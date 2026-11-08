import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recordAIUsage, usageReport } from './ai-usage.mjs';

test('AI usage ledger aggregates observed cost/tokens without credentials', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'seen-usage-')), 'usage.jsonl');
  recordAIUsage({ at: '2026-08-03T12:00:00Z', provider: 'cline', model: 'gpt-codex', surface: 'board-room', costUsd: .01, inputTokens: 10, outputTokens: 5 }, { path });
  recordAIUsage({ at: '2026-08-04T12:00:00Z', provider: 'cline', model: 'gpt-codex', surface: 'board-room', costUsd: .02 }, { path });
  const r = usageReport({ path, now: new Date('2026-08-04T15:00:00Z') });
  assert.equal(r.total.requests, 2); assert.equal(r.total.costUsd, .03); assert.equal(r.total.tokens, 15); assert.equal(r.models[0].requests, 2);
  assert.doesNotMatch(readFileSync(path, 'utf8'), /api[_-]?key|secret/i);
});
