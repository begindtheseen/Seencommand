import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

// Redirect the activity ledger to a throwaway dir (config.commandRepoDir() honors SEEN_COMMAND_REPO_DIR)
// so codeAgentically's started/green/failed lines never touch the real repo — and give config a key so
// the lane is enabled. Both must be set BEFORE importing the module, but anthropicKey()/activityDir()
// read env at CALL time, so a top-level assignment is honored by every call inside the tests.
process.env.SEEN_COMMAND_REPO_DIR = mkdtempSync(join(tmpdir(), 'agentic-ledger-'));
process.env.ANTHROPIC_API_KEY = 'test-key-not-used-fetch-is-injected';
delete process.env.AGENTIC_MODEL; // engine tag stays 'agentic:<config default>'
// These scripted tests drive the ANTHROPIC engine (they replay Messages-API tool_use turns through the
// injected fetchFn). Pin it: the default AUTO chain now LEADS with claude-cli, which is installed on dev
// machines and would otherwise be tried first here. The per-engine adapters + AUTO fall-through get their
// own coverage in agentic-engines.test.mjs.
process.env.AGENTIC_ENGINE = 'anthropic';

const { codeAgentically } = await import('./agentic-coder.mjs');

// ---- scripted Messages API: a fake fetchFn replays canned assistant turns, capturing every request
// body so we can assert on the tool_result blocks the loop feeds back. No network, no model, no key use.
let _id = 0;
const use = (name, input = {}) => ({ type: 'tool_use', id: `tu_${++_id}`, name, input });
const say = (text) => ({ type: 'text', text });
const turn = (blocks, usage = { input_tokens: 200, output_tokens: 100 }) => ({ role: 'assistant', content: blocks, stop_reason: 'tool_use', usage });

function scriptedFetch(turns) {
  const sent = [];
  let i = 0;
  const fetchFn = async (_url, opts) => {
    sent.push(JSON.parse(opts.body));
    const t = turns[i] || turns[turns.length - 1];
    i += 1;
    return { ok: true, status: 200, json: async () => t, text: async () => '' };
  };
  return { fetchFn, sent, count: () => i };
}

// Every DISTINCT tool_result block the loop fed back (the model's view of what each tool returned).
// Each request body repeats the whole growing history, so dedupe by tool_use_id to count each once.
function toolResults(sent) {
  const byId = new Map();
  for (const body of sent) {
    for (const m of body.messages || []) {
      if (m.role === 'user' && Array.isArray(m.content)) {
        for (const b of m.content) if (b && b.type === 'tool_result') byId.set(b.tool_use_id, b);
      }
    }
  }
  return [...byId.values()];
}

function seedRepo(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agentic-'));
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), content);
  }
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'pipe' });
  g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false');
  g('add', '-A'); g('commit', '--allow-empty', '-m', 'seed'); // --allow-empty: some seeds track no files
  return dir;
}

// The gate stands in for the real syntax+suite check: GREEN once the target file carries REAL_IMPL.
const TARGET = 'engine/feature.mjs';
const makeGate = (dir) => (_root, _touched) => (existsSync(join(dir, TARGET)) && readFileSync(join(dir, TARGET), 'utf8').includes('REAL_IMPL')
  ? { green: true, errors: [] }
  : { green: false, errors: [`TESTS: ${TARGET} missing REAL_IMPL`] });

