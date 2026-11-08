// Forge implementer — the best-of-N VERIFIED implementation loop.
//
// This is the module that makes a small local model behave frontier-grade: never trust one sample.
// For a single small step it draws up to N candidate patches; each candidate is APPLIED to the real
// tree and then VERIFIED by the caller's gate. The FIRST green candidate wins and its edits stay in
// the tree; a red candidate is reverted PRECISELY (only the paths it touched) and its failure — an
// unmatched SEARCH, an off-limits path, a red verify — is quoted back into the NEXT candidate's
// prompt as feedback, so every draw is smarter than the last. The model's claim of success never
// decides anything here — only verification does — which is exactly Brandon's requirement: broken
// work must be structurally unable to ship, no matter how confident the model that wrote it was.
//
// Division of labor inside Forge: the planner slices a task into small steps, THIS module lands one
// step green, the verifier supplies the richer `verify` the orchestrator threads through. Everything
// external (model, verify, path policy, git/exec) is injectable so tests run with zero network.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEdits, applyEdits, stripCodeFence } from '../coder.mjs';
import { reason } from '../../lib/llm.mjs';

// Same framing coder.mjs gives its model (its SYSTEM is module-local, not exported — this copy exists
// for the same reason theirs does): a model told to be minimal and format-only stays parseable; a
// model allowed prose drifts into markdown fences and burns candidates on unparseable replies.
const SYSTEM = 'You are a precise senior engineer editing a real repository. You make MINIMAL, correct changes. '
  + 'You ONLY output edit blocks in the exact format given — never prose, never whole files, never markdown fences.';

// The SEARCH/REPLACE protocol — kept in lockstep with coder.mjs parseEdits. parseEdits is the ONE
// tolerant parser every Forge candidate flows through, and this text teaches exactly the canonical
// shapes it extracts (*** FILE:/NEWFILE: headers, <<<<<<< SEARCH|CONTENT, =======, >>>>>>> REPLACE|END).
// If parseEdits ever changes its markers this constant must move with it — the round-trip test pins
// that a reply written in THIS format parses through the REAL parseEdits, so drift breaks a test, not
// a build. (coder.mjs's PROTOCOL is module-local, hence this owned copy of the contract.)
export const PROTOCOL = `
Respond with ONLY these blocks (no prose, no code fences):

*** SUMMARY: <one line describing the change>

For each change to an existing file:
*** FILE: <relative/path>
<<<<<<< SEARCH
<exact, contiguous lines that currently exist — copy them verbatim, enough to be unique>
=======
<the replacement lines>
>>>>>>> REPLACE

To create a new file — or to REWRITE a small existing file whole when SEARCH anchoring keeps failing
(NEWFILE overwrites; include the COMPLETE file body, every line, not a fragment):
*** NEWFILE: <relative/path>
<<<<<<< CONTENT
<full contents>
=======
>>>>>>> END

To ADD code at the END of an existing file — the right way to add a new test to an existing *.test.mjs;
no SEARCH text is needed, so nothing can fail to match (imports the file already has are de-duplicated):
*** APPEND: <relative/path>
<<<<<<< CONTENT
<only the new code to add>
=======
>>>>>>> END

To replace ONE ENTIRE FUNCTION in a large file — the safest edit for big/template-literal files; the
engine locates the function itself, no SEARCH text needed:
*** REPLACEFN: <relative/path> :: <functionName>
<<<<<<< CONTENT
<the complete new function, from its declaration line to its closing brace>
=======
>>>>>>> END

Rules: the SEARCH text must match the current file EXACTLY (whitespace included). Keep each SEARCH small and unique. Do NOT wrap anything in markdown code fences. Change only what the step needs.
WIRING: every symbol you USE must be defined or imported by THIS same reply — defining a helper in one file without adding the import where it is used is an automatic reviewer rejection.
GIANT FILES: never splice fragments inside template literals — partial edits there break the syntax. Use *** REPLACEFN with the complete rewritten function instead.`;

