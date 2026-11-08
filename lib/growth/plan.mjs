// The plan to 1,000 users — phases, weekly targets, channels, the owner's weekly time budget and dated
// kill-gates, checked every week against REAL admin-stats numbers. Built on the approved Operation 50%
// playbook (seen repo playbook/): its Day-90 gates G1–G6 and its month-6 marker ($200–500 a month) are used
// as written; the user milestones (100 → 350 → 1,000) are this plan's own goals, not benchmarks.
//
// Money (Seen owner decisions 2026-10-25): Seen sells ONE-TIME products — Interview Prep $9.99 at the
// interview moment and the 30-day Job Search Pass $19.99. Nothing renews (subscriptions, the no-card trial,
// the Credit Pack and the Interview Sprint are retired), so the money line is revenue in the last 30 days
// from Seen's revenue funnel, and "paid" is paying customers in those 30 days. The playbook's dollar
// markers are kept as monthly revenue (decided 2026-10-28 when the owner handed these calls over).
//
// Every recommendation names the playbook rule that drove it (lib/growth/rules.mjs).
// Numbers: targets are goals; actuals come only from admin-stats. When admin-stats is unreachable or its
// data is degraded, the check says "unknown" — it never guesses.
import { readDoc, writeDoc, updateDoc } from './store.mjs';
import { ptToday, addDays, daysBetween, mondayOf, isDay, dayLabel } from './pt.mjs';
import { rule, cite } from './rules.mjs';

export const GOAL_USERS = 1000;
export const INTERVIEW_PREP_USD = 9.99; // seen repo lib/server/creditRules.js ONE_TIME_SKUS.interview — the lead product
export const DEFAULT_WEEKS = 26;

export const PHASES = [
  { id: 'atomic', name: 'Atomic network', weeks: [1, 6], users: 100, activationGoal: 0.3,
    goal: 'The first 100 users, recruited by hand inside the beachhead; the first visit reliably reaches a useful moment.',
    rules: ['beachhead', 'dont_scale', 'activation_first'],
    channels: ['reddit', 'dm', 'seo'], ownerHours: 6,
    moves: ['15 min/day of real r/recruitinghell presence (comments, no links unless asked)', '10–15 DMs/week to people who publicly posted a ghosting story (OUTREACH_SCRIPTS.md script 1/2)', 'Weekly Ghost Report from week 3 (honest-small title while N is small)', 'Fix one first-visit leak per week (1%-a-day product items)'] },
  { id: 'loop', name: 'The beachhead loop', weeks: [7, 14], users: 350, activationGoal: 0.4,
    goal: 'A weekly loop that brings users without Brandon pushing every one: Ghost Report → lookups → reports → cards → shares; first dollar by day 90.',
    rules: ['founder_content', 'weekly_retention', 'kill_gates', 'promotable'],
    channels: ['reddit', 'linkedin', 'short-video', 'creators', 'seo', 'email'], ownerHours: 7,
    moves: ['Ghost Report every week + 2 demo clips (CONTENT_ENGINE.md scripts A/B)', 'Creator kit: citable agency numbers + lookup links, offered to 3 creators a week', 'Outcome email loop (day 7/14/30) as the retention channel', 'Employer outreach 10/week (badge pitch to good scorers first)'] },
  { id: 'compound', name: 'Compounding', weeks: [15, 26], users: 1000, activationGoal: 0.5,
    goal: 'Assets that keep bringing users on their own: company and agency pages ranking, creators citing Seen, cards being shared; first steady revenue.',
    rules: ['compounding_seo', 'focus_channel', 'distinctive_assets'],
    channels: ['seo', 'creators', 'reddit', 'short-video', 'linkedin', 'email', 'paid-test'], ownerHours: 7,
    moves: ['Double the one channel that produced the most sessions; cut the bottom half of formats (monthly retro)', 'One new comparison or agency page a week where reports exist', 'A $50 paid boost of the best organic post ONLY if G2 hit (simulate first)', 'Second niche only if G1 hit (reallocation rule)'] },
];

