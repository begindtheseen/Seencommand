// The copywriter: three platform-native variants for a calendar item (Reddit post + title, Reddit comment,
// short-video script with hook / beats / CTA, LinkedIn post, X thread, email, landing headline, ad, creator
// pitch, DM), each with "why this works" and the trust checklist (lib/growth/trust.mjs) — the text Brandon
// sees is the checked, cleaned text. Variants are written from the brand kit, the item and its evidence (a
// live callout) by templates; when a model lane is available, reason() rewrites them in the brand voice and
// the rewrite goes through the same checklist (a model-added number is removed, never trusted).
// Approvals are remembered: the approved style per format reorders future variants, the last approved
// examples ride in the model prompt, and a pointer fact goes to the brain (growth:copy · approved-<format>).
import { readDoc, writeDoc } from './store.mjs';
import { trustCheck } from './trust.mjs';
import { getBrand, brandBrief } from './brand.mjs';
import { cite, rule } from './rules.mjs';
import { config } from '../config.mjs';
import { ptStamp } from './pt.mjs';

export const STYLES = ['data-first', 'story-first', 'question-first'];
export const FORMATS = ['reddit-post', 'reddit-comment', 'video-script', 'linkedin-post', 'x-thread', 'email', 'landing-headline', 'ad', 'creator-pitch', 'dm'];
export const LIMITS = { redditTitle: 300, xPost: 280, adHeadline: 40, adPrimary: 125, emailSubject: 60, landingHeadline: 70 };

const PILLAR_PATH = { 'agency-index': '/agencies', 'data-story': '/ghost-report', 'build-in-public': '/agencies', 'how-to': '/companies', 'credit-the-good': '/companies', 'outcome-card': '/tracker', positioning: '/ghosted' };
export function itemLink(item, base = config.seenBaseUrl()) { return item?.evidence?.url || `${base}${PILLAR_PATH[item?.pillar] || '/agencies'}`; }
const clip = (s, n) => { s = String(s).replace(/\s+/g, ' ').trim(); return s.length <= n ? s : `${s.slice(0, n - 1).replace(/\s+\S*$/, '')}…`; };
const evName = (ev) => (ev ? String(ev.line).split(':')[0] : null);

