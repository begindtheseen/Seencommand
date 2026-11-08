import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { claudeCliHealth, clineCliHealth, defaultCliProbe, recordClineConnectionSuccess, resetCliHealthCache } from './credentials.mjs';

// Every probe below is INJECTED: these tests never spawn `claude` or `cline`, so they pass offline
// and on a machine where neither is installed.
const ok = (stdout) => ({ exitCode: 0, signal: null, stdout, stderr: '', error: null, timedOut: false });
const AUTH_OK = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'someone@example.com', orgId: 'org-abc', subscriptionType: 'max' });

// A probe that answers `--version` and `auth status` differently, and records what it was asked.
function scriptedClaude({ version = ok('2.1.231 (Claude Code)'), auth = ok(AUTH_OK) } = {}) {
  const calls = [];
  const probe = (bin, args) => { calls.push(args.join(' ')); return args[0] === '--version' ? version : auth; };
  probe.calls = calls;
  return probe;
}

function realBin(name = 'claude') {
  const dir = mkdtempSync(join(tmpdir(), 'seen-cli-health-'));
  const bin = join(dir, name);
  writeFileSync(bin, '#!/bin/sh\n');
  return { dir, bin };
}

test('a real Board Room Cline success becomes the secret-free Settings connection proof', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cline-health-'));
  const file = join(dir, 'connection.json');
  try {
    const out = recordClineConnectionSuccess({ provider: 'cline', model: 'codex', latencyMs: 123, costUsd: 0.01 }, { file });
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(out.ok, true);
    assert.equal(saved.model, 'codex');
    assert.equal(saved.source, 'board-room');
    assert.deepEqual(Object.keys(saved).sort(), ['at', 'costUsd', 'latencyMs', 'model', 'ok', 'provider', 'source'].sort());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a logged-in claude CLI reads healthy and reports version/plan without the account email or org id', () => {
  resetCliHealthCache();
  const { dir, bin } = realBin();
  try {
    const probe = scriptedClaude();
    const h = claudeCliHealth({ probe, bin });
    assert.equal(h.installed, true);
    assert.equal(h.runnable, true);
    assert.equal(h.authenticated, true);
    assert.equal(h.version, '2.1.231 (Claude Code)');
    assert.equal(h.plan, 'max');
    assert.deepEqual(probe.calls, ['--version', 'auth status --json'], 'auth is read from the free status command, not a token-spending -p run');
    const text = JSON.stringify(h);
    assert.doesNotMatch(text, /someone@example\.com/, 'the account email never leaves the module');
    assert.doesNotMatch(text, /org-abc/, 'the org id never leaves the module');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a logged-out claude CLI is authenticated:false with the /login fix, never healthy', () => {
  resetCliHealthCache();
  const { dir, bin } = realBin();
  try {
    const h = claudeCliHealth({ probe: scriptedClaude({ auth: ok(JSON.stringify({ loggedIn: false })) }), bin });
    assert.equal(h.runnable, true);
    assert.equal(h.authenticated, false);
    assert.match(h.reason, /not logged in/);
    assert.match(h.fix, /\/login/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an auth probe that fails or times out is UNKNOWN (null), never true', () => {
  const { dir, bin } = realBin();
  try {
    resetCliHealthCache();
    const timedOut = claudeCliHealth({ probe: scriptedClaude({ auth: { exitCode: null, signal: 'SIGKILL', stdout: '', stderr: '', error: 'ETIMEDOUT', timedOut: true } }), bin });
    assert.equal(timedOut.authenticated, null, 'a timeout is unknown, not healthy');
    assert.match(timedOut.reason, /UNKNOWN/);

    resetCliHealthCache();
    const garbled = claudeCliHealth({ probe: scriptedClaude({ auth: ok('not json at all') }), bin });
    assert.equal(garbled.authenticated, null);

    resetCliHealthCache();
    const oldCli = claudeCliHealth({ probe: scriptedClaude({ auth: { exitCode: 1, signal: null, stdout: '', stderr: "error: unknown command 'auth'", error: null, timedOut: false } }), bin });
    assert.equal(oldCli.authenticated, null, 'a CLI too old to report auth status is unknown, not logged out');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a non-zero exit on --version is never treated as installed-and-fine', () => {
  resetCliHealthCache();
  const { dir, bin } = realBin();
  try {
    const h = claudeCliHealth({ probe: () => ({ exitCode: 1, signal: null, stdout: '', stderr: 'boom', error: null, timedOut: false }), bin });
    assert.equal(h.runnable, false);
    assert.equal(h.authenticated, null);
    assert.match(h.reason, /exited 1/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The live failure on Brandon's machine, verified 2026-08-13: npm's global install left the Cline
// binary with an invalid ad-hoc signature, so macOS SIGKILLs it with ZERO bytes on stdout AND
// stderr. An empty-output kill must never read as an empty-but-fine result.
test('a SIGKILLed Cline (invalid code signature) is broken with the re-sign fix, not silent success', () => {
  resetCliHealthCache();
  const { dir, bin } = realBin('cline');
  try {
    const h = clineCliHealth({ probe: () => ({ exitCode: null, signal: 'SIGKILL', stdout: '', stderr: '', error: null, timedOut: false }), bin, lastTestFn: () => ({ ok: true, at: '2026-08-12T09:37:26.837Z' }) });
    assert.equal(h.installed, true);
    assert.equal(h.runnable, false, 'a killed binary is not runnable');
    assert.match(h.reason, /SIGKILL/);
    assert.match(h.reason, /code signature is invalid/);
    assert.match(h.fix, /agent:setup/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a recorded Cline success older than the installed binary is flagged stale, not green', () => {
  resetCliHealthCache();
  const { dir, bin } = realBin('cline');
  try {
    // The binary was just written; the recorded verdict is from 2020, so it tested a different build.
    const stale = clineCliHealth({ probe: () => ok('3.0.53'), bin, lastTestFn: () => ({ ok: true, at: '2020-01-01T00:00:00.000Z' }) });
    assert.equal(stale.runnable, true);
    assert.equal(stale.lastTestStale, true);
    assert.match(stale.reason, /stale/);

    resetCliHealthCache();
    const fresh = clineCliHealth({ probe: () => ok('3.0.53'), bin, lastTestFn: () => ({ ok: true, at: new Date(Date.now() + 60_000).toISOString() }) });
    assert.equal(fresh.lastTestStale, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a missing binary is missing, and health results are cached then released on reset', () => {
  resetCliHealthCache();
  const gone = clineCliHealth({ probe: () => { throw new Error('must not spawn for a missing binary'); }, bin: '/definitely/not/here/cline' });
  assert.equal(gone.installed, false);
  assert.match(gone.reason, /not installed/);

  resetCliHealthCache();
  const { dir, bin } = realBin();
  try {
    let spawns = 0;
    const probe = scriptedClaude();
    const counting = (b, a) => { spawns += 1; return probe(b, a); };
    const first = claudeCliHealth({ probe: counting, bin });
    const second = claudeCliHealth({ probe: counting, bin });
    assert.equal(first.cached, false);
    assert.equal(second.cached, true, 'repeat diagnostics reuse the cached verdict');
    assert.equal(spawns, 2, 'one --version + one auth status, and nothing more');
    assert.equal(second.authenticated, true);

    // An expired TTL re-probes rather than serving a verdict forever.
    let clock = 0;
    resetCliHealthCache();
    claudeCliHealth({ probe: counting, bin, now: () => clock, ttlMs: 1000 });
    clock = 5000;
    assert.equal(claudeCliHealth({ probe: counting, bin, now: () => clock, ttlMs: 1000 }).cached, false);
  } finally { rmSync(dir, { recursive: true, force: true }); resetCliHealthCache(); }
});

test('the default probe is bounded and reports a non-zero exit honestly, without spawning anything real', () => {
  let opts = null;
  const result = defaultCliProbe('/bin/whatever', ['--version'], 1234, {
    spawnSyncFn: (_bin, _args, o) => { opts = o; return { status: 3, signal: null, stdout: 'out', stderr: 'err', error: null }; },
  });
  assert.equal(opts.timeout, 1234, 'every probe spawn is time-bounded');
  assert.equal(opts.stdio[0], 'ignore', 'stdin is closed so an interactive prompt cannot hang the probe');
  assert.equal(result.exitCode, 3);
  assert.equal(result.timedOut, false);
  const timed = defaultCliProbe('/bin/whatever', [], 10, { spawnSyncFn: () => ({ status: null, signal: 'SIGKILL', stdout: '', stderr: '', error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) }) });
  assert.equal(timed.timedOut, true);
});
