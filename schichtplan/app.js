import { initializeApp, deleteApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, connectAuthEmulator, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  sendPasswordResetEmail, createUserWithEmailAndPassword,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  terminate, clearIndexedDbPersistence, query, where, getDocs,
  doc, collection, onSnapshot, setDoc, addDoc, updateDoc, deleteDoc,
  serverTimestamp, FieldPath, writeBatch, connectFirestoreEmulator,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import {
  getMessaging, getToken, deleteToken, onMessage, isSupported,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js';
import { FIREBASE_CONFIG, VAPID_KEY } from './firebase-config.js';
import { readRows, interpretRows, buildMatcher, pad } from './import.js?v=2026-10-09-2023';

// Versionsnummer: muss mit version.json und index.html übereinstimmen (tools/version.sh)
const APP_VERSION = '2026-10-09-2023';

const app = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
auth.languageCode = 'de';
// Zwischenspeicher auf dem Gerät: beim erneuten Öffnen werden möglichst nur Änderungen geladen
// (spart Lesevorgänge). Falls der Browser das nicht kann (z. B. privater Modus) → ohne Speicher.
let db;
try {
  db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
} catch (e) {
  console.warn('Kein lokaler Zwischenspeicher', e);
  db = getFirestore(app);
}

// Lokales Testen ohne echte Daten: http://localhost:5000/?emulator (firebase emulators:start)
const USE_EMULATOR = ['localhost', '127.0.0.1'].includes(location.hostname)
  && new URLSearchParams(location.search).has('emulator');
if (USE_EMULATOR) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
}

const DEFAULT_TYPES = [
  { code: 'F', label: 'Frühdienst', start: '06:00', end: '14:00', color: '#fde68a' },
  { code: 'S', label: 'Spätdienst', start: '14:00', end: '22:00', color: '#fdba74' },
  { code: 'N', label: 'Nachtdienst', start: '22:00', end: '06:00', color: '#93c5fd' },
  // Platzhalter: "ist an dem Tag da, konkreter Dienst wird noch zugeteilt"
  { code: 'T', label: 'Tagdienst', start: '08:00', end: '16:30', color: '#e5e7eb', placeholder: true },
];
// Farbvorschlag: Tageszeit-Logik (Früh = gelb, Spät = orange, Nacht = blau), Platzhalter neutral grau.
// Rot (Krank) und Dunkel (übernommen) bleiben frei, damit sie eindeutig bleiben.
const SUGGESTED_COLORS = { F: '#fde68a', S: '#fdba74', N: '#93c5fd' };
const PLACEHOLDER_COLOR = '#e5e7eb';
const EXTRA_COLORS = ['#99f6e4', '#d9f99d', '#f5d0fe', '#a7f3d0', '#fbcfe8'];
function suggestColors(types) {
  let i = 0;
  return types.map(t => ({ ...t, color: t.placeholder ? PLACEHOLDER_COLOR
    : SUGGESTED_COLORS[t.code.trim().toUpperCase()] || EXTRA_COLORS[i++ % EXTRA_COLORS.length] }));
}
const VAC_TYPES = { U: 'Urlaub', ZA: 'Zeitausgleich', K: 'Krankenstand', FB: 'Fortbildung' };
const SWAP_STATUS = {
  pending: 'offen', accepted: 'angenommen', rejected: 'abgelehnt',
  cancelled: 'zurückgezogen', reverted: 'rückgängig (Admin)',
};
const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const MONTHS = ['Jänner', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli',
  'August', 'September', 'Oktober', 'November', 'Dezember'];

// Nur noch zwei Bereiche (+ Verwaltung). Ältere Links (#swaps, #open, #vacation) führen zu "Meine".
function viewFromHash(hash) {
  const v = String(hash || '').replace('#', '');
  if (['plan', 'mine', 'admin'].includes(v)) return v;
  if (['swaps', 'open', 'vacation'].includes(v)) return 'mine';
  return 'plan';
}

const S = {
  uid: null, me: null,
  users: [], usersById: {},
  types: DEFAULT_TYPES,
  months: {},          // 'YYYY-MM' → { days: { 'YYYY-MM-DD': { uid: code } } }
  marks: {},           // 'YYYY-MM' → { days: { date: { uid: vonUid } } } – aus Excel übernommene Vertretungen/Tausche
  monthWaiters: {},    // 'YYYY-MM' → Promise (erster Snapshot)
  swaps: [], vacations: [], wishes: [],
  winStart: null,       // Tausche, Abwesenheiten, Vertretungen werden erst ab diesem Datum geladen
  winUnsub: [],
  winReady: Promise.resolve(),
  swapParts: {},
  covers: [],          // Urlaubsvertretungen: offene bzw. zugeteilte Dienste
  view: viewFromHash(location.hash),
  cur: (() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() + 1 }; })(),
  // Handy: Wochenansicht, sonst Monatstabelle
  planMode: matchMedia('(max-width: 700px)').matches ? 'week' : 'month',
  weekStart: null,      // Montag der angezeigten Woche (YYYY-MM-DD)
  scrollToday: true,    // Wochenansicht: einmalig zum heutigen Tag scrollen
  unsub: [],
  dataStarted: false,
  importResult: null,
};

// ── Helfer ────────────────────────────────────────────────────────────────────

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseIso = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const today = () => iso(new Date());
const addDays = (s, n) => { const d = parseIso(s); d.setDate(d.getDate() + n); return iso(d); };
const fmt = s => { const d = parseIso(s); return `${WD[d.getDay()]} ${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`; };
const fmtShort = s => { const d = parseIso(s); return `${WD[d.getDay()]} ${pad(d.getDate())}.${pad(d.getMonth() + 1)}.`; };
const monthKey = (y, m) => `${y}-${pad(m)}`;
const daysOfMonth = (y, m) => {
  const n = new Date(y, m, 0).getDate();
  return Array.from({ length: n }, (_, i) => `${y}-${pad(m)}-${pad(i + 1)}`);
};
const isWeekend = s => [0, 6].includes(parseIso(s).getDay());

// Gesetzliche Feiertage Österreich (inkl. Ostern-abhängiger Feiertage)
const HOLIDAYS = {};
function holidaysOf(y) {
  if (HOLIDAYS[y]) return HOLIDAYS[y];
  // Ostersonntag nach Gauß/Meeus
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const easter = `${y}-${pad(Math.floor((h + l - 7 * m + 114) / 31))}-${pad(((h + l - 7 * m + 114) % 31) + 1)}`;
  return (HOLIDAYS[y] = {
    [`${y}-01-01`]: 'Neujahr', [`${y}-01-06`]: 'Heilige Drei Könige',
    [addDays(easter, 1)]: 'Ostermontag', [`${y}-05-01`]: 'Staatsfeiertag',
    [addDays(easter, 39)]: 'Christi Himmelfahrt', [addDays(easter, 50)]: 'Pfingstmontag',
    [addDays(easter, 60)]: 'Fronleichnam', [`${y}-08-15`]: 'Mariä Himmelfahrt',
    [`${y}-10-26`]: 'Nationalfeiertag', [`${y}-11-01`]: 'Allerheiligen',
    [`${y}-12-08`]: 'Mariä Empfängnis', [`${y}-12-25`]: 'Christtag', [`${y}-12-26`]: 'Stefanitag',
  });
}
const holidayName = s => holidaysOf(+s.slice(0, 4))[s] || '';
const isOffDay = s => isWeekend(s) || !!holidayName(s);   // Wochenende oder Feiertag
const userName = uid => S.usersById[uid]?.name || 'Unbekannt';
const personColor = uid => S.usersById[uid]?.color || null;
const isAdmin = () => S.me?.role === 'admin';
const typeOf = code => S.types.find(t => t.code.toUpperCase() === String(code).toUpperCase());
const codeLabel = code => code ? (typeOf(code) ? `${code} (${typeOf(code).label})` : code) : 'frei';

// Mehrere Dienste an einem Tag werden als "F+S" gespeichert
const codeParts = s => (s ? String(s).split('+').filter(Boolean) : []);
const addCode = (cur, code) => [...codeParts(cur), ...codeParts(code)].join('+');
const isPlaceholder = code => !!typeOf(code)?.placeholder;
// Nur echte Dienste (ohne Platzhalter wie T)
const realCode = s => codeParts(s).filter(c => !isPlaceholder(c)).join('+');
function dropPlaceholder(cur) {
  const p = codeParts(cur);
  const i = p.findIndex(isPlaceholder);
  if (i >= 0) p.splice(i, 1);
  return p.join('+');
}
function removeCode(cur, code) {
  const p = codeParts(cur);
  for (const c of codeParts(code)) { const i = p.indexOf(c); if (i >= 0) p.splice(i, 1); }
  return p.join('+');
}

function chip(code) {
  if (!code) return '<span class="chip" style="background:#eef0f3;color:#6b7280">frei</span>';
  if (codeParts(code).length > 1) return codeParts(code).map(chip).join(' ');
  return `<span class="chip" style="background:${esc(typeOf(code)?.color || '#e5e7eb')}">${esc(code)}</span>`;
}

let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = err ? 'err' : '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), err ? 6000 : 3000);
}

function fail(e) {
  console.error(e);
  const map = {
    'permission-denied': 'Keine Berechtigung für diese Aktion.',
    'auth/email-already-in-use': 'Für diese E-Mail existiert bereits ein Account.',
    'auth/invalid-email': 'Ungültige E-Mail-Adresse.',
    'auth/network-request-failed': 'Keine Verbindung zum Server.',
  };
  toast(map[e?.code] || e?.message || String(e), true);
}

// ── Plan-Berechnung: Grundplan + Tausche + Vertretungen + Abwesenheiten ───────

// Alle Änderungen am Grundplan in zeitlicher Reihenfolge:
// angenommene Tausche und vergebene Urlaubsvertretungen.
function planEvents() {
  return [
    ...S.swaps.filter(s => s.status === 'accepted')
      .map(s => ({ ...s, kind: 'swap', t: s.decidedAt?.toMillis?.() ?? 0 })),
    ...S.covers.filter(c => c.status === 'assigned')
      .map(c => ({ ...c, coverKind: c.kind || 'vacation', kind: 'cover', t: c.assignedAt?.toMillis?.() ?? 0 })),
  ].sort((a, b) => a.t - b.t);
}

// Liefert für einen Tag { uid: code } inkl. aller Änderungen (chronologisch).
// Ein Tausch vertauscht die Einträge von "from" und "to" an dateFrom und (falls anders) an dateTo.
// Beispiel: A gibt Mo-Frühdienst gegen B's Mi-Spätdienst → Mo und Mi werden zwischen A und B getauscht.
// Eine Vertretung gibt der Vertretung den Dienst der abwesenden Person (zusätzlich zu deren eigenem).
// Ein abgegebener Dienst wechselt erst bei Übernahme von der abgebenden zur übernehmenden Person.
// touched: uid → Hinweistext ("getauscht", "Vertretung für …")
function effectiveDay(date, events = planEvents()) {
  const day = { ...(S.months[date.slice(0, 7)]?.days?.[date] || {}) };
  const touched = new Map();
  const from = new Map();   // uid → uid der Person, deren Dienst übernommen wurde
  // Aus Excel übernommene Markierungen (schwarze Zellen)
  for (const [uid, f] of Object.entries(S.marks[date.slice(0, 7)]?.days?.[date] || {})) {
    touched.set(uid, f ? `übernommen von ${userName(f)}` : 'übernommen');
    if (f) from.set(uid, f);
  }
  for (const e of events) {
    if (e.kind === 'swap') {
      if (e.dateFrom !== date && e.dateTo !== date) continue;
      const a = day[e.from] || '', b = day[e.to] || '';
      day[e.from] = b; day[e.to] = a;
      touched.set(e.from, `getauscht mit ${userName(e.to)}`); touched.set(e.to, `getauscht mit ${userName(e.from)}`);
      from.set(e.from, e.to); from.set(e.to, e.from);
    } else if (e.date === date) {
      if (e.coverKind === 'release') {
        day[e.absentUid] = removeCode(day[e.absentUid], e.code);
        touched.set(e.absentUid, `abgegeben an ${userName(e.assignee)}`);
        touched.set(e.assignee, `übernommen von ${userName(e.absentUid)}`);
      } else {
        touched.set(e.assignee, `Vertretung für ${userName(e.absentUid)}`);
      }
      from.set(e.assignee, e.absentUid);
      // Ein Platzhalter (z. B. T) wird durch den übernommenen Dienst ersetzt
      day[e.assignee] = addCode(dropPlaceholder(day[e.assignee]), e.code);
    }
  }
  return { day, touched, from };
}

// Darstellung wie in der bisherigen Excel:
//  abwesend → Zelle in der Farbe der Person (Krank: rot), ursprünglicher Dienst bleibt sichtbar
//  übernommen/getauscht → dunkle Zelle, Schrift in der Farbe der Person, deren Dienst es war
function cellLook(uid, code, vac, fromUid) {
  if (vac) {
    const pc = personColor(uid);
    if (vac.type === 'K') return { bg: '#dc2626', fg: '#fff', text: code || 'K' };
    return { bg: pc || 'var(--vac)', fg: pc ? '#111827' : '#92400e', text: pc ? (code || vac.type) : vac.type };
  }
  if (code && fromUid !== undefined) {
    return { bg: '#111827', fg: personColor(fromUid) || '#fff', text: code, dark: true };
  }
  if (code) {
    // Weiß = "keine Farbe" – dann bleibt die Markierung für Wochenende/Feiertag sichtbar
    const tc = typeOf(codeParts(code)[0])?.color;
    const bg = /^#?(fff|ffffff)$/i.test(tc || '') ? '' : tc || '#e5e7eb';
    return { bg, fg: '', text: code, ph: isPlaceholder(codeParts(code)[0]) };
  }
  return { bg: '', fg: '', text: '' };
}

function openCovers() {
  const t = today();
  return S.covers.filter(c => c.status === 'open' && c.date >= t)
    .sort((a, b) => a.date.localeCompare(b.date));
}

// Offene Dienste, die ich übernehmen könnte (alle, außer meine eigenen und Tage, an denen ich abwesend bin)
function claimableCovers() {
  if (isAdmin()) return [];   // Admins teilen offene Dienste in der Verwaltung zu
  return openCovers().filter(c => c.absentUid !== S.uid && !vacationOn(c.date, S.uid));
}

// Wunschfrei (unverbindlich, z. B. für die Sommerurlaubsplanung)
function wishOn(date, uid) {
  return S.wishes.find(w => w.uid === uid && w.from <= date && w.to >= date);
}

function vacationOn(date, uid) {
  return S.vacations.find(v => v.uid === uid && v.from <= date && v.to >= date);
}

function ensureMonth(mk) {
  ensureWindow(mk);
  if (S.monthWaiters[mk]) return S.monthWaiters[mk];
  S.monthWaiters[mk] = new Promise(resolve => {
    const un = onSnapshot(doc(db, 'plan', mk), snap => {
      S.months[mk] = snap.exists() ? snap.data() : { days: {} };
      resolve();
      render();
    }, e => { fail(e); resolve(); });
    S.unsub.push(un);
    S.unsub.push(onSnapshot(doc(db, 'marks', mk), snap => {
      S.marks[mk] = snap.exists() ? snap.data() : { days: {} };
      render();
    }, () => {}));
  });
  return S.monthWaiters[mk];
}

// Im Plan: alle aktiven Mitarbeiter – Admins (Teamleitung) sind nicht im Dienstrad und werden ausgeblendet
function visibleUsers() {
  return S.users.filter(u => u.active !== false && u.role !== 'admin');
}

// ── Auth ─────────────────────────────────────────────────────────────────────

function show(id) {
  for (const s of ['login', 'noAccess', 'app']) $('#' + s).classList.toggle('hidden', s !== id);
}

$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  $('#loginErr').textContent = '';
  try {
    await signInWithEmailAndPassword(auth, $('#loginEmail').value.trim(), $('#loginPw').value);
  } catch (err) {
    $('#loginErr').textContent = ({
      'auth/invalid-credential': 'E-Mail oder Passwort falsch.',
      'auth/wrong-password': 'E-Mail oder Passwort falsch.',
      'auth/user-not-found': 'E-Mail oder Passwort falsch.',
      'auth/too-many-requests': 'Zu viele Versuche – bitte später erneut probieren.',
      'auth/user-disabled': 'Dieser Account ist gesperrt.',
    })[err.code] || err.message;
  }
});

