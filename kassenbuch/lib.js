// Reine Rechen- und Importfunktionen des Kassenbuchs (ohne Firebase, ohne DOM).
// Werden von app.js verwendet und mit `npm test` (node --test) geprüft.
//
// Beträge werden überall als ganze CENT-Zahlen geführt (1234 = 12,34 €),
// damit sich keine Rundungsfehler aufsummieren.

// ── Hilfen ───────────────────────────────────────────────────────────────────

export const pad = n => String(n).padStart(2, '0');

export function norm(s) {
  return String(s ?? '').replace(/ß/g, 'ss').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

// de-DE: Tausenderpunkt (1.234,56) wie auf Kontoauszügen üblich
const EUR = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** 123456 → "1.234,56" */
export function fmt(cents) {
  return EUR.format((Number(cents) || 0) / 100);
}
/** 123456 → "1.234,56 €" */
export function eur(cents) { return fmt(cents) + ' €'; }

/**
 * Betrag aus Text → Cent. Versteht "1.234,56", "-12,50", "+12,50", "12.50", "1234",
 * "12,50 EUR", "−12,50" (typografisches Minus) und "12,50-" (Minus hinten).
 * Gibt null zurück, wenn es kein Betrag ist.
 */
export function parseAmount(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) : null;
  let s = String(v ?? '').trim().replace(/[−–]/g, '-').replace(/\s|€|EUR/gi, '');
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.endsWith('-')) { neg = true; s = s.slice(0, -1); }
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); } else if (s.startsWith('+')) s = s.slice(1);
  if (!/^[0-9.,']+$/.test(s)) return null;
  const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
  let intPart, dec = '';
  if (lastComma > lastDot) {             // 1.234,56 → Komma ist Dezimal
    intPart = s.slice(0, lastComma); dec = s.slice(lastComma + 1);
  } else if (lastDot > lastComma) {      // 1,234.56 oder 12.50 oder 1.234 (Tausender!)
    const after = s.slice(lastDot + 1);
    if (lastComma === -1 && after.length === 3 && (s.match(/\./g) || []).length >= 1 && !/^0\./.test(s)) {
      intPart = s; dec = '';             // "1.234" = tausendzweihundertvierunddreißig
    } else { intPart = s.slice(0, lastDot); dec = after; }
  } else intPart = s;
  intPart = intPart.replace(/[.,']/g, '');
  if (!/^\d*$/.test(intPart) || !/^\d*$/.test(dec) || dec.length > 2 || (intPart + dec) === '') return null;
  const cents = Number(intPart || '0') * 100 + Number((dec + '00').slice(0, 2));
  return neg ? -cents : cents;
}

/** Datum aus Text → "YYYY-MM-DD" (oder null). Versteht 31.12.2026, 31.12.26, 2026-12-31, 31/12/2026. */
export function parseDate(v) {
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2,4})(?:\D|$)/);
  if (m) {
    let y = +m[3];
    if (y < 100) y += 2000;
    return valid(y, +m[2], +m[1]);
  }
  return null;
  function valid(y, mo, d) {
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return `${y}-${pad(mo)}-${pad(d)}`;
  }
}

/** "2026-12-31" → "31.12.2026" */
export function deDate(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).split('-');
  return `${d}.${m}.${y}`;
}

// ── CSV ──────────────────────────────────────────────────────────────────────

export function decodeText(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^﻿/, '');
  } catch {
    // ELBA und Excel speichern CSV oft als Windows-1252 (ANSI)
    return new TextDecoder('windows-1252').decode(buffer);
  }
}

export function parseCsv(text) {
  const sample = text.split(/\r?\n/).slice(0, 10).join('\n');
  const count = ch => sample.split(ch).length - 1;
  const delim = [';', '\t', ','].sort((a, b) => count(b) - count(a))[0];
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell.trim() === '') { quoted = true; cell = ''; }
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map(r => r.map(c => c.trim())).filter(r => r.some(c => c !== ''));
}

