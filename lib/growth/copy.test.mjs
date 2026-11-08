// Run: node --test lib/growth/copy.test.mjs
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setGrowthDir } from './store.mjs';
import { trustCheck, claimNumbers, CHECKS } from './trust.mjs';
import { draftItem, approveCopy, templateVariants, formatProblems, learnedOrder, copyState, FORMATS, LIMITS, STYLES } from './copy.mjs';

beforeEach(() => setGrowthDir(mkdtempSync(join(tmpdir(), 'growth-copy-'))));
const EV = { line: 'Acme Staffing: 83% ghost rate across 6 applicant reports', source: 'seenjobs.io · 6 applicant reports, trust-weighted · low confidence · as of 2026-10-21 PT', ghostPct: 83, responsePct: 17, reports: 6, confidence: 'Low confidence', url: 'https://seenjobs.io/agencies' };
const CHANNEL = { 'reddit-post': 'reddit', 'reddit-comment': 'reddit', 'video-script': 'short-video', 'linkedin-post': 'linkedin', 'x-thread': 'x', email: 'email', 'landing-headline': 'landing', ad: 'ad', 'creator-pitch': 'creators', dm: 'dm' };
const item = (format, o = {}) => ({ id: `2026-10-27-${format}`, format, channel: CHANNEL[format], hook: 'Before you hop on another quick call, check the agency.', pillar: 'agency-index', evidence: EV, link: format !== 'reddit-comment', platformRules: [], ...o });

test('trust: an unbacked number is flagged AND its sentence removed; backed numbers stay', () => {
  const r = trustCheck('Acme Staffing: 83% ghost rate across 6 applicant reports. Over 12,000 job seekers use Seen every week. Founder here.', { evidence: EV, channel: 'reddit' });
  assert.ok(r.flags.some((f) => f.id === 'numbers' && /12,000/.test(f.text)));
  assert.doesNotMatch(r.clean, /12,000/); assert.match(r.clean, /83% ghost rate across 6 applicant reports/); assert.equal(r.ok, true);
});

test('trust: product facts only count in their own context ("20 credits" yes, "20 users" no)', () => {
  assert.equal(trustCheck('The Credit Pack adds 20 credits. A grade needs 5 reports. Pro is $9.99 a month.', {}).flags.filter((f) => f.id === 'numbers').length, 0);
  const bad = trustCheck('We already have 20 users and 5 companies love it. Pro is $12.', {});
  assert.ok(bad.flags.some((f) => f.id === 'numbers')); assert.doesNotMatch(bad.clean, /20 users|\$12/);
  assert.deepEqual(claimNumbers('week 3 of the plan, v2.1, https://x.io/a/9').map((n) => n.value), []); // not claims
});

test('trust: superlatives, fake urgency, scale, guarantees, evasion words and fake quotes are removed', () => {
  const t = 'Seen is the best job site. Last chance to join! Thousands of users trust us. Guaranteed replies. Beat the ATS with stealth mode. "Seen changed my life" — Maria. Check before you apply.';
  const r = trustCheck(t, { channel: '' });
  for (const id of ['superlatives', 'urgency', 'scale', 'guarantee', 'evasion', 'testimonial']) assert.ok(r.flags.some((f) => f.id === id), id);
  assert.equal(r.clean, 'Check before you apply.'); assert.equal(r.ok, true);
});

test('trust: defamation risk is removed, hype is warned, money-for-score is blocked unless it says "never"', () => {
  const r = trustCheck('Acme Staffing is a scam. Our AI-powered index helps. Employers can pay to improve their score.', {});
  assert.ok(r.flags.some((f) => f.id === 'defamation' && f.severity === 'block')); assert.ok(r.flags.some((f) => f.id === 'hype' && f.severity === 'warn'));
  assert.ok(r.flags.some((f) => f.id === 'money-score')); assert.doesNotMatch(r.clean, /scam|pay to improve/);
  assert.equal(trustCheck('Money never changes a score — no sponsor can buy a better grade.', {}).flags.filter((f) => f.id === 'money-score').length, 0);
});

test('trust: founder disclosure, source line and the CAN-SPAM footer are added; value-first posts lose their link', () => {
  const r = trustCheck('Acme Staffing: 83% ghost rate across 6 applicant reports.', { evidence: EV, channel: 'linkedin' });
  assert.match(r.clean, /founder of Seen/); assert.ok(r.flags.some((f) => f.id === 'disclosure' && f.severity === 'fixed'));
  const noSrc = trustCheck('83% ghost rate at Acme Staffing.', { evidence: EV, channel: '' });
  assert.match(noSrc.clean, /Source: seenjobs\.io · 6 applicant reports/);
  const mail = trustCheck('Hi there — see who answers.', { format: 'email' });
  assert.match(mail.clean, /Unsubscribe/); assert.ok(mail.flags.some((f) => f.id === 'email-legal' && f.severity === 'warn' && /postal/i.test(f.text)));
  const val = trustCheck('Set a day-14 cut-off. More at https://seenjobs.io/companies', { channel: 'reddit', link: false });
  assert.ok(val.flags.some((f) => f.id === 'link-policy')); assert.doesNotMatch(val.clean, /https?:/);
  assert.equal(CHECKS.length, r.checklist.length);
});

