import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { clineSelection, configureCline, credentialStatus, DEFAULT_CLINE_MODEL, saveCredentials, startClineSignIn, testClineConnection } from './credentials.mjs';

test('credential status exposes booleans but never stored values', () => {
  const old = process.env.GROQ_API_KEY; process.env.GROQ_API_KEY = 'super-secret-value';
  try {
    const status = credentialStatus();
    assert.equal(status.groups.find((g) => g.id === 'ai').fields.find((f) => f.key === 'GROQ_API_KEY').configured, true);
    assert.doesNotMatch(JSON.stringify(status), /super-secret-value/);
  } finally { if (old === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = old; }
});

test('saveCredentials atomically updates only allowlisted keys and forces mode 0600', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seen-creds-')); const file = join(dir, '.env');
  writeFileSync(file, '# keep me\nGROQ_API_KEY=old\nGROQ_API_KEY=duplicate\nPORT=4173\n');
  saveCredentials({ values: { GROQ_API_KEY: 'new value#safe' } }, { file });
  const text = readFileSync(file, 'utf8');
  assert.match(text, /# keep me/); assert.match(text, /PORT=4173/);
  assert.equal((text.match(/GROQ_API_KEY=/g) || []).length, 1);
  assert.match(text, /GROQ_API_KEY="new value#safe"/);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('clear writes an explicit empty value so app updates cannot resurrect a bundled secret', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seen-creds-clear-')); const file = join(dir, '.env');
  writeFileSync(file, 'ANTHROPIC_API_KEY=old\n');
  saveCredentials({ clear: ['ANTHROPIC_API_KEY'] }, { file });
  assert.match(readFileSync(file, 'utf8'), /^ANTHROPIC_API_KEY=""/);
  assert.equal(process.env.ANTHROPIC_API_KEY, '');
});

test('credential writes reject unknown keys, multiline values, and symlinked targets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seen-creds-bad-')); const file = join(dir, '.env');
  assert.throws(() => saveCredentials({ values: { PATH: '/evil' } }, { file }), /not allowed/);
  assert.throws(() => saveCredentials({ values: { GITHUB_TOKEN: 'a\nb' } }, { file }), /newlines/);
  const target = join(dir, 'target'); writeFileSync(target, 'safe'); symlinkSync(target, file);
  assert.throws(() => saveCredentials({ values: { GITHUB_TOKEN: 'x' } }, { file }), /symlinked/);
  assert.equal(readFileSync(target, 'utf8'), 'safe');
});

test('Cline BYOK passes the key once to auth and never returns it', () => {
  const oldProvider = process.env.CLINE_PROVIDER; const oldModel = process.env.CLINE_MODEL;
  let call;
  try {
    const result = configureCline({ provider: 'anthropic', apiKey: 'cline-secret', model: 'claude-test' }, { spawnSyncFn: (bin, args, opts) => { call = { bin, args, opts }; return { status: 0 }; } });
    assert.deepEqual(call.args.slice(0, 3), ['auth', '--provider', 'anthropic']);
    assert.ok(call.args.includes('cline-secret'));
    assert.equal(call.opts.stdio[0], 'ignore');
    assert.doesNotMatch(JSON.stringify(result), /cline-secret/);
  } finally {
    if (oldProvider === undefined) delete process.env.CLINE_PROVIDER; else process.env.CLINE_PROVIDER = oldProvider;
    if (oldModel === undefined) delete process.env.CLINE_MODEL; else process.env.CLINE_MODEL = oldModel;
  }
});

test('Cline OAuth starts only an approved browser-auth provider', () => {
  let call;
  const child = { on() {}, unref() {} };
  assert.equal(startClineSignIn({ provider: 'cline' }, { spawnFn: (bin, args, opts) => { call = { bin, args, opts }; return child; } }).started, true);
  assert.deepEqual(call.args, ['auth', 'cline']);
  assert.throws(() => startClineSignIn({ provider: 'anthropic' }, { spawnFn: () => child }), /does not support/);
});

test('Cline selection defaults to GPT Codex and replaces a stale Qwen model', () => {
  const oldProvider = process.env.CLINE_PROVIDER; const oldModel = process.env.CLINE_MODEL;
  try {
    delete process.env.CLINE_PROVIDER; delete process.env.CLINE_MODEL;
    assert.deepEqual(clineSelection(), { provider: 'cline', model: DEFAULT_CLINE_MODEL });
    process.env.CLINE_MODEL = 'qwen/qwen3.8-max';
    assert.equal(clineSelection().model, DEFAULT_CLINE_MODEL);
  } finally {
    if (oldProvider === undefined) delete process.env.CLINE_PROVIDER; else process.env.CLINE_PROVIDER = oldProvider;
    if (oldModel === undefined) delete process.env.CLINE_MODEL; else process.env.CLINE_MODEL = oldModel;
  }
});

test('Cline connection test reports model/latency/cost and persists a non-secret verdict', () => {
  const oldHome = process.env.SEEN_HOME; const oldBin = process.env.CLINE_CLI_PATH; const oldProvider = process.env.CLINE_PROVIDER; const oldModel = process.env.CLINE_MODEL;
  const home = mkdtempSync(join(tmpdir(), 'seen-cline-status-')); const fakeBin = join(home, 'cline'); writeFileSync(fakeBin, 'fixture');
  try {
    process.env.SEEN_HOME = home; process.env.CLINE_CLI_PATH = fakeBin; process.env.CLINE_PROVIDER = 'cline'; process.env.CLINE_MODEL = DEFAULT_CLINE_MODEL;
    const stdout = `${JSON.stringify({ type: 'run_result', durationMs: 1234, text: 'CLINE_CONNECTION_OK', usage: { totalCost: 0.0042 }, model: { provider: 'cline', id: DEFAULT_CLINE_MODEL } })}\n`;
    const result = testClineConnection({}, { spawnSyncFn: (_bin, args) => { assert.ok(args.includes('--auto-approve') && args.includes('false')); return { status: 0, stdout, stderr: '' }; } });
    assert.equal(result.ok, true); assert.equal(result.model, DEFAULT_CLINE_MODEL); assert.equal(result.latencyMs, 1234); assert.equal(result.costUsd, 0.0042);
    assert.equal(credentialStatus().cline.lastTest.model, DEFAULT_CLINE_MODEL);
  } finally {
    if (oldHome === undefined) delete process.env.SEEN_HOME; else process.env.SEEN_HOME = oldHome;
    if (oldBin === undefined) delete process.env.CLINE_CLI_PATH; else process.env.CLINE_CLI_PATH = oldBin;
    if (oldProvider === undefined) delete process.env.CLINE_PROVIDER; else process.env.CLINE_PROVIDER = oldProvider;
    if (oldModel === undefined) delete process.env.CLINE_MODEL; else process.env.CLINE_MODEL = oldModel;
  }
});
