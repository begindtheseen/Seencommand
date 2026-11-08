// PR RESCUE — un-wedge a CONFLICTING self-improvement PR without a human and without lying.
//
// The failure mode this closes: the builder branches `exec/build-*` off whatever main was when the
// build STARTED. If main moves before the PR merges (another PR landed first), GitHub marks the PR
// CONFLICTING and self-update's merge loop would skip it forever — nothing in the system could fix it.
//
// The rescue is deliberately conservative:
//   1) Only `exec/build-*` branches — the builder's own work. Human branches are never rewritten.
//   2) Take the ONE build slot (lib/builds.mjs) first — the builder branch-switches the main checkout,
//      so a rescue must never run concurrently with a live build.
//   3) Rebase in an ISOLATED `git worktree` under the OS tmpdir — the main checkout is never touched.
//   4) A rebase that stops on conflicts is aborted and the PR is left alone, logged honestly
//      ("needs a human"). Belt-and-braces: surviving conflict markers also fail the rescue.
//   5) The FULL test gate runs on the rebased tree — a red gate means no push, same as the builder.
//   6) Push is `--force-with-lease` against the exact sha we fetched — if anyone moved the branch
//      mid-rescue, the push is refused and their work survives.
//
// Used by engine/self-update.mjs; runnable standalone in tests with a local bare origin.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { config } from '../lib/config.mjs';
import { acquireBuildSlot, releaseBuildSlot } from '../lib/builds.mjs';
import { runNodeTests } from './gate.mjs';

const BUILDER_BRANCH = /^exec\/build-[\w.-]+$/; // the only branches the rescue may rewrite
const CONFLICT_MARKER = /^(<{7}|>{7})(\s|$)/m;  // what a half-resolved rebase leaves behind

// Children must run as real node, not the packaged app's shim; and the gate's nested `node --test`
// must not inherit an outer test-runner's context (NODE_TEST_CONTEXT makes failures exit 0).
const runEnv = () => { const e = { ...process.env }; delete e.ELECTRON_RUN_AS_NODE; delete e.NODE_TEST_CONTEXT; return e; };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', env: runEnv() }).trim();

// Does a failed GitHub merge look like the CONFLICTING case (vs auth/network/404)? GitHub answers
// 405 "Pull Request is not mergeable" for conflicts and 409 when the head moved under the merge.
export function looksConflicted(message) {
  const m = String(message || '');
  return /not mergeable|merge conflict|conflict/i.test(m) || /→ 40[59]\b/.test(m);
}

// The same full gate self-update runs: every .test.mjs in the tree (skipping runtime dirs and
// .claude session worktrees), executed IN the rebased worktree. Pure node — no npm install needed.
function testFiles(root, dir = root, acc = []) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.git', '.claude', 'dist', 'data', 'public', '.DS_Store'].includes(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) testFiles(root, full, acc);
    else if (name.endsWith('.test.mjs')) acc.push(relative(root, full));
  }
  return acc;
}
export function fullTestGate(dir) {
  const tests = testFiles(dir);
  if (!tests.length) return { green: true, errors: [] };
  // The ONE test runner (engine/gate.mjs): real node binary, NODE_TEST_CONTEXT stripped, hangs named.
  const r = runNodeTests(dir, tests, { timeoutMs: 300000 });
  return r.ok ? { green: true, errors: [] } : { green: false, errors: [`TESTS:\n${r.output}`] };
}

