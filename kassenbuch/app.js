// Kassenbuch der FF Pichl – statische Web-App (GitHub Pages) mit Firebase Auth + Firestore.
import { initializeApp, deleteApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, connectAuthEmulator, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  sendPasswordResetEmail, createUserWithEmailAndPassword,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  initializeFirestore, connectFirestoreEmulator, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, query, where, orderBy, limit, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  writeBatch, serverTimestamp, deleteField,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import {
  getStorage, connectStorageEmulator, ref as sRef, uploadBytes, getDownloadURL, getBlob, deleteObject,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js';
import { FIREBASE_CONFIG } from './firebase-config.js';
import {
  fmt, eur, parseAmount, parseDate, deDate, norm, decodeText, parseCsv, detectColumns, applyMapping,
  ROLES, ibanFromName, cleanIban, importIds, matchRule, DEFAULT_KATEGORIEN, DEFAULT_KONTEN, DEFAULT_REGELN, parts,
  splitBankText, suchbegriff, belegNummern, chronoSort, gemeindeAbschluss, hatVp, excelKontierung, zuordnenKontierung,
  isKontiert, jahresabschluss, POSTEN_ARTEN, STUECKELUNG, stueckelungSumme, festkassaBuch,
  FEST_ARTEN, festArtVorschlag, veranstaltungImText, ZAHLWEGE, festkassaExcel, bankAbgleich,
  veranstaltungsAbrechnung, toCsv,
} from './lib.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const money = c => `<span class="${c < 0 ? 'minus' : c > 0 ? 'plus' : ''}">${fmt(c)}</span>`;
const ROLE_NAMES = { admin: 'Admin', kassier: 'Kassier', fest: 'Festkassa', pruefer: 'Kassaprüfer' };

// ── Firebase ─────────────────────────────────────────────────────────────────

const USE_EMULATOR = new URLSearchParams(location.search).has('emulator');
const CONFIGURED = FIREBASE_CONFIG.apiKey && !FIREBASE_CONFIG.apiKey.includes('HIER');
if (!CONFIGURED && !USE_EMULATOR) {
  $('#setup').classList.remove('hidden');
  throw new Error('firebase-config.js ist noch nicht ausgefüllt.');
}
const app = initializeApp(USE_EMULATOR ? { ...FIREBASE_CONFIG, apiKey: FIREBASE_CONFIG.apiKey || 'demo', projectId: 'demo-kassenbuch', storageBucket: 'demo-kassenbuch.appspot.com' } : FIREBASE_CONFIG);
const auth = getAuth(app);
const db = initializeFirestore(app, USE_EMULATOR ? {} : { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
if (USE_EMULATOR) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
}
const storage = getStorage(app);
if (USE_EMULATOR) connectStorageEmulator(storage, '127.0.0.1', 9199);

// ── Zustand ──────────────────────────────────────────────────────────────────

const S = {
  uid: null, me: null, unsub: [], yearUnsub: [], postenUnsub: {},
  tab: localStorage.getItem('kb.tab') || 'uebersicht',
  jahr: Number(localStorage.getItem('kb.jahr')) || new Date().getFullYear(),
  users: [], konten: [], kategorien: DEFAULT_KATEGORIEN, kategorienGeladen: false, regeln: [],
  buchungen: [], jahrDoc: null, vorjahrDoc: null, veranstaltungen: [], posten: {},
  filter: { konto: '', kat: '', ver: '', q: '', richtung: '' }, sel: new Set(), belegNr: new Map(),
  allgemein: { ffName: 'Pichl', gemeinde: 'Puchkirchen am Trattberg', ort: 'Pichl' }, xl: null,
  festSel: null, imp: null, log: null,
};

const role = () => S.me?.role;
const isAdmin = () => role() === 'admin';
const canBook = () => ['admin', 'kassier'].includes(role());
const canFest = () => ['admin', 'kassier', 'fest'].includes(role());
const canLog = () => ['admin', 'kassier', 'pruefer'].includes(role());
const locked = () => S.jahrDoc?.gesperrt === true;
const katById = id => S.kategorien.find(k => k.id === id);
const kontoById = id => S.konten.find(k => k.id === id);
const verById = id => S.veranstaltungen.find(v => v.id === id);
const userName = uid => S.users.find(u => u.id === uid)?.name || '–';

function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = err ? 'err' : '';
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.add('hidden'), err ? 6000 : 3000);
}
function fail(e) {
  console.error(e);
  toast(e?.code === 'permission-denied' ? 'Keine Berechtigung (oder Jahr ist abgeschlossen).' : (e?.message || String(e)), true);
}

/** Protokolleintrag in einen Batch (oder einzeln) schreiben. */
function logTo(batch, aktion, text) {
  const ref = doc(collection(db, 'log'));
  const data = { uid: S.uid, name: S.me?.name || '', wann: serverTimestamp(), aktion, text: String(text).slice(0, 2000) };
  if (batch) batch.set(ref, data); else setDoc(ref, data).catch(console.error);
}

// ── Dialog ───────────────────────────────────────────────────────────────────

/**
 * Öffnet einen Dialog. onOk() darf false zurückgeben, um offen zu bleiben.
 * extra: [{label, cls, onClick}] zusätzliche Knöpfe links.
 */
function modal(title, html, { ok = 'Speichern', onOk, wide = false, extra = [], cancel = 'Abbrechen', onOpen } = {}) {
  const dlg = $('#dlg');
  dlg.classList.toggle('wide', wide);
  $('#dlgBody').innerHTML = `<h2>${esc(title)}</h2><form id="dlgForm" novalidate>${html}
    <div class="actions">
      ${extra.map((x, i) => `<button type="button" class="btn ${x.cls || ''} ${i === 0 ? 'left' : ''}" data-extra="${i}">${esc(x.label)}</button>`).join('')}
      ${cancel ? `<button type="button" class="btn" data-close>${esc(cancel)}</button>` : ''}
      ${onOk ? `<button type="submit" class="btn primary">${esc(ok)}</button>` : ''}
    </div></form>`;
  $('#dlgBody [data-close]')?.addEventListener('click', () => dlg.close());
  extra.forEach((x, i) => $(`#dlgBody [data-extra="${i}"]`).addEventListener('click', async () => {
    try { if (await x.onClick() !== false) dlg.close(); } catch (e) { fail(e); }
  }));
  $('#dlgForm').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('#dlgForm button[type=submit]');
    btn.disabled = true;
    if (!onOk) return;
    try { if (await onOk() !== false) dlg.close(); } catch (err) { fail(err); } finally { btn.disabled = false; }
  });
  if (!dlg.open) dlg.showModal();
  onOpen?.();
}
const confirmDlg = (title, text, ok = 'OK') => new Promise(res => {
  modal(title, `<p>${text}</p>`, { ok, onOk: () => res(true) });
  $('#dlg').addEventListener('close', () => res(false), { once: true });
});

function katOptions(selected, betrag, konto = '') {
  if (konto && kontoById(konto)?.ohneKontierung) return '<option value="">— keine Kontierung —</option>';
  const groups = [['E', 'Einnahmen'], ['A', 'Ausgaben'], ['F', 'Festkassa'], ['U', 'Umbuchung']];
  // passende Gruppe zuerst
  if (betrag < 0) groups.unshift(groups.splice(1, 1)[0]);
  return `<option value="">— nicht kontiert —</option>` + groups.map(([art, name]) => {
    const ks = S.kategorien.filter(k => k.art === art && (!k.inaktiv || k.id === selected)
      && (!konto || !k.konto || k.konto === konto || k.id === selected))
      .sort((a, b) => String(a.nr).localeCompare(String(b.nr), 'de', { numeric: true }));
    return ks.length ? `<optgroup label="${name}">${ks.map(k =>
      `<option value="${esc(k.id)}" ${k.id === selected ? 'selected' : ''}>${esc(k.nr ? k.nr + ' ' : '')}${esc(k.name)}</option>`).join('')}</optgroup>` : '';
  }).join('');
}
function verOptions(selected, empty = '— keine —') {
  return `<option value="">${empty}</option>` + S.veranstaltungen.map(v =>
    `<option value="${esc(v.id)}" ${v.id === selected ? 'selected' : ''}>${esc(v.name)}</option>`).join('');
}
function kontoOptions(selected, empty) {
  return (empty ? `<option value="">${empty}</option>` : '') + S.konten.map(k =>
    `<option value="${esc(k.id)}" ${k.id === selected ? 'selected' : ''}>${esc(k.name)}</option>`).join('');
}

// ── Anmeldung ────────────────────────────────────────────────────────────────

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
      'auth/user-disabled': 'Dieser Zugang ist gesperrt.',
    })[err.code] || err.message;
  }
});
$('#forgotLink').addEventListener('click', async e => {
  e.preventDefault();
  const email = $('#loginEmail').value.trim();
  if (!email) { $('#loginErr').textContent = 'Bitte zuerst die E-Mail-Adresse eingeben.'; return; }
  try { await sendPasswordResetEmail(auth, email); } catch { /* keine Auskunft, ob es den Zugang gibt */ }
  $('#loginErr').textContent = '';
  toast('Falls ein Zugang existiert, wurde ein Link zum Passwort-Setzen gesendet.');
});
$('#logoutBtn').addEventListener('click', () => signOut(auth));
$('#noAccessLogout').addEventListener('click', () => signOut(auth));
$('#pwBtn').addEventListener('click', async () => {
  if (!await confirmDlg('Passwort ändern', `Wir schicken einen Link zum Passwort-Ändern an <b>${esc(auth.currentUser.email)}</b>.`, 'Link senden')) return;
  await sendPasswordResetEmail(auth, auth.currentUser.email);
  toast('Link wurde gesendet.');
});

function stopAll() {
  S.unsub.forEach(u => u()); S.unsub = [];
  S.log = null; S.imp = null; S.festSel = null;
  stopYear();
}
function stopYear() {
  S.yearUnsub.forEach(u => u()); S.yearUnsub = [];
  Object.values(S.postenUnsub).forEach(u => u()); S.postenUnsub = {}; S.posten = {};
  S.buchungen = []; S.veranstaltungen = []; S.jahrDoc = null; S.vorjahrDoc = null; S.sel.clear();
}

onAuthStateChanged(auth, user => {
  stopAll();
  S.uid = user?.uid || null;
  S.me = null;
  if (!user) { show('login'); return; }
  $('#noAccessUid').textContent = user.uid;
  $('#noAccessTitle').textContent = 'Verbinde …';
  $('#noAccessMsg').textContent = 'Dein Profil wird geladen.';
  show('noAccess');
  clearTimeout(S.connectTimer);
  S.connectTimer = setTimeout(() => {
    if (S.me) return;
    $('#noAccessTitle').textContent = 'Keine Verbindung';
    $('#noAccessMsg').textContent = 'Die Datenbank ist nicht erreichbar. Bitte Internetverbindung prüfen. '
      + 'Inhaltsblocker oder VPN können die Verbindung blockieren – testweise ausschalten und neu laden.';
  }, 12000);
  let started = false;
  S.unsub.push(onSnapshot(doc(db, 'users', user.uid), { includeMetadataChanges: true }, snap => {
    if (!snap.exists() && snap.metadata.fromCache) return;
    clearTimeout(S.connectTimer);
    S.me = snap.exists() ? { id: snap.id, ...snap.data() } : null;
    if (!S.me || S.me.active === false) {
      $('#noAccessTitle').textContent = 'Kein Zugriff';
      $('#noAccessMsg').textContent = S.me
        ? 'Dein Zugang ist deaktiviert. Bitte wende dich an den Kassier oder Kommandanten.'
        : 'Für deinen Login ist noch kein Profil angelegt. Bitte die unten stehende Benutzer-ID an den Admin schicken.';
      show('noAccess');
      return;
    }
    if (!started) { started = true; startData(); }
    $('#whoami').textContent = `${S.me.name} · ${ROLE_NAMES[role()] || role()}`;
    $$('.kassier-only').forEach(el => el.classList.toggle('hidden', !canBook()));
    $$('.log-only').forEach(el => el.classList.toggle('hidden', !canLog()));
    show('app');
    render();
  }, e => {
    clearTimeout(S.connectTimer);
    $('#noAccessTitle').textContent = 'Kein Zugriff';
    $('#noAccessMsg').textContent = `Zugriff verweigert (${e.code || e.message}).`;
    show('noAccess');
  }));
});

function startData() {
  S.unsub.push(onSnapshot(collection(db, 'users'), snap => {
    S.users = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.name || '').localeCompare(b.name || '', 'de'));
    render();
  }, fail));
  S.unsub.push(onSnapshot(collection(db, 'konten'), snap => {
    S.konten = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || a.name.localeCompare(b.name, 'de'));
    render();
  }, fail));
  S.unsub.push(onSnapshot(doc(db, 'config', 'kategorien'), snap => {
    const list = snap.exists() ? snap.data().list : null;
    S.kategorien = list?.length ? list : DEFAULT_KATEGORIEN;
    S.kategorienGeladen = !!list?.length;
    render();
  }, fail));
  S.unsub.push(onSnapshot(doc(db, 'config', 'allgemein'), snap => {
    if (snap.exists()) S.allgemein = { ...S.allgemein, ...snap.data() };
    render();
  }, fail));
  S.unsub.push(onSnapshot(doc(db, 'config', 'regeln'), snap => {
    S.regeln = snap.exists() ? (snap.data().list || []) : [];
    render();
  }, fail));
  startYear();
}

function startYear() {
  stopYear();
  const y = S.jahr;
  S.yearUnsub.push(onSnapshot(query(collection(db, 'buchungen'), where('jahr', '==', y)), snap => {
    S.buchungen = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => chronoSort(b, a));
    S.belegNr = belegNummern(S.buchungen);
    for (const id of [...S.sel]) if (!S.buchungen.some(b => b.id === id)) S.sel.delete(id);
    render();
  }, fail));
  S.yearUnsub.push(onSnapshot(doc(db, 'jahre', String(y)), snap => { S.jahrDoc = snap.exists() ? snap.data() : null; render(); }, fail));
  S.yearUnsub.push(onSnapshot(doc(db, 'jahre', String(y - 1)), snap => { S.vorjahrDoc = snap.exists() ? snap.data() : null; render(); }, fail));
  S.yearUnsub.push(onSnapshot(query(collection(db, 'veranstaltungen'), where('jahr', '==', y)), snap => {
    S.veranstaltungen = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.von || '').localeCompare(b.von || '') || a.name.localeCompare(b.name, 'de'));
    // Festkassa-Posten aller Veranstaltungen des Jahres mitlesen (für Abrechnung und Jahresabschluss)
    const ids = new Set(S.veranstaltungen.map(v => v.id));
    for (const id of Object.keys(S.postenUnsub)) if (!ids.has(id)) { S.postenUnsub[id](); delete S.postenUnsub[id]; delete S.posten[id]; }
    for (const id of ids) {
      if (S.postenUnsub[id]) continue;
      S.postenUnsub[id] = onSnapshot(collection(db, 'veranstaltungen', id, 'posten'), ps => {
        S.posten[id] = ps.docs.map(d => ({ id: d.id, ...d.data() }));
        render();
      }, fail);
    }
    render();
  }, fail));
}

// ── Kopfzeile, Tabs ──────────────────────────────────────────────────────────

function renderHeader() {
  const now = new Date().getFullYear();
  const years = [];
  for (let y = now + 1; y >= Math.min(now - 6, S.jahr); y--) years.push(y);
  $('#yearSel').innerHTML = years.map(y => `<option ${y === S.jahr ? 'selected' : ''}>${y}</option>`).join('');
  $('#lockChip').innerHTML = locked() ? '<span class="chip lock">🔒 abgeschlossen</span>' : '';
  const unk = S.buchungen.filter(b => !isKontiert(b, S.konten)).length;
  $('#badgeUnk').innerHTML = unk ? `<span class="badge">${unk}</span>` : '';
  $$('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === S.tab));
}
$('#yearSel').addEventListener('change', e => {
  S.jahr = Number(e.target.value);
  localStorage.setItem('kb.jahr', S.jahr);
  S.festSel = null;
  startYear();
  render();
});
$('#tabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  S.tab = b.dataset.tab;
  localStorage.setItem('kb.tab', S.tab);
  if (S.tab !== 'festkassa') S.festSel = null;
  render(true);
});

// render()      – Daten haben sich geändert: gebündelt im nächsten Frame neu zeichnen
// render(true)  – Aktion der Benutzerin/des Benutzers: sofort neu zeichnen
let renderQueued = false;
function render(user = false) {
  if (!S.me) return;
  if (!user) {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; draw(false); });
    return;
  }
  draw(true);
}
function draw(user) {
  if (!S.me) return;
  // Während jemand in ein Feld tippt, Datenänderungen nicht hineinzeichnen (Eingabe ginge sonst verloren)
  const active = document.activeElement;
  const inView = active && active !== document.body && $('#view').contains(active);
  renderHeader();
  if (inView && S.dirty && !user) { render.pending = true; return; }
  // Fokus über das Neuzeichnen hinweg erhalten
  const key = inView ? focusKey(active) : null;
  const selStart = inView && typeof active.selectionStart === 'number' ? active.selectionStart : null;
  const allowed = { import: canBook(), verwaltung: canBook(), protokoll: canLog() };
  if (allowed[S.tab] === false) S.tab = 'uebersicht';
  const views = { uebersicht: viewUebersicht, buchungen: viewBuchungen, import: viewImport, festkassa: viewFestkassa, abschluss: viewAbschluss, verwaltung: viewVerwaltung, protokoll: viewProtokoll };
  (views[S.tab] || viewUebersicht)();
  if (key) {
    const el = $('#view').querySelector(key);
    if (el) { el.focus(); if (selStart !== null) try { el.setSelectionRange(selStart, selStart); } catch { /* z. B. type=date */ } }
  }
}
function focusKey(el) {
  if (el.id) return '#' + CSS.escape(el.id);
  const attr = [...el.attributes].find(a => a.name.startsWith('data-'));
  return attr ? `[${attr.name}="${CSS.escape(attr.value)}"]` : null;
}
// S.dirty: im aktuell fokussierten Feld wurde getippt, aber noch nicht gespeichert
document.addEventListener('input', e => { if ($('#view').contains(e.target) && e.target.tagName !== 'SELECT') S.dirty = true; });
document.addEventListener('focusin', () => { S.dirty = false; });
document.addEventListener('focusout', () => {
  S.dirty = false;
  if (render.pending) { render.pending = false; setTimeout(() => render(), 0); }
});

// ── Salden ───────────────────────────────────────────────────────────────────

/** Anfangsbestände des gewählten Jahres: gespeichert, sonst Endsalden des abgeschlossenen Vorjahres. */
function anfangsbestaende() {
  const out = {};
  for (const k of S.konten) {
    const own = S.jahrDoc?.anfang?.[k.id];
    out[k.id] = Number.isInteger(own) ? own : (S.vorjahrDoc?.endsalden?.[k.id] ?? 0);
  }
  return out;
}
function abschlussDaten() {
  return jahresabschluss({ buchungen: S.buchungen, konten: S.konten, kategorien: S.kategorien, anfang: anfangsbestaende() });
}
/** Bankbuchungs-Teile einer Veranstaltung */
function bankTeileVon(vid) {
  const out = [];
  for (const b of S.buchungen) for (const p of parts(b)) if (p.veranstaltung === vid) out.push({ ...p, buchung: b });
  return out;
}
function abrechnungVon(v) {
  return veranstaltungsAbrechnung(S.posten[v.id] || [], bankTeileVon(v.id));
}

// ── Übersicht ────────────────────────────────────────────────────────────────

function viewUebersicht() {
  const r = abschlussDaten();
  const unk = S.buchungen.filter(b => !isKontiert(b, S.konten));
  const lastImport = S.buchungen.filter(b => b.quelle === 'import').map(b => b.datum).sort().at(-1);
  let html = '';
  if (!S.konten.length) {
    html += `<div class="card"><h2>Willkommen!</h2>
      <p>Es sind noch keine Bankkonten angelegt.</p>
      ${isAdmin() ? `<button class="btn primary" id="initKonten">Feuerwehrkassa und Mannschaftskassa anlegen</button>` : '<p class="muted">Bitte den Admin, die Konten anzulegen.</p>'}</div>`;
  }
  html += `<div class="grid">` + S.konten.map(k => {
    const pk = r.proKonto[k.id];
    return `<div class="stat click" data-konto="${esc(k.id)}">
      <div class="lbl">${esc(k.name)} · Stand lt. Buchungen ${S.jahr}</div>
      <div class="val">${eur(pk.ende)}</div>
      <div class="sub">Anfang ${fmt(pk.anfang)} · Einnahmen <span class="plus">${fmt(pk.einnahmen)}</span> · Ausgaben <span class="minus">${fmt(-pk.ausgaben)}</span></div>
      <div class="sub">${pk.anzahl} Buchungen${pk.unkontiert ? ` · <span class="chip warn">${pk.unkontiert} unkontiert</span>` : ''}</div>
    </div>`;
  }).join('') + `
    <div class="stat click" data-goto="buchungen-unk">
      <div class="lbl">Noch zu kontieren</div>
      <div class="val">${unk.length}</div>
      <div class="sub">${unk.length ? 'Antippen zum Kontieren' : 'Alles kontiert 👍'}${lastImport ? ` · letzte Bankbuchung ${deDate(lastImport)}` : ''}</div>
    </div></div>`;

  html += `<div class="card" style="margin-top:16px"><h2>Veranstaltungen ${S.jahr}</h2>`;
  if (!S.veranstaltungen.length) html += `<p class="muted">Noch keine Veranstaltungen angelegt – unter „Festkassa“.</p>`;
  else {
    html += `<div class="tablewrap"><table class="t"><thead><tr><th>Veranstaltung</th><th>Datum</th><th class="r">Einnahmen</th><th class="r">Ausgaben</th><th class="r">Ergebnis</th><th class="r">Kassabestand</th><th></th></tr></thead><tbody>`
      + S.veranstaltungen.map(v => {
        const a = abrechnungVon(v);
        return `<tr class="click" data-ver="${esc(v.id)}"><td>${esc(v.name)}</td><td class="nowrap">${deDate(v.von)}${v.bis && v.bis !== v.von ? '–' + deDate(v.bis) : ''}</td>
          <td class="r">${fmt(a.einnahmen)}</td><td class="r">${fmt(a.ausgaben)}</td><td class="r"><b>${money(a.ergebnis)}</b></td>
          <td class="r">${fmt(a.bestand)}</td><td>${v.status === 'abgeschlossen' ? '<span class="chip ok">abgeschlossen</span>' : '<span class="chip">offen</span>'}</td></tr>`;
      }).join('') + `</tbody></table></div>`;
  }
  html += `</div>`;
  $('#view').innerHTML = html;
  $('#initKonten')?.addEventListener('click', initKonten);
  $$('#view [data-konto]').forEach(el => el.addEventListener('click', () => { S.filter = { ...S.filter, konto: el.dataset.konto, kat: '' }; goTab('buchungen'); }));
  $('#view [data-goto="buchungen-unk"]').addEventListener('click', () => { S.filter = { konto: '', kat: '__none', ver: '', q: '', richtung: '' }; goTab('buchungen'); });
  $$('#view [data-ver]').forEach(el => el.addEventListener('click', () => { S.festSel = el.dataset.ver; goTab('festkassa'); }));
}
function goTab(t) { S.tab = t; localStorage.setItem('kb.tab', t); render(true); }

