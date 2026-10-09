import { test } from 'node:test';
import assert from 'node:assert/strict';
import { swapCreated, swapUpdated, vacationCreated, releaseCreated, coverUpdated, coverDeleted, fmtDate } from './notify.js';

const names = { anna: 'Anna', ben: 'Ben', chef: 'Chefin' };
const name = uid => names[uid];
const swap = { from: 'anna', to: 'ben', dateFrom: '2026-10-01', dateTo: '2026-10-01', fromCode: 'F', toCode: 'S', status: 'pending' };

test('Datum', () => assert.equal(fmtDate('2026-10-01'), 'Do 01.10.'));

test('neue Anfrage → angefragte Person', () => {
  const [m, ...rest] = swapCreated({ ...swap, note: 'Arzttermin' }, name);
  assert.equal(rest.length, 0);
  assert.equal(m.to, 'ben');
  assert.equal(m.title, 'Tauschanfrage von Anna');
  assert.equal(m.body, 'Do 01.10.: F ⇄ S\n„Arzttermin“');
});

test('verschiedene Tage', () => {
  const [m] = swapCreated({ ...swap, dateTo: '2026-10-07', toCode: '' }, name);
  assert.equal(m.body, 'Do 01.10. (F) gegen Mi 07.10. (frei)');
});

test('angenommen / abgelehnt → anfragende Person', () => {
  for (const status of ['accepted', 'rejected']) {
    const out = swapUpdated(swap, { ...swap, status, decidedBy: 'ben' }, name);
    assert.deepEqual(out.map(m => m.to), ['anna']);
  }
});

test('zurückgezogen → angefragte Person, Rückgängig → beide', () => {
  assert.deepEqual(swapUpdated(swap, { ...swap, status: 'cancelled', decidedBy: 'anna' }, name).map(m => m.to), ['ben']);
  assert.deepEqual(swapUpdated({ ...swap, status: 'accepted' }, { ...swap, status: 'reverted', decidedBy: 'chef' }, name).map(m => m.to), ['anna', 'ben']);
});

test('keine Nachricht ohne Statuswechsel', () => {
  assert.deepEqual(swapUpdated(swap, { ...swap }, name), []);
});

test('Urlaub → Admins, nicht an sich selbst', () => {
  const v = { uid: 'anna', from: '2026-10-05', to: '2026-10-06', type: 'U', createdBy: 'anna' };
  assert.deepEqual(vacationCreated(v, name, ['chef']).map(m => m.to), ['chef']);
  assert.equal(vacationCreated(v, name, ['chef'])[0].body, 'Mo 05.10. – Di 06.10.');
  // Admin trägt eigenen Urlaub ein → niemand
  assert.deepEqual(vacationCreated({ ...v, uid: 'chef', createdBy: 'chef' }, name, ['chef']), []);
  // Admin trägt für Anna ein → Anna
  assert.deepEqual(vacationCreated({ ...v, createdBy: 'chef' }, name, ['chef']).map(m => m.to), ['anna']);
});

test('Urlaub mit Vertretung und offenen Diensten', () => {
  const v = { uid: 'anna', from: '2026-10-15', to: '2026-10-17', type: 'U', createdBy: 'anna' };
  const covers = [
    { date: '2026-10-15', code: 'F', status: 'assigned', assignee: 'ben' },
    { date: '2026-10-16', code: 'F', status: 'open' },
    { date: '2026-10-17', code: 'S', status: 'open' },
  ];
  const freeOn = d => (d === '2026-10-16' ? ['ben', 'chef', 'anna'] : ['chef']);
  const out = vacationCreated(v, name, ['chef'], covers, freeOn);
  const byTo = to => out.filter(m => m.to === to);
  assert.equal(byTo('ben').length, 2);                     // Zuteilung + 1 offener Tag
  assert.equal(byTo('ben')[0].title, 'Du vertrittst Anna (Urlaub)');
  assert.equal(byTo('ben')[1].body, 'Fr 16.10. F · jetzt übernehmen?');
  assert.equal(byTo('chef').length, 2);                    // Admin-Info + offene Dienste
  assert.match(byTo('chef')[0].body, /2 Dienst\(e\) offen/);
  assert.equal(byTo('chef')[1].body, 'Fr 16.10. F, Sa 17.10. S · jetzt übernehmen?');
  assert.equal(byTo('anna').length, 0);                    // nie an die Person im Urlaub
});

test('Offener Dienst übernommen → Person im Urlaub', () => {
  const before = { date: '2026-10-16', code: 'F', absentUid: 'anna', status: 'open', assignee: null };
  const out = coverUpdated(before, { ...before, status: 'assigned', assignee: 'ben', assignedBy: 'ben' }, name);
  assert.deepEqual(out.map(m => [m.to, m.title]), [['anna', 'Ben übernimmt deinen Dienst']]);
  // Admin teilt zu → beide
  const out2 = coverUpdated(before, { ...before, status: 'assigned', assignee: 'ben', assignedBy: 'chef' }, name);
  assert.deepEqual(out2.map(m => m.to), ['anna', 'ben']);
});

test('Urlaub gelöscht → Vertretung entfällt', () => {
  assert.deepEqual(coverDeleted({ date: '2026-10-16', code: 'F', absentUid: 'anna', status: 'assigned', assignee: 'ben' }, name).map(m => m.to), ['ben']);
  assert.deepEqual(coverDeleted({ date: '2026-10-16', code: 'F', absentUid: 'anna', status: 'open', assignee: null }, name), []);
});

test('Admin öffnet Vertretung wieder → bisherige Vertretung', () => {
  const before = { date: '2026-10-16', code: 'F', absentUid: 'anna', status: 'assigned', assignee: 'ben' };
  assert.deepEqual(coverUpdated(before, { ...before, status: 'open', assignee: null, assignedBy: 'chef' }, name).map(m => m.to), ['ben']);
});

test('Dienst abgeben → alle anderen', () => {
  const out = releaseCreated({ absentUid: 'ben', date: '2026-10-16', code: 'S' }, name, ['anna', 'ben', 'chef']);
  assert.deepEqual(out.map(m => m.to), ['anna', 'chef']);
  assert.equal(out[0].title, 'Ben gibt einen Dienst ab');
  assert.equal(out[0].body, 'Fr 16.10. S · übernehmen?');
});

test('Abgegebener Dienst übernommen → abgebende Person', () => {
  const before = { kind: 'release', date: '2026-10-16', code: 'S', absentUid: 'ben', status: 'open', assignee: null };
  const out = coverUpdated(before, { ...before, status: 'assigned', assignee: 'anna', assignedBy: 'anna' }, name);
  assert.deepEqual(out.map(m => [m.to, m.title, m.view]), [['ben', 'Anna übernimmt deinen Dienst', 'mine']]);
});
