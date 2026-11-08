import test from 'node:test';
import assert from 'node:assert/strict';
import { workflowStateCounts } from './runtime-status.mjs';

const workflows = [
  { state: 'RECEIVED' },
  { state: 'CONTEXT_BUILDING' },
  { state: 'RECEIVED' },
  { state: 'PLANNING' },
];

const expectedCounts = {
  total: 4,
  RECEIVED: 2,
  CONTEXT_BUILDING: 1,
  PLANNING: 1,
};

test('workflowStateCounts returns correct counts', () => {
  const result = workflowStateCounts(workflows);
  assert.deepStrictEqual(result, expectedCounts);
});
