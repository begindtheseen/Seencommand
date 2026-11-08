#!/usr/bin/env node
// FORGE — Seen Command's OWNED coding engine. Brandon's directive (2026-08-03): "build me what you know
// I want… never rely on an AI we didn't build… no broken attempts from cheap models — solve it the right
// way." This is that build: a full agentic pipeline we own end-to-end, running on FREE engines (the local
// Ollama coder; reason()'s free lanes), made frontier-grade not by a bigger model but by STRUCTURE:
//
//   GROUND     retrieval (git grep windows) + a persistent repo map + lessons from every prior failure
//   PLAN       decompose into SMALL steps, each with an observable "done means" (planner.mjs; a garbage
//              plan degrades to one honest step — planning can never crash a build)
//   IMPLEMENT  per step, BEST-OF-N verified sampling (implementer.mjs): sample up to N candidate patches,
//              apply → verify → keep the first GREEN, revert reds precisely. The model's claim never
//              decides; verification does. This is how a 32B local model stops shipping broken attempts.
//   VERIFY     layered per-step checks, cheap-first (verifier.mjs): fences → syntax → effectiveness →
//              the FULL repo gate (tests + tsc + the real production build) → an optional self-review
//              that can only block on an explicit REJECT.
//   LEARN      every failure and every success writes a deduped lesson to the shared brain (lessons.mjs)
//              and the next run on similar work gets them injected. The engine improves run over run.
//
// forgeTask has the same call shape + return contract as codeLocally/codeAgentically — { summary,
// touched, engine } ONLY on green, honest throw otherwise — so runBuild's branch/reviewer/commit/PR
// machinery (and every #243-class safeguard in it) ships forge's work unchanged. Every collaborator is
// injectable; tests never touch a model, the network, or a real gate.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { retrieve } from '../coder.mjs';
import { repoMapFor, repoMapSummary } from './repo-map.mjs';
import { planTask, formatPlan } from './planner.mjs';
import { recordLesson, lessonsFor } from './lessons.mjs';
import { implementStep } from './implementer.mjs';
import { verifyStep, buildSelfReviewer } from './verifier.mjs';

// Format retrieval blocks for the prompt (coder.mjs keeps its formatter private; this mirrors its
// intent — path-labelled windows, tight budget — without depending on its internals).
function formatRetrieval(ret, budget = 3500) {
  const parts = [];
  let used = 0;
  for (const b of ret.blocks || []) {
    const s = `--- ${b.path}${b.start ? ` (from line ${b.start})` : ''} ---\n${b.text || ''}`;
    if (used + s.length > budget) break;
    parts.push(s); used += s.length;
  }
  return parts.join('\n');
}

