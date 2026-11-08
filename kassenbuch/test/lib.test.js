import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseAmount, parseDate, parseCsv, detectColumns, applyMapping, importIds, matchRule,
  jahresabschluss, festkassaBuch, veranstaltungsAbrechnung, stueckelungSumme, parts, isKontiert,
  festArtVorschlag, veranstaltungImText, bankPosten,
  DEFAULT_KATEGORIEN, DEFAULT_REGELN, decodeText, ibanFromName, toCsv, splitBankText, suchbegriff,
  belegNummern, gemeindeAbschluss, hatVp, excelKontierung, zuordnenKontierung, postenInfo,
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
  // wie im Excel: zählt nur Bank (Einzahlung − Wechselgeld) und Überweisung, bar in/aus Geldtasche nicht
  assert.equal(r.einnahmen, 1248050 + 50000);
  assert.equal(r.ausgaben, 50000 + 421000);
  assert.equal(r.ergebnis, 827050);
  assert.equal(r.barEinnahmen, 820000 + 478050);
  assert.equal(r.buch.length, 7);   // 4 eigene Posten + Ablieferung + 2 Bankzeilen (Rechnung, Einnahme)
  const bankAusgabe = r.buch.find(p => p.bank && p.art === 'ausgabe');
  assert.equal(bankAusgabe.betragVz, -421000);
  assert.equal(bankAusgabe.wirkung, 0);          // ändert den Kassabestand nicht
  assert.equal(bankAusgabe.ergebnis, true);
  assert.equal(r.bereiche.length, 0);           // keine zählenden Überweisungs-Positionen
  assert.equal(r.barBereiche.length, 3);        // Bar-Umsatz je Bereich nur zur Information
  const bankZeile = r.buch.find(p => p.bank && p.text === 'Erlös Zeltfest');
  assert.equal(bankZeile.art, 'ablieferung');
  assert.equal(bankZeile.text, 'Erlös Zeltfest');
  assert.equal(bankZeile.bestand, 70000);
  assert.equal(bankZeile.betragErg, 1248050);   // Bankeinzahlung: wie im Excel als Einnahme
  assert.equal(bankZeile.betragVz, -1248050);   // … aus Sicht der Geldtasche ein Ausgang
  assert.equal(r.buch.find(p => p.art === 'wechselgeld').betragErg, -50000);   // Wechselgeld: Ausgabe
  // Abhebung (negativ) wird Wechselgeld in die Festkassa
  assert.equal(bankPosten([{ festArt: 'kassa', betrag: -50000, buchung: { id: 'x', datum: '2026-06-11', text: 'Wechselgeld' } }])[0].art, 'wechselgeld');
  assert.deepEqual(r.buch.map(p => p.artName).sort(), ['Bank', 'Bank', 'bar aus Geldtasche', 'bar in Geldtasche', 'bar in Geldtasche', 'Überweisung', 'Überweisung']);
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