$('#forgotLink').addEventListener('click', async e => {
  e.preventDefault();
  const email = $('#loginEmail').value.trim();
  if (!email) { $('#loginErr').textContent = 'Bitte zuerst die E-Mail-Adresse eingeben.'; return; }
  try { await sendPasswordResetEmail(auth, email); } catch { /* keine Auskunft, ob Account existiert */ }
  $('#loginErr').textContent = '';
  toast('Falls ein Account existiert, wurde ein Link zum Passwort-Setzen gesendet.');
});

function stopListeners() {
  S.unsub.forEach(u => u());
  S.unsub = [];
  S.months = {}; S.monthWaiters = {}; S.marks = {};
  S.swaps = []; S.vacations = []; S.covers = []; S.wishes = []; S.users = []; S.usersById = {};
  S.dataStarted = false;
  S.winUnsub.forEach(u => u()); S.winUnsub = []; S.winStart = null; S.swapParts = {};
}

onAuthStateChanged(auth, user => {
  stopListeners();
  S.uid = user?.uid || null;
  S.me = null;
  if (!user) { show('login'); return; }

  // Eigenes Profil prüfen: nur aktive Profile bekommen Zugang
  // Bis der Server antwortet, nicht vorschnell "kein Profil" melden
  clearTimeout(S.connectTimer);
  $('#noAccessUid').textContent = user.uid;
  $('#noAccessTitle').textContent = 'Verbinde …';
  $('#noAccessMsg').textContent = 'Dein Profil wird geladen.';
  show('noAccess');
  S.connectTimer = setTimeout(() => {
    if (S.me) return;
    $('#noAccessTitle').textContent = 'Keine Verbindung';
    $('#noAccessMsg').textContent = 'Die Datenbank ist nicht erreichbar. Bitte Internetverbindung prüfen. '
      + 'Inhaltsblocker, VPN oder „Privat-Relay“ können die Verbindung blockieren – testweise ausschalten und neu laden.';
    show('noAccess');
  }, 12000);
  S.unsub.push(onSnapshot(doc(db, 'users', user.uid), { includeMetadataChanges: true }, snap => {
    // Antwort nur aus dem lokalen Zwischenspeicher → auf den Server warten
    if (!snap.exists() && snap.metadata.fromCache) return;
    clearTimeout(S.connectTimer);
    S.me = snap.exists() ? { id: snap.id, ...snap.data() } : null;
    if (!S.me || S.me.active === false) {
      $('#noAccessTitle').textContent = 'Kein Zugriff';
      $('#noAccessMsg').textContent = S.me
        ? 'Dein Account ist deaktiviert. Bitte wende dich an die Teamleitung.'
        : 'Für deinen Login ist noch kein Mitarbeiterprofil angelegt (vom Server bestätigt). Bitte wende dich an die Teamleitung.';
      show('noAccess');
      return;
    }
    if (!S.dataStarted) { S.dataStarted = true; startData(); refreshPush(); }
    $('#whoami').textContent = `${S.me.name}${isAdmin() ? ' · Admin' : ''}`;
    document.querySelectorAll('.admin-only').forEach(el => el.classList.toggle('hidden', !isAdmin()));
    show('app');
    render();
  }, e => {
    clearTimeout(S.connectTimer);
    $('#noAccessTitle').textContent = 'Kein Zugriff';
    $('#noAccessMsg').textContent = `Zugriff verweigert (${e.code || e.message}).`;
    show('noAccess');
    console.error(e);
  }));
});

function startData() {
  S.unsub.push(onSnapshot(collection(db, 'users'), snap => {
    S.users = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || (a.name || '').localeCompare(b.name || '', 'de'));
    S.usersById = Object.fromEntries(S.users.map(u => [u.id, u]));
    render();
  }, fail));
  S.unsub.push(onSnapshot(doc(db, 'config', 'shiftTypes'), snap => {
    S.types = snap.exists() && snap.data().types?.length ? snap.data().types : DEFAULT_TYPES;
    if (!S.types.some(t => 'placeholder' in t)) S.types = S.types.map(t => ({ ...t, placeholder: t.code === 'T' }));
    render();
  }, fail));
  // Standard: ab dem 1. des Vormonats. Ältere Daten werden erst geladen, wenn jemand dorthin blättert.
  const d = new Date();
  ensureWindow(monthKey(d.getMonth() === 0 ? d.getFullYear() - 1 : d.getFullYear(), d.getMonth() === 0 ? 12 : d.getMonth()));
}

// Tausche, Abwesenheiten und Vertretungen nur ab einem Stichtag laden (spart Lesevorgänge –
// sonst würde jedes Öffnen der App z. B. alle Urlaube des ganzen Jahres lesen).
function ensureWindow(mk) {
  const start = `${mk}-01`;
  if (!S.dataStarted || (S.winStart && S.winStart <= start)) return S.winReady;
  S.winStart = start;
  S.winUnsub.forEach(u => u());
  // winReady: erfüllt, sobald alle Abfragen das erste Mal geantwortet haben (z. B. für den Excel-Export)
  let pending = 5, resolveReady;
  S.winReady = new Promise(r => { resolveReady = r; });
  const first = fn => { let seen = false; const done = () => { if (!seen) { seen = true; if (--pending === 0) resolveReady(); } };
    return [snap => { fn(snap); done(); }, e => { done(); fail(e); }]; };
  S.winUnsub = [
    // Zwei einfache Abfragen statt einer ODER-Abfrage – die bräuchte in Firestore einen eigenen Index
    ...['dateFrom', 'dateTo'].map(field => onSnapshot(query(collection(db, 'swaps'), where(field, '>=', start)), ...first(snap => {
      S.swapParts[field] = snap.docs.map(d => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) }));
      S.swaps = [...new Map([...(S.swapParts.dateFrom || []), ...(S.swapParts.dateTo || [])].map(x => [x.id, x])).values()];
      render();
    }))),
    onSnapshot(query(collection(db, 'coverages'), where('date', '>=', start)), ...first(snap => {
      S.covers = snap.docs.map(d => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) }));
      render();
    })),
    onSnapshot(query(collection(db, 'vacations'), where('to', '>=', start)), ...first(snap => {
      S.vacations = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      render();
    })),
    onSnapshot(query(collection(db, 'wishes'), where('to', '>=', start)), ...first(snap => {
      S.wishes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      render();
    })),
  ];
  return S.winReady;
}

// ── Navigation & Aktionen ─────────────────────────────────────────────────────

function goto(view) {
  S.view = view;
  S.scrollToday = view === 'plan';
  history.replaceState(null, '', `#${view}`);
  window.scrollTo(0, 0);
  render();
}
for (const navEl of [$('#tabs'), $('#bottomnav')]) {
  navEl.addEventListener('click', e => {
    const b = e.target.closest('button[data-view]');
    if (b) goto(b.dataset.view);
  });
}

const mondayOf = date => { const d = parseIso(date); return addDays(date, -((d.getDay() + 6) % 7)); };
// Handy: Woche beginnt heute (dann ist "heute" ganz oben, ohne Springen); sonst ab Montag
const isPhone = () => matchMedia('(max-width: 700px)').matches;
const weekStartFor = date => (isPhone() ? date : mondayOf(date));

// Antippen einer Benachrichtigung öffnet z. B. …/#swaps
window.addEventListener('hashchange', () => {
  S.view = viewFromHash(location.hash); render();
});

const actions = {
  'logout': async () => {
    await removePushToken(); await signOut(auth);
    // Zwischenspeicher vom Gerät löschen (z. B. gemeinsam genutzte Geräte)
    try { await terminate(db); await clearIndexedDbPersistence(db); } catch { /* egal */ }
    location.reload();
  },
  'push-toggle': () => togglePush(),
  'pwreset-self': async () => {
    await sendPasswordResetEmail(auth, auth.currentUser.email);
    toast(`Link zum Ändern des Passworts an ${auth.currentUser.email} gesendet.`);
  },
  'month-prev': () => { if (S.planMode === 'week') shiftWeek(-1); else shiftMonth(-1); },
  'month-next': () => { if (S.planMode === 'week') shiftWeek(1); else shiftMonth(1); },
  'month-today': () => {
    const d = new Date(); S.cur = { y: d.getFullYear(), m: d.getMonth() + 1 }; S.weekStart = weekStartFor(today());
    S.scrollToday = true; render();
  },
  'plan-mode': el => {
    S.planMode = el.dataset.mode;
    S.scrollToday = true;
    // beim Umschalten im passenden Zeitraum bleiben
    if (S.planMode === 'week') {
      const first = monthKey(S.cur.y, S.cur.m) + '-01';
      S.weekStart = today().startsWith(monthKey(S.cur.y, S.cur.m)) ? weekStartFor(today()) : mondayOf(first);
    } else {
      const [y, m] = S.weekStart.split('-').map(Number); S.cur = { y, m };
    }
    render();
  },
  'menu': () => openMenu(),
  'goto-admin': () => { $('#dlg').close(); goto('admin'); },
  'cell': el => onCellClick(el.dataset.date, el.dataset.uid),
  'swap-new': () => openSwapDialog(today(), S.uid, null, today()),
  'swap-from-mine': el => openSwapDialog(el.dataset.date, S.uid, null, el.dataset.date),
  'swap-accept': el => decideSwap(el.dataset.id, 'accepted'),
  'swap-reject': el => decideSwap(el.dataset.id, 'rejected'),
  'swap-cancel': el => decideSwap(el.dataset.id, 'cancelled'),
  'swap-revert': el => {
    if (confirm('Diesen angenommenen Tausch rückgängig machen? Der Plan springt auf den Stand davor zurück.'))
      decideSwap(el.dataset.id, 'reverted');
  },
  'vac-new': () => openVacationDialog(S.uid, today()),
  'vac-delete': el => deleteVacation(el.dataset.id),
  'cover-claim': el => claimCover(el.dataset.id, S.uid),
  'cover-assign': el => {
    const uid = document.querySelector(`select[data-assign="${el.dataset.id}"]`)?.value;
    if (!uid) { toast('Bitte eine Person auswählen.', true); return; }
    return claimCover(el.dataset.id, uid);
  },
  'release': el => releaseShift(el.dataset.date),
  'cover-withdraw': async el => {
    if (!confirm('Angebot zurückziehen? Der Dienst bleibt dann ganz normal bei dir.')) return;
    await deleteDoc(doc(db, 'coverages', el.dataset.id));
    toast('Angebot zurückgezogen.');
  },
  'open-day': el => openClaimDialog(el.dataset.date),
  'cover-undo': el => undoCover(el.dataset.id),
  'wish-new': () => openWishDialog(today()),
  'wish-delete': el => deleteWish(el.dataset.id),
  'wish-grant': el => {
    const w = S.wishes.find(x => x.id === el.dataset.id);
    if (w) openVacationDialog(w.uid, w.from, { to: w.to, wishId: w.id });
  },
  'todo-more': () => { S.todoAll = true; render(); },
  'ics': () => openCalendarDialog().catch(fail),
  'cal-copy': async () => {
    try { await navigator.clipboard.writeText($('#calUrl').value); toast('Link kopiert.'); }
    catch { $('#calUrl').select(); toast('Bitte den markierten Link kopieren.', true); }
  },
  'cal-renew': async () => {
    if (!confirm('Neuen Link erzeugen? Der alte Link funktioniert dann nicht mehr – du musst den Kalender neu abonnieren.')) return;
    await openCalendarDialog(true);
    toast('Neuer Link erzeugt.');
  },
  'export-plan': () => openExportDialog(),
  'export-template': () => exportMonth(false),
  'user-new': () => openUserDialog(null),
  'user-edit': el => openUserDialog(el.dataset.uid),
  'user-reset': async el => {
    const u = S.usersById[el.dataset.uid];
    await sendPasswordResetEmail(auth, u.email);
    toast(`Passwort-Link an ${u.email} gesendet.`);
  },
  'type-add': () => {
    S.types = [...S.types, { code: '', label: '', start: '', end: '', color: '#e5e7eb', placeholder: false }];
    render();
  },
  'type-del': el => { S.types = S.types.filter((_, i) => i !== +el.dataset.i); render(); },
  'type-save': () => saveTypes(),
  'type-suggest': () => { S.types = suggestColors(S.types); render(); toast('Farbvorschlag eingesetzt – zum Übernehmen „Speichern“ tippen.'); },
  'import-run': () => runImport(),
  'takeover-run': () => runTakeover(),
  'takeover-cancel': () => { S.takeover = null; render(); },
  'import-cancel': () => { S.importResult = null; render(); },
};

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-action]');
  if (!el || !actions[el.dataset.action]) return;
  e.preventDefault();
  try { await actions[el.dataset.action](el); } catch (err) { fail(err); }
});

function shiftWeek(delta) {
  S.weekStart = addDays(S.weekStart, 7 * delta);
  const [y, m] = addDays(S.weekStart, 3).split('-').map(Number);
  S.cur = { y, m };
  render();
}

// Handy-Menü (☰)
function openMenu() {
  openDialog(`<h2>${esc(S.me?.name || '')}</h2>
    <p class="muted" style="margin-top:-6px">${esc(auth.currentUser?.email || '')}${isAdmin() ? ' · Admin' : ''}</p>
    <div class="list">
      ${pushConfigured() ? `<button type="button" class="btn" data-action="push-toggle" data-close style="text-align:left">${pushActive() ? '🔔 Benachrichtigungen sind an' : '🔕 Benachrichtigungen einschalten'}</button>` : ''}
      <button type="button" class="btn" data-action="ics" data-close style="text-align:left">📆 Kalender-Abo (Handy/Outlook)</button>
      <button type="button" class="btn" data-action="export-plan" data-close style="text-align:left">📊 Excel-Export</button>
      <button type="button" class="btn" data-action="pwreset-self" data-close style="text-align:left">🔑 Passwort ändern (Link per E-Mail)</button>
      ${isAdmin() ? '<button type="button" class="btn" data-action="goto-admin" style="text-align:left">⚙️ Verwaltung</button>' : ''}
      <button type="button" class="btn danger" data-action="logout" data-close style="text-align:left">Abmelden</button>
    </div>
    <p class="muted" style="margin:12px 0 0;font-size:.75rem">Version ${APP_VERSION}</p>
    <div class="actions"><button type="button" class="btn" data-close>Schließen</button></div>`);
}

function shiftMonth(delta) {
  let { y, m } = S.cur;
  m += delta;
  if (m < 1) { m = 12; y--; }
  if (m > 12) { m = 1; y++; }
  S.cur = { y, m };
  render();
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function render() {
  if (!S.me) return;
  if (!S.weekStart) S.weekStart = weekStartFor(today());
  document.querySelectorAll('#tabs button, #bottomnav button').forEach(b => b.classList.toggle('active', b.dataset.view === S.view));
  const counts = {
    todo: S.swaps.filter(s => s.status === 'pending' && s.to === S.uid).length + claimableCovers().length,
  };
  document.querySelectorAll('[data-badge]').forEach(el => {
    const n = counts[el.dataset.badge];
    el.innerHTML = n ? `<span class="badge">${n}</span>` : '';
  });
  if (S.view === 'admin' && !isAdmin()) S.view = 'plan';

  // Fokus/Eingaben im Admin-Bereich nicht durch Live-Updates zerstören
  const ae = document.activeElement;
  if (ae?.matches?.('input, select, textarea') && ae.closest('#view [data-keep]')) return;

  const v = $('#view');
  if (S.view === 'plan') {
    v.innerHTML = renderPlan();
    // Handy: in der Wochenansicht gleich zum heutigen Tag springen (nur bei Navigation, nicht bei Live-Updates)
    if (S.planMode === 'week') S.scrollToday = false;
    // Monatstabelle: heutige Spalte ins Bild schieben
    const th = S.scrollToday && S.planMode === 'month' && v.querySelector('.plan thead th.today');
    if (th) {
      S.scrollToday = false;
      const wrap = v.querySelector('.plan-wrap');
      wrap.scrollLeft = Math.max(0, th.offsetLeft - wrap.clientWidth / 2);
    }
  }
  else if (S.view === 'mine') v.innerHTML = renderMine();
  else if (S.view === 'admin') { ensureWindow(`${S.cur.y}-01`); v.innerHTML = renderAdmin(); bindAdmin(); }
}

function kw(date) {
  // ISO-Kalenderwoche
  const d = parseIso(date); d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const jan4 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d - jan4) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
}

