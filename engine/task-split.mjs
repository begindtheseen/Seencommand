// task-split — when a task fails whole, retry it in PIECES, not in hope.
//
// NEXT_UPDATE.md gap #8: six real failures died as "could not reach a green gate in 6/8 rounds" —
// genuine model-capability limits, not plumbing. Retrying the whole task burns another 8 rounds on
// the same wall. The missing capability is decomposition: split the task into smaller VERIFIABLE
// steps, each one small enough that a green gate on it means something.
//
// Design rules (in order, and each one is load-bearing):
//   1. DETERMINISTIC FIRST. The split comes from the task text's own seams — numbered/bulleted
//      acceptance criteria, explicit conjunctions ("and" / "then" between imperative clauses),
//      multiple named files/routes. No model call is needed to see that a task naming three
//      deliverables is three tasks.
//   2. NO SCOPE-SHAVING, BY CONSTRUCTION. Every subtask carries the FULL original task text plus its
//      single deliverable and a "scope: ONLY this" line, and every split ends with an integration
//      subtask that re-verifies the original end to end. The union of the pieces can therefore never
//      be less than the original — a split that quietly drops a requirement is worse than no split,
//      because it converts "failed" into "succeeded at something else".
//   3. HISTORY-AWARE. The failure history (lib/failure-loop.mjs shapes) says WHERE it died. A
//      reviewer-rejection history means the coder shipped something that did nothing — so the first
//      subtask is biased toward the smallest verifiable core (make it exist and return real data,
//      tests prove it) with polish pushed last. A history that is entirely blocked-on-owner refuses
//      to split at all: pieces of a task starved of credit fail exactly like the whole.
//   4. HONEST REFUSAL. A task with no seams and no history returns subtasks: [] with the reason
//      "this task is already atomic — a split would just rename the failure". Splitting is not a
//      ritual; it only helps when there is genuinely more than one thing to verify.
//   5. The model lane (the free local claude CLI, the same binary engine/agent-chat.mjs drives) is
//      OPTIONAL, bounded, injectable, and OFF by default — enabled only by TASK_SPLIT_MODEL=1 or an
//      explicit option, and consulted only for the hard case (no textual seams, real failure
//      history). A model failure falls back to the deterministic split, never to an error: the
//      caller asked for a split, and it gets one (or an honest refusal), not a stack trace.
//
// Contract (build-runner wires to this exact shape):
//   splitTask({ task, history = [], repo = 'tool', reason = () => {} })
//     → { subtasks: [{ title, task }], reason }   // 2–4 subtasks, or [] with why not
// The `reason` argument is a progress callback (one line per decision, same idiom as onEvent in
// engine/builder.mjs); the returned `reason` is the one-sentence human verdict.

import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CONCRETE_ANCHOR } from '../lib/text.mjs';
import { toolEnv, claudeToolEnv } from '../lib/tool-env.mjs';

const clip = (v, n = 70) => {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

// ---- seam detection ---------------------------------------------------------

// Numbered / bulleted acceptance criteria — the strongest seam, because the author already did the
// decomposition. A checkbox line counts too.
function listItems(text) {
  const items = [];
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\s*(?:[-*•]|\d+[.)]|\[[ xX]\])\s+(.{3,})$/);
    if (m) items.push(m[1].trim());
  }
  return items;
}