test('Festkassa: eigene Positionen bar/Überweisung, mit und ohne Ergebnis', () => {
  const posten = [
    { art: 'wechselgeld', betrag: 50000, datum: '2026-06-12' },
    { art: 'einnahme', betrag: 300000, datum: '2026-06-13', bereich: 'Schank' },                                      // bar, Ergebnis
    { art: 'ausgabe', betrag: 20000, datum: '2026-06-13', bereich: 'Musik' },                                         // bar, Ergebnis
    { art: 'ausgabe', betrag: 421000, datum: '2026-06-20', bereich: 'Getränke', zahlweg: 'ueberweisung' },           // Überweisung, Ergebnis
    { art: 'einnahme', betrag: 10000, datum: '2026-06-13', bereich: 'Pfand', ergebnis: false },                      // bar, Durchlauf
    { art: 'ausgabe', betrag: 10000, datum: '2026-06-14', bereich: 'Pfand', ergebnis: false },                       // bar, Durchlauf
    { art: 'einnahme', betrag: 5000, datum: '2026-06-15', zahlweg: 'ueberweisung', ergebnis: false },                // Überweisung, Durchlauf
  ];
  const r = veranstaltungsAbrechnung(posten, []);
  assert.equal(r.bestand, 50000 + 300000 - 20000 + 10000 - 10000);          // Überweisungen ändern den Bestand nicht
  assert.equal(r.barEinnahmen, 310000);        // bar in Geldtasche: nur Information
  assert.equal(r.barAusgaben, 30000);
  assert.equal(r.ueberwAusgaben, 421000);
  assert.equal(r.neutralEin, 5000);             // Überweisung mit „zählt: nein“
  assert.equal(r.neutralAus, 0);
  assert.equal(r.einnahmen, 0);
  assert.equal(r.ausgaben, 50000 + 421000);     // Wechselgeld (Bank) + Überweisung
  assert.equal(r.ergebnis, -471000);
  assert.deepEqual(r.bereiche.map(b => b.bereich), ['Getränke']);
  assert.deepEqual(r.barBereiche.map(b => b.bereich), ['Musik', 'Pfand', 'Schank']);
  const ue = r.buch.find(p => p.bereich === 'Getränke');
  assert.equal(ue.betragVz, -421000);
  assert.equal(ue.wirkung, 0);
  assert.deepEqual(postenInfo({ art: 'wechselgeld' }), { fluss: false, zahlweg: 'bank', ergebnis: true, kassa: true, artName: 'Bank' });
  assert.equal(postenInfo({ art: 'einnahme', ergebnis: true }).ergebnis, false);   // bar zählt nie, auch alte Daten
  assert.equal(postenInfo({ art: 'ausgabe', zahlweg: 'ueberweisung' }).artName, 'Überweisung');
  // Überweisung im Festkassabuch UND gleiche Bankbuchung als Ausgabe zugeordnet → Hinweis auf Doppelerfassung
  const d = veranstaltungsAbrechnung(posten, [{ festArt: 'bank', betrag: -421000 }]);
  assert.equal(d.doppelt.length, 1);
  // gleicher Tag ohne Uhrzeit: Reihenfolge der Erfassung
  const b2 = festkassaBuch([{ art: 'ausgabe', betrag: 1, datum: '2026-06-14', text: 'zurück', erfasstAm: 2000 }, { art: 'einnahme', betrag: 1, datum: '2026-06-14', text: 'Pfand', erfasstAm: 1000 }]);
  assert.deepEqual(b2.map(p => p.text), ['Pfand', 'zurück']);
});

test('Bisheriges Festkassabuch (Excel) übernehmen', async () => {
  const { festkassaExcel } = await import('../lib.js');
  const t = [
    ['', 'Musterfest 2026', '', '', '', '', 'Zählt'],
    ['Datum', 'Text', 'Einnahmen', 'Ausgaben', '', 'Betrag', 'JA/NEIN'],
    [new Date(2026, 8, 10), 'Wechselgeld', '', 1000, 'Bank', -1000, 1],
    [new Date(2026, 8, 23), 'Bank', 1000, '', 'Bank', 1000, 1],
    ['', 'Bank Einzahlung', 5000, '', 'Überweisung', 5000, 1],
    ['', 'Bankomat Kassa', 300.5, '', 'Überweisung', 300.5, 1],
    ['', 'Firma A', 100, '', 'Überweisung', 100, 1],
    ['', 'Firma B', 50, '', 'bar in Geldtasche', 0, 0],
    ['', 'Firma C', 0, '', 'Überweisung', 0, 1],
    ['', 'Summe Transparente', 150, '', '', 0, 0],
    ['', 'Musik', '', 400, 'bar aus Geldtasche', 0, 0],
    ['', 'Getränke', '', 1200, 'Überweisung', -1200, 1],
    ['', 'Klowagen / Zeche', 80, 60, 'Überweisung', 20, 1],
    ['', 'Ergebnis', '', '', '', 4220.5, ''],
    ['', '', 6530.5, 2660, '', '', ''],
  ];
  const { zeilen } = festkassaExcel(t, { datumStandard: '2026-09-21' });
  const ok = zeilen.filter(z => !z.skip);
  assert.deepEqual(zeilen.filter(z => z.skip).map(z => z.text), ['Wechselgeld', 'Bank', 'Bank Einzahlung']);
  assert.deepEqual(ok.map(z => [z.text, z.art, z.zahlweg, z.betrag, z.bereich]), [
    ['Bankomat Kassa', 'einnahme', 'ueberweisung', 30050, ''],
    ['Firma A', 'einnahme', 'ueberweisung', 10000, 'Transparente'],
    ['Firma B', 'einnahme', 'bar', 5000, 'Transparente'],
    ['Musik', 'ausgabe', 'bar', 40000, ''],
    ['Getränke', 'ausgabe', 'ueberweisung', 120000, ''],
    ['Klowagen / Zeche', 'einnahme', 'ueberweisung', 8000, ''],
    ['Klowagen / Zeche', 'ausgabe', 'ueberweisung', 6000, ''],
  ]);
  assert.equal(ok[0].datum, '2026-09-21');   // ohne eigenes Datum: Datum der Veranstaltung
  // Mit Bankbuchungen (Wechselgeld ab/zurück, Bareinzahlung) und errechnetem Barumsatz = Ergebnis wie im Excel
  const bank = [
    { festArt: 'kassa', betrag: -100000, buchung: { id: 'w', datum: '2026-09-10', text: 'Wechselgeld' } },
    { festArt: 'kassa', betrag: 100000, buchung: { id: 'r', datum: '2026-09-23', text: 'Wechselgeld retour' } },
    { festArt: 'kassa', betrag: 500000, buchung: { id: 'e', datum: '2026-09-23', text: 'Einzahlung' } },
  ];
  const posten = ok.map((z, i) => ({ ...z, nr: i + 1 }));
  let a = veranstaltungsAbrechnung(posten, bank);
  posten.push({ art: 'einnahme', zahlweg: 'bar', ergebnis: true, betrag: -a.bestand, datum: '2026-09-21' });
  a = veranstaltungsAbrechnung(posten, bank);
  assert.equal(a.bestand, 0);
  assert.equal(a.ergebnis, 422050);
});

