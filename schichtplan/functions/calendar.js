// Kalender-Abo: aus Grundplan + Tauschen + Vertretungen + Abwesenheiten die Dienste
// einer Person als .ics berechnen. Reine Logik ohne Firebase (testbar mit `npm test`).
//
// WICHTIG: muss dieselben Regeln anwenden wie effectiveDay() in app.js.

const pad = n => String(n).padStart(2, '0');

export function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function dateRange(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

const codeParts = s => (s ? String(s).split('+').filter(Boolean) : []);

// data: { months: {'YYYY-MM': {days}}, swaps: [...], covers: [...], types: [...] }
// Ergebnis: Funktion date → { uid: code }
export function makePlan({ months = {}, swaps = [], covers = [], types = [] }) {
  const typeOf = code => types.find(t => String(t.code).toUpperCase() === String(code).toUpperCase());
  const isPlaceholder = code => !!typeOf(code)?.placeholder;
  const addCode = (cur, code) => [...codeParts(cur), ...codeParts(code)].join('+');
  const dropPlaceholder = cur => {
    const p = codeParts(cur);
    const i = p.findIndex(isPlaceholder);
    if (i >= 0) p.splice(i, 1);
    return p.join('+');
  };
  const removeCode = (cur, code) => {
    const p = codeParts(cur);
    for (const c of codeParts(code)) { const i = p.indexOf(c); if (i >= 0) p.splice(i, 1); }
    return p.join('+');
  };
  const ms = t => (t?.toMillis ? t.toMillis() : typeof t === 'number' ? t : 0);
  const events = [
    ...swaps.filter(s => s.status === 'accepted').map(s => ({ ...s, kind: 'swap', t: ms(s.decidedAt) })),
    ...covers.filter(c => c.status === 'assigned')
      .map(c => ({ ...c, coverKind: c.kind || 'vacation', kind: 'cover', t: ms(c.assignedAt) })),
  ].sort((a, b) => a.t - b.t);

  return date => {
    const day = { ...(months[date.slice(0, 7)]?.days?.[date] || {}) };
    for (const e of events) {
      if (e.kind === 'swap') {
        if (e.dateFrom !== date && e.dateTo !== date) continue;
        const a = day[e.from] || '', b = day[e.to] || '';
        day[e.from] = b; day[e.to] = a;
      } else if (e.date === date) {
        if (e.coverKind === 'release') day[e.absentUid] = removeCode(day[e.absentUid], e.code);
        day[e.assignee] = addCode(dropPlaceholder(day[e.assignee]), e.code);
      }
    }
    return day;
  };
}

const VAC = { U: 'Urlaub', ZA: 'Zeitausgleich', K: 'Krankenstand', FB: 'Fortbildung' };
const icsText = s => String(s).replace(/\\/g, '\\\\').replace(/[,;]/g, m => `\\${m}`).replace(/\n/g, '\\n');
const compact = d => d.replace(/-/g, '');

// Liefert den Kalender einer Person. stamp: Zeitstempel im Format 20261009T120000Z
export function buildIcs({ uid, name, dates, planFor, vacations = [], types = [], stamp }) {
  const typeOf = code => types.find(t => String(t.code).toUpperCase() === String(code).toUpperCase());
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Schichtplan//DE', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsText(`Schichtplan ${name || ''}`.trim())}`,
    'X-WR-TIMEZONE:Europe/Vienna',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H',
  ];
  const event = (id, start, end, summary, allDay) => {
    lines.push('BEGIN:VEVENT', `UID:${id}@schichtplan`, `DTSTAMP:${stamp}`);
    if (allDay) lines.push(`DTSTART;VALUE=DATE:${start}`, `DTEND;VALUE=DATE:${end}`);
    else lines.push(`DTSTART:${start}`, `DTEND:${end}`);
    lines.push(`SUMMARY:${icsText(summary)}`, 'TRANSP:OPAQUE', 'END:VEVENT');
  };
  const myVacs = vacations.filter(v => v.uid === uid);
  const vacOn = d => myVacs.find(v => v.from <= d && v.to >= d);

  for (const d of dates) {
    const v = vacOn(d);
    if (v) {
      event(`${compact(d)}-abw-${uid}`, compact(d), compact(addDays(d, 1)), VAC[v.type] || v.type, true);
      continue;
    }
    codeParts(planFor(d)[uid]).forEach((code, i) => {
      const tp = typeOf(code);
      const summary = tp?.label ? `${tp.label} (${code})` : `Dienst ${code}`;
      const id = `${compact(d)}-${i}-${uid}`;
      if (tp?.start && tp?.end) {
        const endDay = tp.end <= tp.start ? addDays(d, 1) : d;
        event(id, `${compact(d)}T${tp.start.replace(':', '')}00`, `${compact(endDay)}T${tp.end.replace(':', '')}00`, summary, false);
      } else {
        event(id, compact(d), compact(addDays(d, 1)), summary, true);
      }
    });
  }
  lines.push('END:VCALENDAR');
  // Zeilen > 75 Zeichen falten (RFC 5545)
  return lines.map(l => {
    if (l.length <= 75) return l;
    const parts = [l.slice(0, 75)];
    for (let i = 75; i < l.length; i += 74) parts.push(` ${l.slice(i, i + 74)}`);
    return parts.join('\r\n');
  }).join('\r\n') + '\r\n';
}