// Imperative verbs that open a deliverable clause. Splitting on every bare "and" would shred noun
// phrases ("read and write path"), so a fragment only stands alone when it STARTS like an
// instruction; otherwise it is re-merged into the clause before it.
const VERBS = new Set([
  'add', 'append', 'block', 'build', 'cache', 'check', 'clean', 'close', 'convert', 'create',
  'delete', 'derive', 'detect', 'display', 'document', 'drop', 'emit', 'ensure', 'expose', 'extend',
  'fix', 'gate', 'guard', 'handle', 'harden', 'hook', 'implement', 'introduce', 'isolate', 'keep',
  'load', 'log', 'make', 'mark', 'migrate', 'move', 'notify', 'open', 'parse', 'point', 'polish',
  'prevent', 'probe', 'record', 'refactor', 'reject', 'remove', 'rename', 'render', 'replace',
  'report', 'return', 'route', 'run', 'save', 'serve', 'ship', 'show', 'split', 'stop', 'store',
  'style', 'support', 'surface', 'swap', 'teach', 'test', 'tidy', 'update', 'use', 'validate',
  'verify', 'wire', 'write',
]);
const startsImperative = (s) => VERBS.has(String(s).trim().toLowerCase().split(/\s+/)[0] || '');

// Conjunction seams: ";", "then", and ", and" / " and " between clauses that each read as an
// instruction. "then"/";" are hard separators; a bare "and" fragment must open with a verb to stand.
function conjunctionClauses(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  const hard = flat.split(/\s*(?:;|,?\s+and\s+then\s+|,?\s+then\s+|\.\s+[Tt]hen\s+)\s*/);
  const clauses = [];
  for (const part of hard) {
    const soft = part.split(/,?\s+and\s+/);
    for (let i = 0; i < soft.length; i++) {
      const frag = soft[i].trim();
      if (!frag) continue;
      // A fragment stands alone only if it opens with a verb AND what came before it already reads
      // as a complete instruction. Verb-ness alone is not enough: in "Harden the read and write
      // path", "write" is a verb but "write path" is the tail of a noun phrase, and the giveaway is
      // that the preceding fragment ("Harden the read") is too short to be an instruction on its
      // own. Over-splitting is the expensive direction here — it manufactures subtasks that describe
      // half a noun, and the builder then fails them one at a time.
      const prev = clauses.length ? clauses[clauses.length - 1] : '';
      const prevIsComplete = prev.split(/\s+/).filter(Boolean).length >= 4;
      if (i > 0 && clauses.length && (!startsImperative(frag) || !prevIsComplete)) {
        clauses[clauses.length - 1] += ` and ${frag}`; // not a deliverable of its own — rejoin
      } else {
        clauses.push(frag);
      }
    }
  }
  return clauses.filter((c) => c.split(/\s+/).length >= 3);
}

// Multiple named files/routes — the weakest seam (two files are often one coherent change), so it
// only fires when nothing stronger did and the task is long enough to plausibly hold several jobs.
function namedTargets(text) {
  const found = String(text).match(new RegExp(CONCRETE_ANCHOR.source, 'g')) || [];
  return [...new Set(found.map((f) => f.trim()))];
}

// ---- history reading --------------------------------------------------------

// Accepts lib/failure-loop.mjs records ({ reason, errorKind, blocked, … }) or bare strings, because
// callers hold both shapes (failureHistory() rows vs. lines already folded into a brief).
function readHistory(history) {
  const rows = (Array.isArray(history) ? history : []).map((h) =>
    (h && typeof h === 'object') ? h : { reason: String(h == null ? '' : h) });
  const reasons = rows.map((r) => `${r.errorKind || ''} ${r.reason || ''}`);
  return {
    count: rows.length,
    allBlocked: rows.length > 0 && rows.every((r) => !!r.blocked),
    blockedReason: (rows.find((r) => r.blocked) || {}).reason || null,
    reviewerRejected: reasons.some((r) => /reviewer|rejected/i.test(r)),
    greenGateExhausted: reasons.some((r) => /green gate/i.test(r)),
  };
}

// ---- ordering bias ----------------------------------------------------------

