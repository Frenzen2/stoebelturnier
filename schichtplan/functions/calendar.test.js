import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePlan, buildIcs, dateRange, addDays } from './calendar.js';

const types = [
  { code: 'F', label: 'Frühdienst', start: '06:00', end: '14:00' },
  { code: 'S', label: 'Spätdienst', start: '14:00', end: '22:00' },
  { code: 'N', label: 'Nachtdienst', start: '22:00', end: '06:00' },
  { code: 'TD1', label: 'Tagdienst 1', placeholder: true },
];
const months = { '2026-10': { days: {
  '2026-10-01': { anna: 'F', ben: 'S', carl: 'TD1' },
  '2026-10-02': { anna: 'N', ben: 'F' },
} } };
const ics = (uid, data, extra = {}) => buildIcs({
  uid, name: uid, dates: dateRange('2026-10-01', '2026-10-02'), planFor: makePlan({ months, types, ...data }),
  types, stamp: '20261001T000000Z', ...extra,
});
const summaries = s => [...s.matchAll(/SUMMARY:(.*)/g)].map(m => m[1].trim());

test('Datumshilfen', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.deepEqual(dateRange('2026-10-30', '2026-11-01'), ['2026-10-30', '2026-10-31', '2026-11-01']);
});

test('Grundplan mit Uhrzeiten, Nachtdienst endet am Folgetag', () => {
  const s = ics('anna', {});
  assert.deepEqual(summaries(s), ['Frühdienst (F)', 'Nachtdienst (N)']);
  assert.match(s, /DTSTART:20261001T060000\r\nDTEND:20261001T140000/);
  assert.match(s, /DTSTART:20261002T220000\r\nDTEND:20261003T060000/);
  assert.match(s, /X-WR-CALNAME:Schichtplan anna/);
});

test('angenommener Tausch', () => {
  const swaps = [{ from: 'anna', to: 'ben', dateFrom: '2026-10-01', dateTo: '2026-10-01', status: 'accepted', decidedAt: 1 },
    { from: 'anna', to: 'ben', dateFrom: '2026-10-02', dateTo: '2026-10-02', status: 'pending' }];
  assert.deepEqual(summaries(ics('anna', { swaps })), ['Spätdienst (S)', 'Nachtdienst (N)']);
  assert.deepEqual(summaries(ics('ben', { swaps })), ['Frühdienst (F)', 'Frühdienst (F)']);
});

test('abgegebener Dienst wandert, Platzhalter wird ersetzt', () => {
  const covers = [{ kind: 'release', date: '2026-10-01', code: 'S', absentUid: 'ben', status: 'assigned', assignee: 'carl', assignedAt: 2 }];
  assert.deepEqual(summaries(ics('ben', { covers })), ['Frühdienst (F)']);
  assert.deepEqual(summaries(ics('carl', { covers })), ['Spätdienst (S)']);
});

test('Urlaub ersetzt Dienste, Vertretung bekommt den Dienst zusätzlich', () => {
  const covers = [{ date: '2026-10-01', code: 'F', absentUid: 'anna', status: 'assigned', assignee: 'ben', assignedAt: 1 }];
  const vacations = [{ uid: 'anna', from: '2026-10-01', to: '2026-10-01', type: 'U' }];
  const a = ics('anna', { covers }, { vacations });
  assert.deepEqual(summaries(a), ['Urlaub', 'Nachtdienst (N)']);
  assert.match(a, /DTSTART;VALUE=DATE:20261001\r\nDTEND;VALUE=DATE:20261002/);
  assert.deepEqual(summaries(ics('ben', { covers }, { vacations })), ['Spätdienst (S)', 'Frühdienst (F)', 'Frühdienst (F)']);
});

test('Platzhalter ohne Uhrzeit als Ganztagstermin, Sonderzeichen maskiert', () => {
  const s = ics('carl', {}, { name: 'Carl, Jr.' });
  assert.deepEqual(summaries(s), ['Tagdienst 1 (TD1)']);
  assert.match(s, /X-WR-CALNAME:Schichtplan Carl\\, Jr\./);
  assert.ok(s.endsWith('END:VCALENDAR\r\n'));
});
