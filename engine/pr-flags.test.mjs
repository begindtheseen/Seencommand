import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SEEN_HOME = mkdtempSync(join(tmpdir(), 'seen-flags-'));
const { flagConflictedPRs } = await import('./pr-flags.mjs');
const { writeBuild, readBuild } = await import('../lib/builds.mjs');

const TOOL = 'begindtheseen/seen-command';   // config.commandRepo() default
const PRODUCT = 'begindtheseen/Seen';
const rec = (id, over = {}) => ({
  id, repo: 'product', status: 'pr_ready', updatedAt: 't1',
  pr: `https://github.com/${PRODUCT}/pull/186`, prNumber: 186,
  issue: { repo: TOOL, number: 30 },
  ...over,
});

test('a CONFLICTING product PR is flagged on the PR and the task, once per head sha', async () => {
  writeBuild('task-30', rec('task-30'));
  const comments = [];
  const deps = {
    prInfoFn: async () => ({ state: 'open', mergeable: false, head: 'exec/build-x', headSha: 'sha-1' }),
    commentFn: async (a) => comments.push(a),
    rescueFn: async () => { throw new Error('must not rescue product PRs'); },
  };
  const r1 = await flagConflictedPRs({ builds: [readBuild('task-30')], ...deps });
  assert.deepEqual(r1.flagged, [`${PRODUCT}#186`]);
  assert.equal(comments.length, 2);                      // PR + task
  assert.match(comments[0].body, /CONFLICTING/);
  assert.equal(comments[1].number, 30);
  assert.equal(readBuild('task-30').conflicted, true);
  // same head sha again → no new comments
  const r2 = await flagConflictedPRs({ builds: [readBuild('task-30')], ...deps });
  assert.deepEqual(r2.flagged, []);
  assert.equal(comments.length, 2);
});

test('a PR that becomes mergeable again gets its flag cleared', async () => {
  const r = await flagConflictedPRs({
    builds: [readBuild('task-30')],
    prInfoFn: async () => ({ state: 'open', mergeable: true, head: 'x', headSha: 'sha-2' }),
    commentFn: async () => { throw new Error('no comments needed'); },
    rescueFn: async () => { throw new Error('no rescue needed'); },
  });
  assert.deepEqual(r.cleared, [`${PRODUCT}#186`]);
  assert.equal(readBuild('task-30').conflicted, false);
});

test('a CONFLICTING tool builder PR gets the rescue, and success means no flag', async () => {
  writeBuild('task-90', rec('task-90', { repo: 'tool', pr: `https://github.com/${TOOL}/pull/90`, prNumber: 90, issue: { repo: TOOL, number: 90 } }));
  const rescues = []; const comments = [];
  const r = await flagConflictedPRs({
    builds: [readBuild('task-90')],
    prInfoFn: async () => ({ state: 'open', mergeable: false, head: 'exec/build-thing-abc', headSha: 's' }),
    commentFn: async (a) => comments.push(a),
    rescueFn: async (a) => { rescues.push(a); return { rescued: true, sha: 'new' }; },
  });
  assert.equal(rescues.length, 1);
  assert.equal(rescues[0].branch, 'exec/build-thing-abc');
  assert.equal(rescues[0].ownSlot, true); // standalone sweep takes its own slot
  assert.deepEqual(r.rescued, [`${TOOL}#90`]);
  assert.deepEqual(r.flagged, []);
  assert.equal(comments.length, 0);
});

test('a failed tool rescue falls back to the flag', async () => {
  const comments = [];
  const r = await flagConflictedPRs({
    builds: [readBuild('task-90')],
    prInfoFn: async () => ({ state: 'open', mergeable: false, head: 'exec/build-thing-abc', headSha: 's2' }),
    commentFn: async (a) => comments.push(a),
    rescueFn: async () => ({ rescued: false, reason: 'real conflicts' }),
  });
  assert.deepEqual(r.flagged, [`${TOOL}#90`]);
  assert.ok(comments.length >= 1);
  assert.match(comments[0].body, /human/);
});

test('closed/merged PRs and records without a PR are skipped', async () => {
  const r = await flagConflictedPRs({
    builds: [
      rec('x1', { pr: `https://github.com/${PRODUCT}/pull/50` }),
      rec('x2', { pr: null }),
    ],
    prInfoFn: async () => ({ state: 'closed', mergeable: false, headSha: 's' }),
    commentFn: async () => { throw new Error('no comments for closed PRs'); },
    rescueFn: async () => { throw new Error('no rescues for closed PRs'); },
  });
  assert.deepEqual(r.flagged, []);
  assert.deepEqual(r.rescued, []);
});
