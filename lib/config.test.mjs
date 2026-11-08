import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEnvValue } from './config.mjs';
import { parseWorktreeGitdir } from './paths.mjs';

test('env parser removes inline documentation comments without damaging hashes in values', () => {
  assert.equal(parseEnvValue('   # optional path'), '');
  assert.equal(parseEnvValue('cline   # provider'), 'cline');
  assert.equal(parseEnvValue('abc#token'), 'abc#token');
  assert.equal(parseEnvValue('"space # kept"'), 'space # kept');
  assert.equal(parseEnvValue("'space # kept'"), 'space # kept');
});

// .env is gitignored, so a worktree has none and every credential silently reads as "not configured":
// deploy-drift.mjs run from a worktree printed "not checkable (prod deploy unknown)" and exited 0 —
// indistinguishable from "production is fine". The primary checkout's .env is the fallback.
test('a worktree .git file resolves to the primary checkout, a real .git dir resolves to nothing', () => {
  assert.equal(
    parseWorktreeGitdir('gitdir: /Users/b/Downloads/command-os/.git/worktrees/setup-fixes-abc123\n'),
    '/Users/b/Downloads/command-os');
  assert.equal(parseWorktreeGitdir('gitdir: /Users/b/repo/.git/worktrees/deep/nested'), '/Users/b/repo');
  // A submodule .git file points straight at a gitdir with no /worktrees/ segment — not a worktree.
  assert.equal(parseWorktreeGitdir('gitdir: ../.git/modules/vendor'), null);
  assert.equal(parseWorktreeGitdir(''), null);       // unreadable / empty
  assert.equal(parseWorktreeGitdir(null), null);     // primary checkout: readFileSync threw on a dir
});