// The step's target files, VERBATIM — attempt 2's forge lesson: the planner names targetFiles but the
// implementer never saw their real text, so the model invented SEARCH blocks from imagination and every
// candidate died "nothing applied". SEARCH/REPLACE edits demand exact current text; give it exactly
// that. Small files ship whole; big ones ship numbered head + keyword-matched windows. readFn injectable.
// Budget/threshold sized to the 32k local context, not timidity: attempts 3-5 all died to keyword
// windows showing the wrong slice while the model guessed signatures. A 300-line file is ~6k tokens —
// SHIP TARGET FILES WHOLE (≤600 lines); only giants (e.g. the 1200-line dashboard) still window.
export function targetFileContext(repoRoot, step, { readFn, budget = 22000 } = {}) {
  const read = readFn || ((p) => readFileSync(p, 'utf8'));
  const files = Array.isArray(step && step.targetFiles) ? step.targetFiles : [];
  const parts = [];
  let used = 0;
  const stepText = String(`${(step && step.title) || ''} ${(step && step.doneMeans) || ''} ${[].concat((step && step.hints) || []).join(' ')}`);
  // LONGEST identifier-ish terms first — attempt 4's telemetry: the window keyed on the FIRST hit of a
  // generic word ("board"/"meeting" in a top-of-file comment), showed the wrong slice, and the model
  // guessed recordBoardMeeting's signature three different ways. "recordBoardMeeting" beats "board".
  const terms = (stepText.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) || [])
    .filter((t, i, a) => a.indexOf(t) === i)
    .sort((a, b) => b.length - a.length);
  for (const f of files.slice(0, 4)) {
    let src;
    try { src = String(read(join(repoRoot, f))); } catch { parts.push(`--- ${f} — DOES NOT EXIST yet (create it with *** NEWFILE) ---`); continue; }
    const lines = src.split('\n');
    let body;
    if (lines.length <= 600) body = src; // whole file when it fits — rewrite escalation then has the full body
    else {
      // Giant files (the 1200-line dashboard): arbitrary ±N-line slices kept cutting template literals
      // mid-expression (attempt 7's s2 deaths). Ship the ENTIRE enclosing function around each term hit
      // instead — brace-balanced from the nearest definition line upward, so SEARCH text can be copied
      // from a complete, coherent block.
      const centers = [];
      for (const t of terms) {
        const hit = lines.findIndex((l, i) => l.toLowerCase().includes(t) && !centers.some((c) => Math.abs(c - i) < 40));
        if (hit >= 0) centers.push(hit);
        if (centers.length >= 2) break;
      }
      if (!centers.length) centers.push(0);
      const blockAround = (c) => {
        // walk UP to the nearest line that starts a definition-ish block
        let start = c;
        for (let i = c; i >= Math.max(0, c - 80); i--) {
          if (/^(export\s+)?(async\s+)?(function|const|let|var|class)\b|^window\.|^\s{0,2}function\b/.test(lines[i])) { start = i; break; }
          start = i;
        }
        // walk DOWN balancing braces from start; cap at 150 lines
        let depth = 0; let seen = false; let end = Math.min(lines.length - 1, start + 149);
        for (let i = start; i <= Math.min(lines.length - 1, start + 149); i++) {
          for (const ch of lines[i]) { if (ch === '{') { depth++; seen = true; } else if (ch === '}') depth--; }
          if (seen && depth <= 0) { end = Math.max(i, c); break; }
        }
        return { start, end };
      };
      const spans = centers.sort((a, b) => a - b).map(blockAround);
      const windows = spans.map(({ start, end }) => `(lines ${start + 1}-${end + 1})\n${lines.slice(start, end + 1).join('\n')}`);
      body = `${windows.join('\n… (gap) …\n')}\n… (${lines.length} lines total — SEARCH text must match EXACTLY what is shown or actually in the file)`;
    }
    const s = `--- CURRENT CONTENT OF ${f} (copy SEARCH lines from THIS text verbatim) ---\n${body}`;
    if (used + s.length > budget) break;
    parts.push(s); used += s.length;
  }
  return parts.join('\n\n');
}