function monthNav() {
  const week = S.planMode === 'week';
  const end = week ? addDays(S.weekStart, 6) : null;
  const title = week
    ? `${parseIso(S.weekStart).getDay() === 1 ? `KW ${kw(S.weekStart)} · ` : ''}${S.weekStart.slice(8)}.${S.weekStart.slice(5, 7)}.–${end.slice(8)}.${end.slice(5, 7)}.`
    : `${MONTHS[S.cur.m - 1]} ${S.cur.y}`;
  return `<div class="monthnav">
    <button class="btn" data-action="month-prev" aria-label="zurück">‹</button>
    <h2>${title}</h2>
    <button class="btn" data-action="month-next" aria-label="weiter">›</button>
    <button class="btn small" data-action="month-today">Heute</button>
    <span class="seg noprint">
      <button class="btn small ${week ? 'on' : ''}" data-action="plan-mode" data-mode="week">Woche</button>
      <button class="btn small ${week ? '' : 'on'}" data-action="plan-mode" data-mode="month">Monat</button>
    </span>
  </div>`;
}

// "Anna Muster" → "A. Muster" (Wochenansicht am Handy, damit ein Dienst in eine Zeile passt)
const shortName = n => { const p = String(n).trim().split(/\s+/); return p.length > 1 ? `${p[0][0]}. ${p.slice(1).join(' ')}` : n; };

// Wochenansicht (vor allem fürs Handy): pro Tag eine Karte, gruppiert nach Dienst
function renderWeek() {
  const days = Array.from({ length: 7 }, (_, i) => addDays(S.weekStart, i));
  [...new Set(days.map(d => d.slice(0, 7)))].forEach(ensureMonth);
  const ev = planEvents();
  const users = visibleUsers();
  const t = today();
  const typeOrder = c => { const i = S.types.findIndex(tp => tp.code.toUpperCase() === c.toUpperCase()); return i < 0 ? 99 : i; };

  const cards = days.map(d => {
    const { day, touched, from } = effectiveDay(d, ev);
    const groups = new Map();
    const absent = [];
    const wishes = users.filter(u => !vacationOn(d, u.id) && wishOn(d, u.id));
    for (const u of users) {
      const vac = vacationOn(d, u.id);
      if (vac) { absent.push([u, vac]); continue; }
      for (const c of codeParts(day[u.id])) { if (!groups.has(c)) groups.set(c, []); groups.get(c).push(u); }
    }
    const nameBtn = (u, extra = '', absentLook) => {
      const pc = personColor(u.id);
      const f = from.get(u.id);
      const isT = touched.has(u.id) && !absentLook;
      const st = absentLook ? `background:${absentLook.bg};color:${absentLook.fg};`
        : isT ? `background:#111827;color:${personColor(f) || '#fff'};` : '';
      return `<button class="wk-name ${u.id === S.uid ? 'me' : ''}" data-action="cell" data-date="${d}" data-uid="${esc(u.id)}"
        style="${st}${pc && !absentLook && !isT ? `box-shadow:inset 4px 0 0 ${esc(pc)};` : ''}"
        title="${esc(touched.get(u.id) || u.name)}"><span class="nm-long">${esc(u.name)}</span><span class="nm-short">${esc(shortName(u.name))}</span>${isT && !personColor(f) ? ' <span class="dot">●</span>' : ''}${extra}</button>`;
    };
    const rows = [...groups.keys()].sort((a, b) => typeOrder(a) - typeOrder(b)).map(c => `<div class="wk-row">${chip(c)}
      <div class="wk-names one">${groups.get(c).map(u => nameBtn(u)).join('')}</div></div>`);
    const open = S.covers.filter(c => c.date === d && c.status === 'open' && c.kind !== 'release');
    if (open.length) rows.push(`<div class="wk-row wk-open"><span class="chip" style="background:#fee2e2;color:#b91c1c">⚠</span>
      <div class="wk-names"><button class="wk-name wk-open" data-action="open-day" data-date="${d}">Offen: ${open.map(c => esc(c.code)).join(', ')} – übernehmen?</button></div></div>`);
    if (absent.length) rows.push(`<div class="wk-row"><span class="chip" style="background:#e5e7eb">Abw.</span>
      <div class="wk-names">${absent.map(([u, v]) => {
        const look = cellLook(u.id, day[u.id] || '', v);
        return nameBtn(u, ` (${esc(v.type)}${day[u.id] ? ` statt ${esc(day[u.id])}` : ''})`, look);
      }).join('')}</div></div>`);
    if (wishes.length) rows.push(`<div class="wk-row"><span class="chip wish-chip" title="Wunsch: frei">☆</span>
      <div class="wk-names">${wishes.map(u => `<span class="wk-wish" title="${esc(wishOn(d, u.id).note || 'Wunsch: frei')}">${esc(shortName(u.name))}</span>`).join('')}</div></div>`);
    const mine = vacationOn(d, S.uid)?.type || day[S.uid] || '';
    const hol = holidayName(d);
    return `<div class="wk-day ${isOffDay(d) ? 'we' : ''} ${d === t ? 'today' : ''}">
      <div class="wk-head">${fmtShort(d)}${d === t ? ' <span class="status pending">heute</span>' : ''}${hol ? ` <span class="hol-tag">${esc(hol)}</span>` : ''}
        ${isAdmin() ? '' : `<span class="wk-me">Du: ${mine ? esc(mine) : 'frei'}</span>`}</div>
      ${rows.join('') || '<p class="muted" style="margin:0">Noch kein Plan für diesen Tag.</p>'}
    </div>`;
  }).join('');

  return `${monthNav()}<div class="week">${cards}</div>
    <p class="muted noprint">Tipp: Auf <strong>deinen</strong> Namen tippen → tauschen, abgeben oder Urlaub eintragen. ● = getauscht/übernommen.</p>`;
}

function renderPlan() {
  return renderTodo() + (S.planMode === 'week' ? renderWeek() : renderMonth());
}

function renderMonth() {
  const { y, m } = S.cur;
  const mk = monthKey(y, m);
  ensureMonth(mk);
  const dates = daysOfMonth(y, m);
  const swaps = planEvents();
  const eff = Object.fromEntries(dates.map(d => [d, effectiveDay(d, swaps)]));
  const t = today();
  const users = visibleUsers();
  const loaded = !!S.months[mk];

  const head = dates.map(d => {
    const dt = parseIso(d);
    const hol = holidayName(d);
    return `<th class="${isOffDay(d) ? 'we' : ''} ${hol ? 'hol' : ''} ${d === t ? 'today' : ''}" ${hol ? `title="${esc(hol)}"` : ''}>${WD[dt.getDay()]}<br>${dt.getDate()}</th>`;
  }).join('');

  const body = users.map(u => {
    const cells = dates.map(d => {
      const vac = vacationOn(d, u.id);
      const code = eff[d].day[u.id] || '';
      const touchedHere = eff[d].touched.has(u.id) && code && !vac;
      const look = cellLook(u.id, code, vac, touchedHere ? (eff[d].from.get(u.id) ?? null) : undefined);
      const wish = !vac && wishOn(d, u.id);
      const cls = ['cell', isOffDay(d) ? 'we' : '', d === t ? 'today' : '', vac ? 'vac' : '', look.ph ? 'ph' : '', wish ? 'wish' : '',
        touchedHere && !personColor(eff[d].from.get(u.id)) ? 'swapped' : ''].join(' ');
      const style = look.bg || look.fg ? `style="${look.bg ? `background:${look.bg};` : ''}${look.fg ? `color:${look.fg};` : ''}"` : '';
      const title = `${u.name} · ${fmt(d)} · ${vac ? `${VAC_TYPES[vac.type]}${vac.note ? ` (${vac.note})` : ''}${code ? ` – eigentlich ${code}` : ''}` : codeLabel(code)}`
        + (touchedHere ? ` · ${eff[d].touched.get(u.id)}` : '')
        + (wish ? ` · ☆ Wunsch: frei${wish.note ? ` (${wish.note})` : ''}` : '') + (holidayName(d) ? ` · ${holidayName(d)}` : '');
      return `<td class="${cls}" ${style} data-action="cell" data-date="${d}" data-uid="${esc(u.id)}" title="${esc(title)}">${esc(look.text)}</td>`;
    }).join('');
    const pc = personColor(u.id);
    return `<tr class="${u.id === S.uid ? 'mine' : ''}"><td class="name" title="${esc(u.name)}" ${pc ? `style="box-shadow:inset 6px 0 0 ${esc(pc)};padding-left:14px"` : ''}>${esc(u.name)}</td>${cells}</tr>`;
  }).join('');

  // Offene Dienste (Urlaub ohne Vertretung)
  const openByDate = {};
  // nur unbesetzte Dienste (Urlaub) – abgegebene Dienste sind bis zur Übernahme noch besetzt
  for (const c of S.covers) if (c.status === 'open' && c.kind !== 'release' && c.date.startsWith(mk)) (openByDate[c.date] ??= []).push(c);
  const openRow = Object.keys(openByDate).length ? `<tr class="openrow"><td class="name" title="Dienste ohne Vertretung">⚠ Offen</td>${dates.map(d => {
    const list = openByDate[d] || [];
    if (!list.length) return `<td class="${isOffDay(d) ? 'we' : ''}"></td>`;
    const title = list.map(c => `${c.code} von ${userName(c.absentUid)}`).join(', ');
    return `<td class="cell open" data-action="open-day" data-date="${d}" title="Offen: ${esc(title)} – zum Übernehmen klicken">${esc(list.map(c => c.code).join(' '))}</td>`;
  }).join('')}</tr>` : '';

  // Besetzung pro Tag
  const foot = S.types.map(tp => `<tr><td class="name muted">${esc(tp.code)} – ${esc(tp.label)}</td>${dates.map(d => {
    const n = users.filter(u => !vacationOn(d, u.id)
      && codeParts(eff[d].day[u.id]).some(c => c.toUpperCase() === tp.code.toUpperCase())).length;
    return `<td class="${isOffDay(d) ? 'we' : ''}">${n || ''}</td>`;
  }).join('')}</tr>`).join('');

  const legend = S.types.map(tp => `<span>${chip(tp.code)} ${esc(tp.label)}${tp.placeholder ? ' (Platzhalter)' : ''} ${tp.start ? esc(`${tp.start}–${tp.end}`) : ''}</span>`).join('')
    + `<span><span class="chip" style="background:var(--vac)">U</span> Urlaub/ZA/FB – in der Farbe der Person</span>`
    + `<span><span class="chip" style="background:#dc2626;color:#fff">K</span> Krankenstand</span>`
    + `<span><span class="chip" style="background:#111827;color:#00b0f0">F</span> übernommen/getauscht – Schrift in der Farbe der Person, deren Dienst es war</span>`
    + `<span><span class="chip" style="background:#fee2e2;color:#b91c1c">F</span> offener Dienst</span>`
    + `<span><span class="chip wish-chip">☆</span> Wunsch: frei (unverbindlich)</span>`
    + `<span><span class="chip" style="background:var(--weekend);color:#b91c1c">26</span> Feiertag</span>`;

  return `${monthNav()}
    ${loaded && !Object.keys(S.months[mk].days || {}).length ? `<div class="warn" style="margin-bottom:12px">Für ${MONTHS[m - 1]} ist noch kein Grundplan hinterlegt.${isAdmin() ? ' Unter „Verwaltung“ kannst du ihn als CSV/Excel hochladen.' : ''}</div>` : ''}
    <div class="plan-wrap"><table class="plan">
      <thead><tr><th class="name">Mitarbeiter</th>${head}</tr></thead>
      <tbody>${body}${openRow}</tbody>
      <tfoot>${foot}</tfoot>
    </table></div>
    <div class="legend">${legend}</div>
    <p class="muted noprint">Tipp: Auf <strong>deinen</strong> Dienst tippen → tauschen, abgeben oder Urlaub/Krank eintragen. Dienste anderer kannst du nur ansehen – getauscht wird immer von deiner eigenen Schicht aus.${isAdmin() ? ' Als Admin änderst du dort auch den Grundplan.' : ''}</p>`;
}

function renderMine() {
  const t = today();
  const dates = Array.from({ length: 62 }, (_, i) => addDays(t, i));
  [...new Set(dates.map(d => d.slice(0, 7)))].forEach(ensureMonth);
  const swaps = planEvents();
  const rows = dates.map(d => {
    const { day, touched } = effectiveDay(d, swaps);
    const vac = vacationOn(d, S.uid);
    const code = day[S.uid] || '';
    if (!code && !vac) return '';
    const label = codeParts(code).map(c => {
      const tp = typeOf(c);
      return `${esc(tp?.label || c)}${tp?.start ? ` <span class="muted">${esc(tp.start)}–${esc(tp.end)}</span>` : ''}`;
    }).join(' + ');
    const offered = S.covers.filter(c => c.kind === 'release' && c.status === 'open' && c.absentUid === S.uid && c.date === d);
    return `<div class="item">
      <div style="min-width:120px"><strong>${fmtShort(d)}</strong>${d === t ? ' <span class="status pending">heute</span>' : ''}</div>
      <div class="grow">${vac ? `<span class="chip" style="background:var(--vac)">${esc(vac.type)}</span> ${esc(VAC_TYPES[vac.type])}`
        : `${chip(code)} ${label}`}
        ${touched.has(S.uid) ? `<span class="muted"> · ${esc(touched.get(S.uid))}</span>` : ''}
        ${offered.length ? `<div><span class="status pending">zur Übernahme angeboten: ${offered.map(c => esc(c.code)).join(', ')}</span></div>` : ''}</div>
      ${!vac ? `<button class="btn small" data-action="swap-from-mine" data-date="${d}">Tauschen</button>
        ${offered.length ? offered.map(c => `<button class="btn small" data-action="cover-withdraw" data-id="${c.id}">Angebot zurückziehen</button>`).join('')
          : realCode(code) ? `<button class="btn small" data-action="release" data-date="${d}">Abgeben</button>` : ''}` : ''}
    </div>`;
  }).join('');
  return `${renderTodo()}
  <div class="card">
    <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:12px">
      <h2 style="margin:0">Meine nächsten Schichten</h2>
      <button class="btn small" data-action="ics" title="Dienste automatisch im Apple-, Google- oder Outlook-Kalender">📆 Kalender-Abo</button>
    </div>
    <div class="list">${rows || '<p class="muted">Keine Schichten in den nächsten 2 Monaten.</p>'}</div>
  </div>
  ${renderMyAbsences()}
  ${renderMyWishes()}`;
}

function swapLine(s) {
  const same = s.dateFrom === s.dateTo;
  return same
    ? `${fmt(s.dateFrom)}: <strong>${esc(userName(s.from))}</strong> ${chip(s.fromCode)} ⇄ ${chip(s.toCode)} <strong>${esc(userName(s.to))}</strong>`
    : `<strong>${esc(userName(s.from))}</strong> gibt ${fmtShort(s.dateFrom)} ${chip(s.fromCode)} ab und übernimmt ${fmtShort(s.dateTo)} ${chip(s.toCode)} von <strong>${esc(userName(s.to))}</strong>`;
}

function countWorkdays(from, to, year) {
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) if (d.startsWith(String(year)) && !isOffDay(d)) n++;
  return n;
}

// ── Klick auf Planzelle ───────────────────────────────────────────────────────

function onCellClick(date, uid) {
  if (isAdmin()) return openAdminCellDialog(date, uid);
  if (uid === S.uid) return openOwnCellDialog(date);
  return openInfoDialog(date, uid);
}

// Dienst einer Kollegin/eines Kollegen: nur ansehen. Bearbeiten (tauschen, abgeben, Urlaub)
// geht ausschließlich über die eigene Schicht.
function openInfoDialog(date, uid) {
  const { day, touched } = effectiveDay(date);
  const vac = vacationOn(date, uid);
  const code = day[uid] || '';
  openDialog(`<h2>${esc(userName(uid))}</h2>
    <p>${fmt(date)}: ${vac ? `<span class="chip" style="background:var(--vac)">${esc(vac.type)}</span> ${esc(VAC_TYPES[vac.type] || '')}`
      : code ? codeParts(code).map(c => `${chip(c)} ${esc(typeOf(c)?.label || '')}`).join(' + ') : chip('')}
      ${touched.get(uid) ? `<br><span class="muted">${esc(touched.get(uid))}</span>` : ''}</p>
    <p class="muted">Zum Tauschen auf <strong>deine eigene</strong> Schicht tippen und dort die Kollegin/den Kollegen auswählen.</p>
    <div class="actions"><button type="button" class="btn" data-close>Schließen</button></div>`);
}