// (i) a full scripted build: ground (grep → read) → write (incomplete) → run_gate RED → fix → run_gate
// GREEN → done. The gate reads real file content, so red→green is driven by the actual writes.
test('scripted session: ground → write → gate red → fix → gate green → done returns summary+touched', async () => {
  const dir = seedRepo({ 'seed.mjs': 'export const SEED = 1; // groundme\n' });
  const writable = []; const touchedEvents = []; const events = [];
  const { fetchFn, sent } = scriptedFetch([
    turn([say('grounding'), use('grep', { pattern: 'groundme' })]),
    turn([use('read_file', { path: 'seed.mjs' })]),
    turn([use('write_file', { path: TARGET, content: 'export const F = 1;' })]),         // no marker → gate red
    turn([use('run_gate', {})]),
    turn([use('write_file', { path: TARGET, content: 'export const F = 1; // REAL_IMPL' })]), // marker → gate green
    turn([use('run_gate', {})]),
    turn([use('done', { summary: 'implemented the feature in engine/feature.mjs' })]),
  ]);
  const r = await codeAgentically({
    task: 'build the employer feature', repoRoot: dir, gate: makeGate(dir), fetchFn,
    assertWritable: (p) => { writable.push(p); },
    onTouched: (p) => touchedEvents.push(p), onEvent: (m) => events.push(m),
  });
  assert.match(r.engine, /^agentic:/, 'engine tags the lane + model');
  assert.equal(r.summary, 'implemented the feature in engine/feature.mjs', 'the done() summary is returned');
  assert.deepEqual(r.touched, [TARGET]);
  assert.ok(writable.includes(TARGET), 'assertWritable was enforced on the write');
  assert.ok(touchedEvents.includes(TARGET), 'onTouched fired so the builder can clean up on abort');
  assert.match(readFileSync(join(dir, TARGET), 'utf8'), /REAL_IMPL/, 'the corrected content landed on disk');
  // the model saw a RED gate then a GREEN gate through run_gate
  const gates = toolResults(sent).map((r2) => r2.content).filter((c) => /GATE (GREEN|RED)/.test(c));
  assert.ok(gates.some((c) => /GATE RED/.test(c)) && gates.some((c) => /GATE GREEN/.test(c)), JSON.stringify(gates));
  assert.ok(events.some((m) => /\[agentic\] wrote/.test(m)), 'compact progress lines are emitted');
});

// (ii) a write outside the safe paths returns an ERROR the model sees — the build continues, never throws
// (the task-31 lesson: an off-limits edit is per-edit feedback, not a build-killer).
test('write_file outside safePath → error tool_result, build continues (never throws)', async () => {
  const dir = seedRepo();
  const assertWritable = (p) => { if (p.includes('..') || p.startsWith('secret/')) throw new Error('outside safe paths'); };
  const { fetchFn, sent } = scriptedFetch([
    turn([use('write_file', { path: 'secret/evil.mjs', content: 'export const E = 1; // REAL_IMPL' })]),
    turn([use('write_file', { path: TARGET, content: 'export const F = 1; // REAL_IMPL' })]),
    turn([use('done', { summary: 'done' })]),
  ]);
  const r = await codeAgentically({ task: 'x', repoRoot: dir, gate: makeGate(dir), assertWritable, fetchFn });
  assert.deepEqual(r.touched, [TARGET], 'only the allowed write is tracked');
  assert.ok(!existsSync(join(dir, 'secret/evil.mjs')), 'the off-limits write never happened');
  const err = toolResults(sent).find((tr) => tr.is_error && /OFF-LIMITS/.test(tr.content));
  assert.ok(err, 'the model received an is_error tool_result naming the off-limits path');
});

// (iii) content whose FIRST line is a markdown fence is rejected at write (the #194 non-compiling .tsx).
test('write_file rejects fence-first-line content (the Seen #194 lesson)', async () => {
  const dir = seedRepo();
  const { fetchFn, sent } = scriptedFetch([
    turn([use('write_file', { path: TARGET, content: '```js\nexport const F = 1; // REAL_IMPL\n```' })]),
    turn([use('write_file', { path: TARGET, content: 'export const F = 1; // REAL_IMPL' })]),
    turn([use('done', { summary: 'done' })]),
  ]);
  const r = await codeAgentically({ task: 'x', repoRoot: dir, gate: makeGate(dir), assertWritable: () => {}, fetchFn });
  assert.match(r.engine, /^agentic:/);
  const fenceErr = toolResults(sent).find((tr) => tr.is_error && /markdown code fence/.test(tr.content));
  assert.ok(fenceErr, 'the fence body was refused with a corrective error');
  assert.ok(!readFileSync(join(dir, TARGET), 'utf8').includes('```'), 'no fence reached disk');
});

