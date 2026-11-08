// Tests for the streaming Board Room agent (engine/agent-chat.mjs). We inject a fake `spawn` that emits
// claude-CLI `--output-format stream-json` NDJSON so no real binary or login is needed: we prove the
// event stream is parsed into UI events, the final reply is captured, the session id round-trips, and a
// logged-out CLI degrades to the caller's single-shot fallback (honest, not fake).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runChatAgent, turnFailure, _internals } from './agent-chat.mjs';

// A fake child process: stdout/stderr are EventEmitters; it fires the scripted lines then closes.
function fakeSpawn(lines, { stderr = '', code = 0 } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      for (const l of lines) child.stdout.emit('data', Buffer.from(`${JSON.stringify(l)}\n`));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', code);
    });
    return child;
  };
}

test('parses a full stream into UI events + final reply, counts tools, keeps session id', async () => {
  const lines = [
    { type: 'system', subtype: 'init', session_id: 'sess-123', model: 'claude-opus-4-8', tools: [] },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Let me check the PR.' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'gh pr view 132' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'state: MERGED', is_error: false }] } },
    { type: 'result', subtype: 'success', is_error: false, session_id: 'sess-123', result: 'PR 132 merged cleanly; nothing went wrong.' },
  ];
  const events = [];
  const r = await runChatAgent({ message: 'look at pr 132', emit: (e) => events.push(e), spawnFn: fakeSpawn(lines) });

  assert.equal(r.engine, 'claude-cli');
  assert.equal(r.degraded, false);
  assert.equal(r.sessionId, 'sess-123');
  assert.equal(r.toolCount, 1);
  assert.match(r.reply, /merged cleanly/);
  assert.ok(events.some((e) => e.type === 'text' && /check the PR/.test(e.text)), 'streams assistant text');
  assert.ok(events.some((e) => e.type === 'tool' && e.name === 'Bash' && /gh pr view 132/.test(e.summary)), 'streams a tool chip');
  assert.ok(events.some((e) => e.type === 'tool_result' && e.ok), 'streams a tool result');
  assert.ok(events.some((e) => e.type === 'done'), 'ends with done');
});

test('a logged-out CLI degrades to the single-shot fallback, flagged honestly', async () => {
  const lines = [{ type: 'result', subtype: 'error', is_error: true, result: 'Invalid API key · Please run /login' }];
  const events = [];
  let fallbackCalled = false;
  const r = await runChatAgent({
    message: 'hi',
    emit: (e) => events.push(e),
    spawnFn: fakeSpawn(lines),
    fallback: async () => { fallbackCalled = true; return { reply: 'answer from memory', engine: 'groq' }; },
  });
  assert.equal(fallbackCalled, true);
  assert.equal(r.degraded, true);
  assert.equal(r.reply, 'answer from memory');
  assert.match(r.reason, /not logged in/);
  assert.ok(events.some((e) => e.type === 'status' && e.degraded), 'emits a degraded status');
});

test('a credit-balance string disguised as a successful result still falls back', async () => {
  const events = [];
  const r = await runChatAgent({
    message: 'show me your work', emit: (e) => events.push(e),
    spawnFn: fakeSpawn([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Credit balance is too low' }] } },
      { type: 'result', subtype: 'success', is_error: false, result: 'Credit balance is too low' },
    ]),
    fallback: async () => ({ reply: 'free lane answer', engine: 'groq' }),
  });
  assert.equal(r.reply, 'free lane answer'); assert.equal(r.engine, 'groq'); assert.equal(r.degraded, true);
  assert.ok(!events.some((e) => e.type === 'text' && /Credit balance/.test(e.text || '')));
});

test('unusableReason classifies logged-out, not-installed, vs normal output', () => {
  assert.match(_internals.unusableReason('Please run /login first'), /not logged in/);
  assert.match(_internals.unusableReason('spawn ENOEXEC'), /not fully installed/);
  assert.match(_internals.unusableReason('claude native binary not installed'), /not fully installed/);
  assert.equal(_internals.unusableReason('here is your answer'), null);
});

