import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SEEN_HOME = mkdtempSync(join(tmpdir(), 'seen-verify-'));
process.env.SEEN_COMMAND_REPO_DIR = process.env.SEEN_HOME; // keep verdict logActivity out of the real repo ledger
const { verifyProductPRs, verdictComment, verdictOutcome, derivePrStatus } = await import('./pr-verify.mjs');
const { writeBuild, readBuild } = await import('../lib/builds.mjs');

const PRODUCT = 'begindtheseen/seen';   // config.githubRepo() default
const TOOL = 'begindtheseen/seen-command';
const rec = (id, over = {}) => ({
  id, repo: 'product', status: 'pr_ready', updatedAt: 't1',
  pr: `https://github.com/${PRODUCT}/pull/188`, prNumber: 188,
  issue: { repo: TOOL, number: 33 },
  ...over,
});

test('a READY preview stamps a deployable verdict with the preview link', async () => {
  writeBuild('task-33v', rec('task-33v'));
  const comments = [];
  const r = await verifyProductPRs({
    builds: [readBuild('task-33v')],
    prInfoFn: async () => ({ state: 'open', head: 'exec/x', headSha: 'sha-1' }),
    deployFn: async () => ({ configured: true, state: 'READY', url: 'seen-git-exec-x.vercel.app' }),
    commentFn: async (a) => comments.push(a),
  });
  assert.deepEqual(r.verdicts, [{ key: `${PRODUCT}#188`, state: 'READY' }]);
  assert.match(comments[0].body, /Deployable/);
  assert.match(comments[0].body, /seen-git-exec-x\.vercel\.app/);
  const b = readBuild('task-33v');
  assert.equal(b.previewVerdictSha, 'sha-1');
  assert.equal(b.preview.state, 'READY');
});

test('the same head sha is never re-stamped; a NEW head is', async () => {
  const comments = [];
  const deps = {
    prInfoFn: async () => ({ state: 'open', head: 'exec/x', headSha: 'sha-1' }),
    deployFn: async () => ({ configured: true, state: 'READY', url: 'u' }),
    commentFn: async (a) => comments.push(a),
  };
  const r1 = await verifyProductPRs({ builds: [readBuild('task-33v')], ...deps });
  assert.deepEqual(r1.verdicts, []);
  assert.equal(comments.length, 0);
  const r2 = await verifyProductPRs({ builds: [readBuild('task-33v')],
    ...deps, prInfoFn: async () => ({ state: 'open', head: 'exec/x', headSha: 'sha-2' }) });
  assert.equal(r2.verdicts.length, 1);
  assert.equal(comments.length, 1);
});

test('a FAILED preview stamps DO NOT MERGE', async () => {
  writeBuild('task-99v', rec('task-99v', { pr: `https://github.com/${PRODUCT}/pull/199`, issue: { repo: TOOL, number: 99 } }));
  const comments = [];
  const r = await verifyProductPRs({
    builds: [readBuild('task-99v')],
    prInfoFn: async () => ({ state: 'open', head: 'exec/y', headSha: 's' }),
    deployFn: async () => ({ configured: true, state: 'ERROR' }),
    commentFn: async (a) => comments.push(a),
  });
  assert.deepEqual(r.verdicts, [{ key: `${PRODUCT}#199`, state: 'ERROR' }]);
  assert.match(comments[0].body, /DO NOT MERGE/);
  assert.match(comments[0].body, /broken build to production/);
});