// ---- the template writers: (item, ev, link, kit) → { title?, body, parts? } per style -----------------
const W = {
  'reddit-post': {
    'data-first': (it, ev, link) => ({
      title: ev ? `Tracking which employers and agencies answer applicants — ${ev.line}` : clip(it.hook, LIMITS.redditTitle),
      body: [ev ? `**${ev.line}** (${ev.confidence.toLowerCase()} — ${ev.reports} reports so far).` : it.hook,
        'In plain English: when people applied there and reported back, that is how often they never heard anything.',
        'How it is counted: applicant-reported outcomes, trust-weighted. A grade only appears once there are 5 first-party reports, and small samples are labelled small.',
        `Been ghosted by them — or did they actually answer you? Adding it takes about 2 minutes: ${link}`,
        'I\'m the founder of Seen and I\'ll answer anything about how the numbers are made, including the parts that are still thin.'].join('\n\n') }),
    'story-first': (it, ev, link) => ({
      title: clip(ev ? `If a recruiter went quiet after the "quick call", you're not imagining a pattern (${evName(ev)} data inside)` : 'If a recruiter went quiet after the "quick call", you\'re not imagining a pattern', LIMITS.redditTitle),
      body: ['You apply, you get the call, you send the updated résumé — and then nothing. Most of us have been there more than once.',
        'I got tired of it being invisible, so I started keeping a public record of which employers and staffing agencies actually answer applicants.',
        ev ? `So far: ${ev.line}. That is ${ev.confidence.toLowerCase()}, and it says so on the page.` : 'It is early — when a company has fewer than 5 reports, the page says "not enough data" instead of guessing.',
        `If it happened to you, you can put it on the record in about 2 minutes: ${link}`,
        'Founder here, building this in the open.'].join('\n\n') }),
    'question-first': (it, ev, link) => ({
      title: clip(ev ? `Which staffing agencies actually got back to you? ${evName(ev)} is at ${ev.ghostPct}% ghosted in our reports so far` : 'Which staffing agencies actually got back to you after the first call?', LIMITS.redditTitle),
      body: ['Genuine question for this sub: which agencies answered you, and which went silent?',
        ev ? `I keep a public index of this. ${ev.line} — ${ev.confidence.toLowerCase()}, so more reports would make it fairer either way.` : 'I keep a public index of this, and most agencies do not have enough reports yet to say anything fair.',
        `Reply here, or add yours to the record (about 2 minutes): ${link}`,
        'Disclosure: I\'m the founder of Seen, the site that keeps the index.'].join('\n\n') }),
  },
  'reddit-comment': {
    'data-first': () => ({ body: 'Two checks that save a lot of waiting: look the company up before you apply (has anyone reported hearing back?), and set yourself a day-14 cut-off — if there is no human reply by then, treat it as a no and move your energy elsewhere. Silence is information.' }),
    'story-first': () => ({ body: 'What helps a lot of people here: a short list of employers that have actually replied to applicants, and a rule that a "quick call" is not progress until there is a next step with a date. It keeps the waiting from eating your week.' }),
    'question-first': () => ({ body: 'Did they give you a date for the next step on the call? If not, I\'d keep applying as if this one is a no — not because it is, but because the ones that do hire usually tell you what happens next.' }),
  },
  'video-script': {
    'data-first': (it, ev, link) => ({ parts: { hook: ev ? `${evName(ev)}: ${ev.ghostPct}% ghost rate. Here is where that number comes from.` : 'Before you spend an hour on this application, check one thing.',
      beats: ['Screen: seenjobs.io → search the company', ev ? `Show the grade with "${ev.reports} reports · ${ev.confidence.toLowerCase()}" visible` : 'Show a company page — and one that honestly says "not enough data yet"', 'VO: "That\'s from applicant-reported outcomes, not a vibe — and when there is no data, it says so."', 'Screen: the Report button — "if they ghosted you, put it on the record"'],
      cta: 'Check yours before you apply — seenjobs.io', onScreen: ev ? ev.sourceLine : 'seenjobs.io', caption: 'I built this because ghosting should leave a record. Founder here.' } }),
    'story-first': (it) => ({ parts: { hook: 'Applied. Interviewed. Then nothing. Sound familiar?',
      beats: ['Face to camera, 3 seconds: "If this happened to you, it should leave a record."', 'Screen: mark an application ghosted in the tracker', 'Screen: the outcome card appears', 'VO: "Now it warns the next person who applies there."'],
      cta: 'Put yours on the record — seenjobs.io', onScreen: it.hook, caption: 'Founder here. Ghosted cards are free.' } }),
    'question-first': () => ({ parts: { hook: 'Does this company even answer applicants? Let\'s check.',
      beats: ['Screen: paste a company name into seenjobs.io', 'Show the response record with its report count', 'VO: "Green means people heard back. Red means they mostly didn\'t. Grey means not enough data yet — and it says so."', 'Screen: the Ghost Index at /agencies'],
      cta: 'Ten seconds before every application — seenjobs.io', onScreen: 'seenjobs.io', caption: 'I built this. Ask me anything about the data.' } }),
  },
  'linkedin-post': {
    'data-first': (it, ev, link) => ({ body: [ev ? ev.line + '.' : it.hook, '', 'That number comes from applicants reporting what happened after they applied — trust-weighted, and labelled with how many reports it rests on.', ev ? `${ev.reports} reports is ${ev.confidence.toLowerCase()}. We show it anyway, with the label, because a small honest number beats a big invented one.` : 'Most companies do not have enough reports yet. We say so instead of guessing.', '', `The full record: ${link}`, '', 'I\'m building Seen in public — the response record of employers.'].join('\n') }),
    'story-first': (it, ev, link) => ({ body: ['Every week someone tells me the same story: applied, interviewed, then silence.', '', 'Ghosting is so normal it has become invisible. So I started keeping a public record of which employers and staffing agencies answer applicants.', '', ev ? `One line from it this week: ${ev.line}.` : 'It starts small and says so: under 5 reports, a company shows "not enough data".', '', `If you hire: answering applicants is a competitive advantage now. If you apply: check before you spend the hour. ${link}`, '', 'Founder of Seen.'].join('\n') }),
    'question-first': (it, ev, link) => ({ body: ['Recruiters and hiring managers — honest question: how many applicants hear back from your team?', '', 'Applicants are starting to keep score in public.', ev ? `Example: ${ev.line}.` : '', '', `What would it take for your company to have a record you would be proud to link to? ${link}`, '', 'I\'m the founder of Seen.'].filter((x, i, a) => !(x === '' && a[i - 1] === '')).join('\n') }),
  },
  'x-thread': {
    'data-first': (it, ev, link) => ({ parts: { posts: [ev ? `${ev.line}.` : clip(it.hook, 270), 'Where it comes from: applicants reporting what happened after they applied. Trust-weighted. Small samples labelled small.', ev ? `${ev.reports} reports = ${ev.confidence.toLowerCase()}. More reports make it fairer, either way.` : 'Under 5 reports a company shows "not enough data". No guessing.', `The record: ${link}\n\nI'm the founder.`] } }),
    'story-first': (it, ev, link) => ({ parts: { posts: ['Applied. Interviewed. Silence.\n\nIf that is your week, you are not the problem — and it should leave a record.', 'So I\'m building one: which employers and staffing agencies actually answer applicants.', ev ? `This week: ${ev.line}.` : 'It is early and it says so.', `Check before you apply, or add yours: ${link}\n\nFounder here.`] } }),
    'question-first': (it, ev, link) => ({ parts: { posts: ['Which employer answered you fastest — and which never did?', 'I keep a public response record of employers and staffing agencies, built from applicant reports.', ev ? `Right now: ${ev.line}.` : 'Most still have too few reports to judge, and the page says so.', `Reply, or add yours (2 minutes): ${link}\n\nI built it.`] } }),
  },
  email: {
    'data-first': (it, ev, link) => ({ parts: { subject: clip(ev ? `${evName(ev)}: ${ev.ghostPct}% ghost rate (${ev.reports} reports)` : 'This week in who answers applicants', LIMITS.emailSubject), preheader: 'From applicant reports, with the sample size on every number.' },
      body: ['Hi {first_name},', '', ev ? `${ev.line} — ${ev.confidence.toLowerCase()}.` : it.hook, '', `See the record: ${link}`, '', 'If you are waiting on an application right now, your tracker will ask at day 7, 14 and 30 what happened — one tap, and it warns the next applicant.', '', '— Brandon, founder of Seen'].join('\n') }),
    'story-first': (it, ev, link) => ({ parts: { subject: 'Silence is information', preheader: 'What to do on day 14 with no reply.' },
      body: ['Hi {first_name},', '', 'If an application has been quiet for two weeks, here is the honest move: keep applying as if it is a no, and record what happened when you know.', '', ev ? `For example, ${ev.line}.` : '', '', `Check an employer before you spend the hour: ${link}`, '', '— Brandon'].filter((x, i, a) => !(x === '' && a[i - 1] === '')).join('\n') }),
    'question-first': (it, ev, link) => ({ parts: { subject: 'Did they ever get back to you?', preheader: 'One tap closes the loop.' },
      body: ['Hi {first_name},', '', 'Quick one: did the employers you applied to recently ever get back to you?', '', 'Your answer — offer, rejected, ghosted or still waiting — goes into the public record that helps the next applicant decide.', '', `Update it here: ${link.replace(/\/(agencies|companies|ghost-report)$/, '/tracker')}`, '', '— Brandon, founder of Seen'].join('\n') }),
  },
  'landing-headline': {
    'data-first': () => ({ parts: { headline: 'Check if they ghost before you apply.', sub: 'Response and ghost rates for employers and staffing agencies, from applicant reports — with the sample size on every number.', cta: 'Check a company' } }),
    'story-first': () => ({ parts: { headline: 'Ghosted again? Put it on the record.', sub: 'Report what happened in about 2 minutes. It becomes part of that employer\'s public response record.', cta: 'Report a ghosting' } }),
    'question-first': () => ({ parts: { headline: 'Will they even answer you?', sub: 'See which employers and agencies respond to applicants — and which go silent.', cta: 'Look one up' } }),
  },
  ad: {
    'data-first': (it, ev) => ({ parts: { primary: clip(ev ? `${ev.line}. Check any employer before you apply.` : 'See whether an employer answers applicants before you apply.', LIMITS.adPrimary), headline: clip('Check if they ghost', LIMITS.adHeadline), description: 'From applicant reports. Free.', cta: 'Learn more' } }),
    'story-first': () => ({ parts: { primary: clip('Applied, interviewed, then silence? It should leave a record. See who answers applicants.', LIMITS.adPrimary), headline: clip('Ghosted? Check first.', LIMITS.adHeadline), description: 'The response record of employers.', cta: 'Learn more' } }),
    'question-first': () => ({ parts: { primary: clip('Does this company answer applicants? Find out in seconds before you spend an hour applying.', LIMITS.adPrimary), headline: clip('Do they answer applicants?', LIMITS.adHeadline), description: 'Free lookup. Honest sample sizes.', cta: 'Search' } }),
  },
  'creator-pitch': {
    'data-first': (it, ev, link) => ({ body: [`Hi {creator_name} — I run Seen, a public record of which employers and staffing agencies answer applicants.`, ev ? `Thought this might be useful for your audience: ${ev.line} (${ev.confidence.toLowerCase()}). Source: ${link}` : `Thought the lookup might be useful for your audience: ${link}`, 'No ask and no payment — if you ever use it, the link is the source and the sample size is on the page. Happy to pull any company for you.', '— Brandon (founder)'].join('\n\n') }),
    'story-first': (it, ev, link) => ({ body: ['Hi {creator_name} — your post about {their_story} is exactly why I built Seen: it keeps a public record of which employers answer applicants.', ev ? `If you ever want a number for a video: ${ev.line}. Source: ${link}` : `If you ever want data for a video: ${link}`, 'Nothing expected in return. Founder here — ask me anything.'].join('\n\n') }),
    'question-first': (it, ev, link) => ({ body: ['Hi {creator_name} — would a "does this company ghost?" lookup be useful for your audience?', `It is free: ${link}. Every number shows how many applicant reports it is based on${ev ? ` (e.g. ${ev.line})` : ''}.`, 'If you want, I can pull the record for any companies your viewers ask about. — Brandon, founder of Seen'].join('\n\n') }),
  },
  dm: {
    'data-first': (it, ev, link) => ({ body: [`Hey — saw your post about {company} going silent after {detail}. That genuinely sucks.`, ev ? `I keep a public record of this: ${ev.line}.` : 'I keep a public record of which companies and staffing agencies ghost applicants, so the next person can check first.', `If you're up for it, reporting what happened takes about 2 minutes: ${link}`, 'I\'m the founder, not a bot — happy to answer anything.'].join(' ') }),
    'story-first': (it, ev, link) => ({ body: ['Hey — read your post about {company}. This kind of silence is exactly why I started keeping a public ghost-rate record.', `If you want it on the record (anonymous if you like): ${link}`, 'Founder here, building it in the open.'].join(' ') }),
    'question-first': (it, ev, link) => ({ body: ['Hey — did {company} ever get back to you after {detail}?', `I'm the founder of a site that tracks which employers answer applicants; if they didn't, adding it takes about 2 minutes and warns the next applicant: ${link}`].join(' ') }),
  },
};

