// Forge step verifier — LAYERED verification for ONE step of an owned-engine build.
//
// The whole Forge bet is that a local/free model becomes trustworthy through VERIFICATION, not
// through model quality: broken work must be structurally unable to ship. This module is that
// structure for a single step. Layers run CHEAP-FIRST and the step reds at the FIRST failure —
// a first-line fence or a syntax error costs seconds to catch, so it must never wait behind a
// multi-minute test suite + production build (the caller's full gate) to be discovered:
//
//   a. fence     — a source file beginning with ``` is a model artifact on disk (Seen #194 class).
//   b. syntax    — node --check every touched .mjs/.js (via nodeRunner, so it works on launchd's
//                  bare PATH exactly like the builder's gates do).
//   c. effective — a comment-only "change" is theater, not work (the PR #50 class): a green gate
//                  proves the change BREAKS nothing, never that it DOES anything.
//   d. gate      — the caller's FULL repo gate (tests + tsc + production build for the product
//                  repo). Its errors propagate VERBATIM so the coder can retry on the real text.
//   e. self-review (optional, probabilistic, LAST) — a model re-reads the diff against the step's
//                  own done-condition. It can only block on an EXPLICIT REJECT; unavailability
//                  (no lane, throw, empty reply) is a NOTE, never a red. That is safe HERE only
//                  because this is an inner, advisory pass: the builder's reviewDiff runs after
//                  every lane and FAILS CLOSED, so nothing ships on this step's silence.
//
// Everything side-effectful is injectable (gate, reviewFn) so tests never touch a model or the
// network; the deterministic layers run against a throwaway git repo.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fenceErrors, nodeRunner, hasEffectiveChange } from '../builder.mjs';
import { groundingFor } from '../reviewer.mjs';
import { reason } from '../../lib/llm.mjs';

