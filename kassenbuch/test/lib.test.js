import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseAmount, parseDate, parseCsv, detectColumns, applyMapping, importIds, matchRule,
  jahresabschluss, festkassaBuch, veranstaltungsAbrechnung, stueckelungSumme, parts, isKontiert,
  DEFAULT_KATEGORIEN, DEFAULT_REGELN, decodeText, ibanFromName, toCsv, splitBankText, suchbegriff,
} from '../lib.js';

test('Beträge', () => {
  assert.equal(parseAmount('+3.500,00'), 350000);
  assert.equal(parseAmount('-412,80'), -41280);
  assert.equal(parseAmount('−8,90'), -890);
  assert.equal(parseAmount('12.50'), 1250);
  assert.equal(parseAmount('1.234'), 123400);
  assert.equal(parseAmount('1,234.56'), 123456);
  assert.equal(parseAmount('12,5'), 1250);
  assert.equal(parseAmount('12,50-'), -1250);
  assert.equal(parseAmount('12,50 EUR'), 1250);
  assert.equal(parseAmount('0,01'), 1);
  assert.equal(parseAmount('abc'), null);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount(12.345), 1235);
});

test('Datum', () => {
  assert.equal(parseDate('02.01.2026'), '2026-01-02');
  assert.equal(parseDate('2.1.26'), '2026-01-02');
  assert.equal(parseDate('2026-12-31'), '2026-12-31');
  assert.equal(parseDate('31.02.2026'), null);
  assert.equal(parseDate('02.01.2026 07:12:44:301'), '2026-01-02');
});

test('ELBA-CSV ohne Kopfzeile wird erkannt (echtes Format)', () => {
  const table = parseCsv(decodeText(readFileSync(new URL('../beispiel-raika.csv', import.meta.url))));
  const det = detectColumns(table);
  assert.equal(det.header, false);
  assert.deepEqual(det.mapping, ['datum', 'text', 'valuta', 'betrag', 'waehrung', 'zeitstempel']);
  const { rows, errors } = applyMapping(table, det.mapping, det.header);
  assert.deepEqual(errors, []);
  assert.equal(rows.length, 10);
  assert.equal(rows[0].betrag, -6160);
  assert.equal(rows[1].betrag, 272723);          // positiver Betrag ohne „+“
  assert.equal(rows[3].valuta, '2026-04-01');
  assert.match(rows[0].text, /^Zahlungsempfänger: Bezirksfeuerwehrkommando/);
  // Standard-Regeln kontieren alle Beispielzeilen außer der Einzelrechnung
  const ohne = rows.filter(r => !matchRule(DEFAULT_REGELN, r));
  assert.deepEqual(ohne.map(r => r.betrag), [-73401]);
  assert.equal(matchRule(DEFAULT_REGELN, rows[6]).kategorie, 'festkassa');
  assert.equal(matchRule(DEFAULT_REGELN, rows[9]).kategorie, 'e_sponsoring');
  assert.ok(DEFAULT_REGELN.every(r => DEFAULT_KATEGORIEN.some(k => k.id === r.kategorie)));
});

test('Bank-Text zerlegen', () => {
  const t = 'Online Banking vom 17.05 um 10:48 Empfänger: Brandschutz Muster Zahlungsreferenz: Rechnung Nr 2025 IBAN Empfänger: AT001234000000000005 BIC Empfänger: MUSTAT2L523 Empfänger: Hauptstraße 3, 4881 Musterort';
  assert.deepEqual(splitBankText(t), { partner: 'Brandschutz Muster', zweck: 'Rechnung Nr 2025', iban: 'AT001234000000000005' });
  assert.deepEqual(splitBankText('Zahlungsreferenz: Kontoführung'), { partner: '', zweck: 'Kontoführung', iban: '' });
  assert.equal(splitBankText('Bareinzahlung Zeltfest').zweck, 'Bareinzahlung Zeltfest');
  assert.equal(suchbegriff(t), 'Brandschutz Muster');
  assert.equal(suchbegriff('Zahlungsreferenz: 1,5 % p.a.Habenzinsen ab 2.000'), 'Habenzinsen');
});

test('CSV mit Kopfzeile, Windows-1252 und Anführungszeichen', () => {
  const csv = 'Buchungsdatum;Valutadatum;Auftraggeber/Empfänger;Verwendungszweck;Betrag;Währung\r\n'
    + '05.03.2026;05.03.2026;"Muster; Max";Spende Florianifeier;50,00;EUR\r\n'
    + '06.03.2026;06.03.2026;Lagerhaus;Diesel;-80,20;EUR\r\n';
  const buf = Uint8Array.from([...csv].map(c => c === 'ä' ? 0xe4 : c.charCodeAt(0)));
  const text = decodeText(buf);
  assert.match(text, /Währung/);
  const table = parseCsv(text);
  const det = detectColumns(table);
  assert.equal(det.header, true);
  assert.deepEqual(det.mapping, ['datum', 'valuta', 'partner', 'zweck', 'betrag', 'waehrung']);
  const { rows } = applyMapping(table, det.mapping, true);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].text, 'Muster; Max · Spende Florianifeier');
  assert.equal(rows[1].betrag, -8020);
});