// "Why this works", per format and style — and honest about whether a number is in it.
const WHY_BY_FORMAT = {
  'reddit-comment': {
    'data-first': ['platform_rules', 'Concrete advice they can use today — worth upvoting with no link at all, which is what earns the right to post later.'],
    'story-first': ['founder_content', 'Relatable without a pitch; it builds Brandon\'s standing in the sub before any post of his own.'],
    'question-first': ['dont_scale', 'Answers with the question that helps them decide — invites a reply instead of a lecture.'] },
  'landing-headline': {
    'data-first': ['positioning', 'States the promise and the category in one line — the visitor knows what Seen is in a breath.'],
    'story-first': ['beachhead', 'Names the moment of pain the beachhead visitor arrived with, then gives one action.'],
    'question-first': ['activation_first', 'A question the visitor answers "yes" to, pointing at the first useful action (a lookup).'] },
  dm: {
    'data-first': ['dont_scale', 'A personal first line, one useful fact, one link, no follow-up (OUTREACH_SCRIPTS.md script 2).'],
    'story-first': ['platform_rules', 'The soft version (script 3 spirit): empathy first, the link only as an option.'],
    'question-first': ['dont_scale', 'Asks about their experience first; the ask is small and optional.'] },
  'creator-pitch': {
    'data-first': ['promotable', 'Hands them a citable number with its source — it makes them look good and asks for nothing.'],
    'story-first': ['dont_scale', 'References their own post: personal, not a blast.'],
    'question-first': ['promotable', 'Offers a free tool their audience can use — a reason to mention Seen that serves the viewer.'] },
  email: {
    'data-first': ['weekly_retention', 'The subject carries the receipt; the body keeps the day 7/14/30 loop alive.'],
    'story-first': ['weekly_retention', 'Advice they can use this week builds the habit of opening.'],
    'question-first': ['weekly_retention', 'A one-tap answer closes the outcome loop — retention and data in one click.'] },
};
const WHY = {
  'data-first': ['honest_numbers', 'Leads with a real number and its sample size — the receipt is the hook, and a skeptic can click the source.'],
  'data-first-none': ['honest_numbers', 'Leads with how Seen counts instead of a number — honest while the data is thin, and still specific.'],
  'story-first': ['founder_content', 'Opens on the pain the reader already lived; the founder voice earns the link instead of pushing it.'],
  'question-first': ['platform_rules', 'Asks for their experience first — native to communities, invites replies, and the link is optional.'],
};
export function whyFor(format, style, hasEvidence) {
  return WHY_BY_FORMAT[format]?.[style] || (style === 'data-first' && !hasEvidence ? WHY['data-first-none'] : WHY[style]);
}