// ---- layer b: syntax --------------------------------------------------------
// Same shape as the builder gates' per-file check, but standalone so verifyStep can run it BEFORE
// the full gate: a bad file reds here in ~100ms instead of after the whole suite. nodeRunner()
// (not a bare 'node') because the packaged app launches on launchd's bare PATH where 'node' is
// ENOENT — the "baseline tests are already red … TESTS: <nothing>" failure, 2026-07-10.
export function syntaxErrors(repoRoot, touched) {
  const errors = [];
  const nr = nodeRunner();
  for (const f of touched.filter((f) => /\.(mjs|js)$/.test(f))) {
    try { execFileSync(nr.bin, ['--check', join(repoRoot, f)], { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe', env: nr.env }); }
    catch (e) { errors.push(`SYNTAX ${f}:\n${String(e.stderr || e.message).slice(0, 800)}`); }
  }
  return errors;
}

// ---- the reviewable diff ----------------------------------------------------
// Minimal local version of engine/reviewer.mjs diffForReview (kept here rather than imported —
// this module's dependency surface is builder.mjs + lib/llm.mjs only). The trap it closes is the
// same one: `git diff` prints NOTHING for an untracked path, so a step whose only output is a new
// file would hand the reviewer an EMPTY diff and the self-review would judge nothing (the exact
// hole #194's stub page shipped through). Untracked files are synthesized as /dev/null-style
// all-addition hunks so every line of a new file is visible +content.
export function diffFor(repoRoot, touched = []) {
  const run = (args) => {
    try { return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' }); }
    catch (e) { return typeof e.stdout === 'string' ? e.stdout : ''; }
  };
  const tracked = []; const untracked = [];
  for (const p of touched) {
    try { execFileSync('git', ['ls-files', '--error-unmatch', '--', p], { cwd: repoRoot, stdio: 'ignore' }); tracked.push(p); }
    catch { untracked.push(p); } // --error-unmatch exits non-zero for an untracked path
  }
  const parts = [];
  if (tracked.length) { const d = run(['diff', '--', ...tracked]); if (d) parts.push(d); }
  for (const p of untracked) {
    let body = '';
    try { body = readFileSync(join(repoRoot, p), 'utf8'); } catch { continue; } // unreadable → nothing to show
    const lines = body.split('\n');
    if (lines[lines.length - 1] === '') lines.pop(); // don't fabricate a trailing +"" line
    parts.push(`--- /dev/null\n+++ b/${p}\n${lines.map((l) => `+${l}`).join('\n')}\n`);
  }
  return parts.join('');
}

// ---- the layered verifier ---------------------------------------------------
// Verify one step's touched files. Returns { green, errors, notes } — errors only when red, notes
// carry advisory context (the self-review verdict, or why it was skipped) either way. `gate` is
// the caller's FULL repo gate (repoRoot, touched) → { green, errors }; it is the expensive layer
// and therefore runs only after every cheap deterministic layer is green. `reviewFn({ diff, step })`
// is the optional model self-review; FORGE_SELF_REVIEW=0 disables it wholesale (mirroring
// CODER_REVIEW=0 on the builder's reviewer).
export async function verifyStep({ repoRoot, touched = [], step = null, gate, reviewFn = null, onEvent } = {}) {
  const say = (m) => { if (typeof onEvent === 'function') { try { onEvent(m); } catch { /* ignore */ } } };
  const notes = [];
  const red = (errors, layer) => {
    say(`[forge:verify] RED at ${layer}: ${String(errors[0] || '').split('\n')[0].slice(0, 160)}`);
    return { green: false, errors, notes };
  };

  // An empty touched set is an honest failure — there is nothing to verify, and letting it fall
  // through would red confusingly at the effectiveness layer ("comment-only" with no files).
  if (!touched.length) return red(['no touched files — the step produced nothing to verify'], 'input');

  // a. fence — deterministic, no subprocess: a source file must never begin with a ``` fence.
  const fences = fenceErrors(repoRoot, touched);
  if (fences.length) return red(fences, 'fence');

  // b. syntax — node --check per touched .mjs/.js; ~100ms per file, so a typo never waits on tests.
  const syntax = syntaxErrors(repoRoot, touched);
  if (syntax.length) return red(syntax, 'syntax');

  // c. effectiveness — at least one changed line must be real code (the PR #50 class).
  if (!hasEffectiveChange(repoRoot, touched)) {
    return red(['comment-only change — nothing effective shipped'], 'effectiveness');
  }

  // d. the FULL gate — tests (+ tsc + production build in the product repo). Errors propagate
  // VERBATIM: the retry loop feeds them straight back to the coder, and paraphrasing loses the
  // file:line anchors it needs. Awaited so an async gate works; the builder's gates are sync.
  // A STEP is a partial change: gate it with the step-level gate when the builder provides one (gate.partial
  // skips the whole-change rules — caller, biting test, route — which the finale and the builder enforce).
  const g = await (typeof gate.partial === 'function' ? gate.partial : gate)(repoRoot, touched);
  if (!g || !g.green) {
    return red(g && Array.isArray(g.errors) && g.errors.length ? g.errors : ['gate returned red with no errors'], 'gate');
  }

  // e. self-review — probabilistic, LAST, and only ever blocking on an explicit REJECT. A throwing
  // or silent reviewer is an availability problem, not a judgment: note it and hand the change on
  // (the builder's fail-closed reviewDiff is the gate that decides whether it ships). The reply is trimmed first, so "REJECT"
  // behind leading whitespace still counts; anything not starting with REJECT is advisory.
  if (reviewFn && process.env.FORGE_SELF_REVIEW !== '0') {
    let text = '';
    try { text = String((await reviewFn({ diff: diffFor(repoRoot, touched), step })) ?? '').trim(); }
    catch { text = ''; } // a crashed reviewer must never red a deterministically-green step
    if (!text) notes.push('self-review unavailable');
    else if (/^reject/i.test(text)) return red([text], 'self-review');
    else notes.push(`self-review: ${text.slice(0, 400)}`);
  }

  say('[forge:verify] all layers green ✓');
  return { green: true, errors: [], notes };
}

// ---- the model self-reviewer ------------------------------------------------
// Build a reviewFn for verifyStep backed by the LLM router. The judgment is deliberately NARROW:
// not style, not architecture — ONLY "does this diff genuinely satisfy the step's done-condition
// without faking it" (stubs, placeholders, fabricated APIs are exactly what a small coder ships
// when it can't do the real work). The first-line APPROVE/REJECT contract keeps the verdict
// machine-checkable without JSON parsing — a rambling small model that buries its verdict is
// treated as advisory, never as a block. reasonFn is injectable so tests never touch a model;
// fallback:'' means an all-lanes-dead router returns empty text → we return '' and the caller
// (verifyStep) records 'self-review unavailable' instead of guessing.
export function buildSelfReviewer(reasonFn = reason, { repoRoot = null } = {}) {
  const SYSTEM = 'You are a ruthless senior code reviewer. You judge ONLY whether a diff genuinely satisfies '
    + 'its step\'s done-condition without faking it — no stubs, no placeholder bodies, no TODO-as-work, no '
    + 'fabricated APIs. The FIRST LINE of your reply MUST be exactly APPROVE or REJECT: <specific reason>.';
  return async ({ diff, step } = {}) => {
    const done = String((step && (step.doneMeans || step.title || step.task)) || 'the step is genuinely accomplished');
    // Existence evidence (attempt-8 lesson): without repo grounding the reviewer REJECTed a call to
    // todayISO() — a real, existing helper — as "not defined anywhere". Same fix the builder's diff
    // reviewer got: git-grep counts for every identifier the diff adds, so "exists elsewhere" is a
    // fact in the prompt, not a guess.
    let evidence = '';
    if (repoRoot) { try { evidence = groundingFor(repoRoot, diff); } catch { /* evidence is best-effort */ } }
    const r = await reasonFn({
      deptId: 'product', competence: 'review', maxTokens: 500, fallback: '',
      timeoutMs: 240000, // local reviewers read a whole diff — the 20s conversational default guarantees silence
      system: SYSTEM,
      prompt: `STEP — "done" means:\n${done}\n\n`
        + `THE DIFF (new files appear as all-addition hunks against /dev/null):\n${String(diff || '').slice(0, 9000)}\n\n`
        + (evidence ? `EXISTENCE EVIDENCE (occurrences of referenced names across the WHOLE repo, this diff included): treat ANY name that appears in the repo as existing — reject as undefined ONLY a name with zero occurrences outside this diff that the diff itself does not define. Never apply a numeric threshold.\n${evidence}\n\n` : '')
        + 'Does this diff GENUINELY satisfy the done-condition, without faking it (stubs, placeholders, '
        + 'APIs that do not exist in this repo)? First line MUST be APPROVE or REJECT: <reason>.',
    });
    if (!r || r.engine === 'fallback' || !r.text) return ''; // no lane answered → unavailable, the caller notes it
    return String(r.text).trim();
  };
}
