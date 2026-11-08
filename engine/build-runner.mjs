#!/usr/bin/env node
// The background build-runner — the bridge from "Brandon approved an engineering action" to a real,
// test-gated PR. The server spawns this DETACHED on approval so the HTTP request returns instantly and
// the build survives even if the app window closes. It drives engine/builder.mjs and records lifecycle
// to data/builds/<id>.json (building → pr_ready | merged | failed), which the dashboard polls.
//
// Usage (spawned by engine/server.mjs, but runnable by hand):
//   node engine/build-runner.mjs --id <buildId> --repo tool|product --task "..." \
//        [--key "<stableKey>"] [--title "..."] [--issue-repo owner/name --issue-number N] \
//        [--auto-merge] [--dry-run]

import { runBuild, explainBuildFailure } from './builder.mjs';
import { readBuild, writeBuild, queueBuild, appendBuildLog, acquireBuildSlot, releaseBuildSlot, reconcileStaleBuilds } from '../lib/builds.mjs';
import { executeCommentIssueIn, executeCloseIssueIn, executeClosePRIn, prInfo } from '../lib/connectors/github.mjs';
import { deploymentForRef } from '../lib/connectors/vercel.mjs';
import { verdictComment, verdictOutcome, derivePrStatus } from './pr-verify.mjs';
import { observeBuild, initialProof, proofSummary } from './completion.mjs';
import { prCoords } from './reconcile.mjs';
import { logActivity } from '../lib/activity.mjs';
import '../lib/notify-wire.mjs';
import { recordFailure, failureBrief } from '../lib/failure-loop.mjs';
import { claudeCliHealth, clineCliHealth } from '../lib/credentials.mjs';

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    const name = k.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { a[name] = true; }
    else { a[name] = next; i++; }
  }
  return a;
}

// A human phrase for a non-ready prStatus — feeds the build log AND the activity-ledger summary so a
// Claude session reading data/activity/*.jsonl sees WHY a fresh PR isn't ready, not just a code word.
function prStatusReason(prStatus, mergeableState, previewState) {
  if (prStatus === 'conflicting') return 'conflicts with its base branch';
  if (prStatus === 'checks_failing') return 'a required check is failing (or a merge gate is unmet)';
  if (prStatus === 'not_ready_preview') return `the Vercel preview did not confirm deployable (preview=${previewState || 'none'})`;
  return `GitHub had not settled mergeability in time (mergeable_state=${mergeableState || 'unknown'})`;
}

