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
// konto: Kategorie wird nur bei diesem Konto angeboten ('' = bei allen)
// vp: Voranschlagsposten im Feuerwehr-Rechnungsabschluss für die Gemeinde.
//     Bei Festkassa/Umbuchung: vpE (Eingänge) und vpA (Ausgänge).

const vpE = [
  ['298', 'Entnahme aus der FW-Rücklage'], ['753', 'lfd. Transferz. v.Gemeinden'], ['805', 'Veräußerungen'],
  ['810', 'Leistungserlöse aus Einsätzen'], ['823', 'Zinsen der Feuerwehrrücklage'], ['824', 'Einnahmen aus Vermietung'],
  ['829', 'Sonst. Einnahmen (Spenden etc.)'], ['858', 'Kapitaltransferz. v. Landes-Fw-Fonds'], ['871', 'Kapitaltransferz. vom Land'],
];
const vpA = [
  ['10', 'Feuerwehrhaus-Errichtung'], ['20', 'Geräte u. Anlagen'], ['40', 'FW-Fahrzeuge-Anschaffung'], ['50', 'Löschwasseranlagen'],
  ['298', 'Rücklagenzuführung'], ['346', 'Rückzahlung v. Darlehen'], ['400', 'Geringwert. Ge- u. Verbrauchsgüter'],
  ['409', 'Ersatzteile für Geräte u. Fahrzeuge'], ['451', 'Betriebskosten für Gebäude'], ['452', 'Treibstoffe'],
  ['455', 'Löschmittel, Ölbindemittel'], ['600', 'Strom'], ['614', 'Instandh. von Gebäuden'], ['616', 'Instandh. von Geräten u. Anlagen'],
  ['617', 'Instandh. von Fahrzeugen'], ['630', 'Leistungen der Post'], ['650', 'Kreditzinsen'], ['670', 'Versicherungen'],
  ['690', 'Schadenersätze'], ['710', 'Öffentl. Abgaben'], ['728', 'Entgelte für sonst. Leistungen'],
  ['729', 'Sonst. Ausgaben (Aus- u. Fortbildung)'],
];

export const DEFAULT_KATEGORIEN = [
  // Feuerwehrkassa: Voranschlagsposten der Gemeinde
  ...vpE.map(([nr, name]) => ({ id: `vp_e${nr}`, nr, vp: nr, name, art: 'E', konto: 'feuerwehr' })),
  ...vpA.map(([nr, name]) => ({ id: `vp_a${nr}`, nr, vp: nr, name, art: 'A', konto: 'feuerwehr' })),
  // Mannschaftskassa (Kameradschaftskassa, nicht Teil des Gemeinde-Abschlusses)
  { id: 'm_beitraege', nr: 'M10', name: 'Mitgliedsbeiträge', art: 'E', konto: 'mannschaft' },
  { id: 'm_spenden', nr: 'M11', name: 'Spenden / Sponsoring', art: 'E', konto: 'mannschaft' },
  { id: 'm_fest_e', nr: 'M20', name: 'Veranstaltungen – Einnahmen', art: 'E', konto: 'mannschaft' },
  { id: 'm_bewerbe_e', nr: 'M25', name: 'Bewerbe / Rückerstattungen', art: 'E', konto: 'mannschaft' },
  { id: 'm_zinsen', nr: 'M30', name: 'Zinsen', art: 'E', konto: 'mannschaft' },
  { id: 'm_sonst_e', nr: 'M39', name: 'Sonstige Einnahmen', art: 'E', konto: 'mannschaft' },
  { id: 'm_kamerad', nr: 'M50', name: 'Kameradschaftspflege / Ausflüge / Essen', art: 'A', konto: 'mannschaft' },
  { id: 'm_bekleidung', nr: 'M55', name: 'Bekleidung / Ausrüstung', art: 'A', konto: 'mannschaft' },
  { id: 'm_bewerbe', nr: 'M60', name: 'Bewerbe / Leistungsabzeichen', art: 'A', konto: 'mannschaft' },
  { id: 'm_jugend', nr: 'M65', name: 'Feuerwehrjugend', art: 'A', konto: 'mannschaft' },
  { id: 'm_fest_a', nr: 'M70', name: 'Veranstaltungen – Ausgaben', art: 'A', konto: 'mannschaft' },
  { id: 'm_ehrungen', nr: 'M75', name: 'Ehrungen / Geschenke / Kränze', art: 'A', konto: 'mannschaft' },
  { id: 'm_bank', nr: 'M80', name: 'Bankspesen / KESt', art: 'A', konto: 'mannschaft' },
  { id: 'm_sonst_a', nr: 'M89', name: 'Sonstige Ausgaben', art: 'A', konto: 'mannschaft' },
  // beide Konten
  { id: 'festkassa', nr: 'F', name: 'Festkassa: Ablieferung / Wechselgeld', art: 'F', konto: '', vpE: '829', vpA: '729' },
  { id: 'umbuchung', nr: 'U', name: 'Umbuchung zwischen eigenen Konten', art: 'U', konto: '' },
];

