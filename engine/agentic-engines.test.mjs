import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { readActivity } from '../lib/activity.mjs';

// Redirect the activity ledger to a throwaway dir (config.commandRepoDir() honors SEEN_COMMAND_REPO_DIR)
// so the started/green/engine-fallthrough lines never touch the real repo — the reviewer.test seam. Give
// every hosted lane a key so engine SELECTION (not "no key configured") is what we exercise; each engine
// is picked per test via AGENTIC_ENGINE, and fetch/spawn are always injected — no network, no real model.
process.env.SEEN_COMMAND_REPO_DIR = mkdtempSync(join(tmpdir(), 'agentic-engines-ledger-'));
process.env.GROQ_API_KEY = 'test-groq';
process.env.CEREBRAS_API_KEY = 'test-cerebras';
process.env.GEMINI_API_KEY = 'test-gemini';
process.env.ANTHROPIC_API_KEY = 'test-anthropic';
delete process.env.AGENTIC_MODEL;
delete process.env.AGENTIC_OLLAMA_MODEL;
process.env.CLINE_AGENT = '0'; // keep AUTO-chain expectations hermetic even when Cline is installed globally

const { codeAgentically } = await import('./agentic-coder.mjs');

// ---- shared helpers --------------------------------------------------------
const TARGET = 'engine/feature.mjs';
const REAL = 'export const F = 1; // REAL_IMPL';

function seedRepo(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agentic-eng-'));
  for (const [p, content] of Object.entries(files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), content); }
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'pipe' });
  g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false');
  g('add', '-A'); g('commit', '--allow-empty', '-m', 'seed');
  return dir;
}
const makeGate = (dir) => (_root, _touched) => (existsSync(join(dir, TARGET)) && readFileSync(join(dir, TARGET), 'utf8').includes('REAL_IMPL')
  ? { green: true, errors: [] } : { green: false, errors: [`TESTS: ${TARGET} missing REAL_IMPL`] });

// Force one engine for the duration of a call, restoring the prior value (top-level node:test cases run
// sequentially, the same assumption agentic-coder.test.mjs already relies on).
async function withEngine(kind, fn) {
  const prev = process.env.AGENTIC_ENGINE;
  if (kind == null) delete process.env.AGENTIC_ENGINE; else process.env.AGENTIC_ENGINE = kind;
  try { return await fn(); } finally { if (prev === undefined) delete process.env.AGENTIC_ENGINE; else process.env.AGENTIC_ENGINE = prev; }
}

// A scripted fetch that replays provider-shaped responses in order, capturing every request.
function scripted(responses) {
  const sent = []; let i = 0;
  const fetchFn = async (url, opts) => { sent.push({ url, body: JSON.parse(opts.body), headers: opts.headers }); const r = responses[Math.min(i, responses.length - 1)]; i += 1; return { ok: true, status: 200, json: async () => r, text: async () => '' }; };
  return { fetchFn, sent };
}
const ok = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => '' });
const err = (status, body) => ({ ok: false, status, json: async () => ({}), text: async () => body });

// provider response shapes
const oaiTool = (name, args, id, usage = { total_tokens: 250 }) => ({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }], usage });
const oaiText = (text) => ({ choices: [{ message: { role: 'assistant', content: text } }], usage: { total_tokens: 20 } });
const gemTool = (name, args) => ({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name, args } }] } }], usageMetadata: { totalTokenCount: 250 } });
const ollamaTool = (name, args) => ({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] }, prompt_eval_count: 200, eval_count: 100 });
const ollamaText = (text) => ({ message: { role: 'assistant', content: text } });

