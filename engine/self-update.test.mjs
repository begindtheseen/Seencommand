// Tests for the self-update runner (engine/self-update.mjs).
//
// The regression these exist for: self-update ran dirtyCode() on the SHARED checkout up front and
// threw on ANY porcelain line. Two untracked orphan files (`?? intelligence/cli-gateway.mjs`) blocked
// every self-update for a WEEK while having nothing to do with any update — 11 of the 50 recorded
// build failures, the largest single bucket in NEXT_UPDATE.md. The builder had long since moved to
// isolated worktrees; this runner had not.
//
// So the assertions that matter are: untracked junk can never block, only TRACKED code can, the block
// message names the offending file, and the shared checkout is not consulted before the gate at all.
// Everything is injected — no git, no gh, no npm, no network.

import test from 'node:test';
import assert from 'node:assert/strict';
import { trackedCodeDirt, explainInstallBlock, INSTALL_IGNORE, recoverDivergedMain } from './self-update.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// --- trackedCodeDirt: what may block an install ------------------------------------------------

test('untracked files NEVER block — the exact week-long blocker', () => {
  const porcelain = [
    '?? intelligence/cli-gateway.mjs',
    '?? intelligence/cli-gateway.test.mjs',
    '?? .agents/',
    '?? AGENTS.md',
  ].join('\n');
  assert.deepEqual(trackedCodeDirt(porcelain), [],
    'a checkout dirty only with untracked files is installable');
});

test('a tracked code modification DOES block, and is named', () => {
  const dirt = trackedCodeDirt(' M engine/builder.mjs\n M lib/ops.mjs');
  assert.deepEqual(dirt, ['engine/builder.mjs', 'lib/ops.mjs']);
});

test('runtime, vault and generated paths never block', () => {
  const porcelain = [
    ' M memory/knowledge/testing.md',
    ' M data/state.json',
    ' M public/command-center.html',
    ' M .claude/settings.json',
    ' M engine/run.mjs',
  ].join('\n');
  assert.deepEqual(trackedCodeDirt(porcelain), ['engine/run.mjs'],
    'only the real code file survives the filter');
  for (const p of ['memory/x.md', 'data/x.json', 'public/x.html', '.agents/x', '.codex/x', '.claude/x']) {
    assert.match(p, INSTALL_IGNORE, `${p} must be ignorable`);
  }
});

test('root-level docs never block — HANDOFF.md churns on every session', () => {
  assert.deepEqual(trackedCodeDirt(' M HANDOFF.md\n M NEXT_UPDATE.md\n M README.md'), []);
  // ...but a .md inside a code path is not a root doc and is left to the code filter.
  assert.deepEqual(trackedCodeDirt(' M engine/forge/notes.md'), ['engine/forge/notes.md']);
});

test('a rename reports the destination path, not the arrow line', () => {
  assert.deepEqual(trackedCodeDirt('R  engine/old.mjs -> engine/new.mjs'), ['engine/new.mjs']);
});

test('staged and mixed status codes are still tracked dirt', () => {
  assert.deepEqual(trackedCodeDirt('M  engine/a.mjs\nMM engine/b.mjs\nA  engine/c.mjs'),
    ['engine/a.mjs', 'engine/b.mjs', 'engine/c.mjs']);
});

test('empty or absent porcelain is clean, not an error', () => {
  for (const v of ['', '   ', null, undefined]) assert.deepEqual(trackedCodeDirt(v), []);
});

// --- explainInstallBlock: one actionable sentence ----------------------------------------------

test('a clean checkout produces no block message', () => {
  assert.equal(explainInstallBlock([], '/repo'), null);
  assert.equal(explainInstallBlock(null, '/repo'), null);
});

test('the block names the file, the repo, and what to do — not a wall of git status', () => {
  const msg = explainInstallBlock(['engine/builder.mjs'], '/Users/b/command-os');
  assert.match(msg, /engine\/builder\.mjs/, 'names the offending file');
  assert.match(msg, /\/Users\/b\/command-os/, 'names the checkout');
  assert.match(msg, /commit or stash/, 'says what to do');
  assert.match(msg, /packaged from this checkout/, 'says why it matters here specifically');
  assert.ok(msg.split('\n').length === 1, 'one sentence, not a status dump');
});

test('many blockers stay readable — first named, remainder counted', () => {
  const msg = explainInstallBlock(['a.mjs', 'b.mjs', 'c.mjs', 'd.mjs', 'e.mjs'], '/repo');
  assert.match(msg, /a\.mjs/);
  assert.match(msg, /and 4 more/);
  assert.ok(msg.length < 400, 'bounded, not every path');
});

// A real git repo: origin has a squash commit, local main has its own commit → --ff-only refuses.
function divergedRepo() {
  const root = mkdtempSync(join(tmpdir(), 'su-div-'));
  const g = (cwd, ...a) => String(execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })).trim();
  const origin = join(root, 'origin.git'); const seed = join(root, 'seed'); const local = join(root, 'local');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main', seed]);
  writeFileSync(join(seed, 'a.txt'), 'one\n'); g(seed, 'add', '.'); g(seed, 'commit', '-qm', 'base'); g(seed, 'remote', 'add', 'origin', origin); g(seed, 'push', '-q', 'origin', 'main');
  execFileSync('git', ['clone', '-q', origin, local]);
  writeFileSync(join(local, 'b.txt'), 'local only\n'); g(local, 'add', '.'); g(local, 'commit', '-qm', 'local commit');
  writeFileSync(join(seed, 'a.txt'), 'two\n'); g(seed, 'commit', '-qam', 'squash on GitHub'); g(seed, 'push', '-q', 'origin', 'main');
  g(local, 'fetch', '-q', 'origin', 'main');
  return { local, g };
}

