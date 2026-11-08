// DEPLOYABILITY VERDICTS — Brandon (2026-07-10): "make sure it doesn't push out broken code and
// make sure nothing it's pushed out is broken." Merging a product PR deploys production, and the
// only trustworthy build oracle is Vercel itself — it already builds a PREVIEW for every branch
// with the same builder production uses. This sweep stamps that verdict on every open product PR
// so the merge button is never faced blind:
//
//   preview READY          → "✅ Deployable — eyeball the live preview: <url>" (see it BEFORE prod)
//   preview ERROR/CANCELED → "⚠️ DO NOT MERGE — this would push a broken build to production"
//   still building / none  → say nothing yet; re-checked on the next sweep
//
// One comment per head sha (no spam; a new push re-verifies). Runs on every self-update;
// standalone: node engine/pr-verify.mjs. Dependencies injectable for tests.

import { listBuilds, writeBuild } from '../lib/builds.mjs';
import { prInfo as ghPrInfo, executeCommentIssueIn, executeClosePRIn } from '../lib/connectors/github.mjs';
import { deploymentForRef as vcDeploymentForRef } from '../lib/connectors/vercel.mjs';
import { prCoords } from './reconcile.mjs';
import { config } from '../lib/config.mjs';
import { logActivity } from '../lib/activity.mjs';

export function verdictComment(state, url) {
  if (state === 'READY') return `✅ Deployable: Vercel built this branch clean with the same builder production uses. Eyeball the live preview before merging: https://${url} 🤖`;
  return `⚠️ DO NOT MERGE: the Vercel preview build for this branch ${state === 'ERROR' ? 'FAILED' : 'was canceled'} — merging would push a broken build to production. Fix or close this PR. 🤖`;
}

// The BUILDER'S own-PR outcome for a SETTLED preview verdict: only a hard ERROR/FAILED is proof the
// change never built, so the builder withdraws (closes) the PR it just opened. Every other state
// KEEPS the PR open — READY (deployable, gets its stamp), CANCELED (a canceled build is NOT proof of
// breakage — keeps its DO-NOT-MERGE stamp), and any in-flight/unknown state (BUILDING/QUEUED/null/
// timeout). Deliberately conservative: never close on anything but a proven failure.
export function verdictOutcome(state) {
  return (state === 'ERROR' || state === 'FAILED') ? 'close' : 'keep';
}

// POST-CREATE PR STATUS — the compact verdict on a PR the builder JUST opened, folded from GitHub's
// OWN mergeability signals (GET /pulls/{n}: `mergeable` bool|null + `mergeable_state`) and, for a
// PRODUCT PR, the Vercel preview verdict. Brandon's directive: "after creating a PR, Seen Command must
// check the PR's status to know if it conflicts … and if the PR doesn't reflect READY, report it into
// the activity ledger." This is DETECTION + NAMING only — it never merges or closes (the conflict
// rescue at self-update and the reconcile sweep keep those jobs); it just says what GitHub already knows.
//
//   mergeable === false  OR  mergeable_state 'dirty'   → 'conflicting'    (won't merge — conflicts with base)
//   mergeable_state 'unstable' | 'blocked'             → 'checks_failing' (a CI run is red or a required gate is unmet)
//   mergeable_state 'clean'                            → 'ready'          (TOOL: the local test gate is the oracle)
//                                                        …for a PRODUCT PR, ALSO require the preview READY:
//                                                        clean-but-preview-not-READY is 'not_ready_preview'
//                                                        (a hard preview ERROR is the withdraw path handled
//                                                        in the runner, so it never reaches here as 'ready').
//   anything else / never settled                     → null            (GitHub still computing, or 'behind'/
//                                                        'unknown'/draft — we log it, we don't guess).
//
// `previewState` is the fold seam for the product path: OMIT it (undefined/null) for a TOOL PR, which has
// no preview — its gate ran locally before the PR opened. Pass ANY string for a PRODUCT PR (the settled
// Vercel state, or a placeholder like 'PENDING' when it never settled): a product PR is only 'ready' when
// GitHub says 'clean' AND that string is exactly 'READY'.
export function derivePrStatus({ mergeable, mergeable_state, previewState } = {}) {
  if (mergeable === false || mergeable_state === 'dirty') return 'conflicting';
  if (mergeable_state === 'unstable' || mergeable_state === 'blocked') return 'checks_failing';
  if (mergeable_state === 'clean') {
    if (previewState == null) return 'ready';                            // tool PR — nothing else to confirm
    return previewState === 'READY' ? 'ready' : 'not_ready_preview';    // product PR — preview must confirm deployable
  }
  return null; // 'behind'/'unknown'/draft, or mergeable still null-and-not-clean — GitHub hasn't settled
}

