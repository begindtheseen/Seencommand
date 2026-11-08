#!/usr/bin/env node
// SELF-UPDATE — Seen Command applies its own improvements to ITSELF. This is the missing loop Brandon
// called out: the builder ships self-improvement PRs, and this runner turns them into the running app:
//
//   1) MERGE   — every open, green `exec/build-*` PR on the TOOL repo (the self-improvements Brandon
//                already approved when he approved the build). Drafts are marked ready via `gh`.
//                A PR that went CONFLICTING because main moved after the build branched gets a
//                RESCUE (engine/pr-rescue.mjs): rebase onto origin/main in an isolated worktree,
//                full gate, force-push-with-lease. Real conflicts are left for a human, logged honestly.
//   2) GATE    — fetch origin/main and run the FULL test suite in an ISOLATED worktree cut from it,
//                never in the shared checkout. Red = abort, nothing is installed.
//   3) INSTALL — fast-forward the shared checkout to origin/main and let electron-builder rebuild
//                Seen Command.app into /Applications. This is the ONLY stage that touches the shared
//                checkout, so it is the only stage that may block on it — and only for a TRACKED
//                code modification, named by file. Untracked junk never blocks anything.
//   4) RESTART — quits the running app and reopens the fresh build.
//
// Why the isolation (gap #2 in NEXT_UPDATE.md — 11 real failures): the old flow ran dirtyCode() on
// the SHARED checkout up front and threw on ANY porcelain line, so two untracked orphan files
// (`?? intelligence/cli-gateway.mjs`) blocked every self-update for a WEEK while having nothing to do
// with any update. The builder was already converted (engine/build-worktree.mjs); this runner now
// uses the same helpers: merges are remote-side, the gate runs in a throwaway worktree off
// origin/main, and the shared checkout is consulted exactly once — at the install step, where the
// app really is packaged from it.
//
// Spawned DETACHED (like the build-runner) so it survives the app quitting itself. Progress is
// written to the builds store (data/builds/<id>.json) — visible at /api/builds. NO silent steps.
//
// Usage: node engine/self-update.mjs [--no-merge] [--no-restart]   ·   npm run self:update

import { execFileSync, spawn } from 'node:child_process';
import { nodeTestCommand } from './gate.mjs';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { config } from '../lib/config.mjs';
import { writeBuild, appendBuildLog, acquireBuildSlot, releaseBuildSlot } from '../lib/builds.mjs';
import { openPRsFor, executeMergePRIn, prFiles } from '../lib/connectors/github.mjs';
import { createBuildWorktree, deleteBuildBranch } from './build-worktree.mjs';
import { rescuePRBranch, looksConflicted } from './pr-rescue.mjs';
import { reconcileMergedTasks } from './reconcile.mjs';
import { flagConflictedPRs } from './pr-flags.mjs';
import { sweepCompletion } from './completion.mjs';
import { verifyProductPRs } from './pr-verify.mjs'; // was CALLED at the deployability sweep but never imported — the sweep silently skipped every run ("verifyProductPRs is not defined", the #46 phantom-call class predating the lint)
import { touchesProtected } from './policy.mjs';
import { logActivity } from '../lib/activity.mjs';
import { PT, ptDate } from '../lib/time-pt.mjs';

// The packaged app's PATH is launchd-bare; probe the usual homes for npm/gh.
const PATHS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
const bin = (name) => PATHS.map((p) => join(p, name)).find((f) => existsSync(f)) || name;
const envFor = () => {
  const e = { ...process.env, PATH: [...PATHS, process.env.PATH || ''].join(':') };
  delete e.ELECTRON_RUN_AS_NODE; // npm/electron-builder children must run as real node, not our shim
  return e;
};

// Paths the INSTALL step never blocks on: the vault, runtime/generated dirs, agent tooling, and
// root-level docs (HANDOFF.md, NEXT_UPDATE.md, …) — none of them are code the app is packaged from.
export const INSTALL_IGNORE = /^(memory|data|public|\.agents|\.codex|\.claude)\//;
const ROOT_DOC = /^[^/]+\.md$/i;