function openOwnCellDialog(date) {
  const { day } = effectiveDay(date);
  const vac = vacationOn(date, S.uid);
  const wish = wishOn(date, S.uid);
  openDialog(`<h2>${fmt(date)}${holidayName(date) ? ` <span class="hol-tag">${esc(holidayName(date))}</span>` : ''}</h2>
    <p>Deine Schicht: ${vac ? `<span class="chip" style="background:var(--vac)">${esc(vac.type)}</span> ${esc(VAC_TYPES[vac.type])}
      ${fmt(vac.from)}${vac.to !== vac.from ? ` – ${fmt(vac.to)}` : ''}` : chip(day[S.uid])}</p>
    <div class="actions">
      <button type="button" class="btn" data-close>Schließen</button>
      ${vac ? '<button type="button" class="btn danger" id="dVacDel">Abwesenheit löschen</button>'
        : '<button type="button" class="btn" id="dVac">Abwesend (Urlaub/ZA/Krank)</button>'}
      ${realCode(day[S.uid]) && !vac ? '<button type="button" class="btn" id="dRel">Dienst abgeben</button>' : ''}
      ${vac ? '' : wish ? '<button type="button" class="btn" id="dWishDel">☆ Wunschfrei löschen</button>'
        : '<button type="button" class="btn" id="dWish" title="Unverbindlicher Wunsch, z. B. für die Urlaubsplanung">☆ Wunschfrei</button>'}
      <button type="button" class="btn primary" id="dSwap">Tausch anfragen</button>
    </div>`);
  if ($('#dVac')) $('#dVac').onclick = () => openVacationDialog(S.uid, date);
  if ($('#dVacDel')) $('#dVacDel').onclick = () => { $('#dlg').close(); deleteVacation(vac.id).catch(fail); };
  if ($('#dRel')) $('#dRel').onclick = () => { $('#dlg').close(); releaseShift(date).catch(fail); };
  if ($('#dWish')) $('#dWish').onclick = () => openWishDialog(date);
  if ($('#dWishDel')) $('#dWishDel').onclick = () => { $('#dlg').close(); deleteWish(wish.id).catch(fail); };
  $('#dSwap').onclick = () => openSwapDialog(date, S.uid, null, date);
}

// ── Wunschfrei ────────────────────────────────────────────────────────────────
// Unverbindlich: die Teamleitung sieht die Wünsche und plant danach (Urlaub eintragen oder Dienst zuteilen).

function openWishDialog(date) {
  openDialog(`<h2>☆ Wunschfrei</h2>
    <p class="muted" style="margin-top:-4px">Unverbindlicher Wunsch, z. B. für die Sommerurlaubsplanung. Die Teamleitung sieht ihn im Plan
      und trägt bei Zusage den Urlaub ein – sonst kann sie dir an dem Tag trotzdem einen Dienst zuteilen.</p>
    <div class="row">
      <label>Von<input type="date" id="wFrom" value="${date}" required></label>
      <label>Bis<input type="date" id="wTo" value="${date}" required></label>
    </div>
    <label style="margin-top:8px">Notiz (optional, z. B. „Urlaub Kroatien“ oder „1. Wahl“)<input id="wNote" maxlength="200"></label>
    <div class="actions">
      <button type="button" class="btn" data-close>Abbrechen</button>
      <button type="submit" class="btn primary">Wunsch speichern</button>
    </div>`, async () => {
    const from = $('#wFrom').value, to = $('#wTo').value;
    if (!from || !to || to < from) { toast('„Bis“ liegt vor „Von“.', true); return false; }
    if ((parseIso(to) - parseIso(from)) / 86400000 > 92) { toast('Bitte maximal ca. 3 Monate auf einmal.', true); return false; }
    if (S.wishes.some(w => w.uid === S.uid && w.from <= to && w.to >= from)) {
      toast('Überschneidet sich mit einem bestehenden Wunsch.', true); return false;
    }
    const data = { uid: S.uid, from, to, createdAt: serverTimestamp() };
    const note = $('#wNote').value.trim();
    if (note) data.note = note;
    await addDoc(collection(db, 'wishes'), data);
    toast('Wunsch gespeichert.');
  });
}

async function deleteWish(id) {
  const w = S.wishes.find(x => x.id === id);
  if (!w || !confirm(`Wunschfrei ${fmt(w.from)}${w.to !== w.from ? ` – ${fmt(w.to)}` : ''}${w.uid !== S.uid ? ` von ${userName(w.uid)}` : ''} löschen?`)) return;
  await deleteDoc(doc(db, 'wishes', id));
  toast('Wunsch gelöscht.');
}

function wishRange(w) { return `${fmt(w.from)}${w.to !== w.from ? ` – ${fmt(w.to)}` : ''}`; }

// Meine Wünsche
function renderMyWishes() {
  const t = today();
  const mine = S.wishes.filter(w => w.uid === S.uid && w.to >= t).sort((a, b) => a.from.localeCompare(b.from));
  return `<div class="card">
    <div class="row" style="justify-content:space-between;align-items:center">
      <h2 style="margin:0">☆ Wunschfrei</h2>
      <button class="btn" data-action="wish-new">+ Wunsch</button>
    </div>
    <p class="muted">Unverbindliche Wünsche (z. B. Sommerurlaub). Die Teamleitung plant danach.</p>
    <div class="list">${mine.map(w => `<div class="item"><div class="grow"><span class="chip wish-chip">☆</span> ${wishRange(w)}
      ${w.note ? `<span class="muted"> · ${esc(w.note)}</span>` : ''}</div>
      <button class="btn small danger" data-action="wish-delete" data-id="${w.id}">Löschen</button></div>`).join('') || '<p class="muted">Keine Wünsche eingetragen.</p>'}</div>
  </div>`;
}

// Verwaltung: alle Wünsche mit Überschneidungen
function renderWishOverview() {
  const t = today();
  const list = S.wishes.filter(w => w.to >= t).sort((a, b) => a.from.localeCompare(b.from) || userName(a.uid).localeCompare(userName(b.uid)));
  const items = list.map(w => {
    const others = [
      ...S.wishes.filter(o => o.id !== w.id && o.uid !== w.uid && o.from <= w.to && o.to >= w.from).map(o => `${userName(o.uid)} (Wunsch)`),
      ...S.vacations.filter(v => v.uid !== w.uid && v.from <= w.to && v.to >= w.from).map(v => `${userName(v.uid)} (${v.type})`),
    ];
    const granted = S.vacations.some(v => v.uid === w.uid && v.from <= w.from && v.to >= w.to);
    return `<div class="item"><div class="grow"><strong>${esc(userName(w.uid))}</strong> · ${wishRange(w)}
        ${w.note ? `<span class="muted"> · ${esc(w.note)}</span>` : ''}
        ${others.length ? `<div class="muted" style="font-size:.85rem">gleichzeitig: ${esc([...new Set(others)].join(', '))}</div>` : ''}
        ${granted ? '<div style="font-size:.85rem;color:#047857">✓ Abwesenheit bereits eingetragen</div>' : ''}</div>
      ${granted ? '' : `<button class="btn small primary" data-action="wish-grant" data-id="${w.id}">Als Urlaub eintragen</button>`}
      <button class="btn small danger" data-action="wish-delete" data-id="${w.id}">Löschen</button></div>`;
  }).join('');
  return `<div class="card"><h2>☆ Wunschfrei (${list.length})</h2>
    <p class="muted">Wünsche der Mitarbeiter, z. B. für die Sommerurlaubsplanung. „Als Urlaub eintragen“ öffnet den Urlaubsdialog
      (mit Vertretungen) und entfernt danach den Wunsch. Nicht zugesagte Wünsche einfach löschen – Dienste kannst du trotzdem zuteilen.</p>
    <div class="list">${items || '<p class="muted">Keine offenen Wünsche.</p>'}</div></div>`;
}

// ── Dialog-Grundgerüst ────────────────────────────────────────────────────────

function openDialog(html, onSubmit) {
  const dlg = $('#dlg');
  const body = $('#dlgBody');
  body.innerHTML = html;
  body.onsubmit = async e => {
    e.preventDefault();
    if (!onSubmit) return dlg.close();
    const btn = body.querySelector('[type=submit]');
    if (btn) btn.disabled = true;
    try {
      if (await onSubmit() !== false) dlg.close();
    } catch (err) { fail(err); } finally { if (btn) btn.disabled = false; }
  };
  body.querySelectorAll('[data-close]').forEach(b => b.onclick = () => dlg.close());
  if (!dlg.open) dlg.showModal();
}

// ── Tausch ────────────────────────────────────────────────────────────────────