test('Abgleich Festkassabuch ↔ Bank', async () => {
  const { bankAbgleich } = await import('../lib.js');
  const B = (id, konto, datum, betrag, text, extra = {}) => ({ id, konto, datum, betrag, text, ...extra });
  const buchungen = [
    B('g', 'MS', '2026-09-29', -173226, 'Empfänger: Max Muster Zahlungsreferenz: gschäftl fürs fest'),
    B('s1', 'FW', '2026-09-22', 138851, 'Auftraggeber: Sumup Limited Verwendungszweck: PAYOUT'),
    B('s2', 'FW', '2026-09-18', 493, 'Auftraggeber: Sumup Limited Verwendungszweck: PAYOUT'),
    B('b1', 'MS', '2026-08-04', -27660, 'Empfänger: A Zahlungsreferenz: 12xBacadi'),
    B('b2', 'MS', '2026-08-04', -15180, 'Empfänger: B Zahlungsreferenz: 7xBacardi'),
    B('u1', 'MS', '2026-10-09', -33523, 'Empfänger: Brau Union Österreich AG Zahlungsreferenz: Rechnung 1'),
    B('u2', 'MS', '2026-10-17', -17316, 'Empfänger: Brau Union Österreich AG Zahlungsreferenz: Rechnung 2'),
    B('st', 'MS', '2026-10-23', -65350, 'Empfänger: Max Muster Zahlungsreferenz: Starzinger fürs Fest'),
    B('e1', 'FW', '2026-09-23', 10000, 'Auftraggeber: EW-Bau Zahlungsreferenz: Transparent'),
    B('e2', 'FW', '2026-09-24', 10000, 'Auftraggeber: Muster Immo GmbH Zahlungsreferenz: Werbung'),
    B('x', 'MS', '2026-12-18', -15000, 'Empfänger: Hans Zahlungsreferenz: Schnaps fürs Wiesenfest 2026'),
    B('w', 'MS', '2026-09-23', 1467298, 'Zahlungsreferenz: Wiesnfest', { veranstaltung: 'v', festArt: 'kassa' }),
    B('alt', 'MS', '2026-03-01', -5000, 'Zahlungsreferenz: Wiesnfest Vorbereitung'),   // außerhalb des Zeitfensters
  ];
  const P = (text, art, betrag) => ({ id: text, text, art, betrag, zahlweg: 'ueberweisung', ergebnis: true, datum: '2026-09-21' });
  const posten = [
    P('Gschäftl', 'ausgabe', 173226), P('Bankomat Kassa', 'einnahme', 139344), P('Barcadi / Gin', 'ausgabe', 42840),
    P('Brau Union', 'ausgabe', 50839), P('Starzinger', 'ausgabe', 65300), P('Muster Immo', 'einnahme', 10000),
    P('EW-BAU Gmbh', 'einnahme', 10000), P('Elektro Neu', 'einnahme', 10000),
    { ...P('Musik', 'ausgabe', 140000), zahlweg: 'bar' },   // bar: nicht im Abgleich
  ];
  const ab = bankAbgleich(posten, buchungen, { id: 'v', name: 'Wiesnfest 2026', von: '2026-09-20', bis: '2026-09-21' });
  const st = Object.fromEntries(ab.zeilen.map(z => [z.posten.text, [z.status, z.buchungen.map(b => b.id).sort().join(','), z.sicher ?? null]]));
  assert.deepEqual(st['Gschäftl'], ['ok', 'g', true]);
  assert.deepEqual(st['Bankomat Kassa'].slice(0, 2), ['summe', 's1,s2']);
  assert.deepEqual(st['Barcadi / Gin'].slice(0, 2), ['summe', 'b1,b2']);
  assert.deepEqual(st['Brau Union'].slice(0, 2), ['summe', 'u1,u2']);
  assert.deepEqual(st['Starzinger'].slice(0, 2), ['diff', 'st']);
  assert.deepEqual(st['Muster Immo'], ['ok', 'e2', true]);
  assert.deepEqual(st['EW-BAU Gmbh'], ['ok', 'e1', true]);
  assert.equal(st['Elektro Neu'][0], 'fehlt');
  assert.equal(ab.zeilen.find(z => z.posten.text === 'Starzinger').differenz, 50);
  assert.equal(ab.zeilen.length, 8);
  assert.deepEqual(ab.offen.map(b => b.id), ['x']);
});