// ---- withdraw authority: a settled-ERROR builder PR is CLOSED by the sweep, not merely commented -----
// The runner closes a broken product PR only inside its ~8-min in-process window; PRs whose window
// elapsed used to be left OPEN wearing a "DO NOT MERGE" comment the Tasks tab still reads as a happy
// "PR ready" (the #194/#243 false-green). verifyProductPRs now has the same withdraw authority — but
// tightly scoped: only builder branches (exec/build-*), only a hard SETTLED failure.
test('verifyProductPRs CLOSES a builder PR whose preview settled ERROR — not just a comment (the #243 false-green)', async () => {
  writeBuild('task-243v', rec('task-243v', { pr: `https://github.com/${PRODUCT}/pull/243`, issue: { repo: TOOL, number: 243 } }));
  const closed = []; const comments = [];
  const r = await verifyProductPRs({
    builds: [readBuild('task-243v')],
    prInfoFn: async () => ({ state: 'open', head: 'exec/build-admin-stats-abc', headSha: 'sha-e' }),
    deployFn: async () => ({ configured: true, state: 'ERROR', url: 'seen-git-exec-build.vercel.app' }),
    commentFn: async (a) => comments.push(a),
    closeFn: async (a) => closed.push(a),
  });
  assert.equal(closed.length, 1, 'the broken builder PR must be CLOSED');
  assert.equal(closed[0].number, 243);
  assert.match(closed[0].comment, /withdrawing|FAILED/i);
  assert.equal(comments.length, 0, 'a withdrawn PR is not also stamped with a keep-open comment');
  assert.deepEqual(r.verdicts, [{ key: `${PRODUCT}#243`, state: 'ERROR', closed: true }]);
  const b = readBuild('task-243v');
  assert.equal(b.status, 'preview_failed');
  assert.equal(b.previewVerdictSha, 'sha-e'); // stamped so a re-sweep never double-closes
});

test('verifyProductPRs does NOT close on a NON-terminal preview (BUILDING) — never withdraw an unsettled build', async () => {
  writeBuild('task-244v', rec('task-244v', { pr: `https://github.com/${PRODUCT}/pull/244` }));
  const closed = []; const comments = [];
  const r = await verifyProductPRs({
    builds: [readBuild('task-244v')],
    prInfoFn: async () => ({ state: 'open', head: 'exec/build-x-abc', headSha: 'sha-b' }),
    deployFn: async () => ({ configured: true, state: 'BUILDING' }),
    commentFn: async (a) => comments.push(a),
    closeFn: async (a) => closed.push(a),
  });
  assert.equal(closed.length, 0, 'an unsettled BUILDING preview must never close the PR');
  assert.equal(comments.length, 0, 'BUILDING says nothing yet');
  assert.deepEqual(r.verdicts, []);
});

test('verifyProductPRs does NOT close on CANCELED — a canceled build is not proof of breakage (keeps its DO-NOT-MERGE stamp)', async () => {
  writeBuild('task-245v', rec('task-245v', { pr: `https://github.com/${PRODUCT}/pull/245` }));
  const closed = []; const comments = [];
  await verifyProductPRs({
    builds: [readBuild('task-245v')],
    prInfoFn: async () => ({ state: 'open', head: 'exec/build-y-abc', headSha: 'sha-c' }),
    deployFn: async () => ({ configured: true, state: 'CANCELED' }),
    commentFn: async (a) => comments.push(a),
    closeFn: async (a) => closed.push(a),
  });
  assert.equal(closed.length, 0, 'CANCELED must never close');
  assert.equal(comments.length, 1, 'CANCELED still gets its DO-NOT-MERGE comment');
  assert.match(comments[0].body, /DO NOT MERGE/);
});

test('verifyProductPRs does NOT close a NON-builder branch even on ERROR — only PRs the builder opened (exec/build-*)', async () => {
  writeBuild('task-246v', rec('task-246v', { pr: `https://github.com/${PRODUCT}/pull/246` }));
  const closed = []; const comments = [];
  await verifyProductPRs({
    builds: [readBuild('task-246v')],
    prInfoFn: async () => ({ state: 'open', head: 'feature/hand-made', headSha: 'sha-d' }),
    deployFn: async () => ({ configured: true, state: 'ERROR' }),
    commentFn: async (a) => comments.push(a),
    closeFn: async (a) => closed.push(a),
  });
  assert.equal(closed.length, 0, 'a human/non-builder branch is never auto-withdrawn');
  assert.equal(comments.length, 1, 'it still gets the DO-NOT-MERGE stamp');
  assert.match(comments[0].body, /DO NOT MERGE/);
});