// ---- REPLACEFN: deterministic whole-function replacement --------------------------------------
// Attempts 7-10 proved the failure law of giant generated-string files: ANY text-splicing edit a
// local model makes inside nested template literals breaks the syntax. REPLACEFN removes splicing
// from the model's job entirely — it writes ONE complete function; WE locate the old one (definition
// regex + brace balance, the same logic that ships whole-function context chunks) and swap it. The
// only residual hazard is "is the new function itself valid", which the syntax layer answers in 100ms.
const REPLACEFN_HEAD = /^[\s#*>]*REPLACEFN\s*\**\s*:\s*([^\s:]+)\s*::\s*([A-Za-z_$][\w$]*)\s*$/;

// Extract REPLACEFN blocks from a model reply; return { fns: [{path, fn, content}], rest } where
// `rest` is the reply with those blocks removed (handed on to parseEdits for FILE/NEWFILE blocks).
export function parseReplaceFns(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const fns = []; const rest = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(REPLACEFN_HEAD);
    if (!m) { rest.push(lines[i]); continue; }
    // find the <<<<<<< opener (blank/fence lines may intervene), then capture until >>>>>>> close;
    // a ======= separator line is protocol furniture, not content.
    let j = i + 1;
    while (j < lines.length && (!lines[j].trim() || /^\s*`{3,}/.test(lines[j]))) j++;
    if (j >= lines.length || !/^\s*<{4,}/.test(lines[j])) { rest.push(lines[i]); continue; }
    const body = []; let close = -1;
    for (let k = j + 1; k < lines.length; k++) {
      if (/^\s*>{4,}/.test(lines[k])) { close = k; break; }
      if (/^\s*={4,}\s*$/.test(lines[k])) continue;
      body.push(lines[k]);
    }
    if (close === -1) { rest.push(lines[i]); continue; } // truncated — never guess
    fns.push({ path: m[1], fn: m[2], content: stripCodeFence(body.join('\n')) });
    i = close;
  }
  return { fns, rest: rest.join('\n') };
}

// Locate `fn`'s definition in `src` (function/const/let/var/window.* forms) and return the
// brace-balanced [startLine, endLine] span, or null / 'ambiguous'.
export function functionSpan(src, fn) {
  const lines = String(src).split('\n');
  const def = new RegExp(`^(export\\s+)?(default\\s+)?(async\\s+)?function\\s*\\*?\\s*${fn}\\s*\\(|^(export\\s+)?(const|let|var)\\s+${fn}\\s*=|^window\\.${fn}\\s*=|^\\s{0,4}function\\s+${fn}\\s*\\(`);
  const starts = [];
  for (let i = 0; i < lines.length; i++) if (def.test(lines[i])) starts.push(i);
  if (!starts.length) return null;
  if (starts.length > 1) return 'ambiguous';
  const start = starts[0];
  let depth = 0; let seen = false;
  for (let i = start; i < Math.min(lines.length, start + 400); i++) {
    for (const ch of lines[i]) { if (ch === '{') { depth++; seen = true; } else if (ch === '}') depth--; }
    if (seen && depth <= 0) return { start, end: i };
  }
  return null; // never balanced — refuse rather than guess
}

// Apply one REPLACEFN: splice the new function over the located span. Same failure contract as
// applyEdits — failures are feedback, never throws.
export function applyReplaceFns(repoRoot, fns, assertWritable) {
  const touched = new Set(); const failures = [];
  for (const r of fns) {
    try { assertWritable(r.path); }
    catch (err) { failures.push({ path: r.path, why: `path is OFF-LIMITS (${err.message})` }); continue; }
    const abs = join(repoRoot, r.path);
    let src;
    try { src = readFileSync(abs, 'utf8'); }
    catch { failures.push({ path: r.path, why: 'file does not exist — REPLACEFN edits an existing file (use NEWFILE to create)' }); continue; }
    if (!String(r.content).trim()) { failures.push({ path: r.path, why: `REPLACEFN ${r.fn}: empty CONTENT` }); continue; }
    const span = functionSpan(src, r.fn);
    if (span === null) { failures.push({ path: r.path, why: `REPLACEFN: function "${r.fn}" not found in ${r.path} — name it exactly as defined` }); continue; }
    if (span === 'ambiguous') { failures.push({ path: r.path, why: `REPLACEFN: "${r.fn}" is defined more than once in ${r.path} — use a SEARCH/REPLACE edit instead` }); continue; }
    const lines = src.split('\n');
    const body = String(r.content).replace(/\n+$/, '');
    const rebuilt = [...lines.slice(0, span.start), ...body.split('\n'), ...lines.slice(span.end + 1)].join('\n');
    writeFileSync(abs, rebuilt.endsWith('\n') ? rebuilt : `${rebuilt}\n`);
    touched.add(r.path);
  }
  return { touched: [...touched], failures };
}

// Precise undo of EXACTLY these paths: tracked files go back to their committed state, untracked (new)
// files are deleted. Mirrors builder.mjs gitFor().undoTouched — module-local there, not exported, so
// the semantics are reimplemented here on purpose and must stay identical: a red candidate leaves the
// tree byte-for-byte as it found it, and NOTHING outside `touched` is ever touched. No broad
// checkout/clean/reset — the product checkout's permanently-dirty vault (memory/) taught that a wide
// revert wipes data the coder never wrote. execFn is injectable so tests can spy without a real tree.
export function revertTouched(repoRoot, touched = [], { execFn = execFileSync } = {}) {
  const ok = (args) => { try { execFn('git', args, { cwd: repoRoot, stdio: 'ignore' }); return true; } catch { return false; } };
  for (const p of touched) {
    if (ok(['ls-files', '--error-unmatch', p])) ok(['checkout', '--', p]); // tracked → revert to HEAD
    else { try { execFn('rm', ['-f', join(repoRoot, p)], { stdio: 'ignore' }); } catch { /* already gone */ } } // new → remove
  }
}

// Tiny adapter, kept trivial ON PURPOSE: the builder gates speak gate(repoRoot, touched) → {green,
// errors} while implementStep speaks verify({repoRoot, touched}). This lets a caller hand the builder
// gate straight in; the real orchestrator supplies a richer verify from verifier.mjs instead.
export function focusedVerify(repoRoot, { gate } = {}) {
  return ({ repoRoot: at = repoRoot, touched = [] } = {}) => gate(at, touched);
}

// Apply-failure feedback: quote the closest REAL file text back (applyEdits attaches `closest`) so the
// next candidate copies what exists instead of re-guessing what it half-remembers. Own minimal version
// of coder.mjs's failureFeedback (module-local there, not exported) — same bounds: at most 3 failures,
// the quoted windows already capped upstream by closestWindow.
function applyFeedback(failures) {
  return failures.slice(0, 3).map((f) => (f.closest
    ? `- ${f.path}: ${f.why}. The closest ACTUAL text in the file is:\n${f.closest}\n  ^ copy your SEARCH lines from THAT text exactly.`
    : `- ${f.path}: ${f.why}`)).join('\n');
}

// Best-of-N only helps when the N draws DIFFER. A near-deterministic local model fed the identical
// prompt returns the identical patch — N identical retries verify red N identical ways. So each
// candidate index appends a one-line steer that pushes the sampler somewhere new without changing the
// task; combined with the accumulated feedback, no two candidates see the same prompt.
const VARIATIONS = [
  '', // candidate 1: the straight minimal edit — no steer needed yet
  'NOTE: a previous attempt failed. Try a DIFFERENT approach than before — anchor your SEARCH on different surrounding lines, or structure the change another way.',
  // Candidate 3 (attempt-3 lesson): when anchoring keeps failing, stop anchoring. A whole-file rewrite
  // via *** NEWFILE has NO search text to mismatch — for a small file it is the reliable last resort.
  'NOTE: previous attempts failed to match any SEARCH text. STOP using SEARCH/REPLACE for the failing file: if its CURRENT CONTENT is shown above in full, emit *** NEWFILE: <that path> with the COMPLETE corrected file body instead (NEWFILE overwrites an existing file). Keep every existing line except your minimal change.',
];
const variationFor = (n) => VARIATIONS[Math.min(n - 1, VARIATIONS.length - 1)];

// One candidate's full prompt: the task for the big picture, the STEP as the actual work order
// (title + doneMeans as the target, targetFiles as ANCHORS so the model edits where the planner
// grounded, hints as free advice), the retrieved code, then every prior failure and the per-index
// variation steer, then the protocol. Feedback goes IN the prompt — a fresh sample that can't see why
// its siblings died just dies the same way.
function buildPrompt({ task, step = {}, context, feedback, n }) {
  const anchors = [].concat(step.targetFiles || []).filter(Boolean).join(', ');
  const hints = [].concat(step.hints || []).filter(Boolean);
  return [
    `TASK: ${task}`,
    '',
    `CURRENT STEP: ${step.title || '(untitled step)'}`,
    step.doneMeans ? `DONE WHEN: ${step.doneMeans}` : '',
    anchors ? `ANCHOR FILES (your edits almost certainly belong in these): ${anchors}` : '',
    hints.length ? `HINTS:\n${hints.map((h) => `- ${h}`).join('\n')}` : '',
    context ? `\nRELEVANT CODE:\n${context}` : '',
    feedback.length ? `\nFEEDBACK FROM PRIOR FAILED ATTEMPTS (fix these; do not repeat them):\n${feedback.join('\n')}` : '',
    variationFor(n),
    PROTOCOL,
  ].filter(Boolean).join('\n');
}

// implementStep — land ONE planner step green, best-of-N. Per candidate: sample a patch, parse it,
// apply it, VERIFY it; first green wins and stays, red is reverted precisely and becomes feedback.
// Returns { touched, candidate, engine } on green; throws an honest error listing each candidate's
// first failure when all N are red — no "probably fine", no partial state left in the tree.
// localOnly mirrors the coder's default: strictly local + $0 unless CODER_ESCALATE=1 opens the hosted
// lanes (evaluated per call so a runner can flip the env between steps).
export async function implementStep({ step, task, repoRoot, context = '', reasonFn = reason,
  candidates = 3, verify, assertWritable, onEvent } = {}) {
  const say = (m) => { if (onEvent) try { onEvent(m); } catch { /* ignore */ } }; // builder's say() convention: narration must never kill a build
  const feedback = []; // accumulated across candidates — every failure teaches the next draw
  const outcomes = []; // per-candidate FIRST failure, for the honest exhaustion error
  const title = (step && step.title) || 'step';
  for (let n = 1; n <= candidates; n++) {
    say(`[implementer] step "${title}" — candidate ${n}/${candidates}`);
    const r = await reasonFn({
      deptId: 'product', competence: 'code', coder: true,
      localOnly: process.env.CODER_ESCALATE !== '1',
      maxTokens: 4000, system: SYSTEM,
      prompt: buildPrompt({ task, step, context, feedback, n }),
      fallback: '', // reason() never throws; an empty text below reads as "no valid edit blocks" and honestly consumes the candidate
      timeoutMs: 600000, // whole-file contexts + a full 32B patch ≈ 8-9min worst case; free lanes make patience free
    });
    // REPLACEFN blocks first (deterministic function swap — the giant-file lane), then the classic
    // FILE/NEWFILE blocks from whatever remains of the reply.
    const rfns = parseReplaceFns(r && r.text ? r.text : '');
    const parsed = parseEdits(rfns.rest);
    if (!rfns.fns.length && !parsed.edits.length && !parsed.newFiles.length && !(parsed.appends || []).length) {
      // Off-format reply (or no lane answered). Consuming the candidate is deliberate — a model that
      // can't hold the format twice shouldn't get infinite free retries; the variation steer + this
      // feedback give the next draw its best shot.
      say(`[implementer] candidate ${n}: no valid edit blocks — reminding the model of the format`);
      feedback.push(`- attempt ${n}: no valid edit blocks — emit ONLY the protocol format (*** FILE / SEARCH / REPLACE blocks), no prose, no code fences.`);
      outcomes.push({ n, why: 'no valid edit blocks' });
      continue;
    }
    const fnRes = applyReplaceFns(repoRoot, rfns.fns, assertWritable);
    const edRes = applyEdits(repoRoot, parsed, assertWritable);
    const touched = [...new Set([...fnRes.touched, ...edRes.touched])];
    const failures = [...fnRes.failures, ...edRes.failures];
    if (failures.length) feedback.push(`- attempt ${n}: these edit blocks did NOT apply:\n${applyFeedback(failures)}`);
    if (!touched.length) {
      // Every block missed (bad anchors / off-limits paths / no-ops). Nothing reached the tree, so
      // there is nothing to verify and nothing to revert — the candidate is spent, the failures are
      // already queued as feedback for the next one.
      // Telemetry the operator loop needs: WHAT the model tried to anchor on, not just that it missed.
      for (const f of failures.slice(0, 2)) say(`[implementer]   ✗ ${f.path}: ${String(f.why).slice(0, 80)}${f.search ? ` — tried SEARCH "${String(f.search).split('\n')[0].slice(0, 70)}"` : ''}`);
      say(`[implementer] candidate ${n}: nothing applied (${failures.length} failed block(s))`);
      outcomes.push({ n, why: `nothing applied — ${failures[0] ? `${failures[0].path}: ${failures[0].why}` : 'no blocks matched'}` });
      continue;
    }
    say(`[implementer] candidate ${n}: applied ${touched.length} file(s) → ${touched.join(', ')}`);
    // THE decision point. verify() — not the model, not the parse, not the apply — says whether this
    // candidate ships. Green means these edits STAY in the tree and we return immediately (first green
    // wins; later candidates might also be green but the step needs one landing, not a beauty contest).
    const v = await verify({ repoRoot, touched });
    if (v && v.green) {
      say(`[implementer] candidate ${n}: verify GREEN ✓ — keeping this patch`);
      return { touched, candidate: n, engine: r.engine };
    }
    const errs = ((v && v.errors) || []).slice(0, 2).map((e) => String(e).slice(0, 400)); // first 2, truncated — enough signal to steer, small enough to fit a local model
    say(`[implementer] candidate ${n}: verify red — ${(errs[0] || 'no error detail').slice(0, 160)}`);
    // Red → this candidate's edits must not contaminate the next draw. Revert EXACTLY what it touched
    // so candidate n+1 anchors its SEARCH blocks against the same original text the prompt shows.
    revertTouched(repoRoot, touched);
    say(`[implementer] candidate ${n}: reverted ${touched.join(', ')} — tree back to the pre-candidate state`);
    feedback.push(`- attempt ${n}: the change APPLIED but verification was RED. It has been REVERTED — every file is back to the ORIGINAL text shown above; start again from that text. Errors:\n${errs.map((e) => `  ${e}`).join('\n')}`);
    outcomes.push({ n, why: `verify red — ${errs[0] || 'no error detail'}` });
  }
  // All N spent, none green. Throw with each candidate's first failure so the orchestrator (and the
  // activity log) sees exactly HOW the step died — never a vague "step failed" that hides the pattern.
  throw new Error(`step "${title}": all ${candidates} candidate(s) failed verification:\n`
    + outcomes.map((o) => `  candidate ${o.n}: ${o.why}`).join('\n'));
}
