import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickAutoQueue } from './overnight.mjs';

const issues = [
  { number: 1, title: 'Fix null crash in KPI parse', body: 'toNum() throws on undefined', labels: ['auto-build'], url: 'u1' },
  { number: 2, title: 'Redesign the whole dashboard', body: 'big', labels: ['discussion'], url: 'u2' },
  { number: 3, title: '[building] already in flight', body: '', labels: ['auto-build'], url: 'u3' },
  { number: 4, title: 'Tidy a comment', body: 'trivial', labels: ['auto-build', 'chore'], url: 'u4' },
  { number: 5, title: 'Another safe one', body: 'ok', labels: ['auto-build'], url: 'u5' },
];

test('only label-matched issues enter the queue', () => {
  const q = pickAutoQueue(issues, 'auto-build', 10);
  const nums = q.map((i) => i.number);
  assert.ok(nums.includes(1) && nums.includes(4) && nums.includes(5));
  assert.ok(!nums.includes(2), 'unlabeled issue excluded');
});

test('issues already marked [building] are skipped (no double-build)', () => {
  const q = pickAutoQueue(issues, 'auto-build', 10);
  assert.ok(!q.map((i) => i.number).includes(3));
});

test('the cap bounds the number of overnight builds', () => {
  const q = pickAutoQueue(issues, 'auto-build', 2);
  assert.equal(q.length, 2);
});

test('the build task combines title and body', () => {
  const q = pickAutoQueue(issues, 'auto-build', 10);
  const one = q.find((i) => i.number === 1);
  assert.match(one.task, /Fix null crash in KPI parse/);
  assert.match(one.task, /toNum\(\) throws/);
});

test('no labeled issues → empty queue (nothing fabricated)', () => {
  assert.deepEqual(pickAutoQueue(issues, 'nonexistent-label', 10), []);
});
