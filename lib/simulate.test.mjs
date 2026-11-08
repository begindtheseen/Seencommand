// Run: node --test lib/simulate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMajor, simulateNumbers, triangular, rng, tally, parsePass, simulateDecision, simulationBrief } from './simulate.mjs';

test('major decisions: high risk, money, pricing, publishing, outreach, data — not routine work', () => {
  assert.equal(isMajor({ risk: 'high', title: 'x' }), true);
  assert.equal(isMajor({ title: 'Raise the Pro price to $12', risk: 'medium' }), true);
  assert.equal(isMajor({ title: 'Publish the Ghost Report on r/recruitinghell' }), true);
  assert.equal(isMajor({ title: 'Apply the Supabase migration to prod' }), true);
  assert.equal(isMajor({ title: 'Refresh the welder search', risk: 'low' }), false);
});

test('numbers: seeded (same inputs, same answer), triangular stays in range, percentiles ordered', () => {
  const r = rng(7); for (let i = 0; i < 500; i++) { const x = triangular(r, { low: 1, likely: 2, high: 5 }); assert.ok(x >= 1 && x <= 5); }
  assert.throws(() => triangular(rng(1), { low: 3, likely: 2, high: 5 }), /low ≤ likely ≤ high/);
  const inp = { users: 800, weeks: 12, weeklyGrowth: { low: 0.02, likely: 0.08, high: 0.2 }, paidShare: { low: 0.01, likely: 0.03, high: 0.06 }, price: 9, monthlyCost: { low: 45, likely: 60, high: 90 } };
  const a = simulateNumbers(inp), b = simulateNumbers(inp);
  assert.deepEqual(a.summary, b.summary);
  for (const k of ['users', 'paid', 'mrr', 'net']) assert.ok(a.summary[k].p10 <= a.summary[k].p50 && a.summary[k].p50 <= a.summary[k].p90, k);
  assert.ok(a.summary.users.p50 > 800 * Math.pow(1.02, 12) && a.summary.users.p50 < 800 * Math.pow(1.2, 12));
  assert.ok(a.summary.chanceNetPositive >= 0 && a.summary.chanceNetPositive <= 1);
  assert.equal(simulateNumbers({ users: 1 }).ok, false);
});

test('verdicts: unanimous wins; a confident "don\'t" blocks unless the operator is confidently go; else modify', () => {
  const P = (verdict, confidence = 'medium') => ({ verdict, confidence });
  assert.equal(tally({ operator: P('go'), premortem: P('go'), market: P('go') }), 'go');
  assert.equal(tally({ operator: P('go'), premortem: P('dont', 'high'), market: P('go') }), 'dont');
  assert.equal(tally({ operator: P('go', 'high'), premortem: P('dont', 'high'), market: P('go') }), 'modify');
  assert.equal(tally({ operator: P('go'), premortem: P('modify'), market: null }), 'modify');
  assert.equal(tally({}), null);
  assert.equal(parsePass('{"verdict":"maybe"}'), null);
  assert.equal(parsePass('Sure: {"verdict":"go","expected_effect":"x","risks":["a"],"confidence":"high"}').verdict, 'go');
});

test('a full simulation: three blind passes in parallel, the chair sees all three; a down model concludes nothing', async () => {
  const seen = [];
  const reasonFn = async ({ system, prompt }) => {
    seen.push({ system, prompt });
    if (/chair/i.test(system)) return { text: 'MODIFY: post it, but lead with the method and the confidence label.' };
    const v = /pre-mortem/i.test(system) ? 'modify' : 'go';
    return { text: JSON.stringify({ verdict: v, expected_effect: 'More signups from r/recruitinghell.', risks: ['mod removal'], assumptions: [], watch: ['upvotes in 2h'], confidence: 'medium' }) };
  };
  const s = await simulateDecision({ question: 'Publish the Staffing Agency Ghost Index to r/recruitinghell', reasonFn, numbers: { users: 800, weeks: 8, weeklyGrowth: { low: 0, likely: 0.05, high: 0.15 }, paidShare: 0.02, price: 9, monthlyCost: 60 } });
  assert.equal(s.ok, true); assert.equal(s.verdict, 'modify'); assert.match(s.chair, /MODIFY/);
  const passes = seen.filter((x) => !/chair/i.test(x.system));
  assert.equal(passes.length, 3);
  for (const p of passes) assert.doesNotMatch(p.prompt, /OPERATOR:|PRE-MORTEM:/, 'blind: a pass never sees another');
  assert.match(seen.find((x) => /chair/i.test(x.system)).prompt, /OPERATOR:.*PRE-MORTEM:.*MARKET:/s);
  const brief = simulationBrief(s);
  assert.match(brief, /GO, WITH CHANGES/); assert.match(brief, /Numbers over 8 weeks \(projection\)/);
  const down = await simulateDecision({ question: 'x', reasonFn: async () => { throw new Error('no lane'); } });
  assert.equal(down.ok, false); assert.match(simulationBrief(down), /nothing was concluded/);
});

test('queue: one at a time, a repeat returns the existing result, majors are queued after a meeting', async () => {
  process.env.SEEN_HOME = mkdtempSync(join(tmpdir(), 'sim-'));
  const { createSimulations } = await import(`./simulations.mjs?x=${Date.now()}`);
  let active = 0, maxActive = 0; const posted = [];
  const state = { approvals: [{ id: 'run1-a1', status: 'pending', title: 'Raise Pro price to $12', summary: 'pricing', risk: 'medium' }, { id: 'run1-a2', status: 'pending', title: 'Refresh welder search', risk: 'low' }] };
  const sims = createSimulations({ loadState: () => state, post: async (r) => posted.push(r), reasonFn: async () => ({ text: '' }),
    simulate: async ({ question }) => { active++; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 30)); active--; return { ok: true, question, verdict: 'go', passes: {}, chair: 'go' }; } });
  assert.equal(sims.afterMeeting(), 1, 'only the pricing decision is major');
  sims.enqueue({ question: 'Spend $200 on Reddit ads' });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(maxActive, 1); assert.equal(posted.length, 2);
  assert.equal(sims.forApproval('run1-a1').status, 'done');
  assert.equal(sims.enqueue({ approvalId: 'run1-a1' }).existing, true);
  assert.equal(sims.enqueue({ approvalId: 'nope' }).ok, false);
});
