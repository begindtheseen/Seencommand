import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { issueClient } from '../lib/access-control.mjs';

const cli = new URL('./call.mjs', import.meta.url).pathname;
const run = (vault, argv, env = {}, input) => spawnSync(process.execPath, [cli, ...argv], {
  encoding: 'utf8', input,
  env: { ...process.env, CHRONOS_VAULT: vault, SEEN_REPO: join(vault, 'missing-seen'),
    BRAIN_CLIENT: '', BRAIN_CLIENT_TOKEN: '', BRAIN_CLIENT_CREDENTIAL_FILE: '', ...env },
});
const audit = (vault) => readFileSync(join(vault, '.access', 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

test('a shell call authenticates from the credential file and is audited as the source', () => {
  const vault = mkdtempSync(join(tmpdir(), 'brain-call-'));
  try {
    const issued = issueClient(vault, { name: 'codex', scopes: ['read', 'write'] });
    const file = join(vault, 'codex.token');
    writeFileSync(file, `${issued.secret}\n`, { mode: 0o600 });
    const r = run(vault, ['brain_contradictions'], { BRAIN_CLIENT: 'codex', BRAIN_CLIENT_CREDENTIAL_FILE: file });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /No contradictions/);
    const rows = audit(vault);
    assert.equal(rows.at(-1).by, 'codex');
    assert.equal(rows.at(-1).tool, 'brain_contradictions');
    assert.equal(rows.at(-1).ok, true);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('tool arguments can come from stdin and tools lists the catalog', () => {
  const vault = mkdtempSync(join(tmpdir(), 'brain-call-'));
  try {
    const issued = issueClient(vault, { name: 'codex', scopes: ['read', 'write'] });
    const env = { BRAIN_CLIENT: 'codex', BRAIN_CLIENT_TOKEN: issued.secret };
    const list = run(vault, ['tools'], env);
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /brain_add_fact/);
    const w = run(vault, ['brain_append_timeline', '-'], env,
      JSON.stringify({ heading: 'Shell call test', text: 'Verified the one-shot Brain CLI.', date: '2026-10-19' }));
    assert.equal(w.status, 0, w.stderr);
    assert.match(readFileSync(join(vault, 'timeline', '2026-10-19.md'), 'utf8'), /one-shot Brain CLI/);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('a missing or wrong credential is denied with a non-zero exit and the denial is audited', () => {
  const vault = mkdtempSync(join(tmpdir(), 'brain-call-'));
  try {
    issueClient(vault, { name: 'codex', scopes: ['read'] });
    const r = run(vault, ['brain_overview'], { BRAIN_CLIENT: 'codex', BRAIN_CLIENT_CREDENTIAL_FILE: join(vault, 'absent.token') });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Identify yourself/);
    assert.match(r.stderr, /Chronos → Access/);
    assert.equal(audit(vault).at(-1).ok, false);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('scope limits still apply: a read-only source cannot write through the shell', () => {
  const vault = mkdtempSync(join(tmpdir(), 'brain-call-'));
  try {
    const issued = issueClient(vault, { name: 'codex', scopes: ['read'] });
    const r = run(vault, ['brain_append_timeline', '{"text":"x"}'], { BRAIN_CLIENT: 'codex', BRAIN_CLIENT_TOKEN: issued.secret });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /lacks write permission/);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('usage errors exit 2 without starting a session', () => {
  const vault = mkdtempSync(join(tmpdir(), 'brain-call-'));
  try {
    assert.equal(run(vault, ['brain_overview']).status, 2, 'BRAIN_CLIENT is required');
    assert.equal(run(vault, ['brain_search_facts', 'not json'], { BRAIN_CLIENT: 'codex' }).status, 2);
    assert.equal(run(vault, []).status, 2);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});
