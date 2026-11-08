import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Redirect the writable home BEFORE importing anything that touches the builds store (the rescue
// takes the build-slot lock there) — keeps the real data/ dir untouched, like builds.test.mjs.
process.env.SEEN_HOME = mkdtempSync(join(tmpdir(), 'seen-rescue-home-'));
const { rescuePRBranch, looksConflicted } = await import('./pr-rescue.mjs');
const { buildsDir, buildSlotHolder, releaseBuildSlot } = await import('../lib/builds.mjs');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const lsRemote = (work, ref) => git(work, 'ls-remote', 'origin', `refs/heads/${ref}`).split(/\s+/)[0];
const worktreeCount = (work) => git(work, 'worktree', 'list', '--porcelain').split('\n\n').filter(Boolean).length;

// One local bare origin + one checkout, in the exact shape that wedges the real system: the builder
// branches exec/build-* off main, then main moves FIRST — the PR is now behind (and maybe conflicting).
function makeRepos({ branchEdit, mainEdit, branchName = 'exec/build-fix-thing-ab12' }) {
  const root = mkdtempSync(join(tmpdir(), 'seen-rescue-fx-'));
  const origin = join(root, 'origin.git');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'pipe' });
  const work = join(root, 'work');
  execFileSync('git', ['init', '-b', 'main', work], { stdio: 'pipe' });
  git(work, 'config', 'user.email', 'exec@seen.test');
  git(work, 'config', 'user.name', 'seen-test');
  git(work, 'config', 'commit.gpgsign', 'false');
  git(work, 'remote', 'add', 'origin', origin);
  writeFileSync(join(work, 'a.mjs'), 'export const A = 1;\nexport const B = 2;\n');
  writeFileSync(join(work, 'ok.test.mjs'),
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('ok', () => assert.ok(true));\n");
  git(work, 'add', '-A'); git(work, 'commit', '-m', 'seed'); git(work, 'push', '-u', 'origin', 'main');
  git(work, 'checkout', '-b', branchName);
  branchEdit(work);
  git(work, 'add', '-A'); git(work, 'commit', '-m', 'builder work'); git(work, 'push', 'origin', branchName);
  git(work, 'checkout', 'main');
  mainEdit(work);
  git(work, 'add', '-A'); git(work, 'commit', '-m', 'main moved first'); git(work, 'push', 'origin', 'main');
  git(work, 'fetch', 'origin'); // remote-tracking refs present, like the real checkout
  return { root, origin, work, branchName };
}

// Edits used across fixtures: the branch changes line B; main either adds a file (no conflict)
// or changes the SAME line (real conflict).
const branchEditsB = (work) => writeFileSync(join(work, 'a.mjs'), 'export const A = 1;\nexport const B = 20; // branch\n');
const mainAddsFile = (work) => writeFileSync(join(work, 'c.mjs'), 'export const C = 3;\n');
const mainEditsB = (work) => writeFileSync(join(work, 'a.mjs'), 'export const A = 1;\nexport const B = 200; // main\n');