const clip = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n)}…` : t; };

// The one orchestrating pass. Steps run sequentially — each step's edits stay in the tree for the next
// (a plan is a build-up, not independent patches); a step that exhausts its candidates fails the WHOLE
// task honestly (partial features are theater — the standing no-fakes rule).
export async function forgeTask({ task, repoRoot, gate, assertWritable, extraContext = '', priorityFiles = [], onEvent, onTouched,
  maxSteps = 5, candidates = 3, reasonFn = undefined, deps = {} } = {}) {
  if (!task) throw new Error('forge needs a task');
  if (typeof gate !== 'function') throw new Error('forge needs a gate');
  if (typeof assertWritable !== 'function') throw new Error('forge needs assertWritable');
  const say = (m) => { if (typeof onEvent === 'function') { try { onEvent(m); } catch { /* ignore */ } } };

  const d = {
    retrieveFn: deps.retrieveFn || retrieve,
    repoMapForFn: deps.repoMapForFn || repoMapFor,
    repoMapSummaryFn: deps.repoMapSummaryFn || repoMapSummary,
    lessonsForFn: deps.lessonsForFn || lessonsFor,
    planTaskFn: deps.planTaskFn || planTask,
    implementStepFn: deps.implementStepFn || implementStep,
    verifyStepFn: deps.verifyStepFn || verifyStep,
    buildSelfReviewerFn: deps.buildSelfReviewerFn || buildSelfReviewer,
    recordLessonFn: deps.recordLessonFn || recordLesson,
  };

  // ---- GROUND: what the repo IS + what past runs learned -----------------------------------------
  let retrieval = { blocks: [], files: [] };
  try { retrieval = d.retrieveFn(repoRoot, task, { priorityFiles }); } catch { /* an empty retrieval grounds on the map alone */ }
  let mapNote = '';
  try { mapNote = d.repoMapSummaryFn(await d.repoMapForFn(repoRoot), task, { budget: 2000 }); }
  catch { /* no map (fresh clone, git trouble) — retrieval still grounds the run */ }
  let lessons = [];
  try { lessons = d.lessonsForFn(task) || []; } catch { /* no brain — forge still runs */ }
  say(`[forge] grounded: ${retrieval.files.length} retrieved file(s), map ${mapNote ? 'ready' : 'unavailable'}, ${lessons.length} lesson(s) from prior runs`);

  const context = [
    extraContext,
    mapNote ? `REPO MAP (task-relevant):\n${mapNote}` : '',
    retrieval.blocks.length ? `RELEVANT CODE:\n${formatRetrieval(retrieval)}` : '',
    lessons.length ? `LESSONS FROM PRIOR RUNS (avoid repeating these failures):\n${lessons.map((l, i) => `${i + 1}. ${l}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');

  // ---- PLAN --------------------------------------------------------------------------------------
  const plan = await d.planTaskFn({ task, repoRoot, context, lessons, maxSteps, ...(reasonFn ? { reasonFn } : {}) });
  say(`[forge] plan (${plan.engine}): ${formatPlan ? formatPlan(plan) : plan.steps.map((s) => s.title).join(' → ')}`);

  // ---- IMPLEMENT + VERIFY, step by step ----------------------------------------------------------
  const reviewFn = d.buildSelfReviewerFn(...(reasonFn ? [reasonFn] : [undefined]), { repoRoot });
  const allTouched = new Set();
  const track = (p) => { allTouched.add(p); if (typeof onTouched === 'function') { try { onTouched(p); } catch { /* ignore */ } } };
  const stepEngines = [];

  for (const step of plan.steps) {
    say(`[forge] step ${step.id}: ${step.title} — done means: ${clip(step.doneMeans, 120)}`);
    const verify = ({ repoRoot: r, touched }) => d.verifyStepFn({ repoRoot: r, touched, step, gate, reviewFn, onEvent: say });
    // Per-step grounding: the REAL current text of the files this step targets (read fresh each step —
    // an earlier step may have just edited them). Without this the model guesses SEARCH text (attempt 2).
    let stepContext = context;
    try {
      const tf = targetFileContext(repoRoot, step);
      if (tf) stepContext = `${tf}\n\n${context}`;
    } catch { /* grounding is best-effort — the retrieval context still stands */ }
    let result;
    try {
      result = await d.implementStepFn({
        step, task, repoRoot, context: stepContext, candidates,
        verify, assertWritable, onEvent: say, ...(reasonFn ? { reasonFn } : {}),
      });
    } catch (e) {
      // A step died after N verified candidates → the honest end of THIS task, and a lesson for the next.
      try {
        d.recordLessonFn({ kind: 'failure', repo: repoRoot, task, lesson: clip(`step "${step.title}" failed: ${e.message}`, 280) });
      } catch { /* the lesson is best-effort — the honest failure below is what matters */ }
      say(`[forge] step ${step.id} exhausted its ${candidates} candidates — failing honestly`);
      throw new Error(`forge: step "${step.title}" could not reach green after ${candidates} verified candidates — ${clip(e.message, 400)}`);
    }
    for (const p of result.touched || []) track(p);
    stepEngines.push(result.engine || 'local');
    say(`[forge] step ${step.id} GREEN ✓ (candidate ${result.candidate}, ${(result.touched || []).length} file(s))`);
  }

  // ---- FINAL WHOLE-TASK VERIFY -------------------------------------------------------------------
  // Steps verified individually as they landed; the finale re-proves the WHOLE accumulated change in
  // one pass (a later step can break an earlier one — never trust per-step green alone).
  const finale = gate(repoRoot, [...allTouched]) || { green: false, errors: ['gate returned nothing'] };
  if (!finale.green) {
    try { d.recordLessonFn({ kind: 'failure', repo: repoRoot, task, lesson: clip(`steps green individually but the combined change failed the gate: ${(finale.errors || [])[0]}`, 280) }); }
    catch { /* best-effort */ }
    throw new Error(`forge: every step was green but the COMBINED change fails the full gate:\n${(finale.errors || []).join('\n').slice(0, 1200)}`);
  }

  try { d.recordLessonFn({ kind: 'success', repo: repoRoot, task, lesson: clip(`worked: ${plan.approach || plan.steps.map((s) => s.title).join('; ')}`, 280) }); }
  catch { /* best-effort */ }

  const summary = `${plan.approach ? `${clip(plan.approach, 160)} — ` : ''}${plan.steps.length} step(s), ${allTouched.size} file(s), all verified green`;
  say(`[forge] DONE ✓ ${summary}`);
  return { summary, touched: [...allTouched], engine: `forge:${plan.engine}+${[...new Set(stepEngines)].join('/')}` };
}

export default forgeTask;
