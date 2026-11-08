// The brand kit — who Seen is for, what it promises, how it sounds, what it may claim, and how it looks.
// Drafted from SEEN_STRATEGY.md, the Operation 50% playbook and the owner's vision (brain owner:vision ·
// growth-strategy). Editable and versioned: every save is a new version in data/growth/brand.json (old
// versions kept) plus a pointer fact in the brain (growth:brand · current-version), so the board and the
// next session know which kit is in force. Proof points are only things Seen can back up — static ones
// describe how the product works (verified in the seen repo), live ones are filled from admin-stats at
// draft time and never stored as numbers here.
import { readDoc, writeDoc } from './store.mjs';
import { ptStamp } from './pt.mjs';

export const DEFAULT_BRAND = {
  name: 'Seen',
  domain: 'seenjobs.io',
  category: 'The public response record of employers',
  tagline: 'Check if they ghost before you apply.',
  promise: 'Before you spend an hour on an application, see whether that employer or staffing agency actually answers applicants — from real applicant reports, with the sample size on every number.',
  positioning: 'For job seekers tired of applying into silence, Seen is the public response record of employers: it shows which companies and staffing agencies answer applicants, based on applicant-reported outcomes with honest confidence labels. Unlike review sites that mostly describe working there, Seen measures the part before you are hired — whether anyone gets back to you.',
  segments: [
    { id: 'agency-ghosted', name: 'Ghosted by staffing agencies (beachhead)', where: 'r/recruitinghell, r/jobs, agency-specific threads',
      pains: ['Recruiters reach out, then vanish after a call or a submission', 'No way to tell a real agency pipeline from a résumé harvest', 'Weeks lost waiting on roles that were never real'],
      wants: 'To know which agencies actually place people and answer, before giving them another week.' },
    { id: 'hourly-volume', name: 'High-volume hourly applicants', where: 'retail, warehouse, food service, customer service searches',
      pains: ['Dozens of applications, almost no replies', 'Cannot tell which employers are hiring right now vs collecting applications', 'Little time; every wasted application costs a shift'],
      wants: 'A fast yes/no: does this employer usually respond?' },
    { id: 'laid-off-pros', name: 'Laid-off and career-changing professionals', where: 'LinkedIn, r/cscareerquestions-style communities, newsletters',
      pains: ['Hundreds of applications with a low reply rate', 'Interview loops that end in silence', 'Need to prioritise where to spend effort'],
      wants: 'Response and ghost data to prioritise, plus a tracker that keeps the search organised.' },
    { id: 'creators', name: 'Career creators and coaches (channel partners)', where: 'TikTok, YouTube Shorts, LinkedIn, newsletters',
      pains: ['Need fresh, credible data for content', 'Generic advice blends in', 'Risk of sharing something that turns out to be wrong'],
      wants: 'Citable numbers with a link and a sample size, and a lookup their audience can use.' },
    { id: 'good-employers', name: 'Employers that respond (later — E4)', where: 'recruiting and HR leaders',
      pains: ['Good candidate experience is invisible', 'Bad reviews are about tenure, not hiring'],
      wants: 'Verified credit for responding to applicants — never a bought score.' },
  ],
  proofPoints: [
    { id: 'grade-gate', text: 'A company only gets a grade with at least 5 first-party applicant reports; below that Seen says "not enough data".', backedBy: 'seen repo: lib/server/reportCounts.js MIN_REPORTS_FOR_GRADE, app/agencies/page.tsx' },
    { id: 'sample-size', text: 'Every ghost or response rate is shown with how many reports it is based on.', backedBy: 'seen repo: app/agencies/page.tsx honesty rules' },
    { id: 'no-buying', text: 'Money never changes a score — no sponsorship, ad or employer deal can alter a grade.', backedBy: 'owner decision 2026-07-04; playbook OUTREACH_SCRIPTS.md' },
    { id: 'trust-weighted', text: 'Reports are treated as claims and trust-weighted: imported public accounts count less than first-hand reports to Seen.', backedBy: 'seen repo: SEEN_STRATEGY.md anti-gaming; scoring weights (reddit 0.3, direct 1.0)' },
    { id: 'ghost-index', text: 'The Staffing Agency Ghost Index (seenjobs.io/agencies) ranks major agencies by applicant-reported outcomes and labels agencies with no reports instead of inventing a rate.', backedBy: 'seen repo: app/agencies/page.tsx' },
    { id: 'tracker', text: 'The free tracker asks one-tap check-ins at day 7, 14 and 30 so outcomes get recorded.', backedBy: 'SEEN_STRATEGY.md follow-up system; app/tracker' },
    { id: 'founder', text: 'Built in public by a founder who answers questions himself.', backedBy: 'playbook rules of engagement (always disclose)' },
  ],
  voice: {
    summary: 'A sharp friend who keeps receipts: plain, specific, on the applicant\'s side, calm rather than ranty.',
    traits: [
      { trait: 'Receipts first', do: 'Lead with the number and its sample size, then the plain meaning.', dont: 'Lead with outrage or adjectives.' },
      { trait: 'On the applicant\'s side', do: 'Name the pain exactly ("three interviews, then nothing").', dont: 'Blame applicants or lecture them.' },
      { trait: 'Honest about small data', do: '"6 reports so far — low confidence. Add yours."', dont: 'Round small samples into big claims.' },
      { trait: 'Plain words', do: 'Short sentences a tired person can read on a phone.', dont: 'Jargon, hype, "AI-powered".' },
      { trait: 'Fair to employers', do: 'Credit employers that respond; describe reports, not intentions.', dont: 'Call a named company a scam or a fraud.' },
    ],
  },
  wordsToUse: ['ghosted', 'response record', 'applicant reports', 'based on N reports', 'check before you apply', 'on the record', 'low confidence', 'not enough data yet', 'founder here', 'free'],
  wordsToAvoid: [
    { word: 'guaranteed', why: 'Seen cannot guarantee a reply or a job.' },
    { word: '#1 / best / only', why: 'An unbacked superlative — the first thing a skeptic attacks.' },
    { word: 'millions / thousands of users', why: 'Never claim scale Seen does not have.' },
    { word: 'scam / fraud / illegal (about a named company)', why: 'Defamation risk; describe reported outcomes instead.' },
    { word: 'exposed / name and shame', why: 'Reads as a shakedown; the index reports, it does not attack.' },
    { word: 'AI-powered / revolutionary', why: 'Hype words lower trust with this audience.' },
    { word: 'Stealth / bypass / beat the ATS', why: 'Owner decision 2026-07-02: the feature is "Human Voice" — never evasion language.' },
    { word: 'last chance / only today', why: 'Fake urgency.' },
  ],
  trustPrinciples: [
    'No invented numbers, testimonials or claims — every number is live, linked and has its sample size.',
    'Say "not enough data" when it is true; small and honest beats big and fake.',
    'Brandon discloses he is the founder every time Seen comes up.',
    'Money never changes a score, and nothing we write may imply it could.',
    'Describe reported outcomes, never a person: no recruiter names, no screenshots of private messages.',
    'Follow each community\'s rules; give value with no link when links are not welcome.',
    'Corrections are taken seriously: disputed reports go to Seen\'s review queue, and a fix is said out loud, not buried.',
  ],
  visual: {
    // From the seen repo app/globals.css + app/layout.tsx — the site's own tokens, so ads match the product.
    colors: { ink: '#02040a', void: '#05070f', surface: '#0c0f1a', panel: '#111526', line: 'rgba(255,255,255,0.10)', text: '#e5e7eb', sub: '#9ca3af', white: '#f9fafb',
      green: '#10b981', red: '#ef4444', amber: '#f59e0b', indigo: '#6366f1', violet: '#7c3aed', gradient: ['#1d4ed8', '#7c3aed', '#a855f7'] },
    meaning: { green: 'responds to applicants', red: 'ghosts applicants', amber: 'mixed / low confidence', indigo: 'Seen accent' },
    fonts: { display: 'Syne', body: 'Instrument Sans', mono: 'DM Mono' },
    rules: ['Dark ink background, one accent per piece', 'Numbers in DM Mono, headlines in Syne', 'Every data card carries a source line (site, sample size, date)', 'Wordmark bottom-left, CTA pill bottom-right, 64 px safe margin at 1080 px'],
  },
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function merge(base, patch) {
  if (!isObj(base) || !isObj(patch)) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  return out;
}

const EMPTY = { versions: [] };
export function brandHistory() { return readDoc('brand', EMPTY).versions || []; }
/** The kit in force: the newest saved version, else the drafted default (version 0). */
export function getBrand() {
  const v = brandHistory();
  const last = v[v.length - 1];
  return last ? { version: last.v, savedAt: last.at, note: last.note || '', kit: last.kit } : { version: 0, savedAt: null, note: 'drafted default', kit: structuredClone(DEFAULT_BRAND) };
}
/**
 * Save an edit as a NEW version (history kept). `patch` is merged into the current kit; arrays are
 * replaced. Returns { version, kit, brain } — brain is the pointer-fact write result (or an error).
 */
export async function saveBrand(patch, { note = '', by = 'Brandon', now = new Date(), recordFact = null } = {}) {
  if (!isObj(patch) || !Object.keys(patch).length) return { ok: false, error: 'nothing to save — send the fields to change' };
  const cur = getBrand();
  const kit = merge(cur.kit, patch);
  if (JSON.stringify(kit) === JSON.stringify(cur.kit)) return { ok: true, unchanged: true, version: cur.version, kit };
  const doc = readDoc('brand', EMPTY);
  const v = (doc.versions?.length ? doc.versions[doc.versions.length - 1].v : 0) + 1;
  doc.versions = [...(doc.versions || []), { v, at: now.toISOString(), by, note: String(note).slice(0, 300), kit }];
  writeDoc('brand', doc);
  let brain = null;
  if (recordFact) {
    try { brain = await recordFact({ subject: 'growth:brand', predicate: 'current-version', object: `v${v} saved ${ptStamp(now)} PT by ${by}${note ? ` — ${note}` : ''} (data/growth/brand.json)` }); }
    catch (e) { brain = { ok: false, error: e.message }; }
  }
  return { ok: true, version: v, kit, brain };
}

/** Live proof lines from admin-stats — only numbers that exist, each labelled with what it counts. */
export function liveProof(stats) {
  const s = stats && !stats.dataQuality?.degraded ? stats : null;
  if (!s) return [];
  const raw = s.raw || {};
  const out = [];
  if (Number.isFinite(raw.companies?.with_scores) && raw.companies.with_scores > 0) out.push({ id: 'scored', text: `${raw.companies.with_scores.toLocaleString('en-US')} companies have a Seen score`, source: 'admin-stats companies.with_scores' });
  if (Number.isFinite(s.flywheel?.reportsTotal) && s.flywheel.reportsTotal > 0) out.push({ id: 'reports', text: `${s.flywheel.reportsTotal.toLocaleString('en-US')} applicant reports on file`, source: 'admin-stats reports.total' });
  if (Number.isFinite(s.jobs?.active) && s.jobs.active > 0) out.push({ id: 'jobs', text: `${s.jobs.active.toLocaleString('en-US')} active job listings`, source: 'admin-stats jobs.active' });
  return out;
}

/** A compact brand brief for model prompts and the meeting block. */
export function brandBrief(kit = getBrand().kit) {
  return [`Brand: ${kit.name} (${kit.domain}) — ${kit.category}. Tagline: "${kit.tagline}"`,
    `Voice: ${kit.voice.summary}`,
    `Never say: ${kit.wordsToAvoid.map((w) => w.word).join('; ')}`,
    `Trust: ${kit.trustPrinciples.slice(0, 4).join(' ')}`].join('\n');
}