export async function verifyProductPRs({ builds = null, prInfoFn = ghPrInfo, deployFn = vcDeploymentForRef, commentFn = executeCommentIssueIn, closeFn = executeClosePRIn, log = () => {} } = {}) {
  const records = builds || listBuilds(); // newest-first — the newest record for a PR speaks for it
  const productRepo = config.githubRepo();
  const seen = new Set(); const verdicts = [];
  for (const b of records) {
    const pr = prCoords(b);
    if (!pr || pr.repo !== productRepo) continue; // deployability is a PROD concern; tool PRs have the test gate
    const key = `${pr.repo}#${pr.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let info;
    try { info = await prInfoFn({ repo: pr.repo, number: pr.number }); }
    catch (e) { log(`verify: ${key} unreadable (${String(e.message).slice(0, 80)})`); continue; }
    if (info.state !== 'open') continue;
    if (b.previewVerdictSha === info.headSha) continue; // this head already has its stamp
    let dep;
    try { dep = await deployFn({ ref: info.head, sha: info.headSha }); }
    catch (e) { log(`verify: ${key} — Vercel unreadable (${String(e.message).slice(0, 80)})`); continue; }
    if (!dep || dep.configured === false) { log('verify: Vercel not configured — sweep skipped'); return { verdicts }; }
    if (dep.error) { log(`verify: ${key} — ${dep.error}`); continue; }
    if (dep.none) { log(`verify: ${key} — no preview build for this head yet; next sweep re-checks`); continue; }
    if (!['READY', 'ERROR', 'FAILED', 'CANCELED'].includes(dep.state)) { log(`verify: ${key} — preview still ${dep.state}; next sweep re-checks`); continue; }
    // A SETTLED hard failure (ERROR/FAILED) on a PR the BUILDER opened is proof the change never built —
    // so WITHDRAW it, the same authority build-runner has (executeClosePRIn), for the PRs whose ~8-min
    // in-process runner window already elapsed. Left OPEN, a stamped "DO NOT MERGE" reads as a happy "PR
    // ready" in the Tasks tab — the #194/#243 false-green. Tightly scoped: only builder branches
    // (exec/build-*), only verdictOutcome==='close' (a hard ERROR/FAILED — NEVER CANCELED/BUILDING/
    // QUEUED/null/timeout). The linked TASK stays open: the work still needs doing.
    if (verdictOutcome(dep.state) === 'close' && /^exec\/build-/.test(info.head || '')) {
      try { await closeFn({ repo: pr.repo, number: pr.number, comment: `⚠️ The Vercel preview build for this branch FAILED — merging would push a broken build to production. The Seen Command builder is withdrawing (closing) the PR it opened; the linked task stays open for a fresh attempt. 🤖` }); }
      catch (e) { log(`verify: close failed for ${key} (${String(e.message).slice(0, 80)})`); continue; }
      writeBuild(b.id, { previewVerdictSha: info.headSha, preview: { state: dep.state, url: dep.url || null }, status: 'preview_failed' });
      verdicts.push({ key, state: dep.state, closed: true });
      log(`verify: ${key} → ${dep.state} — PR CLOSED (builder withdrew its own broken PR); task stays open`);
      logActivity({ kind: 'verdict', id: key, status: dep.state, summary: `preview build ${dep.state} — PR withdrawn (${key}); task stays open` });
      continue;
    }
    try { await commentFn({ repo: pr.repo, number: pr.number, body: verdictComment(dep.state, dep.url) }); }
    catch (e) { log(`verify: comment failed for ${key} (${String(e.message).slice(0, 80)})`); continue; }
    writeBuild(b.id, { previewVerdictSha: info.headSha, preview: { state: dep.state, url: dep.url || null } });
    verdicts.push({ key, state: dep.state });
    log(`verify: ${key} → ${dep.state}${dep.state === 'READY' ? ` (https://${dep.url})` : ''}`);
    logActivity({ kind: 'verdict', id: key, status: dep.state, summary: `preview verdict ${key} → ${dep.state === 'READY' ? 'deployable' : 'DO NOT MERGE'} (${dep.state})${dep.state === 'READY' && dep.url ? ` — ${dep.url}` : ''}` });
  }
  return { verdicts };
}

// CLI: node engine/pr-verify.mjs — one manual sweep, honest output.
import { fileURLToPath } from 'node:url';
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  verifyProductPRs({ log: (m) => console.log(`[pr-verify] ${m}`) })
    .then((r) => { console.log(JSON.stringify(r)); process.exit(0); })
    .catch((e) => { console.error(`[pr-verify] ${e.message}`); process.exit(1); });
}
