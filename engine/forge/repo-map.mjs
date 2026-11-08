#!/usr/bin/env node
// Forge's repo cartographer — a DETERMINISTIC map of the repository, built with zero model calls.
//
// Why it exists: the local coder's biggest failure mode is guessing layout — it invents paths,
// imports modules that don't exist, and re-implements exports it can't see (the phantom-reference
// class the lint gate catches only AFTER the model wasted a round). Forge grounds every task in a
// persistent map instead: which files exist, what each one exports, what it imports, and how the
// tree is shaped. The map is pure regex + git plumbing — no AST, no LLM — so it is cheap enough to
// rebuild on every HEAD change and can never hallucinate.
//
// The map is cached at <repoRoot>/data/forge/repo-map.json keyed by HEAD sha. data/ is one of the
// EXCLUDED dirs below, which gives a tidy invariant for free: the map can never list its own cache.
//
// Every external touchpoint (git subprocess, file reads) is injectable so tests never shell out
// unless they choose to build a real fixture repo.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { keywords } from '../coder.mjs';
import { dataDir } from '../../lib/paths.mjs';

// Only real source code belongs on the map — configs, docs, and assets would drown the signal.
const CODE_EXT = /\.(mjs|js|ts|tsx)$/;
const TEST_EXT = /\.test\.(mjs|js|ts|tsx)$/;
// Segment-based exclusion (not just prefix): a nested vendored node_modules/ is as useless as a
// top-level one, and .claude/ holds session worktrees whose duplicate trees would double-map the repo.
const EXCLUDED = new Set(['node_modules', 'dist', 'public', 'data', '.claude', '.git']);
// When the repo is bigger than maxFiles, these dirs are the signal: they hold the code Forge is ever
// asked to change (mirrors builder.mjs's safe-path universe). Everything else is the first to drop.
const SIGNAL_DIRS = ['engine/', 'lib/', 'app/', 'api/', 'org/', 'scripts/'];

