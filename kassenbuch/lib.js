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
    if (!r.muster || !(r.kategorie || r.fest)) continue;
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
  // beide Konten
  { id: 'umbuchung', nr: 'U', name: 'Umbuchung zwischen eigenen Konten', art: 'U', konto: '' },
];

// Vorgeschlagene Kontierungsregeln – nach der bisherigen Kontierung der FF Pichl (Excel 2025).
// Reihenfolge zählt: die erste passende Regel gewinnt.
const FW = 'feuerwehr';
export const DEFAULT_REGELN = [
  // Geld zwischen Bank und Festkassa: in der Feuerwehrkassa wie bisher 729 (Abhebung) / 829 (Einzahlung)
  { muster: 'Wechselgeld', kategorie: 'vp_a729', richtung: '-', konto: FW, fest: 'kassa' },
  { muster: 'Wechselgeld|Erlös|Bareinzahlung|Ablieferung', kategorie: 'vp_e829', richtung: '+', konto: FW, fest: 'kassa' },
  { muster: 'Wechselgeld|Erlös|Bareinzahlung|Ablieferung', kategorie: '', richtung: '', konto: '', fest: 'kassa' },
  { muster: 'Umlage|BEWERB|Startgeld|Abzeichen|ASLP|-LG.|Lehrgang|Brennpunkt|Wix.com', kategorie: 'vp_a729', richtung: '-', konto: FW },
  { muster: 'Kontoführung|Buchungsentgelt|Kapitalertragsteuer|Kontoentgelt|Hilfssäckel|Jahrbuch', kategorie: 'vp_a728', richtung: '-', konto: FW },
  { muster: 'Befüllung', kategorie: 'vp_a409', richtung: '-', konto: FW },
  { muster: 'Brandschutz Attergau|Atemschutz', kategorie: 'vp_a616', richtung: '-', konto: FW },
  { muster: 'Ölbindemittel', kategorie: 'vp_a455', richtung: '-', konto: FW },
  { muster: 'Habenzinsen', kategorie: 'vp_e823', richtung: '+', konto: FW },
  { muster: 'Subvention', kategorie: 'vp_e753', richtung: '+', konto: FW },
  { muster: 'Landes-Feuerwehrverband', kategorie: 'vp_e858', richtung: '+', konto: FW },
  { muster: 'Transparent|Sponsoring|Werbebeitrag|Werbebanner|Werbung|Sumup|Spende|Mitgliedsbeitrag', kategorie: 'vp_e829', richtung: '+', konto: FW },
];

export const DEFAULT_KONTEN = [
  { id: 'feuerwehr', name: 'Feuerwehrkassa', iban: '', order: 1 },
  // Die Mannschaftskassa muss nicht kontiert werden
  { id: 'mannschaft', name: 'Mannschaftskassa', iban: '', order: 2, ohneKontierung: true },
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
    const out = b.splits.map(s => ({ kategorie: s.kategorie || '', veranstaltung: s.veranstaltung || '', festArt: s.veranstaltung ? (s.festArt || 'bank') : '', betrag: s.betrag || 0, notiz: s.notiz || '' }));
    if (sum !== b.betrag) out.push({ kategorie: '', veranstaltung: '', festArt: '', betrag: b.betrag - sum, notiz: 'Rest (nicht aufgeteilt)' });
    return out;
  }
  return [{ kategorie: b.kategorie || '', veranstaltung: b.veranstaltung || '', festArt: b.veranstaltung ? (b.festArt || (b.kategorie === 'festkassa' ? 'kassa' : 'bank')) : '', betrag: b.betrag, notiz: '' }];
}

