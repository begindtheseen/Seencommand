// Run: node --test lib/growth/brand.test.mjs — brand kit, positioning, rules, data callouts, assets, ads, meeting block.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setGrowthDir } from './store.mjs';
import { getBrand, saveBrand, brandHistory, liveProof, brandBrief, DEFAULT_BRAND } from './brand.mjs';
import { positioning, COMPETITORS } from './positioning.mjs';
import { RULES, rule, cite } from './rules.mjs';
import { calloutFrom, callouts, confidenceLabel, companySlug, leaderboard } from './data.mjs';
import { shareableAssets, storyAngles } from './assets.mjs';
import { adsPlan, targetCpa, utm, simulationRequest, readiness, creativeMatrix } from './ads.mjs';
import { growthMeetingBlock } from './meeting.mjs';
import { simulateNumbers } from '../simulate.mjs';
import { designMeta } from './design-meta.mjs';

beforeEach(() => setGrowthDir(mkdtempSync(join(tmpdir(), 'growth-brand-'))));
const ROW = (name, n, ghost) => ({ name, score: { first_party_report_count: n, ghost_rate: ghost, response_rate: 1 - ghost, overall_score: 50 } });
const fakeFetch = (rows) => async () => ({ ok: true, status: 200, json: async () => ({ ok: true, companies: rows }) });

test('brand kit: drafted default is v0; each save is a new version, history kept, pointer written; no-op is a no-op', async () => {
  const b = getBrand(); assert.equal(b.version, 0); assert.equal(b.kit.tagline, DEFAULT_BRAND.tagline);
  assert.ok(b.kit.segments.find((s) => s.id === 'agency-ghosted'), 'the beachhead segment leads');
  assert.ok(b.kit.wordsToAvoid.some((w) => /Stealth/.test(w.word)), 'owner decision: never "Stealth"');
  assert.ok(b.kit.proofPoints.every((p) => p.backedBy), 'every proof point names what backs it');
  const facts = [];
  const r = await saveBrand({ tagline: 'Know who answers before you apply.' }, { note: 'shorter', recordFact: async (f) => { facts.push(f); return { ok: true }; } });
  assert.equal(r.version, 1); assert.equal(getBrand().kit.tagline, 'Know who answers before you apply.'); assert.equal(getBrand().kit.promise, DEFAULT_BRAND.promise, 'merge, not replace');
  assert.equal(facts[0].subject, 'growth:brand'); assert.match(facts[0].object, /^v1 saved .* PT by Brandon — shorter/);
  assert.equal((await saveBrand({ tagline: 'Know who answers before you apply.' })).unchanged, true);
  await saveBrand({ visual: { colors: { green: '#00ff00' } } }); assert.equal(getBrand().version, 2); assert.equal(getBrand().kit.visual.colors.red, DEFAULT_BRAND.visual.colors.red);
  assert.equal(brandHistory().length, 2); assert.equal((await saveBrand({})).ok, false);
  assert.match(brandBrief(), /Never say:/);
});

test('live proof uses only real admin-stats numbers, and none at all when the data is degraded', () => {
  const s = { flywheel: { reportsTotal: 4200 }, jobs: { active: 72000 }, raw: { companies: { with_scores: 1100 } }, dataQuality: { degraded: false } };
  assert.deepEqual(liveProof(s).map((p) => p.id), ['scored', 'reports', 'jobs']);
  assert.deepEqual(liveProof({ ...s, dataQuality: { degraded: true } }), []); assert.deepEqual(liveProof(null), []);
  assert.deepEqual(liveProof({ flywheel: { reportsTotal: 0 }, jobs: {}, raw: {} }), []);
});

test('positioning: conservative competitor map, one category, every unverified claim marked', () => {
  const p = positioning();
  assert.equal(p.category.name, 'The public response record of employers');
  for (const id of ['glassdoor', 'indeed', 'blind', 'fishbowl', 'linkedin', 'trackers', 'recruitinghell']) assert.ok(COMPETITORS.find((c) => c.id === id), id);
  assert.ok(COMPETITORS.filter((c) => c.id !== 'recruitinghell').every((c) => c.verified === false && /as far as we know|mostly|not/.test(c.gap)));
  assert.ok(p.unverifiedNote && p.rule.source);
});

test('every playbook rule has a one-line rationale and a source; cite() is one line', () => {
  for (const [id, r] of Object.entries(RULES)) { assert.ok(r.name && r.rule && r.rationale && r.source, id); assert.doesNotMatch(cite(id), /\n/); }
  for (const id of ['beachhead', 'dont_scale', 'activation_first', 'weekly_retention', 'founder_content', 'kill_gates', 'compounding_seo', 'one_percent']) assert.ok(RULES[id], id);
  assert.throws(() => rule('vibes'));
});

