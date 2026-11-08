#!/usr/bin/env node
// Is what's MERGED actually what's DEPLOYED?
//
// On 2026-08-13 a merge to next-migration produced NO production deployment — commit 58c02f6 carried
// zero GitHub statuses, so Vercel's integration never fired. Nothing surfaced that. Production sat five
// hours behind while the database had already been migrated ahead of it, which turned a narrow bug into
// "every append_timeline fails". `seen`'s CLAUDE.md still asserted "merging to next-migration
// auto-deploys to production… do NOT tell the owner to manually trigger deploys", so every session was
// instructed to trust exactly the thing that had silently broken.
//
// The lesson generalizes past that one PR: a merge that never deploys is INDISTINGUISHABLE from a fix
// that did not work. The next PR without a migration (e.g. ATS discovery) would have read as "the fix
// didn't help" rather than "the fix never shipped". So drift becomes a first-class, loud signal instead
// of something a human must remember to check.
//
// Compares the production branch tip on GitHub against the newest READY production deployment on
// Vercel, records the verdict as ONE supersede-on-change brain fact (so it is visible in
// Chronos → Brain and cannot churn), and exits non-zero when drifted so callers can gate on it.
//
// "cannot churn" DEPENDS ON THE VERDICT BEING TIME-INDEPENDENT, and for a while this comment was
// simply wrong: the sentence carried "(deployed N min ago)", N changed every run, and so an
// unchanged deploy superseded the fact hourly. See driftVerdict below. Keep that function a pure
// function of deploy state — the moment it reads a clock, this line becomes a lie again.
//
// Usage: node scripts/deploy-drift.mjs [--quiet]
//   exit 0 = in sync (or not checkable) · exit 1 = DRIFTED · exit 2 = misconfigured

import { execFileSync } from 'node:child_process';
import { recordFacts } from '../lib/brain.mjs';
import { fileURLToPath } from 'node:url';

const quiet = process.argv.includes('--quiet');
const say = (m) => { if (!quiet) process.stdout.write(`${m}\n`); };

const REPO = 'begindtheseen/Seen';
const BRANCH = 'next-migration';
// Vercel scope comes from the environment (see .env.example) — never hardcode team/project ids.
const TEAM = process.env.VERCEL_TEAM_ID || '';
const PROJECT = process.env.VERCEL_PROJECT_ID || '';

// Branch tip via gh (already authenticated on this machine; no extra secret needed).
function branchTip() {
  try {
    const out = execFileSync('gh', ['api', `repos/${REPO}/commits/${BRANCH}`, '-q', '.sha'],
      { encoding: 'utf8', timeout: 30000 });
    return String(out).trim().slice(0, 40) || null;
  } catch { return null; }
}

// Newest READY production deployment. Returns { sha, created } or null.
async function newestProdDeploy() {
  const token = process.env.VERCEL_TOKEN;
  if (!token || !PROJECT) return null; // unconfigured → "not checkable", never a false alarm
  const scope = TEAM ? `&teamId=${encodeURIComponent(TEAM)}` : '';
  const url = `https://api.vercel.com/v6/deployments?projectId=${encodeURIComponent(PROJECT)}${scope}&target=production&limit=10`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  const j = await res.json();
  for (const d of j.deployments || []) {
    if (d.state !== 'READY') continue;
    return { sha: String((d.meta && d.meta.githubCommitSha) || '').slice(0, 40), created: d.created };
  }
  return null;
}

// The single drift decision, shared by the exit code and the recorded sentence so they cannot
// disagree.
export const isDrifted = (tip, prodSha) => tip !== prodSha;