const asText = (format, v) => {
  if (format === 'video-script') return [v.parts.hook, ...v.parts.beats, v.parts.cta, v.parts.caption].join('\n');
  if (format === 'x-thread') return v.parts.posts.join('\n\n');
  if (format === 'email') return `${v.parts.subject}\n${v.parts.preheader}\n\n${v.body}`;
  if (format === 'landing-headline') return `${v.parts.headline}\n${v.parts.sub}\n${v.parts.cta}`;
  if (format === 'ad') return `${v.parts.primary}\n${v.parts.headline}\n${v.parts.description}`;
  return [v.title, v.body].filter(Boolean).join('\n\n');
};

/** Format checks: lengths and required parts. Returns [] when the variant is well-formed. */
export function formatProblems(format, v) {
  const p = [];
  if (format === 'reddit-post') { if (!v.title) p.push('missing title'); else if (v.title.length > LIMITS.redditTitle) p.push(`title over ${LIMITS.redditTitle} characters`); if (!v.body) p.push('missing body'); }
  if (format === 'x-thread') { const posts = v.parts?.posts || []; if (posts.length < 2) p.push('a thread needs at least 2 posts'); posts.forEach((x, i) => { if (x.length > LIMITS.xPost) p.push(`post ${i + 1} over ${LIMITS.xPost} characters`); }); }
  if (format === 'video-script') { for (const k of ['hook', 'beats', 'cta']) if (!v.parts?.[k] || (Array.isArray(v.parts[k]) && !v.parts[k].length)) p.push(`missing ${k}`); }
  if (format === 'email') { if (!v.parts?.subject) p.push('missing subject'); else if (v.parts.subject.length > LIMITS.emailSubject) p.push(`subject over ${LIMITS.emailSubject} characters`); }
  if (format === 'ad') { if ((v.parts?.headline || '').length > LIMITS.adHeadline) p.push(`headline over ${LIMITS.adHeadline} characters`); if ((v.parts?.primary || '').length > LIMITS.adPrimary) p.push(`primary text over ${LIMITS.adPrimary} characters`); }
  if (format === 'landing-headline' && (v.parts?.headline || '').length > LIMITS.landingHeadline) p.push(`headline over ${LIMITS.landingHeadline} characters`);
  return p;
}