// (1) OpenAI-compatible round-trip (groq): function tools out, assistant tool_calls in, role:'tool'
// results fed back, done → green. Cerebras shares this exact adapter.
test('groq (OpenAI-compat) adapter: tool round-trip → green, results fed back as role:tool', async () => {
  const dir = seedRepo({ 'seed.mjs': '// x\n' });
  const { fetchFn, sent } = scripted([
    oaiTool('write_file', { path: TARGET, content: REAL }, 'call_write'),
    oaiTool('done', { summary: 'done via groq' }, 'call_done'),
  ]);
  const writable = [];
  const r = await withEngine('groq', () => codeAgentically({ task: 'build a feature', repoRoot: dir, gate: makeGate(dir), fetchFn, assertWritable: (p) => writable.push(p) }));
  assert.match(r.engine, /^agentic:groq:/, 'engine tags the groq lane + model');
  assert.deepEqual(r.touched, [TARGET]);
  assert.ok(sent[0].url.includes('api.groq.com/openai/v1/chat/completions'), 'posted to the groq OpenAI-compat endpoint');
  assert.equal(sent[0].headers.authorization, 'Bearer test-groq', 'bearer auth');
  assert.ok(Array.isArray(sent[0].body.tools) && sent[0].body.tools[0].type === 'function', 'function-spec tools sent');
  assert.ok(sent[1].body.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'call_write'), 'the tool result was fed back as a role:tool message keyed by tool_call_id');
  assert.ok(writable.includes(TARGET), 'assertWritable enforced on the write');
});

test('cline: headless checkpointed runtime edits, stays off git, then passes the Seen gate', async () => {
  const dir = seedRepo();
  let invoked = null;
  const spawnFn = (bin, args, opts) => {
    invoked = { bin, args };
    mkdirSync(join(opts.cwd, dirname(TARGET)), { recursive: true });
    writeFileSync(join(opts.cwd, TARGET), `${REAL}\n`);
    return { status: 0, stdout: `${JSON.stringify({ type: 'agent_event', event: { text: 'implemented with Cline' } })}\n`, stderr: '' };
  };
  const r = await withEngine('cline', () => codeAgentically({ task: 'build it with an advanced agent', repoRoot: dir, gate: makeGate(dir), fetchFn: async () => ({}), spawnFn, assertWritable: () => {} }));
  assert.equal(r.engine, 'agentic:cline');
  assert.deepEqual(r.touched, [TARGET]);
  assert.ok(invoked.args.includes('--yolo') && invoked.args.includes('--json'), 'Cline is headless and auto-approved inside the outer Seen gate');
  assert.ok(invoked.args.includes('--compaction') && invoked.args.includes('agentic'), 'agentic context compaction is enabled');
  assert.ok(invoked.args.includes('--retries') && invoked.args.includes('5'), 'bounded recovery retries are enabled');
  assert.ok(invoked.args.includes('--cwd') && invoked.args.includes(dir), 'the worker is scoped to the target checkout');
  assert.ok(invoked.args.includes('--provider') && invoked.args.includes('cline'), 'the verified signed-in provider is explicit');
  assert.ok(invoked.args.includes('--model') && invoked.args.includes('openai/gpt-5.3-codex'), 'Qwen is never selected for Seen Command coding');
});

// (2) Gemini round-trip: functionDeclarations out, functionCall parts in, functionResponse parts fed back.
test('gemini adapter: functionDeclarations round-trip → green, functionResponse fed back', async () => {
  const dir = seedRepo();
  const { fetchFn, sent } = scripted([
    gemTool('write_file', { path: TARGET, content: REAL }),
    gemTool('done', { summary: 'done via gemini' }),
  ]);
  const r = await withEngine('gemini', () => codeAgentically({ task: 'build it', repoRoot: dir, gate: makeGate(dir), fetchFn, assertWritable: () => {} }));
  assert.match(r.engine, /^agentic:gemini:/);
  assert.deepEqual(r.touched, [TARGET]);
  assert.ok(sent[0].url.includes('generativelanguage.googleapis.com') && sent[0].url.includes(':generateContent'), 'posted to gemini generateContent');
  assert.ok(sent[0].body.tools[0].functionDeclarations.length === 7, 'all tools sent as one functionDeclarations block');
  assert.ok(sent[1].body.contents.some((c) => (c.parts || []).some((p) => p.functionResponse && p.functionResponse.name === 'write_file')), 'the tool result was fed back as a functionResponse part');
});