test('copy: three platform-native variants for every format, each well-formed with a "why" and a rule', () => {
  for (const f of FORMATS) {
    const vs = templateVariants(item(f));
    assert.equal(vs.length, 3, f); assert.deepEqual(vs.map((v) => v.style), STYLES);
    for (const v of vs) { assert.deepEqual(formatProblems(f, v), [], `${f}/${v.style}`); assert.ok(v.why && v.rule && v.ruleWhy, `${f} why`); }
  }
  const x = templateVariants(item('x-thread'))[0]; assert.ok(x.parts.posts.length >= 2 && x.parts.posts.every((p) => p.length <= LIMITS.xPost));
  const v = templateVariants(item('video-script'))[0]; assert.ok(v.parts.hook && v.parts.beats.length >= 3 && v.parts.cta);
  const r = templateVariants(item('reddit-post'))[0]; assert.ok(r.title.length <= LIMITS.redditTitle && r.body.length > 100);
  assert.deepEqual(formatProblems('x-thread', { parts: { posts: ['x'.repeat(281), 'ok'] } }), ['post 1 over 280 characters']);
  assert.deepEqual(formatProblems('video-script', { parts: { hook: 'h', beats: [] } }), ['missing beats', 'missing cta']);
});

test('copy: without evidence a draft carries no numbers at all', () => {
  for (const f of FORMATS) for (const v of templateVariants(item(f, { evidence: null }))) {
    const text = [v.title, v.body, ...Object.values(v.parts || {}).flat()].filter(Boolean).join(' ');
    assert.equal(trustCheck(text, {}).flags.filter((x) => x.id === 'numbers').length, 0, `${f}/${v.style}: ${text.slice(0, 120)}`);
  }
});

test('copy: drafts are trust-checked; a model rewrite that adds a number has it removed; no model → templates', async () => {
  const t = await draftItem(item('reddit-post'));
  assert.equal(t.engine, 'templates'); assert.ok(t.variants.every((v) => v.trust.ok), 'template drafts pass');
  const reasonFn = async () => ({ engine: 'stub-lane', text: JSON.stringify({ variants: templateVariants(item('linkedin-post')).map((v) => ({ style: v.style, body: `${v.body}\nAlready 50,000 people rely on Seen.` })) }) });
  const m = await draftItem(item('linkedin-post'), { reasonFn });
  assert.equal(m.engine, 'stub-lane');
  for (const v of m.variants) { assert.doesNotMatch(v.body, /50,000/); assert.ok(v.trust.flags.some((f) => f.id === 'numbers')); assert.equal(v.trust.ok, true); }
  const broken = await draftItem(item('email'), { reasonFn: async () => ({ engine: 'fallback', text: '' }) });
  assert.equal(broken.engine, 'templates');
  assert.ok(copyState().drafts['2026-10-27-linkedin-post']);
});

test('copy: approvals are remembered — the approved style leads next time, and a brain pointer is written', async () => {
  await draftItem(item('x-thread'));
  const facts = [];
  const r = await approveCopy('2026-10-27-x-thread', 2, { recordFact: async (f) => { facts.push(f); return { ok: true }; } });
  assert.equal(r.ok, true); assert.equal(r.style, 'question-first');
  assert.equal(learnedOrder('x-thread')[0], 'question-first'); assert.equal(learnedOrder('email')[0], 'data-first');
  assert.equal(facts[0].subject, 'growth:copy'); assert.equal(facts[0].predicate, 'approved-x-thread'); assert.match(facts[0].object, /question-first/);
  const next = await draftItem(item('x-thread', { id: 'other-x' }));
  assert.equal(next.variants[0].style, 'question-first');
  assert.equal((await approveCopy('missing', 0)).ok, false);
  assert.match((await approveCopy('2026-10-27-x-thread', 7)).error, /no variant/);
});

test('"why this works" fits the format and never claims a number the draft does not have', async () => {
  const { whyFor } = await import('./copy.mjs');
  assert.match(whyFor('reddit-comment', 'data-first', false)[1], /no link/);
  assert.match(whyFor('linkedin-post', 'data-first', true)[1], /real number/);
  assert.doesNotMatch(whyFor('linkedin-post', 'data-first', false)[1], /real number/);
  for (const f of FORMATS) for (const s of STYLES) { const [rid, why] = whyFor(f, s, false); assert.ok(rid && why, `${f}/${s}`); }
  const v = templateVariants(item('reddit-comment', { evidence: null }))[0]; assert.equal(v.rule, 'platform_rules');
});