function openSwapDialog(dateFrom, fromUid, toUid, dateTo) {
  const others = visibleUsers().filter(u => u.id !== S.uid);
  openDialog(`<h2>Schichttausch anfragen</h2>
    <div class="row">
      <label>Mein Tag<input type="date" id="sDateFrom" value="${dateFrom}" required></label>
      <label>Mit<select id="sTo" required>
        <option value="">– auswählen –</option>
        ${others.map(u => `<option value="${esc(u.id)}" ${u.id === toUid ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}
      </select></label>
      <label>Deren Tag<input type="date" id="sDateTo" value="${dateTo}" required></label>
    </div>
    <p class="muted">Gleicher Tag = Schichten am selben Tag tauschen. Anderer Tag = du übernimmst deren Dienst, sie deinen.</p>
    <label>Nachricht (optional)<textarea id="sNote" rows="2" maxlength="300"></textarea></label>
    <div id="sPreview"></div>
    <div class="actions">
      <button type="button" class="btn" data-close>Abbrechen</button>
      <button type="submit" class="btn primary">Anfrage senden</button>
    </div>`, submitSwap);

  const update = async () => {
    const dF = $('#sDateFrom').value, dT = $('#sDateTo').value, to = $('#sTo').value;
    const box = $('#sPreview');
    if (dT) {
      // Im Auswahlfeld anzeigen, welchen Dienst die Kolleg/innen an deren Tag haben
      await ensureMonth(dT.slice(0, 7));
      const { day } = effectiveDay(dT);
      for (const o of $('#sTo').options) {
        if (!o.value) continue;
        const v = vacationOn(dT, o.value);
        o.textContent = `${userName(o.value)} – ${v ? `abwesend (${v.type})` : day[o.value] || 'frei'}`;
      }
    }
    if (!dF || !dT || !to) { box.innerHTML = ''; return; }
    await Promise.all([ensureMonth(dF.slice(0, 7)), ensureMonth(dT.slice(0, 7))]);
    const p = swapPreview(S.uid, to, dF, dT);
    box.innerHTML = `<div class="preview"><strong>Nach dem Tausch:</strong>${p.lines.map(l => `<div>${l}</div>`).join('')}</div>`
      + p.warnings.map(w => `<div class="warn">${w}</div>`).join('');
  };
  ['#sDateFrom', '#sDateTo', '#sTo'].forEach(s => $(s).addEventListener('change', update));
  update();
}

function swapPreview(from, to, dF, dT) {
  const dates = [...new Set([dF, dT])].sort();
  const lines = [], warnings = [];
  for (const d of dates) {
    const { day } = effectiveDay(d);
    const a = day[from] || '', b = day[to] || '';
    lines.push(`${fmtShort(d)}: ${esc(userName(from))} ${chip(a)} → ${chip(b)}, ${esc(userName(to))} ${chip(b)} → ${chip(a)}`);
    if (vacationOn(d, from) || vacationOn(d, to)) warnings.push(`Am ${fmtShort(d)} ist jemand als abwesend eingetragen.`);
  }
  const { day: dayF } = effectiveDay(dF), { day: dayT } = effectiveDay(dT);
  if (!dayF[from] && !dayT[to]) warnings.push('Beide Tage sind frei – es gibt nichts zu tauschen.');
  if (dF < today()) warnings.push('Der Tag liegt in der Vergangenheit.');
  return { lines, warnings, fromCode: dayF[from] || '', toCode: dayT[to] || '' };
}

async function submitSwap() {
  const dF = $('#sDateFrom').value, dT = $('#sDateTo').value, to = $('#sTo').value;
  if (!to) { toast('Bitte eine Person auswählen.', true); return false; }
  await Promise.all([ensureMonth(dF.slice(0, 7)), ensureMonth(dT.slice(0, 7))]);
  const p = swapPreview(S.uid, to, dF, dT);
  if (!p.fromCode && !p.toCode) { toast('Beide Tage sind frei – nichts zu tauschen.', true); return false; }
  const dup = S.swaps.find(s => s.status === 'pending' && s.from === S.uid && s.to === to && s.dateFrom === dF && s.dateTo === dT);
  if (dup) { toast('Diese Anfrage ist bereits offen.', true); return false; }
  const data = {
    from: S.uid, to, dateFrom: dF, dateTo: dT, fromCode: p.fromCode, toCode: p.toCode,
    status: 'pending', createdAt: serverTimestamp(),
  };
  const note = $('#sNote').value.trim();
  if (note) data.note = note;
  await addDoc(collection(db, 'swaps'), data);
  toast(`Anfrage an ${userName(to)} gesendet.`);
}

async function decideSwap(id, status) {
  const s = S.swaps.find(x => x.id === id);
  if (!s) return;
  if (status === 'accepted') {
    // Prüfen, ob sich der Plan seit der Anfrage geändert hat
    await Promise.all([ensureMonth(s.dateFrom.slice(0, 7)), ensureMonth(s.dateTo.slice(0, 7))]);
    const cur = swapPreview(s.from, s.to, s.dateFrom, s.dateTo);
    if (cur.fromCode !== s.fromCode || cur.toCode !== s.toCode) {
      if (!confirm(`Achtung: Der Plan hat sich seit der Anfrage geändert.\nAktuell: ${userName(s.from)} ${codeLabel(cur.fromCode)}, ${userName(s.to)} ${codeLabel(cur.toCode)}.\nTrotzdem tauschen?`)) return;
    } else if (!confirm(`Tausch annehmen?\n\n${cur.lines.map(l => l.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).join('\n')}`)) return;
  }
  await updateDoc(doc(db, 'swaps', id), { status, decidedAt: serverTimestamp(), decidedBy: S.uid });
  toast(`Tausch ${SWAP_STATUS[status]}.`);
}

// ── Urlaub ────────────────────────────────────────────────────────────────────

function openVacationDialog(uid, date, opts = {}) {
  openDialog(`<h2>Abwesenheit eintragen</h2>
    ${isAdmin() ? `<label>Mitarbeiter<select id="vUid">${visibleUsers().map(u =>
      `<option value="${esc(u.id)}" ${u.id === uid ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></label>` : ''}
    <div class="row" style="margin-top:8px">
      <label>Von<input type="date" id="vFrom" value="${date}" required></label>
      <label>Bis<input type="date" id="vTo" value="${opts.to || date}" required></label>
      <label>Art<select id="vType">${Object.entries(VAC_TYPES).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
    </div>
    <label style="margin-top:8px">Notiz (optional)<input id="vNote" maxlength="200"></label>
    <div id="vWarn"></div>
    <div id="vCover"></div>
    <div class="actions">
      <button type="button" class="btn" data-close>Abbrechen</button>
      <button type="submit" class="btn primary">Speichern</button>
    </div>`, async () => {
    const target = isAdmin() ? $('#vUid').value : S.uid;
    const from = $('#vFrom').value, to = $('#vTo').value;
    if (to < from) { toast('„Bis“ liegt vor „Von“.', true); return false; }
    if ((parseIso(to) - parseIso(from)) / 86400000 > 92) {
      toast('Bitte maximal ca. 2 Monate auf einmal eintragen.', true); return false;
    }
    if (S.vacations.some(v => v.uid === target && v.from <= to && v.to >= from)) {
      toast('Überschneidet sich mit einer bestehenden Abwesenheit.', true); return false;
    }
    const data = { uid: target, from, to, type: $('#vType').value, createdAt: serverTimestamp(), createdBy: S.uid };
    const note = $('#vNote').value.trim();
    if (note) data.note = note;

    // Betroffene Dienste: Vertretung zuteilen oder offen lassen
    await loadMonths(from, to);
    const ev = planEvents();
    const shifts = affectedShifts(target, from, to, ev);
    const batch = writeBatch(db);
    const vacRef = doc(collection(db, 'vacations'));
    batch.set(vacRef, data);
    let assigned = 0;
    for (const { date, code } of shifts) {
      const assignee = document.querySelector(`select[data-cover="${date}"]`)?.value || '';
      if (assignee && vacationOn(date, assignee)) {
        toast(`${userName(assignee)} ist am ${fmtShort(date)} abwesend.`, true);
        return false;
      }
      batch.set(doc(db, 'coverages', `${vacRef.id}_${date}`), {
        vacationId: vacRef.id, date, code, absentUid: target,
        status: assignee ? 'assigned' : 'open', assignee: assignee || null,
        createdAt: serverTimestamp(), createdBy: S.uid,
        ...(assignee ? { assignedAt: serverTimestamp(), assignedBy: S.uid } : {}),
      });
      if (assignee) assigned++;
    }
    await batch.commit();
    const open = shifts.length - assigned;
    toast(shifts.length
      ? `Eingetragen. ${assigned} Dienst(e) zugeteilt, ${open} offen.`
      : 'Eingetragen.');
    // Aus einem Wunschfrei-Eintrag übernommen → Wunsch ist erledigt
    if (opts.wishId) await deleteDoc(doc(db, 'wishes', opts.wishId)).catch(() => {});
  });

  const coverList = async () => {
    const from = $('#vFrom').value, to = $('#vTo').value;
    const box = $('#vCover');
    if (!from || !to || to < from || (parseIso(to) - parseIso(from)) / 86400000 > 92) { box.innerHTML = ''; return; }
    const target = isAdmin() ? $('#vUid').value : S.uid;
    await loadMonths(from, to);
    // Bereits getroffene Auswahl beim Neuzeichnen behalten
    const prev = Object.fromEntries([...box.querySelectorAll('select[data-cover]')].map(sel => [sel.dataset.cover, sel.value]));
    const ev = planEvents();
    const shifts = affectedShifts(target, from, to, ev);
    if (!shifts.length) {
      box.innerHTML = '<p class="muted" style="margin-top:12px">Im Zeitraum sind keine festen Dienste eingeteilt (Platzhalter wie T brauchen keine Vertretung).</p>';
      return;
    }
    box.innerHTML = `<h3>Betroffene Dienste (${shifts.length})</h3>
      <p class="muted" style="margin-top:0">Vertretung direkt zuteilen oder offen lassen – offene Dienste kann jede/r im Team übernehmen.</p>
      <div class="list">${shifts.map(({ date, code }) => {
        // Vorne, wer frei hat; dahinter alle, die schon Dienst haben (bekommen dann beide Dienste)
        const day = effectiveDay(date, ev).day;
        const free = visibleUsers().filter(u => u.id !== target && !vacationOn(date, u.id))
          .sort((a, b) => !!realCode(day[a.id]) - !!realCode(day[b.id]));
        const note = uid => realCode(day[uid]) ? ` (hat schon ${realCode(day[uid])})`
          : day[uid] ? ` (${day[uid]} – verfügbar)` : ' (frei)';
        return `<div class="item" style="padding:6px 10px">
          <div style="min-width:110px"><strong>${fmtShort(date)}</strong> ${chip(code)}</div>
          <select data-cover="${date}" style="flex:1 1 180px">
            <option value="">offen lassen</option>
            ${free.map(u => `<option value="${esc(u.id)}" ${prev[date] === u.id ? 'selected' : ''}>Vertretung: ${esc(u.name)}${esc(note(u.id))}</option>`).join('')}
          </select>
          ${free.length ? '' : '<span class="muted">niemand verfügbar</span>'}
        </div>`;
      }).join('')}</div>`;
  };

  const warn = () => {
    const from = $('#vFrom').value, to = $('#vTo').value;
    if (!from || !to || to < from) return;
    const target = isAdmin() ? $('#vUid').value : S.uid;
    const others = S.vacations.filter(v => v.uid !== target && v.from <= to && v.to >= from);
    $('#vWarn').innerHTML = others.length
      ? `<div class="warn">Im Zeitraum ebenfalls abwesend: ${others.map(v => esc(userName(v.uid))).join(', ')}</div>` : '';
  };
  ['#vFrom', '#vTo'].forEach(s => $(s).addEventListener('change', () => {
    if ($('#vTo').value < $('#vFrom').value) $('#vTo').value = $('#vFrom').value;
    warn();
    coverList();
  }));
  $('#vUid')?.addEventListener('change', () => { warn(); coverList(); });
  warn();
  coverList();
}

function loadMonths(from, to) {
  const months = new Set();
  for (let d = from; d <= to; d = addDays(d, 1)) months.add(d.slice(0, 7));
  return Promise.all([...months].map(ensureMonth));
}

// Dienste einer Person im Zeitraum (ab heute), die eine Vertretung brauchen
function affectedShifts(uid, from, to, ev) {
  const out = [];
  const start = from < today() ? today() : from;
  for (let d = start; d <= to; d = addDays(d, 1)) {
    const code = realCode(effectiveDay(d, ev).day[uid]);
    if (code) out.push({ date: d, code });
  }
  return out;
}

async function deleteVacation(id) {
  const v = S.vacations.find(x => x.id === id);
  const covers = S.covers.filter(c => c.vacationId === id);
  const assigned = covers.filter(c => c.status === 'assigned');
  const what = v ? `${VAC_TYPES[v.type] || 'Abwesenheit'}${v.uid !== S.uid ? ` von ${userName(v.uid)}` : ''} (${fmt(v.from)}${v.to !== v.from ? ` – ${fmt(v.to)}` : ''})` : 'Abwesenheit';
  const msg = `${what} löschen?` + (assigned.length
    ? `\n\nDie Vertretungen entfallen (${assigned.map(c => `${fmtShort(c.date)} ${userName(c.assignee)}`).join(', ')}) – die Dienste gehen zurück.`
    : '\n\nDie Dienste an diesen Tagen gelten dann wieder normal.');
  if (!confirm(msg)) return;
  const batch = writeBatch(db);
  batch.delete(doc(db, 'vacations', id));
  covers.forEach(c => batch.delete(doc(db, 'coverages', c.id)));
  await batch.commit();
  toast('Gelöscht.');
}

async function claimCover(id, uid) {
  const c = S.covers.find(x => x.id === id);
  if (!c || c.status !== 'open') { toast('Dieser Dienst ist nicht mehr offen.', true); return; }
  await ensureMonth(c.date.slice(0, 7));
  if (uid === c.absentUid) { toast('Das ist der eigene Dienst.', true); return; }
  if (S.usersById[uid]?.role === 'admin') { toast('Admins sind nicht im Dienstrad und können keine Dienste übernehmen.', true); return; }
  if (vacationOn(c.date, uid)) {
    toast(`${uid === S.uid ? 'Du bist' : `${userName(uid)} ist`} am ${fmtShort(c.date)} abwesend.`, true);
    return;
  }
  const what = `${codeLabel(c.code)} am ${fmt(c.date)} (${c.kind === 'release'
    ? `abgegeben von ${userName(c.absentUid)}` : `Vertretung für ${userName(c.absentUid)}`})`;
  const dayCode = effectiveDay(c.date).day[uid] || '';
  const existing = realCode(dayCode);   // Platzhalter (T) zählen nicht als Dienst
  const ph = codeParts(dayCode).find(isPlaceholder);
  const phNote = ph ? `\n\nDein Platzhalter ${ph} wird dadurch ersetzt.` : '';

  // Admin teilt jemand anderem zu
  if (uid !== S.uid) {
    if (!confirm(`${userName(uid)} übernimmt ${what}?${existing ? `\n\n${userName(uid)} hat an dem Tag schon ${existing} und hat dann beide Dienste.` : ph ? `\n\nDer Platzhalter ${ph} wird dadurch ersetzt.` : ''}`)) return;
    return doClaim(c, uid, false);
  }
  if (!existing) {
    if (!confirm(`Du übernimmst ${what}?${phNote}`)) return;
    return doClaim(c, uid, false);
  }
  // Ich habe an dem Tag schon Dienst → zusätzlich oder eigenen Dienst anbieten
  openDialog(`<h2>Dienst übernehmen</h2>
    <p>Du übernimmst ${esc(what)}.</p>
    <p>Du hast an dem Tag schon ${chip(existing)}. Was soll damit passieren?</p>
    <div class="list">
      <button type="button" class="btn" id="cBoth" style="text-align:left;white-space:normal">
        <strong>Zusätzlich übernehmen</strong><br><span class="muted">Du hast dann beide Dienste (${esc(addCode(existing, c.code))}).</span></button>
      <button type="button" class="btn" id="cOffer" style="text-align:left;white-space:normal">
        <strong>Übernehmen und meinen ${esc(existing)} anbieten</strong><br><span class="muted">Dein ${esc(existing)} erscheint bei den offenen Diensten und bleibt deiner, bis ihn jemand übernimmt.</span></button>
    </div>
    <div class="actions"><button type="button" class="btn" data-close>Abbrechen</button></div>`);
  $('#cBoth').onclick = () => { $('#dlg').close(); doClaim(c, uid, false).catch(fail); };
  $('#cOffer').onclick = () => { $('#dlg').close(); doClaim(c, uid, true, existing).catch(fail); };
}

const releaseId = (uid, date) => `rel_${uid}_${date}_${Date.now()}`;
const releaseDoc = (date, code) => ({
  kind: 'release', vacationId: null, date, code, absentUid: S.uid,
  status: 'open', assignee: null, createdAt: serverTimestamp(), createdBy: S.uid,
});

async function doClaim(c, uid, offerOwn, ownCode) {
  const batch = writeBatch(db);
  batch.update(doc(db, 'coverages', c.id), {
    status: 'assigned', assignee: uid, assignedAt: serverTimestamp(), assignedBy: S.uid,
  });
  const alreadyOffered = offerOwn && S.covers.some(x => x.kind === 'release' && x.status === 'open'
    && x.absentUid === S.uid && x.date === c.date && x.code === ownCode);
  if (offerOwn && !alreadyOffered) batch.set(doc(db, 'coverages', releaseId(S.uid, c.date)), releaseDoc(c.date, ownCode));
  try {
    await batch.commit();
    toast(offerOwn ? `Übernommen – dein ${ownCode} wird jetzt angeboten.` : 'Übernommen – steht jetzt im Plan.');
  } catch (e) {
    // Regeln lassen nur die erste Übernahme zu
    if (e.code === 'permission-denied') toast('Zu spät – jemand anderes hat den Dienst schon übernommen.', true);
    else throw e;
  }
}

// Admin: Übernahme rückgängig. Abgegebener Dienst → zurück an die abgebende Person;
// Urlaubsvertretung → wieder offen (die Person im Urlaub kann ihn ja nicht zurücknehmen).
async function undoCover(id) {
  const c = S.covers.find(x => x.id === id);
  if (!c) return;
  const what = `${c.code} am ${fmt(c.date)}`;
  if (c.kind === 'release') {
    if (!confirm(`${what} von ${userName(c.assignee)} an ${userName(c.absentUid)} zurückgeben?`)) return;
    await deleteDoc(doc(db, 'coverages', id));
    toast(`Zurückgegeben – ${what} ist wieder bei ${userName(c.absentUid)}.`);
  } else {
    if (!confirm(`Vertretung ${what} (${userName(c.assignee)} für ${userName(c.absentUid)}) aufheben? Der Dienst ist dann wieder offen.`)) return;
    await updateDoc(doc(db, 'coverages', id), { status: 'open', assignee: null, assignedAt: serverTimestamp(), assignedBy: S.uid });
    toast(`${what} ist wieder offen.`);
  }
}

// Eigenen Dienst zur Übernahme anbieten (ohne Urlaub). Bleibt bei mir, bis ihn jemand übernimmt.
async function releaseShift(date) {
  await ensureMonth(date.slice(0, 7));
  const code = realCode(effectiveDay(date).day[S.uid]);
  if (!code) { toast('An diesem Tag hast du keinen festen Dienst zum Abgeben (Platzhalter wie T werden zugeteilt).', true); return; }
  if (vacationOn(date, S.uid)) { toast('An diesem Tag bist du abwesend – das läuft über den Urlaubseintrag.', true); return; }
  if (S.covers.some(c => c.kind === 'release' && c.status === 'open' && c.absentUid === S.uid && c.date === date)) {
    toast('Diesen Dienst bietest du bereits an.', true); return;
  }
  if (!confirm(`${codeLabel(code)} am ${fmt(date)} zur Übernahme anbieten?\n\nDer Dienst bleibt deiner, bis ihn jemand übernimmt. Alle im Team werden benachrichtigt.`)) return;
  await setDoc(doc(db, 'coverages', releaseId(S.uid, date)), releaseDoc(date, code));
  toast('Angeboten – steht jetzt bei den offenen Diensten.');
}

function renderOpen() {
  const ev = planEvents();
  const list = openCovers();
  const items = list.map(c => {
    const vac = c.vacationId ? S.vacations.find(v => v.id === c.vacationId) : null;
    const mine = c.absentUid === S.uid;
    const absentThatDay = vacationOn(c.date, S.uid);
    const myCode = effectiveDay(c.date, ev).day[S.uid];
    const reason = c.kind === 'release'
      ? `${esc(userName(c.absentUid))} gibt ab`
      : `${esc(VAC_TYPES[vac?.type] || 'Abwesenheit')} von ${esc(userName(c.absentUid))}`;
    const others = isAdmin() ? visibleUsers().filter(u => u.id !== c.absentUid && !vacationOn(c.date, u.id)) : [];
    const dayCodes = isAdmin() ? effectiveDay(c.date, ev).day : {};
    let action;
    if (isAdmin()) action = '';   // Admins sind nicht im Dienstrad – nur zuteilen
    else if (mine && c.kind === 'release') action = `<button class="btn small" data-action="cover-withdraw" data-id="${c.id}">Zurückziehen</button>`;
    else if (mine) action = '<span class="muted">dein Dienst</span>';
    else if (absentThatDay) action = '<span class="muted">du bist an dem Tag abwesend</span>';
    else action = `${myCode && !mine ? `<span class="muted">du hast ${esc(myCode)}</span>` : ''}
      <button class="btn small primary" data-action="cover-claim" data-id="${c.id}">Übernehmen</button>`;
    return `<div class="item">
      <div style="min-width:120px"><strong>${fmtShort(c.date)}</strong></div>
      <div class="grow">${chip(c.code)} ${esc(typeOf(c.code)?.label || '')}
        <span class="muted">· ${reason}</span></div>
      ${action}
      ${isAdmin() ? `<span class="row" style="flex-wrap:nowrap;gap:4px"><select data-assign="${c.id}" style="padding:4px 6px">
          <option value="">zuteilen …</option>${others.map(u => `<option value="${esc(u.id)}">${esc(u.name)}${dayCodes[u.id] ? ` (${esc(dayCodes[u.id])})` : ''}</option>`).join('')}
        </select><button class="btn small" data-action="cover-assign" data-id="${c.id}">OK</button></span>` : ''}
    </div>`;
  }).join('');

  const t = today();
  // Admins sehen auch die letzten 14 Tage, um Übernahmen rückgängig machen zu können
  const since = isAdmin() ? addDays(t, -14) : t;
  const recent = S.covers.filter(c => c.status === 'assigned' && c.date >= since && (isAdmin() || [c.assignee, c.absentUid].includes(S.uid)))
    .sort((a, b) => a.date.localeCompare(b.date)).slice(0, 40)
    .map(c => `<div class="item"><div style="min-width:120px"><strong>${fmtShort(c.date)}</strong></div>
      <div class="grow">${chip(c.code)} <strong>${esc(userName(c.assignee))}</strong>
        ${c.kind === 'release' ? 'übernimmt von' : 'vertritt'} ${esc(userName(c.absentUid))}</div>
      ${isAdmin() ? `<button class="btn small danger" data-action="cover-undo" data-id="${c.id}">${c.kind === 'release' ? 'Zurückgeben' : 'Wieder öffnen'}</button>` : ''}</div>`).join('');

  return `<div class="card">
      <h2>Offene Dienste (${list.length})</h2>
      <p class="muted">Dienste von Kolleg/innen im Urlaub und Dienste, die jemand abgeben möchte. Jede/r kann übernehmen – wer zuerst kommt, bekommt den Dienst.
        Hast du an dem Tag schon Dienst, kannst du zusätzlich übernehmen oder deinen eigenen Dienst dafür anbieten.</p>
      <div class="list">${items || '<p class="muted">Keine offenen Dienste 🎉</p>'}</div>
      <p class="muted" style="margin-top:12px">Eigenen Dienst abgeben: unter „Meine Schichten“ auf <strong>Abgeben</strong> tippen.</p>
    </div>
    <div class="card"><h2>Vergebene Dienste</h2>
      <div class="list">${recent || '<p class="muted">Keine.</p>'}</div>
    </div>`;
}

// ── Kalender-Abo ──────────────────────────────────────────────────────────────
// Jede Person bekommt einen geheimen Link. Die Cloud Function "calendar" liefert darüber den aktuellen
// Stand als .ics – Kalender-Apps holen ihn regelmäßig ab (Tausche, Urlaube usw. werden nachgezogen).

const CAL_URL = `https://europe-west3-${FIREBASE_CONFIG.projectId}.cloudfunctions.net/calendar`;

async function calendarToken(renew) {
  const mine = await getDocs(query(collection(db, 'calTokens'), where('uid', '==', S.uid)));
  if (!renew && !mine.empty) return mine.docs[0].id;
  await Promise.all(mine.docs.map(d => deleteDoc(d.ref)));
  const token = [...crypto.getRandomValues(new Uint8Array(20))].map(b => b.toString(16).padStart(2, '0')).join('');
  await setDoc(doc(db, 'calTokens', token), { uid: S.uid, createdAt: serverTimestamp() });
  return token;
}

async function openCalendarDialog(renew = false) {
  const token = await calendarToken(renew);
  const url = `${CAL_URL}?t=${token}`;
  const webcal = url.replace(/^https:/, 'webcal:');
  openDialog(`<h2>📆 Kalender-Abo</h2>
    <p>Deine Dienste erscheinen automatisch in deinem Kalender – Tausche, Übernahmen und Urlaube werden laufend nachgezogen
      (je nach Kalender etwa stündlich bis alle paar Stunden).</p>
    <div class="list">
      <a class="btn primary" href="${esc(webcal)}" style="text-align:left">📱 iPhone/Mac: Kalender abonnieren</a>
      <button type="button" class="btn" data-action="cal-copy" style="text-align:left">📋 Link kopieren (Google/Outlook/Android)</button>
    </div>
    <label style="margin-top:10px">Dein persönlicher Link<input id="calUrl" readonly value="${esc(url)}" onfocus="this.select()"></label>
    <details style="margin-top:10px"><summary>So geht's</summary>
      <p><strong>iPhone/iPad:</strong> „Kalender abonnieren“ tippen → „Abonnieren“ → „Hinzufügen“.
        Unter Einstellungen → Kalender → Accounts → Abonnierte Kalender → „Abrufen“ kannst du z. B. „Alle 15 Min.“ wählen.</p>
      <p><strong>Google Kalender</strong> (am Computer auf calendar.google.com): links „Weitere Kalender“ → „+“ → „Per URL“ → Link einfügen.
        Erscheint danach auch am Android-Handy.</p>
      <p><strong>Outlook:</strong> Kalender → „Kalender hinzufügen“ → „Aus dem Internet abonnieren“ → Link einfügen.</p>
    </details>
    <p class="muted" style="font-size:.85rem">Wer diesen Link hat, sieht deine Dienste – bitte nicht weitergeben.
      Zeitraum: 1 Monat zurück bis 12 Monate voraus.</p>
    <div class="actions">
      <button type="button" class="btn danger" data-action="cal-renew">Neuen Link erzeugen</button>
      <button type="button" class="btn" data-close>Schließen</button>
    </div>`);
}

// ── Verwaltung (Admin) ────────────────────────────────────────────────────────

function renderAdmin() {
  const users = S.users.map(u => `<tr class="${u.active === false ? 'inactive' : ''}">
      <td>${esc(u.name)}${u.short ? ` <span class="muted">(${esc(u.short)})</span>` : ''}</td>
      <td>${esc(u.email)}</td>
      <td>${u.role === 'admin' ? 'Admin' : 'Mitarbeiter'}${u.active === false ? ' · deaktiviert' : ''}</td>
      <td style="white-space:nowrap">
        <button class="btn small" data-action="user-edit" data-uid="${esc(u.id)}">Bearbeiten</button>
        <button class="btn small" data-action="user-reset" data-uid="${esc(u.id)}" title="Passwort-Link senden">🔑</button>
      </td></tr>`).join('');

  const types = S.types.map((t, i) => `<tr>
      <td><input data-t="${i}" data-f="code" value="${esc(t.code)}" maxlength="4" style="width:60px"></td>
      <td><input data-t="${i}" data-f="label" value="${esc(t.label)}" maxlength="30"></td>
      <td><input data-t="${i}" data-f="start" type="time" value="${esc(t.start)}"></td>
      <td><input data-t="${i}" data-f="end" type="time" value="${esc(t.end)}"></td>
      <td><input data-t="${i}" data-f="color" type="color" value="${esc(t.color || '#e5e7eb')}"></td>
      <td style="text-align:center"><input data-t="${i}" data-f="placeholder" type="checkbox" ${t.placeholder ? 'checked' : ''} style="width:auto"
        title="Platzhalter: Person ist da, konkreter Dienst wird noch zugeteilt"></td>
      <td><button class="btn small danger" data-action="type-del" data-i="${i}">✕</button></td></tr>`).join('');

  const r = S.importResult;
  const importPreview = r ? `<div class="preview" style="margin-top:12px">
      <strong>Vorschau</strong><br>
      Format: ${esc(r.layout)}<br>
      Zeitraum: ${fmt(r.from)} – ${fmt(r.to)}<br>
      Mitarbeiter erkannt: ${r.employees} · Einträge: ${r.entries.length}<br>
      Schichtcodes: ${[...r.codes].map(c => chip(c)).join(' ') || '–'}
      ${r.unknownCodes.length ? `<div class="warn">Unbekannte Codes werden als neue Schichtart angelegt: ${r.unknownCodes.map(esc).join(', ')}</div>` : ''}
      ${r.unmatched.length ? `<div class="warn">Nicht zugeordnet (werden ignoriert – Namen müssen Name, Kürzel oder E-Mail eines Mitarbeiters entsprechen): ${r.unmatched.map(esc).join(', ')}</div>` : ''}
      <div class="warn">Bestehende Grundplan-Einträge dieser Mitarbeiter im Zeitraum werden überschrieben. Bereits angenommene Tausche und Urlaube bleiben erhalten.</div>
      <div class="actions"><button class="btn" data-action="import-cancel">Abbrechen</button>
      <button class="btn primary" data-action="import-run">Jetzt importieren</button></div>
    </div>` : '';

  return `${renderTeamOverview()}
    <div class="card">
      <div class="row" style="justify-content:space-between;align-items:center">
        <h2 style="margin:0">Mitarbeiter (${S.users.filter(u => u.active !== false).length} aktiv)</h2>
        <button class="btn primary" data-action="user-new">+ Mitarbeiter anlegen</button>
      </div>
      <div style="overflow-x:auto"><table class="simple" style="margin-top:8px">
        <thead><tr><th>Name</th><th>E-Mail</th><th>Rolle</th><th></th></tr></thead><tbody>${users}</tbody></table></div>
    </div>

    ${renderTakeover()}

    <div class="card" data-keep>
      <h2>Grundplan hochladen (CSV / Excel)</h2>
      <p class="muted">Erste Spalte: Name (oder Kürzel/E-Mail), danach eine Spalte pro Tag mit Datum in der Kopfzeile, Zellen mit Schichtcodes (F, S, N …; leer = frei).
        Alternativ: Spalten <code>Datum;Mitarbeiter;Schicht</code>. Am einfachsten: Vorlage herunterladen, ausfüllen, hochladen.</p>
      <div class="row">
        <label>Datei<input type="file" id="importFile" accept=".csv,.xlsx,.xls,.ods,.txt"></label>
        <label style="flex:0 1 120px">Jahr (falls Datum ohne Jahr)<input type="number" id="importYear" value="${S.cur.y}" min="2020" max="2100"></label>
        <button class="btn" data-action="export-template">⬇ Vorlage ${MONTHS[S.cur.m - 1]} ${S.cur.y}</button>
        <button class="btn" data-action="export-plan">📊 Plan als Excel (mit Farben)</button>
      </div>
      ${importPreview}
    </div>

    <div class="card" data-keep>
      <h2>Schichtarten</h2>
      <div style="overflow-x:auto"><table class="simple">
        <thead><tr><th>Code</th><th>Bezeichnung</th><th>Beginn</th><th>Ende</th><th>Farbe</th><th title="Person ist da, Dienst wird noch zugeteilt">Platzhalter</th><th></th></tr></thead>
        <tbody>${types}</tbody></table></div>
      <div class="row" style="margin-top:10px">
        <button class="btn" data-action="type-add">+ Schichtart</button>
        <button class="btn" data-action="type-suggest" title="Früh gelb, Spät orange, Nacht blau, Platzhalter grau">🎨 Farbvorschlag</button>
        <button class="btn primary" data-action="type-save">Speichern</button>
      </div>
    </div>`;
}

function bindAdmin() {
  const file = $('#importFile');
  if (file) file.addEventListener('change', previewImport);
  const tf = $('#takeoverFile');
  if (tf) tf.addEventListener('change', e => previewTakeover(e).catch(fail));
  document.querySelectorAll('[data-t]').forEach(inp => inp.addEventListener(inp.type === 'checkbox' ? 'change' : 'input', () => {
    const v = inp.type === 'checkbox' ? inp.checked : inp.value;
    S.types = S.types.map((t, i) => i === +inp.dataset.t ? { ...t, [inp.dataset.f]: v } : t);
  }));
}

async function saveTypes() {
  const types = S.types.map(t => ({ ...t, code: t.code.trim().toUpperCase(), placeholder: !!t.placeholder })).filter(t => t.code);
  const codes = types.map(t => t.code);
  if (new Set(codes).size !== codes.length) { toast('Codes müssen eindeutig sein.', true); return; }
  await setDoc(doc(db, 'config', 'shiftTypes'), { types });
  toast('Schichtarten gespeichert.');
}

function openUserDialog(uid) {
  const u = uid ? S.usersById[uid] : { name: '', email: '', short: '', role: 'employee', active: true, order: S.users.length + 1 };
  const self = uid === S.uid;
  openDialog(`<h2>${uid ? 'Mitarbeiter bearbeiten' : 'Mitarbeiter anlegen'}</h2>
    <div class="row">
      <label>Name<input id="uName" value="${esc(u.name)}" required maxlength="60"></label>
      <label style="flex:0 1 90px">Kürzel<input id="uShort" value="${esc(u.short || '')}" maxlength="6"></label>
    </div>
    <label style="margin-top:8px">E-Mail<input id="uEmail" type="email" value="${esc(u.email)}" ${uid ? 'disabled' : 'required'}></label>
    <div class="row" style="margin-top:8px">
      <label>Rolle<select id="uRole" ${self ? 'disabled' : ''}>
        <option value="employee" ${u.role !== 'admin' ? 'selected' : ''}>Mitarbeiter</option>
        <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin (Teamleitung)</option></select></label>
      <label style="flex:0 1 90px">Reihenfolge<input id="uOrder" type="number" value="${u.order ?? ''}" min="0" max="999"></label>
      <label style="flex:0 1 70px">Farbe<input id="uColor" type="color" value="${esc(u.color || '#e5e7eb')}"></label>
      <label style="flex:0 1 auto"><span>Aktiv</span><input id="uActive" type="checkbox" ${u.active !== false ? 'checked' : ''} ${self ? 'disabled' : ''} style="width:auto"></label>
    </div>
    ${uid ? '' : '<p class="muted">Nach dem Anlegen erhält die Person automatisch eine E-Mail, um ihr eigenes Passwort zu setzen.</p>'}
    <div class="actions">
      <button type="button" class="btn" data-close>Abbrechen</button>
      <button type="submit" class="btn primary">${uid ? 'Speichern' : 'Anlegen & Einladung senden'}</button>
    </div>`, async () => {
    const data = {
      name: $('#uName').value.trim(),
      short: $('#uShort').value.trim(),
      role: self ? 'admin' : $('#uRole').value,
      active: self ? true : $('#uActive').checked,
      order: Number($('#uOrder').value || 999),
      color: $('#uColor').value,
    };
    if (!data.name) { toast('Name fehlt.', true); return false; }
    if (uid) {
      await updateDoc(doc(db, 'users', uid), data);
      toast('Gespeichert.');
      return;
    }
    const email = $('#uEmail').value.trim().toLowerCase();
    const newUid = await createAuthUser(email);
    await setDoc(doc(db, 'users', newUid), { ...data, email, createdAt: serverTimestamp() });
    await sendPasswordResetEmail(auth, email);
    toast(`${data.name} angelegt – Einladung an ${email} gesendet.`);
  });
}

// Legt einen Login über eine zweite Firebase-Instanz an, damit der Admin angemeldet bleibt.
async function createAuthUser(email) {
  const secondary = initializeApp(FIREBASE_CONFIG, `create-${Date.now()}`);
  try {
    const tmpPw = crypto.getRandomValues(new Uint32Array(4)).join('-') + 'Aa!';
    const secAuth = getAuth(secondary);
    if (USE_EMULATOR) connectAuthEmulator(secAuth, 'http://127.0.0.1:9099', { disableWarnings: true });
    const cred = await createUserWithEmailAndPassword(secAuth, email, tmpPw);
    await signOut(secAuth);
    return cred.user.uid;
  } finally {
    await deleteApp(secondary);
  }
}

async function previewImport(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const rows = await readRows(file, window.XLSX);
    const res = interpretRows(rows, S.users, Number($('#importYear').value) || S.cur.y);
    res.unknownCodes = [...res.codes].filter(c => !typeOf(c));
    S.importResult = res;
  } catch (err) {
    S.importResult = null;
    toast(err.message, true);
  }
  document.activeElement?.blur();
  render();
}

async function runImport() {
  const r = S.importResult;
  if (!r) return;
  // Neue Codes als Schichtarten anlegen
  if (r.unknownCodes.length) {
    const palette = ['#fde68a', '#a7f3d0', '#fbcfe8', '#ddd6fe', '#fed7aa', '#99f6e4'];
    const types = [...S.types, ...r.unknownCodes.map((c, i) => ({ code: c, label: c, start: '', end: '', color: palette[i % palette.length], placeholder: false }))];
    await setDoc(doc(db, 'config', 'shiftTypes'), { types });
  }
  // Pro Monat ein Dokument; nur die betroffenen Zellen überschreiben (mergeFields)
  const byMonth = {};
  for (const { date, uid, code } of r.entries) {
    const mk = date.slice(0, 7);
    byMonth[mk] ??= { data: { days: {} }, cells: new Set() };
    byMonth[mk].data.days[date] ??= {};
    byMonth[mk].data.days[date][uid] = code;   // bei Duplikaten gewinnt der letzte Eintrag
    byMonth[mk].cells.add(`${date}|${uid}`);
  }
  const batch = writeBatch(db);
  for (const [mk, { data, cells }] of Object.entries(byMonth)) {
    const fields = [...cells].map(c => new FieldPath('days', ...c.split('|')));
    batch.set(doc(db, 'plan', mk), data, { mergeFields: fields });
  }
  await batch.commit();
  S.importResult = null;
  toast(`Import abgeschlossen: ${r.entries.length} Einträge in ${Object.keys(byMonth).length} Monat(en).`);
  const [y, m] = r.from.split('-').map(Number);
  S.cur = { y, m };
  S.view = 'plan';
  render();
}

function exportMonth(effective) {
  if (!window.XLSX) { toast('Excel-Bibliothek lädt noch …', true); return; }
  const { y, m } = S.cur;
  const dates = daysOfMonth(y, m);
  const swaps = planEvents();
  const header = ['Name', ...dates.map(d => `${WD[parseIso(d).getDay()]} ${d.slice(8)}.${d.slice(5, 7)}.${d.slice(0, 4)}`)];
  const rows = visibleUsers().map(u => [u.name, ...dates.map(d => {
    if (effective) {
      const vac = vacationOn(d, u.id);
      return vac ? vac.type : (effectiveDay(d, swaps).day[u.id] || '');
    }
    return S.months[monthKey(y, m)]?.days?.[d]?.[u.id] || '';
  })]);
  const ws = window.XLSX.utils.aoa_to_sheet([header, ...rows]);
  ws['!cols'] = [{ wch: 22 }, ...dates.map(() => ({ wch: 6 }))];
  const wb = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(wb, ws, `${pad(m)}-${y}`);
  window.XLSX.writeFile(wb, `${effective ? 'schichtplan' : 'vorlage-grundplan'}-${y}-${pad(m)}.xlsx`);
}

// ── Excel-Export mit Farben (wie die bisherige Excel) ─────────────────────────
// ExcelJS wird erst beim ersten Export geladen.

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = Object.assign(document.createElement('script'), { src, onload: resolve, onerror: () => reject(new Error('Laden fehlgeschlagen: ' + src)) });
    document.head.append(el);
  });
}