export const CHANNELS = {
  reddit: { name: 'Reddit (r/recruitinghell + adjacent)', why: 'The beachhead lives there; value-first posts and replies.', rule: 'beachhead' },
  dm: { name: 'One-to-one DMs', why: 'Only to people who publicly posted being ghosted; one message, no follow-up.', rule: 'dont_scale' },
  seo: { name: 'Search + AI answers (company pages, /agencies)', why: 'Pages that answer "does X ghost applicants?" compound every day.', rule: 'compounding_seo' },
  linkedin: { name: 'LinkedIn (founder posts)', why: 'Hiring-outrage data travels well with professionals and recruiters.', rule: 'founder_content' },
  'short-video': { name: 'Short video (TikTok / Shorts / Reels)', why: 'The demo clips — check-the-ghost-rate and outcome cards.', rule: 'founder_content' },
  creators: { name: 'Career creators', why: 'Citable numbers and lookups make them look good to their audience.', rule: 'promotable' },
  email: { name: 'Email (outcome loop)', why: 'Day 7/14/30 check-ins are retention and data at once.', rule: 'weekly_retention' },
  x: { name: 'X / Threads', why: 'Cheap distribution for the weekly data story.', rule: 'founder_content' },
  'paid-test': { name: 'Small paid tests', why: 'Only to amplify what organic already proved; simulated first.', rule: 'focus_channel' },
};

// The owner's weekly human-only time, from WEEKLY_ROUTINE.md (5–8 h/week total).
export function timeBudget(phaseId = 'atomic') {
  const rows = [
    { task: 'Monday review (this Growth tab + the KPI pack)', minutes: 40, rule: 'weekly_retention' },
    { task: 'Community presence, 15 min/day as a person', minutes: 105, rule: 'dont_scale' },
    { task: 'One-to-one outreach DMs (10–15)', minutes: 75, rule: 'dont_scale' },
    { task: 'Post the weekly Ghost Report + reply for 2 hours', minutes: 45, rule: 'founder_content', from: 3 },
    { task: 'Record 2 demo clips', minutes: 90, rule: 'founder_content', from: 3 },
    { task: 'Approve the day\'s 1% item (the app drafts it)', minutes: 35, rule: 'one_percent' },
    { task: 'Employer / agency outreach (10 emails)', minutes: 45, rule: 'kill_gates', phases: ['loop', 'compound'] },
    { task: 'Creator replies and asks (3 a week)', minutes: 30, rule: 'promotable', phases: ['loop', 'compound'] },
  ].filter((r) => !r.phases || r.phases.includes(phaseId));
  const total = rows.reduce((n, r) => n + r.minutes, 0);
  return { rows, totalMinutes: total, totalHours: Math.round(total / 6) / 10, ceilingHours: 8 };
}

const EMPTY = { plan: null };
/** A plan starting on the Monday (PT) of `start`, with the real user count at creation as its baseline. */
export function buildPlan({ start = ptToday(), weeks = DEFAULT_WEEKS, goal = GOAL_USERS, baselineUsers = null, now = new Date() } = {}) {
  if (!isDay(start)) throw new Error('start must be a YYYY-MM-DD day');
  return { version: 1, createdAt: now.toISOString(), start: mondayOf(start), weeks: Math.max(8, Math.min(78, Number(weeks) || DEFAULT_WEEKS)), goal: Number(goal) || GOAL_USERS,
    baseline: { users: Number.isFinite(baselineUsers) ? baselineUsers : null, source: Number.isFinite(baselineUsers) ? 'admin-stats users.total at plan start' : 'unknown — admin-stats not read yet' } };
}
/** The plan in force. The first call saves a plan starting this week, so its dates never drift. */
// `now` decides the start of a plan created on first read, so a route given a clock (deps.now) starts the
// plan on ITS today, not the machine's.
export function getPlan(now = new Date()) { const p = readDoc('plan', EMPTY).plan; return p || savePlan(buildPlan({ start: ptToday(now), now })); }
/** First real numbers seen → they become the baseline (once; the plan's dates do not move). */
export function ensureBaseline(plan, actuals) {
  if (!plan || plan.baseline?.users != null || !actuals || actuals.degraded || actuals.users == null) return plan;
  return savePlan({ ...plan, baseline: { users: actuals.users, source: `admin-stats users.total, first read ${actuals.day} PT`, at: actuals.at } });
}
export function savePlan(plan) { writeDoc('plan', { plan }); return plan; }

