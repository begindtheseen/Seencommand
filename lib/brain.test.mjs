import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate the vault into a temp dir before importing brain.mjs (config reads CHRONOS_VAULT lazily).
const dir = mkdtempSync(join(tmpdir(), 'brain-'));
process.env.CHRONOS_VAULT = dir;
const brain = await import('./brain.mjs');

test('records a fact and reads it back', () => {
  const r = brain.recordFacts([{ subject: 'Seen', predicate: 'mrr', object: '$0', confidence: 'high' }]);
  assert.equal(r.written, 1);
  const cur = brain.currentFacts();
  assert.equal(cur.length, 1);
  assert.deepEqual({ s: cur[0].subject, p: cur[0].predicate, o: cur[0].object }, { s: 'Seen', p: 'mrr', o: '$0' });
});

test('unchanged fact is a no-op', () => {
  const r = brain.recordFacts([{ subject: 'Seen', predicate: 'mrr', object: '$0' }]);
  assert.equal(r.written, 0);
});

test('supersede: changed value closes the old window and appends a new active fact', () => {
  brain.recordFacts([{ subject: 'Seen', predicate: 'mrr', object: '$49' }]);
  const all = brain.readObservations().filter((f) => f.predicate === 'mrr');
  const active = all.filter((f) => f.valid_to == null);
  const closed = all.filter((f) => f.valid_to != null);
  assert.equal(active.length, 1, 'exactly one active mrr fact');
  assert.equal(active[0].object, '$49');
  assert.equal(closed.length, 1, 'old fact is superseded (valid_to closed)');
  assert.equal(closed[0].object, '$0');
});

test('cleanup', () => { rmSync(dir, { recursive: true, force: true }); });