test('Import-IDs: stabil und gleiche Zeilen bleiben getrennt', async () => {
  const r = { datum: '2026-01-01', valuta: '2026-01-01', betrag: 1000, text: 'Spende', zeitstempel: '' };
  const a = await importIds('feuerwehr', [r, r, { ...r, betrag: 2000 }]);
  const b = await importIds('feuerwehr', [r, r, { ...r, betrag: 2000 }]);
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, 3);
  assert.notEqual((await importIds('mannschaft', [r]))[0], a[0]);
  assert.match(a[0], /^feuerwehr-[0-9a-f]{24}$/);
});

test('IBAN aus Dateiname', () => {
  assert.equal(ibanFromName('ELBA_AT12 3456 7890 1234 5678_umsaetze.csv'), 'AT123456789012345678');
  assert.equal(ibanFromName('umsaetze.csv'), null);
});

test('Kontierungsregeln', () => {
  const regeln = [
    { muster: 'kontoführung|entgelt', kategorie: 'a_bank', richtung: '-' },
    { muster: 'Getränke Haas', kategorie: 'a_fest' },
    { muster: 'gemeinde', kategorie: 'e_subv_gem', richtung: '+' },
  ];
  assert.equal(matchRule(regeln, { text: 'Kontoführung Entgelt 01', betrag: -890 }).kategorie, 'a_bank');
  assert.equal(matchRule(regeln, { text: 'GETRÄNKE HAAS GmbH', betrag: -100 }).kategorie, 'a_fest');
  assert.equal(matchRule(regeln, { text: 'Gemeinde Pichl Rückforderung', betrag: -100 }), null);
});

test('Aufteilung', () => {
  const b = { betrag: -10000, splits: [{ kategorie: 'a_fest', betrag: -6000 }, { kategorie: 'a_kamerad', betrag: -3000 }] };
  const p = parts(b);
  assert.equal(p.length, 3);
  assert.equal(p[2].betrag, -1000);
  assert.equal(isKontiert(b), false);
  b.splits.push({ kategorie: 'a_sonst', betrag: -1000 });
  assert.equal(isKontiert(b), true);
});

test('Jahresabschluss', () => {
  const konten = [{ id: 'feuerwehr' }, { id: 'mannschaft' }];
  const buchungen = [
    { konto: 'feuerwehr', betrag: 350000, kategorie: 'e_subv_gem' },
    { konto: 'feuerwehr', betrag: -41280, kategorie: 'a_versicherung' },
    { konto: 'feuerwehr', betrag: -50000, kategorie: 'umbuchung' },
    { konto: 'mannschaft', betrag: 50000, kategorie: 'umbuchung' },
    { konto: 'mannschaft', betrag: -890 },
    { konto: 'mannschaft', betrag: 1248050, kategorie: 'festkassa', veranstaltung: 'v1' },
  ];
  const r = jahresabschluss({ buchungen, konten, kategorien: DEFAULT_KATEGORIEN, anfang: { feuerwehr: 100000, mannschaft: 20000 } });
  assert.equal(r.proKonto.feuerwehr.ende, 100000 + 350000 - 41280 - 50000);
  assert.equal(r.proKonto.mannschaft.ende, 20000 + 50000 - 890 + 1248050);
  assert.equal(r.proKonto.feuerwehr.einnahmen, 350000);
  assert.equal(r.proKonto.feuerwehr.ausgaben, -41280);
  assert.equal(r.summeUmbuchungen.summe, 0);
  assert.equal(r.gesamt.unkontiert, 1);
  // Prüfsumme: Anfang + Einnahmen + Ausgaben + Umbuchungen = Ende
  for (const k of Object.values(r.proKonto)) assert.equal(k.anfang + k.einnahmen + k.ausgaben + k.umbuchungen, k.ende);
  assert.equal(r.ausgaben.at(-1).name, '⚠ noch nicht kontiert');
});

test('Festkassa: Bestand, Zählprotokoll, Abrechnung', () => {
  assert.equal(stueckelungSumme({ 5000: 3, 200: 4, 10: 7 }), 15870);
  const posten = [
    { art: 'wechselgeld', betrag: 50000, datum: '2026-06-12' },
    { art: 'einnahme', betrag: 820000, datum: '2026-06-13', bereich: 'Schank' },
    { art: 'einnahme', betrag: 478050, datum: '2026-06-13', bereich: 'Küche' },
    { art: 'ausgabe', betrag: 30000, datum: '2026-06-13', bereich: 'Musik' },
    { art: 'ablieferung', betrag: 1248050, datum: '2026-06-14' },
  ];
  const buch = festkassaBuch(posten);
  assert.equal(buch.at(-1).bestand, 70000);
  const bank = [
    { kategorie: 'festkassa', betrag: 1248050 },
    { kategorie: 'a_fest', betrag: -421000 },
    { kategorie: 'e_fest', betrag: 50000 },
  ];
  const r = veranstaltungsAbrechnung(posten, bank, DEFAULT_KATEGORIEN);
  assert.equal(r.bestand, 70000);
  assert.equal(r.einnahmen, 820000 + 478050 + 50000);
  assert.equal(r.ausgaben, 30000 + 421000);
  assert.equal(r.ergebnis, 1348050 - 451000);
  assert.equal(r.bereiche.length, 3);
});

test('CSV-Export', () => {
  assert.equal(toCsv([['a', 'b;c'], ['x"y', 1]]), '﻿a;"b;c"\r\n"x""y";1');
});
