import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseAmount, parseDate, parseCsv, detectColumns, applyMapping, importIds, matchRule,
  jahresabschluss, festkassaBuch, veranstaltungsAbrechnung, stueckelungSumme, parts, isKontiert,
  festArtVorschlag, veranstaltungImText, bankPosten,
  DEFAULT_KATEGORIEN, DEFAULT_REGELN, decodeText, ibanFromName, toCsv, splitBankText, suchbegriff,
  belegNummern, gemeindeAbschluss, hatVp, excelKontierung, zuordnenKontierung,
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
  const fw = rows.map(r => ({ ...r, konto: 'feuerwehr' }));
  const ohne = fw.filter(r => !matchRule(DEFAULT_REGELN, r));
  assert.deepEqual(ohne.map(r => r.betrag), [-73401]);
  assert.equal(matchRule(DEFAULT_REGELN, fw[0]).kategorie, 'vp_a728');   // Hilfssäckel
  assert.equal(matchRule(DEFAULT_REGELN, fw[1]).kategorie, 'vp_e753');   // Subvention
  assert.equal(matchRule(DEFAULT_REGELN, fw[3]).kategorie, 'vp_e823');   // Habenzinsen
  // Wechselgeld-Abhebung: in der Feuerwehrkassa V-P 729 und Geld für die Festkassa
  assert.equal(matchRule(DEFAULT_REGELN, fw[6]).kategorie, 'vp_a729');
  assert.equal(matchRule(DEFAULT_REGELN, fw[6]).fest, 'kassa');
  assert.equal(matchRule(DEFAULT_REGELN, fw[8]).kategorie, 'vp_e829');   // Wechselgeld retour
  assert.equal(matchRule(DEFAULT_REGELN, fw[9]).kategorie, 'vp_e829');   // Transparentwerbung
  // Mannschaftskassa wird nicht kontiert – nur Festkassa-Bewegungen werden erkannt
  assert.equal(matchRule(DEFAULT_REGELN, { ...rows[5], konto: 'mannschaft' }), null);
  const ms = matchRule(DEFAULT_REGELN, { ...rows[6], konto: 'mannschaft' });
  assert.equal(ms.kategorie, '');
  assert.equal(ms.fest, 'kassa');
  assert.ok(DEFAULT_REGELN.every(r => !r.kategorie || DEFAULT_KATEGORIEN.some(k => k.id === r.kategorie)));
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
    { konto: 'feuerwehr', betrag: 350000, kategorie: 'vp_e753' },
    { konto: 'feuerwehr', betrag: -41280, kategorie: 'vp_a670' },
    { konto: 'feuerwehr', betrag: -50000, kategorie: 'umbuchung' },
    { konto: 'mannschaft', betrag: 50000, kategorie: 'umbuchung' },
    { konto: 'mannschaft', betrag: -890 },
    { konto: 'mannschaft', betrag: 1248050, veranstaltung: 'v1', festArt: 'kassa' },
  ];
  const r = jahresabschluss({ buchungen, konten, kategorien: DEFAULT_KATEGORIEN, anfang: { feuerwehr: 100000, mannschaft: 20000 } });
  assert.equal(r.proKonto.feuerwehr.ende, 100000 + 350000 - 41280 - 50000);
  assert.equal(r.proKonto.mannschaft.ende, 20000 + 50000 - 890 + 1248050);
  assert.equal(parts(buchungen[5])[0].festArt, 'kassa');
  assert.equal(r.proKonto.feuerwehr.einnahmen, 350000);
  assert.equal(r.proKonto.feuerwehr.ausgaben, -41280);
  assert.equal(r.summeUmbuchungen.summe, 0);
  assert.equal(r.gesamt.unkontiert, 2);
  // Prüfsumme: Anfang + Einnahmen + Ausgaben + Umbuchungen = Ende
  for (const k of Object.values(r.proKonto)) assert.equal(k.anfang + k.einnahmen + k.ausgaben + k.umbuchungen, k.ende);
  assert.equal(r.ausgaben.at(-1).name, '⚠ noch nicht kontiert');
  // Mannschaftskassa ohne Kontierung: zählt nicht als unkontiert
  const r2 = jahresabschluss({ buchungen, konten: [{ id: 'feuerwehr' }, { id: 'mannschaft', ohneKontierung: true }], kategorien: DEFAULT_KATEGORIEN });
  assert.equal(r2.gesamt.unkontiert, 0);
  assert.equal(r2.ausgaben.at(-1).name, 'ohne Kontierung');
  assert.equal(isKontiert({ konto: 'mannschaft', betrag: -890 }, [{ id: 'mannschaft', ohneKontierung: true }]), true);
  assert.equal(isKontiert({ konto: 'feuerwehr', betrag: -890 }, [{ id: 'mannschaft', ohneKontierung: true }]), false);
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
  // Bank: Einzahlung des Erlöses (Festkassa ↔ Bank) und Rechnungen/Einnahmen des Festes über die Bank
  const bu = { id: 'b1', datum: '2026-06-15', text: 'Zahlungsreferenz: Erlös Zeltfest', konto: 'mannschaft' };
  const bank = [
    { festArt: 'kassa', betrag: 1248050, buchung: bu },
    { festArt: 'bank', kategorie: 'vp_a729', betrag: -421000 },
    { festArt: 'bank', betrag: 50000 },
  ];
  // Ablieferung jetzt aus der Bank statt händisch
  const ohneAbl = posten.filter(p => p.art !== 'ablieferung');
  const r = veranstaltungsAbrechnung(ohneAbl, bank);
  assert.equal(r.bestand, 70000);
  assert.equal(r.ablieferung, 1248050);
  assert.equal(r.einnahmen, 820000 + 478050 + 50000);
  assert.equal(r.ausgaben, 30000 + 421000);
  assert.equal(r.ergebnis, 1348050 - 451000);
  assert.equal(r.buch.length, 5);
  const bankZeile = r.buch.find(p => p.bank);
  assert.equal(bankZeile.art, 'ablieferung');
  assert.equal(bankZeile.text, 'Erlös Zeltfest');
  assert.equal(bankZeile.bestand, 70000);
  // Abhebung (negativ) wird Wechselgeld in die Festkassa
  assert.equal(bankPosten([{ festArt: 'kassa', betrag: -50000, buchung: { id: 'x', datum: '2026-06-11', text: 'Wechselgeld' } }])[0].art, 'wechselgeld');
  assert.equal(r.bereiche.length, 3);
});