test('Veranstaltung über weitere Suchbegriffe erkennen', async () => {
  const { festBegriffe } = await import('../lib.js');
  const ver = [
    { id: 'w', name: 'Wiesnfest 2025', suchbegriffe: 'Wiesn, Oktoberfest; Frühschoppen' },
    { id: 's', name: 'Sonnwendfeuer 2025', suchbegriffe: 'Sonnwend | Johannisfeuer' },
    { id: 'b', name: 'Feuerwehrball 2025', suchbegriffe: 'Ball' },
  ];
  assert.deepEqual(festBegriffe(ver[0]), ['wiesnfest', 'wiesn', 'oktoberfest', 'fruhschoppen']);
  assert.equal(veranstaltungImText('Zahlungsreferenz: Wechselgeld Frühschoppen', ver).id, 'w');
  assert.equal(veranstaltungImText('Erlös Oktoberfest', ver).id, 'w');
  assert.equal(veranstaltungImText('Wechselgeld Sonnwend', ver).id, 's');
  assert.equal(veranstaltungImText('Einzahlung Ball', ver).id, 'b');
  assert.equal(veranstaltungImText('Ballonfahrt', ver), null);              // kurze Begriffe nur als ganzes Wort
  assert.equal(veranstaltungImText('Feuerwehrball Kassa', ver).id, 'b');   // Wort aus dem Namen
  // Wiesn (5) und Sonnwendfeuer (13): der genauere, längere Begriff gewinnt
  assert.equal(veranstaltungImText('Wiesn und Sonnwendfeuer', ver).id, 's');
  // Gleichstand → keine Zuordnung
  assert.equal(veranstaltungImText('Wiesn Ballx', [{ id: 'a', name: 'Fest A', suchbegriffe: 'wiesn' }, { id: 'c', name: 'Fest C', suchbegriffe: 'wiesn' }]), null);
});

