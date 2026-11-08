#!/usr/bin/env node
// The autonomous builder — an agent that WRITES, VERIFIES, and SHIPS real code changes.
//
// Reliability comes from the TEST GATE, not from trusting any model: the coder lane drafts a change,
// the builder applies it on a branch and runs the gate (syntax-check every touched file + the full
// test suite). Failures are fed back to the model verbatim and it retries (up to MAX_ROUNDS). Only a
// GREEN tree is ever committed, pushed, and PR'd — the builder cannot ship code that fails its gate.
//
// Repo-aware. It can build TWO repos, chosen by { repo: 'tool' | 'product' }:
//   • tool    → Seen Command's own repo (this checkout). Pure-Node gate (node --check + node --test).
//               SAFE fixes may --auto-merge (Brandon's policy).
//   • product → the Seen product repo (../seen, a Next.js app). Gate = `npm test`. ALWAYS PR-only —
//               merging there deploys prod, so that click stays human.
//   PRs always open READY (never draft): the builder only opens one when the gate is GREEN, and a
//   draft reads as "work in progress" for finished work.
//
// There is NO deterministic fallback for code: if no model lane can produce a usable change, the
// builder aborts loudly instead of shipping garbage.
//
// Safety rails: the model only ever proposes FILE CONTENTS — the builder never executes model text
// as shell. Writes are confined to the target repo's safe paths; .env, .git, and path traversal are
// rejected. The target repo must be a real, writable git checkout (not the read-only .app bundle).
//
// Usage:
//   node engine/builder.mjs "task description"            # tool repo: branch + gate + push + draft PR
//   node engine/builder.mjs "task" --repo product         # build the product repo instead
//   node engine/builder.mjs "task" --auto-merge           # + merge if green (tool repo only)
//   node engine/builder.mjs "task" --dry-run              # everything except push/PR; branch is reset
//   node engine/builder.mjs --plumb                       # no-LLM plumbing check of the gate machinery

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../lib/config.mjs';
import { codeLocally } from './coder.mjs';
import { codeAgentically, agenticEngineConfigured, exploringAgentConfigured } from './agentic-coder.mjs';
import { forgeTask } from './forge/index.mjs';
import { touchesProtected } from './policy.mjs';
import { reviewDiff } from './reviewer.mjs';
import { toolGate, productGate, fenceErrors, tscErrors, productBuildErrors, nodeRunner, memoGate } from './gate.mjs';
import { compileContract, contractAllows, contractContext } from './task-contract.mjs';
import { semanticGateFindings, semanticGateMessage } from './semantic-gate.mjs';
import { phantomPremise } from './proposal-gate.mjs';
import { executeOpenPRForBranch, executeMergePRIn, openPRsFor, issueStateFor } from '../lib/connectors/github.mjs';
import { sameWork, CONCRETE_ANCHOR } from '../lib/text.mjs';
import { createBuildWorktree, deleteBuildBranch, isolatedBuilds } from './build-worktree.mjs';
import { targetPremiseProblem } from './task-premise.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---- git helpers, bound to a specific repo checkout -------------------------
// The Chronos brain vault (memory/) lives INSIDE the product repo and legitimately churns every board
// meeting; data/ and public/ are runtime/generated. None of them are code the builder writes, so they
// must never block a build nor be wiped by its cleanup. IGNORE_DIRTY is the set the git safety skips.
// Agent-tooling dirs (.agents/.codex/.claude) join the vault + runtime dirs: they are never code the
// builder writes, and untracked ones killed every build on 2026-08-04. Belt-and-braces for the legacy
// in-checkout path — isolated builds don't consult this at all.
const IGNORE_DIRTY = /^(memory|data|public|\.agents|\.codex|\.claude)\//;
function porcelainPath(line) { const p = line.slice(3).trim(); const arrow = p.indexOf(' -> '); return arrow >= 0 ? p.slice(arrow + 4) : p; }

// Pick the ref a build branch is cut FROM. Always the PR base — fresh `origin/<base>` when reachable,
// else the local base ref, else null (offline: the caller warns and uses current HEAD as a last resort).
// It must NEVER silently resolve to the currently-checked-out feature branch: doing so is exactly how
// #243 dragged an entire in-progress branch (the memory/ vault + brain code) into a 2-file PR. Returns a
// ref string or null; gitOk(...args)->bool is injected so this is unit-testable without a real repo.
export function chooseBuildBase(gitOk, prBase) {
  if (gitOk('fetch', 'origin', prBase) && gitOk('rev-parse', '--verify', `origin/${prBase}`)) return `origin/${prBase}`;
  if (gitOk('rev-parse', '--verify', prBase)) return prBase;
  return null;
}