test('CSV-Export', () => {
  assert.equal(toCsv([['a', 'b;c'], ['x"y', 1]]), '﻿a;"b;c"\r\n"x""y";1');
});

test('Belegnummern in ELBA-Reihenfolge', () => {
  const b = [
    { id: 'c', konto: 'feuerwehr', jahr: 2025, datum: '2025-03-31', zeitstempel: '31.03.2025 22:49:59:711', seq: 12 },
    { id: 'a', konto: 'feuerwehr', jahr: 2025, datum: '2025-03-12', zeitstempel: '11.03.2025 19:38:52:015', seq: 6 },
    { id: 'b', konto: 'feuerwehr', jahr: 2025, datum: '2025-03-31', zeitstempel: '31.03.2025 22:49:59:711', seq: 10 },
    { id: 'x', konto: 'mannschaft', jahr: 2025, datum: '2025-01-01', zeitstempel: '' },
  ];
  const nr = belegNummern(b);
  assert.deepEqual(['a', 'b', 'c', 'x'].map(id => nr.get(id)), [1, 2, 3, 1]);
});

test('Feuerwehr-Rechnungsabschluss (Gemeinde)', () => {
  const buchungen = [
    { konto: 'feuerwehr', betrag: 272723, kategorie: 'vp_e753' },
    { konto: 'feuerwehr', betrag: 13401, kategorie: 'vp_e823' },
    { konto: 'feuerwehr', betrag: -3535, kategorie: 'vp_a728' },
    { konto: 'feuerwehr', betrag: -658500, kategorie: 'vp_a729', veranstaltung: 'v1', festArt: 'kassa' },   // Wechselgeld
    { konto: 'feuerwehr', betrag: 658500, kategorie: 'vp_e829', veranstaltung: 'v1', festArt: 'kassa' },    // retour
    { konto: 'feuerwehr', betrag: -1000, kategorie: 'umbuchung' },     // ohne V-P
    { konto: 'feuerwehr', betrag: -2000 },                             // unkontiert
  ];
  const g = gemeindeAbschluss({ buchungen, kategorien: DEFAULT_KATEGORIEN, anfang: 2839054 });
  const e = Object.fromEntries(g.einnahmen.map(r => [r.vp, r.betrag]));
  const a = Object.fromEntries(g.ausgaben.map(r => [r.vp, r.betrag]));
  assert.equal(g.einnahmen.length, 9);   // alle Einnahme-Posten, auch mit 0
  assert.equal(g.ausgaben.length, 22);
  assert.equal(e['753'], 272723); assert.equal(e['829'], 658500); assert.equal(e['298'], 0);
  assert.equal(a['728'], 3535); assert.equal(a['729'], 658500);
  assert.equal(g.ohne.length, 2);
  assert.equal(g.ende, 2839054 + g.summeE - g.summeA);
  assert.equal(g.einnahmen[0].vp, '298'); assert.equal(g.ausgaben[0].vp, '10');
  assert.ok(hatVp(DEFAULT_KATEGORIEN, 'feuerwehr')); assert.ok(!hatVp(DEFAULT_KATEGORIEN.filter(k => k.konto !== 'feuerwehr' && !k.vp), 'mannschaft'));
});