// Parse one `git status --porcelain` line into its path (rename lines report the NEW path).
function statusPath(line) { const p = line.slice(3).trim(); const arrow = p.indexOf(' -> '); return arrow >= 0 ? p.slice(arrow + 4) : p; }

// The ONLY dirt that may block an install: TRACKED code files with uncommitted modifications.
// Untracked lines (`??`) are dropped wholesale — `git checkout main` and `git pull --ff-only` never
// consume untracked files, and in the rare collision (a pulled commit adds the same path) git itself
// refuses with the filename, which we surface. This is the exact fix for the week-long
// `?? intelligence/cli-gateway.mjs` blocker: junk that is not tracked code cannot stop an update.
// Local main has commits GitHub's main does not (a hand commit, a local build, a squash-merged PR's
// original commits): `git pull --ff-only` refuses and the update used to STOP with "reconcile it by hand".
// Every change reaches Seen Command through a PR on GitHub, so GitHub's main is the truth. Nothing is
// thrown away: the local commits are saved on a dated backup branch first, then main moves to
// origin/main with `reset --keep` (it refuses, and we stop, if an uncommitted local edit would be lost).
// Returns { recovered:false } when main has not diverged (the pull failed for another reason).
export const GENERATED_FILES = ['public/command-center.html'];
// The dashboard page is GENERATED (scripts/build-dashboard.mjs) and rewritten by the running app, so it is
// almost always "modified" on the owner's Mac. Whenever GitHub also changed it, `git pull --ff-only` refuses
// ("Your local changes … would be overwritten") and `reset --keep` refuses ("not uptodate") — the update
// stopped on the owner's Mac twice on 2026-10-21 with main NOT diverged. The install rebuilds the page
// anyway, so the committed copy goes back before git moves anything. Real edits elsewhere still stop it.
export function restoreGeneratedFiles({ git, repoDir, log = () => {} }) {
  const restored = [];
  for (const f of GENERATED_FILES) {
    try { git(repoDir, 'diff', '--quiet', '--', f); }
    catch {
      try { git(repoDir, 'checkout', '--', f); restored.push(f); log(`${f} is generated — restored the committed copy (it is rebuilt during the install)`); }
      catch { /* not tracked here */ }
    }
  }
  return restored;
}

export function recoverDivergedMain({ git, repoDir, log = () => {}, now = new Date() }) {
  let ahead = [];
  try { ahead = git(repoDir, 'rev-list', '--oneline', 'refs/remotes/origin/main..refs/heads/main').split('\n').filter(Boolean); }
  catch { return { recovered: false }; }
  if (!ahead.length) return { recovered: false };
  const stamp = ptDate(now).replace(/-/g, '') + '-' + now.toLocaleTimeString('en-GB', { timeZone: PT, hour: '2-digit', minute: '2-digit' }).replace(':', '');
  let backup = `local-main-backup-${stamp}`;
  try { git(repoDir, 'rev-parse', '--verify', '--quiet', `refs/heads/${backup}`); backup += `-${Math.floor(now.getTime() / 1000) % 100000}`; } catch { /* name is free */ }
  git(repoDir, 'branch', backup, 'refs/heads/main');
  restoreGeneratedFiles({ git, repoDir, log });
  git(repoDir, 'reset', '--keep', 'refs/remotes/origin/main');
  log(`local main had ${ahead.length} commit${ahead.length === 1 ? '' : 's'} not on GitHub — saved as branch ${backup}, main now matches origin/main`);
  return { recovered: true, backup, commits: ahead.slice(0, 20) };
}

export function trackedCodeDirt(porcelainText) {
  return String(porcelainText || '')
    .split('\n').filter(Boolean)
    .filter((l) => !l.startsWith('??'))
    .map(statusPath)
    // A whitespace-only porcelain line parses to an empty path, which would otherwise sail through
    // both filters and block the install naming a file called "". An unparseable line is not dirt.
    .filter(Boolean)
    .filter((f) => !INSTALL_IGNORE.test(f))
    .filter((f) => !ROOT_DOC.test(f));
}