// Apply the trust check to every text field of a variant, keeping its shape; then re-check the cleaned
// whole so `trust.ok` describes exactly the text Brandon would post.
function checkVariant(format, item, v) {
  const ctx = { evidence: item.evidence || null, channel: item.channel, format, link: item.link !== false };
  const before = trustCheck(asText(format, v), ctx);
  const bare = { ...ctx, channel: '', format: '', additions: false }; // titles, subjects, hooks: no disclosure/footer appended
  const out = { ...v };
  if (out.title) out.title = trustCheck(out.title, bare).clean;
  if (out.body) out.body = trustCheck(out.body, ctx).clean;
  if (out.parts) {
    const p = { ...out.parts };
    for (const [k, val] of Object.entries(p)) {
      if (Array.isArray(val)) p[k] = val.map((x, i) => trustCheck(x, k === 'posts' && i === val.length - 1 ? ctx : bare).clean).filter(Boolean);
      else if (typeof val === 'string') p[k] = trustCheck(val, k === 'caption' ? { ...bare, channel: ctx.channel } : bare).clean;
    }
    out.parts = p;
  }
  const after = trustCheck(asText(format, out), ctx);
  const fixed = new Set(before.flags.map((f) => f.id));
  return { ...out, trust: { ok: after.ok && !after.flags.some((f) => f.severity === 'block'), flags: before.flags, checklist: after.checklist.map((c) => ({ ...c, fixed: fixed.has(c.id) })) } };
}

