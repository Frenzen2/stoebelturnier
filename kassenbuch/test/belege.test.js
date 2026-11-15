import { test } from 'node:test';
import assert from 'node:assert/strict';
import { belegAusDateiname, belegVorschlaege } from '../lib.js';

test('Belege: Datum, Betrag und Text aus dem Dateinamen', () => {
  assert.deepEqual(belegAusDateiname('2026-04-21_Brandschutz-Attergau_RE-20260445_3474,36EUR.pdf'),
    { datum: '2026-04-21', monat: '2026-04', betrag: 347436, text: 'Brandschutz Attergau' });
  assert.deepEqual(belegAusDateiname('2026-06_Redlinger-Wuerstel-Sonnwendfeuer_235,00EUR.pdf'),
    { datum: null, monat: '2026-06', betrag: 23500, text: 'Redlinger Wuerstel Sonnwendfeuer' });
  const r = belegAusDateiname('Rechnung 12.03.2026 1.234,50 €.pdf');
  assert.equal(r.datum, '2026-03-12'); assert.equal(r.betrag, 123450);
  assert.equal(belegAusDateiname('2026-10-11_OOEVV-Zugticket-1_3x_79,50EUR.pdf').betrag, 7950);
  const x = belegAusDateiname('IMG_2041.jpg');
  assert.equal(x.datum, null); assert.equal(x.betrag, null);
});

const ziele = [
  { id: 'b1', datum: '2026-04-23', betrag: -347436, text: 'Empfänger: Brandschutz Attergau GmbH Zahlungsreferenz: 20260445' },
  { id: 'b2', datum: '2026-05-02', betrag: -6600, text: 'Lastschrift OÖ Landes-Feuerwehrverband' },
  { id: 'b5', datum: '2026-09-20', betrag: -10800, text: 'Lastschrift BFKDO Vöcklabruck' },
  { id: 'b6', datum: '2026-09-18', betrag: -10800, text: 'Getränke Haas' },
  { id: 'b3', datum: '2026-04-30', betrag: -6600, text: 'Lastschrift OÖ Landes-Feuerwehrverband' },
  { id: 'b4', datum: '2026-01-05', betrag: -2500, text: 'Kefo Beitrag', belege: [{ name: 'alt.pdf' }] },
  { id: 'p1', datum: '2026-06-24', betrag: 23500, text: 'Würstel Redlinger' },
];

test('Belege: Zuordnung über Betrag, Datum und Namen', () => {
  const b = [
    { key: 1, name: 'a.pdf', ...belegAusDateiname('2026-04-21_Brandschutz-Attergau_RE-20260445_3474,36EUR.pdf') },
    { key: 2, name: 'b.pdf', ...belegAusDateiname('2026-04-28_BFKDO-Voecklabruck_RE-202600267_66,00EUR.pdf') },
    { key: 3, name: 'c.pdf', ...belegAusDateiname('2026-04-27_BFKDO-Voecklabruck_RE-202600227_66,00EUR.pdf') },
    { key: 4, name: 'd.pdf', ...belegAusDateiname('2026-06_Redlinger-Wuerstel-Sonnwendfeuer_235,00EUR.pdf') },
    { key: 5, name: 'e.pdf', ...belegAusDateiname('2026-09-01_Irgendwer_12,34EUR.pdf') },
  ];
  const e = Object.fromEntries(belegVorschlaege(b, ziele).map(x => [x.key, x]));
  assert.equal(e[1].wahl, 'b1'); assert.equal(e[1].sicher, true);
  // zwei gleiche Beträge: beide vergeben, aber nicht doppelt und nicht „sicher“
  assert.deepEqual(new Set([e[2].wahl, e[3].wahl]), new Set(['b2', 'b3']));
  assert.equal(e[2].sicher || e[3].sicher, false);
  assert.equal(e[4].wahl, 'p1'); assert.equal(e[4].sicher, true);
  assert.equal(e[5].wahl, null); assert.equal(e[5].kandidaten.length, 0);
});

test('Belege: ausgeschriebene Umlaute im Dateinamen', () => {
  const [r] = belegVorschlaege([{ key: 1, name: 'x.pdf', ...belegAusDateiname('2026-09-14_BFKDO-Voecklabruck_108,00EUR.pdf') }], ziele);
  assert.equal(r.wahl, 'b5'); assert.equal(r.sicher, true);
});

test('Belege: Zahlung weit vor der Rechnung passt nicht, gleicher Dateiname gilt als vorhanden', () => {
  const b = [{ key: 1, name: 'alt.pdf', ...belegAusDateiname('2026-06-01_Kefo_25,00EUR.pdf') }];
  const [r] = belegVorschlaege(b, ziele);
  assert.equal(r.vorhanden, 'b4');
  assert.equal(r.wahl, null);
  const [r2] = belegVorschlaege([{ ...b[0], name: 'neu.pdf' }], ziele);
  assert.equal(r2.kandidaten.length, 0);   // b4 liegt 5 Monate vor dem Belegdatum
});