// When review is where it died, the core must land first and polish last: a reviewer rejects a
// change that DOES nothing, and polish-first splits reproduce exactly that.
const POLISH = /\b(polish|styling|style|css|colou?r|spacing|copy|wording|comments?|docs?|documentation|readme|rename|tidy|cleanup|format|animation)\b/i;
const CORE = /\b(endpoint|api|route|data|return|create|implement|exists?|probe|record|parse|serve|store|fix|write|wire)\b/i;
function coreFirst(pieces) {
  const score = (p) => (POLISH.test(p) ? 1 : 0) - (CORE.test(p) ? 1 : 0);
  return pieces.map((p, i) => ({ p, i })) // stable: index breaks ties, original order preserved
    .sort((a, b) => (score(a.p) - score(b.p)) || (a.i - b.i))
    .map((x) => x.p);
}

// ---- assembly ---------------------------------------------------------------

const CORE_FIRST_NOTE = 'PREVIOUS ATTEMPTS FAILED IN REVIEW — build the smallest verifiable core first: '
  + 'make it exist and return real data, with tests that prove it, before any polish.';

function pieceText({ task, piece, index, pieceCount, note = null }) {
  return [
    ...(note ? [note, ''] : []),
    'ORIGINAL TASK (full context — kept whole so nothing can be shaved off):',
    String(task).trim(),
    '',
    `DELIVERABLE ${index + 1} of ${pieceCount}: ${piece}`,
    'SCOPE: ONLY this deliverable. The other pieces are separate subtasks — do not attempt them '
      + 'here. A final integration subtask verifies the union equals the original, so nothing is '
      + 'lost by staying narrow.',
  ].join('\n');
}

function integrationText(task, pieceCount) {
  return [
    'ORIGINAL TASK (full context — kept whole so nothing can be shaved off):',
    String(task).trim(),
    '',
    `DELIVERABLE: INTEGRATION — the ${pieceCount} pieces above landed separately; join them and `
      + 'verify the ORIGINAL task end to end. If any piece of the original is still missing, this '
      + 'subtask restores it: the union of the split must never be less than the whole. Tests must '
      + 'exercise the combined behavior, not the pieces in isolation.',
  ].join('\n');
}

// 2–4 subtasks total, integration always last. Overflow pieces are MERGED into the third, never
// dropped — capping by discarding would be scope-shaving with extra steps.
function assemble({ task, pieces, biasCoreFirst }) {
  let capped = biasCoreFirst ? coreFirst(pieces) : [...pieces];
  if (capped.length > 3) {
    capped = [capped[0], capped[1], `${capped[2]}; plus, none dropped: ${capped.slice(3).join('; ')}`];
  }
  const subtasks = capped.map((piece, index) => ({
    title: clip(piece, 70),
    task: pieceText({
      task, piece, index, pieceCount: capped.length,
      note: biasCoreFirst && index === 0 ? CORE_FIRST_NOTE : null,
    }),
  }));
  subtasks.push({
    title: 'Integration — verify the original task end to end',
    task: integrationText(task, capped.length),
  });
  return subtasks;
}

// ---- the optional model lane ------------------------------------------------

// Same binary probe as engine/agent-chat.mjs: a bare 'claude' is ENOENT under the packaged app's
// launchd PATH, so check the usual homes. Kept local so this module stays import-light and offline.
const BIN_PATHS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
const claudeBin = () => BIN_PATHS.map((p) => join(p, 'claude')).find((f) => existsSync(f)) || 'claude';

function modelPrompt({ task, history, repo }) {
  const h = readHistory(history);
  return [
    `A ${repo}-repo coding task has failed ${h.count} time(s) and has no obvious textual seams. `
      + 'Propose 2 to 4 smaller subtasks whose UNION covers the whole original task (no scope may '
      + 'be dropped), ordered smallest-verifiable-core first.',
    'Reply with ONLY a JSON array of objects shaped {"title": "...", "task": "..."} — no prose.',
    '', 'THE TASK:', String(task).trim(),
  ].join('\n');
}