// (iv) run_cmd is an ALLOWLIST — an arbitrary command is refused; an allowlisted one runs.
test('run_cmd refuses arbitrary commands, allows the read-only allowlist', async () => {
  const dir = seedRepo();
  const { fetchFn, sent } = scriptedFetch([
    turn([use('run_cmd', { cmd: 'rm -rf /' })]),
    turn([use('run_cmd', { cmd: 'git status --porcelain' })]),
    turn([use('write_file', { path: TARGET, content: 'export const F = 1; // REAL_IMPL' })]),
    turn([use('done', { summary: 'done' })]),
  ]);
  await codeAgentically({ task: 'x', repoRoot: dir, gate: makeGate(dir), assertWritable: () => {}, fetchFn });
  const results = toolResults(sent).map((tr) => tr.content);
  assert.ok(results.some((c) => /not allowed/.test(c)), 'the arbitrary command was refused');
  const denials = results.filter((c) => /not allowed/.test(c));
  assert.equal(denials.length, 1, 'only the arbitrary command was refused — the allowlisted git status ran');
});

// (v) the token budget is a hard stop: exceed it and the loop throws an HONEST, router-legible error.
test('budget abort throws honestly (message the router keys off)', async () => {
  const dir = seedRepo({ 'seed.mjs': 'export const S = 1; // groundme\n' });
  const { fetchFn } = scriptedFetch([
    turn([use('grep', { pattern: 'groundme' })], { input_tokens: 400, output_tokens: 200 }), // 600 > budget after turn 1
    turn([use('grep', { pattern: 'groundme' })], { input_tokens: 400, output_tokens: 200 }),
  ]);
  await assert.rejects(
    () => codeAgentically({ task: 'x', repoRoot: dir, gate: makeGate(dir), assertWritable: () => {}, fetchFn, budgetTokens: 50 }),
    /agentic budget exhausted \(\d+ tokens, \d+ turns\)/,
  );
});

// (vi) done() never returns on the model's say-so: the loop re-runs the gate itself, and a RED gate
// feeds the errors back and CONTINUES rather than shipping a red tree.
test('done with a RED gate loops (re-runs the gate itself) instead of returning', async () => {
  const dir = seedRepo();
  const { fetchFn, sent, count } = scriptedFetch([
    turn([use('done', { summary: 'premature — nothing written yet' })]),                    // gate red → keep going
    turn([use('write_file', { path: TARGET, content: 'export const F = 1; // REAL_IMPL' })]),
    turn([use('done', { summary: 'real' })]),                                                // gate green → return
  ]);
  const r = await codeAgentically({ task: 'x', repoRoot: dir, gate: makeGate(dir), assertWritable: () => {}, fetchFn });
  assert.equal(r.summary, 'real', 'the premature done did NOT return — the second, gate-backed done did');
  assert.ok(count() >= 3, 'the loop continued past the premature done');
  const redBack = toolResults(sent).find((tr) => /Not done — the gate is RED/.test(tr.content));
  assert.ok(redBack, 'the premature done was answered with the gate errors, not accepted');
  assert.match(readFileSync(join(dir, TARGET), 'utf8'), /REAL_IMPL/);
});

// The lane refuses to run with no key configured — an honest throw, so the builder can fall back.
test('codeAgentically throws honestly when no Anthropic key is configured', async () => {
  const dir = seedRepo();
  const saved = process.env.ANTHROPIC_API_KEY;
  const savedAlt = process.env.ANTHROPIC_KEY;
  delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_KEY;
  try {
    await assert.rejects(
      () => codeAgentically({ task: 'x', repoRoot: dir, gate: makeGate(dir), assertWritable: () => {}, fetchFn: async () => ({ ok: true, json: async () => ({}) }) }),
      /needs an Anthropic API key/,
    );
  } finally { if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved; if (savedAlt !== undefined) process.env.ANTHROPIC_KEY = savedAlt; }
});