// Vorgeschlagene Kontierungsregeln – nach der bisherigen Kontierung der FF Pichl (Excel 2025).
// Reihenfolge zählt: die erste passende Regel gewinnt.
const FW = 'feuerwehr', MS = 'mannschaft';
export const DEFAULT_REGELN = [
  { muster: 'Wechselgeld|Erlös', kategorie: 'festkassa', richtung: '', konto: '' },
  { muster: 'Umlage|BEWERB|Startgeld|Abzeichen|ASLP|-LG.|Lehrgang|Brennpunkt|Wix.com', kategorie: 'vp_a729', richtung: '-', konto: FW },
  { muster: 'Kontoführung|Buchungsentgelt|Kapitalertragsteuer|Kontoentgelt|Hilfssäckel|Jahrbuch', kategorie: 'vp_a728', richtung: '-', konto: FW },
  { muster: 'Befüllung', kategorie: 'vp_a409', richtung: '-', konto: FW },
  { muster: 'Brandschutz Attergau|Atemschutz', kategorie: 'vp_a616', richtung: '-', konto: FW },
  { muster: 'Ölbindemittel', kategorie: 'vp_a455', richtung: '-', konto: FW },
  { muster: 'Habenzinsen', kategorie: 'vp_e823', richtung: '+', konto: FW },
  { muster: 'Subvention', kategorie: 'vp_e753', richtung: '+', konto: FW },
  { muster: 'Landes-Feuerwehrverband', kategorie: 'vp_e858', richtung: '+', konto: FW },
  { muster: 'Transparent|Sponsoring|Werbebeitrag|Werbebanner|Werbung|Sumup|Spende|Mitgliedsbeitrag', kategorie: 'vp_e829', richtung: '+', konto: FW },
  { muster: 'Kontoführung|Buchungsentgelt|Kapitalertragsteuer|Kontoentgelt', kategorie: 'm_bank', richtung: '-', konto: MS },
  { muster: 'Habenzinsen', kategorie: 'm_zinsen', richtung: '+', konto: MS },
  { muster: 'Mitgliedsbeitr', kategorie: 'm_beitraege', richtung: '+', konto: MS },
  { muster: 'Spende|Sponsoring', kategorie: 'm_spenden', richtung: '+', konto: MS },
  { muster: 'Gasthaus', kategorie: 'm_kamerad', richtung: '-', konto: MS },
  { muster: 'Brandschutz', kategorie: 'm_bekleidung', richtung: '-', konto: MS },
  { muster: 'Brau Union|Verleih|Hüpfburg|AKM', kategorie: 'm_fest_a', richtung: '-', konto: MS },
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

// ── Belegnummern ─────────────────────────────────────────────────────────────

/** "18.02.2025 02:29:12:440" → "2025-02-18 02:29:12:440" (sortierbar) */
function stampKey(z) {
  const m = String(z || '').match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(.*)$/);
  return m ? `${m[3]}-${pad(m[2])}-${pad(m[1])} ${m[4]}` : String(z || '');
}

/** Chronologische Reihenfolge wie im ELBA-Export: Buchungsdatum, Zeitstempel, Zeile in der Datei. */
export function chronoSort(a, b) {
  return a.datum.localeCompare(b.datum) || stampKey(a.zeitstempel).localeCompare(stampKey(b.zeitstempel))
    || (a.seq ?? 1e9) - (b.seq ?? 1e9) || String(a.id || '').localeCompare(String(b.id || ''));
}

/** Laufende Belegnummer je Konto und Jahr (1, 2, 3 …) → Map id → Nr. */
export function belegNummern(buchungen) {
  const byKonto = new Map();
  for (const b of buchungen) {
    const k = `${b.konto}|${b.jahr ?? b.datum.slice(0, 4)}`;
    if (!byKonto.has(k)) byKonto.set(k, []);
    byKonto.get(k).push(b);
  }
  const out = new Map();
  for (const list of byKonto.values()) list.sort(chronoSort).forEach((b, i) => out.set(b.id, i + 1));
  return out;
}

// ── Feuerwehr-Rechnungsabschluss für die Gemeinde ────────────────────────────

const byVp = (a, b) => Number(a.vp) - Number(b.vp) || a.vp.localeCompare(b.vp);

/**
 * Summen je Voranschlagsposten wie im Formular „Feuerwehr-Rechnungsabschluss“.
 * Alle V-P-Zeilen werden aufgeführt (auch mit 0). Teile ohne V-P landen in `ohne`.
 */
