#!/usr/bin/env node
// Keep the brain current WITHOUT running a board meeting.
//
// Why this exists: the only thing that ever wrote live business numbers into the brain was
// `engine/run.mjs` step 7 — inside a full board meeting, which spends real LLM calls across every
// department. Once meetings stopped running automatically on launch (#153), nothing fed the brain, so
// on 2026-08-12 its newest business fact was 2026-08-05 while the Command Center snapshot was newer
// still. A brain that lags the snapshot it is supposed to arbitrate is worse than useless: the
// Command Center reconcile (lib/kpi-reconcile.mjs) prefers whichever side is FRESHER, so a stale brain
// silently stops correcting anything.
//
// This is the cheap half of that step, on its own: fetch the live signals, record them as bi-temporal
// facts, push to the cloud. No models, no departments — safe to run on a short interval.
//
// Re-recording an unchanged value is a NO-OP, not a supersede (see recordFact's dedup), so running
// this often does not churn the vault or inflate its history.
//
// Usage: node scripts/brain-sync.mjs [--quiet]
//   exit 0 = synced (or nothing to change) · exit 1 = could not reach the live signals

import { recordFacts, brainVault, currentFacts } from '../lib/brain.mjs';
import { kpiObservations } from '../brain/lib/metrics.mjs';

const quiet = process.argv.includes('--quiet');
const say = (m) => { if (!quiet) process.stdout.write(`${m}\n`); };

// Signals for which ZERO is not a real reading, it is a failure sentinel. `ct()` in the product's
// api/admin-stats.js computes counts as
//   parseInt((r?.headers?.get('content-range') || '').split('/')[1]) || 0
// which never checks `r.ok` — so a 4xx, a timeout, or a missing header all read as a clean 0. This
// actually happened: the first run of this script pulled `active_jobs = 0` while the database held
// tens of thousands of jobs, and recorded it straight over the previous non-zero value. "Keep the brain current" must never mean
// "let a swallowed HTTP error become a durable fact".
//
// Deliberately narrow: an inventory or account total does not legitimately collapse to zero, whereas
// revenue_30d / paying_customers_30d / errors_today / users_new_today all sit at zero honestly and must NOT be guarded.
const NEVER_ZERO = new Set(['users_total', 'active_jobs']);

// Drop any guarded signal that reads 0 while the brain already holds a non-zero value. Returns
// { keep, rejected } so the caller can report the rejection instead of hiding it.
export function screenSignals(obs, openFacts) {
  const prior = new Map();
  for (const f of Array.isArray(openFacts) ? openFacts : []) {
    if (f && f.valid_to == null) prior.set(String(f.predicate), String(f.object ?? ''));
  }
  const keep = []; const rejected = [];
  for (const o of obs) {
    const n = Number(String(o.object).replace(/[^0-9.-]/g, ''));
    const was = Number(String(prior.get(o.predicate) ?? '').replace(/[^0-9.-]/g, ''));
    if (NEVER_ZERO.has(o.predicate) && n === 0 && Number.isFinite(was) && was > 0) {
      rejected.push({ ...o, was: prior.get(o.predicate) });
      continue;
    }
    keep.push(o);
  }
  return { keep, rejected };
}

// The ONE list of KPI readings (brain/lib/metrics.mjs) — the same predicates the board meeting records, so
// this SUPERSEDES the meeting's values rather than creating a parallel vocabulary.
const obsFrom = kpiObservations;