// (3) Ollama round-trip WITH a format reminder: a first reply that carries no tool call earns ONE
// reminder, then the model recovers with real tool calls and reaches green.
test('ollama adapter: a no-tool-call reply gets ONE reminder, then recovers → green', async () => {
  const dir = seedRepo();
  const { fetchFn, sent } = scripted([
    ollamaText('Sure, I will implement the feature now.'), // no tool_calls → one reminder
    ollamaTool('write_file', { path: TARGET, content: REAL }),
    ollamaTool('done', { summary: 'done via ollama' }),
  ]);
  const r = await withEngine('ollama', () => codeAgentically({ task: 'build it', repoRoot: dir, gate: makeGate(dir), fetchFn, assertWritable: () => {} }));
  assert.match(r.engine, /^agentic:ollama:/);
  assert.deepEqual(r.touched, [TARGET]);
  assert.ok(sent[0].url.includes('/api/chat'), 'posted to the ollama chat endpoint');
  assert.ok(sent.some((s) => (s.body.messages || []).some((m) => m.role === 'user' && /Respond with a tool call/.test(m.content || ''))), 'exactly the format reminder was injected');
});

// (3b) Ollama is BOUNDED: a SECOND consecutive no-tool-call reply after the reminder is a stall, not an
// infinite nudge loop.
test('ollama adapter: no tool call even after the reminder → bounded stall (honest throw)', async () => {
  const dir = seedRepo();
  const { fetchFn } = scripted([ollamaText('thinking...'), ollamaText('still thinking...'), ollamaText('...')]);
  await assert.rejects(
    () => withEngine('ollama', () => codeAgentically({ task: 'x', repoRoot: dir, gate: makeGate(dir), fetchFn, assertWritable: () => {} })),
    /stalled — produced no tool call after a format reminder/,
  );
});

// (4) AUTO fall-through: claude-cli logged-out → groq 401 → cerebras 401 → gemini 400 → anthropic 400
// credit-balance → ollama ECONNREFUSED (last, throws). Each fall-through lands an engine-fallthrough
// ledger line naming which engine and why.
test('AUTO chain: startup/auth failures fall through engine-by-engine with ledger lines', async () => {
  const dir = seedRepo();
  const TASK = 'ZC-FALLTHROUGH engine chain probe';
  const spawnFn = () => ({ status: 1, stdout: '', stderr: 'Invalid API key · Please run /login' }); // claude-cli logged out
  const fetchFn = async (url) => {
    if (url.includes('api.groq.com')) return err(401, 'unauthorized: no groq access');
    if (url.includes('api.cerebras.ai')) return err(401, 'unauthorized');
    if (url.includes('generativelanguage.googleapis.com')) return err(400, 'API key not valid');
    if (url.includes('api.anthropic.com')) return err(400, 'your credit balance is too low');
    throw new Error('connect ECONNREFUSED 127.0.0.1:11434'); // ollama down
  };
  await assert.rejects(
    () => withEngine('auto', () => codeAgentically({ task: TASK, repoRoot: dir, gate: makeGate(dir), fetchFn, spawnFn, assertWritable: () => {} })),
    /ECONNREFUSED|network error/,
    'the last engine (ollama) throws honestly once the whole chain is exhausted',
  );
  const fell = readActivity({ days: 1 }).filter((e) => e.summary.startsWith('ZC-FALLTHROUGH') && e.status === 'engine-fallthrough');
  const engines = fell.map((e) => e.detail.split(':')[0]);
  assert.deepEqual(engines, ['claude-cli', 'groq', 'cerebras', 'gemini', 'anthropic'], 'one fall-through line per engine, in chain order (ollama is last → no line)');
  assert.match(fell[0].detail, /logged in/, 'the claude-cli reason is recorded');
  assert.match(fell.find((e) => e.detail.startsWith('anthropic')).detail, /credit balance/, 'the anthropic credit-balance reason is recorded');
});

