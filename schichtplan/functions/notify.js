// Wer bekommt bei welchem Ereignis welche Nachricht?
// Reine Logik ohne Firebase-Abhängigkeit (testbar mit `npm test`).
// Ergebnis: Liste von { to: uid, title, body, view } – "view" ist der Tab, der beim Antippen öffnet.

const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

export function fmtDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const wd = WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${wd} ${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.`;
}

const code = c => c || 'frei';

function swapText(s) {
  return s.dateFrom === s.dateTo
    ? `${fmtDate(s.dateFrom)}: ${code(s.fromCode)} ⇄ ${code(s.toCode)}`
    : `${fmtDate(s.dateFrom)} (${code(s.fromCode)}) gegen ${fmtDate(s.dateTo)} (${code(s.toCode)})`;
}

// name: uid → Anzeigename
export function swapCreated(s, name) {
  return [{
    to: s.to,
    title: `Tauschanfrage von ${name(s.from)}`,
    body: swapText(s) + (s.note ? `\n„${s.note}“` : ''),
    view: 'swaps',
  }];
}

export function swapUpdated(before, after, name) {
  if (before.status === after.status) return [];
  const text = swapText(after);
  switch (after.status) {
    case 'accepted':
      return [{ to: after.from, title: `${name(after.to)} hat den Tausch angenommen ✅`, body: text, view: 'mine' }];
    case 'rejected':
      return [{ to: after.from, title: `${name(after.to)} hat den Tausch abgelehnt`, body: text, view: 'swaps' }];
    case 'cancelled':
      // Nur benachrichtigen, wenn jemand anderes als die angefragte Person zurückzieht
      return after.decidedBy === after.to ? [] : [{
        to: after.to, title: `Tauschanfrage von ${name(after.from)} zurückgezogen`, body: text, view: 'swaps',
      }];
    case 'reverted':
      return [after.from, after.to].map(to => ({
        to, title: 'Tausch wurde von der Teamleitung rückgängig gemacht', body: text, view: 'mine',
      }));
    default:
      return [];
  }
}

const VAC = { U: 'Urlaub', ZA: 'Zeitausgleich', K: 'Krankenstand', FB: 'Fortbildung' };

const shiftList = covers => covers.map(c => `${fmtDate(c.date)} ${c.code}`).join(', ');

// adminIds: alle aktiven Admins
// covers: die mit dem Urlaub angelegten Vertretungen
// candidates(date) → uids, die den Dienst übernehmen könnten (alle Aktiven, die nicht abwesend sind)
export function vacationCreated(v, name, adminIds, covers = [], candidates = () => []) {
  const range = v.from === v.to ? fmtDate(v.from) : `${fmtDate(v.from)} – ${fmtDate(v.to)}`;
  const label = VAC[v.type] || v.type;
  const open = covers.filter(c => c.status === 'open').sort((a, b) => a.date.localeCompare(b.date));
  const assigned = covers.filter(c => c.status === 'assigned').sort((a, b) => a.date.localeCompare(b.date));
  const summary = open.length ? ` · ${open.length} Dienst(e) offen` : '';

  const out = adminIds
    .filter(id => id !== v.createdBy && id !== v.uid)
    .map(to => ({ to, title: `${label}: ${name(v.uid)}`, body: range + summary + (v.note ? ` · ${v.note}` : ''), view: open.length ? 'open' : 'vacation' }));
  if (v.createdBy !== v.uid) {
    out.push({ to: v.uid, title: `${label} für dich eingetragen`, body: `${range} (von ${name(v.createdBy)})`, view: 'vacation' });
  }

  // Zugeteilte Vertretungen: eine Nachricht pro Person
  const byAssignee = new Map();
  for (const c of assigned) byAssignee.set(c.assignee, [...(byAssignee.get(c.assignee) || []), c]);
  for (const [to, cs] of byAssignee) {
    out.push({ to, title: `Du vertrittst ${name(v.uid)} (${label})`, body: shiftList(cs), view: 'mine' });
  }

  // Offene Dienste: jede Person einmal mit den Tagen, die sie übernehmen könnte
  const byFree = new Map();
  for (const c of open) {
    for (const uid of candidates(c.date)) {
      if (uid === v.uid || uid === v.createdBy) continue;
      byFree.set(uid, [...(byFree.get(uid) || []), c]);
    }
  }
  for (const [to, cs] of byFree) {
    out.push({ to, title: `Offene Dienste – ${name(v.uid)} hat ${label}`, body: `${shiftList(cs)} · jetzt übernehmen?`, view: 'open' });
  }
  return out;
}

// Jemand gibt einen eigenen Dienst ab → alle anderen, die an dem Tag nicht abwesend sind
export function releaseCreated(c, name, candidateIds) {
  return candidateIds.filter(uid => uid !== c.absentUid).map(to => ({
    to, title: `${name(c.absentUid)} gibt einen Dienst ab`, body: `${fmtDate(c.date)} ${c.code} · übernehmen?`, view: 'open',
  }));
}

// Offener Dienst wurde übernommen bzw. zugeteilt
export function coverUpdated(before, after, name) {
  const text = `${fmtDate(after.date)} ${after.code}`;
  // Admin hat Vertretung wieder geöffnet
  if (after.status === 'open' && before.status === 'assigned' && before.assignee) {
    return [{ to: before.assignee, title: 'Vertretung entfällt', body: `${text} – Dienst ist wieder offen`, view: 'mine' }];
  }
  if (after.status !== 'assigned' || before.assignee === after.assignee) return [];
  const out = [];
  if (after.assignedBy !== after.absentUid) {
    out.push({ to: after.absentUid, title: `${name(after.assignee)} übernimmt deinen Dienst`, body: text, view: after.kind === 'release' ? 'mine' : 'vacation' });
  }
  if (after.assignedBy !== after.assignee) {
    out.push({ to: after.assignee, title: `Dir zugeteilt: Dienst von ${name(after.absentUid)}`, body: `${text} (von ${name(after.assignedBy)})`, view: 'mine' });
  }
  if (before.status === 'assigned' && before.assignee && before.assignee !== after.assignee) {
    out.push({ to: before.assignee, title: 'Vertretung entfällt', body: `${text} – wurde neu vergeben`, view: 'mine' });
  }
  return out;
}

// Urlaub gelöscht → Vertretung entfällt
export function coverDeleted(c, name) {
  if (c.status !== 'assigned' || !c.assignee) return [];
  return [{ to: c.assignee, title: `Übernommener Dienst von ${name(c.absentUid)} entfällt`, body: `${fmtDate(c.date)} ${c.code} – wurde zurückgenommen`, view: 'mine' }];
}