async function initKonten() {
  const batch = writeBatch(db);
  for (const k of DEFAULT_KONTEN) batch.set(doc(db, 'konten', k.id), { name: k.name, iban: '', order: k.order, ohneKontierung: !!k.ohneKontierung });
  if (!S.kategorienGeladen) batch.set(doc(db, 'config', 'kategorien'), { list: DEFAULT_KATEGORIEN });
  if (!S.regeln.length) batch.set(doc(db, 'config', 'regeln'), { list: DEFAULT_REGELN });
  logTo(batch, 'konten', 'Standard-Konten und Kategorien angelegt');
  await batch.commit().catch(fail);
  toast('Konten angelegt. IBANs bitte unter Verwaltung eintragen.');
}

// ── Buchungen ────────────────────────────────────────────────────────────────

function gefiltert() {
  const f = S.filter;
  const q = norm(f.q);
  return S.buchungen.filter(b => {
    if (f.konto && b.konto !== f.konto) return false;
    if (f.richtung === '+' && b.betrag < 0) return false;
    if (f.richtung === '-' && b.betrag > 0) return false;
    const ps = parts(b);
    if (f.kat === '__none' && isKontiert(b, S.konten)) return false;
    if (f.kat && f.kat !== '__none' && !ps.some(p => p.kategorie === f.kat)) return false;
    if (f.ver === '__any' && !ps.some(p => p.veranstaltung)) return false;
    if (f.ver && f.ver !== '__any' && !ps.some(p => p.veranstaltung === f.ver)) return false;
    if (f.beleg === 'mit' && !b.belege?.length) return false;
    if (f.beleg === 'ohne' && b.belege?.length) return false;
    if (q && !norm(`${b.text} ${b.notiz || ''} ${b.beleg || ''} ${fmt(b.betrag)} ${deDate(b.datum)}`).includes(q)) return false;
    return true;
  });
}

function katLabel(b) {
  const ps = parts(b);
  if (ps.length > 1) return `<span class="chip split" title="${esc(ps.map(p => `${katById(p.kategorie)?.name || 'unkontiert'}: ${fmt(p.betrag)}`).join('\n'))}">aufgeteilt (${ps.length})</span>${isKontiert(b, S.konten) ? '' : ' <span class="chip warn">Rest offen</span>'}`;
  const k = katById(b.kategorie);
  if (k) return `<span class="chip">${esc(k.nr ? k.nr + ' ' : '')}${esc(k.name)}</span>`;
  return kontoById(b.konto)?.ohneKontierung ? '' : '<span class="chip warn">unkontiert</span>';
}

function viewBuchungen() {
  const f = S.filter;
  const list = gefiltert();
  const sum = list.reduce((a, b) => a + b.betrag, 0);
  const edit = canBook() && !locked();
  const sel = [...S.sel].filter(id => list.some(b => b.id === id));
  const aktiv = [f.konto && kontoById(f.konto)?.name, f.kat && (f.kat === '__none' ? 'unkontiert' : katById(f.kat)?.name), f.ver && (f.ver === '__any' ? 'mit Fest' : verById(f.ver)?.name),
    f.richtung && (f.richtung === '+' ? 'Einnahmen' : 'Ausgaben'), f.beleg && (f.beleg === 'ohne' ? 'ohne Beleg' : 'mit Beleg'), f.q && `„${f.q}“`].filter(Boolean);
  const filterOffen = S.filterOffen ?? window.innerWidth > 700;
  $('#view').innerHTML = `
    <div class="card">
      <details class="filter" id="filterBox" ${filterOffen ? 'open' : ''}><summary>Filter${aktiv.length ? `: <span class="muted" style="font-weight:400">${esc(aktiv.join(' · '))}</span>` : ''}</summary>
      <div class="toolbar">
        <label>Konto<select id="fKonto">${kontoOptions(f.konto, 'alle Konten')}</select></label>
        <label>Kategorie<select id="fKat"><option value="">alle</option><option value="__none" ${f.kat === '__none' ? 'selected' : ''}>⚠ nur unkontierte</option>
          ${S.kategorien.filter(k => !f.konto || !k.konto || k.konto === f.konto).map(k => `<option value="${esc(k.id)}" ${k.id === f.kat ? 'selected' : ''}>${esc(k.nr ? k.nr + ' ' : '')}${esc(k.name)}</option>`).join('')}</select></label>
        <label>Veranstaltung<select id="fVer"><option value="">alle</option><option value="__any" ${f.ver === '__any' ? 'selected' : ''}>nur mit Veranstaltung</option>
          ${S.veranstaltungen.map(v => `<option value="${esc(v.id)}" ${v.id === f.ver ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}</select></label>
        <label>Beleg<select id="fBeleg"><option value="">alle</option><option value="ohne" ${f.beleg === 'ohne' ? 'selected' : ''}>📎 ohne Beleg</option><option value="mit" ${f.beleg === 'mit' ? 'selected' : ''}>📎 mit Beleg</option></select></label>
        <label>Richtung<select id="fRicht"><option value="">alle</option><option value="+" ${f.richtung === '+' ? 'selected' : ''}>Einnahmen</option><option value="-" ${f.richtung === '-' ? 'selected' : ''}>Ausgaben</option></select></label>
        <label class="grow">Suche<input id="fQ" value="${esc(f.q)}" placeholder="Text, Betrag, Beleg …"></label>
      </div></details>
      <div class="toolbar">
        ${edit ? `<button class="btn" id="newBuchung">+ Buchung</button>
          <button class="btn" id="applyRules" title="Regeln aus der Verwaltung auf alle unkontierten Buchungen anwenden">⚙ Regeln anwenden</button>` : ''}
        <button class="btn" id="exportBuch">⬇ CSV</button>
        <button class="btn" id="printKassabuch" title="Kassabuch des gewählten Kontos mit Belegnummern und laufendem Saldo">🖨 Kassabuch</button>
        <span class="spacer" style="flex:1"></span>
        <span class="muted">${list.length} Buchungen · Summe <b>${money(sum)}</b></span>
      </div>
      ${edit && sel.length ? `<div class="infobox row" style="align-items:center">
        <b>${sel.length} ausgewählt:</b>
        <select id="bulkKat" style="flex:1 1 220px"><option value="__keep">Kategorie: unverändert</option>${katOptions('', list.find(b => b.id === sel[0])?.betrag, list.find(b => b.id === sel[0])?.konto).replace('<option value="">', '<option value="__none">')}</select>
        <select id="bulkVer" style="flex:1 1 160px">${verOptions('', 'Festkassabuch: unverändert')}<option value="__clear">Zuordnung entfernen</option></select>
        <button class="btn primary small" id="bulkApply">Zuweisen</button>
        <button class="btn small" id="bulkClear">Auswahl aufheben</button></div>` : ''}
      ${locked() ? `<div class="infobox">🔒 Das Jahr ${S.jahr} ist abgeschlossen – Buchungen können nur noch angesehen werden.</div>` : ''}
      <div class="tablewrap"><table class="t karten">
        <thead><tr>${edit ? `<th><input type="checkbox" id="selAll" ${sel.length && sel.length === list.length ? 'checked' : ''}></th>` : ''}
          <th class="r">Nr.</th><th>Datum</th><th>Konto</th><th>Buchungstext</th><th>Kategorie</th><th>Festkassabuch</th><th>Beleg</th><th class="r">Betrag</th></tr></thead>
        <tbody>${list.map(b => {
          const vs = parts(b).filter(p => p.veranstaltung).map(festLabel);
          return `<tr class="click ${S.sel.has(b.id) ? 'sel' : ''}" data-id="${esc(b.id)}">
            ${edit ? `<td class="k-a"><input type="checkbox" class="selOne" ${S.sel.has(b.id) ? 'checked' : ''}></td>` : ''}
            <td class="r small muted k-weg">${S.belegNr.get(b.id) || ''}</td>
            <td class="nowrap k-b">${deDate(b.datum)}<span class="nur-klein muted small" style="font-weight:400"> · Nr. ${S.belegNr.get(b.id) || ''} · ${esc(kontoById(b.konto)?.name || b.konto)}</span></td>
            <td class="nowrap small k-weg">${esc(kontoById(b.konto)?.name || b.konto)}</td>
            <td class="text k-voll">${bankText(b.text)}${b.notiz ? `<div class="muted small">📝 ${esc(b.notiz)}</div>` : ''}${b.quelle === 'manuell' ? ' <span class="chip">manuell</span>' : ''}${b.belege?.length ? ` <span class="chip" title="Belege">📎 ${b.belege.length}</span>` : ''}</td>
            <td class="k-zeile">${katLabel(b)}</td>
            <td class="small k-zeile">${vs.join(' ')}</td>
            <td class="small k-weg">${esc(b.beleg || '')}</td>
            <td class="r k-c">${money(b.betrag)}</td></tr>`;
        }).join('') || `<tr><td colspan="9" class="muted">Keine Buchungen${S.buchungen.length ? ' für diesen Filter' : ` im Jahr ${S.jahr} – unter „Raika-Import“ die CSV-Datei einlesen`}.</td></tr>`}</tbody>
      </table></div>
    </div>`;

  const setF = (k, v) => { S.filter[k] = v; S.sel.clear(); render(true); };
  $('#filterBox').addEventListener('toggle', e => { S.filterOffen = e.target.open; });
  $('#fKonto').addEventListener('change', e => setF('konto', e.target.value));
  $('#fKat').addEventListener('change', e => setF('kat', e.target.value));
  $('#fVer').addEventListener('change', e => setF('ver', e.target.value));
  $('#fRicht').addEventListener('change', e => setF('richtung', e.target.value));
  $('#fBeleg').addEventListener('change', e => setF('beleg', e.target.value));
  $('#fQ').addEventListener('input', e => {
    S.filter.q = e.target.value;
    clearTimeout(viewBuchungen.t);
    viewBuchungen.t = setTimeout(() => { S.dirty = false; render(true); }, 250);
  });
  $('#newBuchung')?.addEventListener('click', () => buchungDialog(null));
  $('#applyRules')?.addEventListener('click', regelnAnwenden);
  $('#exportBuch').addEventListener('click', () => exportBuchungen(list));
  $('#printKassabuch').addEventListener('click', () => {
    if (!f.konto) { toast('Bitte zuerst oben ein Konto wählen.', true); return; }
    druckKassabuch(f.konto);
  });
  $('#selAll')?.addEventListener('click', e => { e.stopPropagation(); if (e.target.checked) list.forEach(b => S.sel.add(b.id)); else S.sel.clear(); render(true); });
  $$('#view tr[data-id]').forEach(tr => tr.addEventListener('click', e => {
    const id = tr.dataset.id;
    if (e.target.classList.contains('selOne')) { e.target.checked ? S.sel.add(id) : S.sel.delete(id); render(true); return; }
    buchungDialog(S.buchungen.find(b => b.id === id));
  }));
  $('#bulkClear')?.addEventListener('click', () => { S.sel.clear(); render(true); });
  $('#bulkApply')?.addEventListener('click', async () => {
    const kat = $('#bulkKat').value, ver = $('#bulkVer').value;
    const ids = sel;
    const batch = writeBatch(db);
    if (kat === '__keep' && !ver) { toast('Bitte eine Kategorie oder ein Festkassabuch wählen.', true); return; }
    for (const id of ids) {
      const b = S.buchungen.find(x => x.id === id);
      const upd = { geaendertAm: serverTimestamp(), geaendertVon: S.uid };
      if (kat !== '__keep' && !kontoById(b.konto)?.ohneKontierung) { upd.kategorie = kat === '__none' ? '' : kat; upd.splits = deleteField(); }
      if (ver === '__clear') { upd.veranstaltung = ''; upd.festArt = ''; }
      else if (ver) { upd.veranstaltung = ver; upd.festArt = festArtVorschlag(b); upd.splits = deleteField(); }
      batch.update(doc(db, 'buchungen', id), upd);
    }
    logTo(batch, 'kontieren', `${ids.length} Buchungen${kat !== '__keep' ? ' → ' + (katById(kat)?.name || 'unkontiert') : ''}${ver && ver !== '__clear' ? ' / Festkassabuch ' + (verById(ver)?.name || '') : ''}`);
    try { await batch.commit(); S.sel.clear(); toast(`${ids.length} Buchungen kontiert.`); } catch (e) { fail(e); }
  });
}

function exportBuchungen(list) {
  const rows = [['Nr.', 'Datum', 'Valuta', 'Konto', 'Buchungstext', 'Betrag', 'Kontierung', 'Kategorie', 'Veranstaltung', 'Beleg', 'Notiz', 'Quelle']];
  for (const b of [...list].sort(chronoSort)) {
    for (const p of parts(b)) {
      const k = katById(p.kategorie);
      rows.push([S.belegNr.get(b.id) || '', deDate(b.datum), deDate(b.valuta), kontoById(b.konto)?.name || b.konto, b.text, fmt(p.betrag), k?.nr || '', k?.name || '',
        verById(p.veranstaltung)?.name || '', b.beleg || '', [b.notiz, p.notiz].filter(Boolean).join(' / '), b.quelle || '']);
    }
  }
  download(`Buchungen_${S.jahr}.csv`, toCsv(rows));
}
function download(name, text, type = 'text/csv;charset=utf-8') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ── Belege (PDF/Fotos in Firebase Storage) ───────────────────────────────────
//
// Dateien liegen unter belege/{jahr}/buchung/{buchungId}/… bzw. belege/{jahr}/posten/{veranstaltung}/{postenId}/…
// Am Dokument steht die Liste belege: [{ id, name, pfad, typ, groesse, am, von }].

const MAX_BELEG = 15 * 1024 * 1024;
const dateiName = n => norm(n).replace(/[^a-z0-9._-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(-80) || 'beleg';
/** lesbarer Name für Ordner/Dateien im ZIP (Groß/Klein und Umlaute bleiben) */
const lesbar = t => String(t || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().replace(/\s+/g, '_').slice(0, 50) || 'Beleg';
const groesse = n => n >= 1048576 ? `${(n / 1048576).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

/** Fotos vom Handy verkleinern (max. 2000 px, JPEG) – spart Speicher und Zeit beim Hochladen. */
async function verkleinern(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 700 * 1024) return file;
  try {
    const bmp = await createImageBitmap(file);
    const f = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * f); c.height = Math.round(bmp.height * f);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.82));
    return blob && blob.size < file.size ? new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
  } catch { return file; }
}

async function belegOeffnen(x) {
  const w = window.open('', '_blank');   // sofort öffnen, sonst blockiert der Browser das Fenster
  try {
    const url = await getDownloadURL(sRef(storage, x.pfad));
    if (w) w.location.href = url; else location.href = url;
  } catch (e) { w?.close(); fail(e); }
}

/**
 * Belegbereich in einem Dialog. opts: { basis, liste, edit, speichern?: async liste => … }
 * Ohne speichern (neues Dokument) werden Dateien beim Abbrechen wieder gelöscht.
 */