function gitFor(repoRoot) {
  const git = (...args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
  const gitOk = (...args) => { try { git(...args); return true; } catch { return false; } };
  // Dirty CODE files only (vault/runtime paths ignored). Empty = clean enough to build. Uses a RAW
  // (untrimmed) status — the trimming git() helper would strip the first line's leading status space
  // and shift its path parse by one char, leaking a vault file through as "code".
  const dirtyCode = () => execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n').filter(Boolean).filter((l) => !IGNORE_DIRTY.test(porcelainPath(l)));
  // Precisely undo only the files the builder touched — revert tracked, delete untracked — so a failed
  // build never touches the vault or any other change it didn't make. (Replaces broad checkout/clean/reset.)
  const undoTouched = (touched = []) => {
    for (const f of touched) {
      if (gitOk('ls-files', '--error-unmatch', f)) gitOk('checkout', '--', f); // tracked → revert
      else { try { execFileSync('rm', ['-f', join(repoRoot, f)], { stdio: 'ignore' }); } catch { /* ignore */ } } // new → remove
    }
  };
  return { git, gitOk, dirtyCode, undoTouched };
}

// ---- repo profiles: everything that differs between the tool and product repos -----------------
// Tool repo: this dependency-free pure-Node ESM checkout. Product repo: the Next.js app in ../seen.
// allowedNote is TOLD to the coder up front — a model that knows the boundaries writes inside them,
// instead of learning them one rejected edit at a time (task-31 died on a brain/mcp/ edit it was
// never told was out of bounds; brain/ is now fully in bounds — it's tool code under the same gate).
export function profileFor(repo) {
  if (repo === 'product') {
    return {
      repo: 'product',
      repoRoot: config.productRepoDir(),
      prRepo: config.githubRepo(),
      prBase: config.githubBranch(),
      // Product is TS/JS/CSS/SQL under the usual source dirs. Never touch config/lockfiles/env.
      safePath: /^(app|api|lib|components|src|scripts|hooks|utils|styles|public\/[\w\-/.]+)\/[\w\-/.]+\.(ts|tsx|js|jsx|mjs|css|sql|md|json)$/,
      exclude: ['node_modules', '.git', '.next', 'dist', 'out', 'coverage', '.DS_Store', 'memory'],
      maxFiles: 700,
      gate: productGate,
      canAutoMerge: false, // merging product = prod deploy → always human
      stack: 'a Next.js 15 / React 19 / TypeScript app (App Router; api/*.js are Vercel serverless). Match the surrounding style.',
      allowedNote: 'You may ONLY create/edit files under app/, api/, lib/, components/, src/, scripts/, hooks/, utils/, styles/, or public/. NEVER touch config files, lockfiles, .env, supabase/migrations, or node_modules.',
    };
  }
  return {
    repo: 'tool',
    repoRoot: config.commandRepoDir(),
    prRepo: config.commandRepo(),
    prBase: config.commandBranch(),
    safePath: /^(engine|lib|org|scripts|brain|app)\/[\w\-/.]+\.(mjs|js|md)$|^[\w\-.]+\.(md|json|command)$/,
    exclude: ['node_modules', '.git', 'dist', 'data', 'public', '.DS_Store'],
    maxFiles: 400,
    gate: toolGate,
    canAutoMerge: true,
    stack: 'a dependency-free pure-Node ESM repo (only node: builtins, no npm packages).',
    allowedNote: 'You may ONLY create/edit .mjs/.js/.md files under engine/, lib/, org/, scripts/, brain/, or app/ (plus top-level .md files). NEVER touch package.json, .env, .git, or node_modules.',
  };
}

export function assertWritable(p, safePath) {
  if (!safePath.test(p) || p.includes('..') || p.includes('.env') || p.startsWith('.git')) {
    throw new Error(`builder refused to write outside safe paths: ${p}`);
  }
  if (touchesProtected([p]).length) {
    throw new Error(`builder refused to rewrite ${p} (PROTECTED: owner intent / safety layer — see policy.PROTECTED_PATHS)`);
  }
}

// ---- gates: prove the change is green before anything ships ---------------------------------------
// ONE gate, in engine/gate.mjs, for every path that ships code (the builder's lanes, self-update,
// pr-rescue, base-health). These re-exports keep this module's long-standing import surface stable.
export { fenceErrors, tscErrors, productBuildErrors, nodeRunner };

// ---- effectiveness gate: comment-only "changes" never ship -----------------------------------
// A green test gate proves the change BREAKS nothing — not that it DOES anything. When a small model
// can't fulfill a task it adds comments and the gate stays green ("Upgrade Chronos SDK" shipped
// three // comments, 2026-07-10). So before committing, at least one changed line must be real code.
export function effectiveLines(text) {
  return String(text).split('\n').map((l) => l.trim())
    .filter((l) => l && !/^(\/\/|\/\*|\*\/|\*( |$)|#(?!!))/.test(l));
}
export function hasEffectiveChange(repoRoot, touched) {
  for (const f of touched) {
    let tracked = true;
    try { execFileSync('git', ['ls-files', '--error-unmatch', f], { cwd: repoRoot, stdio: 'ignore' }); } catch { tracked = false; }
    if (!tracked) { // a NEW file counts if it contains any real code at all
      try { if (effectiveLines(readFileSync(join(repoRoot, f), 'utf8')).length) return true; } catch { /* unreadable = not effective */ }
      continue;
    }
    const diff = execFileSync('git', ['diff', '--', f], { cwd: repoRoot, encoding: 'utf8' });
    const changed = diff.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+{3}|-{3})/.test(l)).map((l) => l.slice(1));
    if (effectiveLines(changed.join('\n')).length) return true;
  }
  return false;
}

// Stage EXACTLY the coding lane's touched files and commit them — the anti-#243 primitive. The
// product checkout's working tree is PERMANENTLY dirty (the brain rewrites tracked memory/ files every
// board meeting), so a broad `git add -A`/`git add .`/bare `git add` would sweep that vault churn into
// the commit WHOLESALE (PR #243: a +2213/-64 diff that should have been ~2 files). Two rules close it:
//   • stage each touched path as its OWN explicit `-- <path>` pathspec — never a broad add, and the
//     `--` also stops a filename that looks like a flag from being read as one;
//   • quote the diffstat from the REAL commit (startRef..HEAD), never from the intended-file list — so
//     the PR body can't read "small + green" while the commit shipped pollution (the #243 lie).
// An empty touched set is an honest failure (nothing to ship), never a broad add. Git-injectable so
// the staging invariant is unit-pinned against a real dirty tree.
export function commitTouched(git, { touched = [], message, startRef } = {}) {
  if (!touched.length) throw new Error('nothing to commit — the coding lane reported no touched files');
  for (const f of touched) git('add', '--', f); // ONLY these paths; never `git add -A`/`.`/bare
  git('commit', '-m', message);
  return git('diff', '--stat', `${startRef}..HEAD`).slice(0, 1500); // the REAL commit, not the wishlist
}

// A task that matches an already-OPEN builder PR is a duplicate: sibling board-meeting tasks each
// built their own realtime layer (Seen #189 + #190, both dead) because no build knew the other's PR
// existed. Exported for tests.
export function duplicateOpenPR(task, openPRs) {
  const t = String(task || '').slice(0, 140);
  // 0.4, calibrated on the real #189/#190 pair — looser than task-filing dedupe (0.5) because a
  // false positive here costs an honest retryable abort; a miss costs a parallel dead implementation.
  return (openPRs || []).find((p) => p && p.title && sameWork(t, p.title, 0.4)) || null;
}

// The PR-body line that makes GitHub close the source task the INSTANT the PR merges — no matter
// who merges it (Brandon on github.com, self-update, or --auto-merge). Cross-repo tasks use the
// owner/repo#N form (product PRs close tasks tracked on the seen-command repo).
export function closesRef(prRepo, issue) {
  if (!issue || !issue.number) return '';
  const sameRepo = issue.repo && String(issue.repo).toLowerCase() === String(prRepo).toLowerCase();
  return `\n\nCloses ${sameRepo ? `#${issue.number}` : `${issue.repo}#${issue.number}`}`;
}

// ---- entrance screen: refuse phantom and closed tasks BEFORE the coder runs ---------------------
// The competence lint stops the coder from shipping phantom CODE; this stops a phantom or dead TASK
// from ever reaching the coder — the class the lint can't see because it's in the premise, not the
// diff. #81 ("Integrate the Chronos SDK …") was CLOSED, then a build ran on it anyway (runApproval
// has no issue-state check), and the coder FABRICATED lib/chronos/client.mjs + an import so the
// premise "resolved" — the deterministic gate went green (import resolves, nothing tests it), only
// the probabilistic reviewer caught it. Two deterministic refusals close that hole:
//   • phantom premise — the task names something that does not exist (phantomPremise); building it
//     forces the coder to fabricate a stub to satisfy the impossible.
//   • closed task — the tracked issue's live state is 'closed'; a closed task is done or rejected,
//     never a build target.
// issueState is the issue's DIRECT-fetched state ('open' | 'closed' | null) — a per-issue GET, which
// is read-your-writes consistent. It replaces the old openIssues LIST-membership test: the list
// endpoint is eventually consistent, so a task filed ~1s before the build (approve→file→build) was
// often absent from it and got misread as closed — the false refusal that killed OPEN issues #86/#87.
// Only an explicit 'closed' refuses; null = unknown (fetch failed → fail open on availability,
// mirroring reviewDiff) and 'open' both build. Returns null (ok to build) or a refusal string.
export function screenBuildTask({ task, issue = null, issueState = null } = {}) {
  const phantom = phantomPremise(task);
  if (phantom) return `refusing to build: the task's premise names something that does not exist — ${phantom} A phantom task makes the coder fabricate stubs to satisfy it.`;
  if (issue && issue.number != null && issueState === 'closed') {
    return `task #${issue.number} is closed on ${issue.repo} — a closed task is done or rejected; not building it again.`;
  }
  return null;
}

// An honest REFUSAL is the builder declining a build BY DESIGN — a phantom or closed premise, or a
// duplicate of an already-open PR — where the fix is an OWNER action (fix the task / review the PR),
// not a retry. Tag those throws so the runner records status 'refused' (a calm "needs your review")
// instead of 'failed' (red "⚠ Build failed"): the owner kept misreading healthy refusals as breakage
// — yesterday's #88 duplicate-of-open-PR refusal read as a build failure. Genuine failures (red gate,
// coder exhaustion, reviewer double-reject, push/PR errors, preview_failed) stay UNtagged → still red.
export function refusalError(msg) {
  const e = new Error(msg);
  e.refusal = true;
  return e;
}

// ---- honest failure reasons: one sentence a human can act on ------------------------------------
// Auditing every build record (2026-08-13) found the recorded `error` was frequently a raw provider
// payload the owner could do nothing with, e.g.
//   run-202607190818-a1 / task-111: 'agentic coder: Anthropic API call failed — HTTP 400:
//     {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too
//     low to access the Anthropic API…' — a BILLING problem wearing a stack-trace costume;
//   run-202608032029-a1: 'agentic coder (groq): model call failed — HTTP 429: {"error":{"message":
//     "Rate limit reached for model `llama-3.3-70b-versatile`…' — a wait-and-retry, read as breakage.
// None of these are code defects and none can be fixed by re-running: they are BLOCKED builds, and
// the owner is the only one who can unblock them. So classify the raw error into a leading sentence
// that names the actual action. The raw text is NEVER discarded — it is preserved verbatim as
// `detail` and still written to the record, because a swallowed failure is worse than an ugly one.
//
// `blocked: true` marks "this build could not run for a reason outside the code" (credential, quota,
// missing lane, red base branch, absent checkout) as opposed to "the coder tried and could not do it".
const FAILURE_PATTERNS = [
  { kind: 'lane_credit', blocked: true, re: /credit balance is too low|insufficient[_ ]quota|billing[_ ]hard[_ ]limit|exceeded your current quota/i,
    reason: (p) => `the ${p} coding lane is out of credit — add funds or raise the spend cap on that account, or unset its API key to fall back to the free lanes.` },
  { kind: 'lane_rate_limit', blocked: true, re: /HTTP 429|rate[_ ]limit|too many requests/i,
    reason: (p) => `the ${p} coding lane is rate-limited right now — wait for its window to reset, or point CODER_ENGINE at another configured lane.` },
  { kind: 'lane_auth', blocked: true, re: /HTTP 40[13]|invalid[_ ]api[_ ]key|authentication[_ ]error|unauthorized|invalid x-api-key/i,
    reason: (p) => `the ${p} coding lane rejected its API key — refresh that key in .env (it is missing, expired, or revoked).` },
  { kind: 'lane_missing', blocked: true, re: /no LOCAL coder is served|no coding engine|ollama pull/i,
    reason: () => 'no coding model is available to run this build — pull a local coder (e.g. `ollama pull qwen2.5-coder:14b`) and list it in LOCAL_MODELS, or configure an API lane.' },
  { kind: 'repo_missing', blocked: true, re: /is not a git checkout/i,
    reason: () => 'the target repository is not a writable git checkout on this machine — point the repo env var at a real clone.' },
  { kind: 'base_red', blocked: true, re: /baseline tests are already red/i,
    reason: () => 'the base branch\'s own test suite is red before this task changed anything — this task is not at fault; the base branch has to go green first.' },
  { kind: 'dirty_tree', blocked: true, re: /uncommitted CODE changes|local changes that conflict/i,
    reason: () => 'the shared checkout has uncommitted changes blocking a clean branch — commit or stash them (isolated builds avoid this entirely; check BUILD_ISOLATED is not 0).' },
  { kind: 'gate_unproven', blocked: true, re: /gate unproven/i,
    reason: () => 'a required verification step is switched off on this machine (for example PRODUCT_BUILD_GATE=0), so the change could not be proven and was not shipped — turn the step back on and rebuild.' },
  { kind: 'ungrounded_task', blocked: false, re: /cannot be grounded|could not be grounded/i,
    reason: () => 'the task names no file, function or entrypoint that exists in the repo, so there was nothing to ground a coder in — sharpen the task: name what to change.' },
  { kind: 'review_blocked', blocked: true, re: /semantic review blocked/i,
    reason: () => 'no reviewer could judge whether the change does the task (no model lane answered, the reply was unusable, or review is switched off), so it was not shipped — bring a reviewer lane back (a hosted key or a local model) and rebuild.' },
  { kind: 'reviewer_reject', blocked: false, re: /reviewer rejected the change twice/i,
    reason: () => 'the coder produced a change twice that the reviewer judged did not actually do the task — this one needs a human to write or to sharpen the task.' },
  { kind: 'coder_exhausted', blocked: false, re: /could not reach a green gate/i,
    reason: () => 'the coder could not get the test gate green within its round budget — the task is likely too large or too vague for one autonomous build; split it or name a concrete file to change.' },
  { kind: 'comment_only', blocked: false, re: /changed only comments/i,
    reason: () => 'the coder only changed comments, so there was nothing real to ship — if this task wants a document rather than code, route it to the deliverer.' },
  { kind: 'unsafe_path', blocked: false, re: /refused to write outside safe paths|refused to write outside the task contract|refused to rewrite/i,
    reason: () => 'the task required editing a file the builder is not allowed to touch — retarget the task, or make the change by hand if it is genuinely wanted.' },
];

// A RED BASE BRANCH is not this task's fault, and it is not a retryable build failure: every build
// against that base will die at the same gate until a human makes the base green. Two things went
// wrong with how that was reported:
//   1) it was thrown as a plain Error, so the card painted red "⚠ Build failed" and the owner read a
//      broken repo as a broken task queue (task-176, 2026-08-13 — and the same base still blocks
//      every product build today);
//   2) worse, the gate's own output was sometimes EMPTY, producing the literally unactionable
//      "baseline tests are already red — fix main first:\nTESTS: " (task-63 and task-65, 2026-07-11,
//      when the packaged app's bare PATH made the test child die with no output at all). A failure
//      message that names no failure is indistinguishable from a bug in the reporter — say so.
// So: an owner-action refusal, and never a message whose evidence section is blank.
export function baselineRedMessage(prBase, errors = []) {
  const first = String((errors || []).find((e) => String(e || '').trim()) || '').trim();
  const head = `baseline tests are already red on ${prBase} — fix ${prBase} first; this task changed nothing yet and is not the cause.`;
  if (!first) {
    return `${head}\nThe gate reported a red baseline but produced NO output — the test command probably failed to launch at all (a missing/unresolvable node or npm in this launch context), so treat this as a broken gate, not a broken test.`;
  }
  return `${head}\n${first}`;
}

// The `lane_*` verdicts accuse a MODEL PROVIDER, so they may only fire on text that actually came
// from a coding lane. Bare status codes are ambiguous — GitHub answers 403 for permissions and 429
// for its own rate limit, and diagnosing "your Anthropic key is bad" for a GitHub permissions error
// would send the owner to fix the wrong thing. Require lane context before blaming a lane.
const LANE_CONTEXT = /coder|coding|model call|API call failed|anthropic|openai|gemini|groq|cerebras|ollama|LOCAL_MODELS/i;

// Which provider a lane error came from, for a message that names the account to go fix.
export function failureProvider(text) {
  const tagged = /agentic coder \(([a-z0-9_-]+)\)/i.exec(String(text || ''));
  if (tagged) return tagged[1].toLowerCase();
  if (/anthropic/i.test(text)) return 'Anthropic';
  if (/openai/i.test(text)) return 'OpenAI';
  if (/gemini|google/i.test(text)) return 'Gemini';
  return 'configured';
}

// Turn a thrown build error into { reason, kind, blocked, detail }. Unrecognized errors keep their
// own text as the reason — never invent a diagnosis we do not have.
export function explainBuildFailure(err) {
  const detail = String(err && err.message != null ? err.message : err ?? '').trim();
  if (!detail) {
    return { reason: 'the build failed without reporting any reason — this is a bug in the builder\'s error handling, not a verdict on the task.', kind: 'empty', blocked: false, detail: '' };
  }
  const provider = failureProvider(detail);
  const laneCtx = LANE_CONTEXT.test(detail);
  for (const p of FAILURE_PATTERNS) {
    if (p.kind.startsWith('lane_') && !laneCtx) continue; // never blame a model lane for someone else's 403
    if (p.re.test(detail)) return { reason: p.reason(provider), kind: p.kind, blocked: p.blocked, detail };
  }
  return { reason: detail.split('\n')[0].slice(0, 300), kind: 'unknown', blocked: false, detail };
}

// ---- coding lane routing -----------------------------------------------------
// THREE coders sit behind the builder, and the TASK SHAPE picks which leads. FORGE (engine/forge/) is
// the OWNED engine — free by construction, structured (plan → best-of-N verified steps → layered
// verify → brain lessons) — and leads feature-shaped work; its failure falls DOWN the ladder to:
//   • the PATCH-CODER (engine/coder.mjs) — retrieval + one-shot SEARCH/REPLACE on a local model; superb
//     at a targeted fix that names a concrete anchor, and it EXHAUSTED on all four whole-feature tasks
//     (#93-#96 — 8-round deaths / stub PRs).
//   • the AGENTIC CODER (engine/agentic-coder.mjs) — a frontier model looping over tools (ground → plan →
//     implement multi-file → verify → finish); built for exactly those feature-scale changes.
// generateChange chooses and runs the lane, with a fallback ladder, and is exported + fully injectable
// (patchFn/agenticFn) so the routing is unit-pinned without git/LLM/PR side effects. Routing table:
//   feature-shaped (no CONCRETE_ANCHOR) + agenticOk → AGENTIC first; a NON-budget agentic error falls
//     back to the patch-coder; a BUDGET stop is honest and re-thrown (don't burn the patch-coder on a
//     whole feature it already can't do).
//   anchored task, or no agentic lane → PATCH-CODER first; on its exhaustion ("could not reach a green
//     gate") AND agenticOk → ONE agentic RESCUE before aborting.
//   CODER_AGENTIC=0 or no Anthropic key → agenticOk false → patch-coder only, always (today's behavior).
// The reviewer + every downstream gate are UNCHANGED — whichever lane wins, its result flows through the
// same reviewDiff/commit/PR/pr-status pipeline.
export async function generateChange({ task, agenticOk, forgeOk = false, correction = false, extraContext = '', patchFn, agenticFn, forgeFn, onEvent, onLaneReset, localOk = true } = {}) {
  const say = (m) => { if (typeof onEvent === 'function') { try { onEvent(m); } catch { /* ignore */ } } };
  // An UNGROUNDED task (the contract found no file, symbol or entrypoint) goes to the exploring agent or
  // nowhere. A local model handed one picks its own files — runBuild refuses before this when no agent exists.
  if (!localOk) {
    if (!(agenticOk && typeof agenticFn === 'function')) throw new Error('this task could not be grounded and no exploring coding engine is available');
    say('[builder] ungrounded task → exploring agentic lane only (local lanes need a grounded contract)');
    return await agenticFn(extraContext);
  }
  const reset = () => { if (typeof onLaneReset === 'function') { try { onLaneReset(); } catch { /* ignore */ } } };
  const featureShaped = !CONCRETE_ANCHOR.test(String(task || ''));
  // A semantic reviewer rejection means the first lane produced code that passed tests but did not do
  // the job. Re-running the same weak lane is exactly the costly loop task #147 hit. Start the clean
  // correction attempt on the agentic coder (full repo exploration), then Forge, and only fall back to
  // the patch lane when neither stronger option can run.
  if (correction) {
    if (agenticOk && typeof agenticFn === 'function') {
      say('[builder] reviewer rejection → stronger agentic correction lane');
      try { return await agenticFn(extraContext); }
      catch (e) {
        if (/agentic budget exhausted/.test(e.message)) throw e;
        say(`[builder] agentic correction could not finish (${String(e.message).slice(0, 120)})`);
        reset();
      }
    }
    if (forgeOk && typeof forgeFn === 'function') {
      say('[builder] reviewer rejection → FORGE correction lane');
      try { return await forgeFn(extraContext); }
      catch (e) { say(`[builder] forge correction could not finish (${String(e.message).slice(0, 120)})`); reset(); }
    }
    say('[builder] stronger correction lanes unavailable — retrying the patch-coder with reviewer feedback');
    return await patchFn(extraContext);
  }
  // FORGE — the OWNED engine (plan → best-of-N verified steps → layered verify → lessons) — leads on
  // feature-shaped work: it is the free, structured lane built exactly for multi-file changes, and its
  // failure falls DOWN the ladder (agentic → patch), never up to a paid one.
  if (forgeOk && featureShaped && typeof forgeFn === 'function') {
    say('[builder] feature-shaped task → FORGE (the owned engine) first');
    try { return await forgeFn(extraContext); }
    catch (e) {
      say(`[builder] forge could not finish (${String(e.message).slice(0, 140)}) — falling down the lane ladder`);
      reset();
    }
  }
  if (agenticOk && featureShaped) {
    say('[builder] feature-shaped task (no concrete anchor) → agentic coder lane');
    try { return await agenticFn(extraContext); }
    catch (e) {
      if (/agentic budget exhausted/.test(e.message)) throw e; // honest budget stop → abort, never silently retry a feature on the patch-coder
      say(`[builder] agentic lane errored (${String(e.message).slice(0, 120)}) — falling back to the patch-coder`);
      reset();
      return await patchFn(extraContext);
    }
  }
  try { return await patchFn(extraContext); }
  catch (e) {
    const exhausted = /could not reach a green gate/.test(e.message);
    if (exhausted && forgeOk && typeof forgeFn === 'function') {
      say('[builder] patch-coder exhausted — FORGE rescue attempt');
      reset();
      try { return await forgeFn(extraContext); }
      catch (fe) { say(`[builder] forge rescue failed too (${String(fe.message).slice(0, 120)})`); reset(); }
    }
    if (exhausted && agenticOk) {
      say('[builder] one agentic rescue attempt');
      reset();
      return await agenticFn(extraContext);
    }
    throw e;
  }
}

// ---- the build loop ----------------------------------------------------------
// Code generation is delegated to a coding lane chosen by task shape (generateChange, above) — the
// local patch-coder for anchored fixes, the agentic loop for feature-scale work. runBuild owns the
// git/branch/gate/PR machinery around it, identically for both lanes.
// `issue` ({repo, number}) is the tracked task this build serves — wired into the PR so merging closes it.
// Returns { ok, pr?, number?, merged?, dryRun?, summary, touched, engine, repo }.
// `seams` ({ generateFn, reviewFn, gate }) exist ONLY so the wiring between the lanes, the reviewer and
// the commit boundary can be unit-pinned without a model or a network — a guard that is green in its own
// test and ignored by its caller is this repo's recurring failure. Production callers pass none.
export async function runBuild({ task, repo = 'tool', autoMerge = false, dryRun = false, onEvent, issue = null, seams = {} } = {}) {
  if (!task) throw new Error('runBuild needs a task description');
  const P = profileFor(repo);
  const { repoRoot, prRepo, prBase, safePath, canAutoMerge, stack } = P;
  const rawGate = seams.gate || P.gate;
  const generate = seams.generateFn || generateChange;
  const review_ = seams.reviewFn || reviewDiff;
  const { git, gitOk, dirtyCode, undoTouched } = gitFor(repoRoot);
  const say = (m) => { console.log(m); if (typeof onEvent === 'function') { try { onEvent(m); } catch { /* ignore */ } } };

  // The target must be a real, writable git checkout — not the read-only packaged .app bundle.
  if (!gitOk('rev-parse', '--is-inside-work-tree')) {
    throw new Error(`${repoRoot} is not a git checkout — set ${repo === 'product' ? 'SEEN_PRODUCT_REPO_DIR' : 'SEEN_COMMAND_REPO_DIR'} to a writable clone`);
  }
  // Screen the task itself before cutting a branch: a phantom premise or a CLOSED tracked issue must
  // never reach the coder — it fabricates a stub to satisfy the impossible (the closed-#81 route). The
  // issue-state check runs only when an issue is threaded through, by DIRECT per-issue GET
  // (issueStateFor) — read-your-writes consistent. This replaces the old issuesFor LIST fetch, whose
  // eventual consistency omitted a just-filed issue for seconds: approve→file→build fires the build
  // ~1s after filing, so OPEN issues #86/#87 were misread as absent-from-list and falsely refused as
  // "closed". On any fetch failure issueStateFor returns null (unknown → fail open, mirroring
  // reviewDiff), so a GitHub outage can't block honest builds. The phantom check needs no network.
  const issueState = issue ? await issueStateFor(issue.repo, issue.number).catch(() => null) : null;
  const refusal = screenBuildTask({ task, issue, issueState });
  if (refusal) throw refusalError(refusal); // honest refusal (phantom/closed) → 'refused', not red 'failed'
  // ISOLATED builds (default) never read the shared checkout's cleanliness — the build happens in its
  // own worktree, so uncommitted work there is simply none of the builder's business. The legacy
  // in-checkout path (BUILD_ISOLATED=0) still refuses to build on a dirty tree, as it must.
  const isolated = isolatedBuilds();
  if (!isolated) {
    const dirty = dirtyCode();
    if (dirty.length) throw new Error(`working tree has uncommitted CODE changes at ${repoRoot} — commit or stash first:\n${dirty.slice(0, 8).join('\n')}`);
  }
  autoMerge = autoMerge && canAutoMerge; // never auto-merge the product repo

  // Never build a parallel implementation of work that already has an open PR — review that instead.
  if (!dryRun) {
    let dup = null;
    try { dup = duplicateOpenPR(task, await openPRsFor(prRepo)); } catch { /* PR list unreachable → proceed */ }
    if (dup) throw refusalError(`duplicate of open PR #${dup.number} ("${String(dup.title).slice(0, 80)}") — review/merge that PR instead of building the same work again`); // honest refusal → 'refused', not red 'failed' (the #88 misread)
  }

  const slug = task.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const branch = `exec/build-${slug}-${Date.now().toString(36)}`;
  const startBranch = git('rev-parse', '--abbrev-ref', 'HEAD');
  // Cut the work branch from the PR BASE — never from whatever branch a checkout happens to sit on
  // (#243's pollution). ISOLATED: that base becomes a private worktree, so the shared checkout is
  // never switched and its state can never block or contaminate the build.
  const base = chooseBuildBase(gitOk, prBase);
  let workRoot = repoRoot;      // where the build actually happens
  let worktree = null;          // the isolated worktree handle (null on the legacy path)
  if (isolated) {
    worktree = createBuildWorktree(repoRoot, { base, branch }); // throws honestly if git refuses
    workRoot = worktree.dir;
    say(`[builder] ${repo} repo · isolated worktree off ${base || 'HEAD'} · branch ${branch}`);
  } else if (base) {
    // Legacy in-checkout path: if local modifications conflict with base, git refuses the switch.
    // FAIL HONESTLY — never fall back to branching off current HEAD (that is how #243 shipped).
    if (!gitOk('checkout', '-b', branch, base)) {
      throw new Error(`can't cut a clean branch off ${base} — the ${repo} checkout at ${repoRoot} has local changes that conflict with it (commit/stash them, or clean the working tree). Refusing to branch off ${startBranch}, which would drag its unrelated commits into the PR (the #243 pollution).`);
    }
    say(`[builder] ${repo} repo · branch ${branch} off ${base}`);
  } else {
    say(`[builder] ⚠ base ${prBase} not resolvable (offline?) — branching off current HEAD (${startBranch})`);
    git('checkout', '-b', branch);
  }
  // Everything below operates on the BUILD tree (the worktree when isolated, else the checkout).
  const bgit = (...args) => execFileSync('git', args, { cwd: workRoot, encoding: 'utf8' }).trim();
  const bgitOk = (...args) => { try { bgit(...args); return true; } catch { return false; } };
  const undoBuildTouched = (touchedList = []) => {
    for (const f of touchedList) {
      if (bgitOk('ls-files', '--error-unmatch', f)) bgitOk('checkout', '--', f);
      else { try { execFileSync('rm', ['-f', join(workRoot, f)], { stdio: 'ignore' }); } catch { /* ignore */ } }
    }
  };
  const startRef = bgit('rev-parse', 'HEAD'); // the base commit — the diffstat range floor (startRef..HEAD)

  // Validate explicit file targets against the isolated BASE worktree, never the user's shared
  // checkout. This preserves the isolation invariant while refusing fabricated/wrong-repo premises
  // before a gate or model call spends tokens.
  const targetProblem = targetPremiseProblem({ task, repoRoot: workRoot, safePath, repoLabel: `${repo} repo` });
  if (targetProblem) {
    if (worktree) { worktree.cleanup(); deleteBuildBranch(repoRoot, branch); }
    else { gitOk('checkout', startBranch); gitOk('branch', '-D', branch); }
    throw refusalError(`refusing to build: ${targetProblem}. This is a bad task premise, not a coder failure.`);
  }

  // THE TASK CONTRACT — ground the task in the repository before any model is asked anything. It
  // decides the proof the gate will demand, the files a local lane may write, and the structural
  // context every lane is handed. A task that grounds in nothing, with no exploring agent to hand it
  // to, stops here: that is a specification problem, and a coder cannot retry its way out of one.
  const agenticOk = process.env.CODER_AGENTIC !== '0' && agenticEngineConfigured();
  // Grounding asks for a CAPABLE exploring agent, not merely "some agentic engine" (the local Ollama loop
  // always counts as one, which would make an ungrounded task unrefusable).
  const explorerOk = seams.explorerOk !== undefined ? !!seams.explorerOk : (agenticOk && exploringAgentConfigured());
  const compiled = compileContract({ task, repoRoot: workRoot, repo, safePath, agenticOk: explorerOk });
  if (!compiled.ok) {
    if (worktree) { worktree.cleanup(); deleteBuildBranch(repoRoot, branch); }
    else { gitOk('checkout', startBranch); gitOk('branch', '-D', branch); }
    throw refusalError(`refusing to build: ${compiled.refusal}`);
  }
  const contract = compiled.contract;
  say(`[builder] contract: ${contract.kind} · ${contract.grounded ? `${contract.targets.length} target(s), ${contract.allowedFiles.length} writable file(s)` : 'UNGROUNDED → exploring agent only'}`);
  // One verdict per exact tree state, with the proof the contract demands bound in.
  const gate = memoGate(rawGate, { kind: contract.kind });
  // A LOCAL lane writes inside the contract; the exploring agent is bounded by safePath alone.
  const assertInContract = (p) => {
    assertWritable(p, safePath);
    if (!contractAllows(contract, p)) throw new Error(`builder refused to write outside the task contract: ${p} — the contract allows ${contract.allowedFiles.join(', ')}`);
  };

  const baseline = gate(workRoot, []);
  if (!baseline.green) {
    if (worktree) worktree.cleanup();
    deleteBuildBranch(repoRoot, branch);
    throw refusalError(baselineRedMessage(prBase, baseline.errors));
  }

  // Context for the local agent: what stack it's editing and where it may write (kept short — the
  // agent RETRIEVES the code).
  const stackNote = `This repo is ${stack} ${P.allowedNote}`;

  // The coding lane: agentic-first for feature-shaped tasks, patch-coder-first for anchored ones (with
  // the other as fallback/rescue). The agentic side needs the CODER_AGENTIC kill switch off AND at least
  // one engine configured — a $0 engine now counts (the local `claude` CLI, or a free groq/cerebras/
  // gemini key), not only an Anthropic key. Without any engine it's the patch-coder alone, as before.
  const forgeOk = process.env.CODER_FORGE !== '0'; // the OWNED engine — on by default, free by construction
  // Every path either lane wrote — hoisted so an abort (catch) or a lane switch can undo exactly those
  // (never the vault). All lanes report writes through onTouched into this one set.
  const allTouched = new Set();
  // The contract's structural picks lead every local lane's retrieval, ahead of lexical matches.
  const priorityFiles = contract.grounded
    ? [...new Set([...contract.targets.filter((t) => t.exists).map((t) => t.path), ...Object.values(contract.structure).flatMap((n) => [...n.consumers, ...n.tests])])]
    : [];
  const patchFn = (extraContext) => codeLocally({
    task, repoRoot: workRoot, gate, extraContext, priorityFiles,
    assertWritable: assertInContract, onEvent: say, onTouched: (p) => allTouched.add(p),
  });
  const agenticFn = (extraContext) => codeAgentically({
    task, repoRoot: workRoot, gate, extraContext,
    assertWritable: (p) => assertWritable(p, safePath), onEvent: say, onTouched: (p) => allTouched.add(p),
  });
  const forgeFn = (extraContext) => forgeTask({
    task, repoRoot: workRoot, gate, extraContext, priorityFiles,
    assertWritable: assertInContract, onEvent: say, onTouched: (p) => allTouched.add(p),
  });
  try {
    // The chosen coding lane returns only on a GREEN gate. Then a STRONGER model reviews the diff
    // against the task (does it do the thing? is everything real?) — a rejection reverts the attempt
    // and re-runs the coder WITH the named defects; two rejections abort honestly. This layer, and
    // every gate below it, is identical whichever lane produced the change (the theater-PR guard #73/#74).
    let result = null; let review = null; let reviewNote = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      result = await generate({
        task, agenticOk, forgeOk, correction: attempt > 1, extraContext: `${stackNote}${contractContext(contract)}${reviewNote}`, patchFn, agenticFn, forgeFn, onEvent: say,
        localOk: contract.grounded, contract,
        workRoot, gate, assertWritable: assertInContract, // read only by a seams.generateFn (the eval harness's scripted lane); generateChange ignores them
        onLaneReset: () => { undoBuildTouched([...allTouched]); allTouched.clear(); },
      });
      // DETERMINISTIC FIRST. The gate above proves the change breaks nothing; it never proves the
      // change does anything, so an empty file reaches the reviewer clean and burns a full model
      // round to be told "the new file is empty". semanticGateFindings sees that for free. Its
      // findings feed the SAME retry loop as a reviewer rejection, so the coder is taught the same
      // way — and on the second strike the failure reason names them (gap #2, 10 real failures).
      // "New" = not tracked in the branch this build was cut from. git is the only reliable source:
      // the coder lanes do not report which files they created, and existsSync says yes for every
      // file in the worktree. An unrunnable git check reports NOT-new, so an unknown never becomes a
      // rejection.
      const isNewFile = (p) => {
        try { execFileSync('git', ['ls-files', '--error-unmatch', p], { cwd: workRoot, stdio: 'ignore' }); return false; }
        catch (e) { return e && e.status === 1; }
      };
      const semantic = semanticGateFindings({
        touched: result.touched || [],
        readFile: (p) => readFileSync(join(workRoot, p), 'utf8'),
        isNew: isNewFile,
      });
      if (semantic.length) {
        const msg = semanticGateMessage(semantic);
        say(`[builder] SEMANTIC GATE rejected attempt ${attempt} (before review): ${semantic.map((f) => f.rule).join(', ')}`);
        undoBuildTouched([...allTouched]); allTouched.clear();
        if (attempt === 2) throw new Error(`the reviewer rejected the change twice — needs a human:\n${msg}`);
        reviewNote = `\n\nTHE CHANGE DID NOT DO THE WORK — fix these before anything else:\n${msg}`;
        continue;
      }
      // VERIFY, don't trust. Every lane promises to return only on a green gate; the builder now checks.
      // memoGate makes this free when the lane was honest (same tree state → the remembered verdict) and
      // decisive when it was not (it returned without gating, or kept editing after it did).
      const final = gate(workRoot, result.touched || []);
      if (!final.green) throw new Error(`coder could not reach a green gate — the ${result.engine || 'coding'} lane returned a change the gate rejects:\n${(final.errors || []).join('\n').slice(0, 1800)}`);
      if ((final.unproven || []).length && !dryRun) {
        undoBuildTouched([...allTouched]); allTouched.clear();
        throw new Error(`gate unproven: ${final.unproven.join('; ')}. The change is green on every step that ran, but a required step was switched off, so it was NOT shipped.`);
      }
      // Deterministic, free, and terminal — so they run BEFORE a model round is spent. (They used to
      // run after the reviewer accepted; an empty or comment-only change has nothing to review.)
      assertShippableChange(workRoot, result.touched || []);
      review = await review_({ task, repoRoot: workRoot, touched: result.touched, log: say });
      // BLOCKED ≠ REJECTED. No verdict could be rendered (no lane, garbage, review disabled, diff too
      // large): the coder did nothing wrong, so a retry would only burn a second build to hit the same
      // wall. Nothing vouched for this change, so it never ships — with ONE exception: a dry run pushes
      // nothing, and CODER_REVIEW=0 exists precisely to exercise the plumbing without a model.
      if (review.blocked) {
        if (dryRun && review.engine === 'disabled') { say('[builder] semantic review disabled — dry run only, nothing will be pushed'); break; }
        undoBuildTouched([...allTouched]); allTouched.clear();
        throw new Error(`semantic review blocked: ${review.blocked}. The change passed the test gate but nothing judged whether it does the task, so it was NOT shipped.`);
      }
      // INDEPENDENT review. When every hosted lane is down the reviewer falls back to the local model — which
      // may be the SAME model that wrote the change. Its approval is then the author agreeing with itself,
      // not a second opinion (on the first real-model run the 32B coder's change was judged by the 32B coder,
      // wrongly). An approval from the author's own engine does not ship; a REJECTION from it still teaches
      // the retry, which costs nothing. REVIEW_SAME_MODEL_OK=1 opts a strictly-local setup back in, knowingly.
      if (review.ship && sameEngine(review.engine, result.engine) && process.env.REVIEW_SAME_MODEL_OK !== '1') {
        undoBuildTouched([...allTouched]); allTouched.clear();
        throw new Error(`semantic review blocked: the only reviewer available (${review.engine}) is the same model that wrote the change, so its approval is not an independent review. The change passed the gate but was NOT shipped — bring a hosted reviewer lane back, or set REVIEW_SAME_MODEL_OK=1 to accept same-model review.`);
      }
      if (review.ship) { if (attempt > 1) say('[builder] reviewer accepted the corrected attempt ✓'); else if (review.engine !== 'disabled') say(`[builder] reviewer (${review.engine}) accepted the diff ✓`); break; }
      say(`[builder] REVIEWER (${review.engine}) rejected attempt ${attempt}: ${review.defects.join(' · ').slice(0, 300)}`);
      undoBuildTouched([...allTouched]); allTouched.clear();
      if (attempt === 2) throw new Error(`the reviewer rejected the change twice — needs a human:\n${review.defects.join('\n')}`);
      reviewNote = `\n\nA SENIOR REVIEWER REJECTED the previous attempt for these defects — do not repeat them:\n${review.defects.map((d) => `- ${d}`).join('\n')}`;
    }
    const touched = result.touched || [];
    assertShippableChange(workRoot, touched); // already proven inside the loop; re-asserted at the commit boundary
    // Stage + commit EXACTLY the touched files and take the diffstat from the REAL commit — never a
    // broad add and never the intended-file list (both are how #243 lied). commitTouched is exported +
    // git-injectable so this invariant is unit-pinned against a real dirty tree.
    let stat;
    try {
      stat = commitTouched(bgit, {
        touched,
        message: `${commitSubject(result.summary, task)}\n\n${result.summary && result.summary !== commitSubject(result.summary, task) ? `${String(result.summary).slice(0, 1200)}\n\n` : ''}Built autonomously by the Seen Command local coding agent (retrieval + diff edits, test-gated).\n\nCo-Authored-By: Seen Command builder <noreply@seenjobs.io>`,
        startRef,
      });
    } catch (e) { throw new Error(`commit failed: ${String(e.stderr || e.stdout || e.message).slice(0, 300)}`); }
    if (dryRun) {
      if (worktree) { worktree.cleanup(); deleteBuildBranch(repoRoot, branch); }
      else { git('checkout', startBranch); git('branch', '-D', branch); }
      return { ok: true, dryRun: true, repo, summary: result.summary, touched, engine: result.engine, stat, contract };
    }
    // Push with the GitHub token directly — don't depend on the repo's local git credential helper
    // (the product checkout has none, so `git push origin` prompts for a password and fails headless).
    const token = config.githubToken();
    const pushTarget = token ? `https://x-access-token:${token}@github.com/${prRepo}.git` : 'origin';
    try { bgit('push', pushTarget, `HEAD:refs/heads/${branch}`); }
    catch (e) { throw new Error(`push failed: ${String(e.message).split(token || '\u0000').join('***')}`); } // never leak the token
    // The diffstat in the PR body was already computed from the REAL commit (commitTouched, above) —
    // startRef..HEAD, the one commit we just made — never from the intended-file list, so the body can
    // never claim a small, clean diff while the commit shipped more (the #243 lie).
    const pr = await executeOpenPRForBranch({ repo: prRepo, head: branch, base: prBase,
      title: commitSubject(result.summary, task),
      // Never a draft: the builder only opens a PR when the work is DONE (gate green), and a draft
      // reads as "work in progress" on GitHub (Brandon, 2026-07-10). The human gate on the product
      // repo is the MERGE button itself — product PRs are still never auto-merged.
      draft: false,
      body: `**Task:** ${task}\n\nBuilt autonomously by the coding agent — full test suite GREEN before push${autoMerge ? '' : '; ready to merge (merging is the human step)'}.\n\n### Proven before this PR opened\n${contract.proof.map((x) => `- ${x}`).join('\n')}\n- an independent semantic review approved the whole diff (it fails closed)\n\n### Still to be OBSERVED before this is done\n${contract.completion.map((x) => `- ${x}`).join('\n')}\n\n### What changed\n\`\`\`\n${stat}\n\`\`\`\n\n🤖 Seen Command builder (${result.engine})${closesRef(prRepo, issue)}` });
    let merged = false;
    if (autoMerge) { try { await executeMergePRIn({ repo: prRepo, number: pr.number }); merged = true; } catch (e) { say(`[builder] auto-merge failed (${e.message}) — PR stays open`); } }
    if (worktree) worktree.cleanup(); else git('checkout', startBranch);
    if (merged) gitOk('pull', 'origin', prBase);
    return { ok: true, pr: pr.url, number: pr.number, merged, repo, summary: result.summary, touched, engine: result.engine, contract };
  } catch (e) {
    // abort cleanly: undo the builder's own edits precisely (the vault + runtime dirs are left intact),
    // return to the starting branch, and drop the work branch. No broad checkout/clean/reset that could
    // wipe uncommitted brain data living in the repo.
    undoBuildTouched([...allTouched]);
    if (worktree) { worktree.cleanup(); deleteBuildBranch(repoRoot, branch); }
    else { gitOk('checkout', startBranch); gitOk('branch', '-D', branch); }
    throw e;
  }
}