test('diverged local main is saved on a backup branch and moved to origin/main — the update no longer stops', () => {
  const { local, g } = divergedRepo();
  const localHead = g(local, 'rev-parse', 'main');
  assert.throws(() => g(local, 'pull', '--ff-only', 'origin', 'main'), 'precondition: --ff-only refuses');
  const logs = [];
  const r = recoverDivergedMain({ git: g, repoDir: local, log: (m) => logs.push(m), now: new Date('2026-10-21T18:10:00Z') });
  assert.equal(r.recovered, true);
  assert.equal(r.backup, 'local-main-backup-20261021-1110', 'named in California time');
  assert.equal(g(local, 'rev-parse', r.backup), localHead, 'the local commit is kept, not lost');
  assert.equal(g(local, 'rev-parse', 'main'), g(local, 'rev-parse', 'origin/main'));
  assert.equal(readFileSync(join(local, 'a.txt'), 'utf8'), 'two\n');
  assert.match(logs[0], /1 commit not on GitHub — saved as branch local-main-backup-20261021-1110/);
});

test('not diverged → nothing moved (the pull failed for another reason and the update still stops honestly)', () => {
  const { local, g } = divergedRepo();
  g(local, 'reset', '-q', '--hard', 'origin/main');
  assert.deepEqual(recoverDivergedMain({ git: g, repoDir: local }), { recovered: false });
});

test('an uncommitted edit that the move would overwrite stops the recovery instead of losing it', () => {
  const { local, g } = divergedRepo();
  writeFileSync(join(local, 'a.txt'), 'my unsaved edit\n');
  assert.throws(() => recoverDivergedMain({ git: g, repoDir: local }));
  assert.equal(readFileSync(join(local, 'a.txt'), 'utf8'), 'my unsaved edit\n', 'the edit survives');
});

test('the generated dashboard page, rewritten by the running app, no longer blocks the move (owner Mac 2026-10-21)', () => {
  const { local, g } = divergedRepo();
  // the committed generated page, then the app rewrites it locally
  const { mkdirSync } = { mkdirSync: (p) => execFileSync('mkdir', ['-p', p]) };
  mkdirSync(join(local, 'public')); writeFileSync(join(local, 'public', 'command-center.html'), 'built\n');
  g(local, 'add', '.'); g(local, 'commit', '-qm', 'page');
  writeFileSync(join(local, 'public', 'command-center.html'), 'rebuilt by the app\n');
  assert.throws(() => g(local, 'reset', '--keep', 'origin/main'), 'precondition: reset --keep refuses on the generated page');
  const r = recoverDivergedMain({ git: g, repoDir: local });
  assert.equal(r.recovered, true);
  assert.equal(g(local, 'rev-parse', 'main'), g(local, 'rev-parse', 'origin/main'));
});

test('main NOT diverged, GitHub changed the generated page the app rewrote → the pull goes through (owner Mac 2026-10-21 19:55 + 20:20)', async () => {
  const { restoreGeneratedFiles } = await import('./self-update.mjs');
  const root = mkdtempSync(join(tmpdir(), 'su-gen-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const g = (cwd, ...a) => String(execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe', env })).trim();
  const origin = join(root, 'origin.git'); const seed = join(root, 'seed'); const local = join(root, 'local');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main', seed]);
  execFileSync('mkdir', ['-p', join(seed, 'public')]);
  writeFileSync(join(seed, 'public', 'command-center.html'), 'v1\n'); writeFileSync(join(seed, 'a.txt'), 'one\n');
  g(seed, 'add', '.'); g(seed, 'commit', '-qm', 'base'); g(seed, 'remote', 'add', 'origin', origin); g(seed, 'push', '-q', 'origin', 'main');
  execFileSync('git', ['clone', '-q', origin, local]);
  writeFileSync(join(local, 'public', 'command-center.html'), 'rebuilt by the running app\n');
  writeFileSync(join(seed, 'public', 'command-center.html'), 'v2\n'); g(seed, 'commit', '-qam', 'new page'); g(seed, 'push', '-q', 'origin', 'main');
  g(local, 'fetch', '-q', 'origin', 'main');
  assert.equal(g(local, 'rev-list', '--count', 'origin/main..main'), '0', 'precondition: main is NOT ahead');
  assert.throws(() => g(local, 'pull', '--ff-only', 'origin', 'main'), 'precondition: --ff-only refuses on the rewritten page');
  const logs = [];
  assert.deepEqual(restoreGeneratedFiles({ git: g, repoDir: local, log: (m) => logs.push(m) }), ['public/command-center.html']);
  g(local, 'pull', '-q', '--ff-only', 'origin', 'main');
  assert.equal(g(local, 'rev-parse', 'main'), g(local, 'rev-parse', 'origin/main'));
  assert.equal(readFileSync(join(local, 'public', 'command-center.html'), 'utf8'), 'v2\n');
  assert.match(logs[0], /generated — restored the committed copy/);
  // a clean page → nothing restored, nothing logged
  assert.deepEqual(restoreGeneratedFiles({ git: g, repoDir: local }), []);
});

test('restoring the generated page never touches a real edit elsewhere', async () => {
  const { restoreGeneratedFiles } = await import('./self-update.mjs');
  const { local, g } = divergedRepo();
  writeFileSync(join(local, 'a.txt'), 'my unsaved edit\n');
  assert.deepEqual(restoreGeneratedFiles({ git: g, repoDir: local }), []);
  assert.equal(readFileSync(join(local, 'a.txt'), 'utf8'), 'my unsaved edit\n');
});
