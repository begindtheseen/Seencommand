// The relevance gate — does this row (or account) serve SeenJobs' GROWTH, CONTENT, BRAND or PRODUCT?
//
// SeenJobs (seenjobs.io) grades employers on how they treat applicants: ghosting and response rates,
// the Staffing Agency Ghost Index, first-hand applicant reports, transparent job listings. The Creator
// Library exists to grow THAT: content that reaches job seekers, hooks/formats that work on them, the
// pains they voice, brand trust, monetization and product ideas. A row that serves none of these
// (generic motivation, another niche, personal life, editing-software trivia, vague business talk) is
// dropped from every view, the board-meeting block and the chat context — and prune can archive it.
//
// Owner (2026-10-21): "allow it to be ruthless with removing data from the creators tab that doesn't
// serve the greater purpose of the app." So: generic business wording alone is NOT enough to keep a row;
// a row is kept only for a specific Seen signal. A specific signal beats a negative one ("my manager
// ghosted me after the interview" is personal AND job search → kept, with the reason saying so).
//
// Deterministic and explainable: every verdict carries its reason, in words the owner can check.

export const POSITIVE = [
  { key: 'job_search', why: 'job search / hiring', re: /\b(jobs?|job (search|hunt\w*|seekers?|offers?|boards?|postings?|listings?)|hiring|hired|recruit(er|ers|ing|ment)|resumes?|résumés?|cv|cover letters?|interview\w*|salar(y|ies)|pay (range|transparency)|offer letters?|employers?|applicants?|applications? (process|tracker|portal)|\d+ (job )?applications|applying (to|for) (jobs?|roles?|positions?)|applied (to|for)|careers?|linkedin|indeed|glassdoor|ghost(ed|ing)|rejection (email|letter)s?|got rejected|staffing|recruiting agenc(y|ies)|staffing agenc(y|ies)|temp agenc(y|ies)|headhunt\w*|layoffs?|laid off|negotiat\w* (your )?(salary|offer|pay)|unemploy\w*|ats\b|applicant tracking)\b/ },
  { key: 'content_craft', why: 'content craft (hooks, formats, posting)', re: /\b(hooks?|first (\d|one|two|three|few) seconds?|stop(s)? the scroll|scroll(ing)?|retention|watch time|captions?|on-?screen text|subtitles?|script(s|ing)? (your|a|the) (video|reel)s?|storytell\w*|carousels?|reels?|shorts|tiktok|post(s|ing)? (daily|every|consistently)|posting (schedule|cadence|consistently)|cadence|content (pillars?|strategy|ideas?|calendar|format)|video (format|length|structure)|talking head|trending (audio|sounds?)|viral\w*)\b/ },
  { key: 'growth', why: 'audience growth', re: /\b(followers?|audience|grow(th|ing)? (your|an|the)? ?(account|audience|following|page|brand)|algorithm|engagement( rate)?|impressions|comments? (section|below)|dms?\b|ugc|newsletter|email list|lead magnets?|ctas?\b|calls? to action|link in bio|conversion rates?|organic (reach|growth)|shares? and saves?|saves?\b.*\bshares?)\b/ },
  { key: 'brand_trust', why: 'brand trust', re: /\b(trust(worthy|ed)?|credib\w*|authentic(ity)?|transparen(cy|t (pay|salary|pricing|process|about|with))|reputation|testimonials?|social proof|personal brand\w*|brand (voice|story|identity|positioning)|market positioning|niche down|thought leader\w*)\b/ },
  { key: 'monetization', why: 'monetization', re: /\b(monetiz\w*|pricing|price point|subscriptions?|paywall|upsell\w*|revenue|mrr|paid (users?|plans?|tier)|sponsor(ed|ship|ships)|brand deals?|affiliate\w*|digital products?)\b/ },
  { key: 'product', why: 'product / UX', re: /\b(user experience|onboarding (flow|email)s?|churn|landing pages?|sign-?ups?|activation rate|saas|mvp|product roadmap|feedback loop|product.market fit|pmf|waitlist)\b/ },
];

// Off-purpose families. A row with ONLY these (no specific Seen signal) is pruned with the family named.
export const NEGATIVE = [
  { key: 'motivation', why: 'generic motivation', re: /\b(mindset|motivat\w*|grind\w*|hustle\w*|discipline|manifest\w*|gratitude|believe in yourself|never give up|keep going|self[- ]?love|positive vibes|law of attraction|stay hungry|success is|dream big|you got this|comfort zone)\b/ },
  { key: 'personal_life', why: 'personal life', re: /\b(my (wife|husband|girlfriend|boyfriend|kids?|son|daughter|mom|dad|family|dog|cat)|wedding|vacation|holiday|birthday|dating|relationship advice|workout|gym|diet|meal prep|skincare|morning routine)\b/ },
  { key: 'unrelated_niche', why: 'an unrelated niche', re: /\b(crypto\w*|bitcoin|forex|day trad\w*|options trading|stock picks?|real estate|airbnb|dropship\w*|recipes?|cooking|baking|fitness|bodybuilding|fashion|outfits?|makeup|beauty|gaming|video games?|anime|astrology|tarot|travel (tips|hacks)|car (reviews?|mods?))\b/ },
  { key: 'tool_trivia', why: 'editing-software / gear trivia', re: /\b(keyboard shortcuts?|hotkeys?|shortcut (key|for)|after effects|premiere( pro)?|davinci( resolve)?|final cut|capcut|figma|photoshop|illustrator|blender|cinema 4d|c4d|plugins?|presets?|keyframes?|easing|graph editor|render (settings?|queue)|luts?\b|camera settings|lens(es)?|gimbal|lighting setup|frame rate|codec|expressions? (panel|code)|masks?\b|layers? (panel|stack)|motion blur|null objects?|pre-?comps?)\b/ },
];