// Week 1 = the plan's first Monday-to-Sunday. Before the start → 0.
export function planWeek(plan, day = ptToday()) { const d = daysBetween(plan.start, day); return d < 0 ? 0 : Math.floor(d / 7) + 1; }
export function phaseFor(plan, week) {
  const scale = plan.weeks / DEFAULT_WEEKS; // a longer/shorter plan stretches the phases proportionally
  let i = 0; for (; i < PHASES.length; i++) if (week <= Math.round(PHASES[i].weeks[1] * scale)) break;
  return PHASES[Math.min(i, PHASES.length - 1)];
}

// User targets: milestones at the phase ends (scaled to the plan length), interpolated geometrically
// (compound growth) from the baseline; a milestone at or below the baseline is dropped.
function userCurve(plan) {
  const scale = plan.weeks / DEFAULT_WEEKS;
  const base = Math.max(0, plan.baseline?.users ?? 0);
  const pts = [[0, base], ...PHASES.map((p, i) => [i === PHASES.length - 1 ? plan.weeks : Math.round(p.weeks[1] * scale), i === PHASES.length - 1 ? plan.goal : p.users])]
    .filter(([w, u], i) => i === 0 || u > base);
  if (pts.length === 1) pts.push([plan.weeks, Math.max(base, plan.goal)]);
  return (week) => {
    let j = 1; while (j < pts.length - 1 && week > pts[j][0]) j++;
    const [w0, u0] = pts[j - 1], [w1, u1] = pts[j];
    const t = Math.max(0, Math.min(1, (week - w0) / Math.max(1, w1 - w0)));
    if (week >= w1) return u1;
    return u0 > 0 ? u0 * Math.pow(u1 / u0, t) : u0 + (u1 - u0) * t;
  };
}
// Paying customers (30 days): no goal before day 90; ≥1 by day 90 (G6, week 13); then a ramp to 2% of the
// goal by the last week (= 20 Interview Prep buyers a month at 1,000 users ≈ $200, the low end of the
// playbook's M6 marker).
function paidCurve(plan) {
  const scale = plan.weeks / DEFAULT_WEEKS; const g6 = Math.round(13 * scale); const endPaid = Math.max(1, Math.round(plan.goal * 0.02));
  return (week) => { if (week < g6) return 0; if (week === g6) return 1; return Math.max(1, Math.round(1 + (endPaid - 1) * ((week - g6) / Math.max(1, plan.weeks - g6)))); };
}

/** Weekly goals for other modules: [{ week, weekStart, phase, users, paidUsers, revenue, activationGoal }].
 *  paidUsers = paying customers in the last 30 days; revenue = their purchases at the Interview Prep price. */
export function planTargets(plan = getPlan()) {
  const users = userCurve(plan), paid = paidCurve(plan); let prev = 0;
  return Array.from({ length: plan.weeks }, (_, i) => {
    const week = i + 1; const ph = phaseFor(plan, week);
    const u = Math.max(prev, Math.round(users(week))); prev = u;
    const p = paid(week);
    return { week, weekStart: addDays(plan.start, i * 7), phase: ph.id, users: u, paidUsers: p, revenue: Math.round(p * INTERVIEW_PREP_USD * 100) / 100, activationGoal: ph.activationGoal };
  });
}

// ---- actuals: weekly snapshots of REAL numbers -------------------------------------------------------
/** admin-stats summary → the numbers the plan checks (null where the source has none). */
export function actualsFrom(summary, now = new Date()) {
  if (!summary) return null;
  const raw = summary.raw || {};
  const n = (v) => (Number.isFinite(Number(v)) && v !== null ? Number(v) : null);
  return {
    at: now.toISOString(), day: ptToday(now), degraded: !!summary.dataQuality?.degraded,
    users: n(summary.users?.total), newThisWeek: n(raw.users?.new_this_week), dau: n(summary.users?.dau),
    // Money from Seen's revenue funnel (one-time sales, last 30 days); null when Seen could not report it.
    paid: n(summary.revenue?.payingCustomers), revenue: n(summary.revenue?.month),
    prepPurchases: n(summary.revenue?.prepPurchases), passPurchases: n(summary.revenue?.passPurchases),
    interviews: n(summary.revenue?.interviews), offerShown: n(summary.revenue?.offerShown),
    legacyMrr: n(summary.revenue?.legacy?.mrr), reportsTotal: n(summary.flywheel?.reportsTotal), reportsWeek: n(raw.reports?.this_week),
    shares: n(summary.flywheel?.shares), applications: n(raw.applications?.total), scoredCompanies: n(raw.companies?.with_scores),
    activation: null, // admin-stats does not report per-user activation yet — never estimated here
  };
}
export function recordActuals(actuals, plan = getPlan()) {
  if (!actuals) return null;
  const week = planWeek(plan, actuals.day);
  updateDoc('actuals', { weeks: {} }, (d) => { d.weeks = { ...(d.weeks || {}), [week]: actuals }; return d; });
  return { week, ...actuals };
}
export function actualsHistory() { return readDoc('actuals', { weeks: {} }).weeks || {}; }

