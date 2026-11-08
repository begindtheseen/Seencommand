// CONFLICT FLAGGING — Brandon (2026-07-10): "it doesn't detect them and I want a simple flagging
// feature that fixes this." A PR that goes CONFLICTING used to sit silent until someone opened it
// on GitHub. This sweep walks every build record that has an OPEN PR and asks GitHub for its live
// mergeable state:
//
//   CONFLICTING + tool-repo exec/build-* branch  → the FIX: full rescue (rebase in an isolated
//                                                  worktree + full gate + force-push-with-lease).
//   CONFLICTING + product repo (or rescue failed) → the FLAG: one comment on the PR, one on its
//                                                  task, conflicted:true on the build record (the
//                                                  Tasks tab paints from these records). Flagged
//                                                  once per head sha — never comment spam.
//   MERGEABLE again                               → the record's flag is cleared.
//
// Runs on every self-update; standalone: node engine/pr-flags.mjs. Dependencies injectable for tests.

import { listBuilds, writeBuild } from '../lib/builds.mjs';
import { prInfo as ghPrInfo, executeCommentIssueIn } from '../lib/connectors/github.mjs';
import { prCoords } from './reconcile.mjs';
import { rescuePRBranch } from './pr-rescue.mjs';
import { config } from '../lib/config.mjs';

export async function flagConflictedPRs({ builds = null, prInfoFn = ghPrInfo, commentFn = executeCommentIssueIn, rescueFn = rescuePRBranch, log = () => {}, ownSlot = true } = {}) {
  const records = builds || listBuilds(); // newest-first — the newest record for a PR speaks for it
  const seen = new Set(); const flagged = []; const rescued = []; const cleared = [];
  for (const b of records) {
    const pr = prCoords(b);
    if (!pr) continue;
    const key = `${pr.repo}#${pr.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let info;
    try { info = await prInfoFn({ repo: pr.repo, number: pr.number }); }
    catch (e) { log(`flags: ${key} unreadable (${String(e.message).slice(0, 80)})`); continue; }
    if (info.state !== 'open') continue;      // merged/closed PRs are reconcile's business
    if (info.mergeable !== false) {           // MERGEABLE, or null = GitHub still computing
      if (b.conflicted) { writeBuild(b.id, { conflicted: false, conflictFlaggedSha: null }); cleared.push(key); log(`flags: ${key} is mergeable again — flag cleared`); }
      continue;
    }
    // CONFLICTING. Tool-repo builder branches get the full rescue — the fix, not just the flag.
    if (pr.repo === config.commandRepo() && String(info.head || '').startsWith('exec/build-')) {
      const r = await rescueFn({ branch: info.head, repoDir: config.commandRepoDir(), prRepo: pr.repo, base: config.commandBranch(), log, ownSlot })
        .catch((e) => ({ rescued: false, reason: e.message }));
      if (r.rescued) {
        writeBuild(b.id, { conflicted: false, conflictFlaggedSha: null });
        rescued.push(key); log(`flags: ${key} was conflicting — auto-rebased onto ${config.commandBranch()}, gate green`);
        continue;
      }
      log(`flags: ${key} rescue did not apply (${String(r.reason).slice(0, 100)}) — flagging for a human`);
    }
    if (b.conflictFlaggedSha === info.headSha) continue; // this exact head already flagged — no spam
    const why = pr.repo === config.commandRepo()
      ? 'Auto-rescue could not rebase it cleanly; a human needs to resolve.'
      : 'Product PRs are never auto-rebased (merging deploys prod) — rebase or resolve by hand.';
    try {
      await commentFn({ repo: pr.repo, number: pr.number, body: `⚠️ This PR is CONFLICTING with its base branch and cannot merge as-is. ${why} 🤖` });
      if (b.issue && b.issue.number && (b.issue.repo !== pr.repo || b.issue.number !== pr.number)) {
        await commentFn({ repo: b.issue.repo, number: b.issue.number, body: `⚠️ The PR for this task (${b.pr}) has CONFLICTS with its base branch and needs a human. 🤖` });
      }
    } catch (e) { log(`flags: comment failed for ${key} (${String(e.message).slice(0, 80)})`); }
    writeBuild(b.id, { conflicted: true, conflictFlaggedSha: info.headSha });
    flagged.push(key);
    log(`flags: ${key} CONFLICTING — flagged on the PR${b.issue ? ' and the task' : ''}`);
  }
  return { flagged, rescued, cleared };
}

// CLI: node engine/pr-flags.mjs — one manual sweep, honest output.
import { fileURLToPath } from 'node:url';
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  flagConflictedPRs({ log: (m) => console.log(`[pr-flags] ${m}`) })
    .then((r) => { console.log(JSON.stringify(r)); process.exit(0); })
    .catch((e) => { console.error(`[pr-flags] ${e.message}`); process.exit(1); });
}