test('still-building or missing previews say nothing yet; tool-repo PRs are not swept', async () => {
  const comments = [];
  const building = await verifyProductPRs({
    builds: [rec('b1', { pr: `https://github.com/${PRODUCT}/pull/201` })],
    prInfoFn: async () => ({ state: 'open', head: 'h', headSha: 's' }),
    deployFn: async () => ({ configured: true, state: 'BUILDING' }),
    commentFn: async (a) => comments.push(a),
  });
  const none = await verifyProductPRs({
    builds: [rec('b2', { pr: `https://github.com/${PRODUCT}/pull/202` })],
    prInfoFn: async () => ({ state: 'open', head: 'h', headSha: 's' }),
    deployFn: async () => ({ configured: true, none: true }),
    commentFn: async (a) => comments.push(a),
  });
  const tool = await verifyProductPRs({
    builds: [rec('b3', { pr: `https://github.com/${TOOL}/pull/60` })],
    prInfoFn: async () => { throw new Error('tool PRs must not be swept'); },
    deployFn: async () => { throw new Error('tool PRs must not be swept'); },
    commentFn: async (a) => comments.push(a),
  });
  assert.deepEqual([building.verdicts, none.verdicts, tool.verdicts], [[], [], []]);
  assert.equal(comments.length, 0);
});

test('verdictComment covers both directions', () => {
  assert.match(verdictComment('READY', 'x.vercel.app'), /Eyeball the live preview/);
  assert.match(verdictComment('ERROR'), /DO NOT MERGE/);
  assert.match(verdictComment('CANCELED'), /canceled/);
});

test('verdictOutcome closes ONLY on a proven failure; every other state keeps the PR open', () => {
  // A hard failure is proof the change never built → the builder withdraws its own PR.
  assert.equal(verdictOutcome('ERROR'), 'close');
  assert.equal(verdictOutcome('FAILED'), 'close');
  // CANCELED is NOT proof of breakage; READY is deployable; the rest are in-flight/unknown — all keep.
  for (const keep of ['READY', 'CANCELED', 'BUILDING', 'QUEUED', null, undefined, 'WHATEVER']) {
    assert.equal(verdictOutcome(keep), 'keep', `state ${String(keep)} must KEEP the PR open`);
  }
});

test('derivePrStatus: a conflict is the strongest signal', () => {
  assert.equal(derivePrStatus({ mergeable: false, mergeable_state: 'dirty' }), 'conflicting');
  assert.equal(derivePrStatus({ mergeable_state: 'dirty' }), 'conflicting');           // dirty alone
  assert.equal(derivePrStatus({ mergeable: false, mergeable_state: 'clean' }), 'conflicting'); // mergeable:false dominates
  assert.equal(derivePrStatus({ mergeable: false }), 'conflicting');
});

test('derivePrStatus: unstable/blocked → checks_failing', () => {
  assert.equal(derivePrStatus({ mergeable_state: 'unstable' }), 'checks_failing');
  assert.equal(derivePrStatus({ mergeable_state: 'blocked' }), 'checks_failing');
});

test('derivePrStatus: a clean TOOL PR (no preview) is ready', () => {
  assert.equal(derivePrStatus({ mergeable: true, mergeable_state: 'clean' }), 'ready');
  assert.equal(derivePrStatus({ mergeable_state: 'clean' }), 'ready'); // previewState omitted = tool
});

test('derivePrStatus: a clean PRODUCT PR is ready ONLY when the preview is READY', () => {
  assert.equal(derivePrStatus({ mergeable_state: 'clean', previewState: 'READY' }), 'ready');
  // clean mergeability but the preview did not confirm deployable — NOT a green "ready to merge".
  assert.equal(derivePrStatus({ mergeable_state: 'clean', previewState: 'ERROR' }), 'not_ready_preview');
  assert.equal(derivePrStatus({ mergeable_state: 'clean', previewState: 'CANCELED' }), 'not_ready_preview');
  assert.equal(derivePrStatus({ mergeable_state: 'clean', previewState: 'PENDING' }), 'not_ready_preview');
});

test('derivePrStatus: an unsettled/other state is null — GitHub has not decided, so we do not guess', () => {
  for (const undecided of [
    { mergeable: null, mergeable_state: 'unknown' },
    { mergeable: null, mergeable_state: 'behind' },
    { mergeable_state: 'draft' },
    {},
  ]) {
    assert.equal(derivePrStatus(undecided), null, `${JSON.stringify(undecided)} must be null`);
  }
});