async function main() {
  const vault = brainVault();
  if (!vault) { process.stderr.write('[brain-sync] no vault (set CHRONOS_VAULT) — nothing written\n'); return 1; }

  let admin = null;
  try {
    const { summary } = await import('../lib/connectors/adminStats.mjs');
    admin = await summary();
  } catch (e) {
    // Loud and specific: a silent failure here is exactly how the brain went stale for a week.
    process.stderr.write(`[brain-sync] live signals unavailable — the brain was NOT updated: ${e.message}\n`);
    return 1;
  }

  // The endpoint now tells us whether its own numbers are measurements. If ANY underlying query
  // failed, some count in this payload is a fabricated 0, and there is no way from out here to know
  // which — so record nothing rather than risk writing a wrong number into the durable record. This is
  // the authoritative check; screenSignals below is the belt-and-braces for older deploys that do not
  // report data_quality at all.
  const dq = admin.dataQuality;
  if (dq && dq.degraded) {
    const tables = [...new Set((dq.failed || []).map((f) => `${f.table}${f.status ? ` (${f.status})` : ''}`))];
    process.stderr.write(`[brain-sync] ⚠ admin-stats reported ${dq.failedCount} FAILED quer${dq.failedCount === 1 ? 'y' : 'ies'}`
      + `${tables.length ? `: ${tables.join(', ')}` : ''}. Some counts are fabricated zeros, so the brain was NOT updated.\n`);
    return 1;
  }

  const all = obsFrom(admin);
  const { keep, rejected } = screenSignals(all, currentFacts());
  for (const r of rejected) {
    process.stderr.write(`[brain-sync] ⚠ REJECTED ${r.subject} ${r.predicate} = ${r.object} `
      + `(brain holds ${r.was}). Zero is this endpoint's failure sentinel, so the brain was left alone. `
      + `Check the upstream count in the product's api/admin-stats.js.\n`);
  }
  const res = recordFacts(keep);
  let written = res?.written ?? 0;
  say(`[brain-sync] ${all.length} signals checked · ${keep.length} trusted · ${rejected.length} rejected `
    + `· ${written} fact(s) changed · vault ${vault}`);
  for (const o of keep) say(`    ${o.subject} ${o.predicate} = ${o.object}`);

  // Hygiene, every cycle — the backend maintaining its own brain rather than waiting for a human to
  // notice rot. keeper.review() is deterministic (no model). Its verdict is recorded as ONE fact that
  // supersedes on change and no-ops when unchanged, so hourly runs cannot churn the vault, and it shows
  // up attributed in Seen Command → Brain → Activity like any other write.
  try {
    const { review, verdictLine } = await import('../brain/lib/keeper.mjs');
    const r = review();
    // Use the keeper's OWN verdict sentence. This used to be re-derived here and branched only on
    // contradictions, so it recorded "clean" while review() itself returned clean:false with 53
    // stale facts — the recorded hygiene fact contradicted the function that produced it.
    // The fallback calls the SAME verdictLine rather than rebuilding a sentence, so an older keeper
    // (this repo has repeatedly run a stale bundle for days) degrades to a correct verdict instead
    // of writing `undefined` and dying inside recordFacts with an unrelated error message.
    const verdict = r.verdict || verdictLine(r);
    const h = recordFacts([{ subject: 'Brain hygiene', predicate: 'keeper_verdict', object: verdict, confidence: 'high' }]);
    if (h?.written) { written += h.written; say(`[brain-sync] keeper verdict recorded: ${verdict.slice(0, 120)}`); }
    if (r.contradictions.length) process.stderr.write(`[brain-sync] ⚠ keeper found ${r.contradictions.length} contradiction(s) — visible in Seen Command → Brain → Health.\n`);
  } catch (e) { process.stderr.write(`[brain-sync] keeper skipped: ${e.message}\n`); }

  // Merge-vs-deploy drift, every cycle. A merge that never deploys is indistinguishable from a fix
  // that did not work — that cost five hours on 2026-08-13. Loud, hourly, and recorded as a fact so it
  // shows up in Seen Command → Brain rather than needing anyone to remember to check.
  try {
    const { execFileSync } = await import('node:child_process');
    // Destructured here, in this file's dynamic-import idiom. fileURLToPath is required, not
    // optional: the path must be DECODED before it becomes argv[1], because deploy-drift's CLI
    // guard compares argv[1] to its own decoded path and this ships inside
    // "/Applications/Seen Command.app" — a percent-encoded space silently disables the monitor.
    const { fileURLToPath } = await import('node:url');
    execFileSync(process.execPath, [fileURLToPath(new URL('./deploy-drift.mjs', import.meta.url)), '--quiet'],
      { stdio: ['ignore', 'ignore', 'inherit'], timeout: 60000 });
  } catch { /* non-zero = drift, already reported to stderr by the checker; never fail the sync */ }

  // Durability: a local-only write is one restore away from being irrelevant. The pull guard added in
  // brain/lib/cloud.mjs means this can no longer be clobbered mid-flight, but it still has to go up.
  if (written) {
    try {
      const { pushBrainSafe, cloudConfigured } = await import('../brain/lib/cloud.mjs');
      if (cloudConfigured()) {
        const p = await pushBrainSafe(vault);
        say(`[brain-sync] pushed to the cloud brain: ${JSON.stringify(p?.notes ?? p ?? {})}`);
      } else say('[brain-sync] cloud not configured — facts are local until the next push');
    } catch (e) { process.stderr.write(`[brain-sync] cloud push skipped: ${e.message}\n`); }
  }
  return 0;
}

main().then((code) => process.exit(code)).catch((e) => {
  process.stderr.write(`[brain-sync] failed: ${e.message}\n`);
  process.exit(1);
});
