// ISOLATED BUILD WORKTREE — the permanent fix for "new tasks fail automatically".
//
// Every build used to run INSIDE Brandon's shared checkout, so the checkout's state was a build
// precondition. That made unrelated human/agent activity silently fatal, and on 2026-08-04 it killed
// EVERY task in the queue within one second each:
//   • tool repo:    "working tree has uncommitted CODE changes … ?? .agents/ ?? .codex/ ?? AGENTS.md"
//                   (agent-tooling files another agent left lying around — not code, not the builder's)
//   • product repo: "can't cut a clean branch off origin/next-migration — the checkout has local
//                   changes that conflict" (it was parked on feat/chronos-cloud-bridge, 124 commits
//                   ahead, with vault edits) — the #243 guard doing its job, but permanently.
// Both are the same root cause: a build's fate depended on a working tree it does not own.
//
// A `git worktree` fixes it at the root. Each build gets its OWN checkout of `origin/<base>` in the
// OS tmpdir, sharing the repo's object store (cheap — no re-clone). The build branches, edits, gates,
// commits and pushes THERE, then the worktree is removed. Consequences:
//   • the shared checkout is never read for cleanliness, never switched, never touched at all — you
//     can be mid-edit on any branch and builds still run;
//   • a build can never pollute a PR with someone else's work (the #243 class becomes impossible by
//     construction, not by a guard that has to be right every time);
//   • a crashed build leaves a tmpdir, not a wrecked checkout (and `git worktree prune` reaps it).
//
// node_modules is SYMLINKED from the source checkout when present: the product gate runs `npm test`,
// `tsc` and the real `next build`, which need dependencies, and a fresh worktree has none. The tool
// repo is dependency-free, so the link is simply absent there.
//
// Pure Node + git. Every exec is injectable so tests never touch a real repo.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, symlinkSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Create an isolated worktree for `branch` based on `base` (e.g. 'origin/main'). Returns
// { dir, cleanup, branch } — cleanup() removes the worktree and prunes the admin entry, and is safe
// to call twice. Throws only when the worktree genuinely cannot be created (a real, honest failure).
export function createBuildWorktree(repoRoot, { base, branch, execFn = execFileSync, linkNodeModules = true } = {}) {
  if (!repoRoot) throw new Error('createBuildWorktree needs a repoRoot');
  if (!branch) throw new Error('createBuildWorktree needs a branch name');
  const git = (...args) => execFn('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' });
  const dir = mkdtempSync(join(tmpdir(), 'seen-build-'));

  // `git worktree add <dir> -b <branch> <base>` — a fresh checkout of base with the work branch
  // already created. No `git checkout` ever runs in the shared tree.
  try {
    if (base) git('worktree', 'add', dir, '-b', branch, base);
    else git('worktree', 'add', dir, '-b', branch); // offline last resort: base off current HEAD
  } catch (e) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    throw new Error(`could not create an isolated build worktree off ${base || 'HEAD'}: ${String(e.stderr || e.message).slice(0, 200)}`);
  }

  // Dependencies: symlink, never copy (a product node_modules is gigabytes). Absent → nothing to do.
  // The link is then excluded LOCALLY: a repo's `node_modules/` gitignore pattern (trailing slash)
  // does NOT match a symlink, so without this the worktree reports one untracked entry — harmless
  // today (staging is per-path) but exactly the kind of stray state that grows teeth later.
  if (linkNodeModules) {
    const src = join(repoRoot, 'node_modules');
    if (existsSync(src) && !existsSync(join(dir, 'node_modules'))) {
      try {
        symlinkSync(src, join(dir, 'node_modules'), 'dir');
        // `git rev-parse --git-path info/exclude` resolves the WORKTREE's own exclude file.
        const rel = execFn('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: dir, encoding: 'utf8' }).trim();
        const excl = rel.startsWith('/') ? rel : join(dir, rel);
        appendFileSync(excl, '\n# isolated build worktree: the linked dependency tree is not repo content\nnode_modules\n');
      } catch { /* gate will report honestly if deps are truly needed */ }
    }
  }

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    // Remove the worktree via git (drops its admin entry), then make sure the dir is gone. Both are
    // best-effort: a leftover tmpdir must never turn a green build red.
    try { git('worktree', 'remove', '--force', dir); } catch { /* fall through to rm */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { git('worktree', 'prune'); } catch { /* ignore */ }
    // The branch lives on in the shared repo's refs (that is what gets pushed); a failed build's
    // branch is deleted by the caller, exactly as before.
  };

  return { dir, cleanup, branch };
}

// Delete a build branch from the shared repo (used when a build aborts). Never throws.
export function deleteBuildBranch(repoRoot, branch, execFn = execFileSync) {
  if (!branch) return false;
  try { execFn('git', ['branch', '-D', branch], { cwd: repoRoot, stdio: 'ignore' }); return true; }
  catch { return false; }
}

// Whether isolated builds are enabled. ON by default — BUILD_ISOLATED=0 restores the legacy
// in-checkout behavior (kept as an escape hatch, not as the normal path).
export const isolatedBuilds = () => process.env.BUILD_ISOLATED !== '0';
