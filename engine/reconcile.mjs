// TASK RECONCILE — "when something has been completed and merged, Command knows instantly and the
// task disappears" (Brandon, 2026-07-10). A task is DONE the moment the PR built for it MERGES.
// Three layers make that true with no polling loop:
//   1) Every task-born PR carries a `Closes <task>` keyword (builder.mjs closesRef) — GitHub itself
//      closes the task at merge time, whoever merges.
//   2) An --auto-merge build closes its task immediately (build-runner).
//   3) THIS sweep catches everything else — PRs opened before the keyword existed, or merged while
//      the system was down: any build record whose PR is now merged → close the task, mark the
//      record. The Tasks tab reads live open issues, so a closed task vanishes on its next paint.
// It also reaps ZOMBIE builds (see the sweep below) — records stuck mid-flight whose runner is gone.
// Runs on every self-update; callable standalone. Dependencies are injectable for tests.

import { listBuilds, writeBuild, reconcileStaleBuilds } from '../lib/builds.mjs';
import { prInfo as ghPrInfo, executeCloseIssueIn } from '../lib/connectors/github.mjs';
import { logActivity } from '../lib/activity.mjs';

// One build record's PR coordinates — from the recorded URL, which is repo-explicit (product builds
// PR on the product repo while their task lives on the tool repo).
export function prCoords(build) {
  const m = String(build?.pr || '').match(/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/);
  return m ? { repo: m[1], number: Number(m[2]) } : null;
}

export async function reconcileMergedTasks({ builds = null, prInfo = ghPrInfo, closeIssue = executeCloseIssueIn, staleSweep = reconcileStaleBuilds, log = () => {} } = {}) {
  const records = builds || listBuilds(); // newest-first — the newest record for a task speaks for it

  // ZOMBIE SWEEP — the PR walk below structurally cannot see a build that died before opening a PR:
  // no `pr` means `if (!pr) continue` skips it forever, so the dashboard keeps painting "building…"
  // for a process that exited days ago. Reap those first (pid gone, or pid-less and long past any
  // plausible runtime); a record whose pid is still alive is left alone — a slow build is not a dead
  // one. Never fatal: a sweep problem must not stop the merge reconcile that is this function's job.
  const reaped = [];
  let swept = [];
  try { swept = staleSweep({ builds: records, log }) || []; }
  catch (e) { log(`reconcile: stale-build sweep failed (${String(e.message).slice(0, 80)})`); }
  for (const r of swept) {
    reaped.push(r.id);
    try {
      logActivity({ kind: 'build', id: r.id, status: 'failed', summary: `zombie build reaped — was '${r.from}' with no live process`, detail: r.reason });
    } catch { /* the ledger is best-effort; the record is already honest */ }
  }

  const seen = new Set(); const closed = []; const prClosed = []; const skipped = [];
  for (const b of records) {
    if (!b || !b.issue || !b.issue.number) continue;
    const key = `${b.issue.repo}#${b.issue.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (b.reconciled) continue;             // this task was already closed by an earlier sweep
    const pr = prCoords(b);
    if (!pr) continue;                       // no PR → nothing that can have merged
    let info;
    try { info = await prInfo({ repo: pr.repo, number: pr.number }); }
    catch (e) { skipped.push(key); log(`reconcile: ${key} — PR ${pr.repo}#${pr.number} unreadable (${String(e.message).slice(0, 80)})`); continue; }
    if (!info.merged) {
      // STALE-GREEN SWEEP (Seen #194: task #93's card kept showing "✅ PR ready" after its PR was
      // CLOSED without merging). A build record still in `pr_ready` whose PR is now closed-unmerged is
      // a lie on the dashboard — flip it to a neutral `pr_closed` terminal state so the card reads
      // honestly. The TASK stays OPEN (like preview_failed): the work still needs doing, so we never
      // close the issue here. Only records currently `pr_ready` are touched (failed/refused/preview_failed
      // are already honest terminal states).
      if (info.state === 'closed' && b.status === 'pr_ready') {
        try {
          writeBuild(b.id, { status: 'pr_closed', prClosedReason: 'PR closed without merging — see the PR thread' });
          prClosed.push(key);
          log(`reconcile: ${key} — PR ${pr.repo}#${pr.number} closed unmerged → record marked pr_closed (task stays open)`);
          logActivity({ kind: 'reconcile', id: key, status: 'pr_closed', summary: `${key} — PR ${pr.repo}#${pr.number} closed unmerged; card flipped to pr_closed, task stays open` });
        } catch (e) { skipped.push(key); log(`reconcile: could not mark ${key} pr_closed (${String(e.message).slice(0, 80)})`); }
      }
      continue;                              // open, or closed-unmerged (handled above) → the task is NOT done
    }
    try {
      await closeIssue({ repo: b.issue.repo, number: b.issue.number,
        comment: `✅ The work for this task shipped and MERGED: ${b.pr} — closing.` });
      writeBuild(b.id, { status: 'merged', merged: true, reconciled: true });
      closed.push(key);
      log(`reconcile: task ${key} closed — its PR merged`);
      logActivity({ kind: 'reconcile', id: key, status: 'task_closed', summary: `task ${key} closed — its PR merged (${b.pr})` });
    } catch (e) { skipped.push(key); log(`reconcile: could not close ${key} (${String(e.message).slice(0, 80)})`); }
  }
  return { closed, prClosed, reaped, skipped };
}

// CLI: node engine/reconcile.mjs — one manual sweep, honest output.
import { fileURLToPath } from 'node:url';
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  reconcileMergedTasks({ log: (m) => console.log(`[reconcile] ${m}`) })
    .then((r) => { console.log(JSON.stringify(r)); process.exit(0); })
    .catch((e) => { console.error(`[reconcile] ${e.message}`); process.exit(1); });
}