// ── Raika-/Bank-Import ───────────────────────────────────────────────────────
//
// Raiffeisen ELBA exportiert die Umsätze als CSV OHNE Kopfzeile:
//   Buchungsdatum;Buchungstext;Valutadatum;Betrag;Währung;Zeitstempel
//   02.01.2026;Gutschrift Max Muster AT12... Spende;02.01.2026;+50,00;EUR;02.01.2026 08:14:22:123
// Andere Exporte (Mein ELBA, Excel, andere Banken) haben oft eine Kopfzeile.
// Beides wird hier erkannt; die Zuordnung der Spalten lässt sich in der App korrigieren.

export const ROLES = {
  datum: 'Buchungsdatum',
  valuta: 'Valutadatum',
  betrag: 'Betrag',
  text: 'Buchungstext',
  partner: 'Auftraggeber/Empfänger',
  zweck: 'Verwendungszweck',
  waehrung: 'Währung',
  zeitstempel: 'Zeitstempel',
  ignorieren: '— ignorieren —',
};

const HEADER_WORDS = [
  ['datum', /^(buchungs?datum|buchungstag|datum|date|buchung)$/],
  ['valuta', /valuta|wertstellung/],
  ['betrag', /^(betrag|betrag \(eur\)|betrag eur|umsatz|amount|summe)$/],
  ['waehrung', /^(wahrung|whrg|currency)$/],
  ['zeitstempel', /zeitstempel|timestamp/],
  ['partner', /auftraggeber|empfanger|zahlungspflichtiger|partner|name|beguenstigter|begunstigter/],
  ['zweck', /verwendungszweck|zahlungsreferenz|referenz|zweck/],
  ['text', /buchungstext|umsatztext|text|beschreibung|details/],
];

function headerRole(cell) {
  const n = norm(cell).replace(/[^a-z0-9 ()]/g, '');
  if (!n) return null;
  for (const [role, re] of HEADER_WORDS) if (re.test(n)) return role;
  return null;
}

