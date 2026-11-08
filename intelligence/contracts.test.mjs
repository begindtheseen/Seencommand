import test from 'node:test';
import assert from 'node:assert/strict';
import { assertModelRequest, normalizedModelResponse, validateJsonSchema } from './contracts.mjs';

const request = () => ({ taskType: 'plan', messages: [{ role: 'user', content: 'plan it' }], budget: { maxInputTokens: 100, maxOutputTokens: 20, timeoutMs: 1000, maxCostUsd: 0 }, privacy: 'LOCAL_ONLY', requiredCapabilities: ['plan'] });

test('model request contract rejects malformed inputs', () => {
  assert.doesNotThrow(() => assertModelRequest(request()));
  assert.throws(() => assertModelRequest({}), /taskType/);
});

test('structured output validation rejects wrong types and unknown fields', () => {
  const schema = { type: 'object', required: ['ok'], additionalProperties: false, properties: { ok: { type: 'boolean' } } };
  assert.deepEqual(validateJsonSchema({ ok: true }, schema), { valid: true, errors: [] });
  assert.equal(validateJsonSchema({ ok: 'yes', extra: 1 }, schema).valid, false);
});

test('normalized response always exposes the provider-neutral contract', () => {
  assert.deepEqual(Object.keys(normalizedModelResponse({ output: 'x' })).sort(), ['cacheHit', 'estimatedCostUsd', 'latencyMs', 'modelId', 'output', 'providerId', 'runtime', 'toolCalls', 'validation'].sort());
});
