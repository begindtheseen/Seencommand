// The mass-advertising plan, for when Brandon is ready to pay. A PLAN ONLY: no ad accounts, no spend, no
// pixels. Paid amplifies what organic already proved (rule focus_channel); every spend decision is first
// deep-simulated through POST /api/simulate (lib/simulations.mjs) and then decided by Brandon.
// No cost benchmarks are invented: CPMs/CPCs differ by platform, audience and month, so the kill/scale rules
// are relative to Seen's OWN measured numbers (target CPA from real paid share × price), and anything
// unmeasured says so.
import { config } from '../config.mjs';
import { rule } from './rules.mjs';
import { INTERVIEW_PREP_USD } from './plan.mjs';
import { mondayOf, ptToday } from './pt.mjs';

export const AD_CHANNELS = [
  { id: 'reddit-ads', name: 'Reddit Ads — promote the best organic post', when: 'First, once one organic Ghost Report clearly beat the others', audience: 'Communities and interests around job search, careers and staffing (the beachhead)', why: 'Same audience as the organic beachhead; a promoted version of a post they already liked.', rule: 'beachhead' },
  { id: 'tiktok-spark', name: 'TikTok Spark Ads — boost an organic clip', when: 'When a demo clip outperforms the rest organically', audience: 'Job-search and career-advice interests, US', why: 'Boosts the founder\'s own post (keeps its comments and authenticity) instead of a polished ad.', rule: 'founder_content' },
  { id: 'google-search', name: 'Google Search — intent keywords', when: 'When company pages convert organic searchers', audience: 'People searching "does <company> ghost applicants", "<agency> ghosted me", "staffing agency reviews"', why: 'Intent is explicit; the landing page is the exact answer (the company page).', rule: 'compounding_seo' },
  { id: 'meta', name: 'Instagram / Facebook — the best data card', when: 'After Reddit or TikTok proves a message', audience: 'Broad US job-seeker interests; let the creative do the targeting', why: 'Cheap reach for a proven card; a test of whether the message travels beyond Reddit.', rule: 'focus_channel' },
  { id: 'linkedin', name: 'LinkedIn — employer side only', when: 'Only for E4 (Transparency Verified badge / featured listings) once employers reply organically', audience: 'Recruiting and HR leaders', why: 'Expensive for consumers; reasonable only to reach employers.', rule: 'kill_gates' },
];

export const TRANCHES = [
  { id: 't0', name: 'Organic proof', budget: 0, length: 'until G2', gate: 'G2 hit: one post >10k impressions or >500 sessions (recorded on calendar items)', does: 'No spend. Find the message that works for free.' },
  { id: 't1', name: 'First test', budget: 50, length: '5–7 days', gate: 'G2 hit + activation measured + a simulation + Brandon\'s yes', does: 'One channel, the single best organic post or clip, 1–2 creatives.' },
  { id: 't2', name: 'Confirm', budget: 150, length: '2 weeks', gate: 't1 produced signups at or under the target CPA', does: 'The winning creative + 2 variants on the same channel.' },
  { id: 't3', name: 'Steady', budget: 500, length: 'per month', gate: 't2 held the target CPA for 2 weeks and new users activate at the plan rate', does: 'Add one channel; keep the budget at or below what paid users return.' },
];

/** The most Seen should pay for one signup, from REAL numbers: paying share × average sale × purchases per
 *  buyer. Seen's sales are one-time (Interview Prep $9.99, the Pass $19.99), so there is no "months kept". */