test('callouts: only rows past the grade gate, labelled by the strategy confidence table, linked by Seen\'s slug', async () => {
  assert.equal(calloutFrom(ROW('acme', 4, 0.5)), null, 'below 5 reports there is no public number');
  const c = calloutFrom(ROW('insight global', 6, 0.5), { base: 'https://seenjobs.io', asOf: '2026-10-21' });
  assert.equal(c.name, 'Insight Global'); assert.equal(c.ghostPct, 50); assert.equal(c.confidence, 'Low confidence'); assert.equal(c.url, 'https://seenjobs.io/agencies');
  assert.match(c.sourceLine, /6 applicant reports, trust-weighted · low confidence · as of 2026-10-21 PT/);
  assert.equal(calloutFrom(ROW('acme corp', 26, 0.14), { base: 'https://seenjobs.io' }).url, 'https://seenjobs.io/company/acme-corp');
  assert.deepEqual([4, 5, 19, 20, 100, 1000].map(confidenceLabel), ['Not enough data', 'Low confidence', 'Low confidence', 'Moderate confidence', 'Good confidence', 'High confidence']);
  assert.equal(companySlug('Coca Cola'), 'coca-cola');
  const all = await callouts({ fetchImpl: fakeFetch([ROW('robert half', 20, 0.6), ROW('acme corp', 48, 0.13), ROW('tiny', 2, 0.9)]), force: true });
  assert.equal(all.agencies.length, 1); assert.equal(all.companies.length, 1); assert.equal(all.mostResponsive[0].name, 'Acme Corp');
  const down = await leaderboard({ fetchImpl: async () => { throw new Error('offline'); }, force: true });
  assert.equal(down.ok, true, 'a cached copy is served when Seen is unreachable'); assert.equal(down.stale, true);
  setGrowthDir(mkdtempSync(join(tmpdir(), 'growth-brand-empty-')));
  const none = await callouts({ fetchImpl: async () => { throw new Error('offline'); }, force: true });
  assert.equal(none.ok, false); assert.deepEqual(none.agencies, []);
});

test('promotable by design: assets ranked for creators; weekly angles carry evidence only when real data backs them', async () => {
  const a = shareableAssets('https://seenjobs.io');
  assert.equal(a[0].id, 'agency-index'); assert.ok(a.every((x) => x.creatorGets && x.audienceGets && x.url.startsWith('https://seenjobs.io/')));
  const bare = storyAngles(1, null);
  assert.equal(bare.length, 4); assert.ok(bare.every((x) => x.evidence === null)); assert.ok(bare.some((x) => x.needsData));
  assert.ok(bare.every((x) => !/\d+%/.test(x.hook)), 'no data, no numbers');
  const data = await callouts({ fetchImpl: fakeFetch([ROW('robert half', 20, 0.6), ROW('acme corp', 48, 0.13), ROW('globex', 29, 0.13)]), force: true });
  const w1 = storyAngles(1, data);
  const withEv = w1.filter((x) => x.evidence); assert.ok(withEv.length >= 1);
  for (const x of withEv) assert.match(x.hook, new RegExp(String(x.evidence.reports)));
  assert.notEqual(storyAngles(2, data)[0].angle, w1[0].angle, 'each week leads with a different angle');
});

test('ads: a plan only — readiness gates, CPA from real numbers, UTMs, and a simulation body simulate.mjs accepts', () => {
  assert.equal(targetCpa(null).value, null); assert.equal(targetCpa({ users: 100, paid: 0 }).value, null);
  assert.equal(targetCpa({ users: 100, paid: 2 }).value, Math.round(0.02 * 9.99 * 100) / 100);
  assert.equal(targetCpa({ users: 100, paid: 2, revenue: 29.98 }).value, Math.round(0.02 * 14.99 * 100) / 100, 'a measured average sale replaces the list price');
  const u = new URL(utm('https://seenjobs.io/agencies', { source: 'Reddit', medium: 'cpc', campaign: 'agency index', content: 'data-callout' }, '2026-10-21'));
  assert.equal(u.searchParams.get('utm_source'), 'reddit'); assert.equal(u.searchParams.get('utm_campaign'), '2026-10-agency-index');
  const ready = readiness({ items: [{ results: { impressions: 12000 } }], check: { actuals: { activation: 0.4 } } });
  assert.equal(ready.ready, true); assert.equal(readiness({ items: [] }).ready, false);
  const req = simulationRequest('t1', { actuals: { users: 120, paid: 1, degraded: false }, history: {} });
  assert.match(req.question, /\$50/); assert.ok(req.assumptions.some((x) => /ASSUMPTION/.test(x)));
  const sim = simulateNumbers(req.numbers, { runs: 200 }); assert.equal(sim.ok, true, sim.error);
  assert.equal(simulationRequest('t1', { actuals: null }).numbers, null);
  const tids = new Set(designMeta().templates.map((t) => t.id)); assert.ok(creativeMatrix().every((m) => tids.has(m.template)), 'the matrix uses real designer templates');
  const plan = adsPlan({}); assert.match(plan.note, /no spend/); assert.ok(plan.killScale.length >= 4 && plan.tranches[0].budget === 0);
});

test('meeting block: growth and strategy get it, others do not; it never throws', () => {
  const admin = { users: { total: 30, dau: 4 }, revenue: { month: 0, payingCustomers: 0, prepPurchases: 0, passPurchases: 0, interviews: 3 }, flywheel: { reportsTotal: 100, shares: 0 }, dataQuality: { degraded: false }, raw: { users: { new_this_week: 3 }, monetization: { active_paid: 0, mrr: 0 } } };
  const g = growthMeetingBlock('growth', { admin, today: '2026-10-21' });
  assert.match(g, /GROWTH STUDIO/); assert.match(g, /Week 1 of 26/); assert.match(g, /Actual: 30 users/); assert.match(g, /Today's 1% item/); assert.match(g, /rule:/); assert.match(g, /NAME the playbook rule/);
  const s = growthMeetingBlock('strategy', { admin: null, today: '2026-10-21' });
  assert.match(s, /unknown \(admin-stats not connected\)/); assert.doesNotMatch(s, /1% item/);
  assert.equal(growthMeetingBlock('product', { admin }), '');
  assert.doesNotThrow(() => growthMeetingBlock('growth', { admin: { raw: 'garbage' }, today: 'not-a-day' }));
});