function openExportDialog() {
  const { y, m } = S.cur;
  openDialog(`<h2>📊 Excel-Export</h2>
    <p class="muted" style="margin-top:-4px">Der aktuelle Plan inkl. Tauschen, Übernahmen und Abwesenheiten – in den gewohnten Farben.
      Zusätzlich Blätter mit allen Abwesenheiten${isAdmin() ? ' und Wunschfrei-Einträgen' : ''}.</p>
    <div class="list">
      <button type="button" class="btn primary" id="xMonth" style="text-align:left">${MONTHS[m - 1]} ${y}</button>
      <button type="button" class="btn" id="xYear" style="text-align:left">Ganzes Jahr ${y} (ein Blatt pro Monat)</button>
    </div>
    <div class="actions"><button type="button" class="btn" data-close>Schließen</button></div>`);
  const go = months => async () => {
    $('#xMonth').disabled = $('#xYear').disabled = true;
    try { await exportExcel(y, months); $('#dlg').close(); } catch (e) { fail(e); $('#xMonth').disabled = $('#xYear').disabled = false; }
  };
  $('#xMonth').onclick = go([m]);
  $('#xYear').onclick = go(Array.from({ length: 12 }, (_, i) => i + 1));
}

// '#abc' / '#aabbcc' / 'var(--vac)' → 'FFAABBCC' (ExcelJS)
function argb(c) {
  if (!c) return null;
  if (c.startsWith('var(')) return 'FFFDE68A';
  let h = c.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map(x => x + x).join('');
  return /^[0-9a-f]{6}$/i.test(h) ? `FF${h.toUpperCase()}` : null;
}

