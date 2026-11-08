// The 1%-a-day loop: every California day, ONE small concrete improvement to Seen — product, content, SEO,
// data quality or distribution — sized for that day (weekdays ~30 min, weekends ~15), with the compounding
// metric it should move. A streak keeps the habit honest; the weekly review shows what compounded, from
// the real admin-stats snapshots the plan records. Rule: one_percent (James Clear, "Atomic Habits").
import { readDoc, writeDoc } from './store.mjs';
import { ptToday, addDays, weekdayIndex, mondayOf, daysBetween } from './pt.mjs';
import { rule } from './rules.mjs';

export const LANES = {
  product: { name: 'Product', rule: 'activation_first' },
  content: { name: 'Content', rule: 'founder_content' },
  seo: { name: 'SEO', rule: 'compounding_seo' },
  data: { name: 'Data quality', rule: 'honest_numbers' },
  distribution: { name: 'Distribution', rule: 'dont_scale' },
};

// who: 'app' = the app drafts it, Brandon approves · 'brandon' = human-only · 'agent' = a small PR task.
export const CATALOG = [
  { id: 'activation-metric', lane: 'product', minutes: 20, who: 'agent', moves: 'activation (measured at all)', title: 'Make activation measurable',
    detail: 'File a small Seen task: admin-stats reports "new users who, in their first week, tracked an application, checked a company or reported an outcome".' },
  { id: 'first-visit-audit', lane: 'product', minutes: 30, who: 'brandon', moves: 'activation', title: 'Walk the first visit on a phone',
    detail: 'Search a company → open its page → try to report. Write down the first place it asks for too much, and file ONE fix.' },
  { id: 'empty-state-ask', lane: 'product', minutes: 25, who: 'agent', moves: 'reports', title: 'One-tap ask on a "not enough data" page',
    detail: 'Pick one company page under the grade gate and make its report ask one tap (prefilled /report?company=… link).' },
  { id: 'share-card-cta', lane: 'product', minutes: 25, who: 'brandon', moves: 'card shares', title: 'Make sharing an outcome card one tap',
    detail: 'Share a card from the tracker on a phone; note every extra step and file the one that hurts most.' },
  { id: 'prep-moment', lane: 'product', minutes: 30, who: 'agent', moves: 'Interview Prep sales', title: 'Make the Interview Prep offer land at the interview',
    detail: 'Walk a tracked application to the interview stage on a phone: the Prep offer and its free preview must appear on the card and the dashboard\'s next move. File the one step that loses people (owner decision 2026-10-25: Prep is the lead product).' },
  { id: 'ghost-report-draft', lane: 'content', minutes: 30, who: 'app', moves: 'reach', title: 'Draft this week\'s Ghost Report',
    detail: 'Open Growth → Calendar → this week\'s Ghost Report item → Draft. Approve one variant; the numbers are live callouts with sources.' },
  { id: 'clip-script', lane: 'content', minutes: 30, who: 'app', moves: 'reach', title: 'One 30-second clip script',
    detail: 'Draft a short-video script (hook / beats / CTA) for the week\'s clip item; record it when you have 10 minutes.' },
  { id: 'reply-bank', lane: 'content', minutes: 20, who: 'brandon', moves: 'trust', title: 'Three reusable helpful replies',
    detail: 'Write 3 genuinely helpful answers to questions r/recruitinghell asks every week — no links. Save them as notes.' },
  { id: 'card-design', lane: 'content', minutes: 15, who: 'app', moves: 'reach', title: 'One data card from a real number',
    detail: 'Growth → Ad designer → Data callout with a live callout; export the PNG for the next post.' },
  { id: 'agency-to-grade', lane: 'seo', minutes: 30, who: 'brandon', moves: 'graded agencies', title: 'Push one agency toward a grade',
    detail: 'On /agencies, pick an agency "building a record" (1–4 reports) and send 3 DMs to people who publicly posted about being ghosted by it.' },
  { id: 'company-question', lane: 'seo', minutes: 25, who: 'agent', moves: 'search traffic', title: 'Answer "Does X ghost applicants?"',
    detail: 'File a small Seen task: a plain-language answer block on one company page with ≥20 reports, worded like the question people search.' },
  { id: 'internal-links', lane: 'seo', minutes: 15, who: 'agent', moves: 'search traffic', title: 'Link the Ghost Report to the pages it cites',
    detail: 'Every company named in the latest Ghost Report links to its company page (and agencies to /agencies).' },
  { id: 'compare-pair', lane: 'seo', minutes: 20, who: 'brandon', moves: 'search traffic', title: 'One comparison people search for',
    detail: 'Pick two employers in the same field that both pass the grade gate and share their /compare link in one helpful reply.' },
  { id: 'held-queue', lane: 'data', minutes: 20, who: 'brandon', moves: 'trust', title: 'Clear 10 held reports',
    detail: 'Admin → Community → Reports awaiting review: approve or reject 10 rows (each decision is audited).' },
  { id: 'thin-companies', lane: 'data', minutes: 10, who: 'app', moves: 'reports', title: 'Fill the thinnest companies',
    detail: 'Run the "reports:thinnest" preset (Search tab, or `node scripts/act.mjs preset reports:thinnest`) for public first-hand accounts.' },
  { id: 'dupe-scan', lane: 'data', minutes: 10, who: 'brandon', moves: 'trust', title: 'Run the duplicate-report scan',
    detail: 'Admin → Community → Duplicate reports: scan and mark copies, so no grade counts a report twice.' },
  { id: 'stale-check', lane: 'data', minutes: 10, who: 'app', moves: 'listing trust', title: 'Check listings are fresh',
    detail: 'Jobs tab: stale listings should be a small share; if not, run the maintenance preset.' },
  { id: 'dm-5', lane: 'distribution', minutes: 25, who: 'brandon', moves: 'reports · users', title: 'Five one-to-one outreach DMs',
    detail: 'Five people who posted a ghosting story today (OUTREACH_SCRIPTS.md script 1 or 2; personalise the first line; one message, no follow-up).' },
  { id: 'reply-10', lane: 'distribution', minutes: 20, who: 'brandon', moves: 'trust', title: 'Ten helpful comments, no links',
    detail: 'Answer ten r/recruitinghell posts as yourself. Mention Seen only if someone asks — and say you are the founder.' },
  { id: 'creator-ask', lane: 'distribution', minutes: 15, who: 'app', moves: 'creator mentions', title: 'Send one creator this week\'s angle',
    detail: 'Growth → Story angles: send one creator the angle that fits them, with its citable number and link. No ask for payment, no script.' },
  { id: 'linkedin-point', lane: 'distribution', minutes: 15, who: 'app', moves: 'reach', title: 'One LinkedIn data point',
    detail: 'Post one live callout with its source line (draft it from the calendar item).' },
  { id: 'employer-email', lane: 'distribution', minutes: 20, who: 'brandon', moves: 'employer replies', title: 'Three badge-pitch emails',
    detail: 'Template 1 (OUTREACH_SCRIPTS.md) to three employers whose data looks good. Money never changes a score — say so if asked.' },
];

