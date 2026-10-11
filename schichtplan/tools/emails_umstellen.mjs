// E-Mail-Adressen der Mitarbeiter umstellen (z. B. von Test-Adressen auf die echten).
// Ändert die Login-E-Mail (Firebase Authentication) UND das Profil (users/{uid}.email).
// Die Benutzer-ID bleibt gleich – Plan, Urlaube, Tausche und Kalender-Abos bleiben erhalten.
//
// Aufruf in der Cloud Shell (im Ordner "schichtplan", nach "cd functions && npm install && cd .."):
//   node tools/emails_umstellen.mjs liste.csv                      → nur Vorschau, ändert nichts
//   node tools/emails_umstellen.mjs liste.csv --ausfuehren         → ändert
//   node tools/emails_umstellen.mjs liste.csv --ausfuehren --einladen
//                                                                  → ändert und schickt jedem
//                                                                    einen Link zum Passwort-Setzen
//
// liste.csv – eine Zeile pro Person: bisherige E-Mail ODER Name ; neue E-Mail
//   fra.grabner+kruiss@gmail.com;wolfgang.kruiss@firma.at
//   Thomas Waldhör;thomas.waldhoer@firma.at

import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../functions/package.json', import.meta.url));
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');

const PROJECT = process.env.GCLOUD_PROJECT || 'ragschicht';
process.env.GOOGLE_CLOUD_QUOTA_PROJECT ||= PROJECT;

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const apply = args.includes('--ausfuehren');
const invite = args.includes('--einladen');
if (!file) {
  console.log('Aufruf: node tools/emails_umstellen.mjs liste.csv [--ausfuehren] [--einladen]');
  process.exit(1);
}

const norm = s => String(s || '').trim().toLowerCase().normalize('NFC');
const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const rows = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/)
  .map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  .map(l => l.split(/[;,\t]/).map(x => x.trim()))
  .filter(r => r.length >= 2 && isEmail(r[1]));   // Kopfzeile o. Ä. überspringen

initializeApp({ projectId: PROJECT });
const auth = getAuth(), db = getFirestore();
const users = (await db.collection('users').get()).docs.map(d => ({ id: d.id, ...d.data() }));

// Web-API-Schlüssel für den Einladungs-Link (steht ohnehin öffentlich in firebase-config.js)
const apiKey = (fs.readFileSync(new URL('../firebase-config.js', import.meta.url), 'utf8').match(/apiKey:\s*"([^"]+)"/) || [])[1];

console.log(`${apply ? 'ÄNDERN' : 'VORSCHAU (nichts wird geändert)'} – Projekt ${PROJECT}, ${rows.length} Zeile(n)\n`);
let ok = 0, problems = 0;
const newEmails = new Set();
for (const [key, newEmailRaw] of rows) {
  const newEmail = norm(newEmailRaw);
  const matches = users.filter(u => norm(u.email) === norm(key) || norm(u.name) === norm(key));
  const label = `${key} → ${newEmail}`;
  if (!matches.length && users.some(u => norm(u.email) === newEmail)) {
    console.log(`= ${users.find(u => norm(u.email) === newEmail).name}: bereits umgestellt auf ${newEmail}`); continue;
  }
  if (matches.length !== 1) { console.log(`✗ ${label}: ${matches.length ? 'mehrdeutig' : 'nicht gefunden'}`); problems++; continue; }
  const u = matches[0];
  if (newEmails.has(newEmail)) { console.log(`✗ ${label}: neue E-Mail kommt doppelt in der Liste vor`); problems++; continue; }
  newEmails.add(newEmail);
  if (norm(u.email) === newEmail) { console.log(`= ${u.name}: hat bereits ${newEmail}`); continue; }
  const taken = await auth.getUserByEmail(newEmail).catch(() => null);
  if (taken && taken.uid !== u.id) { console.log(`✗ ${label}: E-Mail ist schon einem anderen Login zugeordnet`); problems++; continue; }
  if (!apply) { console.log(`✓ ${u.name}: ${u.email} → ${newEmail}`); ok++; continue; }
  try {
    await auth.updateUser(u.id, { email: newEmail, emailVerified: false });
    await db.doc(`users/${u.id}`).update({ email: newEmail });
    let note = '';
    if (invite) {
      const base = process.env.FIREBASE_AUTH_EMULATOR_HOST ? `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com` : 'https://identitytoolkit.googleapis.com';
      const r = await fetch(`${base}/v1/accounts:sendOobCode?key=${apiKey}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestType: 'PASSWORD_RESET', email: newEmail }),
      });
      note = r.ok ? ' · Einladung gesendet' : ` · Einladung FEHLGESCHLAGEN (${r.status})`;
    }
    console.log(`✓ ${u.name}: ${u.email} → ${newEmail}${note}`);
    ok++;
  } catch (e) {
    console.log(`✗ ${label}: ${e.message}`);
    if (/quota project|PERMISSION_DENIED|credential/i.test(e.message)) {
      console.log('   Tipp: einmal „gcloud auth application-default login“ und\n'
        + `   „gcloud auth application-default set-quota-project ${PROJECT}“ ausführen, dann erneut starten.`);
    }
    problems++;
  }
}
const missing = users.filter(u => u.active !== false && !rows.some(([key, n]) => [norm(key), norm(n)].includes(norm(u.email)) || norm(u.name) === norm(key)));
if (missing.length) console.log(`\nNicht in der Liste (bleiben unverändert): ${missing.map(u => `${u.name} <${u.email}>`).join(', ')}`);
console.log(`\n${ok} ${apply ? 'geändert' : 'würden geändert'}, ${problems} Problem(e).${apply ? '' : '\nZum Ausführen: dasselbe mit --ausfuehren (und optional --einladen).'}`);
process.exit(problems ? 1 : 0);