export function templateVariants(item, { kit = getBrand().kit, base = config.seenBaseUrl(), order = STYLES } = {}) {
  const format = FORMATS.includes(item.format) ? item.format : 'linkedin-post';
  const ev = item.evidence || null; const link = itemLink(item, base);
  return order.map((style) => {
    const raw = W[format][style](item, ev, link, kit);
    const [ruleId, why] = whyFor(format, style, !!ev);
    return { style, format, ...raw, why, rule: ruleId, ruleName: rule(ruleId).name, ruleWhy: cite(ruleId) };
  });
}

// ---- learning from approvals ---------------------------------------------------------------------------
const EMPTY = { drafts: {}, approvals: [], styleCounts: {} };
export function copyState() { return readDoc('copy', EMPTY); }
/** Styles ordered by how often Brandon approved them for this format (ties keep the default order). */
export function learnedOrder(format, state = copyState()) {
  const c = state.styleCounts?.[format] || {};
  return [...STYLES].sort((a, b) => (c[b] || 0) - (c[a] || 0) || STYLES.indexOf(a) - STYLES.indexOf(b));
}
export function approvedExamples(format, state = copyState(), n = 3) { return state.approvals.filter((a) => a.format === format).slice(-n); }

/**
 * Draft three variants for a calendar item. reasonFn (lib/llm.mjs reason) is optional; without a model the
 * templates are the drafts. Every variant is trust-checked and format-checked. Stored under the item id.
 */