export function gemeindeAbschluss({ buchungen, kategorien, anfang = 0 }) {
  const katById = Object.fromEntries(kategorien.map(k => [k.id, k]));
  const rows = { E: new Map(), A: new Map() };
  const addRow = (side, vp, name) => { if (!rows[side].has(vp)) rows[side].set(vp, { vp, name, betrag: 0 }); return rows[side].get(vp); };
  for (const k of kategorien) if (k.vp && (k.art === 'E' || k.art === 'A') && !k.inaktiv) addRow(k.art, k.vp, k.name);
  const ohne = [];
  for (const b of buchungen) {
    for (const p of parts(b)) {
      const k = katById[p.kategorie];
      if (k && k.vp && k.art === 'E') addRow('E', k.vp, k.name).betrag += p.betrag;
      else if (k && k.vp && k.art === 'A') addRow('A', k.vp, k.name).betrag -= p.betrag;
      else if (k && p.betrag >= 0 && k.vpE) addRow('E', k.vpE, k.name).betrag += p.betrag;
      else if (k && p.betrag < 0 && k.vpA) addRow('A', k.vpA, k.name).betrag -= p.betrag;
      else ohne.push({ ...p, buchung: b });
    }
  }
  const einnahmen = [...rows.E.values()].sort(byVp), ausgaben = [...rows.A.values()].sort(byVp);
  const summeE = einnahmen.reduce((a, r) => a + r.betrag, 0), summeA = ausgaben.reduce((a, r) => a + r.betrag, 0);
  return { einnahmen, ausgaben, summeE, summeA, anfang, ende: anfang + summeE - summeA, ohne };
}

/** Hat das Konto Kategorien mit Voranschlagsposten (→ Gemeinde-Abschluss sinnvoll)? */
export function hatVp(kategorien, konto) {
  return kategorien.some(k => k.vp && (!k.konto || k.konto === konto));
}

// ── Kontierung aus einer bisherigen Excel-Liste übernehmen ───────────────────

/**
 * Findet in einer Tabelle (Array von Zeilen) die Kopfzeile mit Datum, Betrag und Kontierung
 * und liefert die Datenzeilen als { datum, betrag, kontierung, text, beleg }.
 */
export function excelKontierung(table) {
  const hi = table.findIndex(r => {
    const n = r.map(c => norm(c));
    return n.includes('datum') && n.includes('betrag') && n.some(c => c.startsWith('kontierung'));
  });
  if (hi < 0) return null;
  const h = table[hi].map(c => norm(c));
  const col = name => h.findIndex(c => c.startsWith(name));
  const ci = { datum: col('datum'), betrag: col('betrag'), kont: col('kontierung'), text: col('bezeichnung'), beleg: col('beleg') };
  const rows = [];
  for (const r of table.slice(hi + 1)) {
    const d = r[ci.datum];
    const datum = d instanceof Date ? isoLocal(d) : parseDate(d);
    const betrag = parseAmount(r[ci.betrag]);
    if (!datum || betrag === null) continue;
    rows.push({ datum, betrag, kontierung: String(r[ci.kont] ?? '').trim().replace(/\.0+$/, ''), text: ci.text >= 0 ? String(r[ci.text] ?? '') : '', beleg: ci.beleg >= 0 ? r[ci.beleg] : '' });
  }
  return rows;
}
function isoLocal(d) {
  const x = new Date(d.getTime() + 12 * 3600e3);   // Excel-Datum um Mitternacht → Zeitzonen-sicher
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
}

/**
 * Ordnet Excel-Zeilen den Buchungen eines Kontos zu (gleiches Datum und gleicher Betrag, bei
 * mehreren gleichen in chronologischer Reihenfolge) und sucht die Kategorie zur Kontierungs-Nummer.
 * Liefert { treffer: [{buchung, kategorie, zeile}], ohneBuchung: [zeile], unbekannt: [zeile] }.
 */
export function zuordnenKontierung(zeilen, buchungen, kategorien, konto) {
  const key = x => `${x.datum}|${x.betrag}`;
  const pool = new Map();
  for (const b of [...buchungen].filter(b => b.konto === konto).sort(chronoSort)) {
    if (!pool.has(key(b))) pool.set(key(b), []);
    pool.get(key(b)).push(b);
  }
  const kats = kategorien.filter(k => !k.konto || k.konto === konto);
  const findKat = (nr, betrag) => {
    const m = kats.filter(k => String(k.vp || k.nr) === nr || String(k.nr) === nr);
    return m.find(k => k.art === (betrag >= 0 ? 'E' : 'A')) || m[0] || null;
  };
  const out = { treffer: [], ohneBuchung: [], unbekannt: [] };
  for (const z of zeilen) {
    if (!z.kontierung) continue;
    const b = pool.get(key(z))?.shift();
    if (!b) { out.ohneBuchung.push(z); continue; }
    const k = findKat(z.kontierung, z.betrag);
    if (!k) { out.unbekannt.push(z); continue; }
    out.treffer.push({ buchung: b, kategorie: k.id, zeile: z });
  }
  return out;
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