// Generic business words. They no longer keep a row by themselves (ruthless): a row whose ONLY signal
// is one of these is pruned as "generic business wording". Listed so the reason can say so.
const WEAK = /\b(users?|apps?|features?|clients?|customers?|offers?|courses?|coaching|views|reach|community|collab\w*|business|marketing|brand)\b/;

// One row's verdict. `text` = title + description (+ conditions) for knowledge, or any free text.
// → { verdict: 'keep'|'prune', score 0..1, signals[], why }
export function relevance(text) {
  const t = String(text || '').toLowerCase();
  const pos = POSITIVE.filter((r) => r.re.test(t));
  const neg = NEGATIVE.filter((r) => r.re.test(t));
  if (pos.length) {
    return { verdict: 'keep', score: Math.min(1, 0.5 + 0.15 * pos.length), signals: pos.map((r) => r.key),
      why: `serves Seen — ${pos.map((r) => r.why).join(', ')}${neg.length ? ` (despite ${neg.map((r) => r.why).join(', ')})` : ''}` };
  }
  if (neg.length) return { verdict: 'prune', score: 0, signals: neg.map((r) => r.key), why: `${neg.map((r) => r.why).join(', ')} — nothing for Seen's growth, content, brand or product` };
  if (WEAK.test(t)) return { verdict: 'prune', score: 0.15, signals: ['weak_business'], why: 'only generic business wording — nothing specific to job seekers, content craft, trust, pricing or product' };
  return { verdict: 'prune', score: 0.1, signals: [], why: "no link to Seen's growth, content, brand or product" };
}

const knowledgeText = (k) => `${k.title || ''} ${k.description || ''} ${(Array.isArray(k.record?.conditions) ? k.record.conditions : []).join(' ')}`;
export const knowledgeRelevance = (k) => relevance(knowledgeText(k));

// The short family name of a prune reason, for counting ("tool_trivia" → "editing-software / gear trivia").
export function pruneFamily(gate) {
  const s = (gate?.signals || [])[0];
  const hit = NEGATIVE.find((r) => r.key === s);
  if (hit) return hit.why;
  if (s === 'weak_business') return 'generic business wording';
  return 'no link to Seen';
}

// Seen's own suggestions (independent_improvement) are not the creator's knowledge — never counted for or against it.
const isLive = (k) => !['contradicted', 'deprecated'].includes(String(k.status || '').toLowerCase()) && String(k.attribution || '').toLowerCase() !== 'independent_improvement';

// An account's verdict, from what its knowledge and its videos are about. `corpus` = the
// library.creatorCorpus() shape. keep: ≥30% of its live knowledge serves Seen, or ≥25% of its videos
// touch job search / hiring (its audience IS Seen's audience); pending: nothing extracted and no text to
// judge; else prune — always with the counts in the reason.
export function accountVerdict(corpus) {
  const knowledge = (corpus?.knowledge || []).filter(isLive);
  const videos = corpus?.videos || [];
  const textByVideo = new Map(videos.map((v) => [v.id, String(v.caption || '')]));
  for (const e of corpus?.evidence || []) if (textByVideo.has(e.video_id)) textByVideo.set(e.video_id, `${textByVideo.get(e.video_id)} ${e.content || ''}`.slice(0, 6000));
  const kept = knowledge.filter((k) => knowledgeRelevance(k).verdict === 'keep').length;
  const jobVideos = [...textByVideo.values()].filter((t) => POSITIVE[0].re.test(t.toLowerCase())).length;
  const kShare = knowledge.length ? kept / knowledge.length : null;
  const vShare = textByVideo.size ? jobVideos / textByVideo.size : null;
  const pct = (x) => `${Math.round(x * 100)}%`;
  const facts = [knowledge.length ? `${kept} of ${knowledge.length} knowledge records (${pct(kShare)}) serve Seen` : 'no knowledge extracted yet',
    textByVideo.size ? `${jobVideos} of ${textByVideo.size} videos (${pct(vShare)}) touch job search / hiring` : 'no videos yet'];
  const hasText = [...textByVideo.values()].some((t) => t.trim());
  const base = { kept, total: knowledge.length, jobVideos, videos: textByVideo.size };
  if (!knowledge.length && !hasText) return { verdict: 'pending', ...base, why: `${facts.join('; ')} — nothing to judge yet` };
  const keep = (kShare != null && kShare >= 0.3) || (vShare != null && vShare >= 0.25);
  return { verdict: keep ? 'keep' : 'prune', ...base,
    why: `${facts.join('; ')}${keep ? '' : " — too little of it serves Seen's growth, content, brand or product"}` };
}