test('Sponsoring: Festkassabuch, Zahlungen zuordnen, Vorlagen', async () => {
  const { sponsorPosten, sponsorZahlungen, sponsorKandidaten, fuelleVorlage, rechnungsNummer, bankAbgleich } = await import('../lib.js');
  const E = (id, name, betrag, extra = {}) => ({ id, name, betrag, zahlweg: 'ueberweisung', status: 'offen', ...extra });
  const eintraege = [
    E('a', 'Muster Bau GmbH', 10000, { rechnungsNr: '2026-001' }),
    E('b', 'Tischlerei Holz', 5000, { rechnungsNr: '2026-002' }),
    E('c', 'Autohaus Blitz', 5000, { rechnungsNr: '2026-003' }),
    E('d', 'Bäckerei Korn', 3000, { zahlweg: 'bar', status: 'bezahlt', bezahltAm: '2026-09-20' }),
    E('e', 'Ohne Zahlung', 8000, { rechnungsNr: '2026-005' }),
  ];
  const B = (id, betrag, text, extra = {}) => ({ id, konto: 'feuerwehr', datum: '2026-10-01', betrag, text, ...extra });
  const buchungen = [
    B('x1', 10000, 'Auftraggeber: Muster Bau Zahlungsreferenz: RE 2026 001'),          // Nummer im Text
    B('x2', 5000, 'Auftraggeber: Tischlerei Holz e.U. Zahlungsreferenz: Transparent'),  // Name + Betrag
    B('x3', 5000, 'Auftraggeber: Firma Q Zahlungsreferenz: Transparentwerbung'),       // nur Betrag (unsicher)
    B('x4', 7500, 'Auftraggeber: Neu GmbH Zahlungsreferenz: Sponsoring Fest'),         // neuer Sponsor
    B('x5', 9999, 'Zahlungsreferenz: Habenzinsen'),
  ];
  const z = sponsorZahlungen(eintraege, buchungen);
  assert.deepEqual(z.map(m => [m.eintrag.id, m.buchung.id, m.sicher, m.grund]), [
    ['a', 'x1', true, 'Rechnungsnummer'], ['b', 'x2', true, 'Betrag und Name'], ['c', 'x3', false, 'nur Betrag'],
  ]);
  // gleicher Name, anderer Betrag → nur Vorschlag
  const z2 = sponsorZahlungen([E('g', 'Fliesen Gaborek', 10000)], [B('y', 30000, 'Auftraggeber: Andreas und Martina Gaborek Zahlungsreferenz: Transparentwerbung')]);
  assert.deepEqual(z2.map(m => [m.buchung.id, m.sicher, m.grund]), [['y', false, 'Name passt, anderer Betrag']]);
  const vergeben = new Set(z.map(m => m.buchung.id));
  assert.deepEqual(sponsorKandidaten(buchungen, vergeben).map(k => [k.buchung.id, k.name]), [['x4', 'Neu GmbH']]);
  // nur bezahlte erscheinen im Festkassabuch
  const bez = eintraege.map(e => z.find(m => m.eintrag.id === e.id) ? { ...e, status: 'bezahlt', buchungId: z.find(m => m.eintrag.id === e.id).buchung.id, bezahltAm: '2026-10-01' } : e);
  const sp = sponsorPosten(bez);
  assert.deepEqual(sp.map(p => [p.text, p.zahlweg, p.betrag, p.bereich]), [
    ['Muster Bau GmbH', 'ueberweisung', 10000, 'Transparente'], ['Tischlerei Holz', 'ueberweisung', 5000, 'Transparente'],
    ['Autohaus Blitz', 'ueberweisung', 5000, 'Transparente'], ['Bäckerei Korn', 'bar', 3000, 'Transparente'],
  ]);
  const a = veranstaltungsAbrechnung(sp, []);
  assert.equal(a.einnahmen, 20000);   // bar bezahlter Sponsor zählt erst mit der Bankeinzahlung
  assert.equal(a.bestand, 3000);   // nur die Barzahlung ändert den Kassabestand
  // Bankabgleich nutzt die feste Verknüpfung
  const ab = bankAbgleich(sp, buchungen, { id: 'v', name: 'Fest 2026', von: '2026-09-19', bis: '2026-09-20' });
  assert.deepEqual(ab.zeilen.filter(z => z.posten.sponsor).map(z => [z.posten.text, z.buchungen[0].id, z.sicher]),
    [['Muster Bau GmbH', 'x1', true], ['Tischlerei Holz', 'x2', true], ['Autohaus Blitz', 'x3', true]]);
  assert.equal(fuelleVorlage('Danke {name} für {betrag} beim {fest} {x}', { name: 'A', betrag: '50,00 €', fest: 'Wiesnfest' }), 'Danke A für 50,00 € beim Wiesnfest {x}');
  assert.equal(rechnungsNummer(2026, 7), '2026-007');
});