// Same underlying model? Engine labels differ by lane ('local:qwen2.5-coder-32b', 'qwen2.5-coder:32b',
// 'agentic:ollama:qwen2.5-coder:32b') — compare the model name, normalised.
export function sameEngine(a, b) {
  const norm = (x) => String(x || '').toLowerCase().split(/[:/]/).filter((p) => !['local', 'agentic', 'ollama', 'hosted', 'unparseable'].includes(p)).join('').replace(/[^a-z0-9.]/g, '');
  const A = norm(a); const B = norm(b);
  return !!A && !!B && A === B;
}

// The COMMIT SUBJECT / PR TITLE. A lane returns free text, and an agentic lane's is prose: the last line
// of one agent's report became PR Seen#293's title ("- No brain/memory write-back: the `brain` MCP server
// failed to connect this session (credential denied)."). A subject is one short imperative line — so take
// the first line that can BE one, and otherwise say what the task was. Never prose, never a bullet.
export function commitSubject(summary, task, { max = 72 } = {}) {
  const fallback = String(task || '').split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, max) || 'autonomous change';
  for (const raw of String(summary || '').split('\n')) {
    const line = raw.trim()
      .replace(/^SUMMARY:\s*/i, '')
      .replace(/^[-*•>#]+\s*/, '')          // a bullet or heading marker is a report, not a subject
      .replace(/^\*\*(.+?)\*\*:?\s*/, '$1: ') // **Scope:** … → Scope: …
      .replace(/\s+/g, ' ')
      .trim();
    if (!line || line.length < 8) continue;
    if (raw.trim().startsWith('-') || raw.trim().startsWith('*')) continue; // the Seen#293 shape
    if (/^(no |none|n\/a|note:|caveat:|warning:|i |i'|here'|this (pr|change) )/i.test(line)) continue;
    if (/\b(mcp|credential denied|failed to connect|not verified|could not)\b/i.test(line)) continue;
    return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
  }
  return fallback;
}

// The change must be a REAL change before anything else looks at it. Throws the terminal, honest reason.
//   • An EMPTY touched set must NEVER reach a git command with an empty pathspec: `git status
//     --porcelain --` (and a broad `git add`) treat an empty pathspec as "EVERYTHING", which would sweep
//     the permanently-dirty vault (memory/) into the commit — the Seen #243 pollution.
//   • A green gate with an EMPTY diff means the model's edits canceled out — abort honestly instead of
//     letting `git commit` die with "nothing to commit" (the failure mode Brandon hit from the app).
export function assertShippableChange(workRoot, touched = []) {
  if (!touched.length) throw new Error('the coding lane reported no touched files — nothing to ship');
  const netDiff = execFileSync('git', ['status', '--porcelain', '--', ...touched], { cwd: workRoot, encoding: 'utf8' }).trim();
  if (!netDiff) throw new Error('the edits produced no net change to the files — nothing to ship');
  if (!hasEffectiveChange(workRoot, touched)) {
    throw new Error('the edits changed only comments — nothing effective to ship (if this task wants a document/plan rather than code, it belongs to the deliverer)');
  }
}

// ---- plumbing self-check (no LLM, no network): prove branch/gate/reset works --
async function plumb() {
  const repoRoot = config.commandRepoDir();
  const { git, gitOk } = gitFor(repoRoot);
  if (git('status', '--porcelain')) throw new Error('dirty tree');
  const branch = `exec/plumb-${Date.now().toString(36)}`;
  git('checkout', '-b', branch);
  try {
    const target = 'lib/paths.mjs';
    writeFileSync(join(repoRoot, target), readFileSync(join(repoRoot, target), 'utf8') + '\n// plumb-check\n');
    const g = toolGate(repoRoot, [target]);
    if (!g.green) throw new Error('gate red on a comment-only change?!');
    console.log('[plumb] gate GREEN on trial change ✓');
    git('checkout', '--', '.');
    // now prove the gate actually catches breakage
    writeFileSync(join(repoRoot, target), 'this is not javascript {{{');
    const bad = toolGate(repoRoot, [target]);
    if (bad.green) throw new Error('gate FAILED to catch a syntax error!');
    console.log('[plumb] gate catches breakage ✓');
  } finally {
    git('checkout', '--', '.'); gitOk('clean', '-fd'); git('checkout', 'main'); gitOk('branch', '-D', branch);
  }
  console.log('[plumb] machinery verified — branch, gate, revert all work.');
}

// ---- CLI ---------------------------------------------------------------------
const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const repoArg = args.includes('--repo') ? args[args.indexOf('--repo') + 1] : 'tool';
  try {
    if (args.includes('--plumb')) { await plumb(); }
    else {
      const task = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--repo').join(' ');
      const r = await runBuild({ task, repo: repoArg, autoMerge: args.includes('--auto-merge'), dryRun: args.includes('--dry-run') });
      console.log(JSON.stringify(r, null, 2));
    }
  } catch (e) { console.error(`[builder] ${e.message}`); process.exit(1); }
}