// Datum für Excel (ExcelJS rechnet in UTC – sonst wäre es in Österreich um einen Tag verschoben)
const xlDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };

async function exportExcel(y, months) {
  toast('Excel wird erstellt …');
  if (!window.ExcelJS) await loadScript('https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js');
  await Promise.all([ensureWindow(monthKey(y, months[0])), ...months.map(m => ensureMonth(monthKey(y, m)))]);
  const ev = planEvents();
  const users = visibleUsers();
  const wb = new window.ExcelJS.Workbook();
  wb.creator = 'Schichtplan';
  const fill = c => (argb(c) ? { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(c) } } : undefined);
  const thin = { style: 'thin', color: { argb: 'FFD1D5DB' } };
  const border = { top: thin, left: thin, bottom: thin, right: thin };
  const OFF = '#eef0f3', HOL = '#fee2e2';

  for (const m of months) {
    const dates = daysOfMonth(y, m);
    const ws = wb.addWorksheet(`${MONTHS[m - 1].slice(0, 3)} ${y}`, { views: [{ state: 'frozen', xSplit: 1, ySplit: 2 }] });
    ws.getColumn(1).width = 24;
    dates.forEach((_, i) => { ws.getColumn(i + 2).width = 5.5; });
    ws.getCell(1, 1).value = `Schichtplan ${MONTHS[m - 1]} ${y}`;
    ws.getCell(1, 1).font = { bold: true, size: 14 };
    // Kopfzeile
    const head = ws.getRow(2);
    head.getCell(1).value = 'Mitarbeiter';
    dates.forEach((d, i) => {
      const c = head.getCell(i + 2);
      c.value = `${WD[parseIso(d).getDay()]}\n${parseIso(d).getDate()}`;
      c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      if (holidayName(d)) { c.fill = fill(HOL); c.font = { bold: true, color: { argb: 'FFB91C1C' } }; c.note = holidayName(d); }
      else if (isWeekend(d)) c.fill = fill(OFF);
    });
    head.height = 30;
    head.eachCell(c => { c.border = border; if (!c.font) c.font = { bold: true }; });

    const eff = Object.fromEntries(dates.map(d => [d, effectiveDay(d, ev)]));
    users.forEach((u, r) => {
      const row = ws.getRow(r + 3);
      row.getCell(1).value = u.name;
      if (personColor(u.id)) row.getCell(1).border = { ...border, left: { style: 'thick', color: { argb: argb(personColor(u.id)) || 'FF000000' } } };
      else row.getCell(1).border = border;
      dates.forEach((d, i) => {
        const vac = vacationOn(d, u.id);
        const code = eff[d].day[u.id] || '';
        const touched = eff[d].touched.has(u.id) && code && !vac;
        const look = cellLook(u.id, code, vac, touched ? (eff[d].from.get(u.id) ?? null) : undefined);
        const c = row.getCell(i + 2);
        c.value = look.text || null;
        c.alignment = { horizontal: 'center' };
        c.border = border;
        const bg = look.bg || (isOffDay(d) ? (holidayName(d) ? HOL : OFF) : '');
        if (fill(bg)) c.fill = fill(bg);
        c.font = { bold: true, ...(argb(look.fg) ? { color: { argb: argb(look.fg) } } : {}), ...(look.ph ? { italic: true, bold: false } : {}) };
        const notes = [vac ? `${VAC_TYPES[vac.type]}${vac.note ? `: ${vac.note}` : ''}` : '', touched ? eff[d].touched.get(u.id) : '',
          isAdmin() && !vac && wishOn(d, u.id) ? `Wunsch: frei${wishOn(d, u.id).note ? ` (${wishOn(d, u.id).note})` : ''}` : ''].filter(Boolean);
        if (notes.length) c.note = notes.join('\n');
      });
    });

    // Besetzung pro Dienst
    let r = users.length + 4;
    for (const tp of S.types) {
      const row = ws.getRow(r++);
      row.getCell(1).value = `${tp.code} – ${tp.label}`;
      row.getCell(1).font = { color: { argb: 'FF6B7280' } };
      dates.forEach((d, i) => {
        const n = users.filter(u => !vacationOn(d, u.id) && codeParts(eff[d].day[u.id]).some(c => c.toUpperCase() === tp.code.toUpperCase())).length;
        const c = row.getCell(i + 2);
        c.value = n || null; c.alignment = { horizontal: 'center' }; c.font = { color: { argb: 'FF6B7280' } };
      });
    }
    // Legende
    r++;
    const legend = [['U', '', 'Urlaub/ZA/FB – in der Farbe der Person (bei hinterlegter Farbe steht der eigentliche Dienst)'],
      ['K', '#dc2626', 'Krankenstand'], ['F', '#111827', 'übernommen/getauscht – Schrift in der Farbe der Person, deren Dienst es war']];
    for (const [t, bg, text] of legend) {
      const row = ws.getRow(r++);
      row.getCell(2).value = t; row.getCell(2).alignment = { horizontal: 'center' };
      row.getCell(2).fill = fill(bg || 'var(--vac)');
      row.getCell(2).font = { bold: true, color: { argb: bg ? 'FFFFFFFF' : 'FF111827' } };
      row.getCell(3).value = text;
    }
  }

  // Abwesenheiten im Zeitraum
  const from = `${monthKey(y, months[0])}-01`, to = daysOfMonth(y, months[months.length - 1]).pop();
  const abs = wb.addWorksheet('Abwesenheiten', { views: [{ state: 'frozen', ySplit: 1 }] });
  abs.columns = [{ header: 'Mitarbeiter', width: 24 }, { header: 'Art', width: 16 }, { header: 'Von', width: 12 },
    { header: 'Bis', width: 12 }, { header: 'Arbeitstage', width: 12 }, { header: 'Notiz', width: 40 }];
  abs.getRow(1).font = { bold: true };
  S.vacations.filter(v => v.from <= to && v.to >= from && S.usersById[v.uid])
    .sort((a, b) => userName(a.uid).localeCompare(userName(b.uid), 'de') || a.from.localeCompare(b.from))
    .forEach(v => {
      const row = abs.addRow([userName(v.uid), VAC_TYPES[v.type] || v.type, xlDate(v.from), xlDate(v.to), countWorkdays(v.from, v.to, y), v.note || '']);
      row.getCell(3).numFmt = row.getCell(4).numFmt = 'dd.mm.yyyy';
      const bg = v.type === 'K' ? '#dc2626' : personColor(v.uid);
      if (fill(bg)) row.getCell(1).fill = fill(bg);
      if (v.type === 'K') row.getCell(1).font = { color: { argb: 'FFFFFFFF' } };
    });

  // Wunschfrei (nur Admins – für die Urlaubsplanung)
  if (isAdmin()) {
    const wsW = wb.addWorksheet('Wunschfrei', { views: [{ state: 'frozen', ySplit: 1 }] });
    wsW.columns = [{ header: 'Mitarbeiter', width: 24 }, { header: 'Von', width: 12 }, { header: 'Bis', width: 12 }, { header: 'Notiz', width: 40 }];
    wsW.getRow(1).font = { bold: true };
    S.wishes.filter(w => w.from <= to && w.to >= from).sort((a, b) => a.from.localeCompare(b.from))
      .forEach(w => {
        const row = wsW.addRow([userName(w.uid), xlDate(w.from), xlDate(w.to), w.note || '']);
        row.getCell(2).numFmt = row.getCell(3).numFmt = 'dd.mm.yyyy';
      });
  }

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: months.length === 1 ? `schichtplan-${y}-${pad(months[0])}.xlsx` : `schichtplan-${y}.xlsx`,
  });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast('Excel-Datei erstellt.');
}

function openAdminCellDialog(date, uid) {
  const base = S.months[date.slice(0, 7)]?.days?.[date]?.[uid] || '';
  const { day, touched } = effectiveDay(date);
  const vac = vacationOn(date, uid);
  openDialog(`<h2>${esc(userName(uid))} · ${fmt(date)}</h2>
    <label>Grundplan<select id="aCode">
      <option value="">frei</option>
      ${S.types.map(t => `<option value="${esc(t.code)}" ${t.code === base ? 'selected' : ''}>${esc(t.code)} – ${esc(t.label)}</option>`).join('')}
    </select></label>
    ${touched.has(uid) ? `<div class="warn">Aktuell (${esc(touched.get(uid))}): ${chip(day[uid])}. Änderungen am Grundplan wirken „unter“ Tausch/Vertretung.</div>` : ''}
    ${vac ? `<div class="warn">Abwesend: ${esc(VAC_TYPES[vac.type])} ${fmt(vac.from)} – ${fmt(vac.to)}</div>` : ''}
    <div class="actions">
      <button type="button" class="btn" data-close>Abbrechen</button>
      ${vac ? '<button type="button" class="btn danger" id="aVacDel">Abwesenheit löschen</button>'
        : '<button type="button" class="btn" id="aVac">Abwesenheit eintragen</button>'}
      ${uid !== S.uid ? '' : '<button type="button" class="btn" id="aSwap">Tausch anfragen</button>'}
      <button type="submit" class="btn primary">Speichern</button>
    </div>`, async () => {
    await setDoc(doc(db, 'plan', date.slice(0, 7)), { days: { [date]: { [uid]: $('#aCode').value } } }, { merge: true });
    toast('Grundplan geändert.');
  });
  if ($('#aVac')) $('#aVac').onclick = () => openVacationDialog(uid, date);
  if ($('#aVacDel')) $('#aVacDel').onclick = () => { $('#dlg').close(); deleteVacation(vac.id).catch(fail); };
  if ($('#aSwap')) $('#aSwap').onclick = () => openSwapDialog(date, S.uid, null, date);
}

// ── Push-Benachrichtigungen ──────────────────────────────────────────────────

const PUSH_KEY = 'schichtplan-push-token';
const lsGet = () => { try { return localStorage.getItem(PUSH_KEY); } catch { return null; } };
const lsSet = v => { try { v ? localStorage.setItem(PUSH_KEY, v) : localStorage.removeItem(PUSH_KEY); } catch { /* egal */ } };
let messaging = null;

const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function pushActive() {
  return typeof Notification !== 'undefined' && Notification.permission === 'granted' && !!lsGet();
}

const pushConfigured = () => !!VAPID_KEY && VAPID_KEY !== 'HIER_EINTRAGEN';

function updatePushButton() {
  const b = $('#pushBtn');
  if (!b) return;
  // Solange Push nicht eingerichtet ist (kein Schlüssel), Glocke ausblenden
  b.classList.toggle('hidden', !pushConfigured());
  b.textContent = pushActive() ? '🔔' : '🔕';
  b.title = pushActive() ? 'Benachrichtigungen sind an (tippen zum Ausschalten)' : 'Benachrichtigungen einschalten';
}

async function getMessagingIfSupported() {
  if (messaging) return messaging;
  if (!VAPID_KEY || VAPID_KEY === 'HIER_EINTRAGEN' || !('serviceWorker' in navigator) || !await isSupported()) return null;
  messaging = getMessaging(app);
  onMessage(messaging, p => toast(`🔔 ${p.notification?.title || ''}${p.notification?.body ? ` – ${p.notification.body}` : ''}`));
  return messaging;
}