test('a cleanly-rebasable branch is rescued: rebased onto moved main, gated, lease-pushed', async () => {
  const fx = makeRepos({ branchEdit: branchEditsB, mainEdit: mainAddsFile });
  const headBefore = git(fx.work, 'rev-parse', 'HEAD');

  const r = await rescuePRBranch({ branch: fx.branchName, repoDir: fx.work, pushTarget: 'origin', slot: { pollMs: 5 } });
  assert.equal(r.rescued, true);

  const tip = lsRemote(fx.work, fx.branchName);
  assert.equal(r.sha, tip);
  assert.equal(git(fx.work, 'rev-parse', `${tip}^`), lsRemote(fx.work, 'main')); // now ON TOP of moved main
  assert.match(git(fx.work, 'show', `${tip}:a.mjs`), /B = 20; \/\/ branch/);     // the branch's work survived
  assert.match(git(fx.work, 'show', `${tip}:c.mjs`), /C = 3/);                   // main's work is underneath

  // the main checkout was never touched, no worktree left behind, the slot is free again
  assert.equal(git(fx.work, 'rev-parse', 'HEAD'), headBefore);
  assert.equal(git(fx.work, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(git(fx.work, 'status', '--porcelain'), '');
  assert.equal(worktreeCount(fx.work), 1);
  assert.equal(buildSlotHolder(), null);
});

test('a real conflict is left alone and logged as needing a human', async () => {
  const fx = makeRepos({ branchEdit: branchEditsB, mainEdit: mainEditsB });
  const before = lsRemote(fx.work, fx.branchName);

  const r = await rescuePRBranch({ branch: fx.branchName, repoDir: fx.work, pushTarget: 'origin', slot: { pollMs: 5 } });
  assert.equal(r.rescued, false);
  assert.match(r.reason, /needs a human/);
  assert.equal(lsRemote(fx.work, fx.branchName), before); // branch untouched on origin
  assert.equal(worktreeCount(fx.work), 1);                // no half-rebased worktree left behind
  assert.equal(buildSlotHolder(), null);
});

test('a rebase that applies but turns the gate RED is not pushed', async () => {
  const fx = makeRepos({
    branchEdit: (work) => writeFileSync(join(work, 'fail.test.mjs'),
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('broken', () => assert.ok(false));\n"),
    mainEdit: mainAddsFile,
  });
  const before = lsRemote(fx.work, fx.branchName);

  const r = await rescuePRBranch({ branch: fx.branchName, repoDir: fx.work, pushTarget: 'origin', slot: { pollMs: 5 } });
  assert.equal(r.rescued, false);
  assert.match(r.reason, /gate is RED/);
  assert.equal(lsRemote(fx.work, fx.branchName), before);
  assert.equal(buildSlotHolder(), null);
});

test('only exec/build-* branches may be rewritten', async () => {
  const fx = makeRepos({ branchEdit: branchEditsB, mainEdit: mainAddsFile });
  for (const branch of ['main', 'feature/foo', 'exec/plumb-x', '']) {
    const r = await rescuePRBranch({ branch, repoDir: fx.work, pushTarget: 'origin', slot: { pollMs: 5 } });
    assert.equal(r.rescued, false);
    assert.match(r.reason, /refusing to rewrite/);
  }
});

test('a live build holding the slot makes the rescue give up honestly, not race', async () => {
  const fx = makeRepos({ branchEdit: branchEditsB, mainEdit: mainAddsFile });
  const before = lsRemote(fx.work, fx.branchName);
  writeFileSync(join(buildsDir(), '.runner.lock'), JSON.stringify({ pid: process.pid, id: 'live-build', at: 't0' }));

  const r = await rescuePRBranch({ branch: fx.branchName, repoDir: fx.work, pushTarget: 'origin', slot: { pollMs: 10, timeoutMs: 60 } });
  assert.equal(r.rescued, false);
  assert.match(r.reason, /gave up waiting for the build slot/);
  assert.equal(lsRemote(fx.work, fx.branchName), before);
  assert.equal(buildSlotHolder().id, 'live-build'); // the live build's lock was never yanked
  releaseBuildSlot();
});

test('force-with-lease refuses to clobber a branch that moved mid-rescue', async () => {
  const fx = makeRepos({ branchEdit: branchEditsB, mainEdit: mainAddsFile });
  const work2 = join(fx.root, 'work2');
  execFileSync('git', ['clone', fx.origin, work2], { stdio: 'pipe' });
  git(work2, 'config', 'user.email', 'other@seen.test');
  git(work2, 'config', 'user.name', 'other');
  git(work2, 'config', 'commit.gpgsign', 'false');

  // The gate hook plays the interloper: while the rescue is mid-flight (after its fetch), someone
  // pushes a new commit to the PR branch. The rescue's lease must lose and their work must survive.
  let sneaked = null;
  const gate = (dir) => {
    git(work2, 'fetch', 'origin', fx.branchName);
    git(work2, 'checkout', '-B', 'tmp', 'FETCH_HEAD');
    git(work2, 'commit', '--allow-empty', '-m', 'interloper');
    sneaked = git(work2, 'rev-parse', 'HEAD');
    git(work2, 'push', 'origin', `tmp:${fx.branchName}`);
    return { green: true, errors: [] };
  };

  const r = await rescuePRBranch({ branch: fx.branchName, repoDir: fx.work, pushTarget: 'origin', gate, slot: { pollMs: 5 } });
  assert.equal(r.rescued, false);
  assert.match(r.reason, /push refused/);
  assert.equal(lsRemote(fx.work, fx.branchName), sneaked); // the interloper's commit survived
  assert.equal(worktreeCount(fx.work), 1);
  assert.equal(buildSlotHolder(), null);
});

test("ownSlot:false runs under the CALLER's slot — no acquire wait, and the lock is left alone", async () => {
  const fx = makeRepos({ branchEdit: branchEditsB, mainEdit: mainAddsFile });
  // self-update holds the slot for its whole run; the rescue it invokes must not wait on that lock
  // (deadlock-by-self) and must not release it either.
  writeFileSync(join(buildsDir(), '.runner.lock'), JSON.stringify({ pid: process.pid, id: 'self-update-x', at: 't0' }));

  const r = await rescuePRBranch({ branch: fx.branchName, repoDir: fx.work, pushTarget: 'origin', ownSlot: false, slot: { pollMs: 10, timeoutMs: 60 } });
  assert.equal(r.rescued, true);                        // proceeded despite the held lock
  assert.equal(buildSlotHolder().id, 'self-update-x');  // and the caller's lock survived the rescue
  releaseBuildSlot();
});

test('looksConflicted separates CONFLICTING from other merge failures', () => {
  assert.ok(looksConflicted('GitHub PUT /repos/x/y/pulls/41/merge → 405: {"message":"Pull Request is not mergeable"}'));
  assert.ok(looksConflicted('GitHub PUT /repos/x/y/pulls/41/merge → 409: {"message":"Head branch was modified"}'));
  assert.ok(looksConflicted('merge conflict between base and head'));
  assert.ok(!looksConflicted('GitHub PUT /repos/x/y/pulls/41/merge → 404: {"message":"Not Found"}'));
  assert.ok(!looksConflicted('GitHub not configured (set GITHUB_TOKEN)'));
  assert.ok(!looksConflicted('fetch failed'));
  assert.ok(!looksConflicted(''));
});
