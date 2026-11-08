import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPETENCE, competenceFor, localChainFor } from './router.mjs';

test('coder work always routes to the code competence', () => {
  assert.equal(competenceFor({ deptId: 'growth', coder: true }), 'code');
  assert.equal(competenceFor({ deptId: 'command', coder: true }), 'code');
});

test('departments map to their lead competence', () => {
  assert.equal(competenceFor({ deptId: 'command' }), 'orchestrate');
  assert.equal(competenceFor({ deptId: 'strategy' }), 'reason');
  assert.equal(competenceFor({ deptId: 'product' }), 'code');
  assert.equal(competenceFor({ deptId: 'data' }), 'classify');
});

test('code competence prefers the lead coder, then the long-horizon coders', () => {
  assert.deepEqual(COMPETENCE.code.slice(0, 3), ['qwen3-coder-30b', 'kimi-k2-7-code', 'kimi-k2-6']);
});

test('nothing served → empty local chain (degrades to hosted lanes)', () => {
  assert.deepEqual(localChainFor('code', new Set()), []);
  assert.deepEqual(localChainFor('orchestrate', new Set()), []);
});

test('localChainFor returns served models best-first, skipping unserved ones', () => {
  // serve the lead coder + a long-horizon coder, but NOT kimi-k2-7
  const served = new Set(['qwen3-coder:30b', 'kimi-k2:6']);
  const chain = localChainFor('code', served).map((m) => m.id);
  assert.deepEqual(chain, ['qwen3-coder-30b', 'kimi-k2-6']); // order preserved, kimi-k2-7-code skipped
});

test('loose tag match tolerates quantization suffixes', () => {
  const served = new Set(['qwen3:32b-instruct-q4_K_M']);
  const chain = localChainFor('orchestrate', served).map((m) => m.id);
  assert.ok(chain.includes('qwen3-32b'));
});

test('the orchestrator competence leads with the CEO/main-brain model', () => {
  const served = new Set(['qwen3:32b', 'glm-4.5-air']);
  assert.equal(localChainFor('orchestrate', served)[0].id, 'qwen3-32b');
});