// One bounded single-shot spawn (`claude -p … --output-format json`). Every exit path resolves an
// explicit { ok:false, error } — a lane that died must never look like a lane that answered.
function runModelLane({ prompt, spawnFn = nodeSpawn, timeoutMs = 60_000 }) {
  return new Promise((resolve) => {
    const injected = spawnFn !== nodeSpawn;
    const bin = claudeBin();
    if (!injected && !existsSync(bin)) {
      resolve({ ok: false, error: 'the claude CLI is not installed on PATH — the free split lane needs it' });
      return;
    }
    let child;
    try {
      child = spawnFn(bin, ['-p', prompt, '--output-format', 'json'],
        { env: claudeToolEnv(bin, { ...process.env, BRAIN_CLIENT: process.env.BRAIN_CLIENT || 'task-split' }) });
    } catch (e) { resolve({ ok: false, error: `could not start the claude CLI: ${e.message}` }); return; }

    let out = ''; let err = ''; let settled = false; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGTERM'); } catch { /* ignore */ } }, timeoutMs);
    const finish = (code = null) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (timedOut) { resolve({ ok: false, error: `the model lane did not answer within ${Math.round(timeoutMs / 1000)}s` }); return; }
      let text = out;
      try { // --output-format json wraps the answer: { result, is_error, … }. Tolerate raw text too.
        const o = JSON.parse(out);
        if (o && o.is_error) { resolve({ ok: false, error: clip(o.result || 'the model lane reported an error', 200) }); return; }
        if (o && typeof o.result === 'string') text = o.result;
      } catch { /* not the wrapper — treat stdout as the answer itself */ }
      const m = String(text).match(/\[[\s\S]*\]/);
      if (!m) {
        resolve({ ok: false, error: code ? `the claude CLI exited ${code}${err ? `: ${clip(err, 160)}` : ' with no output'}` : 'the model answered without a JSON array of subtasks' });
        return;
      }
      let arr;
      try { arr = JSON.parse(m[0]); } catch (e) { resolve({ ok: false, error: `the model's subtask JSON did not parse: ${e.message}` }); return; }
      const pieces = (Array.isArray(arr) ? arr : [])
        .map((s) => ((s && typeof s === 'object') ? String(s.task || s.title || '') : String(s == null ? '' : s)).trim())
        .filter((s) => s.length >= 8);
      if (pieces.length < 2) { resolve({ ok: false, error: 'the model proposed fewer than 2 usable pieces' }); return; }
      resolve({ ok: true, pieces: pieces.slice(0, 4) });
    };
    child.stdout && child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr && child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ ok: false, error: `the claude CLI could not start: ${e.message}` }); } });
    child.on('close', (code) => finish(code));
    child.on('exit', (code) => finish(code));
  });
}

// ---- the public API ---------------------------------------------------------