test('Sponsorenliste aus CSV/Excel', async () => {
  const { sponsorTabelle } = await import('../lib.js');
  // ohne Kopfzeile, wie die bisherige Liste „Tabelle2“
  const ohne = [['original'], ['Muster Bau GmbH', 150, '', 'Überweisung'], ['Bäckerei Korn', 50, '', 'bar in Geldtasche'],
    ['Gratis GmbH', 0, '', 'Überweisung'], ['Summe', 200, '', '']];
  const a = sponsorTabelle(ohne);
  assert.equal(a.kopf, false);
  assert.deepEqual(a.zeilen.map(z => [z.name, z.betrag, z.zahlweg]), [['Muster Bau GmbH', 15000, 'ueberweisung'], ['Bäckerei Korn', 5000, 'bar'], ['Gratis GmbH', 0, 'ueberweisung']]);
  // mit Kopfzeile (CSV-Text), PLZ und Ort getrennt, Status
  const mit = parseCsv('Firma;Ansprechpartner;Straße;PLZ;Ort;E-Mail;Betrag;Zahlweg;Status\r\n'
    + 'Muster Bau GmbH;Frau Muster;Hauptstraße 5;4849;Puchkirchen;office@muster.at;150,00;Überweisung;\r\n'
    + 'Bäckerei Korn;;;;;;50;bar;bezahlt\r\n');
  const b = sponsorTabelle(mit);
  assert.equal(b.kopf, true);
  assert.deepEqual(b.zeilen[0], { name: 'Muster Bau GmbH', betrag: 15000, zahlweg: 'ueberweisung', zusatz: 'Frau Muster', strasse: 'Hauptstraße 5',
    plzOrt: '4849 Puchkirchen', email: 'office@muster.at', leistung: '', bezahlt: false });
  assert.equal(b.zeilen[1].zahlweg, 'bar');
  assert.equal(b.zeilen[1].bezahlt, true);
  // Festkassabuch-Blatt wird nicht als Sponsorenliste gelesen
  assert.equal(sponsorTabelle([['Datum', 'Text', 'Einnahmen', 'Ausgaben'], ['', 'Musik', '', 450]]).zeilen.length, 0);
});

test('Weitere Überweisungen: bestehendem Sponsor zuordnen statt doppelt anlegen', async () => {
  const { ueberweisungVorschlaege } = await import('../lib.js');
  const K = (id, betrag, text) => ({ buchung: { id, betrag, text }, name: text, betrag });
  const kand = [
    K('k1', 30000, 'Auftraggeber: Andreas und Martina Gaborek Zahlungsreferenz: Transparentwerbung'),   // Name passt, Betrag anders
    K('k2', 5000, 'Auftraggeber: Firma Unbekannt Zahlungsreferenz: Transparentwerbung'),               // nur Betrag passt
    K('k3', 7700, 'Auftraggeber: Ganz Neu GmbH Zahlungsreferenz: Sponsoring'),                         // nichts passt
    K('k4', 5000, 'Auftraggeber: Bäckerei Korn Zahlungsreferenz: Werbung'),                            // Name + Betrag
  ];
  const offen = [{ id: 'g', name: 'Fliesen Gaborek', betrag: 10000 }, { id: 'b', name: 'Bäckerei Korn', betrag: 5000 }, { id: 'x', name: 'Elektro Muster', betrag: 5000 }];
  const v = ueberweisungVorschlaege(kand, offen);
  assert.deepEqual(v.map(x => x.aktion), ['g', 'skip', 'neu', 'b']);
  assert.match(v[0].grund, /Name passt, Betrag abweichend/);
  assert.deepEqual(v[1].gleicherBetrag, ['x']);
});