// The verdict this monitor records, as a PURE function of the deploy state.
//
// A monitor must carry a QUERY, not a CONCLUSION, and any state it does assert has to be scoped so
// the next reader treats it as a prior rather than a fact. The concrete form of that here: the
// deploy time is stated ABSOLUTELY, never as "N min ago".
//
// A relative age is a point-in-time claim with no validity window. "deployed 10 min ago" is false
// ten minutes later and absurd a day later, and this monitor wrote it into a DURABLE fact. The
// bi-temporal fields already answer "when was this checked" — `recorded`/`recorded_at` exist
// precisely so the claim itself need not carry the clock.
//
// It also defeated the no-op path. recordFacts supersedes on change, and the age differed on every
// run, so an unchanged deploy still minted a new row every hour: all 6 merge_vs_deploy rows in the
// vault carried an age (10, 2, 12, 5 …) and differed only by it. An absolute timestamp is stable
// while the deploy is stable, so an unchanged deploy now writes nothing.
//
// Pure and exported so the stability property is testable: the same deploy state must produce the
// same sentence no matter when it is evaluated.
export function driftVerdict({ branch, tip, prodSha, deployedMs } = {}) {
  const at = Number(deployedMs) > 0 ? new Date(Number(deployedMs)).toISOString() : 'unknown time';
  return isDrifted(tip, prodSha)
    ? `DRIFTED — ${branch} is at ${String(tip).slice(0, 8)} but production serves ${String(prodSha).slice(0, 8)} (deployed ${at}). A merge did not deploy; a fix that never shipped looks exactly like a fix that did not work. Trigger a production deployment for the merged sha before drawing ANY conclusion from production behaviour.`
    : `in sync — ${branch} and production both at ${String(tip).slice(0, 8)} (deployed ${at})`;
}

async function main() {
  const tip = branchTip();
  const prod = await newestProdDeploy();
  // Not checkable is NOT drift — say so and exit clean, so a machine without gh/VERCEL_TOKEN/VERCEL_PROJECT_ID
  // (or an offline one) never fabricates an alarm.
  if (!tip || !prod || !prod.sha) {
    say(`[deploy-drift] not checkable (branch tip ${tip ? 'ok' : 'unknown'}, prod deploy ${prod && prod.sha ? 'ok' : 'unknown'}) — no verdict recorded`);
    return 0;
  }

  // ONE decision, used by both the exit code and the sentence. When these were computed separately
  // a later tweak to either comparison could have made the process exit 0 while the recorded fact
  // said DRIFTED — callers gate on the code, humans read the fact, and they would disagree.
  const drifted = isDrifted(tip, prod.sha);
  const verdict = driftVerdict({ branch: BRANCH, tip, prodSha: prod.sha, deployedMs: Number(prod.created || 0) });

  recordFacts([{ subject: 'Seen production deploy', predicate: 'merge_vs_deploy', object: verdict, confidence: 'high' }]);
  // A drift is a trackable ticket in the brain (closed by the next in-sync check), not just a fact.
  try {
    const { ticketSources, flushTicketsToCloud } = await import('../lib/ticket-wire.mjs');
    const thing = `production deploy ${BRANCH}`;
    if (drifted) ticketSources.reportFrom({ kind: 'deploy_drift', repo: REPO, thing, title: `Production is behind ${BRANCH}`, error: verdict, ref: `${tip}`, blocked: true, source: 'scripts/deploy-drift.mjs', links: [`https://github.com/${REPO}/commit/${tip}`] });
    else ticketSources.resolveFrom({ kind: 'deploy_drift', repo: REPO, thing, ref: tip, how: verdict });
    await flushTicketsToCloud();
  } catch (e) { process.stderr.write(`[deploy-drift] ticket not recorded: ${e.message}\n`); }

  if (drifted) {
    process.stderr.write(`\n[deploy-drift] ⚠ ${verdict}\n\n`);
    return 1;
  }
  say(`[deploy-drift] ${verdict}`);
  return 0;
}

// Is this module the process entry point?
//
// A plain `argv[1] === fileURLToPath(import.meta.url)` is NOT safe here, and the failure is silent.
// brain-sync spawns this script with `new URL('./deploy-drift.mjs', import.meta.url).pathname`,
// which is PERCENT-ENCODED, and this script ships inside "/Applications/Seen Command.app" — a path
// with a space. So argv[1] arrives as ".../Seen%20Command.app/..." while fileURLToPath decodes to
// ".../Seen Command.app/...", the two never match, main() never runs, and the hourly drift check
// quietly records nothing. It would look fine in the repo checkout and be dead in the packaged app.
// The caller now passes a decoded path too; this accepts either form so neither side alone can
// silently disable the monitor.
export function isMainModule(argv1, metaUrl) {
  if (!argv1) return false;
  const self = fileURLToPath(metaUrl);
  if (argv1 === self) return true;
  try { return decodeURIComponent(argv1) === self; } catch { return false; } // malformed % escape
}

if (isMainModule(process.argv[1], import.meta.url)) {
  main().then((c) => process.exit(c)).catch((e) => {
    process.stderr.write(`[deploy-drift] check failed: ${e.message}\n`);
    process.exit(0); // a broken checker must never be mistaken for drift
  });
}