const ratioStatus = (actual, target) => {
  if (actual == null) return 'unknown';
  if (!target) return actual > 0 ? 'ahead' : 'on-track';
  const r = actual / target;
  return r >= 1.15 ? 'ahead' : r >= 0.9 ? 'on-track' : r >= 0.6 ? 'behind' : 'off-track';
};

/**
 * This week vs the plan. `actuals` = actualsFrom(admin-stats summary) or null. Returns the targets, the
 * status of each measured line, what to change (each with the rule that drove it) and the gates.
 */
export function checkWeek({ plan = getPlan(), actuals = null, history = {}, today = ptToday() } = {}) {
  const targets = planTargets(plan);
  const week = Math.max(1, Math.min(plan.weeks, planWeek(plan, today) || 1));
  const t = targets[week - 1]; const ph = PHASES.find((p) => p.id === t.phase);
  const prev = history[week - 1] || null;
  const changes = [];
  const add = (what, ruleId, why = null) => changes.push({ what, rule: ruleId, ruleName: rule(ruleId).name, why: why || cite(ruleId) });
  if (!actuals) {
    add('Connect admin-stats (SEEN_ADMIN_USERNAME / SEEN_ADMIN_PASSWORD in Settings) — the plan cannot be checked without real numbers.', 'honest_numbers');
    return { week, weekStart: t.weekStart, phase: ph, target: t, actuals: null, status: { users: 'unknown', paid: 'unknown', revenue: 'unknown', activation: 'unknown' }, overall: 'unknown', changes, gates: gates({ plan, actuals: null, today }), trend: null };
  }
  if (actuals.degraded) {
    add('Seen reported failed queries in admin-stats this week — fix the data first; nothing is judged on numbers that may be zeros from errors.', 'honest_numbers');
    return { week, weekStart: t.weekStart, phase: ph, target: t, actuals, status: { users: 'unknown', paid: 'unknown', revenue: 'unknown', activation: 'unknown' }, overall: 'unknown', changes, gates: gates({ plan, actuals, today }), trend: null };
  }
  const status = {
    users: ratioStatus(actuals.users, t.users),
    paid: t.paidUsers ? ratioStatus(actuals.paid, t.paidUsers) : (actuals.paid == null ? 'unknown' : 'not-yet'),
    revenue: t.revenue ? ratioStatus(actuals.revenue, t.revenue) : (actuals.revenue == null ? 'unknown' : 'not-yet'),
    activation: actuals.activation == null ? 'unmeasured' : ratioStatus(actuals.activation, t.activationGoal),
  };
  const trend = prev && prev.users != null && actuals.users != null ? { users: actuals.users - prev.users, dau: actuals.dau != null && prev.dau != null ? actuals.dau - prev.dau : null, reports: actuals.reportsTotal != null && prev.reportsTotal != null ? actuals.reportsTotal - prev.reportsTotal : null, since: prev.day } : null;

  if (status.activation === 'unmeasured') add('Add an "activated in first week" count to Seen\'s admin-stats (tracked an application, checked a company, or reported an outcome) so activation can be judged.', 'activation_first');
  if (status.users === 'behind' || status.users === 'off-track') {
    if (ph.id === 'atomic') add(`Users ${actuals.users} vs ${t.users} goal: send 15 one-to-one outreach DMs this week and reply to every comment on the last post — hand-recruit, don't broadcast.`, 'dont_scale');
    else add(`Users ${actuals.users} vs ${t.users} goal: check which post or clip produced sessions last week, post the next Ghost Report in that venue/format, and drop the weakest format.`, 'focus_channel');
    if (status.users === 'off-track') add('Off track two weeks running → hold every new channel and fix the first visit (search → company page → report) before adding traffic.', 'activation_first');
  }
  if (status.users === 'ahead') add('Ahead of plan: do NOT add channels — double what is working and protect the cadence.', 'focus_channel');
  if (trend && trend.users <= 0) add(`No net user growth since ${dayLabel(trend.since)} — the week\'s 1% items should all be distribution, not product.`, 'weekly_retention');
  if (trend && trend.dau != null && trend.dau < 0) add(`Daily actives fell by ${Math.abs(trend.dau)} since last check — look at what returning users did last week (tracker check-ins, emails) before chasing new ones.`, 'weekly_retention');
  if (t.paidUsers && (status.paid === 'behind' || status.paid === 'off-track')) {
    const why = 'Owner decisions 2026-10-25: Interview Prep ($9.99) is the lead product, sold the moment a tracked application reaches an interview; the 30-day Job Search Pass ($19.99) replaced subscriptions and the trial. Sell at the moment of need, not with pressure.';
    if (actuals.interviews != null && actuals.interviews < Math.max(3, t.paidUsers * 3)) add(`Paying ${actuals.paid ?? 0} vs ${t.paidUsers} goal, and only ${actuals.interviews} tracked application${actuals.interviews === 1 ? '' : 's'} at an interview: Prep sells at the interview, so the lever is more tracked applications reaching that stage — push tracker sign-ups and the day-7/14 check-ins, not the offer.`, 'activation_first', why);
    else add(`Paying ${actuals.paid ?? 0} vs ${t.paidUsers} goal: make the Interview Prep offer impossible to miss at the interview stage (the tracker card and the dashboard's next move), show its free preview, and offer the Pass to people with several active applications.`, 'activation_first', why);
  }
  if (!changes.length) add('On plan: keep the cadence exactly; ship today\'s 1% item.', 'one_percent');
  const order = ['off-track', 'behind', 'unknown', 'unmeasured', 'on-track', 'not-yet', 'ahead'];
  const overall = ['users', 'paid', 'revenue'].map((k) => status[k]).sort((a, b) => order.indexOf(a) - order.indexOf(b))[0];
  return { week, weekStart: t.weekStart, phase: ph, target: t, actuals, status, overall, changes, gates: gates({ plan, actuals, today }), trend };
}

