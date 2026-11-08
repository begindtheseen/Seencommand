#!/usr/bin/env node
// Forge planner — turn a grounded task into a SMALL, VERIFIABLE step plan before any code is written.
//
// Why plan at all: the owned engine runs on local/free models, and a small model handed a whole task
// wanders — it half-does three things and finishes none. Handed ONE step with an observable
// "done means", the same model is reliable. So the planner's job is decomposition into steps a gate
// can actually check, in the repo's existing "Done means" culture (engine/run.mjs requires every
// proposal to end with an observable 'Done means:' a human can verify — same bar here, per step).
//
// Why it can never throw: the plan is scaffolding, not the safety layer — the TEST GATE is the
// safety layer (see engine/builder.mjs). A dead planner lane must degrade to the deterministic
// single-step plan ("do the task, gate green"), never kill a run. Symmetrically, a model reply is
// parsed TOLERANTLY (fences stripped, first balanced JSON block, invalid steps dropped) because
// small local models drift from strict output formats constantly (see engine/coder.mjs parseEdits
// for the same lesson learned the hard way).
//
// Everything external is injectable: reasonFn for the model, context arrives PRE-BUILT (the caller
// runs coder.mjs retrieve() + its repo map and hands us the text), so planTask itself never touches
// disk or network — pure prompt-in / plan-out, trivially testable.

import { stripCodeFence } from '../coder.mjs';
import { reason } from '../../lib/llm.mjs';

const MAX_STEPS_HARD = 12;  // even if a caller asks for more, past ~a dozen steps the plan IS the wandering
const TITLE_MAX = 200;
const DONE_MAX = 300;
const APPROACH_MAX = 400;

// First balanced {...} block in model text, STRING-AWARE (a doneMeans like "prints '}' once" must
// not close the object early). Minimal local version of lib/llm.mjs extractJson — reimplemented
// here (not imported) because it isn't in this module's verified import surface, and we want the
// string-awareness its naive depth counter lacks.
function firstJsonBlock(text) {
  const s = String(text);
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0; let inStr = false; let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return null; // truncated object — never guess at a close (same rule as parseEdits)
}

// Validate + renumber the model's steps. A step is real only when it has BOTH a title and an
// observable doneMeans — a step nobody can check is exactly the vague work the planner exists to
// prevent, so it's dropped, not patched. snake_case aliases accepted because small models drift
// between the two even when shown the exact shape. Ids are OURS (s1..sN, post-drop) — model-supplied
// ids would leave holes after invalid steps are removed.
function validateSteps(raw, cap) {
  const out = [];
  for (const s of (Array.isArray(raw) ? raw : [])) {
    if (out.length >= cap) break;
    if (!s || typeof s !== 'object') continue;
    const title = String(s.title || '').trim();
    const doneMeans = String(s.doneMeans || s.done_means || s.done || '').trim();
    if (!title || !doneMeans) continue;
    const filesRaw = Array.isArray(s.targetFiles) ? s.targetFiles : (Array.isArray(s.target_files) ? s.target_files : []);
    const targetFiles = filesRaw.map((f) => String(f).trim()).filter(Boolean).slice(0, 8);
    out.push({
      id: `s${out.length + 1}`,
      title: title.slice(0, TITLE_MAX),
      doneMeans: doneMeans.slice(0, DONE_MAX),
      targetFiles,
      hints: String(s.hints || '').trim().slice(0, 300),
    });
  }
  return out;
}

// The always-works plan: one step, the task itself, done = implemented + wired in + full gate green.
// This is what ships when no lane answers or every model step is invalid — the executor loop and the
// gate still run exactly as they would under a model plan, just without decomposition.
function deterministicPlan(task) {
  const t = String(task || '').trim();
  return {
    approach: 'direct: implement the task as one verifiable change (planner unavailable or off-format)',
    steps: [{
      id: 's1',
      title: t.slice(0, 120) || 'implement the task',
      doneMeans: 'the change is implemented, wired in, and the full gate is green',
      targetFiles: [],
      hints: '',
    }],
    risks: [],
    engine: 'deterministic',
  };
}

