// COMPLETION — a change is done when its behaviour is OBSERVED where it runs, not when a PR opens.
//
// The builder opened a ready-for-review PR the moment its local gate and reviewer passed, and the build
// record said `pr_ready`. Between that word and working software sat every gap that has actually bitten:
// CI still running (or red), a preview that never built, a migration merged and never APPLIED — the
// 2026-09-18 outage ran two weeks behind green health checks — and an installed app still running last
// week's code. Each is observable. None was observed.
//
// So every build that opens a PR carries a PROOF LEDGER: the conditions its task contract named, each
// `pending` until an observer sees it, `observed` with evidence, or `failed`. The PR stays open-and-ready
// (Brandon's rule: finished work must never LOOK unfinished) — what changes is that nothing here calls
// the work DONE until the ledger says `proven`. Observers never guess: "could not check" stays pending.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { config } from '../lib/config.mjs';
import { listBuilds, writeBuild } from '../lib/builds.mjs';
import { logActivity } from '../lib/activity.mjs';
import { prInfo as ghPrInfo, checkRunsFor as ghCheckRuns } from '../lib/connectors/github.mjs';
import { schemaDrift } from '../lib/schema-drift.mjs';
import { runningCode, isRunning } from '../lib/running-code.mjs';

const LABEL = {
  ci: 'CI is green on the PR head',
  preview: 'the preview deployment built and serves',
  schema: 'every database function the code calls exists in the LIVE database',
  running: 'the merged commit is the code the installed app is running',
  ui: 'the changed screen was seen rendering (a human or a browser check — never inferred)',
};

// Which conditions a build must satisfy. Decided from the repo and the contract kind — not by the coder.
export function conditionsFor({ repo = 'tool', kind = 'behaviour' } = {}) {
  const ids = ['ci', 'schema'];
  if (repo === 'product') ids.push('preview');
  if (repo === 'tool') ids.push('running');
  if (kind === 'ui') ids.push('ui');
  return ids;
}

export function initialProof(build) {
  return { state: 'awaiting', conditions: conditionsFor(build).map((id) => ({ id, label: LABEL[id], status: id === 'ui' ? 'manual' : 'pending', evidence: null, at: null })) };
}

export function proofState(conditions) {
  if (conditions.some((c) => c.status === 'failed')) return 'failed';
  if (conditions.every((c) => c.status === 'observed')) return 'proven';
  if (conditions.every((c) => c.status === 'observed' || c.status === 'manual')) return 'needs-human';
  return 'awaiting';
}

const prCoords = (url) => { const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(String(url || '')); return m ? { repo: m[1], number: Number(m[2]) } : null; };

