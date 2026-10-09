// Push-Benachrichtigungen für die Schichtplan-App.
// Deployment: siehe README.md, Abschnitt "Push-Benachrichtigungen".
import { setGlobalOptions } from 'firebase-functions/v2';
import { onDocumentCreated, onDocumentUpdated, onDocumentDeleted, onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import { defineString } from 'firebase-functions/params';
import { logger } from 'firebase-functions';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import {
  swapCreated, swapUpdated, vacationCreated, releaseCreated, coverUpdated, coverDeleted,
} from './notify.js';
import { makePlan, buildIcs, dateRange, addDays } from './calendar.js';

// Muss zum Standort der Firestore-Datenbank passen (bei der Einrichtung: europe-west3).
setGlobalOptions({ region: 'europe-west3', maxInstances: 2 });

// Adresse der App, z. B. https://name.github.io/schichtplan/ – wird beim ersten Deploy abgefragt.
const APP_URL = defineString('APP_URL', { description: 'Adresse der Schichtplan-App (https://…/)' });

initializeApp();
const db = getFirestore();

async function loadUsers() {
  const snap = await db.collection('users').get();
  return new Map(snap.docs.map(d => [d.id, d.data()]));
}

async function send(messages, users) {
  for (const m of messages) {
    if (users.get(m.to)?.active === false) continue;
    const tokenSnap = await db.collection('pushTokens').where('uid', '==', m.to).get();
    logger.info('Benachrichtigung', { uid: m.to, title: m.title, devices: tokenSnap.size });
    if (tokenSnap.empty) continue;
    const tokens = tokenSnap.docs.map(d => d.id);
    const link = `${APP_URL.value().replace(/\/?$/, '/')}#${m.view}`;
    const res = await getMessaging().sendEachForMulticast({
      tokens,
      notification: { title: m.title, body: m.body },
      webpush: {
        notification: { icon: 'icon-192.png', badge: 'icon-192.png', tag: `${m.view}-${Date.now()}` },
        fcmOptions: { link },
      },
    });
    // Abgelaufene Geräte-Tokens aufräumen
    await Promise.all(res.responses.map((r, i) => {
      const c = r.error?.code;
      if (c === 'messaging/registration-token-not-registered' || c === 'messaging/invalid-registration-token') {
        return db.collection('pushTokens').doc(tokens[i]).delete();
      }
      if (r.error) logger.warn('Push fehlgeschlagen', { uid: m.to, code: c });
      return null;
    }));
    logger.info('Push gesendet', { uid: m.to, ok: res.successCount, failed: res.failureCount });
  }
}

const nameFrom = users => uid => users.get(uid)?.name || 'Jemand';

export const onSwapCreated = onDocumentCreated('swaps/{id}', async event => {
  const users = await loadUsers();
  await send(swapCreated(event.data.data(), nameFrom(users)), users);
});

export const onSwapUpdated = onDocumentUpdated('swaps/{id}', async event => {
  const users = await loadUsers();
  await send(swapUpdated(event.data.before.data(), event.data.after.data(), nameFrom(users)), users);
});

// Wer könnte einen Dienst am Tag übernehmen? Alle Aktiven, die an dem Tag nicht abwesend sind.
async function candidatesLoader(users) {
  const vacs = (await db.collection('vacations').get()).docs.map(d => d.data());
  // Admins (Teamleitung) sind nicht im Dienstrad
  const active = [...users].filter(([, u]) => u.active !== false && u.role !== 'admin').map(([id]) => id);
  return date => active.filter(uid => !vacs.some(v => v.uid === uid && v.from <= date && v.to >= date));
}

export const onVacationCreated = onDocumentCreated('vacations/{id}', async event => {
  const users = await loadUsers();
  const admins = [...users].filter(([, u]) => u.role === 'admin' && u.active !== false).map(([id]) => id);
  // Vertretungen werden im selben Schreibvorgang wie der Urlaub angelegt
  const coverSnap = await db.collection('coverages').where('vacationId', '==', event.params.id).get();
  const covers = coverSnap.docs.map(d => d.data());
  const candidates = covers.some(c => c.status === 'open') ? await candidatesLoader(users) : () => [];
  await send(vacationCreated(event.data.data(), nameFrom(users), admins, covers, candidates), users);
});

// Dienst abgeben (Urlaubsvertretungen laufen über onVacationCreated)
export const onCoverCreated = onDocumentCreated('coverages/{id}', async event => {
  const c = event.data.data();
  if (c.kind !== 'release') return;
  const users = await loadUsers();
  const candidates = await candidatesLoader(users);
  await send(releaseCreated(c, nameFrom(users), candidates(c.date)), users);
});

export const onCoverUpdated = onDocumentUpdated('coverages/{id}', async event => {
  const users = await loadUsers();
  await send(coverUpdated(event.data.before.data(), event.data.after.data(), nameFrom(users)), users);
});

export const onCoverDeleted = onDocumentDeleted('coverages/{id}', async event => {
  const users = await loadUsers();
  await send(coverDeleted(event.data.data(), nameFrom(users)), users);
});

// ── Kalender-Abo ──────────────────────────────────────────────────────────────
// Jede Person hat einen geheimen Link (calTokens/{token} → uid). Kalender-Apps holen ihn regelmäßig ab.
// Damit nicht jeder Abruf den ganzen Plan liest: Kalender werden in calCache/{uid} zwischengespeichert
// und nur neu berechnet, wenn sich seit dem letzten Mal etwas geändert hat (meta/calendar.version)
// oder ein neuer Tag begonnen hat.

const RANGE_BACK = 14;     // Tage zurück
const RANGE_AHEAD = 120;   // Tage voraus

const viennaToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Vienna' }).format(new Date());

// Jede Änderung an Plan, Tauschen, Vertretungen, Abwesenheiten, Schichtarten oder Mitarbeitern → Version hochzählen
const bump = () => db.doc('meta/calendar').set({ version: FieldValue.increment(1) }, { merge: true });
export const calBumpPlan = onDocumentWritten('plan/{id}', bump);
export const calBumpSwaps = onDocumentWritten('swaps/{id}', bump);
export const calBumpCovers = onDocumentWritten('coverages/{id}', bump);
export const calBumpVacations = onDocumentWritten('vacations/{id}', bump);
export const calBumpConfig = onDocumentWritten('config/{id}', bump);
export const calBumpUsers = onDocumentWritten('users/{id}', bump);

async function buildAllCalendars(version, day) {
  const from = addDays(day, -RANGE_BACK), to = addDays(day, RANGE_AHEAD);
  const dates = dateRange(from, to);
  const monthKeys = [...new Set(dates.map(d => d.slice(0, 7)))];
  const [users, cfg, monthSnaps, swapA, swapB, covers, vacs] = await Promise.all([
    db.collection('users').get(),
    db.doc('config/shiftTypes').get(),
    Promise.all(monthKeys.map(k => db.doc(`plan/${k}`).get())),
    db.collection('swaps').where('dateFrom', '>=', from).get(),
    db.collection('swaps').where('dateTo', '>=', from).get(),
    db.collection('coverages').where('date', '>=', from).get(),
    db.collection('vacations').where('to', '>=', from).get(),
  ]);
  const types = cfg.exists ? cfg.data().types || [] : [];
  const months = Object.fromEntries(monthSnaps.filter(s => s.exists).map(s => [s.id, s.data()]));
  const swaps = [...new Map([...swapA.docs, ...swapB.docs].map(d => [d.id, d.data()])).values()];
  const planFor = makePlan({ months, swaps, covers: covers.docs.map(d => d.data()), types });
  const vacations = vacs.docs.map(d => d.data());
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');

  const out = {};
  const batch = db.batch();
  for (const u of users.docs) {
    const data = u.data();
    if (data.active === false) continue;
    out[u.id] = buildIcs({ uid: u.id, name: data.name, dates, planFor, vacations, types, stamp });
    batch.set(db.doc(`calCache/${u.id}`), { version, day, ics: out[u.id] });
  }
  await batch.commit();
  return out;
}

export const calendar = onRequest({ invoker: 'public', memory: '256MiB', timeoutSeconds: 30 }, async (req, res) => {
  const token = String(req.query.t || req.path.split('/').pop() || '').replace(/\.ics$/, '');
  if (!/^[a-f0-9]{40}$/.test(token)) { res.status(404).send('Nicht gefunden'); return; }
  const tok = await db.doc(`calTokens/${token}`).get();
  if (!tok.exists) { res.status(404).send('Link ungültig – bitte in der App einen neuen Kalender-Link holen.'); return; }
  const uid = tok.data().uid;
  const day = viennaToday();
  const [meta, cache] = await Promise.all([db.doc('meta/calendar').get(), db.doc(`calCache/${uid}`).get()]);
  const version = meta.data()?.version ?? 0;
  let ics;
  if (cache.exists && cache.data().version === version && cache.data().day === day) ics = cache.data().ics;
  else ics = (await buildAllCalendars(version, day))[uid];
  if (!ics) { res.status(404).send('Kein aktives Profil.'); return; }
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', 'inline; filename="schichtplan.ics"');
  res.set('Cache-Control', 'private, max-age=600');
  res.send(ics);
});