// ---- dated kill-gates (Day-90 gates G1–G6 from the playbook + this plan's user milestones) -----------
export function gates({ plan = getPlan(), actuals = null, today = ptToday() } = {}) {
  const day90 = addDays(plan.start, 90); const scale = plan.weeks / DEFAULT_WEEKS;
  const ok = actuals && !actuals.degraded;
  const mk = (g) => {
    let state;
    if (g.measure == null) state = today >= g.date ? 'needs-measurement' : 'upcoming';
    else if (g.measure) state = 'hit';
    else state = today >= g.date ? 'missed' : 'upcoming';
    return { ...g, state, daysLeft: daysBetween(today, g.date) };
  };
  const users = ok ? actuals.users : null;
  const out = PHASES.map((p, i) => ({ id: `users-${p.id}`, name: `${p.users.toLocaleString('en-US')} users`, date: addDays(plan.start, Math.round((i === PHASES.length - 1 ? plan.weeks : p.weeks[1] * scale) * 7) - 1),
    number: `users.total ≥ ${p.users}`, progress: users, measure: users == null ? null : users >= (i === PHASES.length - 1 ? plan.goal : p.users),
    ifHit: i < PHASES.length - 1 ? `Move to "${PHASES[i + 1].name}".` : 'Goal reached — set the next one from the winning channel.',
    ifMissed: 'Do not widen the audience or add channels; diagnose the first visit and the DM/post asks, re-run 30 days.', rule: 'kill_gates' }));
  out.push(
    { id: 'G1', name: 'Atomic network forming', date: day90, number: '≥50 organic reports from ≥30 distinct users', progress: ok ? actuals.reportsTotal : null, measure: null,
      note: 'admin-stats counts ALL reports (imports included); the organic count needs the KPI pack SQL in WEEKLY_ROUTINE.md.', ifHit: 'Widen from agencies to one more niche.', ifMissed: 'Fix the report-collection mechanics and re-run 30 days; do not widen.', rule: 'beachhead' },
    { id: 'G2', name: 'Amplifier works', date: day90, number: '≥1 post >10k impressions OR >500 sessions from content', progress: null, measure: null,
      note: 'Record each post\'s results on its calendar item; sessions need PostHog.', ifHit: 'Double posting volume; test a $50 paid boost (simulate first).', ifMissed: 'Rotate venues/formats; missed again at day 180 → content drops to 1 post/week.', rule: 'founder_content' },
    // G3 replaced the playbook's "≥25 trials started" when Seen retired the trial (2026-10-25): the same
    // question — does the offer at the moment of need convert? — asked of the Interview Prep offer.
    { id: 'G3', name: 'Prep offer converts', date: day90, number: '≥25 Interview Prep offers seen and ≥1 in 10 bought', progress: ok && actuals.offerShown != null ? actuals.offerShown : null,
      measure: ok && actuals.offerShown != null && actuals.offerShown >= 25 && actuals.prepPurchases != null ? actuals.prepPurchases / actuals.offerShown >= 0.1 : null,
      note: 'From Seen\'s revenue funnel, last 30 days; judged once 25 people have seen the offer.', ifHit: 'Put the offer on every interview surface; test the Pass beside it.', ifMissed: 'Traffic to the interview stage is the constraint — fold effort into G1/G2 and the tracker check-ins.', rule: 'kill_gates' },
    { id: 'G4', name: 'One-time sales alive', date: day90, number: '≥5 one-time purchases (Interview Prep or the Pass)', progress: ok && actuals.prepPurchases != null ? actuals.prepPurchases + (actuals.passPurchases || 0) : null,
      measure: ok && actuals.prepPurchases != null && actuals.prepPurchases + (actuals.passPurchases || 0) >= 5 ? true : null,
      note: 'Seen\'s revenue funnel counts the last 30 days — a lower bound for the 90.', ifHit: 'Feature Interview Prep at every interview and the Pass beside it.', ifMissed: 'Reposition once (where and when the offer appears); twice missed → park.', rule: 'kill_gates' },
    { id: 'G5', name: 'Employer side alive', date: day90, number: '≥3 employer replies OR 1 paid listing/badge', progress: null, measure: null, note: 'Log replies on the calendar\'s outreach items.', ifHit: 'Systematise: 20 emails/week.', ifMissed: 'Change the pitch target once; twice missed → park.', rule: 'kill_gates' },
    { id: 'G6', name: 'First dollar', date: day90, number: '≥$1 real revenue from any engine', progress: ok ? actuals.revenue : null, measure: ok && (actuals.revenue != null || actuals.paid != null) ? ((actuals.revenue || 0) > 0 || (actuals.paid || 0) > 0 || (actuals.legacyMrr || 0) > 0) : null,
      ifHit: 'Post about it — it is content.', ifMissed: 'Allowed only if G1 and G2 both hit; otherwise a full plan review.', rule: 'kill_gates' },
  );
  return out.map(mk).sort((a, b) => a.date.localeCompare(b.date));
}

/** The whole plan for the UI: phases with dates, targets, channels, time budget, gates and this week. */
export function planView({ plan = getPlan(), actuals = null, history = actualsHistory(), today = ptToday() } = {}) {
  const scale = plan.weeks / DEFAULT_WEEKS;
  const phases = PHASES.map((p, i) => {
    const w0 = i === 0 ? 1 : Math.round(PHASES[i - 1].weeks[1] * scale) + 1; const w1 = i === PHASES.length - 1 ? plan.weeks : Math.round(p.weeks[1] * scale);
    return { ...p, fromWeek: w0, toWeek: w1, from: addDays(plan.start, (w0 - 1) * 7), to: addDays(plan.start, w1 * 7 - 1), rules: p.rules.map(rule), channels: p.channels.map((c) => ({ id: c, ...CHANNELS[c], rule: rule(CHANNELS[c].rule) })), time: timeBudget(p.id) };
  });
  return { plan, phases, targets: planTargets(plan), check: checkWeek({ plan, actuals, history, today }), history };
}