export function targetCpa(actuals, { purchasesPerBuyer = 1 } = {}) {
  if (!actuals || actuals.degraded || !actuals.users) return { value: null, why: 'Unknown — no admin-stats numbers yet. Only a learning budget (t1) is allowed until it is measurable.' };
  const share = (actuals.paid || 0) / actuals.users;
  if (!share) return { value: null, why: 'Unknown — no paying users yet, so a signup\'s value cannot be measured. Only a learning budget (t1) is allowed.' };
  const sale = actuals.revenue > 0 && actuals.paid > 0 ? Math.round((actuals.revenue / actuals.paid) * 100) / 100 : INTERVIEW_PREP_USD;
  const saleWhy = actuals.revenue > 0 && actuals.paid > 0 ? `$${sale} average sale (measured: $${actuals.revenue} ÷ ${actuals.paid} paying in 30 days)` : `$${INTERVIEW_PREP_USD} (Interview Prep price; no average sale measured yet)`;
  const v = Math.round(share * sale * purchasesPerBuyer * 100) / 100;
  return { value: v, why: `${actuals.paid} paying ÷ ${actuals.users} users × ${saleWhy} × ${purchasesPerBuyer} purchase per buyer (assumption) = $${v} per signup.`, purchasesPerBuyer };
}

export const KILL_SCALE = [
  { id: 'kill-creative', rule: 'Kill a creative once it has spent 2× the target CPA with no signups (or $25 in t1 while the CPA is unknown).', why: 'Enough spend to judge, not enough to bleed.' },
  { id: 'kill-ctr', rule: 'After 1,000 impressions, pause a creative whose click-through is below the median of your other creatives on that channel.', why: 'Relative to your own results — no borrowed benchmark.' },
  { id: 'scale', rule: 'Raise a winning ad set\'s budget by at most 20% every 3 days while its CPA stays at or under target.', why: 'Small steps keep the delivery stable and the read honest.' },
  { id: 'stop-channel', rule: 'A tranche that produces zero signups ends that channel for this quarter.', why: 'Kill-gates apply to paid too.' },
  { id: 'trust', rule: 'Pause anything whose comments say it feels like a shakedown or a fake stat — fix the message before spending more.', why: 'Trust is the asset; paid reach multiplies a trust problem.' },
];

const ANGLES = [['agency-index', 'Check the agency before the call'], ['how-to', 'The 10-second check before you apply'], ['credit-the-good', 'The employers that actually answer'], ['outcome-card', 'Put your ghosting on the record']];
const CREATIVE_FORMATS = [['data-callout', '1080x1080'], ['agency-leaderboard', '1080x1350'], ['quote', '1080x1920'], ['cta-banner', '1200x628']];
/** Angle × format × hook-style combinations, each mapped to an ad-designer template and a UTM. */
export function creativeMatrix(base = config.seenBaseUrl()) {
  const out = [];
  for (const [angle, title] of ANGLES) for (const [template, size] of CREATIVE_FORMATS) for (const style of ['data-first', 'question-first']) {
    out.push({ id: `${angle}.${template}.${style}`, angle, title, template, size, style, utm: utm(`${base}${angle === 'agency-index' ? '/agencies' : angle === 'outcome-card' ? '/tracker' : '/companies'}`, { source: 'paid', medium: 'cpc', campaign: angle, content: `${template}-${style}` }) });
  }
  return out;
}

/** UTM-tag a Seen URL. Campaign is prefixed with the PT month so reports group by month. */
export function utm(url, { source, medium, campaign, content = '', term = '' }, today = ptToday()) {
  const u = new URL(url);
  const set = (k, v) => { if (v) u.searchParams.set(k, String(v).toLowerCase().replace(/[^a-z0-9._-]+/g, '-')); };
  set('utm_source', source); set('utm_medium', medium); set('utm_campaign', `${today.slice(0, 7)}-${campaign}`); set('utm_content', content); set('utm_term', term);
  return u.toString();
}