// git wrapper that NEVER throws — an empty repo (no commits → rev-parse fails) or a non-repo dir
// must yield an empty map, not a crash: Forge treats "no map" as a grounding gap, never a build stop.
function sh(execFn, repoRoot, args) {
  // stderr piped (not inherited): an empty repo's `rev-parse HEAD` prints "fatal: ambiguous argument"
  // — expected here, and it must not spray noise into the caller's terminal or a test run's output.
  try { return String(execFn('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); } catch { return ''; }
}

function headShaOf(repoRoot, execFn) {
  const sha = sh(execFn, repoRoot, ['rev-parse', 'HEAD']).trim();
  return /^[0-9a-f]{7,40}$/.test(sha) ? sha : null; // garbage or empty → null, never a fake key
}

// ---- regex extraction (deliberately NOT an AST) ------------------------------------------------
// A parse-perfect extractor would need a dependency or a fragile hand parser; the map only has to be
// good enough to stop the model guessing, and regexes over whole-source text get >95% of real export
// lines in this codebase's style. matchAll over the SOURCE (not per-line) so multi-line brace lists
// (`export {\n a,\n b\n}`) still land.
const EXPORT_DECL = /export\s+(?:default\s+)?(?:async\s+)?(?:function\s*\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
const EXPORT_BRACE = /export\s*\{([^}]*)\}/g;
const IMPORT_FROM = /(?:^|\n)\s*(?:import|export)\s+[^;'"]*?from\s*['"]([^'"]+)['"]/g; // import X from / export {X} from (re-export = a dependency too)
const IMPORT_BARE = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;                           // side-effect import

export function extractExports(src) {
  const out = new Set();
  const s = String(src);
  for (const m of s.matchAll(EXPORT_DECL)) out.add(m[1]);
  for (const m of s.matchAll(EXPORT_BRACE)) {
    for (const piece of m[1].split(',')) {
      const name = piece.trim();
      if (!name) continue;
      const aliased = name.match(/^[\w$]+\s+as\s+([\w$]+)$/); // `a as b` → the OUTSIDE name is what callers import
      if (aliased) out.add(aliased[1]);
      else if (/^[A-Za-z_$][\w$]*$/.test(name)) out.add(name);
    }
  }
  if (/export\s+default\b/.test(s)) out.add('default');
  return [...out];
}

export function extractImports(src) {
  const out = new Set();
  const s = String(src);
  for (const m of s.matchAll(IMPORT_FROM)) out.add(m[1]);
  for (const m of s.matchAll(IMPORT_BARE)) out.add(m[1]);
  return [...out];
}

// ---- the map -----------------------------------------------------------------------------------
// buildRepoMap — one pass over `git ls-files`, filtered to code, capped by signal, parsed by regex.
// Deterministic for a given tree: files are path-sorted, dirs keys sorted, exports/imports in
// first-appearance order — so two builds of the same HEAD produce byte-identical JSON (diffable cache).
export function buildRepoMap(repoRoot, { maxFiles = 400, execFn = execFileSync, readFn = (p) => readFileSync(p, 'utf8') } = {}) {
  const all = sh(execFn, repoRoot, ['ls-files'])
    .split('\n').map((s) => s.trim())
    .filter((p) => p && CODE_EXT.test(p) && !p.split('/').some((seg) => EXCLUDED.has(seg)));
  // The test census runs over the FULL code list, before any trim — trimming may drop misc-dir tests,
  // and a health number that shrinks because the repo GREW would lie to the orchestrator.
  const testFiles = all.filter((p) => TEST_EXT.test(p)).length;
  let keep = all;
  if (keep.length > maxFiles) {
    // Signal tier first, path-alphabetical inside each tier: fully stable, no mtime/size races.
    const tier = (p) => (SIGNAL_DIRS.some((d) => p.startsWith(d)) ? 0 : 1);
    keep = [...keep].sort((a, b) => tier(a) - tier(b) || a.localeCompare(b)).slice(0, maxFiles);
  }
  keep = [...keep].sort((a, b) => a.localeCompare(b));
  const files = [];
  for (const p of keep) {
    let src;
    try { src = String(readFn(join(repoRoot, p))); }
    catch { continue; } // ls-files can list a path deleted from the working tree — skip, don't die
    // size = source length in chars (≈ bytes for this codebase's ASCII-dominant source). Using the
    // content we already read avoids a second injectable (statFn) for a number that's only a ranking hint.
    files.push({ path: p, size: src.length, exports: extractExports(src), imports: extractImports(src) });
  }
  // dirs = the file's IMMEDIATE parent ('.' for root files) — finer than top-level (engine/forge vs
  // engine) so the overview line actually shows where code concentrates. Keys inserted sorted so the
  // serialized map is deterministic.
  const dirCounts = new Map();
  for (const f of files) { const d = dirname(f.path); dirCounts.set(d, (dirCounts.get(d) || 0) + 1); }
  const dirs = {};
  for (const d of [...dirCounts.keys()].sort((a, b) => a.localeCompare(b))) dirs[d] = dirCounts.get(d);
  return { generatedAt: new Date().toISOString(), headSha: headShaOf(repoRoot, execFn), files, dirs, testFiles };
}

// ---- cache -------------------------------------------------------------------------------------
// The cache lives in the APP's own data home (lib/paths dataDir), keyed by a stable hash of the
// target repo path — NEVER inside the target repo. Writing <target>/data/forge/ was the e2e's first
// real catch: the product checkout doesn't gitignore data/, so forge would have littered every repo
// it mapped with an untracked cache directory.
const repoKey = (repoRoot) => {
  let h = 5381; const s = String(repoRoot);
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16);
};
const cacheDir = () => join(dataDir(), 'forge');
const cachePath = (repoRoot) => join(cacheDir(), `repo-map-${repoKey(repoRoot)}.json`);

// Atomic tmp→rename: a build interrupted mid-write must leave either the OLD map or the NEW one on
// disk, never a torn half-JSON — loadRepoMap treats torn as corrupt anyway, but atomicity means a
// crash can't silently cost the next run its cache.
export function saveRepoMap(repoRoot, map) {
  const dir = cacheDir();
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.repo-map.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(map, null, 2) + '\n'); // pretty: humans debug this cache
  renameSync(tmp, cachePath(repoRoot));
  return cachePath(repoRoot);
}

// null on missing OR corrupt — the cache is an optimization, never a dependency, so every failure
// shape (no file, torn write, hand-edited garbage, wrong shape) collapses to "no cache, rebuild".
export function loadRepoMap(repoRoot) {
  try {
    const map = JSON.parse(readFileSync(cachePath(repoRoot), 'utf8'));
    return map && Array.isArray(map.files) ? map : null;
  } catch { return null; }
}

// repoMapFor — the one entry point the orchestrator calls per task: cached map when its headSha still
// IS HEAD, fresh build otherwise. Cache trouble of any kind (unreadable, corrupt, unwritable data/)
// degrades to a rebuild — a stale or broken cache must never fail a build, only slow one down.
export function repoMapFor(repoRoot, opts = {}) {
  const head = headShaOf(repoRoot, opts.execFn || execFileSync);
  const cached = loadRepoMap(repoRoot); // never throws (see above)
  if (cached && head && cached.headSha === head) return cached;
  const map = buildRepoMap(repoRoot, opts);
  try { saveRepoMap(repoRoot, map); } catch { /* read-only checkout / full disk — the map still returns */ }
  return map;
}

// ---- prompt rendering --------------------------------------------------------------------------
// repoMapSummary — the map, compressed for a prompt: one dirs-overview line (biggest dirs first, so
// a truncated read still shows where the code lives), then files RANKED by overlap between the
// task's keywords (coder.mjs's extractor — same tokenizer the retrieval lane uses, so the map and
// the retrieved windows agree on what the task is "about") and each file's path + export names.
// Export-name hits outweigh path hits: a task naming an exported function should surface the file
// that DEFINES it above a file that merely shares a word with the path. Fully deterministic —
// score desc, then path asc — so the same task over the same map always renders the same prompt
// (reproducible builds, diffable transcripts).
export function repoMapSummary(map, task, { budget = 2200 } = {}) {
  const files = (map && map.files) || [];
  const dirs = (map && map.dirs) || {};
  const dirLine = 'dirs: ' + (Object.keys(dirs).length
    ? Object.entries(dirs).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([d, n]) => `${d}(${n})`).join(' ')
    : '(no code files)');
  // keywords() can emit both `runAlpha` (identifier) and `runalpha` (word) — dedupe after lowering
  // or one concept double-counts and skews the ranking.
  const terms = [...new Set(keywords(String(task || '')).map((t) => t.toLowerCase()))];
  const ranked = files.map((f) => {
    const p = f.path.toLowerCase();
    const ex = (f.exports || []).map((e) => e.toLowerCase());
    let score = 0;
    for (const t of terms) {
      if (p.includes(t)) score += 2;
      if (ex.some((e) => e.includes(t))) score += 3; // defining file beats name-alike path
    }
    return { f, score };
  }).sort((a, b) => b.score - a.score || a.f.path.localeCompare(b.f.path));
  const out = [dirLine];
  let used = dirLine.length;
  for (const { f } of ranked) {
    const line = (f.exports || []).length ? `${f.path} — exports: ${f.exports.join(', ')}` : f.path;
    if (used + 1 + line.length > budget) break; // stop, don't skip — later lines rank lower by construction
    out.push(line); used += 1 + line.length;
  }
  return out.join('\n').slice(0, budget); // hard cap even when the dirs line alone overflows
}