// Monday review → data; Tue content; Wed SEO; Thu product; Fri distribution; weekend: light content / data.
const WEEKDAY_LANE = ['data', 'content', 'seo', 'product', 'distribution', 'distribution', 'content'];

const EMPTY = { days: {} };
const hash = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };

/** Which lane a day works on. Behind plan → Tue/Thu become distribution; activation unmeasured → Thursday's product item makes it measurable first. */
export function laneFor(day, { behind = false } = {}) {
  const wd = weekdayIndex(day); let lane = WEEKDAY_LANE[wd];
  if (behind && (wd === 1 || wd === 3)) lane = 'distribution';
  return lane;
}

/** Pick the day's item: stable for the day, never one done in the last 14 days if another exists. */
export function pickItem(day, { days = {}, behind = false, activationUnmeasured = true } = {}) {
  const lane = laneFor(day, { behind });
  const weekend = weekdayIndex(day) >= 5;
  const recent = new Set(Object.entries(days).filter(([d, r]) => r.status === 'done' && daysBetween(d, day) > 0 && daysBetween(d, day) <= 14).map(([, r]) => r.itemId));
  let pool = CATALOG.filter((c) => c.lane === lane && (!weekend || c.minutes <= 20));
  if (!pool.length) pool = CATALOG.filter((c) => c.lane === lane);
  const everDone = new Set(Object.values(days).filter((r) => r.status === 'done').map((r) => r.itemId));
  if (lane === 'product' && activationUnmeasured && !everDone.has('activation-metric')) return CATALOG.find((c) => c.id === 'activation-metric');
  const fresh = pool.filter((c) => !recent.has(c.id));
  const list = fresh.length ? fresh : pool;
  return list[hash(day) % list.length];
}

