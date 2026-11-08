// Creator Library → usable evidence. ONE deterministic engine that turns every researched creator's
// videos, evidence and canonical knowledge into a typed, ranked, de-duplicated set of insights that
// the board meeting (engine/run.mjs), the Board Room chat (creatorContext) and the Creator Library
// tab all read. No model is called here — every number is counted, never guessed.
//
// Two kinds of insight, always labelled:
//   • observed — a pattern COUNTED across the videos themselves: how the first seconds open (hook),
//     the video's format, the job-search topic it covers, the audience pain it voices, how often the
//     creator posts (cadence), and the explicit CTAs it uses (tactic).
//   • taught   — advice a creator states or demonstrates (the compiler's canonical knowledge), merged
//     across videos and creators when the same claim recurs.
//
// Honesty rules (tested in insights.test.mjs):
//   • Strength comes ONLY from independent support — distinct posts and distinct creators. The
//     extractor's self-rated confidence never raises strength. One creator saying it once is
//     "anecdotal"; nothing reaches "strong" without ≥3 creators and ≥6 posts.
//   • Carousel children collapse to their parent post, so one post never counts twice.
//   • Contradicted/deprecated knowledge and Seen's own "independent_improvement" records are excluded;
//     promotional "claim" records (a creator's own result claims) are not evidence of what works and
//     are excluded too.
//   • De-duplicated three ways: the same claim from many videos/creators merges into one insight;
//     observed patterns that mostly cover the same posts keep only the larger (the overlap is noted);
//     a topic that is really the same posts as an audience pain folds into the pain.
//   • Engagement lift is reported only with enough data on both sides, relative to EACH creator's own
//     median (big accounts don't drown small ones), and labelled correlation, not cause.
//   • Every insight carries citations: creator, post, source link, timestamp, excerpt.
//   • Dates shown are California dates (America/Los_Angeles).

import { createHash } from 'node:crypto';
import { ptDate, formatPT } from '../time-pt.mjs';
import { knowledgeRelevance, accountVerdict, pruneFamily } from './relevance.mjs';

export const INSIGHT_TYPES = ['hook', 'format', 'topic', 'audience_pain', 'cadence', 'tactic', 'advice', 'brand', 'monetization', 'product'];
export const STRENGTHS = ['anecdotal', 'emerging', 'moderate', 'strong']; // ascending
export const TYPE_LABEL = {
  hook: 'hook', format: 'format', topic: 'topic', audience_pain: 'audience pain',
  cadence: 'cadence', tactic: 'tactic', advice: 'job-seeker advice', brand: 'brand trust',
  monetization: 'monetization', product: 'product',
};
// A kept knowledge row that no content-craft rule types is typed by the Seen signal that kept it.
const SIGNAL_TYPE = { job_search: 'advice', content_craft: 'format', growth: 'tactic', brand_trust: 'brand', monetization: 'monetization', product: 'product' };
export const CAVEAT = 'Creator research, not proof: counted from the accessible public videos of the researched creators only. '
  + 'Patterns are rule-based; engagement is correlation (public like counts at retrieval), never cause.';

const HOOK_WINDOW_S = 3;   // a hook is what is said / shown in the first 3 seconds
const DAY = 86400000;

// ---- text helpers --------------------------------------------------------------------------------

const STOP = new Set(('a an the and or but if then so to of in on at by for with from into onto your you yours our we us they them '
  + 'their this that these those is are was were be been being it its as do does did not no can will just than more most very '
  + 'about over under what when where who why how which i me my mine he she his her get got make makes made use using every each '
  + 'should must always never one two three video videos creator').split(' '));

