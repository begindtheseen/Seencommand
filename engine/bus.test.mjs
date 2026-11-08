import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectHandoffs, inboxByDept, routingLines, deriveHandoffs } from './bus.mjs';

test('collectHandoffs pulls handoffs off proposals and tags the sender', () => {
  const proposals = [
    { dept: 'data', agentTitle: 'Diagnostician', handoffs: [{ toDept: 'growth', ask: 'raise Reddit' }, { toDept: 'reliability', ask: 'set POSTHOG' }] },
    { dept: 'strategy', agentTitle: 'Steering', handoffs: [] },
    { dept: 'product', agentTitle: 'Reviewer' }, // no handoffs field
  ];
  const routed = collectHandoffs(proposals);
  assert.equal(routed.length, 2);
  assert.equal(routed[0].fromDept, 'data');
  assert.equal(routed[0].toDept, 'growth');
});

test('inboxByDept groups by recipient', () => {
  const routed = [{ toDept: 'growth', ask: 'a' }, { toDept: 'growth', ask: 'b' }, { toDept: 'revenue', ask: 'c' }];
  const inbox = inboxByDept(routed);
  assert.equal(inbox.growth.length, 2);
  assert.equal(inbox.revenue.length, 1);
});

test('routingLines renders readable department titles', () => {
  const lines = routingLines([{ fromDept: 'data', toDept: 'growth', ask: 'raise Reddit' }]);
  assert.match(lines[0], /→/);
  assert.match(lines[0], /raise Reddit/);
});

test('deriveHandoffs fires cross-team asks from live signals', () => {
  const ctx = { admin_stats: { raw: { users: { new_today: 1 }, monetization: {} }, users: { newToday: 1 }, revenue: {}, jobs: {}, errors: {} } };
  const hs = deriveHandoffs('data', ctx);
  assert.ok(hs.some((h) => h.toDept === 'growth'), 'thin funnel routes to growth');
});
