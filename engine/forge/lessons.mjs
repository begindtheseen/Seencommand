#!/usr/bin/env node
// Forge lessons — the failure/success memory that makes the owned engine improve RUN OVER RUN.
//
// Every Forge run that ends (green or dead) can distill ONE portable sentence — "SEARCH blocks must
// copy file text verbatim, the local model re-guesses from memory", "gate X is red whenever Y" — and
// park it in the shared brain (the Chronos vault) as a bi-temporal fact. The next run pulls the
// lessons relevant to ITS task back into the planner prompt. No fine-tuning, no paid model: the
// engine gets smarter because its MEMORY does.
//
// Why facts and not a log file: the brain already has ONE dedup-aware, supersede-never-overwrite
// writer (lib/brain.mjs recordFacts → the seen repo's shared writer / vendored fallback). Facts
// dedupe by subject+predicate, so we make the predicate a CONTENT ADDRESS of the lesson text —
// re-learning the same lesson is a free no-op, while two different lessons can never collide and
// silently supersede each other. Everything is injectable so tests never touch a vault.

import { recordFacts, readBrainFacts } from '../../lib/brain.mjs';
import { rankFacts } from '../../brain/lib/keeper.mjs';

// The ONE subject Forge owns in the brain. lessonsFor filters on it exactly, so nothing else that
// happens to mention "forge" in a predicate/object can leak into a planning prompt.
export const LESSONS_SUBJECT = 'Forge lessons';

const OBJECT_MAX = 300; // vault facts are one-liners, not essays — same cap the brain UI expects

// djb2-xor over the NORMALIZED lesson text, as 8 hex chars. Stable across processes (unlike any
// Math.random / Date scheme), tiny, and collision-safe enough for a lesson set that stays in the
// dozens. The predicate `${kind}-${hash}` is what the brain's subject+predicate dedup keys on:
// same lesson → same predicate → recordFacts no-ops; different lesson → different predicate → both
// survive side by side instead of one superseding the other.
export function stableShortHash(s) {
  let h = 5381;
  const str = String(s);
  for (let i = 0; i < str.length; i++) h = ((((h << 5) >>> 0) + h) ^ str.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

// Normalize BEFORE hashing so trivial whitespace drift ("two  spaces", trailing newline) doesn't
// mint a "new" lesson: the predicate must address the meaning-bearing text, which is also exactly
// the object we store — hash and stored value can never disagree.
function normalizeLesson(lesson) {
  return String(lesson || '').replace(/\s+/g, ' ').trim().slice(0, OBJECT_MAX);
}

// Record ONE lesson as ONE fact. Returns { predicate, written, fact } — `written` is 0 when the
// brain already knew it (the dedup no-op), which callers may treat as "nothing new learned".
// Never throws: a lesson-write failure must not fail the Forge run that learned it.
export function recordLesson({ kind = 'failure', repo = '', task = '', lesson, detail = '', recordFn = recordFacts } = {}) {
  const k = kind === 'success' ? 'success' : 'failure'; // anything unrecognized is a failure lesson — the conservative read
  const object = normalizeLesson(lesson);
  if (!object) return { predicate: null, written: 0, fact: null };
  const predicate = `${k}-${stableShortHash(object)}`;
  // repo + task context ride in `source` — the one free-text field the fact shape carries (see
  // lib/brain.mjs writeOne: {subject, predicate, object, confidence, source}). The object stays the
  // portable lesson alone so ranking/prompting never drags run-specific noise along.
  const source = [
    `forge:${k}`,
    repo ? `repo=${String(repo).slice(0, 60)}` : '',
    task ? `task="${String(task).replace(/\s+/g, ' ').trim().slice(0, 140)}"` : '',
    detail ? String(detail).replace(/\s+/g, ' ').trim().slice(0, 160) : '',
  ].filter(Boolean).join(' · ');
  // failure lessons are HIGH confidence — the gate literally observed the failure; success lessons
  // are medium (one green run is weaker evidence that a tactic generalizes).
  const fact = { subject: LESSONS_SUBJECT, predicate, object, confidence: k === 'failure' ? 'high' : 'medium', source };
  try {
    const r = recordFn([fact]) || {};
    return { predicate, written: r.written || 0, fact };
  } catch (e) {
    process.stderr.write(`[forge] recordLesson failed: ${e && e.message}\n`);
    return { predicate, written: 0, fact };
  }
}

// The lessons worth showing the planner for THIS task: Forge-subject facts only, ranked by keyword
// overlap with the task (keeper.mjs rankFacts — pure), top `limit` lesson strings. rankFacts drops
// zero-overlap facts entirely; when NOTHING overlaps (a brand-new kind of task) we fall back to the
// most RECENT lessons instead of returning [] — a generic hard-won lesson ("never trust an ungated
// diff") is still better prompt material than silence. Never throws; [] when the brain is empty.
export function lessonsFor(task, { limit = 5, factsFn = readBrainFacts, rankFn = rankFacts } = {}) {
  const n = Math.max(1, Number(limit) || 1);
  let forge = [];
  try { forge = (factsFn() || []).filter((f) => f && f.subject === LESSONS_SUBJECT && f.object != null); }
  catch (e) { process.stderr.write(`[forge] lessonsFor read failed: ${e && e.message}\n`); return []; }
  if (!forge.length) return [];
  let ranked = [];
  try { ranked = rankFn(forge, String(task || ''), n) || []; }
  catch { ranked = []; }
  const pick = ranked.length ? ranked : forge.slice(-n); // recency fallback — see WHY above
  return pick.slice(0, n).map((f) => String(f.object));
}
