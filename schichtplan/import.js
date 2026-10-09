// Import des Grundplans aus CSV oder Excel.
//
// Unterstützte Layouts (automatisch erkannt):
//  1. Matrix:      Name | 01.10.2026 | 02.10.2026 | ...   (eine Zeile pro Mitarbeiter)
//  2. Transponiert: Datum | Anna | Ben | ...             (eine Zeile pro Tag)
//  3. Liste:       Datum | Mitarbeiter | Schicht         (eine Zeile pro Eintrag)
//
// Mitarbeiter werden über Name, Kürzel oder E-Mail zugeordnet (Groß/Klein egal).
// Leere Zellen sowie "-", "frei", "x", "/" bedeuten frei.

const FREE_VALUES = new Set(['', '-', '–', 'frei', 'x', '/', '0']);

export function pad(n) { return String(n).padStart(2, '0'); }

function norm(s) {
  return String(s ?? '').replace(/ß/g, 'ss').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

// ── Datei → 2D-Array ──────────────────────────────────────────────────────────

export function decodeText(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^﻿/, '');
  } catch {
    // Excel speichert CSV im deutschsprachigen Raum oft als Windows-1252
    return new TextDecoder('windows-1252').decode(buffer);
  }
}

export function parseCsv(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const count = ch => firstLine.split(ch).length - 1;
  const delim = [';', '\t', ','].sort((a, b) => count(b) - count(a))[0];

  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

export async function readRows(file, XLSX) {
  const buffer = await file.arrayBuffer();
  if (/\.(csv|txt|tsv)$/i.test(file.name)) return parseCsv(decodeText(buffer));
  if (!XLSX) throw new Error('Excel-Bibliothek nicht geladen.');
  const wb = XLSX.read(buffer, { type: 'array', cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' })
    .filter(r => r.some(c => String(c).trim() !== ''));
}

// ── Datumserkennung ───────────────────────────────────────────────────────────

// Liefert "YYYY-MM-DD" oder null. fallbackYear für Angaben wie "01.10." ohne Jahr.
export function parseDate(v, fallbackYear) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') {
    // Excel-Seriennummer (1900er-System)
    if (v < 20000 || v > 80000) return null;
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  if (v instanceof Date) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = s.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})?/);
  if (m) {
    let y = m[3] ? +m[3] : fallbackYear;
    if (y && y < 100) y += 2000;
    return y ? valid(y, +m[2], +m[1]) : null;
  }
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);  // US-Format M/D/YYYY
  if (m) return valid(+m[3], +m[1], +m[2]);
  return null;
}

function valid(y, mo, d) {
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return `${y}-${pad(mo)}-${pad(d)}`;
}

// ── Mitarbeiter-Zuordnung ─────────────────────────────────────────────────────

export function buildMatcher(users) {
  const map = new Map();
  // Nachname allein (z. B. "Grünbart"), sofern eindeutig
  const last = new Map();
  for (const u of users) {
    const ln = norm(u.name).split(' ').pop();
    if (ln) last.set(ln, last.has(ln) ? null : u.id);
  }
  for (const [ln, id] of last) if (id) map.set(ln, id);
  for (const u of users) {
    const keys = [u.name, u.email, u.short];
    const parts = norm(u.name).split(' ');
    if (parts.length > 1) {
      keys.push(`${parts.slice(1).join(' ')} ${parts[0]}`);          // "Muster Anna"
      keys.push(`${parts.slice(1).join(' ')}, ${parts[0]}`);         // "Muster, Anna"
    }
    for (const k of keys) if (k) map.set(norm(k), u.id);
  }
  return label => map.get(norm(label)) || null;
}

function normCode(v) {
  const s = String(v ?? '').trim();
  return FREE_VALUES.has(s.toLowerCase()) ? '' : s.toUpperCase().slice(0, 10);
}

// ── Layout-Erkennung + Auswertung ─────────────────────────────────────────────

// Ergebnis: { layout, entries: [{date, uid, code}], unmatched: [labels], from, to, codes: Set }
export function interpretRows(rows, users, fallbackYear) {
  if (!rows.length) throw new Error('Die Datei ist leer.');
  const match = buildMatcher(users);
  const entries = [];
  const unmatched = new Set();
  let layout = null;

  // Kopfzeile = erste Zeile (in den ersten 10), die nach Datumszeile oder Listenkopf aussieht
  for (let h = 0; h < Math.min(rows.length, 10) && !layout; h++) {
    const header = rows[h].map(c => norm(c));
    const dateCols = rows[h].map((c, i) => [i, parseDate(c, fallbackYear)]).filter(([, d]) => d);

    const iDate = header.findIndex(c => /^(datum|date|tag)$/.test(c));
    const iName = header.findIndex(c => /^(name|mitarbeiter(in)?|ma|person|e-?mail|kurzel|kuerzel)$/.test(c));
    const iCode = header.findIndex(c => /^(schicht|dienst|code|kurzel schicht|shift)$/.test(c));

    if (iDate >= 0 && iName >= 0 && iCode >= 0) {
      layout = 'Liste (Datum / Mitarbeiter / Schicht)';
      for (const r of rows.slice(h + 1)) {
        const date = parseDate(r[iDate], fallbackYear);
        if (!date) continue;
        const uid = match(r[iName]);
        if (!uid) { if (String(r[iName]).trim()) unmatched.add(String(r[iName]).trim()); continue; }
        entries.push({ date, uid, code: normCode(r[iCode]) });
      }
    } else if (dateCols.length >= 3) {
      layout = 'Matrix (Mitarbeiter je Zeile, Tage als Spalten)';
      const nameCol = rows[h].findIndex((c, i) => !parseDate(c, fallbackYear) && i < dateCols[0][0]);
      const nc = nameCol >= 0 ? nameCol : 0;
      for (const r of rows.slice(h + 1)) {
        const label = String(r[nc] ?? '').trim();
        if (!label) continue;
        const uid = match(label);
        if (!uid) { unmatched.add(label); continue; }
        for (const [i, date] of dateCols) entries.push({ date, uid, code: normCode(r[i]) });
      }
    } else {
      const userCols = rows[h].map((c, i) => [i, match(c)]).filter(([, u]) => u);
      const body = rows.slice(h + 1);
      const firstColDates = body.filter(r => parseDate(r[0], fallbackYear)).length;
      if (userCols.length >= 1 && firstColDates >= Math.max(1, body.length / 2)) {
        layout = 'Transponiert (Tage je Zeile, Mitarbeiter als Spalten)';
        rows[h].forEach((c, i) => {
          if (i > 0 && String(c).trim() && !match(c)) unmatched.add(String(c).trim());
        });
        for (const r of body) {
          const date = parseDate(r[0], fallbackYear);
          if (!date) continue;
          for (const [i, uid] of userCols) entries.push({ date, uid, code: normCode(r[i]) });
        }
      }
    }
  }

  if (!layout) {
    throw new Error('Format nicht erkannt. Erwartet wird eine Kopfzeile mit Datumsangaben '
      + '(z. B. "Name;01.10.2026;02.10.2026;…") oder die Spalten "Datum;Mitarbeiter;Schicht".');
  }
  if (!entries.length) throw new Error('Keine Einträge gefunden – stimmen die Mitarbeiternamen?');

  const dates = entries.map(e => e.date).sort();
  return {
    layout,
    entries,
    unmatched: [...unmatched],
    from: dates[0],
    to: dates[dates.length - 1],
    codes: new Set(entries.map(e => e.code).filter(Boolean)),
    employees: new Set(entries.map(e => e.uid)).size,
  };
}