// Observe every unsettled condition of one build. Pure in its dependencies — all I/O is injected.
export async function observeBuild(build, { prInfoFn = ghPrInfo, checkRunsFn = ghCheckRuns, schemaFn = defaultSchema, runningFn = runningCode, isRunningFn = isRunning, now = () => new Date() } = {}) {
  const proof = build.proof && Array.isArray(build.proof.conditions) ? { ...build.proof, conditions: build.proof.conditions.map((c) => ({ ...c })) } : initialProof(build);
  const pc = prCoords(build.pr);
  let pr = null;
  if (pc) { try { pr = await prInfoFn(pc); } catch { pr = null; } }
  const settle = (c, status, evidence) => { if (c.status !== status || c.evidence !== evidence) { c.status = status; c.evidence = evidence; c.at = now().toISOString(); } };

  for (const c of proof.conditions) {
    if (c.status === 'observed') continue; // observed is final; a failure may still recover (CI re-run, migration applied)
    try {
      if (c.id === 'ci') {
        if (!pr || !pc) { settle(c, 'pending', 'the PR could not be read'); continue; }
        const r = await checkRunsFn({ repo: pc.repo, sha: pr.headSha });
        if (r.state === 'passing') settle(c, 'observed', `${r.runs.length} check(s) passed on ${r.sha}`);
        else if (r.state === 'failing') settle(c, 'failed', `failing: ${r.runs.filter((x) => x.conclusion && !['success', 'neutral', 'skipped'].includes(x.conclusion)).map((x) => x.name).join(', ')}`);
        else settle(c, 'pending', r.state === 'none' ? 'no checks have reported yet' : 'checks still running');
      } else if (c.id === 'preview') {
        const st = build.preview && build.preview.state;
        if (st === 'READY') settle(c, 'observed', build.preview.url || 'preview READY');
        else if (st === 'ERROR' || st === 'FAILED') settle(c, 'failed', `preview ${st}`);
        else settle(c, 'pending', st ? `preview ${st}` : 'no preview verdict yet');
      } else if (c.id === 'schema') {
        const r = await schemaFn();
        if (!r.missing.length) settle(c, 'observed', `all ${r.checked} function(s) the code calls are served by the live database`);
        else settle(c, 'failed', `the live database is MISSING ${r.missing.map((m) => m.fn).join(', ')} — a migration is merged but not applied; every call fails in production`);
      } else if (c.id === 'running') {
        if (!pr || !pr.merged || !pr.mergeSha) { settle(c, 'pending', 'not merged yet'); continue; }
        const live = isRunningFn(pr.mergeSha, runningFn({ fetch: true }));
        if (live === true) settle(c, 'observed', `Seen Command.app is running ${pr.mergeSha.slice(0, 8)} (or a descendant)`);
        else settle(c, 'pending', live === false ? `merged as ${pr.mergeSha.slice(0, 8)}, but the installed app is still running older code — run the self-update` : 'the installed app has no readable build stamp — rebuild it once so it can say what it runs');
      }
    } catch (e) { settle(c, 'pending', `not checked: ${String(e.message).slice(0, 160)}`); } // could not check ≠ passed, ≠ failed
  }
  proof.state = proofState(proof.conditions);
  proof.checkedAt = now().toISOString();
  return proof;
}

async function defaultSchema() {
  const roots = [config.commandRepoDir(), (() => { try { return config.productRepoDir(); } catch { return null; } })()].filter((r) => r && existsSync(r));
  return schemaDrift({ roots, url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY });
}

export const proofSummary = (proof) => {
  const n = proof.conditions.filter((c) => c.status === 'observed').length;
  const open = proof.conditions.filter((c) => c.status !== 'observed').map((c) => `${c.id}: ${c.evidence || c.status}`);
  return `${proof.state.toUpperCase()} — ${n}/${proof.conditions.length} observed${open.length ? ` · open: ${open.join(' | ')}` : ''}`;
};

// Re-observe every build still waiting on proof. Transitions land in the activity ledger.
export async function sweepCompletion({ builds = null, write = writeBuild, log = () => {}, deps = {} } = {}) {
  const pending = (builds || listBuilds()).filter((b) => b.pr && (!b.proof || ['awaiting', 'failed'].includes(b.proof.state)) && ['pr_ready', 'merged'].includes(b.status));
  const results = [];
  for (const b of pending) {
    const before = b.proof ? b.proof.state : null;
    const proof = await observeBuild(b, deps);
    write(b.id, { proof });
    if (proof.state !== before) {
      log(`${b.id}: ${proofSummary(proof)}`);
      logActivity({ kind: 'proof', id: b.id, status: proof.state, summary: `${b.pr} — ${proofSummary(proof)}` });
    }
    results.push({ id: b.id, pr: b.pr, state: proof.state, was: before });
  }
  return { checked: results.length, results };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await sweepCompletion({ log: (m) => console.log(`[proof] ${m}`) });
  console.log(`[proof] re-observed ${r.checked} build(s) awaiting proof`);
  for (const x of r.results) console.log(`  ${x.state.padEnd(11)} ${x.pr}`);
}