// (5a) claude-cli happy path: the CLI edits the tree directly; we DETECT the touched file via
// git status before/after, guard it, gate it, and ship it.
test('claude-cli: detects the files the CLI edited, guards + gates them, ships on green', async () => {
  const dir = seedRepo({ 'seed.mjs': '// x\n' });
  const writable = []; const touchedEvents = [];
  const spawnFn = (bin, args, opts) => { mkdirSync(join(opts.cwd, dirname(TARGET)), { recursive: true }); writeFileSync(join(opts.cwd, TARGET), `${REAL}\n`); return { status: 0, stdout: 'wrote engine/feature.mjs', stderr: '' }; };
  const r = await withEngine('claude-cli', () => codeAgentically({ task: 'build it', repoRoot: dir, gate: makeGate(dir), fetchFn: async () => { throw new Error('no fetch'); }, spawnFn, assertWritable: (p) => writable.push(p), onTouched: (p) => touchedEvents.push(p) }));
  assert.equal(r.engine, 'agentic:claude-cli');
  assert.deepEqual(r.touched, [TARGET], 'the CLI-edited file was detected by the before/after diff');
  assert.ok(writable.includes(TARGET), 'the post-hoc writable guard ran on the touched file');
  assert.ok(touchedEvents.includes(TARGET), 'onTouched fired so the builder can clean up on abort');
});

// (5b) claude-cli post-hoc guard: an off-limits edit is REVERTED and the attempt throws honestly (it does
// NOT silently ship, and it is not a fall-through condition).
test('claude-cli: an off-limits edit is reverted and the attempt throws honestly', async () => {
  const dir = seedRepo();
  const spawnFn = (bin, args, opts) => { mkdirSync(join(opts.cwd, 'secret'), { recursive: true }); writeFileSync(join(opts.cwd, 'secret/evil.mjs'), `${REAL}\n`); return { status: 0, stdout: 'done', stderr: '' }; };
  const assertWritable = (p) => { if (p.startsWith('secret/')) throw new Error('outside safe paths'); };
  await assert.rejects(
    () => withEngine('claude-cli', () => codeAgentically({ task: 'x', repoRoot: dir, gate: makeGate(dir), fetchFn: async () => ({}), spawnFn, assertWritable })),
    /off-limits path \(secret\/evil\.mjs\)/,
  );
  assert.ok(!existsSync(join(dir, 'secret/evil.mjs')), 'the off-limits untracked file was reverted (removed)');
});

// (5c) claude-cli post-hoc guard: a markdown-fenced file (the #194 lesson) is reverted + honest throw.
test('claude-cli: a markdown-fenced file is reverted and throws honestly', async () => {
  const dir = seedRepo();
  const spawnFn = (bin, args, opts) => { mkdirSync(join(opts.cwd, dirname(TARGET)), { recursive: true }); writeFileSync(join(opts.cwd, TARGET), '```js\nexport const F = 1; // REAL_IMPL\n```\n'); return { status: 0, stdout: 'done', stderr: '' }; };
  await assert.rejects(
    () => withEngine('claude-cli', () => codeAgentically({ task: 'x', repoRoot: dir, gate: makeGate(dir), fetchFn: async () => ({}), spawnFn, assertWritable: () => {} })),
    /markdown-fenced file/,
  );
  assert.ok(!existsSync(join(dir, TARGET)), 'the fenced untracked file was reverted (removed)');
});

// (5d) claude-cli logged-out FALL-THROUGH: in AUTO, a logged-out CLI hands off to the next engine (groq),
// which succeeds — and the hand-off is recorded in the ledger.
test('claude-cli logged out → AUTO falls through to groq, which ships', async () => {
  const dir = seedRepo();
  const TASK = 'ZC-CLIFALL logged-out hands to groq';
  const spawnFn = () => ({ status: 1, stdout: '', stderr: 'Not logged in. Please run /login' });
  const { fetchFn } = scripted([oaiTool('write_file', { path: TARGET, content: REAL }, 'w'), oaiTool('done', { summary: 'groq shipped it' }, 'd')]);
  const r = await withEngine('auto', () => codeAgentically({ task: TASK, repoRoot: dir, gate: makeGate(dir), fetchFn, spawnFn, assertWritable: () => {} }));
  assert.match(r.engine, /^agentic:groq:/, 'groq took over after claude-cli fell through');
  assert.deepEqual(r.touched, [TARGET]);
  const fell = readActivity({ days: 1 }).filter((e) => e.summary.startsWith('ZC-CLIFALL') && e.status === 'engine-fallthrough');
  assert.equal(fell.length, 1, 'exactly one fall-through, for claude-cli');
  assert.match(fell[0].detail, /^claude-cli:.*logged in/);
});

