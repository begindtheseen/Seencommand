import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerAggregationQuestion, aggregationContextFromRuns, AGGREGATION_QUESTION } from './agent-view.mjs';
import { answerOwned } from '../../engine/owned-brain.mjs';

const NOW = Date.parse('2026-10-20T12:00:00Z');
const runs = [
  { id: 'a', pipeline: 'indeed', status: 'completed', endedAt: '2026-10-19T06:00:00Z', metrics: { written: 120, uniqueListings: 130, rejected: 4, detailsFailed: 0 } },
  { id: 'b', pipeline: 'indeed', status: 'partial', endedAt: '2026-10-18T06:00:00Z', metrics: { written: 30, uniqueListings: 40, rejected: 1, detailsFailed: 6 }, reason: '6 details failed' },
  { id: 'c', pipeline: 'indeed', status: 'blocked', endedAt: '2026-10-17T06:00:00Z', metrics: { searchesFailed: 2, detailsFailed: null }, reason: 'Seen rejected the ingest token' },
  { id: 'd', pipeline: 'indeed', status: 'completed', endedAt: '2026-10-10T06:00:00Z', metrics: { written: 50, uniqueListings: 55, rejected: 0, detailsFailed: 1 } },
  { id: 'e', pipeline: 'company_intel', status: 'completed', endedAt: '2026-10-19T07:00:00Z', metrics: { dryRun: false, importedReports: 3, commentary: 10, duplicates: 2, rejected: 1, excerptsCollected: 16 } },
  { id: 'f', pipeline: 'company_intel', status: 'completed', endedAt: '2026-10-19T05:00:00Z', metrics: { dryRun: true, importedReports: null, commentary: null, excerptsCollected: 9 } },
];
const snap = {
  runs,
  pipelines: {
    company_intel: { id: 'company_intel', label: 'Company Intelligence', state: 'blocked', lastRun: { status: 'blocked', endedAt: '2026-10-20T01:00:00Z', reason: 'Chrome Browser Bridge disconnected: every company search failed', failureCategories: [{ label: 'Chrome Browser Bridge disconnected', count: 5 }] }, problems: [{ label: 'OpenCLI + Chrome Browser Bridge', detail: 'not connected', blocking: true }], actions: ['Open Chrome with the Browser Bridge connected'] },
    indeed: { id: 'indeed', label: 'Indeed Jobs', state: 'completed', lastRun: { status: 'completed', endedAt: '2026-10-19T06:00:00Z' }, problems: [], actions: [] },
  },
};

test('weekly Indeed imports are summed from real run metrics, with the written≠new caveat', () => {
  const r = answerAggregationQuestion('How many jobs did Indeed import this week?', snap, NOW);
  assert.match(r.reply, /\*\*150\*\* listing rows written or refreshed/);
  assert.match(r.reply, /3 runs/);
  assert.match(r.reply, /not a count of brand-new jobs/);
});

test('applicant reports exclude dry runs; unknown companies are said to be rejected, never created', () => {
  const r = answerAggregationQuestion('How many applicant reports did we collect?', snap, NOW);
  assert.match(r.reply, /\*\*3\*\* applicant reports imported/);
  assert.match(r.reply, /\*\*10\*\* commentary/);
  assert.match(r.reply, /1 dry run/);
  assert.match(r.reply, /never created/);
});

test('failing / why-stopped answers name the pipeline, the cause and the owner action', () => {
  for (const q of ['Which collection pipeline is failing?', 'Why did Company Intelligence stop importing?']) {
    const r = answerAggregationQuestion(q, snap, NOW);
    assert.match(r.reply, /Company Intelligence\*\* is \*\*blocked/);
    assert.match(r.reply, /Browser Bridge/);
    assert.match(r.reply, /What you need to do/);
  }
});

test('unreported metrics are said to be unreported, never invented', () => {
  assert.match(answerAggregationQuestion('Which Indeed searches are producing the most valid listings?', snap, NOW).reply, /Per-search yield is not reported/);
  assert.match(answerAggregationQuestion('Are there unresolved company identities?', snap, NOW).reply, /not reported by the collector/);
  const perf = answerAggregationQuestion('What changed in our collection performance?', snap, NOW).reply;
  assert.match(perf, /Indeed rows written:\*\* 150 vs 50/);
  const empty = answerAggregationQuestion('How many jobs did Indeed import this week?', { runs: [], pipelines: {} }, NOW);
  assert.match(empty.reply, /No Indeed runs finished/);
  assert.equal(answerAggregationQuestion('what is the weather', snap, NOW), null);
  assert.ok(AGGREGATION_QUESTION.test('how is the indeed ingestion doing'));
});

test('the Board Room routes these questions to the read-only aggregation skill', async () => {
  const out = await answerOwned({ message: 'Which collection pipeline is failing?', state: {}, deps: { aggregation: async () => snap } });
  assert.equal(out.handled, true);
  assert.equal(out.skill, 'aggregation');
  assert.equal(out.action, undefined, 'a read skill never returns an action');
  const down = await answerOwned({ message: 'How many jobs did Indeed import this week?', state: {}, deps: { aggregation: async () => { throw new Error('no manager'); } } });
  assert.equal(down.handled, false, 'an unavailable source falls through instead of inventing an answer');
  const ctx = aggregationContextFromRuns(runs, NOW);
  assert.match(ctx, /You can start searches and presets/);
  assert.equal(aggregationContextFromRuns([], NOW), '');
});