export async function draftItem(item, { reasonFn = null, kit = getBrand().kit, base = config.seenBaseUrl(), now = new Date() } = {}) {
  if (!item) return { ok: false, error: 'no such calendar item' };
  const state = copyState();
  const order = learnedOrder(item.format, state);
  let variants = templateVariants(item, { kit, base, order });
  let engine = 'templates';
  if (reasonFn) {
    const examples = approvedExamples(item.format, state).map((a) => `- (${a.style}) ${String(a.text).slice(0, 300)}`).join('\n');
    const prompt = `Rewrite these three ${item.format} drafts for SeenJobs in the brand voice. Keep every number, link and placeholder EXACTLY as given; add no new numbers, names, quotes or claims. Keep the same keys.\n\n${brandBrief(kit)}\n\nItem: ${item.hook}\nPlatform rules: ${(item.platformRules || []).join(' · ')}\n${examples ? `Drafts Brandon approved before (match their feel):\n${examples}\n` : ''}\nDrafts (JSON): ${JSON.stringify(variants.map(({ style, title, body, parts }) => ({ style, title, body, parts })))}\n\nAnswer with ONE JSON object: {"variants":[{"style":"…","title":"…","body":"…","parts":{…}}]} in the same order.`;
    try {
      const r = await reasonFn({ deptId: 'growth', system: 'You are a world-class direct-response copywriter who never invents facts. Respond with JSON only.', prompt, maxTokens: 1400, fallback: '' });
      if (r && r.engine !== 'fallback' && r.text) {
        const m = String(r.text).match(/\{[\s\S]*\}/); const j = m ? JSON.parse(m[0]) : null;
        if (j && Array.isArray(j.variants) && j.variants.length === variants.length) {
          variants = variants.map((v, i) => { const x = j.variants[i] || {}; const merged = { ...v, title: typeof x.title === 'string' && v.title ? x.title : v.title, body: typeof x.body === 'string' && v.body ? x.body : v.body, parts: v.parts && x.parts && typeof x.parts === 'object' ? { ...v.parts, ...x.parts } : v.parts };
            return formatProblems(item.format, merged).length ? v : merged; });
          engine = r.engine;
        }
      }
    } catch { engine = 'templates'; }
  }
  variants = variants.map((v) => { const c = checkVariant(item.format, item, v); return { ...c, formatProblems: formatProblems(item.format, c) }; });
  const rec = { at: now.toISOString(), engine, itemId: item.id, format: item.format, variants };
  const doc = copyState(); doc.drafts = { ...doc.drafts, [item.id]: rec }; writeDoc('copy', doc);
  return { ok: true, ...rec };
}

/** Brandon approves variant `index` of an item's drafts. Remembered for learning + a brain pointer. */
export async function approveCopy(itemId, index, { recordFact = null, now = new Date() } = {}) {
  const doc = copyState(); const d = doc.drafts?.[itemId];
  if (!d) return { ok: false, error: 'draft this item first' };
  const i = Number(index); const v = d.variants?.[i];
  if (!v) return { ok: false, error: `no variant ${index} (0–${(d.variants?.length || 1) - 1})` };
  if (v.trust && v.trust.ok === false) return { ok: false, error: 'this variant still fails the trust checklist — edit it or pick another' };
  const text = asText(d.format, v);
  doc.approvals = [...(doc.approvals || []), { itemId, format: d.format, style: v.style, at: now.toISOString(), text: text.slice(0, 1200) }].slice(-200);
  doc.styleCounts = { ...doc.styleCounts, [d.format]: { ...(doc.styleCounts?.[d.format] || {}), [v.style]: ((doc.styleCounts?.[d.format] || {})[v.style] || 0) + 1 } };
  doc.drafts[itemId] = { ...d, approved: i, approvedAt: now.toISOString() };
  writeDoc('copy', doc);
  let brain = null;
  if (recordFact) {
    try { brain = await recordFact({ subject: 'growth:copy', predicate: `approved-${d.format}`, object: `${v.style} — "${text.replace(/\s+/g, ' ').slice(0, 160)}" (item ${itemId}, ${ptStamp(now)} PT; ${doc.styleCounts[d.format][v.style]} approvals of this style)` }); }
    catch (e) { brain = { ok: false, error: e.message }; }
  }
  return { ok: true, itemId, variant: i, style: v.style, text, learned: learnedOrder(d.format, doc), brain };
}
export { asText };
