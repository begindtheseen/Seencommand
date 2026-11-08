// California calendar math for the Growth Studio. Every calendar day here is a PACIFIC day (owner,
// 2026-10-21: "we are in California"). Days are 'YYYY-MM-DD' strings and all day arithmetic is done on
// the calendar (noon-UTC anchors), never by adding 24 h to a timestamp — so a week that crosses a DST
// change still has 7 days and a 9:00 AM post stays 9:00 AM Pacific on both sides of it.
export const PT = 'America/Los_Angeles';
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export const isDay = (s) => DAY_RE.test(String(s || '')) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`));
/** Today (or the given instant) on the California calendar, 'YYYY-MM-DD'. */
export function ptToday(now = new Date()) { return new Date(now).toLocaleDateString('en-CA', { timeZone: PT }); }
const anchor = (day) => { if (!isDay(day)) throw new Error(`not a calendar day: ${day}`); return new Date(`${day}T12:00:00Z`); };
/** day + n calendar days. */
export function addDays(day, n) { const d = anchor(day); d.setUTCDate(d.getUTCDate() + Number(n || 0)); return d.toISOString().slice(0, 10); }
/** Whole calendar days from a to b (b − a). */
export function daysBetween(a, b) { return Math.round((anchor(b) - anchor(a)) / 86400000); }
/** 0 = Monday … 6 = Sunday. */
export function weekdayIndex(day) { return (anchor(day).getUTCDay() + 6) % 7; }
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/** The Monday that starts day's week. */
export function mondayOf(day) { return addDays(day, -weekdayIndex(day)); }
/** 'Oct 26' / 'Mon Oct 26' for a calendar day. */
export function dayLabel(day, { weekday = false } = {}) {
  const d = anchor(day);
  const s = d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
  return weekday ? `${WEEKDAYS[weekdayIndex(day)]} ${s}` : s;
}
// UTC offset (minutes) of California at an instant.
function offsetMinutes(at) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: PT, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(at).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]));
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((asUtc - at.getTime()) / 60000);
}
/** The real instant of a wall-clock time on a California day ('2026-11-02', '09:00') → ISO string. */
export function ptInstant(day, hhmm = '09:00') {
  const [h, m] = String(hhmm).split(':').map(Number);
  const guess = Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10), h, m || 0);
  // Two passes settle the offset even on the day of a change (the hour is never inside the gap at 9 AM).
  let t = guess - offsetMinutes(new Date(guess)) * 60000;
  t = guess - offsetMinutes(new Date(t)) * 60000;
  return new Date(t).toISOString();
}
/** 'Oct 21, 9:05 AM' for an instant, California time. */
export function ptStamp(at) {
  const d = new Date(at); if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', { timeZone: PT, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