/** Erkennt die Spaltenbedeutung. Liefert { header: bool, mapping: [role|'ignorieren', ...] } */
export function detectColumns(table) {
  const width = Math.max(0, ...table.slice(0, 30).map(r => r.length));
  const first = table[0] || [];
  const headerRoles = first.map(headerRole);
  const firstHasDate = first.some(c => parseDate(c));
  if (!firstHasDate && headerRoles.filter(Boolean).length >= 2) {
    const used = new Set();
    const mapping = Array.from({ length: width }, (_, i) => {
      const r = headerRoles[i];
      if (!r || used.has(r)) return 'ignorieren';
      used.add(r); return r;
    });
    return { header: true, mapping };
  }
  // Ohne Kopfzeile: nach Inhalt raten
  const rows = table.slice(0, 50);
  const score = Array.from({ length: width }, (_, i) => {
    const vals = rows.map(r => r[i] ?? '').filter(v => v !== '');
    const share = f => vals.length ? vals.filter(f).length / vals.length : 0;
    return {
      i,
      date: share(v => parseDate(v) && /^\d{1,2}\.\d{1,2}\.\d{2,4}$|^\d{4}-\d{2}-\d{2}$/.test(v)),
      stamp: share(v => /^\d{1,2}\.\d{1,2}\.\d{4}[ T]\d{1,2}:\d{2}/.test(v) || /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(v)),
      amount: share(v => /^[+\-−]?\s?\d{1,3}([.']?\d{3})*([.,]\d{1,2})?$/.test(v.replace(/\s?(€|EUR)$/i, ''))),
      cur: share(v => /^[A-Z]{3}$/.test(v)),
      len: vals.reduce((a, v) => a + v.length, 0) / (vals.length || 1),
    };
  });
  const mapping = Array(width).fill('ignorieren');
  const dates = score.filter(s => s.date > 0.8 && s.stamp < 0.5);
  if (dates[0]) mapping[dates[0].i] = 'datum';
  if (dates[1]) mapping[dates[1].i] = 'valuta';
  const stamp = score.find(s => s.stamp > 0.8);
  if (stamp) mapping[stamp.i] = 'zeitstempel';
  const cur = score.find(s => s.cur > 0.8 && mapping[s.i] === 'ignorieren');
  if (cur) mapping[cur.i] = 'waehrung';
  // Betrag: Zahlenspalte, bevorzugt mit Vorzeichen bzw. Dezimalkomma
  const amounts = score.filter(s => s.amount > 0.8 && mapping[s.i] === 'ignorieren');
  const withSign = amounts.find(s => rows.some(r => /^[+\-]/.test(r[s.i] ?? '')));
  const amt = withSign || amounts.find(s => rows.some(r => /,\d{2}$/.test(r[s.i] ?? ''))) || amounts[0];
  if (amt) mapping[amt.i] = 'betrag';
  const texts = score.filter(s => mapping[s.i] === 'ignorieren' && s.amount < 0.5).sort((a, b) => b.len - a.len);
  if (texts[0]) mapping[texts[0].i] = 'text';
  return { header: false, mapping };
}

/**
 * Wendet eine Spaltenzuordnung an. Liefert { rows, errors }.
 * rows: { datum, valuta, betrag, text, zeitstempel, zeile }
 */
export function applyMapping(table, mapping, header) {
  const col = role => mapping.indexOf(role);
  const c = Object.fromEntries(Object.keys(ROLES).map(r => [r, col(r)]));
  const rows = [], errors = [];
  if (c.datum < 0) errors.push('Keine Spalte für das Buchungsdatum gewählt.');
  if (c.betrag < 0) errors.push('Keine Spalte für den Betrag gewählt.');
  if (errors.length) return { rows, errors };
  table.forEach((r, idx) => {
    if (header && idx === 0) return;
    const get = k => (c[k] >= 0 ? (r[c[k]] ?? '').trim() : '');
    const datum = parseDate(get('datum'));
    const betrag = parseAmount(get('betrag'));
    if (!datum || betrag === null) {
      // Summen- oder Leerzeilen am Ende der Datei still überspringen
      if (r.filter(Boolean).length > 2) errors.push(`Zeile ${idx + 1} übersprungen (Datum oder Betrag unlesbar): ${r.join(' | ').slice(0, 120)}`);
      return;
    }
    const waehrung = get('waehrung');
    if (waehrung && waehrung.toUpperCase() !== 'EUR') errors.push(`Zeile ${idx + 1}: Währung ${waehrung} – Betrag wird trotzdem als Euro übernommen.`);
    const parts = [get('partner'), get('text'), get('zweck')].filter(Boolean);
    rows.push({
      datum,
      valuta: parseDate(get('valuta')) || datum,
      betrag,
      text: parts.join(' · ').replace(/\s{2,}/g, ' ').slice(0, 500),
      zeitstempel: get('zeitstempel'),
      zeile: idx + 1,
    });
  });
  return { rows, errors };
}

/** Sucht eine IBAN im Dateinamen (ELBA benennt Exporte oft nach dem Konto). */
export function ibanFromName(name) {
  const m = String(name || '').toUpperCase().replace(/[\s_-]/g, '').match(/AT\d{18}/);
  return m ? m[0] : null;
}
export const cleanIban = s => String(s || '').toUpperCase().replace(/\s/g, '');

// ── Doppelte Buchungen erkennen ───────────────────────────────────────────────

async function sha256hex(s) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Stabile Dokument-ID je Bankzeile. Gleiche Zeilen in derselben Datei (z. B. zwei gleiche
 * Spenden am selben Tag) werden durchnummeriert, damit sie nicht zusammenfallen.
 * Wird dieselbe Datei – oder ein überlappender Zeitraum – erneut importiert, entstehen
 * dieselben IDs; bereits vorhandene Buchungen werden dann übersprungen.
 */
export async function importIds(kontoId, rows) {
  const seen = new Map();
  const out = [];
  for (const r of rows) {
    const key = [r.datum, r.valuta, r.betrag, norm(r.text), r.zeitstempel].join('|');
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    out.push(`${kontoId}-${(await sha256hex(key + '|' + n)).slice(0, 24)}`);
  }
  return out;
}

// ── Automatische Kontierung ──────────────────────────────────────────────────

/**
 * Regeln: [{ muster: "Getränke Haas", kategorie: "a_fest", veranstaltung?: id, richtung?: '+'|'-'|'' , konto?: id }]
 * Mehrere Suchbegriffe mit "|" trennen. Erste passende Regel gewinnt.
 */
// ── Bank-Text zerlegen ───────────────────────────────────────────────────────
// ELBA liefert den Umsatztext als eine lange Zeile, z. B.
//   "Online Banking vom 11.03 um 19:32 Empfänger: Brandschutz Attergau Zahlungsreferenz: Rechnung Nr 123
//    IBAN Empfänger: AT74… BIC Empfänger: RZOO…"
// Für die Anzeige werden Auftraggeber/Empfänger und Verwendungszweck herausgelöst.

const LABELS = /(IBAN Auftraggeber|IBAN Zahlungsempfänger|IBAN Empfänger|BIC Auftraggeber|BIC Zahlungsempfänger|BIC Empfänger|Empfänger-Kennung|Auftraggeberreferenz|Zahlungsempfänger|Auftraggeber|Empfänger|Verwendungszweck|Zahlungsreferenz|Mandat):\s*/g;

export function splitBankText(text) {
  const t = String(text || '').replace(/^Online Banking vom [\d.]+ um [\d:]+\s*/, '');
  const parts = {};
  let lastLabel = null, lastIdx = 0, m;
  const pre = [];
  LABELS.lastIndex = 0;
  while ((m = LABELS.exec(t))) {
    const chunk = t.slice(lastIdx, m.index).trim();
    if (lastLabel) { if (!(lastLabel in parts)) parts[lastLabel] = chunk; } else if (chunk) pre.push(chunk);
    lastLabel = m[1]; lastIdx = LABELS.lastIndex;
  }
  const tail = t.slice(lastIdx).trim();
  if (lastLabel) { if (!(lastLabel in parts)) parts[lastLabel] = tail; } else if (tail) pre.push(tail);
  const clean = s => (s || '').replace(/\s{2,}/g, ' ').trim();
  return {
    partner: clean(parts.Auftraggeber || parts.Zahlungsempfänger || parts['Empfänger']),
    zweck: clean([parts.Verwendungszweck, parts.Zahlungsreferenz].filter(Boolean).join(' · ') || pre.join(' ') || parts.Auftraggeberreferenz),
    iban: clean(parts['IBAN Auftraggeber'] || parts['IBAN Zahlungsempfänger'] || parts['IBAN Empfänger']),
  };
}

/** Vorschlag für den Suchbegriff einer Kontierungsregel: Name des Gegenübers, sonst der Verwendungszweck. */
export function suchbegriff(text) {
  const { partner, zweck } = splitBankText(text);
  if (partner) return partner.replace(/\s*\(.*?\)\s*/g, ' ').trim().split(' ').slice(0, 3).join(' ');
  return (zweck || String(text || '')).replace(/[\d.,%]+(\s*p\.a\.)?/g, ' ').split(/\s+/).filter(w => w.length > 2).slice(0, 3).join(' ');
}

export function matchRule(regeln, b) {
  const t = norm(b.text);
  for (const r of regeln || []) {
    if (!r.muster || !r.kategorie) continue;
    if (r.richtung === '+' && b.betrag < 0) continue;
    if (r.richtung === '-' && b.betrag > 0) continue;
    if (r.konto && r.konto !== b.konto) continue;
    const words = String(r.muster).split('|').map(norm).filter(Boolean);
    if (words.some(w => t.includes(w))) return r;
  }
  return null;
}

// ── Standard-Kategorien (Kontenplan) ─────────────────────────────────────────
// art: 'E' Einnahme, 'A' Ausgabe, 'U' Umbuchung (neutral), 'F' Festkassa (Ablieferung/Wechselgeld)

export const DEFAULT_KATEGORIEN = [
  { id: 'e_subv_gem', nr: '100', name: 'Subvention Gemeinde', art: 'E' },
  { id: 'e_subv_land', nr: '110', name: 'Subvention Land / LFV', art: 'E' },
  { id: 'e_spenden', nr: '120', name: 'Spenden', art: 'E' },
  { id: 'e_sponsoring', nr: '122', name: 'Sponsoring / Transparentwerbung', art: 'E' },
  { id: 'e_haussammlung', nr: '125', name: 'Haussammlung', art: 'E' },
  { id: 'e_beitraege', nr: '130', name: 'Mitgliedsbeiträge / Unterstützende Mitglieder', art: 'E' },
  { id: 'e_kostenersatz', nr: '140', name: 'Kostenersätze Einsätze / Leistungen', art: 'E' },
  { id: 'e_fest', nr: '150', name: 'Veranstaltungen – Einnahmen (Bank)', art: 'E' },
  { id: 'e_zinsen', nr: '180', name: 'Zinsen / Erträge', art: 'E' },
  { id: 'e_sonst', nr: '190', name: 'Sonstige Einnahmen', art: 'E' },
  { id: 'a_ausruestung', nr: '500', name: 'Ausrüstung / Bekleidung', art: 'A' },
  { id: 'a_geraete', nr: '510', name: 'Geräte / Wartung', art: 'A' },
  { id: 'a_fahrzeuge', nr: '520', name: 'Fahrzeuge / Treibstoff', art: 'A' },
  { id: 'a_haus', nr: '530', name: 'Feuerwehrhaus / Betriebskosten', art: 'A' },
  { id: 'a_ausbildung', nr: '540', name: 'Aus- und Weiterbildung / Kurse', art: 'A' },
  { id: 'a_bewerbe', nr: '550', name: 'Bewerbe / Leistungsabzeichen', art: 'A' },
  { id: 'a_jugend', nr: '560', name: 'Feuerwehrjugend', art: 'A' },
  { id: 'a_kamerad', nr: '570', name: 'Kameradschaftspflege / Ausflüge', art: 'A' },
  { id: 'a_ehrungen', nr: '575', name: 'Ehrungen / Geschenke / Kränze', art: 'A' },
  { id: 'a_fest', nr: '580', name: 'Veranstaltungen – Ausgaben (Bank)', art: 'A' },
  { id: 'a_verwaltung', nr: '590', name: 'Verwaltung / Büro / Porto', art: 'A' },
  { id: 'a_versicherung', nr: '600', name: 'Versicherungen / Mitgliedschaften', art: 'A' },
  { id: 'a_bank', nr: '610', name: 'Bankspesen / Kontoführung / KESt', art: 'A' },
  { id: 'a_sonst', nr: '690', name: 'Sonstige Ausgaben', art: 'A' },
  { id: 'festkassa', nr: '800', name: 'Festkassa: Ablieferung / Wechselgeld', art: 'F' },
  { id: 'umbuchung', nr: '900', name: 'Umbuchung zwischen eigenen Konten', art: 'U' },
];

// Vorgeschlagene Kontierungsregeln (aus typischen Raika-Umsätzen der FF Pichl)
export const DEFAULT_REGELN = [
  { muster: 'Kontoführung|Buchungsentgelt|Kapitalertragsteuer|Kontoentgelt', kategorie: 'a_bank', richtung: '-', konto: '' },
  { muster: 'Habenzinsen', kategorie: 'e_zinsen', richtung: '+', konto: '' },
  { muster: 'Wechselgeld|Erlös', kategorie: 'festkassa', richtung: '', konto: '' },
  { muster: 'Transparent|Sponsoring|Werbebeitrag|Werbebanner|Werbung', kategorie: 'e_sponsoring', richtung: '+', konto: '' },
  { muster: 'Sumup', kategorie: 'e_fest', richtung: '+', konto: '' },
  { muster: 'Subvention', kategorie: 'e_subv_gem', richtung: '+', konto: '' },
  { muster: 'Mitgliedsbeitrag', kategorie: 'e_beitraege', richtung: '+', konto: '' },
  { muster: 'Spende', kategorie: 'e_spenden', richtung: '+', konto: '' },
  { muster: 'BEWERB|Startgeld|Abzeichen|ASLP', kategorie: 'a_bewerbe', richtung: '-', konto: '' },
  { muster: 'Lehrgang|-LG.|Kurs', kategorie: 'a_ausbildung', richtung: '-', konto: '' },
  { muster: 'Hilfssäckel|Umlage', kategorie: 'a_versicherung', richtung: '-', konto: '' },
  { muster: 'Sonnwendfeuer|Wiesnfest|Wiesenfest|Zeltfest', kategorie: 'a_fest', richtung: '-', konto: '' },
  { muster: 'Atemschutz|Brandschutz', kategorie: 'a_geraete', richtung: '-', konto: '' },
  { muster: 'Jahrbuch|Brennpunkt|Wix.com', kategorie: 'a_verwaltung', richtung: '-', konto: '' },
];

export const DEFAULT_KONTEN = [
  { id: 'feuerwehr', name: 'Feuerwehrkassa', iban: '', order: 1 },
  { id: 'mannschaft', name: 'Mannschaftskassa', iban: '', order: 2 },
];

// ── Aufteilung einer Buchung ─────────────────────────────────────────────────

/**
 * Eine Buchung kann auf mehrere Kategorien/Veranstaltungen aufgeteilt sein (splits).
 * Liefert immer eine Liste von Teilen, deren Summe dem Buchungsbetrag entspricht;
 * ein nicht aufgeteilter Rest bleibt "unkontiert".
 */
export function parts(b) {
  if (Array.isArray(b.splits) && b.splits.length) {
    const sum = b.splits.reduce((a, s) => a + (s.betrag || 0), 0);
    const out = b.splits.map(s => ({ kategorie: s.kategorie || '', veranstaltung: s.veranstaltung || '', betrag: s.betrag || 0, notiz: s.notiz || '' }));
    if (sum !== b.betrag) out.push({ kategorie: '', veranstaltung: '', betrag: b.betrag - sum, notiz: 'Rest (nicht aufgeteilt)' });
    return out;
  }
  return [{ kategorie: b.kategorie || '', veranstaltung: b.veranstaltung || '', betrag: b.betrag, notiz: '' }];
}

export function isKontiert(b) {
  return parts(b).every(p => p.kategorie);
}

// ── Jahresabschluss ──────────────────────────────────────────────────────────

/**
 * buchungen: alle Buchungen des Jahres
 * konten: [{id, name}], kategorien: [{id, nr, name, art}]
 * anfang: { kontoId: cents }
 *
 * Liefert je Konto Anfangs-/Endbestand und Summen, dazu Einnahmen und Ausgaben je Kategorie
 * (positive Teile → Einnahmen, negative Teile → Ausgaben), Umbuchungen getrennt.
 */
export function jahresabschluss({ buchungen, konten, kategorien, anfang = {} }) {
  const katById = Object.fromEntries(kategorien.map(k => [k.id, k]));
  const kontoIds = konten.map(k => k.id);
  const zero = () => Object.fromEntries(kontoIds.map(id => [id, 0]));
  const proKonto = Object.fromEntries(kontoIds.map(id => [id, {
    anfang: anfang[id] || 0, einnahmen: 0, ausgaben: 0, umbuchungen: 0, ende: anfang[id] || 0, anzahl: 0, unkontiert: 0,
  }]));
  const ein = new Map(), aus = new Map(), umb = new Map();
  const add = (map, key, konto, cents) => {
    if (!map.has(key)) map.set(key, zero());
    const row = map.get(key);
    row[konto] = (row[konto] || 0) + cents;
  };
  for (const b of buchungen) {
    const pk = proKonto[b.konto];
    if (!pk) continue;
    pk.anzahl++;
    pk.ende += b.betrag;
    for (const p of parts(b)) {
      const kat = katById[p.kategorie];
      const key = kat ? kat.id : '';
      if (!kat) pk.unkontiert++;
      if (kat && kat.art === 'U') { add(umb, key, b.konto, p.betrag); pk.umbuchungen += p.betrag; continue; }
      if (p.betrag >= 0) { add(ein, key, b.konto, p.betrag); pk.einnahmen += p.betrag; }
      else { add(aus, key, b.konto, p.betrag); pk.ausgaben += p.betrag; }
    }
  }
  const order = key => {
    const k = katById[key];
    return `${k?.nr || '999'}|${k?.name || ''}`;
  };
  const toRows = map => [...map.entries()]
    // Unkontiert immer ans Ende
    .sort((a, b) => (!katById[a[0]]) - (!katById[b[0]]) || order(a[0]).localeCompare(order(b[0]), 'de', { numeric: true }))
    .map(([key, werte]) => ({
      kategorie: key,
      nr: katById[key]?.nr || '',
      name: katById[key]?.name || '⚠ noch nicht kontiert',
      werte,
      summe: Object.values(werte).reduce((a, v) => a + v, 0),
    }));
  const sumRow = rows => {
    const werte = zero();
    rows.forEach(r => kontoIds.forEach(id => { werte[id] += r.werte[id] || 0; }));
    return { werte, summe: Object.values(werte).reduce((a, v) => a + v, 0) };
  };
  const einnahmen = toRows(ein), ausgaben = toRows(aus), umbuchungen = toRows(umb);
  const total = f => kontoIds.reduce((a, id) => a + proKonto[id][f], 0);
  return {
    proKonto,
    einnahmen, ausgaben, umbuchungen,
    summeEinnahmen: sumRow(einnahmen),
    summeAusgaben: sumRow(ausgaben),
    summeUmbuchungen: sumRow(umbuchungen),
    gesamt: {
      anfang: total('anfang'), einnahmen: total('einnahmen'), ausgaben: total('ausgaben'),
      umbuchungen: total('umbuchungen'), ende: total('ende'), unkontiert: total('unkontiert'),
    },
  };
}

// ── Festkassa ────────────────────────────────────────────────────────────────
//
// Posten einer Veranstaltung:
//  art 'wechselgeld' – Wechselgeld/Vorschuss in die Festkassa (Bestand +, kein Ertrag)
//  art 'einnahme'    – Einnahmen (Bestand +), optional mit Zählprotokoll (stueckelung)
//  art 'ausgabe'     – Barausgaben aus der Festkassa (Bestand −)
//  art 'ablieferung' – Bargeld auf ein Bankkonto eingezahlt/übergeben (Bestand −, kein Aufwand)

export const POSTEN_ARTEN = {
  wechselgeld: { name: 'Wechselgeld / Vorschuss', vz: +1 },
  einnahme: { name: 'Einnahme', vz: +1 },
  ausgabe: { name: 'Ausgabe', vz: -1 },
  ablieferung: { name: 'Ablieferung an Bank', vz: -1 },
};

export const STUECKELUNG = [50000, 20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50, 20, 10, 5, 2, 1];

export function stueckelungSumme(st) {
  return STUECKELUNG.reduce((a, w) => a + w * (Number(st?.[w]) || 0), 0);
}

/** Sortiert Posten chronologisch und rechnet den laufenden Kassabestand mit. */
export function festkassaBuch(posten) {
  const sorted = [...posten].sort((a, b) =>
    (a.datum || '').localeCompare(b.datum || '') || (a.zeit || '').localeCompare(b.zeit || '')
    || (a.nr || 0) - (b.nr || 0));
  let bestand = 0;
  return sorted.map((p, i) => {
    const vz = POSTEN_ARTEN[p.art]?.vz || 0;
    bestand += vz * Math.abs(p.betrag || 0);
    return { ...p, lfd: i + 1, wirkung: vz * Math.abs(p.betrag || 0), bestand };
  });
}

/**
 * Abrechnung einer Veranstaltung.
 * posten: Festkassa-Posten; bank: Bankbuchungen (bzw. Teile), die der Veranstaltung zugeordnet sind.
 * Bankteile mit Kategorie 'festkassa' sind nur Geldbewegungen zwischen Bank und Festkassa und zählen
 * nicht zum Ergebnis (sonst wären die Bareinnahmen doppelt gezählt).
 */
export function veranstaltungsAbrechnung(posten, bankTeile, kategorien) {
  const katById = Object.fromEntries((kategorien || []).map(k => [k.id, k]));
  const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
  const abs = p => Math.abs(p.betrag || 0);
  const by = art => posten.filter(p => p.art === art);
  const bereiche = new Map();
  for (const p of posten) {
    if (p.art !== 'einnahme' && p.art !== 'ausgabe') continue;
    const key = p.bereich || (p.art === 'einnahme' ? 'Einnahmen allgemein' : 'Ausgaben allgemein');
    if (!bereiche.has(key)) bereiche.set(key, { bereich: key, einnahmen: 0, ausgaben: 0 });
    bereiche.get(key)[p.art === 'einnahme' ? 'einnahmen' : 'ausgaben'] += abs(p);
  }
  const bankRelevant = bankTeile.filter(t => katById[t.kategorie]?.art !== 'F' && katById[t.kategorie]?.art !== 'U');
  const bankTransfer = bankTeile.filter(t => katById[t.kategorie]?.art === 'F');
  const r = {
    wechselgeld: sum(by('wechselgeld'), abs),
    barEinnahmen: sum(by('einnahme'), abs),
    barAusgaben: sum(by('ausgabe'), abs),
    ablieferung: sum(by('ablieferung'), abs),
    bankEinnahmen: sum(bankRelevant.filter(t => t.betrag > 0), t => t.betrag),
    bankAusgaben: -sum(bankRelevant.filter(t => t.betrag < 0), t => t.betrag),
    bankTransfer: sum(bankTransfer, t => t.betrag),
    bereiche: [...bereiche.values()].sort((a, b) => a.bereich.localeCompare(b.bereich, 'de')),
  };
  r.bestand = r.wechselgeld + r.barEinnahmen - r.barAusgaben - r.ablieferung;
  r.einnahmen = r.barEinnahmen + r.bankEinnahmen;
  r.ausgaben = r.barAusgaben + r.bankAusgaben;
  r.ergebnis = r.einnahmen - r.ausgaben;
  // Kontrolle: was netto auf der Bank angekommen ist (Ablieferungen − Wechselgeld-Abhebungen)
  // sollte zu den Festkassa-Bewegungen passen, sobald alles abgeliefert ist.
  r.bankKontrolle = r.ablieferung - r.wechselgeld;
  return r;
}

// ── CSV-Export ───────────────────────────────────────────────────────────────

export function toCsv(rows) {
  const cell = v => {
    const s = String(v ?? '');
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // BOM, damit Excel Umlaute richtig anzeigt
  return '﻿' + rows.map(r => r.map(cell).join(';')).join('\r\n');
}
