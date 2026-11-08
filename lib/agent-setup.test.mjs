// lib/agent-setup.mjs — `npm run agent:setup` as a child process (the `fix-agents` verb), with a fake spawn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runAgentSetup } from './agent-setup.mjs';

function fakeSpawn({ code = 0, signal = null, out = [], err = [], hang = false } = {}) {
  const calls = [];
  const fn = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = () => { child.killed = true; queueMicrotask(() => child.emit('close', null, 'SIGTERM')); };
    if (!hang) queueMicrotask(() => { out.forEach((d) => child.stdout.emit('data', d)); err.forEach((d) => child.stderr.emit('data', d)); child.emit('close', code, signal); });
    return child;
  };
  fn.calls = calls;
  return fn;
}

test('a clean run reports ok with the output tail; it runs the setup script with a PATH that finds npm', async () => {
  const spawnFn = fakeSpawn({ out: ['[agent-setup] Cline 2.0.1 installed and executable.\n'] });
  const r = await runAgentSetup({ spawnFn, script: '/x/setup-coding-agent.mjs' });
  assert.equal(r.ok, true); assert.equal(r.code, 0); assert.match(r.tail, /Cline 2\.0\.1 installed/);
  assert.equal(spawnFn.calls[0].bin, process.execPath); assert.deepEqual(spawnFn.calls[0].args, ['/x/setup-coding-agent.mjs']);
  assert.match(spawnFn.calls[0].opts.env.PATH, /\/usr\/local\/bin/);
});

test('a failed run says how it ended and keeps the real error output', async () => {
  const r = await runAgentSetup({ spawnFn: fakeSpawn({ code: 1, err: ['npm ERR! code EACCES\n'] }) });
  assert.equal(r.ok, false); assert.match(r.error, /exit 1/); assert.match(r.tail, /EACCES/);
});

test('a run that hangs is stopped at the timeout, and a second request joins the running one', async () => {
  const spawnFn = fakeSpawn({ hang: true });
  const a = runAgentSetup({ spawnFn, timeoutMs: 30 });
  const b = runAgentSetup({ spawnFn, timeoutMs: 30 });
  assert.equal(a, b, 'one npm install at a time');
  const r = await a;
  assert.equal(r.ok, false); assert.match(r.error, /did not finish/); assert.equal(spawnFn.calls.length, 1);
});