// One actionable sentence, naming the exact file and why it matters — never a wall of git status.
export function explainInstallBlock(files, repoDir) {
  if (!files || !files.length) return null;
  const rest = files.length > 1 ? ` (and ${files.length - 1} more: ${files.slice(1, 4).join(', ')})` : '';
  return `cannot install: ${files[0]} has uncommitted tracked changes in ${repoDir}${rest} — the app is packaged from this checkout, so commit or stash that file, then rerun the self-update`;
}

// Wrap a child-process failure so the RECORD carries one actionable sentence and the raw tail rides
// along as detail — the explainBuildFailure bar: a human reads the reason and knows what to do.
function stageFailure(sentence, cause) {
  const err = new Error(sentence);
  const tail = cause ? `${String(cause.stdout || '').slice(-1200)}\n${String(cause.stderr || cause.message || '')
    .slice(-600)}`.trim() : '';
  if (tail) err.detail = tail;
  return err;
}

function testFiles(root, dir = root, acc = []) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.git', '.claude', 'dist', 'data', 'public', '.DS_Store'].includes(name)) continue; // .claude holds session worktrees — their tree is not ours to gate
    const full = join(dir, name);
    if (statSync(full).isDirectory()) testFiles(root, full, acc);
    else if (name.endsWith('.test.mjs')) acc.push(relative(root, full));
  }
  return acc;
}

