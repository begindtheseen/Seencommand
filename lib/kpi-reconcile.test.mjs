// Command Center KPI tiles vs the brain (lib/kpi-reconcile.mjs).
//
// The bug: the tiles are baked into data/state.json by a board meeting, and with admin-stats
// unconfigured no meeting can run — so on 2026-08-12 the Command Center rendered a month-old "Total users"
// tile from a 2026-07-09 snapshot while the brain already held a newer `users_total` (open since
// 07-20). Nothing on screen said the number was a month old.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileKpis, snapshotAgeDays } from './kpi-reconcile.mjs';

const SNAP = '2026-07-09T03:35:01.782Z';
const TODAY = '2026-08-12';
const TILES = [
  { label: 'Total users', value: '500', delta: null },
  { label: 'MRR', value: '$250', delta: null },
  { label: 'Active jobs', value: '4,000', delta: '300 stale' },
  { label: 'Errors today', value: '0', delta: null },
];
const fact = (predicate, object, valid_from, valid_to = null) => ({ predicate, object, valid_from, valid_to });
const byLabel = (out, label) => out.find((k) => k.label === label);

test('a brain fact newer than the snapshot wins — the actual stale-tile bug', () => {
  const out = reconcileKpis(TILES, [fact('users_total', '540', '2026-07-20')], { snapshotISO: SNAP, today: TODAY });
  const t = byLabel(out, 'Total users');
  assert.equal(t.value, '540');
  assert.equal(t.source, 'brain');
  assert.match(t.delta, /brain · 2026-07-20/);
});

test('a brain fact OLDER than the snapshot does not win — the meeting saw fresher data', () => {
  const out = reconcileKpis(TILES, [fact('users_total', '300', '2026-07-01')], { snapshotISO: SNAP, today: TODAY });
  const t = byLabel(out, 'Total users');
  assert.equal(t.value, '500', 'the snapshot stands');
  assert.equal(t.source, 'snapshot-stale');
});

test('a CLOSED fact is ignored, so retired history cannot resurface as a live number', () => {
  const out = reconcileKpis(TILES, [fact('users_total', '999', '2026-08-01', '2026-08-02')], { snapshotISO: SNAP, today: TODAY });
  assert.equal(byLabel(out, 'Total users').value, '500');
});

test('the newest of several open facts for one predicate is the one used', () => {
  const out = reconcileKpis(TILES, [
    fact('users_total', '520', '2026-07-16'),
    fact('users_total', '540', '2026-07-20'),
  ], { snapshotISO: SNAP, today: TODAY });
  assert.equal(byLabel(out, 'Total users').value, '540');
});

test('a stale tile with no fresher fact is DATED, never shown as current', () => {
  const out = reconcileKpis(TILES, [], { snapshotISO: SNAP, today: TODAY });
  assert.match(byLabel(out, 'MRR').delta, /as of 2026-07-09/);
  assert.match(byLabel(out, 'Active jobs').delta, /300 stale · as of 2026-07-09/, 'the existing delta is kept');
});

test('a FRESH snapshot is left completely alone', () => {
  const out = reconcileKpis(TILES, [], { snapshotISO: '2026-08-12T01:00:00Z', today: TODAY });
  assert.deepEqual(out, TILES);
});

test('brain values adopt the tiles thousands formatting', () => {
  const out = reconcileKpis(TILES, [fact('active_jobs', '12345', '2026-08-05')], { snapshotISO: SNAP, today: TODAY });
  assert.equal(byLabel(out, 'Active jobs').value, '12,345');
});

test('money keeps a single $ whether or not the fact already carries one', () => {
  const a = reconcileKpis(TILES, [fact('mrr', '$1200', '2026-08-05')], { snapshotISO: SNAP, today: TODAY });
  const b = reconcileKpis(TILES, [fact('mrr', '1200', '2026-08-05')], { snapshotISO: SNAP, today: TODAY });
  assert.equal(byLabel(a, 'MRR').value, '$1,200');
  assert.equal(byLabel(b, 'MRR').value, '$1,200');
});

test('the new-today delta comes from the brain when it is non-zero', () => {
  const out = reconcileKpis(TILES, [
    fact('users_total', '540', '2026-07-20'), fact('users_new_today', '2', '2026-07-20'),
  ], { snapshotISO: SNAP, today: TODAY });
  assert.match(byLabel(out, 'Total users').delta, /\+2 today/);
});

test('an unmapped tile label is passed through untouched apart from dating', () => {
  const out = reconcileKpis([{ label: 'Something Else', value: '42', delta: null }], [fact('users_total', '540', '2026-07-20')],
    { snapshotISO: SNAP, today: TODAY });
  assert.equal(out[0].value, '42');
});

test('empty / missing input is safe', () => {
  assert.deepEqual(reconcileKpis([], []), []);
  assert.deepEqual(reconcileKpis(null, []), []);
  assert.deepEqual(reconcileKpis(TILES, null, { snapshotISO: '2026-08-12T00:00:00Z', today: TODAY }), TILES);
});

test('snapshotAgeDays measures the gap the dashboard reports', () => {
  assert.equal(snapshotAgeDays(SNAP, TODAY), 34);
  assert.equal(snapshotAgeDays(null, TODAY), null);
});
