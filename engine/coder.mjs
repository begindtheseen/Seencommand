#!/usr/bin/env node
// The coding agent — LOCAL-FIRST with a hosted RESCUE ladder. It stays reliable on a small
// self-hosted model by refusing the two things that broke the cloud one-shot approach: it does NOT
// dump whole files into the prompt, and it does NOT ask for full-file rewrites (which truncate).
//
//   1) RETRIEVE  — grep the repo for the task's terms, rank files, pull only the relevant WINDOWS.
//   2) EDIT      — the model returns small SEARCH/REPLACE blocks, applied by exact (or whitespace-
//                  tolerant) match. Tiny output → fast, fits a 14B, and never truncates a real file.
//   3) VERIFY    — run the caller's test gate; feed the failures (and any SEARCH blocks that didn't
//                  match, with the CLOSEST real text quoted back) and retry. Only GREEN is returned.
//
// Escalation (Brandon, 2026-07-10: "fix these so they no longer fail ever"): the local model gets
// first shot at every round — $0, private — but when it STALLS (off-format replies twice, can't
// anchor its edits twice, the gate red the same way twice, or the lane starved), the round goes to
// the hosted coder lanes (groq → cerebras → gemini → frontier) instead of burning the remaining
// rounds on a model that's looping. The TEST GATE is the safety either way — no model's code ships
// un-gated, and there is still NO deterministic fallback for code. Builds only fail now when every
// lane is exhausted or the task genuinely can't reach green. Set CODER_ESCALATE=0 for strict
// local-only (the old behavior).
//
// This composes: many small, targeted fixes a day instead of one fragile whole-file rewrite.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { reason } from '../lib/llm.mjs';

const CONTEXT = 8;             // lines of context around each match
const WHOLE_FILE_MAX = 200;    // include the whole file if it's at most this many lines
const MAX_FILES = 5;
const BUDGET_CHARS = 26000;    // hard cap on retrieved code (~6.5k tokens) so it fits a small local model
const COMMON_DF = 14;          // a term matching more than this many files is too generic to locate with
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|css|scss|sql|json|md)$/;
const STOP = new Set(('the a an and or but if then else for while of to in on at by with from into is are be as it its this that these those not no yes do does did done make made keep kept must should would could will can may given back set reset when where which who what how why we our you your they their he she his her them us me my mine also more most less least very much many few some any all each every other another such same so than too only just even still yet get got give gave take took come came go went run ran use used need needs want wants fix fixes fixed bug issue task change changes update updates add adds added remove removes removed').split(' '));