// Every external touchpoint is injectable with real defaults (the house pattern — lib/failure-loop.mjs,
// lib/platform-status.mjs) so the tests below run fully OFFLINE: no network, no real git, no model.
export async function selfUpdate({ id = `self-update-${Date.now().toString(36)}`, merge = true, restart = true } = {}, deps = {}) {
  const {
    repoDir = config.commandRepoDir(),
    toolRepo = config.commandRepo(),
    exec = execFileSync,            // every git/gh/npm/gate child goes through this one seam
    spawnFn = spawn,
    exists = existsSync,
    worktreeFn = createBuildWorktree,
    dropBranch = deleteBuildBranch,
    listTests = testFiles,
    rescue = rescuePRBranch,
    reconcile = reconcileMergedTasks,
    sweepConflicts = flagConflictedPRs,
    sweepDeploys = verifyProductPRs,
    sweepProof = sweepCompletion,
    protectedHits = touchesProtected,
    activity = logActivity,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = deps;
  const store = { writeBuild, appendBuildLog, acquireBuildSlot, releaseBuildSlot, ...(deps.store || {}) };
  const gh = { openPRs: openPRsFor, mergePR: executeMergePRIn, listPRFiles: prFiles, ...(deps.github || {}) };

  const sh = (cmd, args, cwd, timeout = 900000) =>
    String(exec(cmd, args, { cwd, encoding: 'utf8', stdio: 'pipe', timeout, env: envFor() }) ?? '').trim();
  const git = (cwd, ...args) => String(exec('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }) ?? '').trim();

  // After a rescue force-push GitHub recomputes mergeability asynchronously — give the merge a few beats.
  const mergeAfterRescue = async (repo, number, tries = 3, waitMs = 4000) => {
    for (let i = 1; ; i++) {
      try { return await gh.mergePR({ repo, number }); }
      catch (e) { if (i >= tries) throw e; await sleep(waitMs); }
    }
  };

  const log = (m) => { console.log(`[self-update] ${m}`); store.appendBuildLog(id, `[self-update] ${m}`); };
  store.writeBuild(id, { id, repo: 'tool', kind: 'self-update', title: 'Self-update: apply improvements + rebuild the app',
    task: 'merge green self-PRs → gate in isolated worktree → ff main → rebuild → restart', status: 'building', startedAt: new Date().toISOString(), log: [] });

  let wt = null; // the isolated gate worktree — cleaned up on every exit path
  try {
    if (!exists(join(repoDir, '.git'))) throw new Error(`${repoDir} is not a git checkout — point SEEN_COMMAND_REPO_DIR at a writable clone of the tool repo`);

    // ONE build at a time: a self-update that fires mid-build waits its turn instead of yanking the
    // build slot's shared resources (the object store, the /Applications install) out from under it.
    let waits = 0;
    await store.acquireBuildSlot(id, (h) => { if (waits++ % 6 === 0) log(`waiting for the build slot (held by ${h.id}) — a build is running`); });

    // NOTE what is deliberately ABSENT here: the old up-front dirtyCode() throw on the shared
    // checkout. Merges are remote-side and the gate runs in its own worktree, so the shared
    // checkout's state is none of this stage's business (gap #2 — 11 failures, one blocked a week).

    // 1) merge the green self-improvement PRs
    let merged = 0;
    if (merge) {
      const prs = (await gh.openPRs(toolRepo)).filter((p) => String(p.head || '').startsWith('exec/build-'));
      log(`${prs.length} open self-improvement PR(s)`);
      for (const p of prs) {
        try {
          // NEVER auto-merge a PR that touches Brandon's intent files or the safety layer — PR #56
          // rewrote the north-star focus text and self-merged minutes later, gate green. Those wait
          // for Brandon no matter how green they are.
          try {
            const hits = protectedHits(await gh.listPRFiles({ repo: toolRepo, number: p.number }));
            if (hits.length) { log(`PR #${p.number} touches PROTECTED intent files (${hits.join(', ')}) — never auto-merged; waiting for Brandon`); continue; }
          } catch (e) { log(`PR #${p.number} file list unreadable (${String(e.message).slice(0, 80)}) — not auto-merging`); continue; }
          if (p.draft) { try { sh(bin('gh'), ['pr', 'ready', String(p.number), '--repo', toolRepo], repoDir, 30000); log(`PR #${p.number} marked ready`); } catch (e) { log(`PR #${p.number} un-draft failed (${e.message.slice(0, 80)}) — skipping`); continue; } }
          await gh.mergePR({ repo: toolRepo, number: p.number });
          merged++; log(`merged PR #${p.number}: ${p.title}`);
        } catch (e) {
          if (!looksConflicted(e.message)) { log(`PR #${p.number} not merged (${String(e.message).slice(0, 100)}) — skipping`); continue; }
          // Main moved after this build branched, so GitHub reports CONFLICTING and a plain merge
          // loop would skip it forever. Rescue: rebase the branch onto origin/main in an ISOLATED
          // worktree (never the shared checkout), full gate, force-push-with-lease.
          log(`PR #${p.number} looks conflicted — attempting rebase rescue of ${p.head}`);
          const r = await rescue({ branch: p.head, repoDir, prRepo: toolRepo, log, ownSlot: false }) // we already hold the slot
            .catch((err) => ({ rescued: false, reason: err.message }));
          if (!r.rescued) { log(`PR #${p.number} conflicted — needs a human (${String(r.reason).slice(0, 160)})`); continue; }
          try {
            await mergeAfterRescue(toolRepo, p.number);
            merged++; log(`merged PR #${p.number} after rebase rescue: ${p.title}`);
          } catch (e2) { log(`PR #${p.number} rescued (rebased, gate green) but merge still refused (${String(e2.message).slice(0, 100)}) — leaving it for a human`); }
        }
      }
    }

    // 1b) a task whose PR has merged is DONE — close it so the Tasks tab reflects reality instantly.
    try {
      const rec = await reconcile({ log });
      if (rec.closed.length) log(`reconciled ${rec.closed.length} completed task(s): ${rec.closed.join(', ')}`);
    } catch (e) { log(`task reconcile skipped (${String(e.message).slice(0, 80)})`); }

    // 1c) conflict sweep: detect CONFLICTING PRs, auto-rescue tool ones, flag the rest on PR + task.
    try {
      const fl = await sweepConflicts({ log, ownSlot: false }); // we already hold the build slot
      if (fl.rescued.length || fl.flagged.length) log(`conflict sweep: ${fl.rescued.length} rescued, ${fl.flagged.length} flagged, ${fl.cleared.length} cleared`);
    } catch (e) { log(`conflict sweep skipped (${String(e.message).slice(0, 80)})`); }

    // 1d) deployability sweep: every open product PR gets its Vercel preview verdict stamped
    // (✅ deployable + preview link, or ⚠️ DO NOT MERGE) — the merge button is never faced blind.
    try {
      const vr = await sweepDeploys({ log });
      if (vr.verdicts.length) log(`deployability sweep: ${vr.verdicts.map((v) => `${v.key}=${v.state}`).join(', ')}`);
    } catch (e) { log(`deployability sweep skipped (${String(e.message).slice(0, 80)})`); }

    // 1e) PROOF sweep: every build still waiting on its completion conditions is re-observed — CI settled,
    // preview served, the LIVE database has what the code calls, the merged commit is what the app runs.
    // A PR that opened is not work that is done; this is where "awaiting" becomes "proven" or "failed".
    try {
      const pr = await sweepProof({ log });
      if (pr.checked) log(`proof sweep: ${pr.results.map((x) => `${x.id}=${x.state}`).join(', ')}`);
    } catch (e) { log(`proof sweep skipped (${String(e.message).slice(0, 80)})`); }

    // 2) GATE — fetch refs (touches nothing in any working tree), then cut an isolated worktree off
    // origin/main and run the full suite THERE. The shared checkout stays parked wherever it is.
    try { git(repoDir, 'fetch', 'origin', 'main'); }
    catch (e) { throw stageFailure(`could not fetch origin/main in ${repoDir} — check the network and git credentials, then rerun the self-update`, e); }
    let before = '(no local main)';
    try { before = git(repoDir, 'rev-parse', '--short', 'refs/heads/main'); } catch { /* a clone without a local main still updates fine */ }
    const after = git(repoDir, 'rev-parse', '--short', 'refs/remotes/origin/main');
    log(`main ${before} → ${after}${merged ? ` (+${merged} PR${merged === 1 ? '' : 's'} merged)` : ''}`);
    if (before === after && !merged) log('already up to date — rebuilding anyway so the app matches main');

    wt = worktreeFn(repoDir, { base: 'origin/main', branch: `self-update-gate-${id}`, execFn: exec }); // throws honestly if git refuses
    const tests = listTests(wt.dir);
    if (!tests.length) {
      // Silent-zero rule: this repo carries dozens of *.test.mjs, so an empty discovery means the
      // discovery broke — it must not report the same shape as a gate that ran and passed.
      throw new Error(`the gate found zero test files in the origin/main worktree — verify ${repoDir} is the Seen Command repo and origin/main is intact`);
    }
    log(`gate: ${tests.length} test files (isolated worktree — the shared checkout is untouched)`);
    // The ONE definition of how node:test is launched (engine/gate.mjs): a real node binary (process.execPath
    // is Electron under the packaged app), NODE_TEST_CONTEXT stripped, a hanging test killed and NAMED.
    const cmd = nodeTestCommand(tests);
    try { exec(cmd.bin, cmd.args, { cwd: wt.dir, encoding: 'utf8', stdio: 'pipe', timeout: 300000, env: cmd.env }); }
    catch (e) { throw stageFailure('the test gate is RED on origin/main — fix the failing tests on main before the app can be rebuilt (failure tail in detail)', e); }
    log('gate GREEN ✓');
    wt.cleanup(); dropBranch(repoDir, wt.branch, exec); wt = null;

    // 3) INSTALL — the one stage that genuinely needs the shared checkout, because the app is
    // packaged FROM it. Only a tracked code modification may block here (it would collide with the
    // checkout/pull below), and the failure names the file — never a wall of git status.
    const dirt = trackedCodeDirt(exec('git', ['status', '--porcelain'], { cwd: repoDir, encoding: 'utf8' }));
    if (dirt.length) throw new Error(explainInstallBlock(dirt, repoDir));
    restoreGeneratedFiles({ git, repoDir, log });
    try { git(repoDir, 'checkout', 'main'); }
    catch (e) { throw stageFailure(`could not switch ${repoDir} to main for the install — commit or stash the conflicting file git names (see detail), then rerun the self-update`, e); }
    try { sh('git', ['pull', '--ff-only', 'origin', 'main'], repoDir, 120000); }
    catch (e) {
      let rec = { recovered: false };
      try { rec = recoverDivergedMain({ git, repoDir, log }); }
      catch (e2) { throw stageFailure(`local main in ${repoDir} has diverged from origin/main and could not be moved safely (an uncommitted edit would be lost) — commit or stash it, then rerun the self-update`, e2); }
      if (!rec.recovered) throw stageFailure(`could not update local main in ${repoDir} (git pull --ff-only failed — see detail), then rerun the self-update`, e);
      activity({ kind: 'self-update', id, status: 'note', summary: `local main had ${rec.commits.length} commit(s) not on GitHub — kept on branch ${rec.backup}; main now matches GitHub`, detail: rec.commits.join('\n') });
    }

    // New or changed packages must be installed before the rebuild, or electron-builder packs the old
    // node_modules (or fails on a missing one). Only when package.json / the lockfile changed.
    let depsChanged = false;
    try { depsChanged = /(^|\n)package(-lock)?\.json(\n|$)/.test(git(repoDir, 'diff', '--name-only', `${before}`, 'HEAD')); } catch { depsChanged = true; } // unknown → install (cheap when nothing changed)
    if (depsChanged) {
      log('packages changed — npm install…');
      try { sh(bin('npm'), ['install', '--no-audit', '--no-fund'], repoDir, 600000); }
      catch (e) { throw stageFailure(`npm install failed in ${repoDir} — run it there to see npm's error (tail in detail)`, e); }
    }
    log('rebuilding Seen Command.app (electron-builder)…');
    try { sh(bin('npm'), ['run', 'app:install'], repoDir, 900000); }
    catch (e) { throw stageFailure(`the app rebuild failed — run "npm run app:install" in ${repoDir} to see electron-builder's error (tail in detail)`, e); }
    log('rebuilt + installed to /Applications');

    store.writeBuild(id, { status: 'updated', endedAt: new Date().toISOString(), summary: `main @ ${after}; ${merged} PRs merged; gate green in isolated worktree; app rebuilt` });
    activity({ kind: 'self-update', id, status: 'updated', summary: `self-update ok — ${merged} PR${merged === 1 ? '' : 's'} merged, main @ ${after}, gate green, app rebuilt` });
    store.releaseBuildSlot();

    // 4) restart the app so the new build is what's running
    if (restart) {
      log('restarting the app…');
      spawnFn('/bin/sh', ['-c', 'sleep 1; osascript -e \'tell application "Seen Command" to quit\' >/dev/null 2>&1; sleep 2; open -a "Seen Command"'],
        { detached: true, stdio: 'ignore', env: envFor() }).unref();
    }
    return { ok: true, merged, head: after };
  } catch (e) {
    if (wt) { // a failed gate must not leave a worktree (or its branch) behind
      try { wt.cleanup(); } catch { /* best effort */ }
      try { dropBranch(repoDir, wt.branch, exec); } catch { /* best effort */ }
    }
    store.releaseBuildSlot(); // no-op unless we hold it
    store.writeBuild(id, { status: 'failed', endedAt: new Date().toISOString(), error: e.message,
      ...(e.detail ? { detail: String(e.detail).slice(0, 2000) } : {}) });
    store.appendBuildLog(id, `[self-update] FAILED: ${e.message}`);
    activity({ kind: 'self-update', id, status: 'failed', summary: 'self-update FAILED — nothing installed',
      detail: e.detail ? `${e.message}\n${String(e.detail).slice(-600)}` : e.message });
    throw e;
  }
}

// CLI / detached-runner entry
import { fileURLToPath } from 'node:url';
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  selfUpdate({ merge: !args.includes('--no-merge'), restart: !args.includes('--no-restart') })
    .then((r) => { console.log(JSON.stringify(r)); process.exit(0); })
    .catch((e) => { console.error(`[self-update] ${e.message}`); process.exit(1); });
}
