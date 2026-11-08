// Isolated build worktrees — the permanent fix for "new tasks fail automatically" (2026-08-04, where
// every queued task died in ~1s on a precondition the build did not own). These tests use REAL throwaway
// git repos (local subprocesses only — no network, no model) because the whole point is git behavior.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBuildWorktree, deleteBuildBranch, isolatedBuilds } from './build-worktree.mjs';

// A repo with a committed base and an "origin" it can fetch from, so `origin/main` resolves.
function seedRepoWithOrigin() {
  const origin = mkdtempSync(join(tmpdir(), 'wt-origin-'));
  execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'pipe' });
  const dir = mkdtempSync(join(tmpdir(), 'wt-repo-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'pipe' });
  g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'code.mjs'), 'export const v = 1;\n');
  g('add', '-A'); g('commit', '-m', 'base');
  g('remote', 'add', 'origin', origin);
  g('push', '-u', 'origin', 'main');
  return { dir, origin, g };
}

test('a build worktree is cut off origin/<base> even when the checkout is FILTHY (the 2026-08-04 killer)', () => {
  const { dir, g } = seedRepoWithOrigin();
  // Reproduce BOTH real blockers: untracked agent tooling + a parked feature branch with local edits.
  mkdirSync(join(dir, '.agents'), { recursive: true });
  writeFileSync(join(dir, '.agents', 'skill.md'), 'tooling\n');
  writeFileSync(join(dir, 'AGENTS.md'), '# agents\n');
  g('checkout', '-b', 'feat/parked');
  writeFileSync(join(dir, 'code.mjs'), 'export const v = 999; // local work in progress\n');
  g('add', '-A'); g('commit', '-m', 'parked work');
  writeFileSync(join(dir, 'code.mjs'), 'export const v = 1000; // uncommitted too\n');

  const wt = createBuildWorktree(dir, { base: 'origin/main', branch: 'exec/build-x' });
  try {
    // The worktree holds BASE content — none of the parked branch's work, none of the dirt.
    assert.equal(readFileSync(join(wt.dir, 'code.mjs'), 'utf8'), 'export const v = 1;\n');
    assert.ok(!existsSync(join(wt.dir, '.agents')), 'agent tooling is not in the build tree');
    assert.ok(!existsSync(join(wt.dir, 'AGENTS.md')));
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: wt.dir, encoding: 'utf8' }).trim(), '', 'build tree is pristine');
    // The shared checkout is untouched: same branch, same uncommitted edit.
    assert.equal(execFileSync('git', ['branch', '--show-current'], { cwd: dir, encoding: 'utf8' }).trim(), 'feat/parked');
    assert.match(readFileSync(join(dir, 'code.mjs'), 'utf8'), /uncommitted too/);
  } finally { wt.cleanup(); deleteBuildBranch(dir, 'exec/build-x'); }
});

test('cleanup removes the worktree and is safe to call twice; the checkout survives', () => {
  const { dir } = seedRepoWithOrigin();
  const wt = createBuildWorktree(dir, { base: 'origin/main', branch: 'exec/build-clean' });
  assert.ok(existsSync(wt.dir));
  wt.cleanup();
  assert.ok(!existsSync(wt.dir), 'worktree dir removed');
  assert.doesNotThrow(() => wt.cleanup(), 'second cleanup is a no-op');
  assert.ok(existsSync(join(dir, 'code.mjs')), 'the shared checkout is intact');
  // git no longer lists it
  const list = execFileSync('git', ['worktree', 'list'], { cwd: dir, encoding: 'utf8' });
  assert.ok(!list.includes(wt.dir), 'worktree admin entry pruned');
  deleteBuildBranch(dir, 'exec/build-clean');
});

test('node_modules is symlinked (deps available to the gate) and locally excluded so the tree stays pristine', () => {
  const { dir } = seedRepoWithOrigin();
  mkdirSync(join(dir, 'node_modules', 'left-pad'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
  const wt = createBuildWorktree(dir, { base: 'origin/main', branch: 'exec/build-deps' });
  try {
    assert.ok(existsSync(join(wt.dir, 'node_modules', 'left-pad', 'index.js')), 'deps reachable from the build tree');
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: wt.dir, encoding: 'utf8' }).trim(), '', 'the link never shows as untracked dirt');
  } finally { wt.cleanup(); deleteBuildBranch(dir, 'exec/build-deps'); }
});

test('a commit in the worktree lands on the branch in the SHARED repo (so the push has something to push)', () => {
  const { dir } = seedRepoWithOrigin();
  const wt = createBuildWorktree(dir, { base: 'origin/main', branch: 'exec/build-commit' });
  try {
    writeFileSync(join(wt.dir, 'code.mjs'), 'export const v = 2;\n');
    const wg = (...a) => execFileSync('git', a, { cwd: wt.dir, encoding: 'utf8', stdio: 'pipe' });
    wg('config', 'user.email', 't@t'); wg('config', 'user.name', 't'); wg('config', 'commit.gpgsign', 'false');
    wg('add', '--', 'code.mjs'); wg('commit', '-m', 'build change');
    const sha = execFileSync('git', ['rev-parse', 'exec/build-commit'], { cwd: dir, encoding: 'utf8' }).trim();
    assert.match(sha, /^[0-9a-f]{40}$/, 'the shared repo resolves the build branch');
    const body = execFileSync('git', ['show', `${sha}:code.mjs`], { cwd: dir, encoding: 'utf8' });
    assert.equal(body, 'export const v = 2;\n', 'the commit content is visible from the shared repo');
  } finally { wt.cleanup(); deleteBuildBranch(dir, 'exec/build-commit'); }
});

test('an unresolvable base fails honestly (no silent fallback to whatever is checked out)', () => {
  const { dir } = seedRepoWithOrigin();
  assert.throws(
    () => createBuildWorktree(dir, { base: 'origin/does-not-exist', branch: 'exec/build-nope' }),
    /could not create an isolated build worktree/,
  );
});

test('isolatedBuilds is ON by default and only BUILD_ISOLATED=0 turns it off', (t) => {
  const prev = process.env.BUILD_ISOLATED;
  t.after(() => { if (prev === undefined) delete process.env.BUILD_ISOLATED; else process.env.BUILD_ISOLATED = prev; });
  delete process.env.BUILD_ISOLATED;
  assert.equal(isolatedBuilds(), true);
  process.env.BUILD_ISOLATED = '1';
  assert.equal(isolatedBuilds(), true);
  process.env.BUILD_ISOLATED = '0';
  assert.equal(isolatedBuilds(), false);
});