// (6) Token-estimate budget enforcement: when a provider omits usage, tokens are estimated (JSON chars/4)
// and the hard budget still fires with the honest, router-legible message.
test('token estimation (no provider usage) still enforces the hard budget', async () => {
  const dir = seedRepo({ 'seed.mjs': '// groundme\n' });
  // groq responses with NO `usage` field → the estimate path is what accrues tokens.
  const noUsage = { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'g1', type: 'function', function: { name: 'grep', arguments: JSON.stringify({ pattern: 'groundme' }) } }] } }] };
  const { fetchFn } = scripted([noUsage, noUsage]);
  await assert.rejects(
    () => withEngine('groq', () => codeAgentically({ task: 'x', repoRoot: dir, gate: makeGate(dir), fetchFn, assertWritable: () => {}, budgetTokens: 50 })),
    (e) => {
      const m = e.message.match(/agentic budget exhausted \((\d+) tokens, (\d+) turns\)/);
      assert.ok(m, `message shape: ${e.message}`);
      assert.ok(Number(m[1]) >= 50, 'the estimated token count crossed the budget (proves estimation ran)');
      return true;
    },
  );
});

// (7) FREE-ONLY DEFAULT (Brandon 2026-08-03: "make this free… never rely on an AI we didn't build" +
// "no credits"): with AGENTIC_ENGINE unset, the chain is claude-cli → ollama ONLY. No groq/cerebras/
// gemini call, and CRITICALLY no paid Anthropic API call — a credit-balance error is impossible because
// the paid endpoint is never contacted. Exhausting the free chain throws the last (ollama) error.
test('DEFAULT chain is FREE-ONLY: no hosted/paid engine is ever contacted', async () => {
  const dir = seedRepo();
  const TASK = 'FREE-ONLY default chain probe';
  const urls = [];
  const spawnFn = () => ({ status: 1, stdout: '', stderr: 'Invalid API key · Please run /login' }); // claude-cli logged out
  const fetchFn = async (url) => { urls.push(url); throw new Error('connect ECONNREFUSED 127.0.0.1:11434'); }; // ollama down
  await assert.rejects(
    () => withEngine(null, () => codeAgentically({ task: TASK, repoRoot: dir, gate: makeGate(dir), fetchFn, spawnFn, assertWritable: () => {} })),
    /ECONNREFUSED|network error/,
  );
  assert.ok(urls.every((u) => u.includes('11434') || u.includes('ollama')), `only the local ollama endpoint was contacted, got: ${urls.join(', ')}`);
  assert.ok(!urls.some((u) => u.includes('api.anthropic.com')), 'the PAID Anthropic API is never called on the default chain');
  assert.ok(!urls.some((u) => u.includes('api.groq.com') || u.includes('api.cerebras.ai') || u.includes('generativelanguage')), 'no hosted lane is called on the default chain');
  const fell = readActivity({ days: 1 }).filter((e) => e.summary.startsWith('FREE-ONLY') && e.status === 'engine-fallthrough');
  assert.deepEqual(fell.map((e) => e.detail.split(':')[0]), ['claude-cli'], 'only claude-cli falls through (ollama is last)');
});

// (8) AGENTIC_ENGINE=free is an explicit alias for the same free chain.
test('AGENTIC_ENGINE=free selects the free chain explicitly', async () => {
  const dir = seedRepo();
  const urls = [];
  const spawnFn = () => ({ status: 1, stdout: '', stderr: 'please run /login' });
  const fetchFn = async (url) => { urls.push(url); throw new Error('ECONNREFUSED'); };
  await assert.rejects(
    () => withEngine('free', () => codeAgentically({ task: 'x', repoRoot: dir, gate: makeGate(dir), fetchFn, spawnFn, assertWritable: () => {} })),
    /ECONNREFUSED|network error/,
  );
  assert.ok(!urls.some((u) => u.includes('api.anthropic.com') || u.includes('api.groq.com')), 'free = no paid/hosted calls');
});
