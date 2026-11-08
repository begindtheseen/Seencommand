// California time for everything Seen Command shows (owner, 2026-10-21: "get rid of UTC anywhere and
// everywhere — we are in California"). Intl handles PST/PDT; never format with toISOString for display.
export const PT = 'America/Los_Angeles';
const valid = (d) => { const x = d instanceof Date ? d : new Date(d); return Number.isNaN(x.getTime()) ? null : x; };
/** 'Oct 21, 6:04 AM' — the year only when it is not this year. */
export function formatPT(d, { now = new Date() } = {}) {
  const x = valid(d); if (!x) return '';
  const sameYear = new Intl.DateTimeFormat('en-US', { timeZone: PT, year: 'numeric' }).format(x) === new Intl.DateTimeFormat('en-US', { timeZone: PT, year: 'numeric' }).format(now);
  return new Intl.DateTimeFormat('en-US', { timeZone: PT, month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }), hour: 'numeric', minute: '2-digit' }).format(x);
}
/** 'YYYY-MM-DD' on the California calendar. */
export function ptDate(d = new Date()) { const x = valid(d); return x ? x.toLocaleDateString('en-CA', { timeZone: PT }) : ''; }
