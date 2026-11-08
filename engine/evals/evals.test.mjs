// The coding pipeline, scored against its own recorded failures — in the gate, so a regression in ANY
// layer (or in the wiring between them) reds the suite. The cases themselves run in evals.shardN.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES } from './cases.mjs';

test('the suite contains controls that SHIP — a pipeline that rejects everything scores zero', () => {
  const controls = CASES.filter((c) => c.history === 'control');
  assert.ok(controls.length >= 3);
  assert.ok(controls.every((c) => c.expect.status.includes('shipped') && !c.pending));
});

test('every case belongs to exactly one shard, and every shard file exists', () => {
  const shards = readdirSync(dirname(fileURLToPath(import.meta.url))).filter((f) => /^evals\.shard\d+\.test\.mjs$/.test(f));
  assert.equal(shards.length, 4, 'run-shard.mjs splits by index % 4 — keep the shard files in step');
  assert.equal(new Set(CASES.map((c) => c.id)).size, CASES.length, 'case ids are unique');
});