async function registerToken() {
  const m = await getMessagingIfSupported();
  if (!m) return null;
  const reg = await navigator.serviceWorker.register(
    `firebase-messaging-sw.js?config=${encodeURIComponent(JSON.stringify(FIREBASE_CONFIG))}`);
  const token = await getToken(m, { vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
  // Gerät gehört jetzt diesem Login (auch wenn sich vorher jemand anderes hier angemeldet hatte)
  await setDoc(doc(db, 'pushTokens', token), {
    uid: S.uid, createdAt: serverTimestamp(), device: navigator.userAgent.slice(0, 200),
  });
  const old = lsGet();
  if (old && old !== token) await deleteDoc(doc(db, 'pushTokens', old)).catch(() => {});
  lsSet(token);
  return token;
}

// Beim Start: falls bereits erlaubt, Token auffrischen (Tokens können sich ändern)
async function refreshPush() {
  updatePushButton();
  if (!pushActive()) return;
  try { await registerToken(); } catch (e) { console.warn('Push-Token', e); }
  updatePushButton();
}

async function togglePush() {
  if (pushActive()) {
    if (!confirm('Benachrichtigungen auf diesem Gerät ausschalten?')) return;
    await removePushToken();
    toast('Benachrichtigungen ausgeschaltet.');
    return;
  }
  if (isIos() && !isStandalone()) {
    openDialog(`<h2>Benachrichtigungen am iPhone</h2>
      <p>Apple erlaubt Benachrichtigungen nur, wenn der Schichtplan als App auf dem Home-Bildschirm liegt:</p>
      <ol><li>In Safari unten auf <strong>Teilen</strong> (□↑) tippen</li>
      <li><strong>Zum Home-Bildschirm</strong> wählen</li>
      <li>Die App vom Home-Bildschirm öffnen, anmelden und dort auf 🔕 tippen</li></ol>
      <p class="muted">Benötigt iOS 16.4 oder neuer.</p>
      <div class="actions"><button type="button" class="btn primary" data-close>Verstanden</button></div>`);
    return;
  }
  if (!await getMessagingIfSupported()) {
    toast('Dieser Browser unterstützt keine Push-Benachrichtigungen (oder sie sind noch nicht eingerichtet).', true);
    return;
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    toast('Benachrichtigungen wurden nicht erlaubt. Das lässt sich in den Browser-Einstellungen ändern.', true);
    return;
  }
  await registerToken();
  updatePushButton();
  toast('🔔 Benachrichtigungen sind an – du wirst bei Tauschanfragen informiert.');
}

// Beim Abmelden/Ausschalten: Gerät abmelden, damit keine fremden Nachrichten mehr ankommen
async function removePushToken() {
  const token = lsGet();
  lsSet(null);
  updatePushButton();
  if (!token) return;
  await deleteDoc(doc(db, 'pushTokens', token)).catch(() => {});
  try { const m = await getMessagingIfSupported(); if (m) await deleteToken(m); } catch { /* egal */ }
}

function coverSummary(vacationId) {
  const cs = S.covers.filter(c => c.vacationId === vacationId);
  if (!cs.length) return '';
  const open = cs.filter(c => c.status === 'open').length;
  const by = [...new Set(cs.filter(c => c.status === 'assigned').map(c => userName(c.assignee)))];
  return `<div class="muted">${cs.length} Dienst(e): ${by.length ? `vertreten von ${esc(by.join(', '))}` : ''}${by.length && open ? ' · ' : ''}${open ? `<span style="color:var(--danger)">${open} offen</span>` : ''}</div>`;
}

// ── Einmalige Übernahme der bisherigen Excel (Plan, Abwesenheiten, Vertretungen/Tausche, Farben) ──
// Die Übernahme-Datei (JSON) erzeugt tools/excel_uebernahme.py aus der bisherigen Excel.

function renderTakeover() {
  const t = S.takeover;
  let preview = '';
  if (t) {
    const { j, map } = t;
    const dates = Object.keys(j.plan).sort();
    const mapped = j.people.filter(p => map[p.key]);
    const cnt = type => j.absences.filter(a => a.type === type && map[a.person]).length;
    const marks = Object.values(j.marks).reduce((n, m) => n + Object.keys(m).length, 0);
    preview = `<div class="preview" style="margin-top:12px">
      <strong>Vorschau: ${esc(j.source || '')}</strong><br>
      Zeitraum: ${fmt(dates[0])} – ${fmt(dates[dates.length - 1])}<br>
      Abwesenheiten: ${cnt('U')} × Urlaub/ZA, ${cnt('K')} × Krank, ${cnt('FB')} × Fortbildung · Markierte Übernahmen/Tausche: ${marks}
      <table class="simple" style="margin-top:8px"><thead><tr><th>In der Excel</th><th>In der App</th><th>Farbe</th></tr></thead><tbody>
      ${j.people.map(p => `<tr><td>${esc(p.key)}</td><td>${map[p.key] ? esc(userName(map[p.key])) : '<span style="color:var(--danger)">✗ nicht gefunden – wird übersprungen</span>'}</td>
        <td><span class="chip" style="background:${esc(p.color)}">&nbsp;&nbsp;</span></td></tr>`).join('')}
      </tbody></table>
      ${mapped.length < j.people.length ? '<div class="warn">Nicht gefundene Personen zuerst unter „Mitarbeiter anlegen“ anlegen (Nachname muss passen) und die Datei dann erneut wählen.</div>' : ''}
      <label style="margin-top:10px;display:flex;gap:8px;align-items:center;color:var(--text)">
        <input type="checkbox" id="takeoverWipe" checked style="width:auto"> Bestehende Abwesenheiten dieser Personen im Zeitraum vorher löschen (empfohlen, verhindert Doppelte)</label>
      <div class="warn">Überschreibt im Zeitraum den Plan dieser Personen, setzt ihre Farben und die Schichtarten (F, S, N, TD1–TD3).</div>
      <div class="actions"><button class="btn" data-action="takeover-cancel">Abbrechen</button>
        <button class="btn primary" data-action="takeover-run" ${mapped.length ? '' : 'disabled'}>Jetzt übernehmen</button></div>
    </div>`;
  }
  return `<div class="card" data-keep>
    <h2>Übernahme aus der bisherigen Excel</h2>
    <p class="muted">Einmalig: übernimmt Plan, Urlaub/ZA, Krankenstand und die markierten Vertretungen/Tausche samt Personenfarben.
      Dafür die vorbereitete Übernahme-Datei (<code>.json</code>) wählen.</p>
    <label>Übernahme-Datei<input type="file" id="takeoverFile" accept=".json,application/json"></label>
    ${preview}
  </div>`;
}

async function previewTakeover(e) {
  const file = e.target.files[0];
  if (!file) return;
  let j;
  try { j = JSON.parse(await file.text()); } catch { throw new Error('Die Datei ist keine gültige Übernahme-Datei.'); }
  if (j.format !== 'schichtplan-uebernahme') throw new Error('Die Datei ist keine Übernahme-Datei.');
  const match = buildMatcher(S.users.filter(u => u.active !== false));
  S.takeover = { j, map: Object.fromEntries(j.people.map(p => [p.key, match(p.key)])) };
  document.activeElement?.blur();
  render();
}

// Schreibt in mehreren Batches (Firestore erlaubt max. 500 Schreibvorgänge pro Batch)
async function commitInChunks(ops, size = 400) {
  for (let i = 0; i < ops.length; i += size) {
    const batch = writeBatch(db);
    ops.slice(i, i + size).forEach(op => op(batch));
    await batch.commit();
  }
}

async function runTakeover() {
  const { j, map } = S.takeover;
  const wipe = $('#takeoverWipe')?.checked;
  const dates = Object.keys(j.plan).sort();
  const first = dates[0], last = dates[dates.length - 1];
  const uids = new Set(Object.values(map).filter(Boolean));
  if (!confirm(`Übernahme für ${uids.size} Personen, ${fmt(first)} – ${fmt(last)} jetzt durchführen?`)) return;
  toast('Übernahme läuft …');

  // 1. Schichtarten: aus der Datei, bestehende andere Codes bleiben erhalten
  const codes = new Set(j.types.map(t => t.code));
  await setDoc(doc(db, 'config', 'shiftTypes'), { types: [...j.types, ...S.types.filter(t => !codes.has(t.code))] });

  // 2. Personenfarben
  await commitInChunks(j.people.filter(p => map[p.key]).map(p => b => b.update(doc(db, 'users', map[p.key]), { color: p.color })));

  // 3. Plan (nur Zellen der zugeordneten Personen) und 4. Markierungen, je Monat ein Dokument
  const planOps = [];
  const byMonth = {};
  for (const [date, row] of Object.entries(j.plan)) {
    const mk = date.slice(0, 7);
    byMonth[mk] ??= { plan: { days: {} }, fields: [], marks: { days: {} } };
    for (const [key, code] of Object.entries(row)) {
      const uid = map[key];
      if (!uid) continue;
      (byMonth[mk].plan.days[date] ??= {})[uid] = code;
      byMonth[mk].fields.push(new FieldPath('days', date, uid));
    }
  }
  for (const [date, row] of Object.entries(j.marks)) {
    const mk = date.slice(0, 7);
    for (const [key, fromKey] of Object.entries(row)) {
      const uid = map[key];
      if (!uid || !byMonth[mk]) continue;
      (byMonth[mk].marks.days[date] ??= {})[uid] = fromKey ? (map[fromKey] || null) : null;
    }
  }
  for (const [mk, m] of Object.entries(byMonth)) {
    if (m.fields.length) planOps.push(b => b.set(doc(db, 'plan', mk), m.plan, { mergeFields: m.fields }));
    planOps.push(b => b.set(doc(db, 'marks', mk), m.marks));
  }
  await commitInChunks(planOps);

  // 5. Bestehende Abwesenheiten im Zeitraum entfernen (samt zugehöriger offener/vergebener Dienste)
  if (wipe) {
    const old = S.vacations.filter(v => uids.has(v.uid) && v.from <= last && v.to >= first);
    const oldIds = new Set(old.map(v => v.id));
    await commitInChunks([
      ...S.covers.filter(c => c.vacationId && oldIds.has(c.vacationId)).map(c => b => b.delete(doc(db, 'coverages', c.id))),
      ...old.map(v => b => b.delete(doc(db, 'vacations', v.id))),
    ]);
  }

  // 6. Abwesenheiten anlegen
  await commitInChunks(j.absences.filter(a => map[a.person]).map(a => b => {
    const data = { uid: map[a.person], from: a.from, to: a.to, type: a.type, createdAt: serverTimestamp(), createdBy: S.uid };
    if (a.note) data.note = String(a.note).slice(0, 200);
    b.set(doc(collection(db, 'vacations')), data);
  }));

  S.takeover = null;
  toast(`Übernahme abgeschlossen: ${Object.keys(byMonth).length} Monate, ${j.absences.length} Abwesenheiten.`);
  goto('plan');
}

// ── "Für dich zu erledigen": Anfragen und offene Dienste direkt bearbeiten ──
function renderTodo() {
  const t = today();
  const incoming = S.swaps.filter(x => x.status === 'pending' && x.to === S.uid);
  const outgoing = S.swaps.filter(x => x.status === 'pending' && x.from === S.uid);
  const myOffers = S.covers.filter(c => c.kind === 'release' && c.status === 'open' && c.absentUid === S.uid && c.date >= t);
  const claimable = claimableCovers();
  const ev = planEvents();
  const rows = [
    ...incoming.map(x => `<div class="item"><div class="grow">🔁 ${swapLine(x)}${x.note ? `<div class="muted">„${esc(x.note)}“</div>` : ''}</div>
      <button class="btn small primary" data-action="swap-accept" data-id="${x.id}">Annehmen</button>
      <button class="btn small danger" data-action="swap-reject" data-id="${x.id}">Ablehnen</button></div>`),
    ...claimable.map(c => {
      const mine = effectiveDay(c.date, ev).day[S.uid];
      const why = c.kind === 'release' ? `${esc(userName(c.absentUid))} gibt ab` : `${esc(VAC_TYPES[S.vacations.find(v => v.id === c.vacationId)?.type] || 'abwesend')}: ${esc(userName(c.absentUid))}`;
      return `<div class="item"><div class="grow">🙋 Offen: <strong>${fmtShort(c.date)}</strong> ${chip(c.code)} <span class="muted">· ${why}${mine ? ` · du hast ${esc(mine)}` : ''}</span></div>
        <button class="btn small primary" data-action="cover-claim" data-id="${c.id}">Übernehmen</button></div>`;
    }),
    ...outgoing.map(x => `<div class="item"><div class="grow">⏳ Deine Anfrage: ${swapLine(x)}</div>
      <button class="btn small" data-action="swap-cancel" data-id="${x.id}">Zurückziehen</button></div>`),
    ...myOffers.map(c => `<div class="item"><div class="grow">⏳ Du gibst ab: <strong>${fmtShort(c.date)}</strong> ${chip(c.code)}</div>
      <button class="btn small" data-action="cover-withdraw" data-id="${c.id}">Zurückziehen</button></div>`),
  ];
  if (!rows.length) return '';
  const limit = S.todoAll ? rows.length : 4;
  return `<div class="card todo">
    <h2>${incoming.length + claimable.length ? `Für dich zu erledigen (${incoming.length + claimable.length})` : 'Deine offenen Anfragen'}</h2>
    <div class="list">${rows.slice(0, limit).join('')}</div>
    ${rows.length > limit ? `<button class="btn small" data-action="todo-more" style="margin-top:8px">Alle ${rows.length} anzeigen</button>` : ''}
  </div>`;
}

// Abwesenheiten (Urlaub/ZA/Krank/Fortbildung) der angemeldeten Person
function renderMyAbsences() {
  const y = S.cur.y;
  const t = today();
  const mine = S.vacations.filter(v => v.uid === S.uid).sort((a, b) => b.from.localeCompare(a.from));
  const coming = mine.filter(v => v.to >= t).reverse();
  const past = mine.filter(v => v.to < t).slice(0, 10);
  const sum = types => mine.filter(v => types.includes(v.type)).reduce((n, v) => n + countWorkdays(v.from, v.to, y), 0);
  const item = v => `<div class="item">
      <div class="grow"><span class="chip" style="background:${v.type === 'K' ? '#dc2626;color:#fff' : (personColor(S.uid) || 'var(--vac)')}">${esc(v.type)}</span>
        ${fmt(v.from)}${v.to !== v.from ? ` – ${fmt(v.to)}` : ''}
        ${v.note ? `<span class="muted"> · ${esc(v.note)}</span>` : ''}${coverSummary(v.id)}</div>
      <button class="btn small danger" data-action="vac-delete" data-id="${v.id}">Löschen</button></div>`;
  return `<div class="card">
    <div class="row" style="justify-content:space-between;align-items:center">
      <h2 style="margin:0">Meine Abwesenheiten</h2>
      <button class="btn primary" data-action="vac-new">+ Urlaub / ZA / Krank</button>
    </div>
    <p class="muted">${y}: ${sum(['U'])} Tage Urlaub · ${sum(['ZA'])} Tage ZA · ${sum(['K'])} Tage krank (Mo–Fr ohne Feiertage)</p>
    <div class="list">${coming.map(item).join('') || '<p class="muted">Nichts geplant.</p>'}</div>
    ${past.length ? `<details style="margin-top:10px"><summary class="muted">Vergangene anzeigen</summary><div class="list" style="margin-top:8px">${past.map(item).join('')}</div></details>` : ''}
  </div>`;
}

// Klick auf offenen Dienst im Plan → direkt übernehmen
function openClaimDialog(date) {
  const list = S.covers.filter(c => c.date === date && c.status === 'open' && c.kind !== 'release');
  if (isAdmin()) return goto('admin');   // Admins teilen in der Verwaltung zu
  if (list.length === 1) return claimCover(list[0].id, S.uid);
  openDialog(`<h2>Offene Dienste am ${fmt(date)}</h2>
    <div class="list">${list.map(c => `<div class="item"><div class="grow">${chip(c.code)} von ${esc(userName(c.absentUid))}</div>
      <button type="button" class="btn small primary" data-action="cover-claim" data-id="${c.id}" data-close>Übernehmen</button></div>`).join('')}</div>
    <div class="actions"><button type="button" class="btn" data-close>Schließen</button></div>`);
}

// Verwaltung: Team-Übersichten (Tausche, offene Dienste, Abwesenheitstage)
function renderTeamOverview() {
  const y = S.cur.y;
  const sum = (uid, types) => S.vacations.filter(v => v.uid === uid && types.includes(v.type))
    .reduce((n, v) => n + countWorkdays(v.from, v.to, y), 0);
  const stats = visibleUsers().map(u => `<tr><td>${esc(u.name)}</td><td>${sum(u.id, ['U'])}</td>
    <td>${sum(u.id, ['ZA'])}</td><td>${sum(u.id, ['K'])}</td></tr>`).join('');
  const sorted = [...S.swaps].sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
  const pending = sorted.filter(x => x.status === 'pending');
  const history = sorted.filter(x => x.status !== 'pending').slice(0, 30);
  const item = (x, buttons) => `<div class="item"><div class="grow">${swapLine(x)}</div>
    <span class="status ${x.status}">${SWAP_STATUS[x.status] || esc(x.status)}</span>${buttons}</div>`;
  return `${renderOpen()}
    ${renderWishOverview()}
    <div class="card"><h2>Tausche</h2>
      <h3>Offene Anfragen (${pending.length})</h3><div class="list">
      ${pending.map(x => item(x, `<button class="btn small" data-action="swap-cancel" data-id="${x.id}">Verwerfen</button>`)).join('') || '<p class="muted">Keine.</p>'}</div>
      <details style="margin-top:12px"><summary class="muted">Verlauf (letzte 30)</summary><div class="list" style="margin-top:8px">
      ${history.map(x => item(x, x.status === 'accepted' ? `<button class="btn small danger" data-action="swap-revert" data-id="${x.id}">Rückgängig</button>` : '')).join('') || '<p class="muted">Noch keine Tausche.</p>'}
      </div></details>
    </div>
    <div class="card"><h2>Abwesenheitstage ${y} (Mo–Fr ohne Feiertage)</h2>
      <div style="overflow-x:auto"><table class="simple"><thead><tr><th>Mitarbeiter</th><th>Urlaub</th><th>ZA</th><th>Krank</th></tr></thead><tbody>${stats}</tbody></table></div>
      <p class="muted">Aus der Excel übernommene Abwesenheiten zählen als Urlaub (dort war Urlaub/ZA nicht unterschieden).</p>
    </div>`;
}

// ── Automatisch aktualisieren ─────────────────────────────────────────────────
// Browser/Home-Bildschirm halten alte Dateien oft fest. Die App fragt deshalb version.json ab
// (ohne Zwischenspeicher) und lädt sich neu, sobald eine neuere Version veröffentlicht ist.
async function checkVersion() {
  try {
    const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const { version } = await res.json();
    if (!version || version === APP_VERSION) return;
    if ($('#dlg').open || document.activeElement?.matches?.('input, textarea, select')) return; // nicht mitten in einer Eingabe
    const url = new URL(location.href);
    if (url.searchParams.get('v') === version) return;   // schon versucht – keine Endlosschleife
    url.searchParams.set('v', version);
    location.replace(url.toString());
  } catch { /* offline o. Ä. – egal */ }
}
checkVersion();
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkVersion(); });