// Rebase a builder PR branch onto origin/<base> in an isolated worktree, gate it, and force-push
// with lease. Returns { rescued: true, sha, before } or { rescued: false, reason } — it never throws
// for an unrescuable branch, and it never leaves the repo mid-rebase or a worktree behind.
//   branch     — the PR head (must match exec/build-*)
//   repoDir    — the tool repo checkout (shared object store; its working tree is NOT touched)
//   prRepo     — owner/name, used to build the token push URL (ignored when pushTarget is given)
//   pushTarget — override for tests: a remote name/URL (default: token URL, else 'origin')
//   gate       — override for tests: (worktreeDir, changedFiles) → { green, errors } (may be async)
//   slot       — acquireBuildSlot options ({ pollMs, timeoutMs })
//   ownSlot    — false when the CALLER already holds the build slot (self-update does): the rescue
//                then neither acquires nor releases it — acquiring would wait on our own lock.
export async function rescuePRBranch({ branch, repoDir, prRepo, base = 'main', pushTarget, gate = fullTestGate, log = () => {}, slot = {}, ownSlot = true } = {}) {
  if (!branch || !BUILDER_BRANCH.test(branch)) return { rescued: false, reason: `refusing to rewrite non-builder branch "${branch}"` };
  if (!repoDir || !existsSync(join(repoDir, '.git'))) return { rescued: false, reason: `${repoDir} is not a git checkout` };

  // Never race a live build: the builder switches branches in this same checkout, so wait for the
  // one build slot. Timing out is an honest no — the PR is left alone for the next self-update.
  if (ownSlot) {
    try {
      await acquireBuildSlot(`rescue-${branch.replace(/[^\w.-]/g, '_')}`,
        (h) => log(`rescue of ${branch}: waiting for the build slot (held by ${h.id})`),
        { timeoutMs: 15 * 60 * 1000, ...slot });
    } catch (e) { return { rescued: false, reason: e.message }; }
  }

  let wtDir = null;
  try {
    git(repoDir, 'fetch', 'origin');
    let before, baseSha;
    try { before = git(repoDir, 'rev-parse', `refs/remotes/origin/${branch}`); } catch { return { rescued: false, reason: `origin/${branch} not found after fetch` }; }
    try { baseSha = git(repoDir, 'rev-parse', `refs/remotes/origin/${base}`); } catch { return { rescued: false, reason: `origin/${base} not found after fetch` }; }

    // The isolated stage: a detached worktree in the OS tmpdir sharing repoDir's objects/refs.
    wtDir = mkdtempSync(join(tmpdir(), 'seen-pr-rescue-'));
    git(repoDir, 'worktree', 'add', '--detach', wtDir, before);

    try { git(wtDir, 'rebase', baseSha); }
    catch {
      try { git(wtDir, 'rebase', '--abort'); } catch { /* nothing in progress */ }
      return { rescued: false, reason: `rebase onto origin/${base} hit real conflicts — needs a human` };
    }

    const changed = git(wtDir, 'diff', '--name-only', baseSha, 'HEAD').split('\n').filter(Boolean);
    if (!changed.length) return { rescued: false, reason: `origin/${base} already contains this branch's changes — nothing left to ship` };
    for (const f of changed) {
      const full = join(wtDir, f);
      if (existsSync(full) && CONFLICT_MARKER.test(readFileSync(full, 'utf8'))) {
        return { rescued: false, reason: `conflict markers survived in ${f} — needs a human` };
      }
    }

    const g = await gate(wtDir, changed);
    if (!g.green) return { rescued: false, reason: `rebase applied cleanly but the test gate is RED — needs a human:\n${(g.errors || [])[0] || ''}`.trim() };

    // Push with the token directly (same reason as the builder: no credential helper headless),
    // with-lease against the exact sha we fetched — a branch that moved mid-rescue wins.
    const token = config.githubToken();
    const target = pushTarget || (token && prRepo ? `https://x-access-token:${token}@github.com/${prRepo}.git` : 'origin');
    try { git(wtDir, 'push', `--force-with-lease=refs/heads/${branch}:${before}`, target, `HEAD:refs/heads/${branch}`); }
    catch (e) {
      const msg = token ? String(e.message).split(token).join('***') : String(e.message); // never leak the token
      return { rescued: false, reason: `push refused (${msg.slice(0, 200)}) — the branch moved under the rescue; leaving it alone` };
    }
    const sha = git(wtDir, 'rev-parse', 'HEAD');
    log(`rescued ${branch}: rebased onto origin/${base}, gate GREEN, force-pushed with lease (${before.slice(0, 7)} → ${sha.slice(0, 7)})`);
    return { rescued: true, sha, before };
  } finally {
    if (wtDir) {
      try { git(repoDir, 'worktree', 'remove', '--force', wtDir); }
      catch { try { rmSync(wtDir, { recursive: true, force: true }); git(repoDir, 'worktree', 'prune'); } catch { /* best effort */ } }
    }
    if (ownSlot) releaseBuildSlot();
  }
}