function stem(w) {
  return w.replace(/'s$/, '').replace(/(ies)$/, 'y').replace(/(ing|ed|es|s)$/, '');
}
export function tokens(text) {
  return [...new Set((String(text || '').toLowerCase().match(/[a-z0-9']{3,}/g) || [])
    .filter((w) => !STOP.has(w)).map(stem).filter((w) => w.length >= 3))];
}
// Overlap of two token sets: both "share most of the shorter one" and "aren't wildly different sizes".
export function similarity(a, b) {
  const A = a instanceof Set ? a : new Set(a); const B = b instanceof Set ? b : new Set(b);
  if (!A.size || !B.size) return 0;
  let shared = 0; for (const t of A) if (B.has(t)) shared++;
  const contain = shared / Math.min(A.size, B.size);
  const jaccard = shared / (A.size + B.size - shared);
  return Math.min(contain, jaccard * 1.6);
}
const firstSentence = (s, cap = 140) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  const m = /^(.{12,}?[.!?])(\s|$)/.exec(t);
  return (m ? m[1] : t).slice(0, cap);
};
const median = (xs) => { const a = xs.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); if (!a.length) return null; const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const fmtTs = (s) => { s = Math.max(0, Math.floor(Number(s) || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
export function citeAt(start, end) {
  if (start == null || !Number.isFinite(Number(start))) return null;
  const a = fmtTs(start);
  return Number.isFinite(Number(end)) && Number(end) > Number(start) + 0.5 ? `${a}–${fmtTs(end)}` : a;
}

// ---- pattern libraries (rule-based; each rule is a regex over lowercase text) --------------------

const PAIN_RE = /\bghost(ed|ing)?\b|never heard back|no response|radio silence|no repl(y|ies)|reject(ed|ion)|laid off|layoffs?|unemploy|can'?t (get|find) (a )?(job|interview|work)|no call ?backs?|hundreds of (applications|jobs)|applied to \d+|fake jobs?|ghost jobs?|\bscam/;

export const HOOK_PATTERNS = [
  { key: 'problem_first', claim: "Open on the viewer's job-search pain (ghosting, rejection, no replies)", re: PAIN_RE },
  { key: 'question', claim: 'Open with a direct question to the viewer', re: /\?|^(why|how|what|who|when|where|do|does|did|are|is|can|should|have|ever|would)\b/ },
  { key: 'warning', claim: 'Open with a warning ("stop doing X", "the biggest mistake")', re: /\b(stop|don'?t|do not|never|mistakes?|worst|avoid|red flags?)\b/ },
  { key: 'number_list', claim: 'Open by promising a numbered list ("3 things…")', re: /\b(\d+|three|four|five|six|seven|ten)\s+(ways|tips|things|reasons|steps|mistakes|signs|red flags|questions|jobs|words|phrases|lies|secrets)\b|^#?\d+[.)]\s/ },
  { key: 'direct_address', claim: 'Open by addressing the viewer directly ("If you\'re job hunting…")', re: /^(if you|you|you'?re|your)\b|\bif you('?re| are| have| got)\b/ },
  { key: 'story', claim: 'Open in story mode ("POV", "so I just…")', re: /\b(pov|storytime|story time|so i|i just|i got|i was|my (boss|manager|recruiter|interviewer))\b/ },
  { key: 'hidden_truth', claim: 'Open with a hidden-truth claim ("nobody tells you…")', re: /\b(nobody|no one) (tells|talks|knows)|\bsecret|the truth|the real reason|what they don'?t\b/ },
];

const FORMAT_PATTERNS = [
  { key: 'listicle', claim: 'Numbered-list videos (step 1, 2, 3…)', test: (t) => (t.match(/\b(number (one|two|three)|tip (one|two|#?\d)|first(ly)?,|second(ly)?,|third(ly)?,|step (one|two|\d))/g) || []).length >= 2 || (t.match(/(^|\n)\s*\d[.)]\s/g) || []).length >= 2 },
  { key: 'tutorial', claim: 'Step-by-step how-to / tutorial videos', test: (t) => /\b(how to|step by step|here'?s how|walk you through|tutorial|let me show you)\b/.test(t) },
  { key: 'storytime', claim: 'Personal storytime videos', test: (t) => /\b(storytime|story time|let me tell you|this happened|true story)\b/.test(t) },
  { key: 'reaction', claim: 'Reaction / reply / stitch videos (responding to a post or comment)', test: (t) => /\b(stitch|duet|reply(ing)? to|responding to|react(ing)? to|this comment)\b/.test(t) },
  { key: 'myth_fact', claim: 'Myth-vs-fact / hot-take videos', test: (t) => /\b(myth|unpopular opinion|hot take|truth is|controversial)\b/.test(t) },
  { key: 'series', claim: 'Numbered series ("Part 2", "Day 14 of…")', test: (t) => /\b(part \d+|pt\.? ?\d+|day \d+ of|episode \d+)\b/.test(t) },
];

const TACTIC_PATTERNS = [
  { key: 'cta_comment', claim: 'Explicit comment prompt (CTA: "comment X", "let me know below")', test: (t) => /\b(comment (below|\w+ (and|for|to))|drop (a|an|your) \w+ (below|in the comments)|let me know (below|in the comments)|in the comments)\b/.test(t) },
  { key: 'cta_follow_save', claim: 'Explicit follow / save / share CTA', test: (t) => /\b(follow (me |for )|save this|share this|send this to)\b/.test(t) },
  { key: 'cta_link_dm', claim: 'Funnels viewers off-platform ("link in bio", "DM me")', test: (t) => /\b(link in (my )?bio|dm me|message me|free (guide|template|download)|newsletter)\b/.test(t) },
];

export const TOPICS = [
  { key: 'ghosting', claim: 'Employer ghosting', re: /\bghost(ed|ing)\b|never heard back|radio silence|no response/ },
  { key: 'staffing_recruiters', claim: 'Recruiters & staffing agencies', re: /\b(recruiters?|staffing|agenc(y|ies)|headhunters?|third.party)\b/ },
  { key: 'interviews', claim: 'Interviews', re: /\binterview(s|ing|ed|er)?\b/ },
  { key: 'resume_ats', claim: 'Résumés & ATS screening', re: /\b(resume|résumé|cv|ats|applicant tracking)\b/ },
  { key: 'pay_negotiation', claim: 'Pay, salary ranges & negotiation', re: /\b(salary|salaries|pay range|negotiat\w*|compensation|lowball\w*|offer letter)\b/ },
  { key: 'layoffs', claim: 'Layoffs & being let go', re: /\b(laid off|layoffs?|let go|fired)\b/ },
  { key: 'fake_jobs', claim: 'Fake / ghost job postings', re: /\b(fake (job|posting)s?|ghost jobs?|scam\w*|evergreen (job|posting)s?|not (actually|really) hiring)\b/ },
  { key: 'application_volume', claim: 'Application volume & no callbacks', re: /\b(applied to \d+|\d+ applications|hundreds of applications|mass apply|easy apply|no call ?backs?)\b/ },
  { key: 'job_boards', claim: 'LinkedIn / Indeed / job boards', re: /\b(linkedin|indeed|job boards?|glassdoor|ziprecruiter)\b/ },
  { key: 'networking', claim: 'Networking, referrals & cold outreach', re: /\b(network(ing)?|referrals?|cold (email|message|dm)s?|reach(ing)? out)\b/ },
];

export const PAINS = [
  { key: 'ghosted', claim: 'Being ghosted after applying or interviewing', re: /\bghost(ed|ing)\b|never heard back|radio silence|no response|no repl(y|ies)|stopped (responding|replying)/ },
  { key: 'volume_no_callbacks', claim: 'Sending huge numbers of applications with no callbacks', re: /\b(applied|sent|submitted) (to )?\d{2,}|\b\d{2,} applications|hundreds of (applications|jobs)|no call ?backs?|zero (interviews|callbacks)/ },
  { key: 'fake_postings', claim: 'Fake or never-filled job postings', re: /\b(fake (job|posting)s?|ghost jobs?|not (actually|really) hiring|reposted (the )?(same )?job|evergreen (job|posting)s?)\b/ },
  { key: 'recruiter_vanishes', claim: 'Recruiters / staffing agencies who disappear', re: /\b(recruiters?|staffing|agenc(y|ies))\b.{0,50}\b(disappear\w*|ghost\w*|vanish\w*|stopped|never (called|replied|responded))/ },
  { key: 'pay_hidden_low', claim: 'Hidden or lowball pay', re: /\b(lowball\w*|underpaid|unpaid|below market|no (salary|pay) range|(didn'?t|don'?t|won'?t) (list|post|share) (the )?(salary|pay))\b/ },
  { key: 'long_process', claim: 'Endless interview rounds and slow processes', re: /\b(\d+|four|five|six|seven|eight) rounds?\b|\bmonths? (of|to) (interview|hear)|took (weeks|months)\b/ },
  { key: 'auto_rejected', claim: 'Being auto-rejected by software (ATS / AI screens)', re: /\b(ats|a\.?i\.?|robot|algorithm|software) (rejected|screen\w*|filter\w*)|auto(matic(ally)?|mated)?[ -]?reject\w*/ },
];

// Taught knowledge → insight type. First match wins; nothing matched AND nothing job-search-related
// → dropped (off-purpose for Seen).
const TAUGHT_RULES = [
  { type: 'hook', re: /\bhooks?\b|first (\d|one|two|three|few) seconds?|opening (line|seconds?|shot)|stop (the|them) (scroll|scrolling)|grab (their )?attention|scroll/ },
  { type: 'cadence', re: /\bpost(ing)? (daily|every|consistently|\d+ times)|consisten(t|cy)|frequency|times (a|per) (week|day)|posting schedule|cadence|batch (film|record)/ },
  { type: 'format', re: /\b(format|structure|script|carousel|talking head|b-?roll|green screen|subtitles?|on-?screen text|captions?|edit(ing)?|video length|series|template|thumbnail|cover image)\b/ },
  { type: 'audience_pain', re: /\b(pain points?|struggl\w*|frustrat\w*|audience (wants|needs|feels)|what (your|the) audience)\b/ },
  { type: 'tactic', re: /\b(followers?|grow(th)?|algorithm|engagement|reach|views|cta|call to action|comments?|dms?|funnel|lead magnet|monetiz\w*|brand deals?|collab\w*|newsletter|email list|link in bio|trend(s|ing)?|virality|viral)\b/ },
];
const JOB_DOMAIN_RE = /\b(job|jobs|hiring|hire|recruit\w*|resume|résumé|interview\w*|salary|offer|employer\w*|applica\w*|career\w*|linkedin|ghost\w*|reject\w*|staffing|agenc\w*|layoff\w*|negotiat\w*)\b/;

const ATTRIBUTION_W = { creator_explicit: 1, creator_demonstrated: 0.9, system_inferred: 0.6 };
const STATUS_W = { confirmed: 1, probable: 0.85, ambiguous: 0.5 };

// ---- strength + scoring --------------------------------------------------------------------------

// Strength is a pure function of INDEPENDENT support — exported so the rule is pinned by tests.
export function strengthOf({ videos = 0, creators = 0 } = {}) {
  if (creators >= 3 && videos >= 6) return 'strong';
  if (creators >= 2 && videos >= 3) return 'moderate';
  if (videos >= 3 || (creators >= 2 && videos >= 2)) return 'emerging';
  return 'anecdotal';
}
const rankOf = (s) => STRENGTHS.indexOf(s);
const downgrade = (s) => STRENGTHS[Math.max(0, rankOf(s) - 1)];
export function atLeast(s, min) { return rankOf(s) >= rankOf(min); }

export function recencyWeight(lastIso, now) {
  const t = Date.parse(lastIso || '');
  if (!Number.isFinite(t)) return 0.5; // unknown age → neither rewarded nor dropped
  const age = Math.max(0, (now - t) / DAY);
  return Math.max(0.25, Math.pow(0.5, age / 180)); // half-life ~6 months, floor 0.25
}

function score({ videos, creators, last, quality = 1, lift = null }, now) {
  const liftW = lift && Number.isFinite(lift.ratio) ? Math.sqrt(Math.min(2, Math.max(0.5, lift.ratio))) : 1;
  return Number((Math.log2(1 + videos) * (1 + 0.6 * Math.max(0, creators - 1)) * recencyWeight(last, now) * quality * liftW).toFixed(4));
}

// Engagement lift for a set of posts, relative to EACH creator's own median likes (comments when a
// creator has no likes). Needs ≥6 counted posts for a creator, ≥2 inside and ≥2 outside the set, and
// ≥3 counted posts inside overall — otherwise null (not enough to say anything).
export function engagementLift(memberKeys, postsByCreator) {
  const ratios = []; let n = 0; let metric = null; let creators = 0;
  for (const posts of postsByCreator.values()) {
    const pick = posts.some((p) => p.likes != null) ? 'likes' : (posts.some((p) => p.comments != null) ? 'comments' : null);
    if (!pick) continue;
    const counted = posts.filter((p) => p[pick] != null);
    if (counted.length < 6) continue;
    const inside = counted.filter((p) => memberKeys.has(p.key)); const outside = counted.filter((p) => !memberKeys.has(p.key));
    if (inside.length < 2 || outside.length < 2) continue;
    const base = median(counted.map((p) => p[pick]));
    if (!base) continue;
    ratios.push(median(inside.map((p) => p[pick])) / base);
    n += inside.length; creators++; metric = metric && metric !== pick ? 'engagement' : pick;
  }
  if (!ratios.length || n < 3) return null;
  return { ratio: Number(median(ratios).toFixed(2)), n, creators, metric };
}

// ---- corpus normalisation ------------------------------------------------------------------------

function normaliseCorpus(c) {
  const handle = c.handle || `@${c.project}`;
  const keyOf = new Map(); const posts = new Map();
  for (const v of c.videos || []) {
    const key = `${c.project}:${v.parent || v.id}`;
    keyOf.set(v.id, key);
    const prev = posts.get(key);
    if (!prev) posts.set(key, { key, id: v.id, url: v.url, publishedAt: v.publishedAt, caption: v.caption || '', likes: v.likes, comments: v.comments, handle, project: c.project });
    else { // a carousel's posts share the post's counts; keep the first non-null
      if (prev.likes == null) prev.likes = v.likes; if (prev.comments == null) prev.comments = v.comments;
      if (!prev.caption && v.caption) prev.caption = v.caption;
      if (!prev.publishedAt && v.publishedAt) prev.publishedAt = v.publishedAt;
    }
  }
  const evidence = (c.evidence || []).filter((e) => keyOf.has(e.video_id)).map((e) => ({ ...e, key: keyOf.get(e.video_id) }));
  const knowledge = (c.knowledge || []).map((k) => ({ ...k, evidence: (k.evidence || []).filter((e) => keyOf.has(e.video_id)).map((e) => ({ ...e, key: keyOf.get(e.video_id) })) }));
  return { project: c.project, handle, posts, evidence, knowledge };
}

function citationFrom(e, post, handle) {
  return { handle, video_id: e.video_id, url: e.source_url || post?.url || null, at: citeAt(e.timestamp_start, e.timestamp_end),
    type: String(e.evidence_type || '').toLowerCase() || null, excerpt: firstSentence(e.content, 160) };
}

// Pick ≤3 citations: one per creator first, newest posts first, timestamped ones preferred.
function pickCitations(cands, postsAll, max = 3) {
  const sorted = cands.slice().sort((a, b) => String(postsAll.get(b.key)?.publishedAt || '').localeCompare(String(postsAll.get(a.key)?.publishedAt || ''))
    || ((b.cite.at ? 1 : 0) - (a.cite.at ? 1 : 0)));
  const out = []; const usedCreator = new Set(); const usedPost = new Set();
  for (const pass of [0, 1]) {
    for (const c of sorted) {
      if (out.length >= max) break;
      if (usedPost.has(c.key)) continue;
      if (pass === 0 && usedCreator.has(c.cite.handle)) continue;
      out.push(c.cite); usedPost.add(c.key); usedCreator.add(c.cite.handle);
    }
  }
  return out;
}

const insightId = (type, basis, key) => `ci-${type}-${createHash('sha1').update(`${type}|${basis}|${key}`).digest('hex').slice(0, 10)}`;

// Assemble one insight from its member posts + citation candidates.
const MEMBERS = new WeakMap(); // insight → Set of post keys (internal; used by the de-dup pass)

function makeInsight({ type, basis, key, claim, detail = null, members, cands, ctx, quality = 1, extra = {} }) {
  const keys = [...members];
  const creators = [...new Set(keys.map((k) => ctx.postsAll.get(k)?.handle).filter(Boolean))];
  const dates = keys.map((k) => ctx.postsAll.get(k)?.publishedAt).filter(Boolean).sort();
  const totalPosts = creators.reduce((s, h) => s + (ctx.postsPerHandle.get(h) || 0), 0);
  const support = { videos: keys.length, creators: creators.length, handles: creators,
    share: totalPosts ? Number((keys.length / totalPosts).toFixed(2)) : null, of: totalPosts };
  let strength = strengthOf(support);
  if (quality < 0.6) strength = downgrade(strength);
  const lift = ctx.engagement ? engagementLift(new Set(keys), ctx.postsByCreator) : null;
  const last = dates[dates.length - 1] || null;
  const out = {
    id: insightId(type, basis, key), type, basis, claim, detail, strength,
    score: score({ videos: support.videos, creators: support.creators, last, quality, lift }, ctx.now),
    support,
    recency: { first: dates[0] || null, last, lastPT: last ? ptDate(last) : null,
      ageDays: last && Number.isFinite(Date.parse(last)) ? Math.max(0, Math.round((ctx.now - Date.parse(last)) / DAY)) : null },
    engagement: lift,
    citations: pickCitations(cands, ctx.postsAll),
    // The newest citation from EACH creator behind the line, so one creator's view can cite its own video.
    citationsByHandle: Object.fromEntries(creators.map((h) => [h, pickCitations(cands.filter((c) => c.cite.handle === h), ctx.postsAll, 1)[0]]).filter(([, c]) => c)),
    ...extra,
  };
  MEMBERS.set(out, new Set(keys));
  return out;
}

const overlapOf = (a, b) => { const A = MEMBERS.get(a), B = MEMBERS.get(b); if (!A || !B || !A.size || !B.size) return 0; let n = 0; for (const k of A) if (B.has(k)) n++; return n / (A.size + B.size - n); };

// De-dup observed patterns that are really the same posts. Within a type (e.g. "question" vs
// "pain-first" hooks on the same videos) keep the larger and note the overlap; a topic that covers the
// same posts as an audience pain folds into the pain (the pain is the more actionable reading).
export function dedupeObserved(list) {
  const drop = new Set();
  const note = (keep, gone) => { (keep.overlaps ||= []).push({ claim: gone.claim, type: gone.type, shared: Math.round(overlapOf(keep, gone) * 100) / 100 }); drop.add(gone); };
  const obs = list.filter((i) => i.basis === 'observed' && i.type !== 'cadence');
  for (let x = 0; x < obs.length; x++) for (let y = x + 1; y < obs.length; y++) {
    const a = obs[x], b = obs[y];
    if (drop.has(a) || drop.has(b)) continue;
    if (a.type === b.type && overlapOf(a, b) >= 0.7) {
      const [keep, gone] = (b.support.videos > a.support.videos) ? [b, a] : [a, b];
      note(keep, gone);
    } else if (a.type !== b.type && [a.type, b.type].includes('topic') && [a.type, b.type].includes('audience_pain') && overlapOf(a, b) >= 0.8) {
      note(a.type === 'audience_pain' ? a : b, a.type === 'topic' ? a : b);
    }
  }
  return list.filter((i) => !drop.has(i));
}

// ---- the engine ----------------------------------------------------------------------------------

// buildInsights(corpora, { now }) → { generatedAt, creators[], totals, insights[] (ranked) }.
// `corpora` = the per-creator shape library.creatorCorpus() returns. Pure — tests feed fixtures.
export function buildInsights(corpora = [], { now = Date.now(), engagement = true } = {}) {
  const raw = (Array.isArray(corpora) ? corpora : []).filter(Boolean);
  // Account relevance gate: an account whose videos/knowledge are not about Seen's world contributes
  // no OBSERVED patterns (its hooks/topics describe another niche); its knowledge rows are still
  // gated one by one, so a genuinely useful tip from it survives.
  const verdicts = new Map(raw.map((c) => [c.project, accountVerdict(c)]));
  const norm = raw.map(normaliseCorpus).filter((c) => c.posts.size);
  const observes = (handle) => norm.some((c) => c.handle === handle && verdicts.get(c.project)?.verdict !== 'prune');
  const postsAll = new Map(); const postsByCreator = new Map(); const postsPerHandle = new Map();
  for (const c of norm) {
    for (const [k, p] of c.posts) postsAll.set(k, p);
    postsByCreator.set(c.handle, [...c.posts.values()]);
    postsPerHandle.set(c.handle, (postsPerHandle.get(c.handle) || 0) + c.posts.size);
  }
  const ctx = { now, postsAll, postsByCreator, postsPerHandle, engagement };
  const insights = [];

  // Per-post text views, built once.
  const evByPost = new Map();
  for (const c of norm) { if (!observes(c.handle)) continue; for (const e of c.evidence) { if (!evByPost.has(e.key)) evByPost.set(e.key, []); evByPost.get(e.key).push({ ...e, handle: c.handle }); } }

  // 1) HOOKS — the line spoken (else on-screen text) inside the first HOOK_WINDOW_S seconds.
  const hookLine = new Map();
  for (const [key, evs] of evByPost) {
    const early = evs.filter((e) => Number.isFinite(Number(e.timestamp_start)) && Number(e.timestamp_start) <= HOOK_WINDOW_S)
      .sort((a, b) => Number(a.timestamp_start) - Number(b.timestamp_start));
    const pick = early.find((e) => String(e.evidence_type).toLowerCase() === 'spoken') || early.find((e) => String(e.evidence_type).toLowerCase() === 'ocr');
    if (pick && String(pick.content || '').trim()) hookLine.set(key, pick);
  }
  for (const pat of HOOK_PATTERNS) {
    const members = new Set(); const cands = []; const ends = [];
    for (const [key, e] of hookLine) {
      const text = firstSentence(e.content, 200).toLowerCase();
      if (!pat.re.test(text)) continue;
      members.add(key); cands.push({ key, cite: citationFrom(e, postsAll.get(key), e.handle) });
      const end = Number(e.timestamp_end); if (Number.isFinite(end)) ends.push(end);
    }
    if (!members.size) continue;
    const by = median(ends);
    const lands = by != null ? Math.min(HOOK_WINDOW_S, Math.max(1, Math.round(by))) : null;
    insights.push(makeInsight({ type: 'hook', basis: 'observed', key: pat.key, members, cands, ctx,
      claim: `${pat.claim}${lands ? ` — lands by ~${lands}s` : ''}`,
      detail: `${members.size} of ${hookLine.size} posts with a readable opening line (first ${HOOK_WINDOW_S}s).` }));
  }

  // Full per-post text (caption + speech + screen text) for formats / topics / tactics.
  const fullText = new Map();
  for (const [key, p] of postsAll) {
    if (!observes(p.handle)) continue;
    const evs = evByPost.get(key) || [];
    fullText.set(key, `${p.caption || ''}\n${evs.map((e) => e.content || '').join('\n')}`.toLowerCase().slice(0, 20000));
  }
  const textCite = (key, matches) => { // the first evidence row (else the caption) that shows the match
    const p = postsAll.get(key);
    const e = (evByPost.get(key) || []).find((x) => matches(String(x.content || '').toLowerCase()));
    if (e) return citationFrom(e, p, p.handle);
    return { handle: p.handle, video_id: p.id, url: p.url, at: null, type: 'caption', excerpt: firstSentence(p.caption, 160) };
  };

  // 2) FORMATS + 3) observed TACTICS (explicit CTAs).
  for (const [type, list] of [['format', FORMAT_PATTERNS], ['tactic', TACTIC_PATTERNS]]) {
    for (const pat of list) {
      const members = new Set(); const cands = [];
      for (const [key, t] of fullText) if (pat.test(t)) { members.add(key); cands.push({ key, cite: textCite(key, pat.test) }); }
      if (members.size) insights.push(makeInsight({ type, basis: 'observed', key: pat.key, claim: pat.claim, members, cands, ctx }));
    }
  }

  // 4) TOPICS + 5) AUDIENCE PAINS — counted per post, cited at the exact matching evidence row.
  for (const [type, list] of [['topic', TOPICS], ['audience_pain', PAINS]]) {
    for (const pat of list) {
      const members = new Set(); const cands = [];
      for (const [key, t] of fullText) if (pat.re.test(t)) { members.add(key); cands.push({ key, cite: textCite(key, (x) => pat.re.test(x)) }); }
      if (members.size) insights.push(makeInsight({ type, basis: 'observed', key: pat.key, members, cands, ctx,
        claim: type === 'topic' ? `Topic: ${pat.claim}` : `Audience pain: ${pat.claim}` }));
    }
  }

  // 6) CADENCE — posts/week inside each creator's researched window, then one cross-creator line.
  const cadences = [];
  for (const [handle, posts] of postsByCreator) {
    if (!observes(handle)) continue;
    const ts = posts.map((p) => Date.parse(p.publishedAt || '')).filter(Number.isFinite).sort((a, b) => a - b);
    if (ts.length < 4) continue;
    const spanDays = (ts[ts.length - 1] - ts[0]) / DAY;
    if (spanDays < 7) continue;
    const gaps = ts.slice(1).map((t, i) => (t - ts[i]) / DAY);
    cadences.push({ handle, perWeek: Number(((ts.length - 1) / (spanDays / 7)).toFixed(1)), medianGapDays: Number(median(gaps).toFixed(1)), posts: ts.length, spanDays: Math.round(spanDays),
      latest: posts.slice().sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')))[0] });
  }
  if (cadences.length) {
    const members = new Set(); const cands = [];
    for (const c of cadences) for (const p of postsByCreator.get(c.handle)) if (p.publishedAt) members.add(p.key);
    for (const c of cadences) cands.push({ key: c.latest.key, cite: { handle: c.handle, video_id: c.latest.id, url: c.latest.url, at: null, type: 'cadence',
      excerpt: `${c.perWeek} posts/week — ${c.posts} posts over ${c.spanDays} days, median gap ${c.medianGapDays} days` } });
    const rates = cadences.map((c) => c.perWeek);
    const med = Number(median(rates).toFixed(1));
    const claim = cadences.length === 1
      ? `${cadences[0].handle} posts ~${med} videos/week in the researched window`
      : `Researched creators post a median of ~${med} videos/week (range ${Math.min(...rates)}–${Math.max(...rates)})`;
    const ins = makeInsight({ type: 'cadence', basis: 'observed', key: 'posting_rate', claim, members, cands, ctx,
      detail: 'Measured on the researched window (the newest videos pulled), not each creator\'s full history.', extra: { perCreator: cadences.map(({ latest, ...r }) => r) } });
    // Cadence strength is about how many CREATORS it is measured on, not how many posts exist.
    ins.strength = cadences.length >= 3 ? 'strong' : cadences.length === 2 ? 'moderate' : 'emerging';
    ins.engagement = null;
    ins.support.share = null; ins.support.of = null; // every post counts toward cadence — a share would be noise
    insights.push(ins);
  }

  // 7) TAUGHT — canonical knowledge, gated for relevance, typed, and merged across videos/creators.
  const items = []; const pruned = [];
  for (const c of norm) for (const k of c.knowledge) {
    const status = String(k.status || '').toLowerCase(); const attribution = String(k.attribution || '').toLowerCase();
    if (status === 'contradicted' || status === 'deprecated' || attribution === 'independent_improvement') continue;
    if (String(k.type || '').toLowerCase() === 'claim') continue; // a creator's own result claim proves nothing about what works
    if (!k.evidence.length || !String(k.title || '').trim()) continue; // uncited knowledge is not evidence
    const r = k.record || {};
    const text = `${k.title} ${k.description || ''} ${(Array.isArray(r.conditions) ? r.conditions : []).join(' ')}`.toLowerCase();
    const gate = knowledgeRelevance(k);
    if (gate.verdict !== 'keep') { pruned.push({ knowledge_id: k.knowledge_id, project: c.project, handle: c.handle, title: String(k.title).slice(0, 160), why: gate.why, family: pruneFamily(gate) }); continue; }
    const rule = TAUGHT_RULES.find((x) => x.re.test(text));
    const type = rule ? rule.type : (JOB_DOMAIN_RE.test(text) ? 'advice' : SIGNAL_TYPE[gate.signals[0]] || 'advice');
    items.push({ k, handle: c.handle, type, toks: new Set(tokens(`${k.title} ${k.description || ''}`)),
      quality: (ATTRIBUTION_W[attribution] ?? 0.6) * (STATUS_W[status] ?? 0.7) });
  }
  // Greedy clustering: biggest-support records seed clusters; a record joins the first same-type
  // cluster it is similar enough to. Deterministic order (support, then id).
  items.sort((a, b) => new Set(b.k.evidence.map((e) => e.key)).size - new Set(a.k.evidence.map((e) => e.key)).size
    || String(a.k.knowledge_id).localeCompare(String(b.k.knowledge_id)));
  // Compared against the cluster SEED's tokens (not a growing union), so a chain of small rewordings
  // can never drift one cluster into an unrelated claim.
  const clusters = []; const byType = new Map();
  for (const it of items) {
    const same = byType.get(it.type) || [];
    const hit = same.find((cl) => similarity(cl.toks, it.toks) >= 0.55);
    if (hit) hit.items.push(it);
    else { const cl = { type: it.type, toks: it.toks, items: [it] }; clusters.push(cl); same.push(cl); byType.set(it.type, same); }
  }
  for (const cl of clusters) {
    const lead = cl.items[0].k;
    const members = new Set(); const cands = [];
    for (const it of cl.items) for (const e of it.k.evidence) { members.add(e.key); cands.push({ key: e.key, cite: citationFrom(e, postsAll.get(e.key), it.handle) }); }
    if (!members.size) continue;
    const quality = cl.items.reduce((s, it) => s + it.quality, 0) / cl.items.length;
    insights.push(makeInsight({ type: cl.type, basis: 'taught', key: [...cl.items.map((it) => it.k.knowledge_id)].sort()[0], members, cands, ctx,
      claim: String(lead.title).trim().slice(0, 160),
      detail: lead.description ? String(lead.description).trim().slice(0, 220) : null,
      quality,
      extra: { knowledgeIds: cl.items.map((it) => it.k.knowledge_id), merged: cl.items.length } }));
  }

  const ranked = dedupeObserved(insights);
  ranked.sort((a, b) => rankOf(b.strength) - rankOf(a.strength) || b.score - a.score || a.id.localeCompare(b.id));
  const creators = norm.map((c) => ({ handle: c.handle, project: c.project, posts: c.posts.size, knowledge: c.knowledge.length,
    verdict: verdicts.get(c.project) || null,
    window: (() => { const d = [...c.posts.values()].map((p) => p.publishedAt).filter(Boolean).sort(); return d.length ? { from: d[0], to: d[d.length - 1], fromPT: ptDate(d[0]), toPT: ptDate(d[d.length - 1]) } : null; })() }));
  return {
    generatedAt: new Date(now).toISOString(),
    creators,
    totals: { creators: creators.length, posts: postsAll.size, insights: ranked.length,
      byStrength: Object.fromEntries(STRENGTHS.map((s) => [s, ranked.filter((i) => i.strength === s).length])),
      prunedRows: pruned.length, prunedAccounts: creators.filter((c) => c.verdict?.verdict === 'prune').length },
    insights: ranked,
    pruned, // knowledge rows the relevance gate dropped, each with its reason (never silent)
    prunedSummary: summarisePruned(pruned),
    caveat: CAVEAT,
  };
}

// Dropped rows by reason family, per creator and overall: { total, byFamily:{family:n}, byHandle:{handle:{total, byFamily}} }.
export function summarisePruned(pruned = []) {
  const out = { total: pruned.length, byFamily: {}, byHandle: {} };
  for (const r of pruned) {
    const f = r.family || 'no link to Seen';
    out.byFamily[f] = (out.byFamily[f] || 0) + 1;
    const h = (out.byHandle[r.handle] ||= { total: 0, byFamily: {} });
    h.total++; h.byFamily[f] = (h.byFamily[f] || 0) + 1;
  }
  return out;
}

// ---- rendering for the board meeting + chat ------------------------------------------------------

// Which insight types each department reasons over. Departments not listed get no creator block.
export const DEPT_TYPES = {
  growth: ['hook', 'format', 'topic', 'audience_pain', 'cadence', 'tactic', 'advice', 'brand'],
  strategy: ['audience_pain', 'topic', 'hook', 'format', 'cadence', 'tactic', 'brand', 'monetization'],
  revenue: ['audience_pain', 'tactic', 'monetization', 'brand'],
  product: ['audience_pain', 'topic', 'advice', 'product'],
};

// 'Oct 18' (California calendar); the year only when it is not the current year.
function shortDate(iso, now = Date.now()) {
  const t = Date.parse(iso || ''); if (!Number.isFinite(t)) return null;
  const yr = (x) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric' }).format(new Date(x));
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', ...(yr(t) === yr(now) ? {} : { year: 'numeric' }) }).format(new Date(t));
}

// One line per insight — the same format for meeting + chat, so a proposal can quote it verbatim.
export function insightLine(i, { citations = 1, urls = false, excerpt = 70 } = {}) {
  const s = i.support || {};
  const parts = [`${s.creators} creator${s.creators === 1 ? '' : 's'} / ${s.videos} video${s.videos === 1 ? '' : 's'}${s.of ? ` (${Math.round((s.share || 0) * 100)}% of ${s.of})` : ''}`];
  const last = shortDate(i.recency?.last); if (last) parts.push(`latest ${last}`);
  if (i.engagement) { const e = i.engagement; parts.push(`${e.metric} ${e.ratio}× creator median (n=${e.n}, ${e.creators} creator${e.creators === 1 ? '' : 's'})`); }
  const same = (i.overlaps || []).filter((o) => o.type === i.type); // e.g. two hook styles on the same videos
  if (same.length) parts.push(`usually combined with "${same.map((o) => String(o.claim).replace(/ — lands by.*$/, '').replace(/\s*\(.*?\)/g, '').slice(0, 80)).join('", "')}"`);
  const cites = (i.citations || []).slice(0, citations).map((c) => `${c.handle}${c.at ? ` ${c.at}` : ''}${urls && c.url ? ` ${c.url}` : ''}${c.excerpt ? ` "${String(c.excerpt).slice(0, excerpt)}"` : ''}`);
  return `• [${TYPE_LABEL[i.type] || i.type} · ${i.basis} · ${i.strength}] ${i.claim} — ${parts.join('; ')}${cites.length ? `. e.g. ${cites.join(' | ')}` : ''}`;
}

// The board meeting's creator-evidence block for ONE department. Only insights at or above
// `minStrength` pass; an empty library, an unlisted department, or nothing strong enough → text ''
// (the block is ABSENT — never a placeholder). Bounded to maxChars. Returns { text, used[] }.
export function creatorEvidenceBlock(lib, deptId, { maxChars = 1500, maxItems = 6, minStrength = 'moderate' } = {}) {
  const types = DEPT_TYPES[deptId];
  if (!lib || !Array.isArray(lib.insights) || !lib.insights.length || !types) return { text: '', used: [] };
  const pool = lib.insights.filter((i) => types.includes(i.type) && atLeast(i.strength, minStrength));
  if (!pool.length) return { text: '', used: [] };
  // Diversity: at most 2 per type, so one rich type cannot crowd out the rest.
  const perType = new Map(); const picked = [];
  for (const i of pool) { const n = perType.get(i.type) || 0; if (n >= 2) continue; perType.set(i.type, n + 1); picked.push(i); if (picked.length >= maxItems) break; }
  const t = lib.totals || {};
  const head = `CREATOR EVIDENCE (Creator Library: ${t.creators} public creator${t.creators === 1 ? '' : 's'}, ${t.posts} videos. observed = counted in the videos, taught = creators' advice; engagement = correlation. Research, not proof — a proposal that relies on a line must cite its support, e.g. "3 creators / 7 videos"):\n`;
  let text = head; const used = [];
  for (const i of picked) {
    const line = insightLine(i) + '\n';
    if (text.length + line.length > maxChars) { if (used.length) break; continue; }
    text += line; used.push(i);
  }
  if (!used.length) return { text: '', used: [] };
  return { text: text.trimEnd() + '\n\n', used };
}

// A proposal's creator-evidence citations, checked against the lines its department was SHOWN:
// `cited` = insight ids whose exact "N creators / M videos" support the text quotes; `phantom` = counts
// it quotes that were never shown (an invented number). Pure; used by engine/run.mjs.
export function checkCreatorCitations(text, used = []) {
  const cited = []; const phantom = [];
  for (const m of String(text || '').matchAll(/\b(\d+)\s+creators?\s*\/\s*(\d+)\s+videos?\b/gi)) {
    const c = Number(m[1]); const v = Number(m[2]);
    const hits = (used || []).filter((i) => i.support?.creators === c && i.support?.videos === v);
    if (hits.length) { for (const h of hits) if (!cited.includes(h.id)) cited.push(h.id); }
    else phantom.push(`${c} creator${c === 1 ? '' : 's'} / ${v} video${v === 1 ? '' : 's'}`);
  }
  return { cited, phantom: [...new Set(phantom)] };
}

const CONTENT_Q =/\b(hooks?|content|posts?|posting|videos?|reels?|tiktoks?|instagram|ig|creators?|influencers?|audience|growth|grow|marketing|viral|captions?|formats?|topics?|pain ?points?|cadence|engagement|followers?|social|scripts?|ctas?|what works|job[- ]?seekers?)\b/i;

// Compact creator-evidence context for the Board Room chat. '' unless the question is about content /
// growth / creators / the audience (so unrelated questions pay nothing) AND the library has evidence.
// Emerging insights may appear, always labelled; anecdotal ones never do.
// Which insight types a question is asking about ("what hooks work?" → hook). Empty set = none named.
export function typesAsked(question) {
  const ql = String(question || '').toLowerCase(); const want = new Set();
  if (/\bhooks?|open(ing|er)?s?\b|first (few )?seconds?\b/.test(ql)) want.add('hook');
  if (/\bformats?|structure|style|script/.test(ql)) want.add('format');
  if (/\btopics?|talk about|subjects?|themes?\b/.test(ql)) want.add('topic');
  if (/\bpain|struggl|frustrat|complain|audience|job[- ]?seekers?\b/.test(ql)) want.add('audience_pain');
  if (/\bcadence|how often|frequency|per week|schedule|consisten/.test(ql)) want.add('cadence');
  if (/\bctas?\b|growth|grow|followers?|engagement|viral|tactics?/.test(ql)) want.add('tactic');
  if (/\btrust|credib|brand|reputation|authentic/.test(ql)) want.add('brand');
  if (/\bmoneti|pricing|price|revenue|sponsor|paid|subscription/.test(ql)) want.add('monetization');
  if (/\bproduct|feature|onboarding|landing page|sign.?ups?|ux\b/.test(ql)) want.add('product');
  if (/\badvice|tips?|resume|résumé|interview|recruiter|applicants?|job search/.test(ql)) want.add('advice');
  return want;
}

// Insights (≥ emerging) ordered for a question: the asked-about types first, then strength, then
// word overlap with the question, then score.
export function rankForQuestion(lib, question) {
  const want = typesAsked(question); const qt = new Set(tokens(question));
  return (lib?.insights || []).filter((i) => atLeast(i.strength, 'emerging'))
    .map((i) => ({ i, want: want.has(i.type) ? 1 : 0, rel: tokens(`${i.claim} ${i.detail || ''}`).filter((t) => qt.has(t)).length }))
    .sort((a, b) => b.want - a.want || rankOf(b.i.strength) - rankOf(a.i.strength) || b.rel - a.rel || b.i.score - a.i.score)
    .map((x) => ({ ...x.i, asked: !!x.want }));
}

// What the last board meeting took from the Creator Library, in one line the chat can quote
// ("the growth team was shown …; 1 proposal cited it"). '' when no meeting used creator evidence.
export function lastMeetingLine(m) {
  if (!m || !m.byDept || !Object.keys(m.byDept).length) return '';
  const depts = Object.entries(m.byDept).map(([d, list]) => `${d}: ${(list || []).slice(0, 3).map((i) => `"${String(i.claim).slice(0, 70)}" (${i.support?.creators} creator${i.support?.creators === 1 ? '' : 's'} / ${i.support?.videos} video${i.support?.videos === 1 ? '' : 's'}, ${i.strength})`).join('; ')}`);
  const cited = (m.cited || []).slice(0, 3).map((c) => `"${String(c.title).slice(0, 80)}" (${c.dept})`);
  return `LAST BOARD MEETING (${formatPT(m.at) || 'recently'} PT, run ${m.runId || '?'}) used these Creator Library lines — ${depts.join(' | ')}. `
    + (cited.length ? `${(m.cited || []).length} proposal(s) cited one: ${cited.join(', ')}.` : 'No proposal cited them.');
}

export function creatorContextFrom(lib, question, { maxChars = 2400, maxItems = 8, lastMeeting = null } = {}) {
  const q = String(question || '');
  if (!lib || !lib.insights?.length || !CONTENT_Q.test(q)) return '';
  const pool = rankForQuestion(lib, q);
  if (!pool.length) return '';
  const t = lib.totals || {};
  let text = `CREATOR LIBRARY EVIDENCE (${t.creators} researched public creator${t.creators === 1 ? '' : 's'}, ${t.posts} videos; computed ${shortDate(lib.generatedAt) || 'recently'} PT). `
    + 'Answer creator/content questions from these lines and quote their citations (creator, timestamp, link). '
    + 'Strength is computed from independent creators/videos: strong ≥3 creators & ≥6 videos, moderate ≥2 creators & ≥3 videos, '
    + 'emerging = one creator or very few videos — say "emerging" out loud and never present it as proven. Observed = counted in the videos; taught = what creators advise.\n';
  let n = 0;
  for (const i of pool) {
    if (n >= maxItems) break;
    const line = insightLine(i, { citations: 2, urls: true, excerpt: 100 }) + '\n';
    if (text.length + line.length > maxChars) continue;
    text += line; n++;
  }
  if (!n) return '';
  const meet = lastMeetingLine(lastMeeting);
  return (meet ? `${text}${meet}` : text).trimEnd();
}

// A complete, deterministic Board Room answer to "what <hooks|formats|…> work?" — only the asked-about
// types, ≥ emerging, cited. '' when the library has nothing for that question (the model takes over).
export function answerCreatorQuestion(lib, question, { max = 6 } = {}) {
  const asked = rankForQuestion(lib, question).filter((i) => i.asked).slice(0, max);
  if (!asked.length) return '';
  const t = lib.totals || {};
  const kinds = [...new Set(asked.map((i) => TYPE_LABEL[i.type] || i.type))].join(', ');
  return `### What the Creator Library shows — ${kinds}\n_${t.creators} researched creator${t.creators === 1 ? '' : 's'} · ${t.posts} videos · strength = how many independent creators/videos back each line (strong ≥3 creators & ≥6 videos; emerging = one creator or very few videos — not proven)._\n\n`
    + asked.map((i) => insightLine(i, { citations: 2, urls: true, excerpt: 100 }).replace(/^• /, '- ')).join('\n')
    + `\n\n_${CAVEAT}_`;
}

// ---- the live library (cached) -------------------------------------------------------------------

let corpusCache = null; // { sig, corpora } — raw reads, reused until any project's database changes
let cache = null;       // { key, lib } — the cross-creator result

// Every researched creator's corpus, with "unresolved" (ambiguous) knowledge resolved: corroborated
// across ALL creators or decided by the owner (resolutions.mjs). Cached on the databases' signature.
export async function libraryCorpora({ lib = null } = {}) {
  const L = lib || await import('./library.mjs');
  const names = L.projectNames ? L.projectNames() : (L.listProjects() || []).map((p) => p.name);
  const sig = names.map((n) => (L.projectSignature ? L.projectSignature(n) : n)).join('|');
  let corpora;
  if (!lib && corpusCache && corpusCache.sig === sig) corpora = corpusCache.corpora;
  else { corpora = names.map((n) => L.creatorCorpus(n)).filter(Boolean); if (!lib) corpusCache = { sig, corpora }; }
  // Archived (pruned) accounts and rows are gone from every view, meeting and chat until restored.
  const A = await import('./prune.mjs');
  const archive = A.readArchive();
  corpora = A.applyArchive(corpora, archive);
  const R = await import('./resolutions.mjs');
  const resolved = corpora.map((c) => {
    const others = corpora.filter((x) => x !== c).flatMap((x) => x.knowledge || []);
    const overrides = R.readOverrides(c.project);
    return R.applyResolutions(c, R.resolveAmbiguous(c.knowledge || [], { overrides, others }));
  });
  const overlay = createHash('sha1').update(JSON.stringify(archive)).update(resolved.map((c) => JSON.stringify(R.readOverrides(c.project))).join('|')).digest('hex').slice(0, 12);
  return { sig: `${sig}|${overlay}`, corpora: resolved };
}

// Build insights over EVERY researched creator, or one with { project } (that creator's key points).
export async function libraryInsights({ project = null, now = Date.now(), lib = null } = {}) {
  const { sig, corpora } = await libraryCorpora({ lib });
  const key = `${sig}|${project || '*'}`;
  if (!lib && cache && cache.key === key && now - Date.parse(cache.lib.generatedAt) < DAY) return cache.lib;
  const out = buildInsights(project ? corpora.filter((c) => c.project === project) : corpora, { now });
  if (!lib && !project) cache = { key, lib: out };
  return out;
}

// The ONE function the Board Room chat calls (engine/server.mjs). Never throws; '' when there is
// nothing relevant to say.
export async function creatorContext(question) {
  try {
    let lastMeeting = null;
    try { lastMeeting = (await import('../memory.mjs')).loadState()?.creatorEvidence || null; } catch { /* no meeting yet */ }
    return creatorContextFrom(await libraryInsights(), question, { lastMeeting });
  } catch { return ''; }
}

// ONE creator's key points, read from the CROSS-creator result so each point says how many other
// creators back it (a point only this creator makes stays labelled weak). Archived creators are absent
// from `lib` (null here). Every point carries this creator's own citation when it has one.
export function creatorKeyPoints(lib, project, { max = 60 } = {}) {
  const c = (lib?.creators || []).find((x) => x.project === project);
  if (!c) return null;
  const mine = (lib.insights || []).filter((i) => (i.support?.handles || []).includes(c.handle)).slice(0, max)
    .map((i) => ({ ...i, own: i.citationsByHandle?.[c.handle] || null, alsoBy: (i.support.handles || []).filter((h) => h !== c.handle) }));
  const pruned = lib.prunedSummary?.byHandle?.[c.handle] || { total: 0, byFamily: {} };
  return {
    project, handle: c.handle, verdict: c.verdict || null, posts: c.posts, knowledge: c.knowledge, window: c.window,
    generatedAt: lib.generatedAt,
    byStrength: Object.fromEntries(STRENGTHS.map((s) => [s, mine.filter((i) => i.strength === s).length])),
    keyPoints: mine,
    pruned: { ...pruned, examples: (lib.pruned || []).filter((r) => r.handle === c.handle).slice(0, 8) },
    caveat: CAVEAT,
  };
}

// A plain-text digest of one creator's key points (chat + act verb). Weak lines are labelled, never hidden.
export function keyPointsText(kp, { max = 8 } = {}) {
  if (!kp) return '';
  const v = kp.verdict ? `${kp.verdict.verdict === 'prune' ? 'PRUNE' : kp.verdict.verdict === 'keep' ? 'KEEP' : 'PENDING'} — ${kp.verdict.why}` : '';
  const lines = kp.keyPoints.slice(0, max).map((i) => {
    const cite = i.own || i.citations?.[0];
    const also = i.alsoBy.length ? `; also ${i.alsoBy.slice(0, 3).join(', ')}` : '; only this creator so far';
    return `• [${TYPE_LABEL[i.type] || i.type} · ${i.basis} · ${i.strength}] ${i.claim} — ${i.support.videos} video${i.support.videos === 1 ? '' : 's'}${also}${cite ? `. e.g. ${cite.handle}${cite.at ? ` ${cite.at}` : ''}${cite.url ? ` ${cite.url}` : ''}${cite.excerpt ? ` "${String(cite.excerpt).slice(0, 90)}"` : ''}` : ''}`;
  });
  const fam = Object.entries(kp.pruned.byFamily || {}).sort((a, b) => b[1] - a[1]).map(([f, n]) => `${n} ${f}`).join(', ');
  return [`${kp.handle}: ${kp.posts} videos · ${kp.knowledge} knowledge records${v ? ` · ${v}` : ''}`,
    lines.length ? lines.join('\n') : 'No key points that serve SeenJobs yet.',
    kp.pruned.total ? `Dropped as off-purpose: ${kp.pruned.total} record(s)${fam ? ` (${fam})` : ''}.` : '',
  ].filter(Boolean).join('\n');
}
