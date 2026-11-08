// TASK CONTRACT — what a task IS, established from the repository before any model is asked anything.
//
// The pipeline was engineered to stop a bad DIFF. Most failures start earlier: a vague task, the wrong
// repo, a plan that is valid JSON about unrelated files (the workflowStateCounts run planned the lint
// engine, git episodes and hardware detection — and was accepted), a coder that picks its own files.
// Every layer assumed the previous one understood the job; none established it. This does, with no
// model call and no judgment: it reads the task text and the code graph and either GROUNDS the task in
// things that exist — files, exported symbols, their callers and tests — or refuses to start.
//
// The contract then binds the rest of the build:
//   kind          what proof the gate demands (gate.mjs proofErrors) — decided here, never by the coder
//   allowedFiles  the SYSTEM's selection of what may be written: the targets, their tests, their direct
//                 callers and imports. A local model edits inside it; it does not choose its own scope.
//   structure     the definition / callers / tests of every target, handed to the coder as context —
//                 structural, not lexical
//   completion    what must be OBSERVED before the work may be called done (completion.mjs)
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { buildGraph, neighbourhood, isTest, isSource } from './code-graph.mjs';
import { explicitFileTargets, permitsNewFile } from './task-premise.mjs';

const LEADING_VERB = /^\s*(?:please\s+)?([a-z-]+)/i;
const REFACTOR = new Set(['refactor', 'rename', 'simplify', 'cleanup', 'clean', 'tidy', 'extract', 'inline', 'dedupe', 'deduplicate', 'reorganize', 'reorganise', 'restructure', 'move']);
const DOCS = new Set(['document', 'docs']);
// A refactor verb followed by wording that ADDS behaviour is not a refactor ("simplify X and add retries").
const ADDS_BEHAVIOUR = /\b(add|implement|introduce|support|handle|fix|new feature|so that|when the|return(s)? )\b/i;