// planTask — decompose a task into 1..maxSteps small steps with observable done-conditions.
// `context` is the pre-built grounding (retrieval windows + repo-map summary); `lessons` are prior
// runs' failure/success lessons (engine/forge/lessons.mjs), numbered into the prompt so the model
// plans AROUND known traps. Returns { approach, steps, risks, engine }; NEVER throws.
export async function planTask({ task, repoRoot, context = '', lessons = [], reasonFn = reason, maxSteps = 5 } = {}) {
  // repoRoot is part of the call shape for symmetry with the rest of Forge, but planning is
  // deliberately disk-free — the orchestrator builds `context` (retrieve() output) so this function
  // stays pure and every test runs without a repo.
  void repoRoot;
  const t = String(task || '').trim();
  try {
    const cap = Math.max(1, Math.min(Number(maxSteps) || 5, MAX_STEPS_HARD));
    const lessonBlock = (Array.isArray(lessons) ? lessons : []).filter(Boolean)
      .slice(0, 8).map((l, i) => `${i + 1}. ${String(l).replace(/\s+/g, ' ').trim().slice(0, 300)}`).join('\n');
    const system = 'You are the planning brain of an autonomous coding engine working on a real repository. '
      + 'You decompose a task into the SMALLEST set of independently verifiable steps. '
      + 'You reply with ONLY a JSON object — no prose, no markdown fences, no commentary.';
    const prompt = `TASK: ${t}\n`
      + (context ? `\nREPO GROUNDING (retrieved code + repo map):\n${context}\n` : '')
      + (lessonBlock ? `\nLESSONS FROM PRIOR RUNS (plan around these known traps):\n${lessonBlock}\n` : '')
      + `\nReply with ONLY JSON of exactly this shape:\n`
      + `{"approach": "<one sentence: the strategy>", "steps": [{"title": "<small concrete step>", "doneMeans": "<one OBSERVABLE behavior that proves the step is done — something a test or a human can check>", "targetFiles": ["<relative/path>"], "hints": "<optional: where/how in the code>"}], "risks": ["<what could go wrong>"]}\n`
      + `\nRules: 1 to ${cap} steps. Each step must be SMALL and verifiable ON ITS OWN — if a step needs another step to be checkable, merge them. `
      + `Every doneMeans must be observable, never "code is improved". targetFiles lists the files the step will touch (empty array if unknown). `
      + `NEVER invent names: any function, file, or export a step mentions MUST appear verbatim in the REPO GROUNDING above — if you cannot see it there, do not reference it (attempt 3 planned around a function that did not exist and every candidate died chasing it). `
      + `If the TASK's done-condition mentions a test, the LAST step must create or extend a real test file proving it (the reviewer rejects untested work). JSON only.`;
    // A local 32B planning 1500 tokens needs minutes, not the 20s conversational default — attempt 1
    // proved a short window means NO plan ever (deterministic fallback every run).
    const r = await reasonFn({ deptId: 'product', competence: 'plan', maxTokens: 1500, system, prompt, fallback: '', timeoutMs: 300000 });
    // engine:'fallback' means NO lane answered and we got our own empty fallback back — that is not
    // a plan, it's the signal to go deterministic (see lib/llm.mjs reason: never throws either).
    if (!r || !r.text || r.engine === 'fallback') return deterministicPlan(t);
    const block = firstJsonBlock(stripCodeFence(r.text));
    if (!block) return deterministicPlan(t);
    let parsed;
    try { parsed = JSON.parse(block); } catch { return deterministicPlan(t); }
    const steps = validateSteps(parsed.steps, cap);
    if (!steps.length) return deterministicPlan(t); // a "plan" with zero checkable steps is no plan
    const risks = (Array.isArray(parsed.risks) ? parsed.risks : [])
      .map((x) => String(x).replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 6);
    const approach = String(parsed.approach || '').replace(/\s+/g, ' ').trim().slice(0, APPROACH_MAX) || t.slice(0, 120);
    return { approach, steps, risks, engine: r.engine || 'unknown' };
  } catch (e) {
    // A planner crash (bad injectable, unexpected shape) must never kill a build — log and degrade.
    process.stderr.write(`[forge] planTask degraded to deterministic: ${e && e.message}\n`);
    return deterministicPlan(t);
  }
}

// Compact one-plan-per-glance rendering for the ledger / chat — mirrors the shape agents and
// Brandon already read in board-meeting output: numbered steps, each with its done-condition.
export function formatPlan(plan) {
  if (!plan || !Array.isArray(plan.steps) || !plan.steps.length) return '(no plan)';
  const lines = [`plan [${plan.engine || '?'}] ${plan.approach || ''}`.trim()];
  for (const s of plan.steps) {
    const files = (s.targetFiles && s.targetFiles.length) ? ` (${s.targetFiles.join(', ')})` : '';
    lines.push(`  ${s.id}. ${s.title}${files} — done means: ${s.doneMeans}`);
  }
  if (Array.isArray(plan.risks) && plan.risks.length) lines.push(`  risks: ${plan.risks.join(' · ')}`);
  return lines.join('\n');
}