// ---- retrieval -------------------------------------------------------------
// Pull meaningful search terms from a task: code identifiers, quoted strings, and salient words.
export function keywords(task) {
  const out = new Set();
  for (const m of String(task).matchAll(/`([^`]+)`|"([^"]+)"|'([^']+)'/g)) out.add((m[1] || m[2] || m[3]).trim());
  for (const id of String(task).matchAll(/\b([a-z][a-zA-Z0-9]*(?:[A-Z][a-zA-Z0-9]*)+|[a-z0-9]+(?:_[a-z0-9]+)+)\b/g)) out.add(id[1]); // camelCase / snake_case
  for (const w of String(task).toLowerCase().matchAll(/\b[a-z][a-z0-9]{3,}\b/g)) { if (!STOP.has(w[0])) out.add(w[0]); }
  return [...out].filter((t) => t.length >= 3).slice(0, 18);
}

function git(repoRoot, args) {
  try { return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }); } catch (e) { return e.stdout ? String(e.stdout) : ''; }
}

// Revert exactly these paths to their committed state: checkout tracked files, delete untracked (new)
// ones. Used between rounds so a broken edit doesn't compound — each attempt starts from a clean base.
function revertPaths(repoRoot, paths) {
  for (const p of paths) {
    try { execFileSync('git', ['ls-files', '--error-unmatch', p], { cwd: repoRoot, stdio: 'ignore' }); execFileSync('git', ['checkout', '--', p], { cwd: repoRoot, stdio: 'ignore' }); }
    catch { try { execFileSync('rm', ['-f', join(repoRoot, p)], { stdio: 'ignore' }); } catch { /* ignore */ } }
  }
}

// Rank tracked code files by how many distinct terms hit them, and report each term's document
// frequency (how many files it hits) so we can drop over-generic terms when locating exact lines.
// Files whose PATH contains a task term get a strong bonus — "fix the ghost report page" must rank
// app/ghost-report/page.tsx above some data file that merely mentions the words.
export function rankFiles(repoRoot, terms) {
  const score = new Map(); const df = new Map();
  for (const t of terms) {
    const out = git(repoRoot, ['grep', '-l', '-i', '-F', '-e', t, '--', '*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.sql', '*.css']);
    const hitFiles = out.split('\n').map((s) => s.trim()).filter((f) => f && CODE_EXT.test(f));
    df.set(t, hitFiles.length);
    for (const f of hitFiles) {
      const pathBonus = f.toLowerCase().includes(t.toLowerCase()) ? 3 : 0;
      score.set(f, (score.get(f) || 0) + 1 + pathBonus);
    }
  }
  return { files: [...score.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f), df };
}

// Matched lines for a file, WEIGHTED by term rarity: a line hit by three rare terms ("good morning
// undefined") must outrank a cluster of lines each hit by one common term — otherwise the window with
// the actual target loses the budget race and the model hallucinates code it never saw. Returns a
// Map(lineNo → Σ 1/df). `git grep -n <file>` prefixes rows with "<file>:", stripped before parsing.
function matchLines(repoRoot, file, terms, df = new Map()) {
  const weights = new Map();
  const prefix = file + ':';
  for (const t of terms) {
    const w = 1 / Math.max(df.get(t) || 1, 1);
    const out = git(repoRoot, ['grep', '-n', '-i', '-F', '-e', t, '--', file]);
    for (const row of out.split('\n')) {
      const rest = row.startsWith(prefix) ? row.slice(prefix.length) : row;
      const m = rest.match(/^(\d+):/); if (m) { const ln = Number(m[1]); weights.set(ln, (weights.get(ln) || 0) + w); }
    }
  }
  return weights;
}

// Build the retrieval context: only the RELEVANT windows across the top files, ranked by how many
// discriminative terms they contain, and capped to a small char budget so it fits a local model with
// room to answer. Whole small files are included as-is; big files contribute only their densest windows.
// `priorityFiles` are the task CONTRACT's structural picks — the targets, their callers and their tests
// (engine/task-contract.mjs). Lexical ranking finds files that TALK about the task; the contract names the
// files that are CONNECTED to it. They go first, are never cut by maxFiles, and a big one with no keyword
// hit still contributes its head (imports + exports), so the coder always sees who calls what it edits.
export function retrieve(repoRoot, task, { maxFiles = MAX_FILES, budget = BUDGET_CHARS, priorityFiles = [] } = {}) {
  const terms = keywords(task);
  const ranked = rankFiles(repoRoot, terms);
  const df = ranked.df;
  const priority = [...new Set(priorityFiles)].filter((f) => existsSync(join(repoRoot, f)));
  const files = [...priority, ...ranked.files.filter((f) => !priority.includes(f))].slice(0, Math.max(maxFiles, priority.length));
  const located = terms.filter((t) => (df.get(t) || 0) >= 1 && (df.get(t) || 0) <= COMMON_DF); // drop over-generic terms
  const cand = [];
  for (const f of files) {
    const full = existsSync(join(repoRoot, f)) ? readFileSync(join(repoRoot, f), 'utf8') : '';
    if (!full) continue;
    const src = full.split('\n');
    if (src.length <= WHOLE_FILE_MAX) { cand.push({ path: f, from: 1, to: src.length, text: full, score: 100 }); continue; }
    const weights = matchLines(repoRoot, f, located.length ? located : terms, df);
    const hits = [...weights.keys()].sort((a, b) => a - b);
    const wins = [];
    for (const ln of hits) {
      const from = Math.max(1, ln - CONTEXT), to = Math.min(src.length, ln + CONTEXT);
      const w = weights.get(ln) || 0;
      const last = wins[wins.length - 1];
      // merge adjacent hits, but CAP the window — one mega-window must not swallow the char budget
      // and crowd out the window that actually contains the target line (the failure that made the
      // model hallucinate code it never saw).
      // score = PEAK line weight, not sum: a single line where several rare terms co-occur IS the
      // target; summing lets broad low-signal clusters (e.g. CSS full of one common term) outrank it.
      if (last && from <= last.to + 3 && (Math.max(last.to, to) - last.from) <= 34) { last.to = Math.max(last.to, to); last.score = Math.max(last.score, w); }
      else wins.push({ from, to, score: w });
    }
    if (!wins.length && priority.includes(f)) wins.push({ from: 1, to: Math.min(src.length, 40), score: 50 }); // structurally relevant, lexically silent → its head
    for (const w of wins) cand.push({ path: f, from: w.from, to: w.to, text: src.slice(w.from - 1, w.to).join('\n'), score: priority.includes(f) ? w.score + 1000 : w.score });
  }
  // ROUND-ROBIN selection: order candidates per file by density, then take each file's next-best window
  // in turns until the budget is used — every relevant file contributes before any file gets seconds.
  const byFile = new Map();
  for (const c of cand) { if (!byFile.has(c.path)) byFile.set(c.path, []); byFile.get(c.path).push(c); }
  for (const list of byFile.values()) list.sort((a, b) => b.score - a.score);
  const queues = [...byFile.entries()].sort((a, b) => (priority.includes(b[0]) ? 1 : 0) - (priority.includes(a[0]) ? 1 : 0)).map(([, list]) => list); // contract files take their turn first
  const blocks = []; let used = 0; let took = true;
  while (took && used < budget) {
    took = false;
    for (const q of queues) {
      const c = q.shift();
      if (!c) continue;
      if (used + c.text.length > budget && blocks.length) continue;
      blocks.push(c); used += c.text.length; took = true;
      if (used >= budget) break;
    }
  }
  blocks.sort((a, b) => a.path.localeCompare(b.path) || a.from - b.from); // stable, readable order
  return { terms, files, blocks };
}

// ---- edit protocol ---------------------------------------------------------
// Parse the model's SEARCH/REPLACE + NEWFILE blocks. Small local models drift from the taught format
// constantly — wrap everything in ``` fences, drop the *** from the header, put the bare path on its
// own line above the markers — and under the old strict regex every drifted reply burned a WHOLE
// round ("no edit blocks parsed", the #33/#30 death spiral). So this is a tolerant line scanner: it
// accepts the canonical form plus the common drifts, but only ever extracts COMPLETE marker shapes —
// a truncated or separator-less block is skipped, never guessed at.
const FENCE_LINE = /^\s*`{3,}[\w-]*\s*$/;
const OPEN_LINE = /^\s*<{4,}\s*(SEARCH|CONTENT)?\s*$/i;
const MID_LINE = /^\s*={4,}\s*$/;
const CLOSE_LINE = /^\s*>{4,}\s*(REPLACE|END)?\s*$/i;
const HEADER_LINE = /^[\s#*>]*(FILE|NEWFILE|APPEND)\s*\**\s*:\s*(.+?)\s*$/i;
const PATHISH = /^[\w][\w\-./]*\.\w+$/; // a bare "api/reports.js"-looking line
const cleanPath = (p) => p.replace(/^[`'"*\s]+|[`'"*\s]+$/g, '');

// NEWFILE de-fencing. A small model routinely wraps the WHOLE file body in a markdown code fence
// (```typescript … ```) inside the CONTENT block; written verbatim, that fence becomes the file's
// first line — a non-compiling .tsx that passed the local gate and only died at Vercel (Seen #194).
// No source file in this system is MEANT to begin with a fence, so a leading fence is ALWAYS the
// wrapper: strip it, plus the matching TRAILING fence when the body is fully wrapped. Fence-looking
// lines in the MIDDLE are left untouched — they are legitimate inside .md content. Applied once, at
// the single write point in applyEdits.
export function stripCodeFence(content) {
  const lines = String(content).split('\n');
  let first = 0;
  while (first < lines.length && !lines[first].trim()) first++;
  if (first >= lines.length || !FENCE_LINE.test(lines[first])) return content; // no leading fence → nothing to strip
  let last = lines.length - 1;
  while (last > first && !lines[last].trim()) last--;
  const closed = last > first && FENCE_LINE.test(lines[last]); // a matching trailing fence closes the wrapper pair
  return lines.slice(first + 1, closed ? last : lines.length).join('\n');
}

export function parseEdits(text) {
  const edits = []; const newFiles = []; const appends = [];
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  let summary = null;
  for (let i = 0; i < lines.length; i++) {
    const sm = lines[i].match(/^[\s#*>]*SUMMARY\s*\**\s*:\s*(.+)$/i);
    if (sm) { if (!summary) summary = sm[1].replace(/[`*]+$/g, '').trim(); continue; }
    // Which file does this block belong to? An explicit FILE:/NEWFILE: header (fences/blanks may
    // sit between it and the opening marker), or a bare path line directly above the marker.
    let head = null; let open = -1;
    const hm = lines[i].match(HEADER_LINE);
    if (hm) {
      head = { kind: hm[1].toUpperCase(), path: cleanPath(hm[2]) };
      let j = i + 1;
      while (j < lines.length && (FENCE_LINE.test(lines[j]) || !lines[j].trim())) j++;
      if (j < lines.length && OPEN_LINE.test(lines[j])) open = j;
    } else if (i + 1 < lines.length && OPEN_LINE.test(lines[i + 1])) {
      const p = cleanPath(lines[i].replace(/^[\s#*>]*/, ''));
      if (PATHISH.test(p)) { head = { kind: 'FILE', path: p }; open = i + 1; }
    }
    if (!head || !head.path || open === -1) continue;
    const label = (lines[open].match(/(SEARCH|CONTENT)/i) || [, ''])[1].toUpperCase();
    const isNew = head.kind === 'NEWFILE' || (label === 'CONTENT' && head.kind !== 'APPEND');
    const a = []; const b = []; let cur = a; let sawMid = false; let close = -1;
    for (let k = open + 1; k < lines.length; k++) {
      if (!sawMid && MID_LINE.test(lines[k])) { cur = b; sawMid = true; continue; }
      if (CLOSE_LINE.test(lines[k])) { close = k; break; }
      cur.push(lines[k]);
    }
    if (close === -1) continue; // truncated block — never guess
    if (head.kind === 'APPEND') appends.push({ path: head.path, content: a.join('\n') });
    else if (isNew) newFiles.push({ path: head.path, content: a.join('\n') });
    else if (sawMid) edits.push({ path: head.path, search: a.join('\n'), replace: b.join('\n') }); // no separator = no trustable REPLACE — skip, don't invent a deletion
    i = close;
  }
  return { edits, newFiles, appends, summary };
}

// The verbatim file region most similar to a failed SEARCH block, quoted back to the model so it can
// re-anchor on text that actually exists — the fix for the "applied 0 edit(s), N unmatched" loop,
// where the model keeps re-guessing code it half-remembers instead of copying what's really there.
export function closestWindow(cur, search, { maxLines = 14 } = {}) {
  const fileLines = String(cur).split('\n');
  const want = String(search).split('\n').map((t) => t.trim()).filter(Boolean);
  if (!want.length || !fileLines.length) return null;
  const wantSet = new Set(want);
  const span = Math.min(Math.max(want.length, 3), maxLines);
  let best = { score: 0, at: 0 };
  for (let i = 0; i < fileLines.length; i++) {
    let score = 0;
    for (let j = i; j < Math.min(i + span, fileLines.length); j++) {
      const t = fileLines[j].trim();
      if (t && wantSet.has(t)) score += 1 + Math.min(t.length, 80) / 80; // longer exact lines anchor harder
    }
    if (score > best.score) best = { score, at: i };
  }
  if (!best.score) return null;
  const from = Math.max(0, best.at - 1);
  return fileLines.slice(from, Math.min(fileLines.length, from + span + 2)).join('\n').slice(0, 1200);
}

const normWS = (s) => s.replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/\s+$/, '')).join('\n');

// Apply parsed edits to the working tree. Exact match first, then whitespace-tolerant. Returns which
// files were touched and which SEARCH blocks did not match (so the caller can feed them back).
// An OFF-LIMITS path is a per-edit FAILURE fed back to the model, never a thrown error — task-31
// died instantly because one stray `brain/mcp/server.mjs` edit aborted the whole build instead of
// telling the model to put the change somewhere allowed.
// One line naming WHY a gate is red. For a test failure that is the failing TEST NAMES — the first lines
// of a runner's output tail are an arbitrary slice of some assertion diff (the first version of this
// printed "mmitted code file(s) (engine/run.mjs) — this is what has blocked self-update before").
export function redReason(err) {
  const lines = String(err || 'no error text').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return 'no error text';
  if (/^TESTS/.test(lines[0])) {
    const failing = [...new Set(lines.filter((l) => /^(✖|not ok)\s/.test(l) && !/failing tests:/.test(l)).map((l) => l.replace(/^(✖|not ok\s+\d+\s+-?)\s*/, '').replace(/\s*\(\d[\d.]*ms\)$/, '')))];
    return `TESTS: ${failing.length ? failing.slice(0, 3).join(' | ') : lines.slice(1, 3).join(' ⏎ ')}`.slice(0, 300);
  }
  return lines.slice(0, 2).join(' ⏎ ').slice(0, 300);
}

// Files a retrieval showed the model IN FULL, pinned to the exact bytes it saw: path → sha256.
export function shownInFull(ret) {
  const out = new Map();
  for (const b of (ret && ret.blocks) || []) {
    if (b.from !== 1) continue;
    out.set(b.path, createHash('sha256').update(b.text).digest('hex'));
  }
  return out;
}
const exportNames = (text) => [...String(text).matchAll(/^[ \t]*export\s+(?:default\b|(?:async\s+)?(?:function\*?|class|const|let|var)\s+([\w$]+))/gm)].map((m) => m[1] || 'default');
const codeLineCount = (text) => String(text).split('\n').filter((l) => l.trim() && !/^\s*(\/\/|\*|\/\*)/.test(l)).length;

// May a NEWFILE block OVERWRITE a file that already exists? A model regenerating a whole file to make a
// five-line change must reproduce every other line faithfully, and a 14B model does not: it drops
// imports, reverts neighbours, truncates. Whole-file replacement is therefore the exception, allowed only
// when ALL hold — the file is small enough to have been shown in full; if the lane reports what it
// showed (`shown`), this exact content is what the model saw (a hash pin: changed since → stale view);
// no export disappears; and the body does not collapse. Otherwise: a bounded SEARCH/REPLACE hunk.
export function overwriteProblem(path, current, next, shown = null) {
  const lines = current.split('\n').length;
  if (lines > WHOLE_FILE_MAX) return `NEWFILE would overwrite the existing ${lines}-line ${path}. A whole-file rewrite of a file you were not shown in full silently drops the code you cannot see — change it with small SEARCH/REPLACE hunks (or REPLACEFN) instead`;
  if (shown) {
    const pin = shown.get(path);
    if (!pin) return `NEWFILE would overwrite ${path}, which was never shown to you in full — edit it with SEARCH/REPLACE hunks instead`;
    if (pin !== createHash('sha256').update(current).digest('hex')) return `NEWFILE would overwrite ${path}, but the file has CHANGED since it was shown to you — your copy is stale and a rewrite would revert those changes. Use SEARCH/REPLACE hunks against the current text`;
  }
  const lost = exportNames(current).filter((n) => !exportNames(next).includes(n));
  if (lost.length) return `NEWFILE would overwrite ${path} and DROP its existing export(s): ${lost.join(', ')} — other modules import those. Keep them, or use SEARCH/REPLACE hunks`;
  if (codeLineCount(current) >= 10 && codeLineCount(next) < codeLineCount(current) * 0.5) return `NEWFILE would overwrite ${path} with less than half its code (${codeLineCount(current)} → ${codeLineCount(next)} lines) — that is a truncation, not an edit. Use SEARCH/REPLACE hunks`;
  return null;
}

// APPEND — add to the END of an existing file, with no SEARCH text to mismatch. The proof rule makes "add a
// test to the existing *.test.mjs" the most common edit in the system, and SEARCH/REPLACE made it the least
// reliable: to append, a model must quote the file's last lines EXACTLY, and on the first escalated
// real-model run (2026-09-18) the hosted coder fixed the source three times and had its test block go
// "unmatched" three times — so a correct change died as "includes no test". Appending is bounded (it cannot
// drop or rewrite a line that exists) and needs no anchor.
// An appended test usually re-imports what the file already imports, and a duplicate binding is a
// SyntaxError — so import lines are de-duplicated against the bindings the file already has.
export function mergeAppend(current, addition) {
  const bound = new Set();
  for (const m of String(current).matchAll(/^[ \t]*import\s+([^'";]*?)\s+from\s+['"][^'"]+['"]/gm)) {
    for (const n of m[1].replace(/[{}]/g, ',').split(',')) { const name = n.trim().split(/\s+as\s+/).pop().replace(/^\*\s*/, '').trim(); if (name) bound.add(name); }
  }
  const kept = [];
  for (const line of String(addition).replace(/\r\n/g, '\n').split('\n')) {
    const m = /^([ \t]*import\s+)([^'";]*?)(\s+from\s+['"][^'"]+['"];?\s*)$/.exec(line);
    if (!m) { kept.push(line); continue; }
    const braces = /\{([^}]*)\}/.exec(m[2]);
    const outside = m[2].replace(/\{[^}]*\}/, '').split(',').map((x) => x.trim()).filter(Boolean).filter((x) => !bound.has(x.split(/\s+as\s+/).pop().replace(/^\*\s*/, '').trim()));
    const inside = braces ? braces[1].split(',').map((x) => x.trim()).filter(Boolean).filter((x) => !bound.has(x.split(/\s+as\s+/).pop().trim())) : [];
    if (!outside.length && !inside.length) continue; // everything it imports is already bound
    for (const x of [...outside, ...inside]) bound.add(x.split(/\s+as\s+/).pop().replace(/^\*\s*/, '').trim());
    kept.push(`${m[1]}${[...outside, ...(inside.length ? [`{ ${inside.join(', ')} }`] : [])].join(', ')}${m[3]}`);
  }
  const body = kept.join('\n').replace(/^\n+/, '').replace(/\s+$/, '');
  return `${String(current).replace(/\s+$/, '')}\n\n${body}\n`;
}

export function applyEdits(repoRoot, { edits, newFiles, appends = [] }, assertWritable, { shown = null } = {}) {
  const touched = new Set(); const failures = [];
  for (const ap of appends) {
    try { assertWritable(ap.path); }
    catch (err) { failures.push({ path: ap.path, why: `path is OFF-LIMITS (${err.message}) — append to an allowed file instead` }); continue; }
    const abs = join(repoRoot, ap.path);
    const content = stripCodeFence(ap.content);
    if (!content.trim()) { failures.push({ path: ap.path, why: 'APPEND content is empty — provide the real code to add' }); continue; }
    if (!existsSync(abs)) { failures.push({ path: ap.path, why: 'APPEND needs an existing file — use NEWFILE to create one' }); continue; }
    writeFileSync(abs, mergeAppend(readFileSync(abs, 'utf8'), content));
    touched.add(ap.path);
  }
  for (const nf of newFiles) {
    try { assertWritable(nf.path); }
    catch (err) { failures.push({ path: nf.path, why: `path is OFF-LIMITS (${err.message}) — create the file under an allowed directory instead` }); continue; }
    const content = stripCodeFence(nf.content); // drop a markdown-fence wrapper before it reaches the tree (Seen #194)
    // An empty NEWFILE used to count as an applied edit and immediately pass syntax/tests. That burned
    // two full coder+reviewer attempts on live task #147. It is no progress, so feed it back inside the
    // coder loop before touching disk or invoking the expensive gate/reviewer.
    if (!content.trim()) { failures.push({ path: nf.path, why: 'NEWFILE content is empty — provide the complete, real file body' }); continue; }
    if (existsSync(join(repoRoot, nf.path))) {
      const problem = overwriteProblem(nf.path, readFileSync(join(repoRoot, nf.path), 'utf8'), content, shown);
      if (problem) { failures.push({ path: nf.path, why: problem }); continue; }
    }
    mkdirSync(dirname(join(repoRoot, nf.path)), { recursive: true });
    writeFileSync(join(repoRoot, nf.path), content.endsWith('\n') ? content : content + '\n');
    touched.add(nf.path);
  }
  for (const e of edits) {
    try { assertWritable(e.path); }
    catch (err) { failures.push({ path: e.path, why: `path is OFF-LIMITS (${err.message}) — make the change in an allowed file instead` }); continue; }
    const abs = join(repoRoot, e.path);
    if (!existsSync(abs)) { failures.push({ path: e.path, why: 'file does not exist' }); continue; }
    if (!e.search.trim()) { failures.push({ path: e.path, why: 'SEARCH is empty — copy the exact current lines you want to replace' }); continue; }
    const cur = readFileSync(abs, 'utf8');
    // A no-op "edit" (REPLACE identical to SEARCH) must not count as applied — it stages nothing,
    // which made `git commit` fail downstream with "nothing to commit". Feed it back instead.
    if (normWS(e.search) === normWS(e.replace)) { failures.push({ path: e.path, why: 'edit is a NO-OP — the replacement is identical to the search text; make a real change' }); continue; }
    if (cur.includes(e.search)) { writeFileSync(abs, cur.replace(e.search, e.replace)); touched.add(e.path); continue; }
    // whitespace-tolerant: match on trailing-space-normalized text, splice the ORIGINAL span back out
    const nc = normWS(cur), ns = normWS(e.search);
    const idx = nc.indexOf(ns);
    if (idx !== -1) {
      // map normalized index → original by line count (normWS preserves line count)
      const beforeLines = nc.slice(0, idx).split('\n').length - 1;
      const searchLines = ns.split('\n').length;
      const lines = cur.split('\n');
      const rebuilt = [...lines.slice(0, beforeLines), ...e.replace.split('\n'), ...lines.slice(beforeLines + searchLines)].join('\n');
      writeFileSync(abs, rebuilt); touched.add(e.path); continue;
    }
    // trimmed-line tolerant: small models re-type lines with drifted INDENTATION; match on per-line
    // trimmed content, but only when the span is UNIQUE in the file (ambiguity = refuse, never guess).
    const curLines = cur.split('\n');
    const sLines = e.search.split('\n').map((s) => s.trim());
    while (sLines.length && sLines[0] === '') sLines.shift();
    while (sLines.length && sLines[sLines.length - 1] === '') sLines.pop();
    if (sLines.length) {
      let found = -1;
      for (let i = 0; i + sLines.length <= curLines.length; i++) {
        let ok = true;
        for (let j = 0; j < sLines.length; j++) { if (curLines[i + j].trim() !== sLines[j]) { ok = false; break; } }
        if (ok) { if (found !== -1) { found = -2; break; } found = i; }
      }
      if (found >= 0) {
        // preserve the original indentation: re-indent each replacement line by the matched block's lead
        const lead = (curLines[found].match(/^\s*/) || [''])[0];
        const rLines = e.replace.split('\n').map((s) => (s.trim() ? lead + s.trim() : s));
        const rebuilt = [...curLines.slice(0, found), ...rLines, ...curLines.slice(found + sLines.length)].join('\n');
        if (rebuilt !== cur) { writeFileSync(abs, rebuilt); touched.add(e.path); continue; }
        failures.push({ path: e.path, why: 'edit is a NO-OP after applying' }); continue;
      }
      if (found === -2) { failures.push({ path: e.path, why: 'SEARCH matches MULTIPLE places — include more surrounding lines to make it unique' }); continue; }
    }
    failures.push({ path: e.path, why: 'SEARCH block not found', search: e.search.slice(0, 200), closest: closestWindow(cur, e.search) });
  }
  return { touched: [...touched], failures };
}

// ---- the agent loop --------------------------------------------------------
const SYSTEM = 'You are a precise senior engineer editing a real repository. You make MINIMAL, correct changes. '
  + 'You ONLY output edit blocks in the exact format given — never prose, never whole files, never markdown fences.';

function formatContext(ret) {
  return ret.blocks.map((b) => `----- ${b.path} (lines ${b.from}-${b.to}) -----\n${b.text}`).join('\n\n');
}

const PROTOCOL = `
Respond with ONLY these blocks (no prose, no code fences):

*** SUMMARY: <one line describing the fix>

For each change to an existing file:
*** FILE: <relative/path>
<<<<<<< SEARCH
<exact, contiguous lines that currently exist — copy them verbatim, enough to be unique>
=======
<the replacement lines>
>>>>>>> REPLACE

To create a new file:
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

Rules: the SEARCH text must match the current file EXACTLY (whitespace included). Keep each SEARCH small and unique. Do NOT wrap anything in markdown code fences. Change only what the task needs.`;

// Feedback for unmatched SEARCH blocks: quote the closest REAL text so the model copies instead of
// re-guessing (bounded — at most 3 failures, the windows already capped by closestWindow).
function failureFeedback(failures) {
  return failures.slice(0, 3).map((f) => f.closest
    ? `- ${f.path}: ${f.why}. The closest ACTUAL text in the file is:\n${f.closest}\n  ^ copy your SEARCH lines from THAT text exactly.`
    : `- ${f.path}: ${f.why}`).join('\n');
}

// codeLocally — run the retrieve→edit→gate loop, local model first, hosted lanes as the stall rescue.
// Returns { summary, touched, engine } on a GREEN gate; throws otherwise. onTouched(path) lets the
// caller track files for cleanup on abort. reasonFn/escalate/retryWaitMs are injectable for tests.
export async function codeLocally({ task, repoRoot, assertWritable, gate, onEvent, onTouched, maxRounds = 8, extraContext = '', priorityFiles = [],
  reasonFn = reason, escalate = process.env.CODER_ESCALATE === '1', retryWaitMs = 30000 } = {}) {
  const say = (m) => { if (onEvent) try { onEvent(m); } catch { /* ignore */ } };
  const ret = retrieve(repoRoot, task, { priorityFiles });
  const shown = shownInFull(ret); // what the model was shown in full, pinned to the bytes it saw
  say(`[coder] retrieved ${ret.blocks.length} region(s) from ${ret.files.length} file(s): ${ret.files.join(', ') || '(none)'}`);
  let context = formatContext(ret);
  if (extraContext) context = `${extraContext}\n\n${context}`;
  let feedback = '';
  const applied = new Set(); // every file actually edited so far (edits accumulate in the tree)
  let lastSummary = null; let lastEngine = null;
  let escalated = false;   // once true, rounds go to the hosted coder lanes (local only as last resort)
  let stalls = 0;          // consecutive rounds with zero progress (off-format or nothing applied)
  let lastRedSig = null;   // first gate error of the last red round — same twice = the model is looping

  const answered = (r) => r && r.engine !== 'fallback' && r.text;
  const think = (mode) => reasonFn({ deptId: 'product', competence: 'code', coder: true,
    localOnly: mode === 'local', hostedOnly: mode === 'hosted', maxTokens: 4000, system: SYSTEM,
    prompt: `TASK: ${task}\n\nRELEVANT CODE:\n${context}\n${feedback}\n${PROTOCOL}`, fallback: '' });
  const goHosted = (why) => {
    if (escalated || !escalate) return false;
    escalated = true; stalls = 0;
    say(`[coder] ${why} — escalating to the hosted coder lanes (CODER_ESCALATE=1 is set; unset it to stay strictly local + free)`);
    return true;
  };

  // One round's brain: the preferred lane first, the other side as a LIVE fallback — a starved or
  // unconfigured lane must never end a build by itself.
  async function thinkRound() {
    let r = await think(escalated ? 'hosted' : 'local');
    if (answered(r)) return r;
    if (!escalated) {
      // The local lane starves when Ollama is busy (board-meeting agenda right after a restart) —
      // wait with growing patience before concluding it's down.
      for (let retry = 1; !answered(r) && retry <= 2; retry++) {
        say(`[coder] local lane unavailable (busy or timed out) — waiting ${(retry * retryWaitMs) / 1000}s and retrying (${retry}/2)`);
        await new Promise((res) => setTimeout(res, retry * retryWaitMs));
        r = await think('local');
      }
      if (!answered(r) && escalate) { goHosted('the local coder is not answering'); r = await think('hosted'); }
    } else {
      r = await think('local');
      if (answered(r)) say('[coder] hosted lanes unavailable this round — continuing with the local coder');
    }
    return r;
  }

  for (let round = 1; round <= maxRounds; round++) {
    const r = await thinkRound();
    if (!answered(r)) {
      throw new Error(escalate
        ? 'no coder lane answered — the local lane is starved/not served AND every hosted lane failed or is unconfigured; retry when a lane is back'
        : 'the LOCAL coder did not answer — Ollama is not served or is saturated. Start it and pull a coder model (e.g. `ollama pull qwen2.5-coder:32b`), or set CODER_ESCALATE=1 to allow paid hosted lanes. Staying free + local by default.');
    }
    lastEngine = r.engine;
    const parsed = parseEdits(r.text);
    if (parsed.summary) lastSummary = parsed.summary;
    if (!parsed.edits.length && !parsed.newFiles.length && !(parsed.appends || []).length) {
      say(`[coder] round ${round} (${r.engine}): no edit blocks parsed — reminding the model of the format`);
      feedback = '\nYour last reply contained no valid edit blocks. Output ONLY the *** FILE / SEARCH / REPLACE blocks exactly as specified — no prose, no code fences.\n';
      if (++stalls >= 2) goHosted('the local coder keeps replying off-format');
      continue;
    }
    const { touched, failures } = applyEdits(repoRoot, parsed, assertWritable, { shown });
    touched.forEach((t) => { applied.add(t); if (onTouched) onTouched(t); });
    say(`[coder] round ${round} (${r.engine}): applied ${touched.length} edit(s)${failures.length ? `, ${failures.length} unmatched` : ''} → ${touched.join(', ') || '(none)'}`);

    // Nothing has actually been changed yet → the model needs to match real text; don't gate empty.
    if (!applied.size) {
      feedback = `\nThose SEARCH blocks did not match the file verbatim — copy the EXACT current text (whitespace included):\n${failureFeedback(failures)}\n`;
      if (++stalls >= 2) goHosted('the local coder cannot anchor its edits to the real file text');
      continue;
    }
    stalls = 0;
    // Gate the FULL accumulated change. A GREEN gate is the signal of success — unmatched extra blocks
    // that changed nothing are harmless and must NOT block shipping a green fix.
    const g = gate(repoRoot, [...applied]);
    // Say WHY it is red. The log used to read "gate red" eight times and nothing else, so a failed build
    // could not be diagnosed from its own record (the 2026-09-18 live run: eight reds, zero reasons).
    const redWhy = g.green ? '' : ` — ${redReason((g.errors || [])[0])}`;
    say(`[coder] round ${round}: gate ${g.green ? 'GREEN ✓' : 'red'}${redWhy}`);
    if (g.green) return { summary: lastSummary || task, touched: [...applied], engine: lastEngine };
    // Red → the model's edits are bad. Revert to a CLEAN base so the next attempt doesn't stack on top
    // of broken code, and hand it the gate errors to fix. Failing the SAME way twice = it's looping —
    // hand the round to a stronger lane instead of watching the loop.
    // The SAME failure, recognisably. This compared the first 160 chars of raw runner output — an arbitrary
    // slice of an assertion diff that differs a little every round — so a model failing the same TEST eight
    // times never looked like a loop and never escalated (seen live, 2026-09-18). Failing test NAMES are stable.
    const sig = redReason((g.errors || [])[0]);
    if (sig && sig === lastRedSig) goHosted('the gate keeps failing the same way');
    lastRedSig = sig;
    feedback = `The test gate is RED with your last edits. Your edits were REVERTED — every file is back to the ORIGINAL code shown above; start again from that text. Errors:\n${g.errors.join('\n').slice(0, 2500)}\n`
      + (failures.length ? `\nAlso, these SEARCH blocks didn't match the original — copy exact text:\n${failureFeedback(failures)}\n` : '');
    revertPaths(repoRoot, [...applied]);
    applied.clear();
  }
  throw new Error(`coder could not reach a green gate in ${maxRounds} rounds${escalated ? ' (local + hosted lanes both tried)' : ''}${lastRedSig ? ` — last gate failure: ${lastRedSig}` : ''}`);
}