export function taskKind(task, targets = []) {
  const verb = (LEADING_VERB.exec(String(task || '')) || [])[1]?.toLowerCase() || '';
  const paths = targets.map((t) => t.path);
  if (paths.length && paths.every((p) => /\.md$/i.test(p))) return 'docs';
  if (DOCS.has(verb) && !paths.some(isSource)) return 'docs';
  if (REFACTOR.has(verb) && !ADDS_BEHAVIOUR.test(task)) return 'refactor';
  if (paths.length && paths.every((p) => /\.(tsx|jsx|css|scss)$/.test(p) || /^(components|app|styles|public)\//.test(p))) return 'ui';
  return 'behaviour';
}

// Identifiers the task names — `backticked`, or written as a call: isFresh(row, now).
export function namedSymbols(task) {
  const out = new Set();
  for (const m of String(task || '').matchAll(/`([A-Za-z_$][\w$]{2,})(?:\([^`]*\))?`/g)) out.add(m[1]);
  for (const m of String(task || '').matchAll(/\b([a-zA-Z_$][\w$]{3,})\(/g)) out.add(m[1]);
  return [...out];
}

export function compileContract({ task, repoRoot, repo = 'tool', safePath = null, agenticOk = false, graph = null } = {}) {
  const g = graph || buildGraph({ root: repoRoot });
  let baseSha = null;
  try { baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' }).trim(); } catch { /* not a checkout — runBuild already refused */ }

  const mayCreate = permitsNewFile(task);
  const targets = [];
  for (const p of explicitFileTargets(task)) {
    const exists = existsSync(join(repoRoot, p));
    if (!exists && !mayCreate) continue; // a nonexistent path is evidence/prose; task-premise already refused the primary one
    if (safePath && !safePath.test(p)) continue;
    targets.push({ path: p, exists, why: 'named in the task' });
  }
  // Symbols → the module that exports them. Only an UNAMBIGUOUS match grounds anything.
  const symbols = [];
  for (const name of namedSymbols(task)) {
    const homes = [...g.modules.values()].filter((m) => !isTest(m.path) && m.exports.includes(name)).map((m) => m.path);
    if (homes.length !== 1) continue;
    symbols.push({ name, path: homes[0] });
    if (!targets.some((t) => t.path === homes[0])) targets.push({ path: homes[0], exists: true, why: `exports \`${name}\`` });
  }

  const grounded = targets.length > 0;
  const kind = taskKind(task, targets);
  if (!grounded && !agenticOk) {
    return { ok: false, refusal: 'this task cannot be grounded: it names no file, exported symbol or entrypoint that exists in the '
      + `${repo} repo, and no exploring (agentic) coding engine is configured. A local model handed an ungrounded task picks its own files and invents the rest — that is how unrelated, green, useless changes shipped. Sharpen the task: name the file or function to change.` };
  }

  // The structural neighbourhood of every existing target, and the write scope derived from it.
  const structure = {}; const allowed = new Set();
  const allow = (p) => { if (p && (!safePath || safePath.test(p))) allowed.add(p); };
  for (const t of targets) {
    allow(t.path);
    allow(t.path.replace(/\.([cm]?[jt]sx?)$/, '.test.$1').replace(/\.test\.(ts|tsx|js|jsx)$/, '.test.mjs')); // a co-located test, new or not
    allow(t.path.replace(/\.([cm]?[jt]sx?)$/, '.test.$1'));
    if (!t.exists) continue;
    const n = neighbourhood(g, t.path);
    if (!n) continue;
    structure[t.path] = n;
    for (const p of [...n.tests, ...n.consumers, ...n.imports]) allow(p);
  }
  const newDirs = mayCreate ? [...new Set(targets.map((t) => dirname(t.path)))] : [];

  const proof = [];
  if (kind === 'behaviour') proof.push('a test in the change must FAIL against the base code');
  if (kind === 'refactor') proof.push('the touched modules must export exactly what they exported before');
  proof.push('every new callable export has a real caller; no integration is orphaned');
  const completion = ['CI green on the PR'];
  if (repo === 'product') completion.push('the preview deployment builds and serves', 'any migration in the change is APPLIED to the target database');
  if (kind === 'ui') completion.push('the changed screen is observed rendering in the preview');
  if (repo === 'tool') completion.push('the merged commit is the one the installed app is running');

  return { ok: true, contract: {
    objective: String(task).trim(), repo, baseSha, kind, grounded, mayCreate,
    targets, symbols, structure, allowedFiles: [...allowed].sort(), newDirs, proof, completion,
    nonGoals: ['files outside allowedFiles', 'new dependencies', 'schema changes (a migration is its own reviewed change)'],
  } };
}

// May a LOCAL lane write this path? Grounded contracts only — an exploring agent is bounded by safePath.
export function contractAllows(contract, path) {
  if (!contract || !contract.grounded) return true;
  if (contract.allowedFiles.includes(path)) return true;
  return contract.newDirs.some((d) => dirname(path) === d);
}

// The structural context block handed to every coder. What to change, who calls it, what tests it.
export function contractContext(contract) {
  if (!contract || !contract.grounded) return '';
  const L = ['\n\nTASK CONTRACT (established from the repository — not a suggestion):',
    `- kind: ${contract.kind} — ${contract.proof.join('; ')}`,
    `- you may write ONLY: ${contract.allowedFiles.join(', ')}${contract.newDirs.length ? ` (and new files in ${contract.newDirs.join(', ')})` : ''}`];
  for (const [path, n] of Object.entries(contract.structure)) {
    L.push(`- ${path} exports [${n.exports.join(', ') || 'nothing'}]; called from [${n.consumers.join(', ') || 'NOTHING — wire what you add'}]; tested by [${n.tests.join(', ') || 'no test yet'}]`);
  }
  for (const s of contract.symbols) L.push(`- \`${s.name}\` lives in ${s.path}`);
  return L.join('\n');
}
