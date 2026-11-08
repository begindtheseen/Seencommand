// Register one shard of the eval cases as node:test tests. The cases run serially WITHIN a process (the
// repo-dir seam is process-global), so the suite is split across test files — node runs those in parallel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CASES } from './cases.mjs';
import { scoreCase } from './harness.mjs';

const quiet = async (fn) => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };

export function registerShard(index, of) {
  CASES.forEach((c, i) => {
    if (i % of !== index) return;
    test(`eval ${c.id}${c.pending ? ` (pending: ${c.pending})` : ''} — ${c.history}`, async () => {
      const r = await quiet(() => scoreCase(c));
      if (c.pending) {
        // STRICT: a pending case is a named, measured gap. The day a layer closes it, this fails until the
        // flag is removed — so the scoreboard can never quietly claim more (or less) than the pipeline does.
        assert.equal(r.pass, false, `${c.id} now PASSES — remove its \`pending\` flag in engine/evals/cases.mjs`);
        return;
      }
      assert.deepEqual(r.problems, [], `${c.id}: ${r.problems.join(' · ')}`);
    });
  });
}