// POST-CREATE PR STATUS CHECK — Brandon's directive: "after creating a PR, Seen Command must check the
// PR's status to know if it conflicts; that result must show in the Tasks tab; and if the PR doesn't
// reflect READY, it reports that into the activity ledger." DETECTION + VISIBILITY ONLY — it never
// merges or closes (the self-update conflict rescue and the reconcile sweep keep those jobs). GitHub
// computes mergeability ASYNCHRONOUSLY after a PR opens, so we poll a few beats (the same idiom as
// self-update's mergeAfterRescue) until it settles, fold GitHub's signals (+ the product preview state)
// into one compact prStatus via derivePrStatus, write it as an ADDITIONAL field on the build record
// (the existing status — pr_ready / preview_failed — is untouched), and log ONE ledger line either way
// (a 'ready' line too — completeness is the point of the ledger).
async function checkPrStatusAfterCreate({ id, pr, previewState }) {
  const pc = prCoords({ pr });
  if (!pc) return;
  let info = null;
  for (let i = 0; i < 4; i++) { // ~4 tries, ~5s apart — mergeability lands async once the PR is open
    try { info = await prInfo({ repo: pc.repo, number: pc.number }); }
    catch (e) { appendBuildLog(id, `[runner] PR-status read failed: ${e.message}`); }
    // Settled once GitHub reports a concrete summary word (or a definite mergeable === false).
    if (info && (info.mergeable === false || (info.mergeableState && info.mergeableState !== 'unknown'))) break;
    if (i < 3) await new Promise((s) => setTimeout(s, 5000));
  }
  const ms = info?.mergeableState || 'unknown';
  const prStatus = derivePrStatus({ mergeable: info?.mergeable, mergeable_state: info?.mergeableState, previewState });
  writeBuild(id, { prStatus }); // ADDITIONAL field — the Tasks tab paints it next to the PR link
  const detail = `mergeable_state=${ms}${previewState ? `, preview=${previewState}` : ''}`;
  if (prStatus === 'ready') {
    appendBuildLog(id, `[runner] PR status: ready to merge (${detail})`);
    logActivity({ kind: 'pr-status', id, status: 'ready', summary: `PR ${pr} ready to merge`, detail });
  } else {
    const reason = prStatusReason(prStatus, ms, previewState);
    appendBuildLog(id, `[runner] PR status: ${prStatus || 'unknown'} — ${reason}`);
    logActivity({ kind: 'pr-status', id, status: prStatus || 'unknown', summary: `PR ${pr} not ready after creation — ${reason}`, detail });
  }
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const id = a.id;
  if (!id || !a.task) { console.error('build-runner needs --id and --task'); process.exit(1); }
  const repo = a.repo === 'product' ? 'product' : 'tool';
  const dryRun = !!a['dry-run'];
  const autoMerge = !!a['auto-merge'];

  // Reap corpses before adding to the pile: any record still 'queued'/'building' whose runner process
  // is gone died without a verdict, and would otherwise show "building…" forever. Deterministic, and
  // never fatal — a sweep problem must not stop the build the owner actually asked for.
  try {
    for (const r of reconcileStaleBuilds()) {
      logActivity({ kind: 'build', id: r.id, status: 'failed', summary: `zombie build reaped — was '${r.from}' with no live process`, detail: r.reason });
    }
  } catch (e) { console.error(`[runner] stale-build sweep failed: ${e.message}`); }

  const issue = a['issue-repo'] && a['issue-number'] ? { repo: a['issue-repo'], number: Number(a['issue-number']) } : null;
  // The runner's pid is what makes a dead build detectable: a record whose pid no longer exists died
  // mid-flight and must be reaped (see reconcileStaleBuilds). queueBuild clears the previous run's
  // verdict — including its pid — so nothing can mistake THIS run for that one.
  queueBuild(id, { id, key: a.key || null, title: a.title || a.task, task: a.task, repo, pid: process.pid, issue });

  try {
    // ONE build at a time: they share the local coder and (tool builds) one git checkout. Wait our
    // turn in 'queued'; a crashed holder's lock is stale and clears itself.
    // LANE PREFLIGHT (gap #3 — 4 failures). task-111 and run-202607190818-a1 each ran for minutes
    // and then died on "your credit balance is too low"; chat-mreai2wv died on "no LOCAL coder is
    // served" while qwen2.5-coder WAS running. A lane that cannot work is checkable in milliseconds,
    // so check BEFORE taking the slot rather than discovering it mid-build. UNKNOWN counts as usable:
    // a slow probe is not a verdict, and refusing to build on "I could not tell" would be the
    // silent-zero mistake in the other direction.
    const lanes = [];
    try { const c = claudeCliHealth(); lanes.push({ name: 'claude-cli', usable: c.installed && c.authenticated !== false, why: c.reason || (c.installed ? 'ok' : 'not installed') }); }
    catch (e) { lanes.push({ name: 'claude-cli', usable: true, why: `probe failed (${e.message}) — treated as usable` }); }
    try { const c = clineCliHealth(); lanes.push({ name: 'cline', usable: !!c.runnable && c.authenticated !== false, why: c.reason || (c.runnable ? 'ok' : 'does not run') }); }
    catch (e) { lanes.push({ name: 'cline', usable: true, why: `probe failed (${e.message}) — treated as usable` }); }
    try {
      const { servedTags } = await import('../lib/router.mjs');
      const tags = [...(await servedTags())];
      lanes.push({ name: 'local-ollama', usable: tags.length > 0, why: tags.length ? tags.slice(0, 3).join(', ') : 'no models served' });
    } catch (e) { lanes.push({ name: 'local-ollama', usable: true, why: `probe failed (${e.message}) — treated as usable` }); }
    if (!lanes.some((l) => l.usable)) {
      const detail = lanes.map((l) => `${l.name}: ${l.why}`).join(' · ');
      appendBuildLog(id, `[runner] lane preflight FAILED — ${detail}`);
      const err = new Error(`no coding lane is usable — ${detail}. Nothing was built; fix a lane, then re-run the task.`);
      err.blocked = true;
      throw err;
    }
    appendBuildLog(id, `[runner] lanes usable: ${lanes.filter((l) => l.usable).map((l) => l.name).join(', ')}`);

    let waits = 0;
    await acquireBuildSlot(id, (holder) => {
      if (waits++ % 6 === 0) appendBuildLog(id, `[runner] queued — waiting for ${holder.id} to finish (one build at a time keeps the local coder fast)`);
    });
    writeBuild(id, { status: 'building' });
    logActivity({ kind: 'build', id, status: 'started', summary: `build started — ${repo === 'tool' ? 'Seen Command' : 'Seen product'} repo`, detail: String(a.task).slice(0, 200) });
    // A retry that repeats a known failure is wasted money and time. If this id has failed before,
    // the coder receives that history so attempt N+1 starts where attempt N died — the difference
    // between "it failed again" and the platform actually getting better at its own work.
    let taskText = a.task;
    try {
      const brief = failureBrief(id);
      if (brief) {
        taskText = `${a.task}\n\n${brief}`;
        appendBuildLog(id, `[runner] retry informed by ${brief.split('\n').length - 2} prior failure(s) — the coder was told what already failed`);
      }
    } catch (e) { appendBuildLog(id, `[runner] could not read the failure history: ${e.message}`); }
    const r = await runBuild({ task: taskText, repo, autoMerge, dryRun, issue, onEvent: (m) => appendBuildLog(id, m) });
    const status = r.dryRun ? 'green_dry' : (r.merged ? 'merged' : 'pr_ready');
    writeBuild(id, {
      status, endedAt: new Date().toISOString(),
      pr: r.pr || null, prNumber: r.number || null, summary: r.summary || null,
      touched: r.touched || [], engine: r.engine || null, merged: !!r.merged,
    });
    appendBuildLog(id, `[runner] ${status}${r.pr ? ` → ${r.pr}` : ''}`);
    logActivity({ kind: 'build', id, status, summary: `build ${status}${r.pr ? ` — ${r.pr}` : ''} (${repo === 'tool' ? 'Seen Command' : 'Seen product'})`, detail: r.summary || null });
    releaseBuildSlot(); // git work is done — the queue moves on while we do network-only follow-ups

    // Best-effort: link the tracked issue to the PR so the Tasks tab and the PR reference each other.
    // A MERGED result means the task is DONE — close it right now ("Command knows instantly"); the
    // PR-body `Closes` keyword covers merges that happen later (Brandon, self-update).
    if (r.pr && issue) {
      try {
        if (r.merged) { await executeCloseIssueIn({ repo: issue.repo, number: issue.number, comment: `✅ Shipped and merged: ${r.pr} — closing this task.` }); appendBuildLog(id, '[runner] task closed (PR merged)'); }
        else { await executeCommentIssueIn({ repo: issue.repo, number: issue.number, body: `🤖 The Seen Command builder turned this into a test-gated PR: ${r.pr}` }); }
      } catch (e) { appendBuildLog(id, `[runner] issue-link failed: ${e.message}`); }
    }
    // Product PRs face Brandon's merge button, and merging deploys PROD — so wait for the Vercel
    // preview verdict (the same builder production uses) and stamp it on the PR before finishing:
    // ✅ deployable + a live preview link to eyeball, or ⚠️ DO NOT MERGE. No blind merges.
    let previewState = null;      // the settled Vercel preview state (product only) — folded into prStatus below
    let previewWithdrew = false;  // #99: a hard preview ERROR already withdrew this PR → record reads preview_failed
    if (r.pr && repo === 'product' && !r.merged) {
      appendBuildLog(id, '[runner] waiting for the Vercel preview verdict…');
      try {
        const pc = prCoords({ pr: r.pr });
        let dep = null;
        for (let i = 0; i < 16; i++) { // up to ~8 min — previews normally land in 1-3
          await new Promise((s) => setTimeout(s, 30000));
          const info = await prInfo({ repo: pc.repo, number: pc.number });
          dep = await deploymentForRef({ ref: info.head, sha: info.headSha });
          if (dep && dep.configured === false) { appendBuildLog(id, '[runner] Vercel not configured — verdict left to the verify sweep'); dep = null; break; }
          if (dep && ['READY', 'ERROR', 'CANCELED'].includes(dep.state)) break;
          dep = null;
        }
        if (dep) {
          previewState = dep.state;
          writeBuild(id, { preview: { state: dep.state, url: dep.url || null } });
          if (verdictOutcome(dep.state) === 'close') {
            // HARD FAILURE (ERROR): the preview build broke, so the change never reached a mergeable
            // state. A stamped DO-NOT-MERGE left OPEN reads as a green "PR ready" in the Tasks tab
            // (the #194 case) — so the builder withdraws its OWN PR (only THIS build's own PR number,
            // only on a proven ERROR) and records the honest outcome. The linked TASK stays open: the
            // work still needs doing. Never reached for BUILDING/QUEUED/timeout (dep is null then) or
            // CANCELED/READY (verdictOutcome keeps those — a canceled build isn't proof of breakage).
            previewWithdrew = true;
            writeBuild(id, { status: 'preview_failed', error: 'the Vercel preview build FAILED — PR closed; the change never reached a mergeable state' });
            logActivity({ kind: 'build', id, status: 'preview_failed', summary: `preview build FAILED — PR withdrawn (${pc.repo}#${pc.number}); task stays open`, detail: 'the Vercel preview build FAILED; the change never reached a mergeable state' });
            try {
              await executeClosePRIn({ repo: pc.repo, number: pc.number,
                comment: `⚠️ The Vercel preview build for this branch FAILED — merging would push a broken build to production. The Seen Command builder is withdrawing (closing) the PR it opened; the linked task stays open for a fresh attempt. 🤖` });
              appendBuildLog(id, `[runner] preview verdict: ERROR — PR ${pc.repo}#${pc.number} CLOSED (builder withdrew its own broken PR); task stays open`);
            } catch (e) {
              // Close failed (transient GitHub hiccup): the record already reads preview_failed — the
              // false-green is gone — and the withdrawal comment posted first still warns on the PR.
              appendBuildLog(id, `[runner] preview ERROR — record marked preview_failed, but PR-close failed: ${e.message}`);
            }
          } else {
            await executeCommentIssueIn({ repo: pc.repo, number: pc.number, body: verdictComment(dep.state, dep.url) });
            appendBuildLog(id, `[runner] preview verdict: ${dep.state}${dep.state === 'READY' ? ` → https://${dep.url}` : ' — DO NOT MERGE'}`);
          }
        } else {
          appendBuildLog(id, '[runner] no preview verdict yet — the verify sweep will stamp it');
        }
      } catch (e) { appendBuildLog(id, `[runner] preview check failed: ${e.message}`); }
    }

    // After a PR opens (BOTH repos), check whether it actually reflects READY — Brandon's directive:
    // "check the PR's status to know if it conflicts; show it in the Tasks tab; if the PR doesn't
    // reflect READY, report it into the activity ledger." Folds GitHub's mergeability with the product
    // preview (pass the settled state, or 'PENDING' if it never landed, so a product PR is only 'ready'
    // when the preview truly said READY; tool PRs pass nothing — their gate ran locally). Skipped only
    // when the preview path just WITHDREW this PR (#99): that record already reads preview_failed with
    // its own honest ledger line, and a closed PR has no live status to describe.
    if (r.pr && !r.merged && !previewWithdrew) {
      try {
        const previewArg = repo === 'product' ? (previewState || 'PENDING') : undefined;
        await checkPrStatusAfterCreate({ id, pr: r.pr, previewState: previewArg });
      } catch (e) { appendBuildLog(id, `[runner] PR-status check failed: ${e.message}`); }
    }
    // PROOF LEDGER — the PR is open, which is not the same as the work being done. Record what must still
    // be OBSERVED (the contract's completion conditions) and take the first observation now; the proof
    // sweep (self-update, `npm run proof`) keeps looking until it is proven or failed.
    if (r.pr && !previewWithdrew) {
      try {
        const kind = (r.contract && r.contract.kind) || 'behaviour';
        const proof = await observeBuild({ ...readBuild(id), repo, kind, pr: r.pr, proof: initialProof({ repo, kind }) });
        writeBuild(id, { kind, proof });
        appendBuildLog(id, `[runner] proof: ${proofSummary(proof)}`);
        logActivity({ kind: 'proof', id, status: proof.state, summary: `${r.pr} — ${proofSummary(proof)}` });
      } catch (e) { appendBuildLog(id, `[runner] proof ledger could not be recorded: ${e.message}`); }
    }
    appendBuildLog(id, `[runner] Build finished: ${status}${r.pr ? ' — PR open; DONE only when its proof ledger reads PROVEN' : ''}`);
    process.exit(0);
  } catch (e) {
    releaseBuildSlot();
    // An honest REFUSAL (e.refusal, set by builder.refusalError) is the builder declining a build BY
    // DESIGN — a phantom/closed premise or a duplicate of an already-open PR — not breakage. Record
    // 'refused' so the dashboard paints a calm "needs your review", not red "⚠ Build failed" (the owner
    // kept reading yesterday's #88 duplicate-of-open-PR refusal as a failure). Genuine failures keep
    // 'failed'. A refusal is a clean, intended outcome, so it exits 0 — nothing awaits this exit code
    // (the runner is spawned detached), but 0 is the honest signal that the runner did its job.
    const refused = !!e.refusal;
    // Record a reason a human can ACT on, not a raw provider payload. explainBuildFailure turns
    // 'HTTP 400: {"type":"error",…"Your credit balance is too low…' into "the Anthropic coding lane is
    // out of credit — add funds…". The original text is kept verbatim in errorDetail: normalizing the
    // headline must never destroy the evidence, and `blocked` tells the UI/chat that this build was
    // stopped by something only the owner can clear (credential, quota, missing lane, red base branch)
    // rather than by the coder failing at the work.
    const x = explainBuildFailure(e);
    writeBuild(id, {
      status: refused ? 'refused' : 'failed', endedAt: new Date().toISOString(),
      error: x.reason, errorKind: x.kind, blocked: x.blocked, errorDetail: x.detail,
    });
    appendBuildLog(id, `[runner] ${refused ? 'REFUSED' : 'FAILED'}: ${x.reason}`);
    if (x.detail && x.detail !== x.reason) appendBuildLog(id, `[runner] detail: ${x.detail.split('\n')[0].slice(0, 300)}`);
    logActivity({
      kind: 'build', id, status: refused ? 'refused' : 'failed',
      summary: `build ${refused ? 'REFUSED (needs your review)' : 'FAILED'} — ${repo === 'tool' ? 'Seen Command' : 'Seen product'}: ${x.reason}`,
      detail: x.detail,
    });
    // A failure must never END here. Queue it where a future session can patch it, and tell Chronos,
    // so the platform learns from the break instead of accumulating silent red records. A REFUSAL is
    // deliberately excluded: the builder declining a bad premise is the system working, not failing.
    if (!refused) {
      try {
        recordFailure({
          kind: 'build', id, key: a.key || null, repo, title: a.title || a.task || null,
          reason: x.reason, detail: x.detail, blocked: x.blocked, errorKind: x.kind,
          source: 'engine/build-runner.mjs',
        });
      } catch (err) { appendBuildLog(id, `[runner] failure-queue write failed: ${err.message}`); }

      // DECOMPOSITION (gap #8). A task that has already failed once and failed again the same way is
      // not going to succeed on a third identical replay — six failures read "could not reach a green
      // gate in 6/8 rounds". Split it into smaller verifiable steps and QUEUE them; deliberately do
      // NOT spawn them, because auto-spawning N builds out of one failure is a fork bomb.
      try {
        const priorHistory = failureBrief(id);
        if (priorHistory && /gate|coder|reviewer/i.test(String(x.kind || ''))) {
          const { splitTask } = await import('./task-split.mjs');
          const split = await splitTask({ task: a.task, history: priorHistory, repo });
          const subs = (split && split.subtasks) || [];
          if (subs.length >= 2) {
            subs.forEach((st, i) => {
              const subId = `${id}-s${i + 1}`;
              writeBuild(subId, { id: subId, repo, task: st.task, title: st.title || st.task.slice(0, 90), status: 'queued',
                startedAt: new Date().toISOString(), parent: id, log: [`[runner] queued from the decomposition of ${id}: ${split.reason || 'repeated failure'}`] });
            });
            appendBuildLog(id, `[runner] split into ${subs.length} smaller tasks (${subs.map((_, i) => `${id}-s${i + 1}`).join(', ')}) — queued, not started`);
          } else if (split && split.reason) {
            appendBuildLog(id, `[runner] not split: ${split.reason}`);
          }
        }
      } catch (err) { appendBuildLog(id, `[runner] decomposition skipped: ${err.message}`); }
    }
    process.exit(refused ? 0 : 1);
  }
}

main();