/** Is paid allowed yet? Reads the calendar's recorded results and the plan check. */
export function readiness({ items = [], check = null } = {}) {
  const best = items.filter((i) => i.results).reduce((m, i) => Math.max(m, i.results.impressions || i.results.views || 0, (i.results.sessions || 0) * 20), 0);
  const g2 = items.some((i) => i.results && ((i.results.impressions || i.results.views || 0) > 10000 || (i.results.sessions || 0) > 500));
  const activation = check?.actuals?.activation != null;
  const reasons = [];
  if (!g2) reasons.push('G2 not hit yet — no recorded post above 10k impressions or 500 sessions.');
  if (!activation) reasons.push('Activation is not measured — paid traffic into an unmeasured first visit cannot be judged (activation before acquisition).');
  return { ready: g2 && activation, g2, activation, bestRecorded: best || null, reasons, rule: rule('activation_first') };
}

/** The POST /api/simulate body for a tranche — real users; growth/conversion as labelled assumption ranges. */
export function simulationRequest(trancheId, { actuals = null, history = {} } = {}) {
  const t = TRANCHES.find((x) => x.id === trancheId) || TRANCHES[1];
  const weeksSeen = Object.values(history).filter((a) => a && a.users != null).sort((a, b) => String(a.day).localeCompare(String(b.day)));
  let observed = null;
  if (weeksSeen.length >= 2) { const a = weeksSeen[weeksSeen.length - 2], b = weeksSeen[weeksSeen.length - 1]; if (a.users > 0) observed = Math.max(-0.5, (b.users - a.users) / a.users); }
  const users = actuals && !actuals.degraded && actuals.users != null ? actuals.users : null;
  const share = users ? (actuals.paid || 0) / users : null;
  const numbers = users == null ? null : {
    users, weeks: 12,
    weeklyGrowth: observed != null ? { low: Math.max(0, observed * 0.5), likely: Math.max(0, observed), high: Math.max(0.02, observed * 1.5 + 0.02) } : { low: 0, likely: 0.03, high: 0.1 },
    paidShare: share ? { low: share * 0.5, likely: share, high: share * 1.5 } : { low: 0, likely: 0.01, high: 0.03 },
    price: { low: INTERVIEW_PREP_USD, likely: INTERVIEW_PREP_USD, high: 19.99 },
    monthlyCost: t.id === 't3' ? t.budget : 0, oneTime: t.id === 't3' ? null : { cost: t.budget },
  };
  return {
    question: `Should SeenJobs spend $${t.budget} on paid ads (${t.name}: ${t.does}) now? Gate: ${t.gate}.`,
    numbers,
    assumptions: numbers ? [observed != null ? `weekly growth from the last two admin-stats snapshots (${Math.round(observed * 1000) / 10}%/wk) ±50%` : 'weekly growth 0–10%/wk is an ASSUMPTION range (no two snapshots yet) — edit before simulating', share ? `paid share from admin-stats (${actuals.paid}/${users})` : 'paid share 0–3% is an ASSUMPTION range (no paying users yet)', 'price per sale between Interview Prep ($9.99) and the Job Search Pass ($19.99), one-time'] : ['No admin-stats numbers — the simulation runs on the decision in words only.'],
  };
}

export function adsPlan({ actuals = null, history = {}, items = [], check = null } = {}) {
  return { note: 'A plan only — no ad accounts, no spend. Every tranche is simulated first (POST /api/simulate) and decided by Brandon.',
    readiness: readiness({ items, check }), channels: AD_CHANNELS.map((c) => ({ ...c, rule: rule(c.rule) })), tranches: TRANCHES, targetCpa: targetCpa(actuals),
    killScale: KILL_SCALE, matrix: creativeMatrix(), simulate: Object.fromEntries(TRANCHES.slice(1).map((t) => [t.id, simulationRequest(t.id, { actuals, history })])),
    utmExample: utm(`${config.seenBaseUrl()}/agencies`, { source: 'reddit', medium: 'cpc', campaign: 'agency-index', content: 'data-callout-data-first' }),
    weekOf: mondayOf(ptToday()), unverified: 'Platform minimums, policies and targeting options change — check each ad manager before the first test.' };
}