const view = (day, rec) => { const c = CATALOG.find((x) => x.id === rec.itemId) || {}; return { day, ...c, ...rec, laneName: LANES[rec.lane]?.name || rec.lane, rule: rule('one_percent'), laneRule: rule(LANES[rec.lane]?.rule || 'one_percent') }; };

/** Today's item (created and stored on first ask, so it does not change during the day). */
export function todayItem({ day = ptToday(), behind = false, activationUnmeasured = true } = {}) {
  const doc = readDoc('daily', EMPTY);
  if (!doc.days[day]) {
    const c = pickItem(day, { days: doc.days, behind, activationUnmeasured });
    doc.days[day] = { itemId: c.id, lane: c.lane, title: c.title, status: 'open', createdAt: new Date().toISOString() };
    writeDoc('daily', doc);
  }
  return view(day, doc.days[day]);
}

export function markDaily(day, status = 'done', { note = '', now = new Date() } = {}) {
  if (!['done', 'skipped', 'open'].includes(status)) return { ok: false, error: 'status is done, skipped or open' };
  const doc = readDoc('daily', EMPTY);
  if (!doc.days[day]) { const c = pickItem(day, { days: doc.days }); doc.days[day] = { itemId: c.id, lane: c.lane, title: c.title, status: 'open', createdAt: now.toISOString() }; }
  doc.days[day] = { ...doc.days[day], status, note: String(note || '').slice(0, 500), doneAt: status === 'done' ? now.toISOString() : null };
  writeDoc('daily', doc);
  return { ok: true, item: view(day, doc.days[day]), streak: streak(doc.days, day) };
}

/**
 * The streak: consecutive DONE days ending today — or ending yesterday while today is still open (the
 * streak is alive until the day ends). `best` is the longest run ever. Skipped breaks a streak.
 */
export function streak(days = {}, today = ptToday()) {
  const done = (d) => days[d]?.status === 'done';
  let end = done(today) ? today : addDays(today, -1);
  let current = 0; while (done(end)) { current++; end = addDays(end, -1); }
  const alive = done(today) || (current > 0 && days[today]?.status !== 'skipped');
  const sorted = Object.keys(days).filter(done).sort();
  let best = 0, run = 0, prev = null;
  for (const d of sorted) { run = prev && daysBetween(prev, d) === 1 ? run + 1 : 1; best = Math.max(best, run); prev = d; }
  const wk = mondayOf(today);
  const doneThisWeek = Array.from({ length: 7 }, (_, i) => addDays(wk, i)).filter(done).length;
  return { current, best, alive, doneThisWeek, compounding: Math.round((Math.pow(1.01, current) - 1) * 1000) / 10 };
}

/** What compounded in a week: done items by lane, and how the metrics they target moved (real snapshots). */
export function weeklyReview({ weekStart = mondayOf(ptToday()), days = readDoc('daily', EMPTY).days, snapshots = [] } = {}) {
  const dates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const items = dates.map((d) => days[d] ? view(d, days[d]) : null).filter(Boolean);
  const done = items.filter((i) => i.status === 'done');
  const byLane = Object.fromEntries(Object.keys(LANES).map((l) => [l, done.filter((i) => i.lane === l).map((i) => i.title)]));
  const [a, b] = snapshots; // [before, after] actuals snapshots, either may be null
  const delta = (k) => (a && b && a[k] != null && b[k] != null ? b[k] - a[k] : null);
  const metrics = a && b ? { users: delta('users'), dau: delta('dau'), reports: delta('reportsTotal'), shares: delta('shares'), paid: delta('paid') } : null;
  const lines = [];
  if (!done.length) lines.push('No 1% items done this week — the habit is the product; restart with today\'s item.');
  else lines.push(`${done.length} of 7 days improved Seen (${Object.entries(byLane).filter(([, v]) => v.length).map(([l, v]) => `${LANES[l].name} ${v.length}`).join(', ')}).`);
  if (metrics) {
    const moved = Object.entries(metrics).filter(([, v]) => v != null && v !== 0).map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${v}`);
    lines.push(moved.length ? `Moved since last check: ${moved.join(', ')}.` : 'The compounding metrics did not move yet — keep the items pointed at distribution until they do.');
  } else lines.push('No two admin-stats snapshots for this week yet, so the metric movement is unknown (not guessed).');
  return { weekStart, items, done: done.length, byLane, metrics, lines };
}

export function dailyHistory() { return readDoc('daily', EMPTY).days; }