/** Konten mit ohneKontierung (z. B. Mannschaftskassa) gelten immer als kontiert. */
export function isKontiert(b, konten) {
  if (konten?.find(k => k.id === b.konto)?.ohneKontierung) return true;
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
  const kontoFrei = new Set(konten.filter(k => k.ohneKontierung).map(k => k.id));
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
      const frei = !kat && kontoFrei.has(b.konto);
      const key = kat ? kat.id : frei ? '__ohne' : '';
      if (!kat && !frei) pk.unkontiert++;
      if (kat && kat.art === 'U') { add(umb, key, b.konto, p.betrag); pk.umbuchungen += p.betrag; continue; }
      if (p.betrag >= 0) { add(ein, key, b.konto, p.betrag); pk.einnahmen += p.betrag; }
      else { add(aus, key, b.konto, p.betrag); pk.ausgaben += p.betrag; }
    }
  }
  const order = key => {
    const k = katById[key];
    return `${k?.nr || '999'}|${k?.name || ''}`;
  };
  const rank = key => (katById[key] ? 0 : key === '__ohne' ? 1 : 2);
  const toRows = map => [...map.entries()]
    // Unkontiert immer ans Ende
    // „ohne Kontierung“ und „noch nicht kontiert“ ans Ende
    .sort((a, b) => rank(a[0]) - rank(b[0]) || order(a[0]).localeCompare(order(b[0]), 'de', { numeric: true }))
    .map(([key, werte]) => ({
      kategorie: key,
      nr: katById[key]?.nr || '',
      name: katById[key]?.name || (key === '__ohne' ? 'ohne Kontierung' : '⚠ noch nicht kontiert'),
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

// Art (Zahlweg) wie im bisherigen Excel-Festkassabuch:
//  „bar in Geldtasche“ / „bar aus Geldtasche“ – Bargeld der Festkassa: ändert den Kassabestand, zählt NICHT zum
//        Ergebnis (das Bargeld kommt erst mit der Bankeinzahlung ins Ergebnis, sonst wäre es doppelt)
//  „Überweisung“ – über ein Bankkonto: zählt zum Ergebnis (außer „zählt“ = nein, z. B. Pfand, Kaution),
//        ändert den Kassabestand nicht
//  „Bank“ – Wechselgeld abheben (−) und Bankeinzahlung/Ablieferung (+): zählt zum Ergebnis, ändert den Kassabestand
// Ergebnis = Bankeinzahlungen − Wechselgeld + Überweisungen (Einnahmen − Ausgaben)
export const ZAHLWEGE = { bar: 'bar in/aus Geldtasche', ueberweisung: 'Überweisung' };

/** Bezeichnung der Art wie im Excel: „bar in Geldtasche“, „bar aus Geldtasche“, „Überweisung“, „Bank“. */
export function zahlwegName(art, zahlweg) {
  if (art !== 'einnahme' && art !== 'ausgabe') return 'Bank';
  if (zahlweg === 'ueberweisung' || zahlweg === 'bank') return 'Überweisung';
  return art === 'einnahme' ? 'bar in Geldtasche' : 'bar aus Geldtasche';
}

/** Zahlungsweg, Ergebnis-Wirkung („zählt“) und ob die Position den Kassabestand ändert. */
export function postenInfo(p) {
  const fluss = p.art === 'einnahme' || p.art === 'ausgabe';
  const zahlweg = p.bank && fluss ? 'bank' : fluss ? (p.zahlweg === 'ueberweisung' ? 'ueberweisung' : 'bar') : 'bank';
  const ergebnis = !fluss || zahlweg === 'bank' || (zahlweg === 'ueberweisung' && p.ergebnis !== false);
  return { fluss, zahlweg, ergebnis, kassa: !fluss || zahlweg === 'bar', artName: zahlwegName(p.art, zahlweg) };
}

export const STUECKELUNG = [50000, 20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50, 20, 10, 5, 2, 1];

export function stueckelungSumme(st) {
  return STUECKELUNG.reduce((a, w) => a + w * (Number(st?.[w]) || 0), 0);
}

// ── Bankbuchungen und Festkassabuch ──────────────────────────────────────────
//
// Eine Bankbuchung (oder ein Teil davon) kann einer Veranstaltung zugeordnet werden:
//  festArt 'kassa' – Geld zwischen Bank und Festkassa: eine Abhebung (z. B. Wechselgeld) bringt Geld IN die
//                    Festkassa, eine Einzahlung (Erlös, Wechselgeld retour) ist eine Ablieferung AUS der Festkassa.
//                    Erscheint automatisch als Zeile im Festkassabuch, zählt nicht zum Ergebnis.
//  festArt 'bank'  – Einnahme/Ausgabe der Veranstaltung direkt über die Bank (Rechnung Getränke, SumUp …).
//                    Zählt zum Ergebnis, ändert den Kassabestand nicht.

export const FEST_ARTEN = {
  kassa: 'Geld zwischen Bank und Festkassa (Wechselgeld / Ablieferung)',
  bank: 'Einnahme/Ausgabe der Veranstaltung über die Bank',
};

const KASSA_WORT = /wechselgeld|erlos|bareinzahlung|einzahlung|ablieferung|festkassa|kassa retour/;

/**
 * Vorschlag, ob eine Bankbuchung Geld zwischen Bank und Festkassa ist oder eine Fest-Einnahme/-Ausgabe.
 * mitName: der Name der Veranstaltung steht im Text.
 */
export function festArtVorschlag(b, mitName = false) {
  const t = norm(b.text);
  if (KASSA_WORT.test(t)) return 'kassa';
  // Einzahlung ohne Auftraggeber mit dem Namen des Festes (z. B. „Zahlungsreferenz: Wiesnfest“) ist eine Bareinzahlung
  if (mitName && b.betrag > 0 && !splitBankText(b.text).partner) return 'kassa';
  return 'bank';
}

/** Sucht eine Veranstaltung, deren Name (ein markantes Wort, ohne Jahreszahl) im Bank-Text vorkommt. */
/** Suchbegriffe einer Veranstaltung: markante Wörter des Namens plus die eigenen „weiteren Suchbegriffe“. */
export function festBegriffe(v) {
  const wies = s => s.replace(/wiesenfest/g, 'wiesnfest');
  const ausName = wies(norm(v.name)).split(/[\s\-–/]+/)
    .filter(w => w.length >= 5 && !/^\d+$/.test(w) && !['feuerwehr', 'freiwillige'].includes(w));
  // weitere Suchbegriffe: mit Komma, Strichpunkt oder | getrennt; auch mehrere Wörter („Wechselgeld Fest“) erlaubt
  const eigene = String(v.suchbegriffe || '').split(/[,;|\n]+/).map(x => wies(norm(x))).filter(x => x.length >= 3);
  return [...new Set([...ausName, ...eigene])];
}

/**
 * Sucht die Veranstaltung, deren Name oder Suchbegriff im Bank-Text vorkommt.
 * Passen mehrere, gewinnt der längste (genaueste) Begriff; bei Gleichstand wird nichts zugeordnet.
 */
export function veranstaltungImText(text, veranstaltungen) {
  const t = norm(text).replace(/wiesenfest/g, 'wiesnfest');
  const enthaelt = b => (b.length >= 5 ? t.includes(b) : new RegExp(`(^|[^a-z0-9])${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(t));
  const treffer = (veranstaltungen || [])
    .map(v => ({ v, len: Math.max(0, ...festBegriffe(v).filter(enthaelt).map(b => b.length)) }))
    .filter(x => x.len > 0)
    .sort((a, b) => b.len - a.len);
  if (!treffer.length || (treffer[1] && treffer[1].len === treffer[0].len)) return null;
  return treffer[0].v;
}

/**
 * Zugeordnete Bankbuchungen beider Konten als Zeilen fürs Festkassabuch:
 *  'kassa' → Wechselgeld (Abhebung) bzw. Ablieferung (Einzahlung) – ändert den Kassabestand
 *  'bank'  → Einnahme/Ausgabe des Festes über die Bank – zählt zum Ergebnis, Kassabestand bleibt
 */
export function bankPosten(bankTeile) {
  return bankTeile.map(t => ({
    id: 'bank_' + (t.buchung?.id || ''),
    art: t.festArt === 'kassa' ? (t.betrag < 0 ? 'wechselgeld' : 'ablieferung') : (t.betrag < 0 ? 'ausgabe' : 'einnahme'),
    betrag: Math.abs(t.betrag),
    datum: t.buchung?.datum || '',
    zeit: '',
    text: (t.festArt === 'kassa'
      ? splitBankText(t.buchung?.text).zweck
      : [splitBankText(t.buchung?.text).partner, splitBankText(t.buchung?.text).zweck].filter(Boolean).join(' – ')
    ) .slice(0, 120) || (t.buchung?.text || '').slice(0, 120),
    bereich: '',
    bank: true,
    buchung: t.buchung,
  }));
}

/** Sortiert Posten chronologisch und rechnet den laufenden Kassabestand mit. */
const erfasst = p => (p.erfasstAm?.toMillis ? p.erfasstAm.toMillis() : Number(p.erfasstAm) || 0);

export function festkassaBuch(posten) {
  const sorted = [...posten].sort((a, b) =>
    (a.datum || '').localeCompare(b.datum || '') || (a.zeit || '').localeCompare(b.zeit || '')
    // gleiche Zeit: in der Reihenfolge der Erfassung (Bankzeilen am selben Tag zuerst)
    || erfasst(a) - erfasst(b) || (a.nr || 0) - (b.nr || 0));
  let bestand = 0;
  return sorted.map((p, i) => {
    const vz = POSTEN_ARTEN[p.art]?.vz || 0;
    const info = postenInfo(p);
    const betrag = vz * Math.abs(p.betrag || 0);       // Eingang (+) / Ausgang (−)
    const wirkung = info.kassa ? betrag : 0;            // Änderung des Kassabestands
    bestand += wirkung;
    // Vorzeichen wie im Excel (Sicht des Ergebnisses): Wechselgeld abheben = Ausgabe, Bankeinzahlung = Einnahme.
    // betragVz bleibt die Sicht der Geldtasche (Wechselgeld kommt hinein, Einzahlung geht hinaus).
    const betragErg = (p.art === 'wechselgeld' || p.art === 'ablieferung') ? -betrag : betrag;
    return { ...p, ...info, lfd: i + 1, betragVz: betrag, betragErg, wirkung, bestand };
  });
}

/**
 * Abrechnung einer Veranstaltung (wie im Excel: nur „Überweisung“ und „Bank“ zählen).
 * posten: im Festkassabuch eingetragene Posten; bankTeile: der Veranstaltung zugeordnete Bankbuchungs-Teile.
 * Bankteile 'kassa' sind Wechselgeld (−) bzw. Bankeinzahlung (+), Bankteile 'bank' Einnahmen/Ausgaben per Überweisung.
 * Bar-Positionen (in/aus Geldtasche) stehen nur zur Information drin – sie sind in der Bankeinzahlung enthalten.
 */
export function veranstaltungsAbrechnung(eigenePosten, alleBankTeile) {
  // Eine Bankbuchung, die schon mit einer Position verknüpft ist (z. B. Zahlung eines Sponsors), zählt nur einmal –
  // über die Position. Ist sie zusätzlich dem Fest zugeordnet, wird sie hier weggelassen.
  const verknuepftIds = new Set(eigenePosten.map(p => p.buchungId).filter(Boolean));
  const bankTeile = alleBankTeile.filter(t => !verknuepftIds.has(t.buchung?.id));
  const posten = [...eigenePosten, ...bankPosten(bankTeile)];
  const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
  const abs = p => Math.abs(p.betrag || 0);
  const mit = posten.map(p => ({ p, i: postenInfo(p) }));
  const pick = (art, f) => sum(mit.filter(x => x.p.art === art && f(x.i)), x => abs(x.p));
  const gruppe = f => {
    const m = new Map();
    for (const { p, i } of mit) {
      if (!f(p, i)) continue;
      const key = p.bereich || (p.art === 'einnahme' ? 'Einnahmen allgemein' : 'Ausgaben allgemein');
      if (!m.has(key)) m.set(key, { bereich: key, einnahmen: 0, ausgaben: 0 });
      m.get(key)[p.art === 'einnahme' ? 'einnahmen' : 'ausgaben'] += abs(p);
    }
    return [...m.values()].sort((a, b) => a.bereich.localeCompare(b.bereich, 'de'));
  };
  const bankRelevant = bankTeile.filter(t => t.festArt !== 'kassa');
  const r = {
    wechselgeld: pick('wechselgeld', () => true),
    ablieferung: pick('ablieferung', () => true),
    barEinnahmen: pick('einnahme', i => i.zahlweg === 'bar'),
    barAusgaben: pick('ausgabe', i => i.zahlweg === 'bar'),
    ueberwEinnahmen: pick('einnahme', i => i.ergebnis && i.zahlweg === 'ueberweisung'),
    ueberwAusgaben: pick('ausgabe', i => i.ergebnis && i.zahlweg === 'ueberweisung'),
    neutralEin: pick('einnahme', i => !i.ergebnis && i.zahlweg === 'ueberweisung'),
    neutralAus: pick('ausgabe', i => !i.ergebnis && i.zahlweg === 'ueberweisung'),
    bankEinnahmen: sum(bankRelevant.filter(t => t.betrag > 0), t => t.betrag),
    bankAusgaben: -sum(bankRelevant.filter(t => t.betrag < 0), t => t.betrag),
    // zählende Überweisungs-Positionen nach Bereich; Bar nach Bereich nur zur Information (Umsatz je Stand)
    bereiche: gruppe((p, i) => i.ergebnis && i.zahlweg === 'ueberweisung'),
    barBereiche: gruppe((p, i) => i.zahlweg === 'bar'),
  };
  r.einnahmen = r.ablieferung + r.ueberwEinnahmen + r.bankEinnahmen;
  r.ausgaben = r.wechselgeld + r.ueberwAusgaben + r.bankAusgaben;
  r.ergebnis = r.einnahmen - r.ausgaben;
  r.buch = festkassaBuch(posten);
  r.bestand = r.buch.length ? r.buch.at(-1).bestand : 0;
  // Mögliche Doppelerfassung: Überweisung im Festkassabuch UND gleiche Bankbuchung als Einnahme/Ausgabe zugeordnet
  r.doppelt = mit.filter(({ p, i }) => !p.buchungId && i.ergebnis && i.zahlweg === 'ueberweisung'
    && bankRelevant.some(t => Math.abs(t.betrag) === abs(p) && (t.betrag > 0) === (p.art === 'einnahme'))).map(x => x.p);
  // Bankbuchungen, die nur über den Sponsor zählen (zusätzlich dem Fest zugeordnet)
  r.verknuepft = alleBankTeile.filter(t => verknuepftIds.has(t.buchung?.id));
  // Eingetragene Transparent-Positionen, die es auch als Sponsor gibt
  r.doppeltSponsor = transparentAbgleich(eigenePosten.filter(p => !p.sponsor), eigenePosten.filter(p => p.sponsor))
    .filter(x => x.sponsor).map(x => ({ ...x.posten, sponsorName: x.sponsor.text }));
  return r;
}

/** Transparent-/Sponsor-Positionen des Festkassabuchs (Einnahme, Bereich „Transparente“ o. ä.) */
export const istTransparentPosten = p => p.art === 'einnahme' && /transparent|sponsor/i.test(p.bereich || '');

/**
 * Ordnet eingetragene Transparent-Positionen bestehenden Sponsoren zu (ähnlicher Name, jeder Sponsor nur einmal;
 * bei gleich gutem Namen gewinnt der gleiche Betrag). sponsoren: Einträge mit name oder text.
 * Ergebnis: [{ posten, sponsor | null }]
 */
export function transparentAbgleich(posten, sponsoren) {
  const tp = posten.filter(istTransparentPosten);
  const name = e => e.name ?? e.text ?? '';
  const paare = [];
  tp.forEach((p, i) => sponsoren.forEach(e => {
    const n = aehnlich(name(e), p.text || ''), gleich = e.betrag === p.betrag;
    // nur ein gemeinsames Wort (z. B. „Christian“ ↔ „Christopher“) reicht nur bei gleichem Betrag
    if (n >= 2 || (n === 1 && gleich)) paare.push({ i, e, n, gleich });
  }));
  paare.sort((a, b) => b.n - a.n || (b.gleich - a.gleich));
  const wahl = new Map(), vergeben = new Set();
  for (const x of paare) {
    const key = x.e.id ?? x.e.sponsorId;
    if (wahl.has(x.i) || vergeben.has(key)) continue;
    wahl.set(x.i, x.e); vergeben.add(key);
  }
  return tp.map((p, i) => ({ posten: p, sponsor: wahl.get(i) || null }));
}

// ── Bisheriges Festkassabuch (Excel) übernehmen ─────────────────────────────
//
// Erwartet eine Tabelle mit Kopfzeile „Datum | Text | Einnahmen | Ausgaben | (Zahlweg) | Betrag | Zählt“.
// Der Zahlweg steht in einer Spalte ohne Überschrift: „Überweisung“, „bar in/aus Geldtasche“, „Bank“.
// Zeilen „Summe …“ geben den darüberliegenden Zeilen ihren Bereich (z. B. „Summe Transparente“).
// Bankbewegungen (Wechselgeld abheben/zurück, Bareinzahlung) werden NICHT übernommen – sie kommen
// über die zugeordneten Bankbuchungen ins Festkassabuch.

const ZW_RE = { ueberweisung: /uberweis/, bar: /\bbar\b|geldtasche|kassa bar/, bank: /^bank\b/ };
const zahlwegAus = v => {
  const n = norm(v);
  if (!n) return '';
  if (ZW_RE.ueberweisung.test(n)) return 'ueberweisung';
  if (ZW_RE.bar.test(n)) return 'bar';
  if (ZW_RE.bank.test(n)) return 'bank';
  return '';
};

export function festkassaExcel(table, { datumStandard = '' } = {}) {
  const hi = table.findIndex(r => {
    const n = r.map(c => norm(c));
    return n.includes('text') && n.some(c => c.startsWith('einnahme')) && n.some(c => c.startsWith('ausgabe'));
  });
  if (hi < 0) return null;
  const h = table[hi].map(c => norm(c));
  const col = f => h.findIndex(f);
  const ci = {
    datum: col(c => c === 'datum'), text: col(c => c === 'text' || c === 'bezeichnung'),
    ein: col(c => c.startsWith('einnahme')), aus: col(c => c.startsWith('ausgabe')),
  };
  // Spalte „Zählt“ (JA/NEIN bzw. 1/0) – Überschrift in der Kopfzeile oder in der Zeile darüber
  const ueber = (table[hi - 1] || []).map(c => norm(c));
  const zaehltCol = [h, ueber].map(z => z.findIndex(c => c.startsWith('zahlt') || c === 'ja/nein')).find(x => x >= 0) ?? -1;
  const zaehlt = v => { const n = norm(v); return !(n === '0' || n === 'nein' || n === 'n'); };
  // Zahlweg-Spalte: die Spalte, in der am häufigsten „Überweisung“/„bar …“/„Bank“ steht
  const width = Math.max(...table.map(r => r.length));
  let zw = -1, best = 0;
  for (let c = 0; c < width; c++) {
    if (Object.values(ci).includes(c)) continue;
    const n = table.slice(hi + 1).filter(r => zahlwegAus(r[c])).length;
    if (n > best) { best = n; zw = c; }
  }
  const num = v => (v === '' || v == null ? 0 : parseAmount(v) || 0);
  const zeilen = [];
  for (let i = hi + 1; i < table.length; i++) {
    const r = table[i];
    const text = String(r[ci.text] ?? '').trim();
    const ein = num(r[ci.ein]), aus = num(r[ci.aus]);
    const d = r[ci.datum];
    // Zeilen ohne eigenes Datum bekommen das Datum der Veranstaltung
    const datum = (d instanceof Date ? isoLocal(d) : parseDate(d)) || datumStandard;
    if (/^ergebnis/i.test(norm(text))) break;          // darunter stehen nur noch Summen
    if (/^summe/i.test(norm(text))) {
      // Bereich für die Zeilen darüber: so weit nach oben, bis deren Beträge genau die Summe ergeben
      const art = ein ? 'einnahme' : 'ausgabe';
      const ziel = Math.abs(ein || aus);
      const bereich = text.replace(/^summe\s*/i, '').trim();
      if (ziel && bereich) {
        let acc = 0;
        for (let j = zeilen.length - 1; j >= 0; j--) {
          if (zeilen[j].art !== art || zeilen[j].skip) break;
          acc += zeilen[j].betrag;
          if (acc === ziel) { for (let k = j; k < zeilen.length; k++) if (!zeilen[k].bereich) zeilen[k].bereich = bereich; break; }
          if (acc > ziel) break;
        }
      }
      continue;
    }
    if (!text) continue;                                // Zeilen ohne Text sind Summen oder leer
    const zahlweg = zahlwegAus(r[zw]);
    for (const [art, betrag] of [['einnahme', ein], ['ausgabe', aus]]) {
      if (!betrag) continue;
      const z = { quellZeile: i + 1, datum, text, art, betrag: Math.abs(betrag), zahlweg: zahlweg === 'ueberweisung' ? 'ueberweisung' : 'bar', bereich: '',
        ergebnis: zahlweg === 'ueberweisung' ? (zaehltCol < 0 || r[zaehltCol] === '' || r[zaehltCol] == null || zaehlt(r[zaehltCol])) : false };
      if (zahlweg === 'bank' || (KASSA_WORT.test(norm(text)) && zahlweg !== 'bar')) {
        z.skip = 'Bankbewegung (Wechselgeld/Einzahlung) – bitte die Bankbuchung zuordnen 🏦';
      } else if (!zahlweg) {
        z.hinweis = 'Zahlweg fehlt – als bar übernommen';
      }
      zeilen.push(z);
    }
  }
  if (!zeilen.length) return { zeilen: [] };
  return { zeilen };
}

// ── Abgleich: Überweisungs-Positionen im Festkassabuch ↔ Bankbuchungen ─────
//
// Für jede Position mit Zahlweg „Überweisung“ wird die passende Bankbuchung (beide Konten) gesucht:
//  1. gleicher Betrag (bei mehreren: ähnlichster Text, dann nächstes Datum)
//  2. Summe mehrerer Buchungen desselben Auftraggebers/Empfängers (z. B. drei SumUp-Auszahlungen)
//  3. Summe mehrerer Buchungen vom selben Tag (z. B. sechs Getränke-Einkäufe)
//  4. Summe zweier Buchungen mit ähnlichem Text (z. B. zwei Brau-Union-Rechnungen)
// Findet sich nichts, wird die Buchung mit dem ähnlichsten Text als Abweichung gezeigt.
// Zusätzlich: Bankbuchungen, die das Fest nennen, aber keiner Position entsprechen.

const STOP = new Set(['online', 'banking', 'empfanger', 'auftraggeber', 'zahlungsreferenz', 'verwendungszweck', 'rechnung', 'pichl', 'feuerwehr',
  'freiwillige', 'gmbh', 'fur', 'furs', 'und', 'nummer', 'wiesenfest', 'wiesnfest', 'fest', 'festl', '2024', '2025', '2026', '2027']);
const woerter = t => new Set(norm(t).replace(/[^a-z0-9 ]+/g, ' ').split(' ')
  .filter(w => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w)));
const kompakt = t => norm(t).split(/[^a-z0-9]+/).filter(w => w && !STOP.has(w) && !['gmbh', 'co', 'kg', 'eu', 'ag'].includes(w)).join('');
export const aehnlich = (a, b) => {
  const wb = woerter(b);
  let n = 0;
  // kurze Firmennamen wie „EW-BAU“ oder „AKM“: zusammengeschrieben im Bank-Text enthalten
  const ka = kompakt(a), kb = kompakt(b);
  if (ka.length >= 3 && kb.includes(ka.slice(0, 8))) n++;
  for (const w of woerter(a)) if ([...wb].some(x => x.startsWith(w.slice(0, 5)) || w.startsWith(x.slice(0, 5))
    || (w.length >= 6 && x.length >= 6 && (w.includes(x) || x.includes(w))))) n++;
  return n;
};
const tageZwischen = (a, b) => Math.abs((new Date(a) - new Date(b)) / 864e5);

function teilsumme(kand, ziel, max = 8) {
  // kleine Teilsummensuche (Cent genau) über höchstens 14 Kandidaten
  const k = kand.slice(0, 14);
  let best = null;
  const rec = (i, rest, pick) => {
    if (best) return;
    if (rest === 0 && pick.length > 1) { best = [...pick]; return; }
    if (rest <= 0 || pick.length >= max || i >= k.length) return;
    rec(i + 1, rest - Math.abs(k[i].betrag), [...pick, k[i]]);
    rec(i + 1, rest, pick);
  };
  rec(0, ziel, []);
  return best;
}

export function bankAbgleich(posten, buchungen, v) {
  const von = v.von || v.bis, bis = v.bis || v.von;
  const imFenster = b => (!von || b.datum >= addTage(von, -60)) && (!bis || b.datum <= addTage(bis, 120));
  const frei = buchungen.filter(b => imFenster(b) && !b.splits?.length
    && (!b.veranstaltung || (b.veranstaltung === v.id && b.festArt !== 'kassa')));
  const benutzt = new Set();
  const zeilen = [];
  const ue = posten.filter(p => !p.bank && (p.art === 'einnahme' || p.art === 'ausgabe') && p.zahlweg === 'ueberweisung')
    .sort((a, b) => b.betrag - a.betrag);
  // zuerst alle genauen Treffer, damit Summen nicht die Einzelbuchungen „wegnehmen“:
  //  a) gleicher Betrag UND ähnlicher Name (bester Name gewinnt)  b) gleicher Betrag, Name egal
  let offenP = [];
  // fest verknüpfte Bankbuchung (z. B. bezahlte Sponsor-Rechnung) → direkt zuordnen
  const ohneLink = [];
  for (const p of ue) {
    const b = p.buchungId && buchungen.find(x => x.id === p.buchungId);
    if (b) { benutzt.add(b.id); zeilen.push({ posten: p, status: 'ok', buchungen: [b], sicher: true }); } else ohneLink.push(p);
  }
  ue.length = 0; ue.push(...ohneLink);
  const genau = (p, mitText) => {
    const vz = p.art === 'ausgabe' ? -1 : 1;
    return frei.filter(b => !benutzt.has(b.id) && b.betrag === vz * p.betrag && (!mitText || aehnlich(p.text, b.text) > 0))
      .sort((a, b) => aehnlich(p.text, b.text) - aehnlich(p.text, a.text) || tageZwischen(a.datum, p.datum) - tageZwischen(b.datum, p.datum));
  };
  for (const p of ue) {
    const k = genau(p, true)[0];
    if (k) { benutzt.add(k.id); zeilen.push({ posten: p, status: 'ok', buchungen: [k], sicher: true }); } else offenP.push(p);
  }
  offenP = offenP.filter(p => {
    const k = genau(p, false)[0];
    if (!k) return true;
    benutzt.add(k.id);
    zeilen.push({ posten: p, status: 'ok', buchungen: [k], sicher: false });
    return false;
  });
  for (const p of offenP) {
    const vz = p.art === 'ausgabe' ? -1 : 1;
    const kand = frei.filter(b => !benutzt.has(b.id) && Math.sign(b.betrag) === vz && Math.abs(b.betrag) < p.betrag);
    let treffer = null;
    // 2. gleicher Auftraggeber/Empfänger
    const gruppen = new Map();
    for (const b of kand) { const k = norm(splitBankText(b.text).partner); if (k) { if (!gruppen.has(k)) gruppen.set(k, []); gruppen.get(k).push(b); } }
    for (const g of gruppen.values()) if (!treffer && g.length > 1) treffer = teilsumme(g, p.betrag);
    // 3. gleicher Tag
    if (!treffer) {
      const tage = new Map();
      for (const b of kand) { if (!tage.has(b.datum)) tage.set(b.datum, []); tage.get(b.datum).push(b); }
      for (const g of tage.values()) if (!treffer && g.length > 1) treffer = teilsumme(g, p.betrag);
    }
    // 4. zwei Buchungen mit ähnlichem Text
    if (!treffer) {
      const aeh = kand.filter(b => aehnlich(p.text, b.text) > 0);
      for (let i = 0; i < aeh.length && !treffer; i++) for (let j = i + 1; j < aeh.length && !treffer; j++)
        if (Math.abs(aeh[i].betrag) + Math.abs(aeh[j].betrag) === p.betrag) treffer = [aeh[i], aeh[j]];
    }
    if (treffer) { treffer.forEach(b => benutzt.add(b.id)); zeilen.push({ posten: p, status: 'summe', buchungen: treffer, sicher: true }); continue; }
    // Abweichung: ähnlichster Text mit gleichem Vorzeichen
    const naechste = frei.filter(b => !benutzt.has(b.id) && Math.sign(b.betrag) === vz && aehnlich(p.text, b.text) > 0)
      .sort((a, b) => aehnlich(p.text, b.text) - aehnlich(p.text, a.text) || Math.abs(Math.abs(a.betrag) - p.betrag) - Math.abs(Math.abs(b.betrag) - p.betrag))[0];
    if (naechste) { benutzt.add(naechste.id); zeilen.push({ posten: p, status: 'diff', buchungen: [naechste], differenz: Math.abs(naechste.betrag) - p.betrag }); }
    else zeilen.push({ posten: p, status: 'fehlt', buchungen: [] });
  }
  // Bankbuchungen, die das Fest nennen, aber keiner Position entsprechen (und nicht schon zugeordnet sind)
  const offen = frei.filter(b => !benutzt.has(b.id) && !b.veranstaltung
    && (veranstaltungImText(b.text, [v]) || /\bfest(l|es)?\b/.test(norm(b.text))));
  const reihen = { diff: 0, fehlt: 1, summe: 2, ok: 3 };
  zeilen.sort((a, b) => reihen[a.status] - reihen[b.status] || (a.posten.datum || '').localeCompare(b.posten.datum || ''));
  return { zeilen, offen };
}
function addTage(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ── Sponsoring / Transparente ────────────────────────────────────────────────
//
// Je Veranstaltung: veranstaltungen/{id}/sponsoring/{sid}
//   { name, zusatz, strasse, plzOrt, email, leistung, betrag (Cent), zahlweg 'ueberweisung'|'bar',
//     status 'offen'|'bezahlt', bezahltAm, buchungId, rechnungsNr, rechnungsDatum, belege (Fotos) }
// Bezahlte Sponsoren erscheinen automatisch als Einnahme im Festkassabuch (Bereich „Transparente“).

/** Bezahlte Sponsoren als (nicht editierbare) Zeilen fürs Festkassabuch */
export function sponsorPosten(eintraege) {
  return (eintraege || []).filter(e => e.status === 'bezahlt' && e.betrag > 0).map(e => ({
    id: 'sp_' + e.id, sponsorId: e.id, sponsor: true,
    art: 'einnahme', betrag: e.betrag, datum: e.bezahltAm || e.rechnungsDatum || '', zeit: '',
    zahlweg: e.zahlweg === 'bar' ? 'bar' : 'ueberweisung', ergebnis: true,
    bereich: e.bereich || 'Transparente', text: e.name, beleg: e.rechnungsNr || '',
    buchungId: e.buchungId || '', belege: e.belege || [],
  }));
}

const kompaktNr = t => norm(t).replace(/[^a-z0-9]/g, '');

/**
 * Ordnet offene Sponsor-Rechnungen (Zahlweg Überweisung) Zahlungseingängen beider Konten zu.
 *  1. Rechnungsnummer steht im Bank-Text (z. B. „RE 2026-007“, „2026007“)
 *  2. gleicher Betrag und ähnlicher Name
 *  3. gleicher Betrag, Name passt nicht → nur Vorschlag (sicher: false)
 * buchungenVergeben: IDs, die schon einer Rechnung zugeordnet sind.
 */
export function sponsorZahlungen(eintraege, buchungen, buchungenVergeben = new Set()) {
  const frei = buchungen.filter(b => b.betrag > 0 && !buchungenVergeben.has(b.id) && !b.splits?.length
    && (!b.veranstaltung || b.festArt === 'bank'));
  const benutzt = new Set();
  const out = [];
  const offen = eintraege.filter(e => e.status !== 'bezahlt' && e.zahlweg !== 'bar' && e.betrag > 0);
  const nimm = (e, b, sicher, grund) => { benutzt.add(b.id); out.push({ eintrag: e, buchung: b, sicher, grund }); };
  const rest = [];
  for (const e of offen) {
    const nr = e.rechnungsNr && kompaktNr(e.rechnungsNr);
    const b = nr && nr.length >= 5 && frei.find(x => !benutzt.has(x.id) && kompaktNr(x.text).includes(nr));
    if (b) nimm(e, b, b.betrag === e.betrag, 'Rechnungsnummer'); else rest.push(e);
  }
  const rest2 = [];
  for (const e of rest) {
    const b = frei.filter(x => !benutzt.has(x.id) && x.betrag === e.betrag && aehnlich(e.name, x.text) > 0)
      .sort((a, c) => aehnlich(e.name, c.text) - aehnlich(e.name, a.text))[0];
    if (b) nimm(e, b, true, 'Betrag und Name'); else rest2.push(e);
  }
  const rest3 = [];
  for (const e of rest2) {
    const kand = frei.filter(x => !benutzt.has(x.id) && x.betrag === e.betrag
      && /transparent|sponsor|werb|banner/.test(norm(x.text)));
    if (kand.length === 1) nimm(e, kand[0], false, 'nur Betrag'); else rest3.push(e);
  }
  // 4. gleicher Name (Auftraggeber), aber anderer Betrag → Vorschlag; beim Bestätigen gilt der Betrag laut Bank
  for (const e of rest3) {
    const b = frei.filter(x => !benutzt.has(x.id) && aehnlich(e.name, splitBankText(x.text).partner) > 0)
      .sort((a, c) => aehnlich(e.name, splitBankText(c.text).partner) - aehnlich(e.name, splitBankText(a.text).partner))[0];
    if (b) nimm(e, b, false, 'Name passt, anderer Betrag');
  }
  return out;
}

/** Zahlungseingänge, die nach Sponsoring aussehen, aber keinem Sponsor zugeordnet sind → Vorschlag für neue Einträge */
export function sponsorKandidaten(buchungen, buchungenVergeben = new Set(), v = null) {
  return buchungen.filter(b => b.betrag > 0 && !buchungenVergeben.has(b.id) && !b.splits?.length
    && (!b.veranstaltung || (v && b.veranstaltung === v.id && b.festArt === 'bank'))
    && /transparent|sponsor|werbebeitrag|werbung|banner/.test(norm(b.text)))
    .map(b => {
      const { partner, zweck } = splitBankText(b.text);
      return { buchung: b, name: (partner || zweck || b.text).replace(/\s+(IBAN|BIC)\b.*$/i, '').slice(0, 120), betrag: b.betrag };
    });
}

// ── Sponsorenliste aus CSV/Excel ─────────────────────────────────────────────
//
// Mit Kopfzeile (Name/Firma, Betrag, Zahlweg, Zusatz/Ansprechpartner, Straße, PLZ, Ort bzw. PLZ Ort, E-Mail,
// Leistung, Status) oder ohne – dann wird erkannt: Textspalte = Name, Zahlenspalte = Betrag,
// Spalte mit „Überweisung“/„bar …“ = Zahlweg (so wie die bisherige Liste „Tabelle2“).

const SP_KOPF = [
  ['name', /^(name|firma|sponsor|unternehmen|bezeichnung|werbepartner)/],
  ['betrag', /^(betrag|summe|preis|euro|eur|€)/],
  ['zahlweg', /^(zahlweg|zahlung|zahlart|bezahlung|bezahlt per)/],
  ['zusatz', /^(zusatz|ansprech|z\.? ?h|kontakt|zu handen)/],
  ['strasse', /^(strasse|str\.?|adresse|anschrift)$/],
  ['plzOrt', /^(plz ?\/? ?ort|plz und ort)$/],
  ['plz', /^plz$/],
  ['ort', /^(ort|wohnort|gemeinde)$/],
  ['email', /^(e-?mail|mail)/],
  ['leistung', /^(leistung|art|werbung|beschreibung)$/],
  ['status', /^(status|bezahlt)$/],
];

export function sponsorTabelle(table) {
  const rows = table.filter(r => r.some(c => String(c ?? '').trim() !== ''));
  if (!rows.length) return { zeilen: [], kopf: false };
  // ein Festkassabuch (Spalten Einnahmen UND Ausgaben) ist keine Sponsorenliste
  if (rows.slice(0, 5).some(r => { const n = r.map(c => norm(c)); return n.some(c => c.startsWith('einnahme')) && n.some(c => c.startsWith('ausgabe')); })) {
    return { zeilen: [], kopf: false };
  }
  let hi = -1, map = {};
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    const m = {};
    rows[i].forEach((c, j) => { const n = norm(c); const k = SP_KOPF.find(([, re]) => re.test(n)); if (k && !(k[0] in m)) m[k[0]] = j; });
    if ('name' in m && Object.keys(m).length >= 2) { hi = i; map = m; break; }
  }
  const daten = rows.slice(hi + 1);
  if (hi < 0) {
    // ohne Kopfzeile: Spalten am Inhalt erkennen
    const breite = Math.max(...daten.map(r => r.length));
    const anteil = (j, f) => { const v = daten.map(r => r[j]).filter(x => String(x ?? '').trim() !== ''); return v.length ? v.filter(f).length / v.length : 0; };
    for (let j = 0; j < breite; j++) {
      const zahl = anteil(j, x => typeof x === 'number' || parseAmount(x) !== null);
      const zw = anteil(j, x => !!zahlwegAus(x));
      if (zw > 0.6 && !('zahlweg' in map)) map.zahlweg = j;
      else if (zahl > 0.6 && !('betrag' in map)) map.betrag = j;
      else if (zahl < 0.3 && zw < 0.3 && !('name' in map)) map.name = j;
    }
  }
  const get = (r, k) => (k in map ? r[map[k]] : '');
  const txt = (r, k) => String(get(r, k) ?? '').trim();
  const zeilen = [];
  for (const r of daten) {
    const name = txt(r, 'name');
    if (!name || /^(summe|gesamt|total|original)\b/i.test(norm(name))) continue;
    const roh = get(r, 'betrag');
    const betrag = roh === '' || roh == null ? null : (typeof roh === 'number' ? Math.round(roh * 100) : parseAmount(roh));
    const zwRoh = zahlwegAus(get(r, 'zahlweg'));
    if (betrag === null && !zwRoh && hi < 0) continue;            // ohne Kopfzeile: Zeile ohne Betrag/Zahlweg ist keine Sponsorzeile
    const st = norm(get(r, 'status'));
    zeilen.push({
      name: name.slice(0, 120), betrag: Math.abs(betrag || 0),
      zahlweg: zwRoh === 'bar' ? 'bar' : 'ueberweisung',
      zusatz: txt(r, 'zusatz'), strasse: txt(r, 'strasse'),
      plzOrt: txt(r, 'plzOrt') || [txt(r, 'plz'), txt(r, 'ort')].filter(Boolean).join(' '),
      email: txt(r, 'email'), leistung: txt(r, 'leistung'),
      bezahlt: /^(bezahlt|ja|x|erledigt|ok)/.test(st),
    });
  }
  return { zeilen, kopf: hi >= 0 };
}

/**
 * Vorschlag je Zahlungseingang ohne Sponsor: einem bestehenden offenen Sponsor zuordnen, neu anlegen oder offen lassen.
 *  - Name passt (beste Übereinstimmung, jeder Sponsor nur einmal) → bestehender Sponsor (auch bei anderem Betrag)
 *  - nur der Betrag passt zu offenen Sponsoren → nicht zuordnen, Auswahl durch die Kassierin/den Kassier
 *  - kein offener Sponsor kommt in Frage → neu anlegen
 */
export function ueberweisungVorschlaege(kandidaten, offeneSponsoren) {
  const paare = [];
  kandidaten.forEach((k, i) => offeneSponsoren.forEach(e => {
    const n = aehnlich(e.name, k.buchung.text);
    if (n > 0) paare.push({ i, e, n, gleich: e.betrag === k.betrag });
  }));
  paare.sort((a, b) => b.n - a.n || (b.gleich - a.gleich));
  const wahl = new Map(), vergeben = new Set();
  for (const p of paare) {
    if (wahl.has(p.i) || vergeben.has(p.e.id)) continue;
    wahl.set(p.i, { aktion: p.e.id, grund: p.gleich ? 'Name und Betrag passen' : `Name passt, Betrag ${p.e.betrag ? 'abweichend' : 'fehlt'} – Bank-Betrag wird übernommen` });
    vergeben.add(p.e.id);
  }
  return kandidaten.map((k, i) => {
    if (wahl.has(i)) return { ...k, ...wahl.get(i) };
    const gleich = offeneSponsoren.filter(e => !vergeben.has(e.id) && e.betrag === k.betrag);
    if (gleich.length) return { ...k, aktion: 'skip', grund: `${gleich.length} offene(r) Sponsor(en) mit gleichem Betrag – bitte auswählen`, gleicherBetrag: gleich.map(e => e.id) };
    return { ...k, aktion: 'neu', grund: 'kein passender offener Sponsor' };
  });
}

/** Platzhalter {name}, {fest}, {betrag} … in Vorlagen ersetzen */
export function fuelleVorlage(text, werte) {
  return String(text || '').replace(/\{(\w+)\}/g, (m, k) => (k in werte ? String(werte[k]) : m));
}

/** Nächste Rechnungsnummer im Format JJJJ-NNN */
export function rechnungsNummer(jahr, laufend) {
  return `${jahr}-${String(laufend).padStart(3, '0')}`;
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