// Options (second argument, all injectable so tests run offline):
//   model      — true forces the lane on, false forces it off; default reads TASK_SPLIT_MODEL=1,
//                which is unset in tests and in the app today, so the lane is OFF by default.
//   spawnFn    — the child_process.spawn used by the model lane (tests inject a fake).
//   timeoutMs  — model-lane bound (default 60s; it is one single-shot completion, not an agent run).
export async function splitTask(
  { task, history = [], repo = 'tool', reason = () => {} } = {},
  { model = null, spawnFn = nodeSpawn, timeoutMs = 60_000 } = {},
) {
  if (!task || !String(task).trim()) {
    // Invalid usage, not an empty verdict — per the silent-zero rule a caller bug must throw, never
    // come back shaped like "nothing to split".
    throw new TypeError('splitTask needs a non-empty task string');
  }
  const say = (line) => { try { reason(line); } catch { /* a broken progress callback must not break the split */ } };
  const h = readHistory(history);

  // A fully blocked history means the OWNER holds the fix (credit, quota, red base). Pieces of a
  // starved task starve identically — refusing here is the honest answer, seams or not.
  if (h.allBlocked) {
    const why = `all ${h.count} prior failure(s) were blocked on the owner`
      + `${h.blockedReason ? ` (${clip(h.blockedReason, 120)})` : ''} — splitting will not help; clear the blocker instead`;
    say(why);
    return { subtasks: [], reason: why };
  }

  // Deterministic seams, strongest first.
  let pieces = listItems(task);
  let seam = pieces.length >= 2 ? `${pieces.length} listed acceptance criteria` : null;
  if (!seam) {
    pieces = conjunctionClauses(task);
    seam = pieces.length >= 2 ? `${pieces.length} conjoined deliverables` : null;
  }
  if (!seam) {
    const targets = namedTargets(task);
    if (targets.length >= 2 && String(task).trim().split(/\s+/).length >= 15) {
      pieces = targets.map((t) => `the part of the task that changes ${t}`);
      seam = `${targets.length} named files/routes`;
    }
  }

  const biasCoreFirst = h.reviewerRejected;
  if (seam) {
    say(`found ${seam}${biasCoreFirst ? '; reviewer-rejection history — ordering core first' : ''}`);
    const subtasks = assemble({ task, pieces, biasCoreFirst });
    return {
      subtasks,
      reason: `split on ${seam} into ${subtasks.length - 1} piece(s) plus one integration subtask; `
        + 'every subtask carries the full original task, so the union cannot shrink'
        + (biasCoreFirst ? '; ordered smallest-verifiable-core first because a reviewer rejected earlier attempts' : ''),
    };
  }

  // No textual seams. With no history either, splitting is theater — refuse honestly.
  if (h.count === 0) {
    const why = 'this task is already atomic — a split would just rename the failure';
    say(why);
    return { subtasks: [], reason: why };
  }

  // Hard case: seamless but repeatedly failing. Try the free model lane only if explicitly enabled;
  // its failure FALLS BACK to the deterministic staged split below — never to an error.
  const modelOn = model === true || (model !== false && String(process.env.TASK_SPLIT_MODEL || '') === '1');
  let modelNote = null;
  if (modelOn) {
    say('no textual seams — asking the free model lane for a decomposition');
    const r = await runModelLane({ prompt: modelPrompt({ task, history, repo }), spawnFn, timeoutMs });
    if (r.ok) {
      // Model pieces go through the SAME assembly as deterministic ones: full-context wrapper,
      // scope line, integration tail. The model proposes; the union guarantee stays structural.
      const subtasks = assemble({ task, pieces: r.pieces, biasCoreFirst });
      say(`the model proposed ${r.pieces.length} pieces`);
      return {
        subtasks,
        model: { attempted: true, ok: true },
        reason: `the model lane proposed ${Math.min(r.pieces.length, 3)} piece(s); assembled with full-context `
          + 'wrappers and an integration subtask so the union cannot shrink',
      };
    }
    modelNote = r.error; // surfaced in the verdict — a dead lane must not vanish silently
    say(`model lane failed (${r.error}) — using the deterministic staged split`);
  }

  // Deterministic staged split: the one decomposition that needs no seams — verify the core is REAL
  // first (the exact thing a green gate on the whole task never proved), then the rest, then join.
  const staged = [
    'the smallest verifiable core of the task — the one behavior that proves the task is real (it '
      + 'exists, runs, and returns real data), with a test that fails without it',
    'the remaining behavior of the original task, built on top of the verified core',
  ];
  const subtasks = assemble({ task, pieces: staged, biasCoreFirst: false }); // staged IS core-first already
  say(`no textual seams but ${h.count} prior failure(s) — staged core-first split`);
  return {
    subtasks,
    ...(modelNote ? { model: { attempted: true, ok: false, error: modelNote } } : {}),
    reason: `no textual seams, but ${h.count} prior failure(s) — staged into smallest-verifiable-core `
      + 'first, remainder second, integration last'
      + (modelNote ? `; the model lane failed (${modelNote}) so the deterministic split was used` : ''),
  };
}

export const _internals = { listItems, conjunctionClauses, namedTargets, readHistory, coreFirst, assemble, runModelLane, modelPrompt };
