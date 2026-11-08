// CODING-SYSTEM EVAL HARNESS — the pipeline scored against its own recorded failures.
//
// Every safety layer in this repo was added after an incident and proven by a unit test of THAT layer.
// Nothing ever asked the question that matters: handed the exact bad change that shipped last time,
// does the PIPELINE — runBuild, end to end, the way production calls it — stop it? This does.
//
// Two rules make the score mean something:
//   1. The coder is SCRIPTED. A case replays a specific historical bad change (or a good one), so the
//      result measures the pipeline, not a model's mood. The scripted lane honours the real lane
//      contract: it writes into the build tree, runs the REAL gate, and returns only on green.
//   2. The reviewer APPROVES EVERYTHING unless a case says otherwise. A probabilistic reviewer that
//      happens to catch a defect is luck; a case only passes when a DETERMINISTIC layer rejects it.
//      (Controls run the other way: a good change must ship, so "reject everything" scores zero.)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { runBuild, explainBuildFailure } from '../builder.mjs';

const write = (root, files) => {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
};

// A committed fixture repo. `dirty` (optional) is written AFTER the commit and left uncommitted — the
// shared-checkout contamination an isolated build must never pick up.
export function makeRepo(files, { dirty = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'coding-eval-'));
  const g = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  execFileSync('git', ['init', '-b', 'main', root], { stdio: 'pipe' });
  g('config', 'user.email', 'eval@seen'); g('config', 'user.name', 'eval'); g('config', 'commit.gpgsign', 'false');
  write(root, files);
  g('add', '-A'); g('commit', '-m', 'fixture base');
  // A real `origin`, so the build is cut from origin/main exactly as production cuts it.
  g('remote', 'add', 'origin', root); g('fetch', '-q', 'origin');
  if (dirty) write(root, dirty);
  return root;
}

// The scripted lane. `edits` maps repo-relative paths to new contents (null deletes the file).
// `skipGate` models a DISHONEST lane: one that returns a change without proving it green.
export function scriptedLane(edits, summary = 'scripted change', { skipGate = false } = {}) {
  const lane = async ({ workRoot, gate, assertWritable }) => {
    lane.calls++;
    const touched = Object.keys(edits);
    for (const rel of touched) if (typeof assertWritable === 'function') assertWritable(rel); // a local lane writes inside the contract
    for (const [rel, body] of Object.entries(edits)) {
      if (body === null) rmSync(join(workRoot, rel), { force: true });
      else write(workRoot, { [rel]: body });
    }
    if (skipGate) return { touched, summary, engine: 'scripted-dishonest' };
    const g = gate(workRoot, touched);
    if (!g.green) throw new Error(`coder could not reach a green gate in 1 rounds:\n${g.errors.join('\n')}`);
    return { touched, summary, engine: 'scripted' };
  };
  lane.calls = 0;
  return lane;
}

export const approveAll = async () => ({ ship: true, defects: [], engine: 'eval-approve-all' });

// Run one case through the real runBuild. Returns { status, message, kind, touched, stat, laneCalls }.
//   shipped  — reached the commit boundary (dry run: committed in the build tree, nothing pushed)
//   refused  — an honest premise refusal before any coding
//   blocked  — an owner-action stop (no reviewer, red base…)
//   rejected — the change was produced and a layer turned it back
export async function runCase(c) {
  const root = makeRepo(c.base, { dirty: c.dirty });
  const prevTool = process.env.SEEN_COMMAND_REPO_DIR;
  process.env.SEEN_COMMAND_REPO_DIR = root;
  const lane = scriptedLane(c.edits || {}, c.summary, { skipGate: !!c.skipGate });
  const prevEnv = {};
  for (const [k, v] of Object.entries(c.env || {})) { prevEnv[k] = process.env[k]; process.env[k] = v; }
  try {
    const out = await runBuild({ task: c.task, dryRun: true, onEvent: () => {}, seams: { generateFn: lane, reviewFn: c.reviewFn || approveAll, ...(c.seams || {}) } });
    return { status: 'shipped', message: '', kind: null, touched: out.touched, stat: out.stat, laneCalls: lane.calls, root };
  } catch (e) {
    const why = explainBuildFailure(e);
    const status = e.refusal ? 'refused' : (why && why.blocked ? 'blocked' : 'rejected');
    return { status, message: String(e.message), kind: why ? why.kind : null, touched: [], stat: '', laneCalls: lane.calls, root };
  } finally {
    for (const [k, v] of Object.entries(prevEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (prevTool === undefined) delete process.env.SEEN_COMMAND_REPO_DIR; else process.env.SEEN_COMMAND_REPO_DIR = prevTool;
  }
}

// Score one case against its expectation. `pending` cases are EXPECTED to fail today (a named gap);
// one that starts passing must have its flag removed, so the scoreboard can never silently flatter.
export async function scoreCase(c) {
  const r = await runCase(c);
  const problems = [];
  const want = c.expect;
  if (!want.status.includes(r.status)) problems.push(`status ${r.status}, wanted ${want.status.join('|')}`);
  if (want.message && !want.message.test(r.message)) problems.push(`message did not match ${want.message}: ${r.message.slice(0, 200)}`);
  if (want.laneCalls !== undefined && r.laneCalls !== want.laneCalls) problems.push(`coder ran ${r.laneCalls}×, wanted ${want.laneCalls}×`);
  if (want.check) { try { const p = await want.check(r); if (p) problems.push(p); } catch (e) { problems.push(`check threw: ${e.message}`); } }
  try { rmSync(r.root, { recursive: true, force: true }); } catch { /* best effort */ }
  return { id: c.id, history: c.history, pending: c.pending || null, pass: problems.length === 0, problems, result: r };
}

export async function runSuite(cases) {
  const results = [];
  for (const c of cases) results.push(await scoreCase(c)); // serial: the repo-dir env seam is process-global
  const active = results.filter((r) => !r.pending);
  return {
    results,
    passed: active.filter((r) => r.pass).length, total: active.length,
    pending: results.filter((r) => r.pending),
  };
}