function belegeBox(sel, opts) {
  let liste = [...(opts.liste || [])];
  const neu = [];
  let fertig = false;
  const draw = () => {
    const box = $(sel);
    if (!box) return;
    box.innerHTML = `<div class="belege"><div class="muted small">Belege (PDF oder Foto)</div>
      ${liste.map((x, i) => `<div class="beleg"><a href="#" data-bo="${i}">📎 ${esc(x.name)}</a> <span class="muted small">${groesse(x.groesse || 0)}</span>
        ${opts.edit ? `<button type="button" class="btn small danger" data-bx="${i}" title="Beleg löschen">✕</button>` : ''}</div>`).join('') || '<div class="muted small">– noch kein Beleg –</div>'}
      ${opts.edit ? `<div class="row" style="margin-top:6px;align-items:center">
        <label class="btn small upl">📄 Datei wählen<input type="file" accept="application/pdf,image/*" multiple data-bf style="display:none"></label>
        <label class="btn small upl">📷 Foto<input type="file" accept="image/*" capture="environment" data-bf style="display:none"></label>
        <span class="small muted" data-bs></span></div>` : ''}</div>`;
    box.querySelectorAll('[data-bo]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); belegOeffnen(liste[+a.dataset.bo]); }));
    box.querySelectorAll('[data-bx]').forEach(btn => btn.addEventListener('click', async () => {
      const x = liste[+btn.dataset.bx];
      if (!confirm(`Beleg „${x.name}“ löschen?`)) return;
      try {
        await deleteObject(sRef(storage, x.pfad)).catch(e => { if (e.code !== 'storage/object-not-found') throw e; });
        liste = liste.filter(y => y.id !== x.id);
        if (opts.speichern) await opts.speichern(liste);
        logTo(null, 'beleg', `Gelöscht: ${x.name}`);
        draw();
      } catch (e) { fail(e); }
    }));
    box.querySelectorAll('[data-bf]').forEach(inp => inp.addEventListener('change', async () => {
      const files = [...inp.files];
      const status = box.querySelector('[data-bs]');
      for (const [n, orig] of files.entries()) {
        if (orig.size > MAX_BELEG) { toast(`${orig.name}: größer als 15 MB.`, true); continue; }
        if (!/^application\/pdf$|^image\//.test(orig.type)) { toast(`${orig.name}: nur PDF oder Bilder.`, true); continue; }
        status.textContent = `Lade hoch … (${n + 1}/${files.length})`;
        try {
          const f = await verkleinern(orig);
          const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          const pfad = `${opts.basis}/${id}-${dateiName(f.name)}`;
          await uploadBytes(sRef(storage, pfad), f, {
            contentType: f.type || 'application/pdf',
            // beim Öffnen/Speichern den ursprünglichen Dateinamen verwenden
            contentDisposition: `inline; filename*=UTF-8''${encodeURIComponent(f.name.slice(0, 120))}`,
          });
          liste.push({ id, name: f.name.slice(0, 120), pfad, typ: f.type || 'application/pdf', groesse: f.size, am: Date.now(), von: S.uid });
          neu.push(pfad);
          if (opts.speichern) await opts.speichern(liste);
          logTo(null, 'beleg', `Hochgeladen: ${f.name}`);
        } catch (e) { fail(e); }
      }
      status.textContent = '';
      draw();
    }));
  };
  draw();
  // neues Dokument nicht gespeichert → hochgeladene Dateien wieder entfernen
  $('#dlg').addEventListener('close', () => {
    if (!fertig && !opts.speichern) neu.forEach(p => deleteObject(sRef(storage, p)).catch(() => {}));
  }, { once: true });
  return { liste: () => liste, gespeichert: () => { fertig = true; } };
}

async function belegeLoeschen(liste) {
  for (const x of liste || []) await deleteObject(sRef(storage, x.pfad)).catch(() => {});
}

function buchungDialog(b) {
  const neu = !b;
  const edit = canBook() && !locked();
  const imported = b?.quelle === 'import';
  b = b || { konto: S.filter.konto || S.konten[0]?.id || '', datum: S.jahr === new Date().getFullYear() ? today() : `${S.jahr}-12-31`, betrag: 0, text: '', quelle: 'manuell' };
  let splits = (b.splits || []).map(s => ({ ...s }));
  const ro = !edit ? 'disabled' : '';
  const ohneKont = !!kontoById(b.konto)?.ohneKontierung;
  const html = `
    ${imported ? `<dl class="kv">
        <dt>Konto</dt><dd>${esc(kontoById(b.konto)?.name || b.konto)} · lfd. Nr. ${S.belegNr.get(b.id) || '–'}</dd>
        <dt>Datum</dt><dd>${deDate(b.datum)}${b.valuta && b.valuta !== b.datum ? ` (Valuta ${deDate(b.valuta)})` : ''}</dd>
        <dt>Betrag</dt><dd><b>${money(b.betrag)} €</b></dd>
        <dt>Bank-Text</dt><dd>${esc(b.text)}</dd>
        <dt>Import</dt><dd class="small muted">${esc(b.datei || '')} ${b.importiertVon ? '· ' + esc(userName(b.importiertVon)) : ''}</dd></dl>`
    : `<div class="row">
        <label>Konto<select id="bKonto" ${ro}>${kontoOptions(b.konto)}</select></label>
        <label>Datum<input type="date" id="bDatum" value="${esc(b.datum)}" ${ro}></label>
        <label>Betrag (Ausgaben mit −)<input id="bBetrag" class="num" inputmode="decimal" value="${neu ? '' : fmt(b.betrag)}" placeholder="-12,50" ${ro}></label>
      </div>
      <label>Buchungstext<input id="bText" value="${esc(b.text)}" maxlength="500" ${ro}></label>`}
    <div id="singleKat" class="${splits.length ? 'hidden' : ''}">
      <div class="row ${ohneKont ? 'hidden' : ''}" id="katRow">
        <label>Kategorie (V-P)<select id="bKat" ${ro}>${katOptions(b.kategorie || '', b.betrag, b.konto)}</select></label>
      </div>
      <div class="infobox" style="margin-top:10px">
        <div class="row">
          <label>Festkassabuch der Veranstaltung<select id="bVer" ${ro}>${verOptions(b.veranstaltung || '', '— nicht zugeordnet —')}</select></label>
          <label>Art<select id="bFestArt" ${ro}>${Object.entries(FEST_ARTEN).map(([k, n]) => `<option value="${k}" ${(b.festArt || festArtVorschlag(b)) === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        </div>
        <div class="small" id="bFestHint" style="margin-top:6px"></div>
      </div>
    </div>
    <div id="splitBox" class="${splits.length ? '' : 'hidden'}">
      <div class="muted" style="margin-top:10px">Aufteilung auf mehrere Kategorien:</div>
      <div id="splitRows"></div>
      <div class="row" style="margin-top:6px;align-items:center">
        ${edit ? `<button type="button" class="btn small" id="splitAdd">+ Zeile</button>` : ''}
        <span class="muted small" id="splitRest"></span>
      </div>
    </div>
    ${edit && !ohneKont ? `<p style="margin:8px 0 0"><a href="#" id="splitToggle" class="small">${splits.length ? 'Aufteilung entfernen' : 'Auf mehrere Kategorien aufteilen …'}</a></p>` : ''}
    <div class="row">
      <label style="flex:0 1 140px">Beleg-Nr.<input id="bBeleg" value="${esc(b.beleg || '')}" maxlength="40" ${ro}></label>
      <label>Notiz<input id="bNotiz" value="${esc(b.notiz || '')}" maxlength="1000" ${ro}></label>
    </div>
    <div id="bBelege"></div>
    ${edit && imported && !ohneKont ? `<label class="check" style="margin-top:12px"><input type="checkbox" id="bRegel"> Für künftige Importe merken, wenn der Text enthält:</label>
      <input id="bRegelText" style="width:100%;margin-top:4px" value="${esc(suchbegriff(b.text))}">` : ''}
    ${b.geaendertVon ? `<p class="muted small">Zuletzt geändert von ${esc(userName(b.geaendertVon))}</p>` : ''}`;

  const extra = [];
  if (edit && !neu) extra.push({
    label: 'Löschen', cls: 'danger', onClick: async () => {
      if (imported && !confirm('Diese Buchung kommt aus dem Bank-Import. Wirklich löschen? (Beim nächsten Import derselben Datei wird sie wieder angelegt.)')) return false;
      if (!imported && !confirm('Buchung löschen?')) return false;
      const batch = writeBatch(db);
      batch.delete(doc(db, 'buchungen', b.id));
      logTo(batch, 'löschen', `${deDate(b.datum)} ${fmt(b.betrag)} ${b.text}`);
      await batch.commit();
      await belegeLoeschen(b.belege);
      toast('Gelöscht.');
    },
  });

  modal(neu ? 'Neue Buchung' : (edit ? 'Buchung kontieren' : 'Buchung'), html, {
    wide: true, extra, ok: 'Speichern', cancel: edit ? 'Abbrechen' : 'Schließen',
    onOk: edit ? async () => {
      const data = { ...b };
      delete data.id;
      if (!imported) {
        data.konto = $('#bKonto').value;
        data.datum = $('#bDatum').value;
        data.betrag = parseAmount($('#bBetrag').value);
        data.text = $('#bText').value.trim();
        data.valuta = data.datum;
        if (!data.konto || !parseDate(data.datum) || data.betrag === null || !data.betrag) { toast('Bitte Konto, Datum und Betrag angeben.', true); return false; }
        if (!data.text) { toast('Bitte einen Buchungstext angeben.', true); return false; }
        data.jahr = Number(data.datum.slice(0, 4));
        if (data.jahr !== S.jahr && !confirm(`Das Datum liegt im Jahr ${data.jahr}. Trotzdem speichern?`)) return false;
      }
      data.beleg = $('#bBeleg').value.trim();
      data.notiz = $('#bNotiz').value.trim();
      data.belege = belegeUi.liste();
      if (splits.length) {
        readSplits();
        const clean = splits.filter(s => s.betrag);
        if (clean.reduce((a, s) => a + s.betrag, 0) !== data.betrag && !confirm('Die Aufteilung ergibt nicht den vollen Betrag. Der Rest bleibt unkontiert. Trotzdem speichern?')) return false;
        data.splits = clean;
        data.kategorie = ''; data.veranstaltung = ''; data.festArt = '';
      } else {
        data.kategorie = kontoById(data.konto)?.ohneKontierung ? '' : $('#bKat').value;
        data.veranstaltung = $('#bVer').value;
        data.festArt = data.veranstaltung ? $('#bFestArt').value : '';
        delete data.splits;
      }
      data.geaendertAm = serverTimestamp();
      data.geaendertVon = S.uid;
      const batch = writeBatch(db);
      if (neu) {
        data.erstelltAm = serverTimestamp(); data.erstelltVon = S.uid;
        batch.set(neuRef, data);
        logTo(batch, 'buchung', `Neu: ${deDate(data.datum)} ${fmt(data.betrag)} ${data.text}`);
      } else {
        // splits entfernen, falls es vorher welche gab
        batch.set(doc(db, 'buchungen', b.id), data.splits ? data : { ...data, splits: deleteField() }, { merge: true });
        const changed = imported ? `${deDate(b.datum)} ${fmt(b.betrag)}: ${data.splits ? 'aufgeteilt' : (katById(data.kategorie)?.name || 'unkontiert')}` : `${deDate(data.datum)} ${fmt(data.betrag)} ${data.text}`;
        logTo(batch, 'kontieren', changed);
      }
      if ($('#bRegel')?.checked && $('#bRegelText').value.trim() && !data.splits && (data.kategorie || data.festArt === 'kassa')) {
        const regel = { muster: $('#bRegelText').value.trim(), kategorie: data.kategorie, richtung: data.betrag < 0 ? '-' : '+', konto: data.konto,
          ...(data.festArt === 'kassa' ? { fest: 'kassa' } : {}) };
        batch.set(doc(db, 'config', 'regeln'), { list: [...S.regeln, regel] });
      }
      await batch.commit();
      belegeUi.gespeichert();
      toast('Gespeichert.');
    } : null,
  });
  const neuRef = neu ? doc(collection(db, 'buchungen')) : null;
  const belegeUi = belegeBox('#bBelege', {
    basis: `belege/${b.jahr || S.jahr}/buchung/${neu ? neuRef.id : b.id}`, liste: b.belege, edit,
    speichern: neu ? null : liste => updateDoc(doc(db, 'buchungen', b.id), { belege: liste }),
  });

  function readSplits() {
    $$('#splitRows .splitrow').forEach((row, i) => {
      splits[i].kategorie = row.querySelector('.sKat').value;
      splits[i].veranstaltung = row.querySelector('.sVer').value;
      splits[i].betrag = parseAmount(row.querySelector('.sBet').value) || 0;
      // Vorzeichen der Buchung übernehmen, falls nur der Betrag eingegeben wurde
      const total = imported ? b.betrag : (parseAmount($('#bBetrag')?.value) || 0);
      if (total < 0 && splits[i].betrag > 0) splits[i].betrag = -splits[i].betrag;
    });
  }
  function drawSplits() {
    const total = imported ? b.betrag : (parseAmount($('#bBetrag')?.value) || 0);
    $('#splitRows').innerHTML = splits.map((s, i) => `<div class="splitrow">
      <select class="sKat" ${ro}>${katOptions(s.kategorie, total, imported ? b.konto : $('#bKonto')?.value)}</select>
      <select class="sVer" ${ro}>${verOptions(s.veranstaltung)}</select>
      <input class="sBet num" inputmode="decimal" value="${s.betrag ? fmt(s.betrag) : ''}" ${ro}>
      ${edit ? `<button type="button" class="btn small danger" data-del="${i}">✕</button>` : '<span></span>'}</div>`).join('');
    const rest = total - splits.reduce((a, s) => a + (s.betrag || 0), 0);
    $('#splitRest').innerHTML = rest ? `Noch aufzuteilen: <b>${fmt(rest)}</b>` : '✓ vollständig aufgeteilt';
    $$('#splitRows [data-del]').forEach(x => x.addEventListener('click', () => { readSplits(); splits.splice(+x.dataset.del, 1); drawSplits(); }));
    $$('#splitRows .sBet').forEach(x => x.addEventListener('change', () => { readSplits(); drawSplits(); }));
  }
  if (splits.length) drawSplits();
  // Hinweis, wie die Buchung im Festkassabuch erscheint
  const festHint = () => {
    const betrag = imported ? b.betrag : (parseAmount($('#bBetrag')?.value) || 0);
    const v = $('#bVer').value, art = $('#bFestArt').value;
    $('#bFestArt').closest('label').classList.toggle('hidden', !v);
    $('#bFestHint').innerHTML = !v ? 'Wechselgeld-Abhebungen, Einzahlungen von Festerlösen oder Rechnungen eines Festes hier einer Veranstaltung zuordnen.'
      : art === 'kassa'
        ? (betrag < 0 ? '➜ Erscheint im Festkassabuch als <b>Wechselgeld / Vorschuss</b> (Eingang in die Festkassa).' : '➜ Erscheint im Festkassabuch als <b>Ablieferung an die Bank</b> (Ausgang aus der Festkassa).')
          + ' Zählt nicht zum Ergebnis des Festes.'
        : `➜ Zählt als <b>${betrag < 0 ? 'Ausgabe' : 'Einnahme'} der Veranstaltung über die Bank</b>; der Kassabestand bleibt unverändert.`;
  };
  $('#bVer').addEventListener('change', () => {
    const ver = verById($('#bVer').value);
    if (ver && !b.festArt) $('#bFestArt').value = festArtVorschlag({ ...b, betrag: imported ? b.betrag : (parseAmount($('#bBetrag')?.value) || 0) }, !!veranstaltungImText(b.text, [ver]));
    festHint();
  });
  $('#bFestArt').addEventListener('change', festHint);
  $('#bBetrag')?.addEventListener('input', festHint);
  festHint();
  // Kategorien passend zum Konto anbieten
  $('#bKonto')?.addEventListener('change', () => {
    const cur = $('#bKat').value;
    $('#bKat').innerHTML = katOptions(cur, parseAmount($('#bBetrag').value) || 0, $('#bKonto').value);
    $('#katRow').classList.toggle('hidden', !!kontoById($('#bKonto').value)?.ohneKontierung);
    if (splits.length) { readSplits(); drawSplits(); }
  });
  $('#splitAdd')?.addEventListener('click', () => {
    readSplits();
    const total = imported ? b.betrag : (parseAmount($('#bBetrag')?.value) || 0);
    splits.push({ kategorie: '', veranstaltung: '', betrag: total - splits.reduce((a, s) => a + (s.betrag || 0), 0) });
    drawSplits();
  });
  $('#splitToggle')?.addEventListener('click', e => {
    e.preventDefault();
    if (splits.length) { splits = []; $('#splitBox').classList.add('hidden'); $('#singleKat').classList.remove('hidden'); e.target.textContent = 'Auf mehrere Kategorien aufteilen …'; return; }
    const total = imported ? b.betrag : (parseAmount($('#bBetrag')?.value) || 0);
    splits = [{ kategorie: $('#bKat').value, veranstaltung: $('#bVer').value, betrag: total }, { kategorie: '', veranstaltung: '', betrag: 0 }];
    $('#splitBox').classList.remove('hidden'); $('#singleKat').classList.add('hidden');
    e.target.textContent = 'Aufteilung entfernen';
    drawSplits();
  });
}

/**
 * Automatische Festkassabuch-Zuordnung (Import, Regeln): nur Geld zwischen Bank und Festkassa
 * (Wechselgeld, Erlös, Einzahlung vom Fest) und nur, wenn der Name der Veranstaltung im Text steht.
 * Fest-Rechnungen oder Sponsoring ordnet man bei Bedarf selbst zu.
 */
function festVorschlag(b, regel) {
  const jahr = Number(String(b.datum).slice(0, 4));
  const v = veranstaltungImText(b.text, S.veranstaltungen.filter(x => x.jahr === jahr));
  if (!v) return null;
  const art = regel?.fest || festArtVorschlag(b, true);
  return art === 'kassa' ? { veranstaltung: v.id, festArt: 'kassa' } : null;
}
function festLabel(p) {
  const v = verById(p.veranstaltung);
  if (!v) return '';
  return `<span class="chip ${p.festArt === 'kassa' ? 'ok' : ''}" title="${esc(FEST_ARTEN[p.festArt] || '')}">${p.festArt === 'kassa' ? '💶 ' : '🧾 '}${esc(v.name)}</span>`;
}

/** Bank-Text kompakt: Auftraggeber/Empfänger fett, dann Verwendungszweck. Voller Text als Tooltip. */
function bankText(text) {
  const { partner, zweck } = splitBankText(text);
  if (!partner && !zweck) return esc(text);
  return `<span title="${esc(text)}">${partner ? `<b>${esc(partner)}</b>` : ''}${partner && zweck ? '<br>' : ''}${zweck ? `<span class="muted">${esc(zweck)}</span>` : ''}</span>`;
}

async function regelnAnwenden() {
  if (!S.regeln.length) { toast('Es sind noch keine Regeln angelegt (Verwaltung → Kontierungsregeln).', true); return; }
  const treffer = [];
  for (const b of S.buchungen) {
    if (b.splits?.length) continue;
    const r = matchRule(S.regeln, b);
    const upd = {};
    if (!isKontiert(b, S.konten) && r?.kategorie && !kontoById(b.konto)?.ohneKontierung) upd.kategorie = r.kategorie;
    const f = !b.veranstaltung && festVorschlag(b, r);
    if (f) Object.assign(upd, f);
    if (Object.keys(upd).length) treffer.push([b, upd]);
  }
  if (!treffer.length) { toast('Keine offene Buchung passt zu einer Regel oder Veranstaltung.'); return; }
  if (!await confirmDlg('Regeln anwenden', `${treffer.length} Buchungen werden kontiert bzw. einem Festkassabuch zugeordnet (nur bisher offene).`, 'Anwenden')) return;
  for (let i = 0; i < treffer.length; i += 200) {
    const batch = writeBatch(db);
    for (const [b, upd] of treffer.slice(i, i + 200)) {
      batch.update(doc(db, 'buchungen', b.id), { ...upd, geaendertAm: serverTimestamp(), geaendertVon: S.uid });
    }
    if (i === 0) logTo(batch, 'kontieren', `${treffer.length} Buchungen per Regel kontiert`);
    await batch.commit().catch(fail);
  }
  toast(`${treffer.length} Buchungen aktualisiert.`);
}

// ── Raika-Import ─────────────────────────────────────────────────────────────

function viewImport() {
  const I = S.imp;
  let html = `<div class="card"><h2>Kontoumsätze von der Raika importieren</h2>
    <p class="muted">In <b>ELBA</b> (bzw. Mein ELBA) beim gewünschten Konto die Umsätze für einen Zeitraum anzeigen und als <b>CSV exportieren</b>.
    Die Datei hier auswählen. Bereits importierte Umsätze werden automatisch erkannt und übersprungen – überlappende Zeiträume sind also kein Problem.</p>
    <div class="row">
      <label>In welches Konto?<select id="impKonto">${kontoOptions(I?.konto || '', '— Konto wählen —')}</select></label>
      <label>CSV-Datei<input type="file" id="impFile" accept=".csv,.txt,text/csv"></label>
    </div></div>`;
  if (I?.table) {
    const cols = I.mapping.length;
    const preview = I.table.slice(0, 4);
    html += `<div class="card"><h2>Spalten zuordnen</h2>
      <p class="muted">Automatisch erkannt${I.header ? ' (mit Kopfzeile)' : ' (ELBA-Format ohne Kopfzeile)'}. Bitte kurz prüfen und bei Bedarf ändern.</p>
      <div class="tablewrap"><table class="t"><thead><tr>${Array.from({ length: cols }, (_, i) => `<th><select data-col="${i}">${Object.entries(ROLES).map(([k, n]) => `<option value="${k}" ${I.mapping[i] === k ? 'selected' : ''}>${n}</option>`).join('')}</select></th>`).join('')}</tr></thead>
      <tbody>${preview.map(r => `<tr>${Array.from({ length: cols }, (_, i) => `<td class="small">${esc((r[i] || '').slice(0, 80))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <label class="check" style="margin-top:8px"><input type="checkbox" id="impHeader" ${I.header ? 'checked' : ''}> Erste Zeile ist eine Kopfzeile</label></div>`;
    if (I.result) {
      const rows = I.result.rows;
      const neu = rows.filter(r => r.status === 'neu');
      const dup = rows.filter(r => r.status === 'vorhanden');
      const gesp = rows.filter(r => r.status === 'gesperrt');
      const auto = neu.filter(r => r.kategorie);
      html += `<div class="card"><h2>Vorschau</h2>
        ${I.result.errors.map(e => `<div class="warnbox">${esc(e)}</div>`).join('')}
        ${I.ibanWarn ? `<div class="warnbox">${esc(I.ibanWarn)}</div>` : ''}
        <p><b>${neu.length}</b> neue Umsätze${auto.length ? ` (davon <b>${auto.length}</b> automatisch kontiert)` : ''}${neu.some(r => r.veranstaltung) ? ` · <b>${neu.filter(r => r.veranstaltung).length}</b> einem Festkassabuch zugeordnet` : ''} · ${dup.length} bereits vorhanden${gesp.length ? ` · <span class="minus">${gesp.length} in abgeschlossenen Jahren (werden nicht importiert)</span>` : ''}</p>
        <div class="row" style="margin-bottom:10px"><button class="btn primary" id="impGo" ${neu.length && I.konto ? '' : 'disabled'}>${neu.length} Umsätze importieren</button>
          ${!I.konto ? '<span class="minus">Bitte oben das Konto wählen.</span>' : ''}</div>
        <div class="tablewrap"><table class="t"><thead><tr><th>Status</th><th>Datum</th><th>Text</th><th>Kategorie (Regel)</th><th>Festkassabuch</th><th class="r">Betrag</th></tr></thead><tbody>
        ${rows.map(r => `<tr class="${r.status !== 'neu' ? 'muted' : ''}"><td>${r.status === 'neu' ? '<span class="chip ok">neu</span>' : r.status === 'vorhanden' ? '<span class="chip">vorhanden</span>' : '<span class="chip lock">gesperrt</span>'}</td>
          <td class="nowrap">${deDate(r.datum)}</td><td class="text small">${bankText(r.text)}</td><td class="small">${esc(katById(r.kategorie)?.name || '')}</td><td class="small">${festLabel(r)}</td><td class="r">${money(r.betrag)}</td></tr>`).join('')}
        </tbody></table></div></div>`;
    }
  }
  $('#view').innerHTML = html;
  $('#view').insertAdjacentHTML('beforeend', excelKarte());
  $('#xlKonto').addEventListener('change', e => { S.xl = { ...(S.xl || {}), konto: e.target.value }; pruefeExcel(); });
  $('#xlFile').addEventListener('change', leseExcel);
  $('#xlSheet')?.addEventListener('change', e => { S.xl.sheet = e.target.value; pruefeExcel(); });
  $('#xlOver')?.addEventListener('change', e => { S.xl.over = e.target.checked; render(true); });
  $('#xlGo')?.addEventListener('click', uebernehmeExcel);
  $('#impKonto').addEventListener('change', e => { S.imp = { ...(S.imp || {}), konto: e.target.value }; if (S.imp.table) pruefeImport(); else render(true); });
  $('#impFile').addEventListener('change', leseImportDatei);
  $$('#view [data-col]').forEach(sel => sel.addEventListener('change', () => { S.imp.mapping[+sel.dataset.col] = sel.value; pruefeImport(); }));
  $('#impHeader')?.addEventListener('change', e => { S.imp.header = e.target.checked; pruefeImport(); });
  $('#impGo')?.addEventListener('click', importieren);
}

// ── Kontierung aus der bisherigen Excel übernehmen ───────────────────────────

function excelKarte() {
  const X = S.xl;
  let html = `<div class="card"><h2>Kontierung aus der bisherigen Excel übernehmen</h2>
    <p class="muted">Für Jahre, die schon in der Excel-Liste (Spalten <b>Belegnr., Datum, Bezeichnung, Betrag, Kontierung</b>) kontiert wurden:
      zuerst die Raika-CSV des Jahres importieren, dann hier die Excel wählen. Buchungen werden über Datum und Betrag zugeordnet,
      die Kontierungs-Nummer (V-P) wird zur Kategorie. Gilt für das oben gewählte Jahr <b>${S.jahr}</b>.</p>
    <div class="row">
      <label>Konto<select id="xlKonto">${kontoOptions(X?.konto || '', '— Konto wählen —')}</select></label>
      <label>Excel-Datei<input type="file" id="xlFile" accept=".xlsx,.xls,.ods"></label>
      ${X?.sheets ? `<label>Blatt<select id="xlSheet">${X.sheets.map(n => `<option ${n === X.sheet ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>` : ''}
    </div>`;
  const R = X?.result;
  if (R) {
    const neu = R.treffer.filter(t => X.over ? t.buchung.kategorie !== t.kategorie || t.buchung.splits?.length : !isKontiert(t.buchung, S.konten));
    html += `<p><b>${R.zeilen}</b> kontierte Zeilen im Blatt · <b>${R.treffer.length}</b> Buchungen gefunden · davon <b>${neu.length}</b> zu ändern
      ${R.ohneBuchung.length ? ` · <span class="minus">${R.ohneBuchung.length} ohne passende Buchung</span>` : ''}
      ${R.unbekannt.length ? ` · <span class="minus">${R.unbekannt.length} mit unbekannter Kontierung (${[...new Set(R.unbekannt.map(z => z.kontierung))].map(esc).join(', ')})</span>` : ''}</p>
      ${R.ohneBuchung.length ? `<div class="warnbox">Ohne passende Buchung (Raika-CSV noch nicht importiert oder anderes Jahr/Konto?): ${R.ohneBuchung.slice(0, 8).map(z => `${deDate(z.datum)} ${fmt(z.betrag)}`).join(', ')}${R.ohneBuchung.length > 8 ? ' …' : ''}</div>` : ''}
      <label class="check"><input type="checkbox" id="xlOver" ${X.over ? 'checked' : ''}> auch bereits kontierte Buchungen überschreiben</label>
      <div class="row" style="margin-top:8px"><button class="btn primary" id="xlGo" ${neu.length ? '' : 'disabled'}>${neu.length} Kontierungen übernehmen</button></div>`;
  } else if (X?.sheets && X.konto) html += `<div class="warnbox">In diesem Blatt gibt es für ${S.jahr} keine kontierten Zeilen (nötig: Kopfzeile mit „Datum“, „Betrag“ und „Kontierung“).</div>`;
  return html + '</div>';
}

async function leseExcel(e) {
  const file = e.target.files[0];
  if (!file) return;
  if (!window.XLSX) { toast('Excel-Bibliothek nicht geladen – bitte Seite neu laden.', true); return; }
  try {
    const wb = window.XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
    const tables = Object.fromEntries(wb.SheetNames.map(n => [n, window.XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '' })]));
    // Blatt vorschlagen: passend zum Kontonamen (z. B. „FW Kassa“), sonst das erste mit Kontierungen
    const konto = S.xl?.konto || '';
    const withData = wb.SheetNames.filter(n => (excelKontierung(tables[n]) || []).some(z => z.kontierung));
    const kn = norm(kontoById(konto)?.name || '');
    const guess = withData.find(n => kn && (norm(n).includes(kn.slice(0, 4)) || (kn.startsWith('feuerwehr') && /^fw/.test(norm(n))) || (kn.startsWith('mannschaft') && /^ms/.test(norm(n)))));
    S.xl = { konto, datei: file.name, tables, sheets: wb.SheetNames, sheet: guess || withData[0] || wb.SheetNames[0], over: false };
    pruefeExcel();
  } catch (err) { fail(err); }
}

function pruefeExcel() {
  const X = S.xl;
  if (!X?.tables) { render(true); return; }
  const zeilen = (excelKontierung(X.tables[X.sheet]) || []).filter(z => z.kontierung && z.datum.startsWith(String(S.jahr)));
  X.result = X.konto && zeilen.length ? { zeilen: zeilen.length, ...zuordnenKontierung(zeilen, S.buchungen, S.kategorien, X.konto) } : null;
  render(true);
}

async function uebernehmeExcel() {
  const X = S.xl;
  const todo = X.result.treffer.filter(t => X.over ? t.buchung.kategorie !== t.kategorie || t.buchung.splits?.length : !isKontiert(t.buchung, S.konten));
  try {
    for (let i = 0; i < todo.length; i += 200) {
      const batch = writeBatch(db);
      for (const t of todo.slice(i, i + 200)) {
        batch.update(doc(db, 'buchungen', t.buchung.id), { kategorie: t.kategorie, splits: deleteField(), geaendertAm: serverTimestamp(), geaendertVon: S.uid });
      }
      if (i === 0) logTo(batch, 'kontieren', `${todo.length} Kontierungen aus ${X.datei} (${X.sheet}) übernommen`);
      await batch.commit();
    }
    toast(`${todo.length} Kontierungen übernommen.`);
    S.filter = { konto: X.konto, kat: '', ver: '', q: '', richtung: '' };
    S.xl = { konto: X.konto };
    goTab('buchungen');
  } catch (e) { fail(e); }
}

async function leseImportDatei(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = decodeText(await file.arrayBuffer());
    const table = parseCsv(text);
    if (!table.length) throw new Error('Die Datei ist leer.');
    const det = detectColumns(table);
    let konto = S.imp?.konto || '';
    let ibanWarn = '';
    const iban = ibanFromName(file.name);
    if (iban) {
      const k = S.konten.find(x => cleanIban(x.iban) === iban);
      if (k) konto = k.id;
      else ibanWarn = `Der Dateiname enthält die IBAN ${iban}, die keinem Konto zugeordnet ist. Bitte prüfen, ob das gewählte Konto stimmt.`;
    }
    S.imp = { konto, datei: file.name, table, header: det.header, mapping: det.mapping, ibanWarn, iban };
    await pruefeImport();
  } catch (err) { fail(err); }
}

async function pruefeImport() {
  const I = S.imp;
  const { rows, errors } = applyMapping(I.table, I.mapping, I.header);
  if (!I.konto) { I.result = { rows: rows.map(r => ({ ...r, status: 'neu' })), errors }; render(true); return; }
  const ids = await importIds(I.konto, rows);
  const jahre = [...new Set(rows.map(r => Number(r.datum.slice(0, 4))))];
  // vorhandene IDs und Sperren der betroffenen Jahre laden
  const existing = new Set();
  const gesperrt = new Set();
  for (const y of jahre) {
    if (y === S.jahr) S.buchungen.forEach(b => existing.add(b.id));
    else {
      const snap = await getDocs(query(collection(db, 'buchungen'), where('jahr', '==', y), where('konto', '==', I.konto)));
      snap.forEach(d => existing.add(d.id));
    }
    const jd = y === S.jahr ? S.jahrDoc : (await getDoc(doc(db, 'jahre', String(y)))).data();
    if (jd?.gesperrt) gesperrt.add(y);
  }
  I.result = {
    errors,
    rows: rows.map((r, i) => {
      const id = ids[i];
      const status = existing.has(id) ? 'vorhanden' : gesperrt.has(Number(r.datum.slice(0, 4))) ? 'gesperrt' : 'neu';
      const regel = matchRule(S.regeln, { ...r, konto: I.konto });
      const fest = festVorschlag(r, regel);
      return { ...r, id, status, kategorie: kontoById(I.konto)?.ohneKontierung ? '' : (regel?.kategorie || ''),
        veranstaltung: fest?.veranstaltung || '', festArt: fest?.festArt || '' };
    }).sort((a, b) => b.datum.localeCompare(a.datum)),
  };
  render(true);
}

async function importieren() {
  const I = S.imp;
  const neu = I.result.rows.filter(r => r.status === 'neu');
  $('#impGo').disabled = true;
  try {
    for (let i = 0; i < neu.length; i += 100) {
      const batch = writeBatch(db);
      for (const r of neu.slice(i, i + 100)) {
        batch.set(doc(db, 'buchungen', r.id), {
          konto: I.konto, datum: r.datum, valuta: r.valuta, betrag: r.betrag, text: r.text, zeitstempel: r.zeitstempel || '', seq: r.zeile,
          jahr: Number(r.datum.slice(0, 4)), quelle: 'import', datei: I.datei.slice(0, 120),
          kategorie: r.kategorie, veranstaltung: r.veranstaltung || '', festArt: r.festArt || '',
          importiertAm: serverTimestamp(), importiertVon: S.uid,
        });
      }
      if (i === 0) logTo(batch, 'import', `${neu.length} Umsätze aus ${I.datei} in ${kontoById(I.konto)?.name}`);
      await batch.commit();
    }
    toast(`${neu.length} Umsätze importiert.`);
    // IBAN aus dem Dateinamen beim Konto merken, damit es beim nächsten Import automatisch gewählt wird
    if (I.iban && isAdmin() && !kontoById(I.konto)?.iban && !S.konten.some(k => cleanIban(k.iban) === I.iban)) {
      updateDoc(doc(db, 'konten', I.konto), { iban: I.iban }).then(() => toast(`IBAN ${I.iban} bei ${kontoById(I.konto)?.name} gespeichert.`)).catch(() => {});
    }
    S.imp = { konto: I.konto };
    S.filter = { konto: I.konto, kat: kontoById(I.konto)?.ohneKontierung ? '' : '__none', ver: '', q: '', richtung: '' };
    goTab('buchungen');
  } catch (e) { fail(e); render(true); }
}

// ── Festkassa / Veranstaltungen ──────────────────────────────────────────────

const BEREICHE = ['Schank', 'Küche', 'Bar', 'Kaffee & Kuchen', 'Eintritt', 'Tombola', 'Einkauf Getränke', 'Einkauf Lebensmittel', 'Musik', 'Miete / Zelt', 'Sonstiges'];

function viewFestkassa() {
  const v = S.festSel && verById(S.festSel);
  if (v) return viewVeranstaltung(v);
  const edit = canBook() && !locked();
  $('#view').innerHTML = `<div class="card">
    <div class="toolbar"><h2 style="margin:0;flex:1">Veranstaltungen ${S.jahr}</h2>${edit ? '<button class="btn primary" id="newVer">+ Veranstaltung</button>' : ''}</div>
    <p class="muted">Pro Veranstaltung (Zeltfest, Florianifeier, Ball, Frühschoppen …) wird ein eigenes Festkassabuch geführt:
      Wechselgeld, Einnahmen je Stand (mit Zählprotokoll), Barausgaben und die Ablieferung an die Bank.
      Rechnungen, die über die Bank bezahlt werden, ordnet man beim Kontieren der Veranstaltung zu.</p>
    <div class="grid">${S.veranstaltungen.map(v => {
      const a = abrechnungVon(v);
      return `<div class="stat click" data-ver="${esc(v.id)}">
        <div class="lbl">${deDate(v.von)}${v.bis && v.bis !== v.von ? ' – ' + deDate(v.bis) : ''} ${v.status === 'abgeschlossen' ? '<span class="chip ok">abgeschlossen</span>' : '<span class="chip">offen</span>'}</div>
        <div style="font-weight:700;font-size:1.1rem">${esc(v.name)}</div>
        <div class="val">${money(a.ergebnis)} €</div>
        <div class="sub">Einnahmen ${fmt(a.einnahmen)} · Ausgaben ${fmt(a.ausgaben)}</div>
        <div class="sub">Kassabestand ${fmt(a.bestand)}${a.bestand && v.status === 'abgeschlossen' ? ' <span class="chip warn">nicht abgeliefert</span>' : ''}</div>
      </div>`;
    }).join('') || '<p class="muted">Noch keine Veranstaltung angelegt.</p>'}</div></div>`;
  $('#newVer')?.addEventListener('click', () => veranstaltungDialog(null));
  $$('#view [data-ver]').forEach(el => el.addEventListener('click', () => { S.festSel = el.dataset.ver; render(true); }));
}

function veranstaltungDialog(v) {
  const neu = !v;
  v = v || { name: '', von: '', bis: '', ort: '', notiz: '', status: 'offen', konto: S.konten.find(k => k.id === 'mannschaft')?.id || S.konten[0]?.id || '' };
  modal(neu ? 'Neue Veranstaltung' : 'Veranstaltung bearbeiten', `
    <label>Name<input id="vName" value="${esc(v.name)}" maxlength="80" placeholder="z. B. Zeltfest ${S.jahr}" required></label>
    <div class="row">
      <label>von<input type="date" id="vVon" value="${esc(v.von || '')}"></label>
      <label>bis<input type="date" id="vBis" value="${esc(v.bis || '')}"></label>
    </div>
    <div class="row">
      <label>Ort<input id="vOrt" value="${esc(v.ort || '')}" maxlength="80"></label>
      <label>Abrechnung über Konto<select id="vKonto">${kontoOptions(v.konto)}</select></label>
    </div>
    <label>Verantwortlich / Festkassier<input id="vVerantw" value="${esc(v.verantwortlich || '')}" maxlength="80"></label>
    <label>Weitere Suchbegriffe für Bankbuchungen<input id="vSuch" value="${esc(v.suchbegriffe || '')}" maxlength="300" placeholder="z. B. Wiesn, Oktoberfest, Frühschoppen"></label>
    <p class="muted small" style="margin:4px 0 0">Mit Komma trennen. Steht einer dieser Begriffe (oder ein Wort aus dem Namen) im Bank-Text, wird die Buchung diesem Fest
      zugeordnet bzw. vorgeschlagen. Kurze Begriffe (3–4 Buchstaben) zählen nur als ganzes Wort.<span id="vSuchTest"></span></p>
    <label>Notiz<textarea id="vNotiz" rows="2" maxlength="1000">${esc(v.notiz || '')}</textarea></label>`, {
    extra: !neu && isAdmin() ? [{
      label: 'Löschen', cls: 'danger', onClick: async () => {
        if ((S.posten[v.id] || []).length) { toast('Bitte zuerst alle Festkassa-Posten löschen.', true); return false; }
        if (!confirm(`Veranstaltung „${v.name}“ löschen?`)) return false;
        await deleteDoc(doc(db, 'veranstaltungen', v.id));
        logTo(null, 'veranstaltung', `Gelöscht: ${v.name}`);
        S.festSel = null; render(true);
      },
    }] : [],
    onOpen: () => {
      // Vorschau: welche Bankbuchungen des Jahres würden mit Name + Suchbegriffen gefunden?
      const test = () => {
        const probe = { ...v, id: v.id || '__neu', name: $('#vName').value, suchbegriffe: $('#vSuch').value };
        const andere = S.veranstaltungen.filter(x => x.id !== v.id);
        const treffer = S.buchungen.filter(b => veranstaltungImText(b.text, [probe, ...andere])?.id === probe.id);
        $('#vSuchTest').innerHTML = probe.name.trim() || probe.suchbegriffe.trim()
          ? ` <b>Findet ${treffer.length} Bankbuchung(en) im Jahr ${S.jahr}</b>${treffer.length ? ': ' + treffer.slice(0, 4).map(b => `${deDate(b.datum)} ${fmt(b.betrag)} ${esc(splitBankText(b.text).zweck.slice(0, 30))}`).join(' · ') + (treffer.length > 4 ? ' …' : '') : ''}.`
          : '';
      };
      ['#vName', '#vSuch'].forEach(x => $(x).addEventListener('input', test));
      test();
    },
    onOk: async () => {
      const von = $('#vVon').value;
      const data = {
        name: $('#vName').value.trim(), von, bis: $('#vBis').value || von, ort: $('#vOrt').value.trim(),
        konto: $('#vKonto').value, verantwortlich: $('#vVerantw').value.trim(), notiz: $('#vNotiz').value.trim(),
        suchbegriffe: $('#vSuch').value.trim(),
        status: v.status || 'offen', jahr: von ? Number(von.slice(0, 4)) : S.jahr,
      };
      if (!data.name) { toast('Bitte einen Namen eingeben.', true); return false; }
      if (data.jahr !== S.jahr && !confirm(`Die Veranstaltung liegt im Jahr ${data.jahr} und erscheint dann dort. Fortfahren?`)) return false;
      if (neu) {
        const ref = doc(collection(db, 'veranstaltungen'));
        await setDoc(ref, { ...data, erstelltAm: serverTimestamp(), erstelltVon: S.uid });
        logTo(null, 'veranstaltung', `Neu: ${data.name}`);
        S.festSel = ref.id;
      } else {
        await updateDoc(doc(db, 'veranstaltungen', v.id), data);
        logTo(null, 'veranstaltung', `Geändert: ${data.name}`);
      }
      render(true);
    },
  });
}

function viewVeranstaltung(v) {
  const offen = v.status === 'offen' && !locked();
  const edit = canFest() && offen;
  const a = abrechnungVon(v);
  const buch = a.buch;
  const bank = bankTeileVon(v.id);
  $('#view').innerHTML = `
    <div class="card">
      <div class="toolbar">
        <button class="btn small" id="back">← Alle Veranstaltungen</button>
        <h2 style="margin:0;flex:1">${esc(v.name)} <span class="muted" style="font-weight:400">${deDate(v.von)}${v.bis && v.bis !== v.von ? ' – ' + deDate(v.bis) : ''}${v.ort ? ' · ' + esc(v.ort) : ''}</span></h2>
        ${v.status === 'abgeschlossen' ? '<span class="chip ok">abgeschlossen</span>' : '<span class="chip">offen</span>'}
      </div>
      <div class="toolbar">
        ${edit ? `<button class="btn primary" data-neu="einnahme">+ Einnahme</button>
          <button class="btn primary" id="zaehlung">🧮 Kassasturz / Zählprotokoll</button>
          <button class="btn primary" data-neu="ausgabe">+ Ausgabe</button>
          <button class="btn" data-neu="wechselgeld" title="Nur für Bargeld, das nicht vom Bankkonto kommt">+ Wechselgeld (bar)</button>
          <button class="btn" data-neu="ablieferung" title="Nur für Bargeld, das nicht über ein Bankkonto läuft">+ Ablieferung (bar)</button>` : ''}
        ${canBook() && !locked() ? `<button class="btn" id="bankZuordnen">🏦 Bankbuchung zuordnen</button>` : ''}
        ${edit ? `<button class="btn" id="fkExcel" title="Bisheriges Festkassabuch aus Excel übernehmen">⬆ Excel übernehmen</button>` : ''}
        <span style="flex:1"></span>
        ${canBook() && !locked() ? `<button class="btn" id="verEdit">Bearbeiten</button>
          <button class="btn" id="verStatus">${v.status === 'offen' ? '✓ Abschließen' : 'Wieder öffnen'}</button>` : ''}
        <button class="btn" id="verPrint">🖨 Drucken</button>
        <button class="btn" id="verCsv">⬇ CSV</button>
      </div>
      <div class="grid">
        <div class="stat"><div class="lbl">Ergebnis (Gewinn/Verlust)</div><div class="val">${money(a.ergebnis)} €</div><div class="sub">Einnahmen ${fmt(a.einnahmen)} − Ausgaben ${fmt(a.ausgaben)}</div></div>
        <div class="stat"><div class="lbl">Kassabestand Festkassa</div><div class="val ${a.bestand < 0 ? 'minus' : ''}">${eur(a.bestand)}</div><div class="sub">${a.bestand < 0 ? '⚠ negativ – es wurde mehr ausgegeben/abgeliefert als eingenommen. Fehlt der Barumsatz (Kassasturz)?' : a.bestand ? 'muss noch abgeliefert werden' : 'alles abgeliefert ✓'}</div>
          ${a.bestand < 0 && edit ? `<button class="btn small" id="barumsatz" style="margin-top:6px" title="Ohne Kassasturz: Barumsatz = Ablieferung + Barausgaben − Wechselgeld − sonstige Bareinnahmen">🧮 Barumsatz errechnen (${fmt(-a.bestand)})</button>` : ''}</div>
        <div class="stat"><div class="lbl">Bar: Einnahmen / Ausgaben</div><div class="val" style="font-size:1.2rem">${fmt(a.barEinnahmen)} / ${fmt(a.barAusgaben)}</div><div class="sub">Wechselgeld ${fmt(a.wechselgeld)} · abgeliefert ${fmt(a.ablieferung)}</div></div>
        <div class="stat"><div class="lbl">Überweisung / Bank: Einnahmen / Ausgaben</div><div class="val" style="font-size:1.2rem">${fmt(a.ueberwEinnahmen + a.bankEinnahmen)} / ${fmt(a.ueberwAusgaben + a.bankAusgaben)}</div>
          <div class="sub">Positionen mit Überweisung und zugeordnete Bankbuchungen${a.neutralEin || a.neutralAus ? ` · nicht im Ergebnis: +${fmt(a.neutralEin)} / −${fmt(a.neutralAus)}` : ''}</div></div>
      </div>
      ${a.doppelt.length ? `<div class="warnbox">⚠ Möglicherweise doppelt erfasst: ${a.doppelt.map(p => `${esc(p.text || p.bereich || POSTEN_ARTEN[p.art].name)} ${fmt(p.betrag)}`).join(', ')} –
        steht als Überweisung im Festkassabuch und ist zusätzlich als Bankbuchung (🧾) zugeordnet. Eines davon entfernen.</div>` : ''}
    </div>

    <div class="card"><h2>Festkassabuch</h2>
      <div class="tablewrap"><table class="t karten"><thead><tr><th>Nr.</th><th>Datum</th><th>Art</th><th>Bereich</th><th>Text</th><th>Beleg</th><th>Zahlweg</th><th>Ergebnis</th><th class="r">Eingang</th><th class="r">Ausgang</th><th class="r">Bestand</th></tr></thead>
      <tbody>${buch.map(p => `<tr class="click" ${p.bank ? `data-bid="${esc(p.buchung.id)}"` : `data-posten="${esc(p.id)}"`}><td class="k-a muted small">${p.lfd}</td><td class="nowrap k-b">${deDate(p.datum)}${p.zeit ? ' ' + esc(p.zeit) : ''}<span class="nur-klein muted small" style="font-weight:400"> · ${esc(POSTEN_ARTEN[p.art]?.name || p.art)}</span></td>
        <td class="small k-weg">${esc(POSTEN_ARTEN[p.art]?.name || p.art)}</td><td class="small k-zeile">${p.bank ? `<span class="chip">🏦 ${esc(kontoById(p.buchung.konto)?.name || 'Bank')}</span>` : esc(p.bereich || '')}</td>
        <td class="small k-voll">${esc(p.text || '')}${p.stueckelung ? ' <span class="chip">🧮 gezählt</span>' : ''}${(p.bank ? p.buchung?.belege : p.belege)?.length ? ` <span class="chip">📎 ${(p.bank ? p.buchung.belege : p.belege).length}</span>` : ''}</td><td class="small k-weg">${esc(p.beleg || '')}</td>
        <td class="small k-zeile">${zahlwegLabel(p)}<span class="nur-klein">${p.ergebnis ? ' · zählt fürs Ergebnis' : ' · nicht im Ergebnis'} · Bestand ${fmt(p.bestand)}</span></td><td class="small k-weg">${p.ergebnis ? '✓' : '<span class="muted">–</span>'}</td>
        <td class="r k-weg ${p.kassa ? '' : 'muted'}">${p.betragVz > 0 ? fmt(p.betragVz) : ''}</td><td class="r k-weg ${p.kassa ? '' : 'muted'}">${p.betragVz < 0 ? fmt(-p.betragVz) : ''}</td>
        <td class="r k-c"><b class="nur-gross">${fmt(p.bestand)}</b><span class="nur-klein ${p.betragVz < 0 ? 'minus' : 'plus'} ${p.kassa ? '' : 'muted'}">${p.betragVz > 0 ? '+' : '−'}${fmt(Math.abs(p.betragVz))}</span></td></tr>`).join('')
        || `<tr><td colspan="11" class="muted">Noch keine Einträge. Üblicher Ablauf: Wechselgeld von der Bank abheben (Bankbuchung zuordnen) → nach dem Fest je Stand einen <b>Kassasturz</b> machen → <b>Barausgaben</b> mit Beleg erfassen → Geld auf die Bank einzahlen (Bankbuchung zuordnen).</td></tr>`}</tbody></table></div>
      <p class="muted small">Zeilen mit 🏦 kommen aus zugeordneten Bankbuchungen (Feuerwehr- oder Mannschaftskassa): eine Abhebung ist Wechselgeld in die Festkassa, eine Einzahlung eine Ablieferung. Sie müssen nicht noch einmal eingetragen werden.
        Positionen mit Zahlweg <b>Überweisung</b> (grau) ändern den Kassabestand nicht. Ergebnis „–“ = zählt nicht zum Ergebnis des Festes.</p>
    </div>

    <div class="card"><h2>Abrechnung nach Bereichen</h2>
      <div class="tablewrap"><table class="t"><thead><tr><th>Bereich</th><th class="r">Einnahmen</th><th class="r">Ausgaben</th><th class="r">Ergebnis</th></tr></thead><tbody>
      ${a.bereiche.map(x => `<tr><td>${esc(x.bereich)}</td><td class="r">${fmt(x.einnahmen)}</td><td class="r">${fmt(x.ausgaben)}</td><td class="r">${money(x.einnahmen - x.ausgaben)}</td></tr>`).join('')}
      ${a.bankEinnahmen || a.bankAusgaben ? `<tr><td>Über die Bank (siehe unten)</td><td class="r">${fmt(a.bankEinnahmen)}</td><td class="r">${fmt(a.bankAusgaben)}</td><td class="r">${money(a.bankEinnahmen - a.bankAusgaben)}</td></tr>` : ''}
      <tr class="sum"><td>Gesamt</td><td class="r">${fmt(a.einnahmen)}</td><td class="r">${fmt(a.ausgaben)}</td><td class="r">${money(a.ergebnis)}</td></tr>
      ${a.neutralEin || a.neutralAus ? `<tr><td class="muted">nicht im Ergebnis (Durchlaufposten)</td><td class="r muted">${fmt(a.neutralEin)}</td><td class="r muted">${fmt(a.neutralAus)}</td><td></td></tr>` : ''}</tbody></table></div>
    </div>

    ${abgleichKarte(v, edit)}

    <div class="card"><h2>Zugeordnete Bankbuchungen</h2>
      <p class="muted small">Zuordnen über <b>🏦 Bankbuchung zuordnen</b> oben oder beim Kontieren einer Buchung (Feld „Festkassabuch der Veranstaltung“).
        💶 = Geld zwischen Bank und Festkassa (steht im Festkassabuch), 🧾 = Einnahme/Ausgabe des Festes direkt über die Bank (z. B. Rechnung Getränke, SumUp).</p>
      <div class="tablewrap"><table class="t"><thead><tr><th>Datum</th><th>Konto</th><th>Text</th><th>Art</th><th>Kontierung</th><th class="r">Betrag</th></tr></thead><tbody>
      ${bank.map(t => `<tr class="click" data-bid="${esc(t.buchung.id)}"><td class="nowrap">${deDate(t.buchung.datum)}</td><td class="small">${esc(kontoById(t.buchung.konto)?.name || '')}</td>
        <td class="small">${bankText(t.buchung.text)}</td><td class="small">${t.festArt === 'kassa' ? (t.betrag < 0 ? '💶 Wechselgeld' : '💶 Ablieferung') : (t.betrag < 0 ? '🧾 Ausgabe' : '🧾 Einnahme')}</td>
        <td class="small">${esc(katById(t.kategorie)?.nr || '')}</td><td class="r">${money(t.betrag)}</td></tr>`).join('')
        || '<tr><td colspan="6" class="muted">Keine.</td></tr>'}</tbody></table></div>
    </div>`;

  $('#back').addEventListener('click', () => { S.festSel = null; render(true); });
  $$('#view [data-neu]').forEach(b => b.addEventListener('click', () => postenDialog(v, { art: b.dataset.neu })));
  $('#zaehlung')?.addEventListener('click', () => zaehlDialog(v, null));
  $('#bankZuordnen')?.addEventListener('click', () => bankZuordnenDialog(v));
  $('#fkExcel')?.addEventListener('click', () => festkassaExcelDialog(v));
  bindAbgleich(v);
  $('#barumsatz')?.addEventListener('click', async () => {
    if (!await confirmDlg('Barumsatz errechnen', `Es wurde kein (vollständiger) Kassasturz erfasst. Aus Ablieferungen, Barausgaben, Wechselgeld und sonstigen
      Bareinnahmen ergibt sich ein Barumsatz von <b>${eur(-a.bestand)}</b>. Er wird als Einnahme (bar, zählt fürs Ergebnis) eingetragen – danach ist der Kassabestand 0.`, 'Eintragen')) return;
    await setDoc(doc(collection(db, 'veranstaltungen', v.id, 'posten')), {
      art: 'einnahme', zahlweg: 'bar', ergebnis: true, betrag: -a.bestand, datum: v.bis || v.von || today(), zeit: '',
      bereich: 'Barumsatz', text: 'Barumsatz errechnet aus Ablieferung (ohne Kassasturz)', beleg: '', errechnet: true,
      erfasstAm: serverTimestamp(), erfasstVon: S.uid,
    }).catch(fail);
    logTo(null, 'festkassa', `${v.name}: Barumsatz errechnet ${fmt(-a.bestand)}`);
  });
  $$('#view [data-posten]').forEach(tr => tr.addEventListener('click', () => {
    const p = (S.posten[v.id] || []).find(x => x.id === tr.dataset.posten);
    if (p.stueckelung) zaehlDialog(v, p); else postenDialog(v, p);
  }));
  $$('#view [data-bid]').forEach(tr => tr.addEventListener('click', () => buchungDialog(S.buchungen.find(b => b.id === tr.dataset.bid))));
  $('#verEdit')?.addEventListener('click', () => veranstaltungDialog(v));
  $('#verStatus')?.addEventListener('click', async () => {
    const zu = v.status === 'offen';
    if (zu && a.bestand && !confirm(`Es sind noch ${eur(a.bestand)} in der Festkassa. Trotzdem abschließen?`)) return;
    try {
      await updateDoc(doc(db, 'veranstaltungen', v.id), { status: zu ? 'abgeschlossen' : 'offen', ...(zu ? { abgeschlossenAm: serverTimestamp(), abgeschlossenVon: S.uid } : {}) });
      logTo(null, 'veranstaltung', `${v.name} ${zu ? 'abgeschlossen' : 'wieder geöffnet'}`);
    } catch (e) { fail(e); }
  });
  $('#verPrint').addEventListener('click', () => druckVeranstaltung(v));
  $('#verCsv').addEventListener('click', () => {
    const rows = [['Nr', 'Datum', 'Zeit', 'Art', 'Bereich', 'Text', 'Beleg', 'Zahlweg', 'Ergebnis', 'Eingang', 'Ausgang', 'Bestand']];
    buch.forEach(p => rows.push([p.lfd, deDate(p.datum), p.zeit || '', POSTEN_ARTEN[p.art]?.name, p.bank ? 'Bank' : p.bereich || '', p.text || '', p.beleg || '',
      p.bank ? 'Bank ' + (kontoById(p.buchung?.konto)?.name || '') : p.zahlweg === 'ueberweisung' ? 'Überweisung' : 'bar', p.ergebnis ? 'ja' : 'nein',
      p.betragVz > 0 ? fmt(p.betragVz) : '', p.betragVz < 0 ? fmt(-p.betragVz) : '', fmt(p.bestand)]));
    download(`Festkassa_${v.name.replace(/[^\wäöüÄÖÜß-]+/g, '_')}.csv`, toCsv(rows));
  });
}

/** Bankbuchungen (beider Konten) dem Festkassabuch dieser Veranstaltung zuordnen */
function bankZuordnenDialog(v) {
  const tage = d => Math.abs((new Date(d) - new Date(v.von || d)) / 864e5);
  const offen = S.buchungen.filter(b => !b.veranstaltung && !b.splits?.length);
  const info = b => {
    const name = !!veranstaltungImText(b.text, [v]);
    const art = festArtVorschlag(b, name);
    const nah = tage(b.datum) <= 21;
    // vorausgewählt: Festkassa-Bewegung rund um das Fest (Wechselgeld, Erlös, Einzahlung …)
    const sc = (art === 'kassa' && (name || nah)) ? 0 : name ? 1 : nah ? 2 : 9;
    return { b, art, sc };
  };
  const liste = offen.map(info).sort((x, y) => x.sc - y.sc || tage(x.b.datum) - tage(y.b.datum));
  const zeige = alle => (alle ? liste : liste.filter(x => x.sc <= 2)).slice(0, 150);
  const artText = b => ({ kassa: b.betrag < 0 ? '💶 Wechselgeld in die Festkassa' : '💶 Ablieferung aus der Festkassa', bank: b.betrag < 0 ? '🧾 Ausgabe über Bank' : '🧾 Einnahme über Bank' });
  const draw = alle => {
    $('#zuoRows').innerHTML = zeige(alle).map(({ b, sc, art }) => `<tr><td><input type="checkbox" data-zb="${esc(b.id)}" ${sc === 0 ? 'checked' : ''}></td>
      <td class="nowrap small">${deDate(b.datum)}</td><td class="small">${esc(kontoById(b.konto)?.name || '')}</td><td class="small">${bankText(b.text)}</td>
      <td><select data-za="${esc(b.id)}">${Object.entries(artText(b)).map(([k, n]) => `<option value="${k}" ${art === k ? 'selected' : ''}>${n}</option>`).join('')}</select></td>
      <td class="r">${money(b.betrag)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Keine passenden offenen Bankbuchungen.</td></tr>';
  };
  modal(`Bankbuchungen „${v.name}“ zuordnen`, `
    <p class="muted small">Vorausgewählt sind Festkassa-Bewegungen beider Konten rund um das Fest (Wechselgeld, Erlös, Einzahlung).
      Darunter weitere Buchungen, die das Fest erwähnen oder zeitlich nah sind – z. B. Rechnungen, die man als „Ausgabe über Bank“ zuordnen kann.
      Die Kontierung (V-P) der Feuerwehrkassa bleibt unverändert.</p>
    <label class="check"><input type="checkbox" id="zuoAlle"> alle offenen Bankbuchungen ${S.jahr} anzeigen</label>
    <div class="tablewrap" style="margin-top:8px"><table class="t"><thead><tr><th></th><th>Datum</th><th>Konto</th><th>Text</th><th>Art</th><th class="r">Betrag</th></tr></thead><tbody id="zuoRows"></tbody></table></div>`, {
    wide: true, ok: 'Zuordnen',
    onOk: async () => {
      const ids = $$('#zuoRows [data-zb]:checked').map(c => c.dataset.zb);
      if (!ids.length) { toast('Bitte mindestens eine Buchung auswählen.', true); return false; }
      const batch = writeBatch(db);
      for (const id of ids) {
        batch.update(doc(db, 'buchungen', id), { veranstaltung: v.id, festArt: $(`#zuoRows [data-za="${CSS.escape(id)}"]`).value, geaendertAm: serverTimestamp(), geaendertVon: S.uid });
      }
      logTo(batch, 'festkassa', `${v.name}: ${ids.length} Bankbuchung(en) zugeordnet`);
      await batch.commit();
      toast(`${ids.length} Bankbuchung(en) zugeordnet.`);
    },
    onOpen: () => { draw(false); $('#zuoAlle').addEventListener('change', e => draw(e.target.checked)); },
  });
}

function zahlwegLabel(p) {
  if (p.bank) return `🏦 ${esc(kontoById(p.buchung?.konto)?.name || 'Bank')}`;
  if (!p.fluss) return 'bar';
  return p.zahlweg === 'ueberweisung' ? 'Überweisung' : 'bar';
}

// ── Abgleich Festkassabuch ↔ Bank ────────────────────────────────────────────

function abgleichKarte(v, edit) {
  const ab = bankAbgleich(S.posten[v.id] || [], S.buchungen, v);
  if (!ab.zeilen.length && !ab.offen.length) return '';
  const n = s => ab.zeilen.filter(z => z.status === s).length;
  const bu = b => `<span class="nowrap">${esc(kontoById(b.konto)?.name || '')} ${deDate(b.datum)}</span> ${fmt(Math.abs(b.betrag))} <span class="muted">${esc((splitBankText(b.text).partner || '').slice(0, 30))} ${esc(splitBankText(b.text).zweck.slice(0, 40))}</span>`;
  const status = { ok: '✓ gleicher Betrag', summe: '✓ Summe mehrerer Buchungen', diff: '⚠ Betrag weicht ab', fehlt: '✗ keine Bankbuchung gefunden' };
  const probleme = ab.zeilen.filter(z => z.status === 'diff' || z.status === 'fehlt' || (z.status === 'ok' && !z.sicher));
  const passt = ab.zeilen.filter(z => (z.status === 'ok' && z.sicher) || z.status === 'summe');
  const zeile = z => `<tr><td class="small">${z.status === 'ok' && !z.sicher ? '≈ nur der Betrag passt – Name prüfen' : status[z.status]}</td>
    <td class="small">${esc(z.posten.text || z.posten.bereich)}</td><td class="r">${z.posten.art === 'ausgabe' ? '−' : ''}${fmt(z.posten.betrag)}</td>
    <td class="small">${z.buchungen.map(bu).join('<br>')}${z.status === 'diff' ? `<br><b class="${z.differenz > 0 ? 'minus' : 'plus'}">Differenz ${fmt(z.differenz)}</b>` : ''}</td>
    <td>${edit && z.status === 'diff' ? `<button class="btn small" data-abg-betrag="${esc(z.posten.id)}" data-abg-wert="${Math.abs(z.buchungen[0].betrag)}">Bankbetrag übernehmen</button>` : ''}</td></tr>`;
  return `<div class="card"><h2>Abgleich mit der Bank</h2>
    <p class="muted small">Positionen mit Zahlweg „Überweisung“ im Vergleich mit den Bankbuchungen beider Konten (60 Tage vor bis 120 Tage nach dem Fest).
      ${n('ok') + n('summe')} von ${ab.zeilen.length} gefunden${ab.zeilen.some(z => z.status === 'ok' && !z.sicher) ? ` (davon ${ab.zeilen.filter(z => z.status === 'ok' && !z.sicher).length} nur über den Betrag)` : ''}${n('diff') ? `, <b>${n('diff')} mit abweichendem Betrag</b>` : ''}${n('fehlt') ? `, <b>${n('fehlt')} ohne Bankbuchung</b>` : ''}.</p>
    ${probleme.length ? `<div class="tablewrap"><table class="t"><thead><tr><th>Status</th><th>Position</th><th class="r">Betrag</th><th>Bankbuchung</th><th></th></tr></thead><tbody>${probleme.map(zeile).join('')}</tbody></table></div>` : ''}
    ${ab.offen.length ? `<h3>Bankbuchungen zum Fest ohne Position im Festkassabuch</h3>
      <div class="tablewrap"><table class="t"><tbody>${ab.offen.map(b => `<tr><td class="small">${bu(b)}</td><td class="r">${money(b.betrag)}</td>
        <td class="r nowrap">${edit ? `<button class="btn small" data-abg-neu="${esc(b.id)}">+ als Position (Überweisung)</button>` : ''}
          ${canBook() && !locked() ? `<button class="btn small" data-bid="${esc(b.id)}">Öffnen</button>` : ''}</td></tr>`).join('')}</tbody></table></div>
      <p class="muted small">Gehört eine davon zu einem anderen Jahr oder Fest (z. B. „… Wiesenfest 2024“), einfach ignorieren oder beim Kontieren das richtige Fest wählen.</p>` : ''}
    ${passt.length ? `<details style="margin-top:8px"><summary class="small">Gefundene Zuordnungen anzeigen (${passt.length})</summary>
      <div class="tablewrap"><table class="t"><tbody>${passt.map(zeile).join('')}</tbody></table></div></details>` : ''}
  </div>`;
}

function bindAbgleich(v) {
  $$('#view [data-abg-betrag]').forEach(btn => btn.addEventListener('click', async () => {
    const p = (S.posten[v.id] || []).find(x => x.id === btn.dataset.abgBetrag);
    const neu = Number(btn.dataset.abgWert);
    if (!confirm(`„${p.text}“ von ${fmt(p.betrag)} auf ${fmt(neu)} (Betrag laut Bank) ändern?`)) return;
    await updateDoc(doc(db, 'veranstaltungen', v.id, 'posten', p.id), { betrag: neu, geaendertVon: S.uid }).catch(fail);
    logTo(null, 'festkassa', `${v.name}: ${p.text} ${fmt(p.betrag)} → ${fmt(neu)} (lt. Bank)`);
  }));
  $$('#view [data-abg-neu]').forEach(btn => btn.addEventListener('click', async () => {
    const b = S.buchungen.find(x => x.id === btn.dataset.abgNeu);
    const { partner, zweck } = splitBankText(b.text);
    await setDoc(doc(collection(db, 'veranstaltungen', v.id, 'posten')), {
      art: b.betrag < 0 ? 'ausgabe' : 'einnahme', betrag: Math.abs(b.betrag), datum: b.datum, zeit: '', zahlweg: 'ueberweisung', ergebnis: true,
      text: [partner, zweck].filter(Boolean).join(' – ').slice(0, 300), bereich: '', beleg: '', erfasstAm: serverTimestamp(), erfasstVon: S.uid,
    }).catch(fail);
    logTo(null, 'festkassa', `${v.name}: Position aus Bankbuchung ${deDate(b.datum)} ${fmt(b.betrag)} angelegt`);
  }));
}

/** Bisheriges Festkassabuch (Excel) in diese Veranstaltung übernehmen */
function festkassaExcelDialog(v) {
  let X = null;
  const vorhanden = (S.posten[v.id] || []).filter(p => p.quelle === 'excel');
  const zeichne = () => {
    if (!X) { $('#fxPrev').innerHTML = ''; return; }
    if (!X.res) { $('#fxPrev').innerHTML = '<div class="warnbox">In diesem Blatt wurde keine Kopfzeile mit „Text“, „Einnahmen“ und „Ausgaben“ gefunden.</div>'; return; }
    const z = X.res.zeilen, uebern = z.filter(r => !r.skip);
    const s = (f, a) => fmt(uebern.filter(r => r.art === a && f(r)).reduce((x, r) => x + r.betrag, 0));
    $('#fxPrev').innerHTML = `<p><b>${uebern.length}</b> Positionen werden übernommen, <b>${z.length - uebern.length}</b> übersprungen.<br>
        Überweisung: Einnahmen ${s(r => r.zahlweg === 'ueberweisung', 'einnahme')} · Ausgaben ${s(r => r.zahlweg === 'ueberweisung', 'ausgabe')}<br>
        Bar: Einnahmen ${s(r => r.zahlweg === 'bar', 'einnahme')} · Ausgaben ${s(r => r.zahlweg === 'bar', 'ausgabe')}</p>
      <div class="tablewrap" style="max-height:340px;overflow:auto"><table class="t"><thead><tr><th>Zeile</th><th>Text</th><th>Bereich</th><th>Art</th><th>Zahlweg</th><th class="r">Betrag</th><th></th></tr></thead><tbody>
      ${z.map(r => `<tr class="${r.skip ? 'muted' : ''}"><td class="small">${r.quellZeile}</td><td class="small">${esc(r.text)}</td><td class="small">${esc(r.bereich)}</td>
        <td class="small">${r.art === 'einnahme' ? 'Einnahme' : 'Ausgabe'}</td><td class="small">${r.zahlweg === 'ueberweisung' ? 'Überweisung' : 'bar'}</td>
        <td class="r">${fmt(r.betrag)}</td><td class="small">${r.skip ? '⏭ ' + esc(r.skip) : r.hinweis ? esc(r.hinweis) : ''}</td></tr>`).join('')}</tbody></table></div>`;
  };
  const lesen = () => {
    const t = X.tables[$('#fxSheet').value];
    X.res = festkassaExcel(t, { datumStandard: v.bis || v.von || today() });
    zeichne();
  };
  modal(`Festkassabuch „${v.name}“ aus Excel übernehmen`, `
    <p class="muted small">Erwartet wird der Aufbau eures bisherigen Festkassabuchs: <b>Datum | Text | Einnahmen | Ausgaben | Zahlweg</b>
      („Überweisung“, „bar in/aus Geldtasche“, „Bank“). Alle Positionen zählen fürs Ergebnis; bar kassierte bzw. bar bezahlte
      Positionen ändern den Kassabestand. Zeilen mit Zahlweg „Bank“ und die Bareinzahlung werden übersprungen – die kommen über die
      zugeordneten Bankbuchungen. Fehlt danach der Barumsatz, rechnet ihn „🧮 Barumsatz errechnen“ aus.</p>
    <div class="row"><label>Excel-Datei<input type="file" id="fxFile" accept=".xlsx,.xls,.ods"></label>
      <label>Blatt<select id="fxSheet"></select></label></div>
    ${vorhanden.length ? `<label class="check" style="margin-top:8px"><input type="checkbox" id="fxErsetzen" checked> ${vorhanden.length} früher aus Excel übernommene Positionen vorher löschen</label>` : ''}
    <div id="fxPrev" style="margin-top:10px"></div>`, {
    wide: true, ok: 'Übernehmen',
    onOk: async () => {
      const neu = X?.res?.zeilen?.filter(r => !r.skip) || [];
      if (!neu.length) { toast('Keine Positionen zum Übernehmen.', true); return false; }
      const ops = [];
      if ($('#fxErsetzen')?.checked) vorhanden.forEach(p => ops.push(b => b.delete(doc(db, 'veranstaltungen', v.id, 'posten', p.id))));
      neu.forEach((r, i) => ops.push(b => b.set(doc(collection(db, 'veranstaltungen', v.id, 'posten')), {
        art: r.art, betrag: r.betrag, datum: r.datum, zeit: '', text: r.text.slice(0, 300), bereich: r.bereich.slice(0, 60), beleg: '',
        zahlweg: r.zahlweg, ergebnis: r.ergebnis, quelle: 'excel', nr: i + 1, erfasstAm: serverTimestamp(), erfasstVon: S.uid,
      })));
      for (let i = 0; i < ops.length; i += 200) {
        const batch = writeBatch(db);
        ops.slice(i, i + 200).forEach(f => f(batch));
        if (i === 0) logTo(batch, 'festkassa', `${v.name}: ${neu.length} Positionen aus ${X.datei} übernommen`);
        await batch.commit();
      }
      toast(`${neu.length} Positionen übernommen.`);
    },
    onOpen: () => {
      $('#fxFile').addEventListener('change', async e => {
        const f = e.target.files[0];
        if (!f) return;
        if (!window.XLSX) { toast('Excel-Bibliothek nicht geladen – bitte Seite neu laden.', true); return; }
        const wb = window.XLSX.read(await f.arrayBuffer(), { type: 'array', cellDates: true });
        const tables = Object.fromEntries(wb.SheetNames.map(n => [n, window.XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '' })]));
        const passend = wb.SheetNames.find(n => festkassaExcel(tables[n])?.zeilen?.length) || wb.SheetNames[0];
        X = { tables, datei: f.name };
        $('#fxSheet').innerHTML = wb.SheetNames.map(n => `<option ${n === passend ? 'selected' : ''}>${esc(n)}</option>`).join('');
        lesen();
      });
      $('#fxSheet').addEventListener('change', lesen);
    },
  });
}

function bereichListe(v) {
  const used = (S.posten[v.id] || []).map(p => p.bereich).filter(Boolean);
  return `<datalist id="bereiche">${[...new Set([...used, ...BEREICHE])].map(b => `<option value="${esc(b)}">`).join('')}</datalist>`;
}

function postenDialog(v, p) {
  const neu = !p.id;
  const edit = canFest() && v.status === 'offen' && !locked();
  const ro = edit ? '' : 'disabled';
  const art = p.art;
  modal(`${POSTEN_ARTEN[art].name}${neu ? ' erfassen' : ''}`, `
    <div class="row">
      <label>Art<select id="pArt" ${ro}>${Object.entries(POSTEN_ARTEN).map(([k, x]) => `<option value="${k}" ${k === art ? 'selected' : ''}>${x.name}</option>`).join('')}</select></label>
      <label>Datum<input type="date" id="pDatum" value="${esc(p.datum || (art === 'wechselgeld' ? v.von : v.bis || v.von) || today())}" ${ro}></label>
      <label style="flex:0 1 110px">Uhrzeit<input type="time" id="pZeit" value="${esc(p.zeit || '')}" ${ro}></label>
    </div>
    <div class="row">
      <label>Betrag €<input id="pBetrag" class="num" inputmode="decimal" value="${p.betrag ? fmt(p.betrag) : ''}" required ${ro}></label>
      <label>Bereich / Stand<input id="pBereich" list="bereiche" value="${esc(p.bereich || '')}" maxlength="60" ${ro}></label>
      <label style="flex:0 1 120px">Beleg-Nr.<input id="pBeleg" value="${esc(p.beleg || '')}" maxlength="40" ${ro}></label>
    </div>
    <label>Text<input id="pText" value="${esc(p.text || '')}" maxlength="300" placeholder="${art === 'ausgabe' ? 'z. B. Eis, Musikkapelle, Kleinmaterial' : art === 'ablieferung' ? 'z. B. Einzahlung Raika, übergeben an Kassier' : ''}" ${ro}></label>
    <div id="pFluss" class="infobox" style="margin-top:10px">
      <div class="row">
        <label>Zahlweg<select id="pZahlweg" ${ro}>${Object.entries(ZAHLWEGE).map(([k, n]) => `<option value="${k}" ${(p.zahlweg || 'bar') === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <label class="check" style="flex:1 1 200px;margin-bottom:8px"><input type="checkbox" id="pErgebnis" ${p.ergebnis === false ? '' : 'checked'} ${ro}> zählt fürs Ergebnis des Festes</label>
      </div>
      <div class="small" id="pHint" style="margin-top:4px"></div>
    </div>
    ${bereichListe(v)}
    ${art === 'wechselgeld' || art === 'ablieferung' ? '<p class="muted small">Läuft das Geld über die Feuerwehr- oder Mannschaftskassa, nicht hier eintragen, sondern die Bankbuchung zuordnen (🏦) – sonst steht es doppelt im Festkassabuch.</p>' : ''}
    <div id="pBelege"></div>
    ${p.erfasstVon ? `<p class="muted small">Erfasst von ${esc(userName(p.erfasstVon))}</p>` : ''}`, {
    cancel: edit ? 'Abbrechen' : 'Schließen',
    extra: edit && !neu ? [{
      label: 'Löschen', cls: 'danger', onClick: async () => {
        if (!confirm('Eintrag löschen?')) return false;
        await deleteDoc(doc(db, 'veranstaltungen', v.id, 'posten', p.id));
        await belegeLoeschen(p.belege);
        logTo(null, 'festkassa', `${v.name}: gelöscht ${POSTEN_ARTEN[p.art].name} ${fmt(p.betrag)}`);
      },
    }] : [],
    onOk: edit ? async () => {
      const betrag = Math.abs(parseAmount($('#pBetrag').value) || 0);
      if (!betrag) { toast('Bitte einen Betrag eingeben.', true); return false; }
      const data = {
        art: $('#pArt').value, datum: $('#pDatum').value || v.von || today(), zeit: $('#pZeit').value, betrag,
        bereich: $('#pBereich').value.trim(), beleg: $('#pBeleg').value.trim(), text: $('#pText').value.trim(),
      };
      const fluss = data.art === 'einnahme' || data.art === 'ausgabe';
      data.zahlweg = fluss ? $('#pZahlweg').value : 'bar';
      data.ergebnis = fluss ? $('#pErgebnis').checked : false;
      if (!parseDate(data.datum)) { toast('Bitte ein Datum angeben.', true); return false; }
      data.belege = postenBelege.liste();
      if (neu) {
        await setDoc(neuPosten, { ...data, erfasstAm: serverTimestamp(), erfasstVon: S.uid });
      } else {
        await updateDoc(doc(db, 'veranstaltungen', v.id, 'posten', p.id), { ...data, geaendertVon: S.uid });
      }
      postenBelege.gespeichert();
      logTo(null, 'festkassa', `${v.name}: ${POSTEN_ARTEN[data.art].name} ${fmt(betrag)} ${data.bereich} (${data.zahlweg === 'ueberweisung' ? 'Überweisung' : 'bar'}${fluss && !data.ergebnis ? ', nicht im Ergebnis' : ''})`);
    } : null,
    onOpen: () => {
      const upd = () => {
        const art = $('#pArt').value, fluss = art === 'einnahme' || art === 'ausgabe';
        $('#pFluss').classList.toggle('hidden', !fluss);
        const ue = $('#pZahlweg').value === 'ueberweisung', erg = $('#pErgebnis').checked;
        $('#pHint').innerHTML = !fluss ? '' : [
          ue ? '➜ Läuft über ein Bankkonto: steht im Festkassabuch, <b>ändert den Kassabestand nicht</b>. Die zugehörige Bankbuchung dann nicht zusätzlich als Einnahme/Ausgabe (🧾) zuordnen.'
            : `➜ ${art === 'einnahme' ? 'Geld kommt in' : 'Geld geht aus'} der Festkassa: <b>ändert den Kassabestand</b>.`,
          erg ? `Zählt als ${art === 'einnahme' ? 'Einnahme' : 'Ausgabe'} zum Ergebnis.`
            : 'Zählt <b>nicht</b> zum Ergebnis (Durchlaufposten, z. B. Pfand, Kaution, weitergeleitetes Geld).',
        ].join(' ');
      };
      ['#pArt', '#pZahlweg', '#pErgebnis'].forEach(x => $(x).addEventListener('change', upd));
      upd();
    },
  });
  const neuPosten = neu ? doc(collection(db, 'veranstaltungen', v.id, 'posten')) : null;
  const postenBelege = belegeBox('#pBelege', {
    basis: `belege/${v.jahr}/posten/${v.id}/${neu ? neuPosten.id : p.id}`, liste: p.belege, edit,
    speichern: neu ? null : liste => updateDoc(doc(db, 'veranstaltungen', v.id, 'posten', p.id), { belege: liste }),
  });
}

function zaehlDialog(v, p) {
  const neu = !p;
  const edit = canFest() && v.status === 'offen' && !locked();
  const ro = edit ? '' : 'disabled';
  p = p || { stueckelung: {}, datum: v.bis || v.von || today(), wechselgeldAbzug: 0 };
  const label = c => c >= 100 ? `${c / 100} €` : `${c} ct`;
  modal('Kassasturz / Zählprotokoll', `
    <div class="row">
      <label>Bereich / Stand<input id="zBereich" list="bereiche" value="${esc(p.bereich || '')}" maxlength="60" required ${ro}></label>
      <label>Datum<input type="date" id="zDatum" value="${esc(p.datum)}" ${ro}></label>
      <label style="flex:0 1 110px">Uhrzeit<input type="time" id="zZeit" value="${esc(p.zeit || '')}" ${ro}></label>
    </div>
    <label>Gezählt von (Namen)<input id="zText" value="${esc(p.text || '')}" maxlength="300" placeholder="z. B. Gezählt: Huber, Mayr" ${ro}></label>
    <p class="muted small" style="margin:12px 0 6px">Anzahl Scheine und Münzen:</p>
    <div class="stueck">${STUECKELUNG.map(c => `<label>${label(c)}<input type="number" min="0" step="1" inputmode="numeric" data-st="${c}" value="${p.stueckelung?.[c] || ''}" ${ro}></label>`).join('')}</div>
    <div class="row" style="margin-top:10px">
      <label>Gezählt gesamt<input id="zSumme" class="num" disabled></label>
      <label>davon Wechselgeld (bleibt nicht als Einnahme)<input id="zWg" class="num" inputmode="decimal" value="${p.wechselgeldAbzug ? fmt(p.wechselgeldAbzug) : ''}" ${ro}></label>
      <label>= Einnahme<input id="zEin" class="num" disabled style="font-weight:700"></label>
    </div>
    <p class="muted small">Das Wechselgeld, das zu Beginn in diese Kassa gegeben wurde, wird abgezogen. Es muss vorher als „Wechselgeld“ eingetragen sein, damit der Kassabestand stimmt.</p>
    ${bereichListe(v)}`, {
    wide: true,
    cancel: edit ? 'Abbrechen' : 'Schließen',
    extra: edit && !neu ? [{
      label: 'Löschen', cls: 'danger', onClick: async () => {
        if (!confirm('Zählprotokoll löschen?')) return false;
        await deleteDoc(doc(db, 'veranstaltungen', v.id, 'posten', p.id));
        logTo(null, 'festkassa', `${v.name}: Zählprotokoll ${p.bereich} gelöscht`);
      },
    }] : [],
    onOk: edit ? async () => {
      const st = {};
      $$('[data-st]').forEach(i => { const n = parseInt(i.value, 10); if (n > 0) st[i.dataset.st] = n; });
      const summe = stueckelungSumme(st);
      const wg = Math.abs(parseAmount($('#zWg').value) || 0);
      const betrag = summe - wg;
      if (!$('#zBereich').value.trim()) { toast('Bitte den Bereich/Stand angeben.', true); return false; }
      if (betrag <= 0) { toast('Die Einnahme muss größer als 0 sein.', true); return false; }
      const data = {
        art: 'einnahme', zahlweg: 'bar', ergebnis: true, datum: $('#zDatum').value || p.datum, zeit: $('#zZeit').value, bereich: $('#zBereich').value.trim(),
        text: $('#zText').value.trim(), stueckelung: st, gezaehlt: summe, wechselgeldAbzug: wg, betrag,
      };
      if (neu) await setDoc(doc(collection(db, 'veranstaltungen', v.id, 'posten')), { ...data, erfasstAm: serverTimestamp(), erfasstVon: S.uid });
      else await updateDoc(doc(db, 'veranstaltungen', v.id, 'posten', p.id), { ...data, geaendertVon: S.uid });
      logTo(null, 'festkassa', `${v.name}: Kassasturz ${data.bereich} = ${fmt(betrag)}`);
    } : null,
    onOpen: () => {
      const calc = () => {
        const st = {};
        $$('[data-st]').forEach(i => { st[i.dataset.st] = parseInt(i.value, 10) || 0; });
        const s = stueckelungSumme(st);
        const wg = Math.abs(parseAmount($('#zWg').value) || 0);
        $('#zSumme').value = fmt(s) + ' €';
        $('#zEin').value = fmt(s - wg) + ' €';
      };
      $$('#dlg [data-st], #zWg').forEach(i => i.addEventListener('input', calc));
      calc();
    },
  });
}

// ── Jahresabschluss ──────────────────────────────────────────────────────────

function viewAbschluss() {
  const r = abschlussDaten();
  const K = S.konten;
  const edit = canBook() && !locked();
  const anfang = anfangsbestaende();
  const bankEnde = S.jahrDoc?.bankEnde || {};
  const offeneVer = S.veranstaltungen.filter(v => v.status !== 'abgeschlossen');
  const festBestand = S.veranstaltungen.map(v => [v, abrechnungVon(v).bestand]).filter(([, b]) => b);
  const vorjahrOffen = !S.vorjahrDoc?.gesperrt;
  const warn = [];
  if (r.gesamt.unkontiert) warn.push(`<a href="#" id="toUnk">${r.gesamt.unkontiert} Buchung(en)</a> sind noch nicht kontiert.`);
  if (r.summeUmbuchungen.summe) warn.push(`Umbuchungen zwischen den eigenen Konten ergeben in Summe ${fmt(r.summeUmbuchungen.summe)} € statt 0 – eine Gegenbuchung fehlt oder ist falsch kontiert.`);
  if (offeneVer.length) warn.push(`Noch offene Veranstaltungen: ${offeneVer.map(v => esc(v.name)).join(', ')}.`);
  festBestand.forEach(([v, b]) => warn.push(`Festkassa „${esc(v.name)}“ hat noch einen Bestand von ${eur(b)}.`));
  K.forEach(k => {
    if (Number.isInteger(bankEnde[k.id]) && bankEnde[k.id] !== r.proKonto[k.id].ende)
      warn.push(`${esc(k.name)}: Endbestand lt. Buchungen (${fmt(r.proKonto[k.id].ende)}) ≠ Kontoauszug (${fmt(bankEnde[k.id])}) – Differenz ${fmt(r.proKonto[k.id].ende - bankEnde[k.id])} €.`);
    if (!Number.isInteger(bankEnde[k.id])) warn.push(`${esc(k.name)}: Saldo laut Kontoauszug per 31.12. noch nicht eingetragen.`);
  });

  const katTable = (title, rows, sum) => `<tr class="sub"><td colspan="${K.length + 3}">${title}</td></tr>`
    + rows.map(x => `<tr><td class="small">${esc(x.nr)}</td><td>${esc(x.name)}</td>${K.map(k => `<td class="r">${x.werte[k.id] ? fmt(x.werte[k.id]) : ''}</td>`).join('')}<td class="r"><b>${fmt(x.summe)}</b></td></tr>`).join('')
    + `<tr class="sum"><td></td><td>Summe ${title}</td>${K.map(k => `<td class="r">${fmt(sum.werte[k.id])}</td>`).join('')}<td class="r">${fmt(sum.summe)}</td></tr>`;

  $('#view').innerHTML = `
    <div class="card">
      <div class="toolbar"><h2 style="margin:0;flex:1">Jahresabschluss ${S.jahr}</h2>
        <button class="btn" id="absPrint">🖨 Drucken / PDF</button>
        <button class="btn" id="absCsv">⬇ CSV</button>
        <button class="btn" id="absZip" title="Alle Belege des Jahres als ZIP-Datei">📎 Belege als ZIP</button>
        ${edit ? `<button class="btn primary" id="absLock">🔒 Jahr abschließen</button>` : ''}
        ${locked() && isAdmin() ? `<button class="btn" id="absUnlock">🔓 Wieder öffnen</button>` : ''}
      </div>
      ${locked() ? `<div class="infobox">🔒 Abgeschlossen ${S.jahrDoc.gesperrtVon ? 'von ' + esc(userName(S.jahrDoc.gesperrtVon)) : ''}${S.jahrDoc.gesperrtAm?.toDate ? ' am ' + S.jahrDoc.gesperrtAm.toDate().toLocaleDateString('de-AT') : ''}. Die Endbestände werden als Anfangsbestände ins Jahr ${S.jahr + 1} übernommen.</div>` : ''}
      ${warn.length ? warn.map(w => `<div class="warnbox">⚠ ${w}</div>`).join('') : '<div class="okbox">✓ Alles kontiert, Festkassen abgeliefert und Bankstände abgestimmt.</div>'}

      <h3>Kontenentwicklung</h3>
      <div class="tablewrap"><table class="t"><thead><tr><th></th>${K.map(k => `<th class="r">${esc(k.name)}</th>`).join('')}<th class="r">Gesamt</th></tr></thead><tbody>
        <tr><td>Anfangsbestand 1.1.${S.jahr}${vorjahrOffen ? '' : ` <span class="muted small">(aus Abschluss ${S.jahr - 1})</span>`}</td>${K.map(k => `<td class="r">${edit
          ? `<input class="num" style="width:120px" data-anfang="${esc(k.id)}" value="${fmt(anfang[k.id])}">` : fmt(anfang[k.id])}</td>`).join('')}<td class="r">${fmt(r.gesamt.anfang)}</td></tr>
        <tr><td>+ Einnahmen</td>${K.map(k => `<td class="r plus">${fmt(r.proKonto[k.id].einnahmen)}</td>`).join('')}<td class="r plus">${fmt(r.gesamt.einnahmen)}</td></tr>
        <tr><td>− Ausgaben</td>${K.map(k => `<td class="r minus">${fmt(-r.proKonto[k.id].ausgaben)}</td>`).join('')}<td class="r minus">${fmt(-r.gesamt.ausgaben)}</td></tr>
        <tr><td>± Umbuchungen</td>${K.map(k => `<td class="r">${fmt(r.proKonto[k.id].umbuchungen)}</td>`).join('')}<td class="r">${fmt(r.gesamt.umbuchungen)}</td></tr>
        <tr class="sum"><td>Endbestand 31.12.${S.jahr} lt. Buchungen</td>${K.map(k => `<td class="r">${fmt(r.proKonto[k.id].ende)}</td>`).join('')}<td class="r">${fmt(r.gesamt.ende)}</td></tr>
        <tr><td>Saldo lt. Kontoauszug 31.12.</td>${K.map(k => `<td class="r">${edit
          ? `<input class="num" style="width:120px" data-bankende="${esc(k.id)}" value="${Number.isInteger(bankEnde[k.id]) ? fmt(bankEnde[k.id]) : ''}" placeholder="eintragen">`
          : (Number.isInteger(bankEnde[k.id]) ? fmt(bankEnde[k.id]) : '–')}</td>`).join('')}<td></td></tr>
        <tr><td>Differenz</td>${K.map(k => { const d = Number.isInteger(bankEnde[k.id]) ? r.proKonto[k.id].ende - bankEnde[k.id] : null; return `<td class="r">${d === null ? '' : d === 0 ? '<span class="plus">✓ 0,00</span>' : `<b class="minus">${fmt(d)}</b>`}</td>`; }).join('')}<td></td></tr>
        <tr><td class="muted small">Ergebnis des Jahres (Einnahmen − Ausgaben)</td>${K.map(k => `<td class="r small">${money(r.proKonto[k.id].einnahmen + r.proKonto[k.id].ausgaben)}</td>`).join('')}<td class="r small">${money(r.gesamt.einnahmen + r.gesamt.ausgaben)}</td></tr>
      </tbody></table></div>
      ${edit ? `<p class="muted small">Anfangsbestände werden aus dem abgeschlossenen Vorjahr übernommen. Für das erste Jahr hier den Kontostand per 1.1. eintragen. Werte werden beim Verlassen des Feldes gespeichert.</p>` : ''}

      <h3>Einnahmen und Ausgaben nach Kategorien</h3>
      <div class="tablewrap"><table class="t"><thead><tr><th>Nr.</th><th>Kategorie</th>${K.map(k => `<th class="r">${esc(k.name)}</th>`).join('')}<th class="r">Gesamt</th></tr></thead><tbody>
        ${katTable('Einnahmen', r.einnahmen, r.summeEinnahmen)}
        ${katTable('Ausgaben', r.ausgaben, r.summeAusgaben)}
        ${r.umbuchungen.length ? katTable('Umbuchungen', r.umbuchungen, r.summeUmbuchungen) : ''}
      </tbody></table></div>

      ${K.filter(k => hatVp(S.kategorien, k.id)).map(k => gemeindeTabelle(k)).join('')}

      <h3>Veranstaltungen</h3>
      ${veranstaltungsTabelle()}
    </div>`;

  $('#toUnk')?.addEventListener('click', e => { e.preventDefault(); S.filter = { konto: '', kat: '__none', ver: '', q: '', richtung: '' }; goTab('buchungen'); });
  $('#absPrint').addEventListener('click', druckAbschluss);
  $$('#view [data-gde]').forEach(b => b.addEventListener('click', () => druckGemeinde(kontoById(b.dataset.gde))));
  $$('#view [data-gdecsv]').forEach(b => b.addEventListener('click', () => csvGemeinde(kontoById(b.dataset.gdecsv))));
  $('#absCsv').addEventListener('click', () => exportAbschluss(r));
  $('#absZip').addEventListener('click', belegeZip);
  $$('#view [data-anfang], #view [data-bankende]').forEach(inp => inp.addEventListener('change', async () => {
    const field = inp.dataset.anfang ? 'anfang' : 'bankEnde';
    const k = inp.dataset.anfang || inp.dataset.bankende;
    const val = inp.value.trim() === '' ? null : parseAmount(inp.value);
    if (inp.value.trim() !== '' && val === null) { toast('Ungültiger Betrag.', true); return; }
    try {
      await setDoc(doc(db, 'jahre', String(S.jahr)), { [field]: { [k]: val === null ? deleteField() : val } }, { merge: true });
      logTo(null, 'abschluss', `${S.jahr} ${field === 'anfang' ? 'Anfangsbestand' : 'Kontoauszug 31.12.'} ${kontoById(k)?.name}: ${val === null ? 'gelöscht' : fmt(val)}`);
    } catch (e) { fail(e); }
  }));
  $('#absLock')?.addEventListener('click', async () => {
    if (!await confirmDlg(`Jahr ${S.jahr} abschließen`, `${warn.length ? `<span class="minus">Es gibt noch ${warn.length} Hinweis(e).</span><br>` : ''}
      Nach dem Abschluss können Buchungen, Festkassen und Veranstaltungen des Jahres ${S.jahr} nicht mehr geändert werden.
      Die Endbestände werden ins Jahr ${S.jahr + 1} übernommen. Nur ein Admin kann das Jahr wieder öffnen.`, 'Abschließen')) return;
    const endsalden = Object.fromEntries(K.map(k => [k.id, r.proKonto[k.id].ende]));
    const batch = writeBatch(db);
    batch.set(doc(db, 'jahre', String(S.jahr)), {
      gesperrt: true, gesperrtAm: serverTimestamp(), gesperrtVon: S.uid, endsalden,
      anfang: Object.fromEntries(K.map(k => [k.id, anfang[k.id]])),
      zusammenfassung: { einnahmen: r.gesamt.einnahmen, ausgaben: r.gesamt.ausgaben, buchungen: S.buchungen.length },
    }, { merge: true });
    logTo(batch, 'abschluss', `Jahr ${S.jahr} abgeschlossen. Endbestände: ${K.map(k => `${k.name} ${fmt(endsalden[k.id])}`).join(', ')}`);
    await batch.commit().catch(fail);
  });
  $('#absUnlock')?.addEventListener('click', async () => {
    if (!await confirmDlg(`Jahr ${S.jahr} wieder öffnen`, 'Danach können Buchungen wieder geändert werden. Achtung: Ändern sich die Endbestände, muss das Jahr erneut abgeschlossen werden, damit das Folgejahr die richtigen Anfangsbestände bekommt.', 'Öffnen')) return;
    const batch = writeBatch(db);
    batch.set(doc(db, 'jahre', String(S.jahr)), { gesperrt: false }, { merge: true });
    logTo(batch, 'abschluss', `Jahr ${S.jahr} wieder geöffnet`);
    await batch.commit().catch(fail);
  });
}

// ── Feuerwehr-Rechnungsabschluss (Gemeinde) ─────────────────────────────────

function gemeindeDaten(k) {
  return gemeindeAbschluss({ buchungen: S.buchungen.filter(b => b.konto === k.id), kategorien: S.kategorien, anfang: anfangsbestaende()[k.id] || 0 });
}
/** Zwei Spalten nebeneinander wie im Formular: Einnahmen links, Ausgaben rechts */
function gemeindeZeilen(g, cls = '') {
  const n = Math.max(g.einnahmen.length, g.ausgaben.length);
  const cell = x => x ? `<td>${esc(x.vp)}</td><td>${esc(x.name)}</td><td class="r">${fmt(x.betrag)}</td>` : '<td></td><td></td><td></td>';
  let html = '';
  for (let i = 0; i < n; i++) html += `<tr class="${cls}">${cell(g.einnahmen[i])}${cell(g.ausgaben[i])}</tr>`;
  return html;
}
function gemeindeTabelle(k) {
  const g = gemeindeDaten(k);
  return `<h3>Feuerwehr-Rechnungsabschluss für die Gemeinde (${esc(k.name)})</h3>
    <div class="toolbar"><button class="btn" data-gde="${esc(k.id)}">🏛 Rechnungsabschluss drucken</button><button class="btn" data-gdecsv="${esc(k.id)}">⬇ CSV</button></div>
    ${g.ohne.length ? `<div class="warnbox">⚠ ${g.ohne.length} Buchung(steil)e(n) haben keinen Voranschlagsposten und fehlen im Gemeinde-Abschluss
      (${g.ohne.slice(0, 5).map(p => `${deDate(p.buchung.datum)} ${fmt(p.betrag)}`).join(', ')}${g.ohne.length > 5 ? ' …' : ''}). Bitte mit einer V-P-Kategorie kontieren.</div>` : ''}
    <div class="tablewrap"><table class="t"><thead><tr><th>V-P</th><th>Einnahmen</th><th class="r">Euro</th><th>V-P</th><th>Ausgaben</th><th class="r">Euro</th></tr></thead><tbody>
      ${gemeindeZeilen(g)}
      <tr class="sum"><td colspan="2">Summe der Einnahmen</td><td class="r">${fmt(g.summeE)}</td><td colspan="2">Summe der Ausgaben</td><td class="r">${fmt(g.summeA)}</td></tr>
      <tr><td colspan="2">Kassastand 01.01.${S.jahr}</td><td class="r">${fmt(g.anfang)}</td><td colspan="2">Kassastand 01.01.${S.jahr + 1}</td><td class="r"><b>${fmt(g.ende)}</b></td></tr>
    </tbody></table></div>`;
}
function druckGemeinde(k) {
  const g = gemeindeDaten(k);
  const A = S.allgemein;
  printOut(`<div style="font-size:11pt;line-height:1.6">Freiwillige Feuerwehr&nbsp;&nbsp;&nbsp;<b>${esc(A.ffName.toUpperCase())}</b><br>
      Gemeinde&nbsp;&nbsp;&nbsp;<b>${esc(A.gemeinde.toUpperCase())}</b></div>
    <h1 style="text-align:center;margin-top:18pt">FEUERWEHR-RECHNUNGSABSCHLUSS</h1>
    <p style="text-align:center;margin:0 0 14pt">für das Finanzjahr ${S.jahr}</p>
    <table><thead><tr><th colspan="3">Einnahmen</th><th colspan="3">Ausgaben</th></tr>
      <tr><th>V-P</th><th>Gegenstand</th><th class="r">Euro</th><th>V-P</th><th>Gegenstand</th><th class="r">Euro</th></tr></thead><tbody>
      ${gemeindeZeilen(g)}
      <tr class="sum"><td colspan="2">Summe der Einnahmen</td><td class="r">${fmt(g.summeE)}</td><td colspan="2">Summe der Ausgaben</td><td class="r">${fmt(g.summeA)}</td></tr>
      <tr><td colspan="2">Kassastand 01.01.${S.jahr}</td><td class="r">${fmt(g.anfang)}</td><td colspan="2">Kassastand 01.01.${S.jahr + 1}</td><td class="r"><b>${fmt(g.ende)}</b></td></tr>
    </tbody></table>
    ${g.ohne.length ? `<p><b>Achtung: ${g.ohne.length} Buchung(en) ohne Voranschlagsposten – Abschluss unvollständig.</b></p>` : ''}
    <p style="margin-top:24pt">${esc(A.ort)}, am ____________________</p>
    ${sig(['Rechnungsprüfer', 'Kassier'])}${sig(['Rechnungsprüfer', 'Feuerwehrkommandant'])}`);
}
function csvGemeinde(k) {
  const g = gemeindeDaten(k);
  const rows = [[`Feuerwehr-Rechnungsabschluss ${S.jahr} – FF ${S.allgemein.ffName}`], [], ['V-P', 'Einnahmen', 'Euro', 'V-P', 'Ausgaben', 'Euro']];
  for (let i = 0; i < Math.max(g.einnahmen.length, g.ausgaben.length); i++) {
    const e = g.einnahmen[i], a = g.ausgaben[i];
    rows.push([e?.vp || '', e?.name || '', e ? fmt(e.betrag) : '', a?.vp || '', a?.name || '', a ? fmt(a.betrag) : '']);
  }
  rows.push(['', 'Summe der Einnahmen', fmt(g.summeE), '', 'Summe der Ausgaben', fmt(g.summeA)]);
  rows.push(['', `Kassastand 01.01.${S.jahr}`, fmt(g.anfang), '', `Kassastand 01.01.${S.jahr + 1}`, fmt(g.ende)]);
  download(`Rechnungsabschluss_${k.name}_${S.jahr}.csv`, toCsv(rows));
}

/** Kassabuch eines Kontos wie in der bisherigen Excel: Nr., Datum, Bezeichnung, Betrag, Kontierung, Saldo */
function druckKassabuch(kontoId) {
  const k = kontoById(kontoId);
  const list = S.buchungen.filter(b => b.konto === kontoId).sort(chronoSort);
  let saldo = anfangsbestaende()[kontoId] || 0;
  let se = 0, sa = 0;
  const rows = list.map(b => {
    saldo += b.betrag;
    if (b.betrag >= 0) se += b.betrag; else sa -= b.betrag;
    const { partner, zweck } = splitBankText(b.text);
    const kont = parts(b).map(p => katById(p.kategorie)?.nr || '?').join(' / ');
    return `<tr><td class="r">${S.belegNr.get(b.id) || ''}</td><td>${deDate(b.datum)}</td><td>${esc([partner, zweck].filter(Boolean).join(' – ') || b.text)}</td>
      <td class="r">${b.betrag >= 0 ? fmt(b.betrag) : ''}</td><td class="r">${b.betrag < 0 ? fmt(-b.betrag) : ''}</td><td>${esc(kont)}</td><td class="r">${fmt(saldo)}</td></tr>`;
  }).join('');
  printOut(`<h1>Kassabuch ${esc(k.name)} ${S.jahr}</h1>
    <p class="meta">Freiwillige Feuerwehr ${esc(S.allgemein.ffName)}${k.iban ? ' · ' + esc(k.iban) : ''} · ${list.length} Buchungen</p>
    <table><thead><tr><th class="r">Nr.</th><th>Datum</th><th>Bezeichnung</th><th class="r">Einnahme</th><th class="r">Ausgabe</th><th>Kontierung</th><th class="r">Saldo</th></tr></thead><tbody>
      <tr><td></td><td>01.01.${S.jahr}</td><td>Anfangsbestand</td><td></td><td></td><td></td><td class="r">${fmt(anfangsbestaende()[kontoId] || 0)}</td></tr>
      ${rows}
      <tr class="sum"><td colspan="3">Summe</td><td class="r">${fmt(se)}</td><td class="r">${fmt(sa)}</td><td></td><td class="r">${fmt(saldo)}</td></tr>
    </tbody></table>${sig(['Kassier', 'Rechnungsprüfer', 'Rechnungsprüfer'])}`);
}

function veranstaltungsTabelle() {
  if (!S.veranstaltungen.length) return '<p class="muted">Keine Veranstaltungen.</p>';
  let se = 0, sa = 0;
  const rows = S.veranstaltungen.map(v => {
    const a = abrechnungVon(v);
    se += a.einnahmen; sa += a.ausgaben;
    return `<tr><td>${esc(v.name)}</td><td class="nowrap">${deDate(v.von)}</td><td class="r">${fmt(a.einnahmen)}</td><td class="r">${fmt(a.ausgaben)}</td><td class="r">${fmt(a.ergebnis)}</td></tr>`;
  }).join('');
  return `<div class="tablewrap"><table class="t"><thead><tr><th>Veranstaltung</th><th>Datum</th><th class="r">Einnahmen</th><th class="r">Ausgaben</th><th class="r">Ergebnis</th></tr></thead>
    <tbody>${rows}<tr class="sum"><td colspan="2">Summe Veranstaltungen</td><td class="r">${fmt(se)}</td><td class="r">${fmt(sa)}</td><td class="r">${fmt(se - sa)}</td></tr></tbody></table></div>
    <p class="muted small">Brutto-Werte aus Festkassabuch und zugeordneten Bankbuchungen. In der Kategorien-Übersicht oben steht die Festkassa nur mit dem Betrag, der tatsächlich auf die Bank gekommen ist.</p>`;
}

function exportAbschluss(r) {
  const K = S.konten;
  const rows = [[`Jahresabschluss ${S.jahr} – FF Pichl`], [], ['', '', ...K.map(k => k.name), 'Gesamt']];
  const line = (a, b, f) => rows.push([a, b, ...K.map(k => fmt(f(k.id))), fmt(K.reduce((s, k) => s + f(k.id), 0))]);
  line('', 'Anfangsbestand', id => r.proKonto[id].anfang);
  line('', 'Einnahmen', id => r.proKonto[id].einnahmen);
  line('', 'Ausgaben', id => r.proKonto[id].ausgaben);
  line('', 'Umbuchungen', id => r.proKonto[id].umbuchungen);
  line('', 'Endbestand', id => r.proKonto[id].ende);
  for (const [t, list, sum] of [['Einnahmen', r.einnahmen, r.summeEinnahmen], ['Ausgaben', r.ausgaben, r.summeAusgaben], ['Umbuchungen', r.umbuchungen, r.summeUmbuchungen]]) {
    if (!list.length) continue;
    rows.push([], [t]);
    list.forEach(x => rows.push([x.nr, x.name, ...K.map(k => fmt(x.werte[k.id] || 0)), fmt(x.summe)]));
    rows.push(['', 'Summe ' + t, ...K.map(k => fmt(sum.werte[k.id])), fmt(sum.summe)]);
  }
  rows.push([], ['Veranstaltungen', '', 'Einnahmen', 'Ausgaben', 'Ergebnis']);
  S.veranstaltungen.forEach(v => { const a = abrechnungVon(v); rows.push([deDate(v.von), v.name, fmt(a.einnahmen), fmt(a.ausgaben), fmt(a.ergebnis)]); });
  download(`Jahresabschluss_${S.jahr}.csv`, toCsv(rows));
}

/** Alle Belege des gewählten Jahres als ZIP (Konto/Nr_Datum_Text.pdf, Festkassa/Fest/…) mit Belegliste.csv */
async function belegeZip() {
  if (!window.JSZip) { toast('ZIP-Bibliothek nicht geladen – bitte Seite neu laden.', true); return; }
  const dateien = [];
  for (const b of [...S.buchungen].sort(chronoSort)) {
    const nr = String(S.belegNr.get(b.id) || 0).padStart(3, '0');
    const t = lesbar(splitBankText(b.text).partner || splitBankText(b.text).zweck || b.text).slice(0, 40);
    (b.belege || []).forEach((x, i) => dateien.push({ x, ordner: lesbar(kontoById(b.konto)?.name || b.konto),
      name: `${nr}_${b.datum}_${t}${b.belege.length > 1 ? '_' + (i + 1) : ''}`, zeile: [kontoById(b.konto)?.name, nr, deDate(b.datum), fmt(b.betrag), b.text] }));
  }
  for (const v of S.veranstaltungen) {
    for (const p of abrechnungVon(v).buch.filter(p => !p.bank)) {
      (p.belege || []).forEach((x, i) => dateien.push({ x, ordner: 'Festkassa/' + lesbar(v.name),
        name: `${String(p.lfd).padStart(3, '0')}_${p.datum}_${lesbar(p.text || p.bereich || p.art).slice(0, 40)}${p.belege.length > 1 ? '_' + (i + 1) : ''}`,
        zeile: [v.name, p.lfd, deDate(p.datum), fmt(p.betragVz), p.text || p.bereich] }));
    }
  }
  if (!dateien.length) { toast(`Im Jahr ${S.jahr} sind noch keine Belege hochgeladen.`); return; }
  const zip = new window.JSZip();
  const liste = [['Datei', 'Konto / Fest', 'Nr.', 'Datum', 'Betrag', 'Text']];
  let fehler = 0;
  for (const [i, d] of dateien.entries()) {
    toast(`Belege werden gesammelt … ${i + 1}/${dateien.length}`);
    const ext = (d.x.name.match(/\.(\w{2,4})$/) || [, d.x.typ === 'application/pdf' ? 'pdf' : 'jpg'])[1].toLowerCase();
    const pfad = `${d.ordner}/${d.name}.${ext}`;
    try {
      zip.file(pfad, await getBlob(sRef(storage, d.x.pfad)));
      liste.push([pfad, ...d.zeile]);
    } catch (e) { fehler++; console.error(e); }
  }
  if (fehler === dateien.length) {
    toast('Belege konnten nicht geladen werden. Beim ersten Mal muss für den Speicher CORS eingerichtet werden (siehe README, „Belege“).', true);
    return;
  }
  zip.file('Belegliste.csv', toCsv(liste));
  const blob = await zip.generateAsync({ type: 'blob' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `Belege_${S.jahr}.zip`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast(`${dateien.length - fehler} Belege als ZIP gespeichert${fehler ? ` (${fehler} fehlgeschlagen)` : ''}.`, !!fehler);
}

// ── Druckansichten ───────────────────────────────────────────────────────────

function printOut(html) {
  $('#print').innerHTML = html + `<p class="meta">Erstellt am ${new Date().toLocaleString('de-AT')} von ${esc(S.me.name)} · Kassenbuch FF Pichl</p>`;
  window.print();
}
const sig = names => `<div class="sig">${names.map(n => `<div>${esc(n)}</div>`).join('')}</div>`;

function druckAbschluss() {
  const r = abschlussDaten();
  const K = S.konten;
  const cols = K.length + 3;
  const kat = (title, rows, sum) => `<tr class="sub"><td colspan="${cols}">${title}</td></tr>`
    + rows.map(x => `<tr><td>${esc(x.nr)}</td><td>${esc(x.name)}</td>${K.map(k => `<td class="r">${x.werte[k.id] ? fmt(x.werte[k.id]) : ''}</td>`).join('')}<td class="r">${fmt(x.summe)}</td></tr>`).join('')
    + `<tr class="sum"><td></td><td>Summe ${title}</td>${K.map(k => `<td class="r">${fmt(sum.werte[k.id])}</td>`).join('')}<td class="r">${fmt(sum.summe)}</td></tr>`;
  const bankEnde = S.jahrDoc?.bankEnde || {};
  printOut(`<h1>Freiwillige Feuerwehr ${esc(S.allgemein.ffName)} – Jahresabschluss ${S.jahr}</h1>
    <p class="meta">Zeitraum 1.1.–31.12.${S.jahr} · ${S.buchungen.length} Bankbuchungen${locked() ? ' · abgeschlossen' : ' · <b>vorläufig (nicht abgeschlossen)</b>'}</p>
    <section><h2>Kontenentwicklung</h2><table><thead><tr><th></th>${K.map(k => `<th class="r">${esc(k.name)}</th>`).join('')}<th class="r">Gesamt</th></tr></thead><tbody>
      <tr><td>Anfangsbestand 1.1.</td>${K.map(k => `<td class="r">${fmt(r.proKonto[k.id].anfang)}</td>`).join('')}<td class="r">${fmt(r.gesamt.anfang)}</td></tr>
      <tr><td>+ Einnahmen</td>${K.map(k => `<td class="r">${fmt(r.proKonto[k.id].einnahmen)}</td>`).join('')}<td class="r">${fmt(r.gesamt.einnahmen)}</td></tr>
      <tr><td>− Ausgaben</td>${K.map(k => `<td class="r">${fmt(-r.proKonto[k.id].ausgaben)}</td>`).join('')}<td class="r">${fmt(-r.gesamt.ausgaben)}</td></tr>
      <tr><td>± Umbuchungen</td>${K.map(k => `<td class="r">${fmt(r.proKonto[k.id].umbuchungen)}</td>`).join('')}<td class="r">${fmt(r.gesamt.umbuchungen)}</td></tr>
      <tr class="sum"><td>Endbestand 31.12.</td>${K.map(k => `<td class="r">${fmt(r.proKonto[k.id].ende)}</td>`).join('')}<td class="r">${fmt(r.gesamt.ende)}</td></tr>
      <tr><td>lt. Kontoauszug</td>${K.map(k => `<td class="r">${Number.isInteger(bankEnde[k.id]) ? fmt(bankEnde[k.id]) : '–'}</td>`).join('')}<td></td></tr>
    </tbody></table></section>
    <section><h2>Einnahmen und Ausgaben</h2><table><thead><tr><th>Nr.</th><th>Kategorie</th>${K.map(k => `<th class="r">${esc(k.name)}</th>`).join('')}<th class="r">Gesamt</th></tr></thead><tbody>
      ${kat('Einnahmen', r.einnahmen, r.summeEinnahmen)}${kat('Ausgaben', r.ausgaben, r.summeAusgaben)}${r.umbuchungen.length ? kat('Umbuchungen', r.umbuchungen, r.summeUmbuchungen) : ''}
      <tr class="sum"><td></td><td>Jahresergebnis</td>${K.map(k => `<td class="r">${fmt(r.proKonto[k.id].einnahmen + r.proKonto[k.id].ausgaben)}</td>`).join('')}<td class="r">${fmt(r.gesamt.einnahmen + r.gesamt.ausgaben)}</td></tr>
    </tbody></table></section>
    <section><h2>Veranstaltungen</h2>${veranstaltungsTabelle().replace(/class="t"/g, '')}</section>
    <p style="margin-top:20pt">Die Kassa wurde geprüft und für in Ordnung befunden.</p>
    ${sig(['Kassier', 'Kommandant', 'Kassaprüfer', 'Kassaprüfer'])}`);
}

function druckVeranstaltung(v) {
  const a = abrechnungVon(v);
  const buch = a.buch;
  const zaehl = buch.filter(p => p.stueckelung);
  printOut(`<h1>Festkassabuch – ${esc(v.name)}</h1>
    <p class="meta">${deDate(v.von)}${v.bis && v.bis !== v.von ? ' – ' + deDate(v.bis) : ''}${v.ort ? ' · ' + esc(v.ort) : ''}${v.verantwortlich ? ' · Verantwortlich: ' + esc(v.verantwortlich) : ''}</p>
    <section><h2>Festkassabuch</h2><table><thead><tr><th>Nr.</th><th>Datum</th><th>Art</th><th>Bereich</th><th>Text</th><th>Beleg</th><th>Zahlweg</th><th>Erg.</th><th class="r">Eingang</th><th class="r">Ausgang</th><th class="r">Bestand</th></tr></thead><tbody>
      ${buch.map(p => `<tr><td>${p.lfd}</td><td>${deDate(p.datum)} ${esc(p.zeit || '')}</td><td>${esc(POSTEN_ARTEN[p.art]?.name)}</td><td>${p.bank ? 'Bank ' + esc(kontoById(p.buchung.konto)?.name || '') : esc(p.bereich || '')}</td><td>${esc(p.text || '')}</td><td>${esc(p.beleg || '')}</td>
        <td>${p.bank ? 'Bank' : p.fluss && p.zahlweg === 'ueberweisung' ? 'Überw.' : 'bar'}</td><td>${p.ergebnis ? '✓' : '–'}</td>
        <td class="r">${p.betragVz > 0 ? fmt(p.betragVz) : ''}</td><td class="r">${p.betragVz < 0 ? fmt(-p.betragVz) : ''}</td><td class="r">${fmt(p.bestand)}</td></tr>`).join('')}
      <tr class="sum"><td colspan="10">Kassabestand</td><td class="r">${fmt(a.bestand)}</td></tr></tbody></table></section>
    <section><h2>Abrechnung</h2><table><thead><tr><th>Bereich</th><th class="r">Einnahmen</th><th class="r">Ausgaben</th><th class="r">Ergebnis</th></tr></thead><tbody>
      ${a.bereiche.map(x => `<tr><td>${esc(x.bereich)}</td><td class="r">${fmt(x.einnahmen)}</td><td class="r">${fmt(x.ausgaben)}</td><td class="r">${fmt(x.einnahmen - x.ausgaben)}</td></tr>`).join('')}
      ${a.bankEinnahmen || a.bankAusgaben ? `<tr><td>über die Bank</td><td class="r">${fmt(a.bankEinnahmen)}</td><td class="r">${fmt(a.bankAusgaben)}</td><td class="r">${fmt(a.bankEinnahmen - a.bankAusgaben)}</td></tr>` : ''}
      <tr class="sum"><td>Ergebnis</td><td class="r">${fmt(a.einnahmen)}</td><td class="r">${fmt(a.ausgaben)}</td><td class="r">${fmt(a.ergebnis)}</td></tr>
      ${a.neutralEin || a.neutralAus ? `<tr><td>nicht im Ergebnis (Durchlaufposten)</td><td class="r">${fmt(a.neutralEin)}</td><td class="r">${fmt(a.neutralAus)}</td><td></td></tr>` : ''}</tbody></table>
      <p class="meta">Überweisungen (Überw.) stehen im Festkassabuch, ändern den Kassabestand aber nicht. Erg. „–“ = zählt nicht zum Ergebnis.</p></section>
    ${zaehl.length ? `<section><h2>Zählprotokolle</h2><table><thead><tr><th>Bereich</th>${STUECKELUNG.map(c => `<th class="r">${c >= 100 ? c / 100 + '€' : c + 'ct'}</th>`).join('')}<th class="r">gezählt</th><th class="r">− WG</th><th class="r">Einnahme</th></tr></thead><tbody>
      ${zaehl.map(p => `<tr><td>${esc(p.bereich)}<br><small>${esc(p.text || '')}</small></td>${STUECKELUNG.map(c => `<td class="r">${p.stueckelung[c] || ''}</td>`).join('')}<td class="r">${fmt(p.gezaehlt)}</td><td class="r">${fmt(p.wechselgeldAbzug || 0)}</td><td class="r">${fmt(p.betrag)}</td></tr>`).join('')}
      </tbody></table></section>` : ''}
    ${sig(['Festkassier', 'Kassier', 'Kommandant'])}`);
}

// ── Verwaltung ───────────────────────────────────────────────────────────────

function viewVerwaltung() {
  const admin = isAdmin();
  $('#view').innerHTML = `
    ${admin ? `<div class="card"><div class="toolbar"><h2 style="margin:0;flex:1">Benutzer</h2><button class="btn primary" id="newUser">+ Benutzer anlegen</button></div>
      <p class="muted small">Rollen: <b>Admin</b> – alles · <b>Kassier</b> – importieren, kontieren, Festkassa, Jahr abschließen · <b>Festkassa</b> – nur Festkassa-Einträge bei offenen Veranstaltungen · <b>Kassaprüfer</b> – nur lesen.</p>
      <div class="tablewrap"><table class="t"><thead><tr><th>Name</th><th>E-Mail</th><th>Rolle</th><th>Status</th><th></th></tr></thead><tbody>
      ${S.users.map(u => `<tr class="${u.active === false ? 'muted' : ''}"><td>${esc(u.name)}</td><td class="small">${esc(u.email || '')}</td><td>${esc(ROLE_NAMES[u.role] || u.role)}</td>
        <td>${u.active === false ? 'deaktiviert' : 'aktiv'}</td><td class="r"><button class="btn small" data-user="${esc(u.id)}">Bearbeiten</button> <button class="btn small" data-reset="${esc(u.id)}" title="Link zum Passwort-Setzen senden">🔑</button></td></tr>`).join('')}
      </tbody></table></div></div>

    <div class="card"><div class="toolbar"><h2 style="margin:0;flex:1">Bankkonten</h2><button class="btn" id="newKonto">+ Konto</button>${!S.konten.length ? '<button class="btn primary" id="initKonten2">Standard-Konten anlegen</button>' : ''}</div>
      <div class="tablewrap"><table class="t"><thead><tr><th>Name</th><th>IBAN</th><th>Kennung</th><th></th></tr></thead><tbody>
      ${S.konten.map(k => `<tr><td>${esc(k.name)}${k.ohneKontierung ? ' <span class="chip">ohne Kontierung</span>' : ''}</td><td class="small">${esc(k.iban || '–')}</td><td class="small muted">${esc(k.id)}</td><td class="r"><button class="btn small" data-konto="${esc(k.id)}">Bearbeiten</button></td></tr>`).join('')}
      </tbody></table></div>
      <p class="muted small">Die IBAN dient zur automatischen Zuordnung beim Import, wenn sie im Dateinamen des ELBA-Exports steht.</p></div>

    <div class="card"><h2>Allgemein</h2>
      <div class="row">
        <label>Feuerwehr<input id="aFf" value="${esc(S.allgemein.ffName)}" maxlength="60"></label>
        <label>Gemeinde<input id="aGde" value="${esc(S.allgemein.gemeinde)}" maxlength="80"></label>
        <label>Ort (für „…, am“)<input id="aOrt" value="${esc(S.allgemein.ort)}" maxlength="60"></label>
        <button class="btn" id="aSave">Speichern</button>
      </div><p class="muted small">Erscheint im Kopf des Feuerwehr-Rechnungsabschlusses und der Ausdrucke.</p></div>

    <div class="card"><div class="toolbar"><h2 style="margin:0;flex:1">Kategorien (Kontenplan)</h2><button class="btn" id="newKat">+ Kategorie</button>
      ${S.kategorienGeladen ? '<button class="btn" id="addKatDefaults">Fehlende Standard-Kategorien ergänzen</button>' : '<button class="btn primary" id="saveKatDefaults">Standard-Kategorien speichern</button>'}</div>
      <p class="muted small">Die Feuerwehrkassa wird nach den <b>Voranschlagsposten (V-P)</b> des Feuerwehr-Rechnungsabschlusses für die Gemeinde kontiert; die Mannschaftskassa hat eigene Kategorien.
        Art: <b>E</b> Einnahme, <b>A</b> Ausgabe, <b>F</b> Festkassa-Geldbewegung (Ablieferung/Wechselgeld, zählt bei der Veranstaltung nicht doppelt), <b>U</b> Umbuchung zwischen eigenen Konten.</p>
      <div class="tablewrap"><table class="t"><thead><tr><th>Nr.</th><th>Name</th><th>Art</th><th>Konto</th><th>V-P Gemeinde</th><th class="r">Buchungen ${S.jahr}</th><th></th></tr></thead><tbody>
      ${[...S.kategorien].sort((a, b) => String(a.konto || 'zz').localeCompare(String(b.konto || 'zz')) || a.art.localeCompare(b.art) || String(a.nr).localeCompare(String(b.nr), 'de', { numeric: true })).map(k => {
        const n = S.buchungen.filter(b => parts(b).some(p => p.kategorie === k.id)).length;
        const vp = k.vp || [k.vpE && `+ ${k.vpE}`, k.vpA && `− ${k.vpA}`].filter(Boolean).join(' / ');
        return `<tr class="${k.inaktiv ? 'muted' : ''}"><td>${esc(k.nr)}</td><td>${esc(k.name)}${k.inaktiv ? ' (inaktiv)' : ''}</td><td>${esc(k.art)}</td>
          <td class="small">${esc(k.konto ? (kontoById(k.konto)?.name || k.konto) : 'alle')}</td><td class="small">${esc(vp || '')}</td>
          <td class="r">${n || ''}</td><td class="r"><button class="btn small" data-kat="${esc(k.id)}">Bearbeiten</button></td></tr>`;
      }).join('')}</tbody></table></div></div>` : ''}

    <div class="card"><div class="toolbar"><h2 style="margin:0;flex:1">Kontierungsregeln</h2>
      <button class="btn" id="addDefaultRegeln" title="Vorschläge für Kontoführung, Zinsen, KESt, Sponsoring, SumUp, Wechselgeld usw.">Standard-Regeln ergänzen</button>
      <button class="btn" id="newRegel">+ Regel</button></div>
      <p class="muted small">Beim Import werden neue Umsätze automatisch kontiert, wenn der Bank-Text einen Suchbegriff enthält (Groß-/Kleinschreibung egal, mehrere Begriffe mit <code>|</code> trennen). Die erste passende Regel gilt.
        Regeln lassen sich auch direkt beim Kontieren einer Buchung anlegen („Für künftige Importe merken“).</p>
      <div class="tablewrap"><table class="t"><thead><tr><th>#</th><th>Text enthält</th><th>Richtung</th><th>Konto</th><th>Kategorie</th><th></th></tr></thead><tbody>
      ${S.regeln.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.muster)}</td><td>${r.richtung === '+' ? 'nur Eingänge' : r.richtung === '-' ? 'nur Ausgänge' : 'beide'}</td>
        <td class="small">${esc(kontoById(r.konto)?.name || 'alle')}</td><td class="small">${esc(katById(r.kategorie)?.name || '?')}</td>
        <td class="r nowrap">${i ? `<button class="btn small" data-up="${i}" title="nach oben">↑</button> ` : ''}<button class="btn small" data-regel="${i}">Bearbeiten</button></td></tr>`).join('')
        || '<tr><td colspan="6" class="muted">Noch keine Regeln.</td></tr>'}</tbody></table></div></div>`;

  $('#newUser')?.addEventListener('click', () => userDialog(null));
  $$('#view [data-user]').forEach(b => b.addEventListener('click', () => userDialog(S.users.find(u => u.id === b.dataset.user))));
  $$('#view [data-reset]').forEach(b => b.addEventListener('click', async () => {
    const u = S.users.find(x => x.id === b.dataset.reset);
    if (!u?.email) return;
    try { await sendPasswordResetEmail(auth, u.email); toast(`Link an ${u.email} gesendet.`); } catch (e) { fail(e); }
  }));
  $('#initKonten2')?.addEventListener('click', initKonten);
  $('#newKonto')?.addEventListener('click', () => kontoDialog(null));
  $$('#view [data-konto]').forEach(b => b.addEventListener('click', () => kontoDialog(kontoById(b.dataset.konto))));
  $('#newKat')?.addEventListener('click', () => katDialog(null));
  $('#saveKatDefaults')?.addEventListener('click', () => saveKategorien(DEFAULT_KATEGORIEN));
  $('#addKatDefaults')?.addEventListener('click', async () => {
    const ids = new Set(S.kategorien.map(k => k.id));
    const neu = DEFAULT_KATEGORIEN.filter(k => !ids.has(k.id));
    if (!neu.length) { toast('Alle Standard-Kategorien sind schon vorhanden.'); return; }
    await saveKategorien([...S.kategorien, ...neu]).catch(fail);
    toast(`${neu.length} Kategorien ergänzt.`);
  });
  $('#aSave')?.addEventListener('click', async () => {
    const data = { ffName: $('#aFf').value.trim(), gemeinde: $('#aGde').value.trim(), ort: $('#aOrt').value.trim() };
    await setDoc(doc(db, 'config', 'allgemein'), data).catch(fail);
    toast('Gespeichert.');
  });
  $$('#view [data-kat]').forEach(b => b.addEventListener('click', () => katDialog(katById(b.dataset.kat))));
  $('#newRegel')?.addEventListener('click', () => regelDialog(null));
  $('#addDefaultRegeln')?.addEventListener('click', async () => {
    const vorhanden = new Set(S.regeln.map(r => norm(r.muster)));
    const neu = DEFAULT_REGELN.filter(r => !vorhanden.has(norm(r.muster)) && katById(r.kategorie));
    if (!neu.length) { toast('Alle Standard-Regeln sind schon vorhanden.'); return; }
    await setDoc(doc(db, 'config', 'regeln'), { list: [...S.regeln, ...neu] }).catch(fail);
    toast(`${neu.length} Regeln ergänzt.`);
  });
  $$('#view [data-regel]').forEach(b => b.addEventListener('click', () => regelDialog(+b.dataset.regel)));
  $$('#view [data-up]').forEach(b => b.addEventListener('click', () => {
    const i = +b.dataset.up, list = [...S.regeln];
    [list[i - 1], list[i]] = [list[i], list[i - 1]];
    setDoc(doc(db, 'config', 'regeln'), { list }).catch(fail);
  }));
}

function userDialog(u) {
  const neu = !u;
  const self = u?.id === S.uid;
  modal(neu ? 'Benutzer anlegen' : 'Benutzer bearbeiten', `
    <label>Name<input id="uName" value="${esc(u?.name || '')}" maxlength="60" required></label>
    <label>E-Mail<input type="email" id="uEmail" value="${esc(u?.email || '')}" ${neu ? 'required' : 'disabled'}></label>
    <label>Rolle<select id="uRole" ${self ? 'disabled' : ''}>${Object.entries(ROLE_NAMES).map(([k, n]) => `<option value="${k}" ${u?.role === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
    <label class="check" style="margin-top:10px"><input type="checkbox" id="uActive" ${u?.active === false ? '' : 'checked'} ${self ? 'disabled' : ''}> aktiv</label>
    ${neu ? '<p class="muted small">Die Person bekommt eine E-Mail mit einem Link, um ihr Passwort selbst zu setzen.</p>' : ''}`, {
    onOk: async () => {
      const data = { name: $('#uName').value.trim(), role: self ? 'admin' : $('#uRole').value, active: self ? true : $('#uActive').checked };
      if (!data.name) { toast('Name fehlt.', true); return false; }
      if (!neu) {
        await updateDoc(doc(db, 'users', u.id), data);
        logTo(null, 'benutzer', `${data.name}: ${ROLE_NAMES[data.role]}, ${data.active ? 'aktiv' : 'deaktiviert'}`);
        toast('Gespeichert.');
        return;
      }
      const email = $('#uEmail').value.trim().toLowerCase();
      if (!email) { toast('E-Mail fehlt.', true); return false; }
      const uid = await createAuthUser(email);
      await setDoc(doc(db, 'users', uid), { ...data, email, createdAt: serverTimestamp() });
      await sendPasswordResetEmail(auth, email);
      logTo(null, 'benutzer', `Angelegt: ${data.name} (${ROLE_NAMES[data.role]})`);
      toast(`${data.name} angelegt – Einladung an ${email} gesendet.`);
    },
  });
}

// Legt einen Login über eine zweite Firebase-Instanz an, damit der Admin angemeldet bleibt.
async function createAuthUser(email) {
  const secondary = initializeApp(app.options, `create-${Date.now()}`);
  try {
    const tmpPw = crypto.getRandomValues(new Uint32Array(4)).join('-') + 'Aa!';
    const secAuth = getAuth(secondary);
    if (USE_EMULATOR) connectAuthEmulator(secAuth, 'http://127.0.0.1:9099', { disableWarnings: true });
    const cred = await createUserWithEmailAndPassword(secAuth, email, tmpPw);
    await signOut(secAuth);
    return cred.user.uid;
  } catch (e) {
    if (e.code === 'auth/email-already-in-use') throw new Error('Für diese E-Mail gibt es schon einen Login. Die Benutzer-ID steht in der Firebase-Konsole unter Authentication – Profil dort manuell anlegen (siehe README).');
    throw e;
  } finally {
    await deleteApp(secondary);
  }
}

function kontoDialog(k) {
  const neu = !k;
  modal(neu ? 'Konto anlegen' : 'Konto bearbeiten', `
    <label>Name<input id="kName" value="${esc(k?.name || '')}" maxlength="60" required></label>
    <label>IBAN<input id="kIban" value="${esc(k?.iban || '')}" maxlength="40" placeholder="AT.."></label>
    <label>Reihenfolge<input type="number" id="kOrder" value="${k?.order ?? S.konten.length + 1}"></label>
    <label class="check" style="margin-top:10px"><input type="checkbox" id="kOhne" ${k?.ohneKontierung ? 'checked' : ''}> muss nicht kontiert werden (z. B. Mannschaftskassa)</label>
    ${neu ? '<label>Kennung (kurz, ohne Leerzeichen, nicht mehr änderbar)<input id="kId" maxlength="30" pattern="[a-z0-9_]+" placeholder="z. B. sparbuch"></label>' : ''}`, {
    onOk: async () => {
      const data = { name: $('#kName').value.trim(), iban: cleanIban($('#kIban').value), order: Number($('#kOrder').value) || 99, ohneKontierung: $('#kOhne').checked };
      if (!data.name) { toast('Name fehlt.', true); return false; }
      const id = neu ? norm($('#kId').value).replace(/[^a-z0-9_]/g, '') : k.id;
      if (!id) { toast('Bitte eine Kennung angeben (a–z, 0–9).', true); return false; }
      if (neu && kontoById(id)) { toast('Diese Kennung gibt es schon.', true); return false; }
      await setDoc(doc(db, 'konten', id), data, { merge: true });
      logTo(null, 'konten', `${neu ? 'Angelegt' : 'Geändert'}: ${data.name} ${data.iban}`);
    },
  });
}

async function saveKategorien(list) {
  await setDoc(doc(db, 'config', 'kategorien'), { list });
}

function katDialog(k) {
  const neu = !k;
  const used = k && S.buchungen.some(b => parts(b).some(p => p.kategorie === k.id));
  modal(neu ? 'Kategorie anlegen' : 'Kategorie bearbeiten', `
    <div class="row">
      <label style="flex:0 1 100px">Nr.<input id="cNr" value="${esc(k?.nr || '')}" maxlength="10"></label>
      <label>Name<input id="cName" value="${esc(k?.name || '')}" maxlength="80" required></label>
    </div>
    <div class="row">
      <label>Art<select id="cArt">${[['E', 'Einnahme'], ['A', 'Ausgabe'], ['F', 'Festkassa (Ablieferung/Wechselgeld)'], ['U', 'Umbuchung (neutral)']].map(([a, n]) => `<option value="${a}" ${k?.art === a ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <label>Nur bei Konto<select id="cKonto">${kontoOptions(k?.konto || '', 'alle Konten')}</select></label>
    </div>
    <div class="row">
      <label>V-P im Gemeinde-Abschluss<input id="cVp" value="${esc(k?.vp || '')}" maxlength="10" placeholder="z. B. 729"></label>
      <label>oder: Eingänge als V-P<input id="cVpE" value="${esc(k?.vpE || '')}" maxlength="10" placeholder="z. B. 829"></label>
      <label>Ausgänge als V-P<input id="cVpA" value="${esc(k?.vpA || '')}" maxlength="10" placeholder="z. B. 729"></label>
    </div>
    <p class="muted small">„V-P“ für Einnahme-/Ausgabe-Kategorien der Feuerwehrkassa (meist gleich der Nr.). Für Festkassa/Umbuchung getrennt nach Eingang und Ausgang. Leer = nicht im Gemeinde-Abschluss.</p>
    ${!neu ? `<label class="check" style="margin-top:10px"><input type="checkbox" id="cInaktiv" ${k.inaktiv ? 'checked' : ''}> inaktiv (wird bei neuen Buchungen nicht mehr angeboten)</label>` : ''}`, {
    extra: !neu ? [{
      label: 'Löschen', cls: 'danger', onClick: async () => {
        if (used) { toast('Die Kategorie wird verwendet. Bitte stattdessen auf „inaktiv“ setzen.', true); return false; }
        if (!confirm(`Kategorie „${k.name}“ löschen? (Buchungen anderer Jahre, die sie noch verwenden, erscheinen dann als unkontiert.)`)) return false;
        await saveKategorien(S.kategorien.filter(x => x.id !== k.id));
      },
    }] : [],
    onOk: async () => {
      const data = { nr: $('#cNr').value.trim(), name: $('#cName').value.trim(), art: $('#cArt').value, konto: $('#cKonto').value,
        vp: $('#cVp').value.trim(), vpE: $('#cVpE').value.trim(), vpA: $('#cVpA').value.trim() };
      if (!data.name) { toast('Name fehlt.', true); return false; }
      let list;
      if (neu) list = [...S.kategorien, { id: 'k_' + Date.now().toString(36), ...data }];
      else list = S.kategorien.map(x => x.id === k.id ? { ...x, ...data, inaktiv: $('#cInaktiv').checked } : x);
      await saveKategorien(list);
      logTo(null, 'kategorien', `${neu ? 'Neu' : 'Geändert'}: ${data.nr} ${data.name}`);
    },
  });
}

function regelDialog(idx) {
  const neu = idx === null;
  const r = neu ? { muster: '', richtung: '', konto: '', kategorie: '' } : S.regeln[idx];
  modal(neu ? 'Kontierungsregel anlegen' : 'Kontierungsregel bearbeiten', `
    <label>Bank-Text enthält (mehrere Begriffe mit | trennen)<input id="rMuster" value="${esc(r.muster)}" maxlength="200" required placeholder="z. B. Kontoführung|Entgelt"></label>
    <div class="row">
      <label>Richtung<select id="rRicht"><option value="">Ein- und Ausgänge</option><option value="+" ${r.richtung === '+' ? 'selected' : ''}>nur Eingänge</option><option value="-" ${r.richtung === '-' ? 'selected' : ''}>nur Ausgänge</option></select></label>
      <label>Konto<select id="rKonto">${kontoOptions(r.konto, 'alle Konten')}</select></label>
    </div>
    <label>Kategorie<select id="rKat">${katOptions(r.kategorie, r.richtung === '-' ? -1 : 1, r.konto)}</select></label>
    <p class="muted small" id="rTreffer"></p>`, {
    extra: !neu ? [{ label: 'Löschen', cls: 'danger', onClick: () => setDoc(doc(db, 'config', 'regeln'), { list: S.regeln.filter((_, i) => i !== idx) }) }] : [],
    onOk: async () => {
      const data = { muster: $('#rMuster').value.trim(), richtung: $('#rRicht').value, konto: $('#rKonto').value, kategorie: $('#rKat').value };
      if (!data.muster || !data.kategorie) { toast('Bitte Suchbegriff und Kategorie angeben.', true); return false; }
      const list = [...S.regeln];
      if (neu) list.push(data); else list[idx] = data;
      await setDoc(doc(db, 'config', 'regeln'), { list });
    },
    onOpen: () => {
      const upd = () => {
        const test = { muster: $('#rMuster').value, richtung: $('#rRicht').value, konto: $('#rKonto').value, kategorie: 'x' };
        const n = S.buchungen.filter(b => matchRule([test], b)).length;
        $('#rTreffer').textContent = test.muster.trim() ? `Passt auf ${n} Buchung(en) im Jahr ${S.jahr}.` : '';
      };
      ['#rMuster', '#rRicht', '#rKonto'].forEach(s => $(s).addEventListener('input', upd));
      ['#rRicht', '#rKonto'].forEach(s => $(s).addEventListener('change', () => {
        $('#rKat').innerHTML = katOptions($('#rKat').value, $('#rRicht').value === '-' ? -1 : 1, $('#rKonto').value);
      }));
      upd();
    },
  });
}

// ── Protokoll ────────────────────────────────────────────────────────────────

function viewProtokoll() {
  if (!S.log) {
    S.log = [];
    S.unsub.push(onSnapshot(query(collection(db, 'log'), orderBy('wann', 'desc'), limit(300)), snap => {
      S.log = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      render();
    }, fail));
  }
  $('#view').innerHTML = `<div class="card"><h2>Änderungsprotokoll</h2>
    <p class="muted small">Jede Änderung wird hier festgehalten und kann nicht gelöscht werden – für die Kassaprüfung. Angezeigt werden die letzten 300 Einträge.</p>
    <div class="tablewrap"><table class="t"><thead><tr><th>Zeitpunkt</th><th>Wer</th><th>Aktion</th><th>Details</th></tr></thead><tbody>
    ${S.log.map(l => `<tr><td class="nowrap small">${l.wann?.toDate ? l.wann.toDate().toLocaleString('de-AT') : '…'}</td><td class="small">${esc(l.name || userName(l.uid))}</td><td class="small">${esc(l.aktion)}</td><td class="small">${esc(l.text)}</td></tr>`).join('')
    || '<tr><td colspan="4" class="muted">Noch keine Einträge.</td></tr>'}</tbody></table></div></div>`;
}