test('summarizeToolInput is compact and safe for each tool kind', () => {
  assert.equal(_internals.summarizeToolInput('Read', { file_path: '/x/y.mjs' }), '/x/y.mjs');
  assert.equal(_internals.summarizeToolInput('Grep', { pattern: 'foo' }), 'foo');
  assert.equal(_internals.summarizeToolInput('mcp__brain__brain_search_facts', { query: 'ghost rate' }), 'ghost rate');
  assert.doesNotThrow(() => _internals.summarizeToolInput('Weird', { a: 1 }));
});

test('the allow-list is read-only by default: no Write/Edit, no open-ended Bash', () => {
  const tools = _internals.allowedTools();
  assert.ok(tools.includes('Read') && tools.includes('Grep'), 'has reads');
  assert.ok(!tools.includes('Write') && !tools.includes('Edit'), 'no file mutation');
  assert.ok(!tools.some((t) => t === 'Bash' || t === 'Bash(*)'), 'no unrestricted Bash');
  assert.ok(tools.some((t) => /^Bash\(gh pr view/.test(t)), 'gh PR reads are allowed');
});

test('fresh platform and local evidence is injected into the full-agent prompt', async () => {
  let args = [];
  const spawnFn = (_bin, received) => {
    args = received;
    return fakeSpawn([{ type: 'result', subtype: 'success', is_error: false, result: 'grounded answer' }])();
  };
  const r = await runChatAgent({
    message: 'where is platformStatus implemented?',
    extraContext: 'LIVE PLATFORM SNAPSHOT: task #20 building\nREAD-ONLY LOCAL EVIDENCE: lib/platform-status.mjs:1',
    spawnFn,
  });
  assert.equal(r.reply, 'grounded answer');
  const prompt = args[args.indexOf('--append-system-prompt') + 1];
  assert.match(prompt, /task #20 building/);
  assert.match(prompt, /lib\/platform-status\.mjs:1/);
});

test('default Cline conversation arguments use plan-mode read tools without enabling Act writes', () => {
  const args = _internals.clineChatArgs({ selected: { provider: 'cline', model: 'codex' }, cwd: '/repo', timeoutMs: 60000, system: 'investigate', message: 'inspect it' });
  assert.ok(args.includes('--plan'));
  assert.ok(!args.includes('--id'), 'this Cline CLI rejects JSON follow-ups with --id; server injects local turn history instead');
  assert.equal(args[args.indexOf('--auto-approve') + 1], 'true', 'headless reads can execute');
  assert.ok(!args.includes('--yolo'));
  assert.ok(!args.includes('--worktree'));
});

test('Cline plan-mode read events become visible tool chips/results without exposing reasoning text', () => {
  const events = [];
  _internals.handleClineEvent({ type: 'agent_event', event: { type: 'content_start', contentType: 'reasoning', reasoning: 'private chain' } }, (e) => events.push(e));
  const started = _internals.handleClineEvent({ type: 'agent_event', event: { type: 'content_start', contentType: 'tool', toolName: 'read_files', input: { files: [{ path: '/repo/package.json' }] } } }, (e) => events.push(e));
  _internals.handleClineEvent({ type: 'agent_event', event: { type: 'content_end', contentType: 'tool', toolName: 'read_files', output: [{ result: 'name: seen-command' }] } }, (e) => events.push(e));
  assert.equal(started.tool, true);
  assert.ok(events.some((e) => e.type === 'tool' && e.name === 'read_files'));
  assert.ok(events.some((e) => e.type === 'tool_result' && /seen-command/.test(e.preview)));
  assert.ok(!JSON.stringify(events).includes('private chain'));
});

// ─── LANE CHOICE ─────────────────────────────────────────────────────────────────────────────────
// Brandon: the Board Room "can barely tell if its running half the time". On his machine the default
// lane (Cline) is SIGKILLed by macOS on every launch with zero bytes on stdout AND stderr, so the
// chat degraded on every turn with the reason "unknown". Both halves of that are fixed here: ask the
// lane before spawning it, and when something does fail, say exactly what and why.

const HEALTHY_CLINE = { installed: true, runnable: true, authenticated: null, reason: 'Cline runs' };
const KILLED_CLINE = { installed: true, runnable: false, authenticated: null, reason: 'Cline was killed by macOS the moment it launched (SIGKILL, no output) — its code signature is invalid', fix: 'Run `npm run agent:setup` to re-sign it.' };
const LIVE_CLAUDE = { installed: true, runnable: true, authenticated: true, reason: 'logged in via claude.ai (max plan)' };

test('a usable Cline lane is left alone', () => {
  const lane = _internals.chooseLiveLane({ cline: HEALTHY_CLINE, claude: LIVE_CLAUDE });
  assert.equal(lane.engine, 'cline');
  assert.equal(lane.notice, null);
});

test('an unknown Cline probe still routes to Cline — a slow probe is not a verdict', () => {
  const lane = _internals.chooseLiveLane({ cline: { installed: true, runnable: null, reason: 'probe timed out' }, claude: LIVE_CLAUDE });
  assert.equal(lane.engine, 'cline');
});

test('a dead Cline fails over to the logged-in claude CLI, and the switch is announced with the reason', () => {
  const lane = _internals.chooseLiveLane({ cline: KILLED_CLINE, claude: LIVE_CLAUDE });
  assert.equal(lane.engine, 'claude');
  assert.match(lane.notice, /Cline lane is down/);
  assert.match(lane.notice, /code signature is invalid/, 'the notice names WHY, not just THAT');
  assert.match(lane.notice, /agent:setup/, 'and carries the fix');
  assert.match(lane.reason, /SIGKILL/);
});

test('with both lanes down nothing is spawned and BOTH reasons are reported', () => {
  const lane = _internals.chooseLiveLane({ cline: KILLED_CLINE, claude: { installed: true, runnable: true, authenticated: false, reason: 'the claude CLI is installed but not logged in' } });
  assert.equal(lane.engine, 'none');
  assert.match(lane.reason, /code signature is invalid/);
  assert.match(lane.reason, /not logged in/);
});

test('a logged-out claude CLI is never chosen as the failover target', () => {
  for (const claude of [
    { installed: false, runnable: false, authenticated: null, reason: 'not installed' },
    { installed: true, runnable: true, authenticated: null, reason: 'login state is UNKNOWN' },
    { installed: true, runnable: false, authenticated: null, reason: 'will not run' },
  ]) {
    assert.equal(_internals.chooseLiveLane({ cline: KILLED_CLINE, claude }).engine, 'none', `unusable claude: ${claude.reason}`);
  }
});

test('exitFailureReason names the failure instead of shrugging "unknown"', () => {
  const kill = _internals.exitFailureReason('the Cline lane', { exitCode: null, signal: 'SIGKILL', stderr: '' });
  assert.match(kill, /killed by macOS/);
  assert.match(kill, /agent:setup/);
  assert.match(_internals.exitFailureReason('the claude CLI', { exitCode: 137, stderr: '' }), /killed by macOS/);
  assert.match(_internals.exitFailureReason('the Cline lane', { exitCode: 1, stderr: 'provider rejected the request' }), /exited 1: provider rejected the request/);
  assert.match(_internals.exitFailureReason('the claude CLI', { timedOut: true, timeoutMs: 60000 }), /did not answer within 60s/);
  assert.equal(_internals.exitFailureReason('the claude CLI', { exitCode: 0, stderr: '' }), null, 'a clean exit is not a failure');
});

test('a claude lane that dies without output degrades with the exit diagnosis, not "produced no answer"', async () => {
  const events = [];
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
    return child;
  };
  const r = await runChatAgent({ message: 'are you running?', emit: (e) => events.push(e), spawnFn, fallback: async () => ({ reply: 'from memory', engine: 'groq' }) });
  assert.equal(r.degraded, true);
  assert.match(r.reason, /killed by macOS/);
  assert.doesNotMatch(r.reason, /unknown/);
  assert.ok(events.some((e) => e.type === 'status' && e.degraded && /killed by macOS/.test(e.text)), 'the user is told which lane failed and why');
});

test('the ops master-kit is allow-listed and taught to both lanes', () => {
  assert.ok(_internals.allowedTools().includes('Bash(node scripts/ops.mjs:*)'), 'ops CLI is allow-listed');
  const prompt = _internals.appendSystemPrompt('');
  assert.match(prompt, /OPS MASTER-KIT/);
  assert.match(prompt, /scripts\/ops\.mjs/);
  assert.match(prompt, /diagnose --fix/);
});

test('turnFailure: a degraded or errored turn is a failure Seen Command tickets; an answer or an empty message is not', () => {
  assert.equal(turnFailure({ reply: 'Here is the answer', engine: 'cline-pass', degraded: false }), null);
  assert.equal(turnFailure({ reply: '', engine: 'none', degraded: true, reason: 'empty message' }), null);
  assert.equal(turnFailure({ reply: 'from memory', engine: 'fallback', degraded: true, reason: 'the claude CLI is logged out' }), 'the claude CLI is logged out');
  assert.equal(turnFailure({ reply: 'I hit an error: tool crashed', engine: 'claude-cli', degraded: false, reason: 'tool crashed' }), 'tool crashed');
  assert.equal(turnFailure(null), null);
});

test('the chat prompt files a ticket only behind a failure and merges only with Brandon’s phrase', () => {
  const p = _internals.appendSystemPrompt('');
  assert.match(p, /FILE ONE ticket with `ticket-new`/);
  assert.match(p, /Never file one for an idea that did not come from a failure/);
  assert.match(p, /Merge ONLY when Brandon replies with that phrase/);
  assert.doesNotMatch(p, /deploy, merge or close PRs/);
});

// Owner 2026-10-21: answers came back "memory-only · gemini" with a logged-in claude CLI. A failed Cline
// turn must retry on the claude CLI first, and only degrade when the claude CLI is not usable.
import { clineFailover } from './agent-chat.mjs';
test('a failed Cline turn retries on a logged-in claude CLI, with a visible notice', async () => {
  const events = []; let ran = 0;
  const onFail = clineFailover({ claudeHealth: () => ({ runnable: true, authenticated: true }), emit: (e) => events.push(e), run: async () => { ran++; return { reply: 'hi from claude', engine: 'claude-cli' }; } });
  const r = await onFail('the Cline lane was killed by macOS the instant it launched (SIGKILL, no output)');
  assert.equal(ran, 1); assert.equal(r.engine, 'claude-cli');
  assert.ok(events.some((e) => e.laneSwitch && /answering on the local claude CLI/.test(e.text) && /SIGKILL/.test(e.text)));
});
test('no retry when the claude CLI is logged out, unknown, or its probe throws', () => {
  for (const claudeHealth of [() => ({ runnable: true, authenticated: false }), () => ({ runnable: true, authenticated: null }), () => { throw new Error('probe'); }]) {
    let ran = 0;
    const onFail = clineFailover({ claudeHealth, run: () => { ran++; } });
    assert.equal(onFail('x'), null); assert.equal(ran, 0);
  }
});

// Owner 2026-10-21: `claude -p` worked in Terminal on Claude Max, but inside Seen Command the CLI said
// "logged in via api_key" and the Board Room fell back to memory-only — the app's ANTHROPIC_API_KEY leaked
// into the child and overrode the subscription login. The claude lane must never receive it.
test('the claude CLI lane never receives the app\'s ANTHROPIC_API_KEY (it must use its own login)', async () => {
  const saved = { k: process.env.ANTHROPIC_API_KEY, t: process.env.ANTHROPIC_AUTH_TOKEN };
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-real'; process.env.ANTHROPIC_AUTH_TOKEN = 'tok-test';
  try {
    let env = null;
    const spawnFn = (_bin, _args, opts) => { env = opts.env; return fakeSpawn([{ type: 'result', subtype: 'success', is_error: false, result: 'ok' }])(); };
    const r = await runChatAgent({ message: 'hi', spawnFn });
    assert.equal(r.reply, 'ok');
    assert.equal(env.ANTHROPIC_API_KEY, undefined); assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.ok(env.PATH && env.BRAIN_CLIENT, 'PATH and the brain identity still pass through');
  } finally {
    if (saved.k === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.k;
    if (saved.t === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN; else process.env.ANTHROPIC_AUTH_TOKEN = saved.t;
  }
});

// Owner 2026-10-21: "aggregate nasa jobs and import to seenjobs" was refused as "propose-not-do". The prompt
// must say a search IS the import and needs no approval.
test('the Board Room prompt says a job search is the import and runs without approval', () => {
  const p = _internals.appendSystemPrompt('');
  assert.match(p, /THIS IS HOW JOBS GET ONTO SEENJOBS\.IO/);
  assert.match(p, /aggregate NASA jobs and import them/);
  assert.match(p, /NOT a propose-only action/);
  assert.match(p, /running a search\/import, a meeting, or a job edit Brandon asked for through act\.mjs is NOT on this list/);
});