test('Kontierung aus Excel übernehmen', () => {
  const table = [
    ['Belegnr.', 'Datum', 'Bezeichnung', 'Betrag', 'Kontierung', '', 'Fest', '', '', 298, 'Entnahme'],
    [1, new Date(2025, 1, 18), 'Lastschrift BFK', -61.6, 728, '', '', '', '', 753, 'Transfer'],
    [2, '18.02.2025', 'Lastschrift BFK Umlage', -47, '729', ''],
    [3, new Date(2025, 2, 31), 'Zinsen', 7.4, 823],
    [4, new Date(2025, 2, 31), 'Zinsen', 7.4, 823],
    [5, new Date(2025, 3, 1), 'gibt es nicht', -5, 729],
    [6, new Date(2025, 3, 2), 'unbekannt', -9, 999],
  ];
  const z = excelKontierung(table);
  assert.equal(z.length, 6);
  assert.deepEqual(z[0], { datum: '2025-02-18', betrag: -6160, kontierung: '728', text: 'Lastschrift BFK', beleg: 1 });
  const buch = [
    { id: 'u1', konto: 'feuerwehr', datum: '2025-02-18', betrag: -6160, seq: 1 },
    { id: 'u2', konto: 'feuerwehr', datum: '2025-02-18', betrag: -4700, seq: 2 },
    { id: 'z1', konto: 'feuerwehr', datum: '2025-03-31', betrag: 740, seq: 3 },
    { id: 'z2', konto: 'feuerwehr', datum: '2025-03-31', betrag: 740, seq: 4 },
    { id: 'n', konto: 'feuerwehr', datum: '2025-04-02', betrag: -900, seq: 5 },
    { id: 'm', konto: 'mannschaft', datum: '2025-04-01', betrag: -500 },
  ];
  const r = zuordnenKontierung(z, buch, DEFAULT_KATEGORIEN, 'feuerwehr');
  assert.deepEqual(r.treffer.map(t => [t.buchung.id, t.kategorie]), [['u1', 'vp_a728'], ['u2', 'vp_a729'], ['z1', 'vp_e823'], ['z2', 'vp_e823']]);
  assert.equal(r.ohneBuchung.length, 1);   // anderes Konto
  assert.equal(r.unbekannt.length, 1);     // 999
});

test('Festkassabuch-Zuordnung vorschlagen', () => {
  const ver = [{ id: 'w', name: 'Wiesnfest 2025' }, { id: 's', name: 'Sonnwendfeuer 2025' }];
  assert.equal(veranstaltungImText('Zahlungsreferenz: Wechselgeld für Wiesnfest', ver).id, 'w');
  assert.equal(veranstaltungImText('Transparentwerbung Wiesenfest 2025', ver).id, 'w');
  assert.equal(veranstaltungImText('Zahlungsreferenz: Erlös Sonnwendfeuer', ver).id, 's');
  assert.equal(veranstaltungImText('Zahlungsreferenz: Wechselgeld retour', ver), null);
  assert.equal(festArtVorschlag({ text: 'Zahlungsreferenz: Erlös Sonnwendfeuer', betrag: 296288 }), 'kassa');
  assert.equal(festArtVorschlag({ text: 'Zahlungsreferenz: Wiesnfest', betrag: 1467298 }, true), 'kassa');
  assert.equal(festArtVorschlag({ text: 'Zahlungsreferenz: 1,0 % p.a.Habenzinsen ab 2.000', betrag: 7239 }), 'bank');
  assert.equal(festArtVorschlag({ text: 'Empfänger: Bäckerei Neudorfer Verwendungszweck: Brot für Sonnwendfeuer', betrag: -23672 }), 'bank');
  assert.equal(festArtVorschlag({ text: 'Auftraggeber: Muster GmbH Zahlungsreferenz: Transparentwerbung Wiesnfest', betrag: 5000 }), 'bank');
});
