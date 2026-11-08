// Brain activity feeds (brain/lib/activity.mjs) — what changed, and what was asked.
//
// The gap this closes: a READ leaves no trace in a vault of notes, so "what did a Claude session ask
// the brain?" was unanswerable. Writes were recoverable in principle (facts carry `recorded_at` / `by`)
// but nothing assembled them into a feed. Both now feed the Chronos Brain menu.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  buildChanges, buildActivity, groupByDay, summarizeArgs,
  appendAccess, readAccess, accessLogPath, isWriteTool, normalizeClientIdentity,
  normalizeRegisteredSource,
} from './activity.mjs';

const scratch = () => mkdtempSync(join(tmpdir(), 'activity-test-'));
const f = (o) => ({ subject: 'Seen', predicate: 'users_total', object: '7', ...o });

// ---------------------------------------------------------------------------
// changes feed
// ---------------------------------------------------------------------------

test('changes are newest-first regardless of input order', () => {
  const rows = buildChanges([
    f({ recorded_at: '2026-08-01T10:00:00Z', object: 'a' }),
    f({ recorded_at: '2026-08-12T09:00:00Z', object: 'c' }),
    f({ recorded_at: '2026-08-05T10:00:00Z', object: 'b' }),
  ]);
  assert.deepEqual(rows.map((r) => r.object), ['c', 'b', 'a']);
});

test('a fact that supersedes an earlier value reads as "changed", otherwise "added"', () => {
  const rows = buildChanges([
    f({ recorded_at: '2026-08-02T00:00:00Z', supersedes: 'users-total-1' }),
    f({ recorded_at: '2026-08-01T00:00:00Z' }),
  ]);
  assert.equal(rows[0].kind, 'changed');
  assert.equal(rows[1].kind, 'added');
});

test('a closed fact is marked retired so history cannot read as still true', () => {
  const rows = buildChanges([f({ recorded_at: '2026-08-01T00:00:00Z', valid_to: '2026-08-05' })]);
  assert.equal(rows[0].retired, true);
});

test('facts written before provenance existed still sort, via recorded then valid_from', () => {
  const rows = buildChanges([
    f({ valid_from: '2026-07-01', object: 'oldest' }),          // no recorded_at, no recorded
    f({ recorded: '2026-07-15', object: 'middle' }),            // date-only provenance
    f({ recorded_at: '2026-08-01T00:00:00Z', object: 'newest' }),
  ]);
  assert.deepEqual(rows.map((r) => r.object), ['newest', 'middle', 'oldest']);
});

test('a fact with no timestamp at all is dropped rather than sorted to the top', () => {
  const rows = buildChanges([f({ object: 'undated' }), f({ recorded_at: '2026-08-01T00:00:00Z', object: 'ok' })]);
  assert.deepEqual(rows.map((r) => r.object), ['ok']);
});

test('a Claude session write carries its `by` and `change` through to the feed', () => {
  const rows = buildChanges([f({
    recorded_at: '2026-08-12T09:00:00Z', by: 'claude:session-2026-08-12', change: 'Recorded after verifying in code.',
  })]);
  assert.equal(rows[0].by, 'claude:session-2026-08-12');
  assert.equal(rows[0].change, 'Recorded after verifying in code.');
});

test('groupByDay buckets newest day first', () => {
  const g = groupByDay(buildChanges([
    f({ recorded_at: '2026-08-12T09:00:00Z' }), f({ recorded_at: '2026-08-12T11:00:00Z' }),
    f({ recorded_at: '2026-08-01T09:00:00Z' }),
  ]));
  assert.deepEqual(g.map((d) => d.day), ['2026-08-12', '2026-08-01']);
  assert.equal(g[0].items.length, 2);
});

// ---------------------------------------------------------------------------
// request log
// ---------------------------------------------------------------------------

test('the request log lives in a dot-dir so walkVault can never read it as a note', () => {
  assert.match(accessLogPath('/v'), /\/v\/\.access\/requests\.jsonl$/);
});

test('requests round-trip and come back newest-first', () => {
  const v = scratch();
  try {
    appendAccess(v, { at: '2026-08-12T09:00:00Z', tool: 'brain_search_facts', mode: 'read', ok: true });
    appendAccess(v, { at: '2026-08-12T10:00:00Z', tool: 'brain_add_fact', mode: 'write', ok: true });
    const rows = readAccess(v);
    assert.deepEqual(rows.map((r) => r.tool), ['brain_add_fact', 'brain_search_facts']);
  } finally { rmSync(v, { recursive: true, force: true }); }
});

test('a torn or partial line is skipped instead of breaking the whole feed', () => {
  const v = scratch();
  try {
    appendAccess(v, { at: '2026-08-12T09:00:00Z', tool: 'brain_overview', ok: true });
    const p = accessLogPath(v);
    writeFileSync(p, `${readFileSync(p, 'utf8')}{"at":"2026-08-12T10:00:00Z","tool":"trunc\n`);
    appendAccess(v, { at: '2026-08-12T11:00:00Z', tool: 'brain_timeline', ok: true });
    assert.deepEqual(readAccess(v).map((r) => r.tool), ['brain_timeline', 'brain_overview']);
  } finally { rmSync(v, { recursive: true, force: true }); }
});

test('reading a vault with no log yet is empty, not an error', () => {
  const v = scratch();
  try { assert.deepEqual(readAccess(v), []); } finally { rmSync(v, { recursive: true, force: true }); }
});

test('appendAccess never throws on an unwritable path — logging must not break a brain call', () => {
  // Portable unwritability. The original used '/proc/definitely/not/writable', which is nothing on
  // macOS but a real kernel filesystem on Linux — where mkdirSync HANGS on the GitHub runner instead
  // of throwing. That one line wedged every CI run for hours from the moment this file landed
  // (2026-08-12T10:53Z) until the per-file bisector named it. Never point a test at /proc.
  const root = scratch();
  try {
    // (1) a read-only parent: mkdir of .access inside it must throw EACCES → caught → false
    const sealed = join(root, 'sealed');
    mkdirSync(sealed);
    chmodSync(sealed, 0o444);
    assert.equal(appendAccess(join(sealed, 'vault'), { at: 'x', tool: 'y' }), false);
    // (2) a FILE where a directory is expected: mkdir under it must throw ENOTDIR → caught → false
    const file = join(root, 'not-a-dir');
    writeFileSync(file, 'plain file');
    assert.equal(appendAccess(file, { at: 'x', tool: 'y' }), false);
    // (3) no vault at all
    assert.equal(appendAccess(null, { at: 'x' }), false);
  } finally {
    try { chmodSync(join(root, 'sealed'), 0o755); } catch { /* already writable */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test('concurrent trimming retains every newly appended denied attempt', async () => {
  const v = scratch(); try {
    const p = accessLogPath(v); mkdirSync(join(v, '.access'), { recursive: true });
    writeFileSync(p, Array.from({ length: 6100 }, (_, i) => JSON.stringify({ at: `old-${i}`, tool: 'old' })).join('\n') + '\n');
    const modulePath = new URL('./activity.mjs', import.meta.url).pathname;
    const count = 30;
    const children = Array.from({ length: count }, (_, index) => new Promise((resolve, reject) => {
      const code = `import { appendAccess } from ${JSON.stringify(modulePath)}; appendAccess(process.env.TEST_VAULT, { at: new Date().toISOString(), tool: 'probe', by: process.env.TEST_ID, ok: false, error: 'denied' });`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
        env: { ...process.env, TEST_VAULT: v, TEST_ID: `denied-${index}` }, stdio: 'ignore',
      });
      child.on('error', reject);
      child.on('exit', (status) => status === 0 ? resolve() : reject(new Error(`audit child exited ${status}`)));
    }));
    await Promise.all(children);
    const retained = new Set(readAccess(v).filter((row) => row.tool === 'probe').map((row) => row.by));
    assert.equal(retained.size, count);
  } finally { rmSync(v, { recursive: true, force: true }); }
});

test('write tools are classified as writes, everything else as reads', () => {
  for (const t of ['brain_add_fact', 'brain_supersede_fact', 'brain_log_decision', 'brain_append_timeline']) {
    assert.equal(isWriteTool(t), true, t);
  }
  for (const t of ['brain_search_facts', 'brain_overview', 'brain_whats_changed', 'brain_get_entity']) {
    assert.equal(isWriteTool(t), false, t);
  }
});

test('MCP client identities are provider-aware and never default to Claude', () => {
  assert.equal(normalizeClientIdentity('codex-mcp-client'), 'codex');
  assert.equal(normalizeClientIdentity('Claude Code'), 'claude');
  assert.equal(normalizeClientIdentity('Anthropic Agent'), 'claude');
  assert.equal(normalizeClientIdentity('Seen Command Board Room'), 'seen-command');
  assert.equal(normalizeClientIdentity('My New Agent'), 'my-new-agent');
  assert.equal(normalizeClientIdentity(''), 'unidentified-client');
});

test('registered sources preserve role-qualified principals instead of collapsing providers', () => {
  assert.equal(normalizeRegisteredSource('Claude Brain'), 'claude-brain');
  assert.equal(normalizeRegisteredSource('claude-seenjobs'), 'claude-seenjobs');
  assert.notEqual(normalizeRegisteredSource('claude-brain'), normalizeRegisteredSource('claude-seenjobs'));
  assert.equal(normalizeRegisteredSource(''), 'unidentified-client');
});

test('summarizeArgs is a recognisable one-liner, truncated and bounded', () => {
  const s = summarizeArgs({ query: 'x'.repeat(200), subject: 'Seen', predicate: 'p', a: 1, b: 2, c: 3 });
  assert.ok(s.includes('…'), 'long values truncate');
  assert.ok(s.length < 400);
  assert.equal(summarizeArgs(null), '');
  assert.equal(summarizeArgs({ query: '', as_of: null }), '', 'empty values are omitted');
});

test('summarizeArgs never logs credentials or file/body payloads', () => {
  const line = summarizeArgs({ uploadId: 'u1', data: 'private bytes', credential: 'chr_secret', text: 'private note' });
  assert.match(line, /uploadId: u1/); assert.match(line, /data: \[13 chars\]/);
  assert.match(line, /credential: \[redacted\]/); assert.match(line, /text: \[12 chars\]/);
  assert.equal(line.includes('private'), false); assert.equal(line.includes('chr_secret'), false);
});

// ---------------------------------------------------------------------------
// the assembled payload
// ---------------------------------------------------------------------------

test('buildActivity returns the three feeds with counts split by read vs write', () => {
  const v = scratch();
  try {
    appendAccess(v, { at: '2026-08-12T09:00:00Z', tool: 'brain_search_facts', mode: 'read', ok: true });
    appendAccess(v, { at: '2026-08-12T10:00:00Z', tool: 'brain_add_fact', mode: 'write', ok: true });
    const facts = Array.from({ length: 40 }, (_, i) =>
      f({ recorded_at: `2026-08-${String((i % 28) + 1).padStart(2, '0')}T09:00:00Z`, object: `v${i}` }));

    const a = buildActivity({ facts, vaultPath: v, recentLimit: 10 });
    assert.equal(a.recent.length, 10, 'latest is capped');
    assert.equal(a.all.length, 40, 'all holds everything');
    assert.equal(a.counts.requests, 2);
    assert.equal(a.counts.requestReads, 1);
    assert.equal(a.counts.requestWrites, 1);
    assert.equal(a.newestRequestAt, '2026-08-12T10:00:00Z');
    assert.equal(a.recent[0].at, a.all[0].at, 'both feeds start at the newest change');
  } finally { rmSync(v, { recursive: true, force: true }); }
});

test('buildActivity attributes changes by author, so a Claude session is distinguishable', () => {
  const a = buildActivity({ facts: [
    f({ recorded_at: '2026-08-12T09:00:00Z', by: 'claude:session-a' }),
    f({ recorded_at: '2026-08-12T08:00:00Z', by: 'claude:session-a' }),
    f({ recorded_at: '2026-08-12T07:00:00Z', by: 'engine/run.mjs' }),
    f({ recorded_at: '2026-08-12T06:00:00Z' }),
  ] });
  assert.equal(a.counts.byAuthor['claude:session-a'], 2);
  assert.equal(a.counts.byAuthor['engine/run.mjs'], 1);
  assert.equal(a.counts.byAuthor.unattributed, 1);
});

test('buildActivity with no vault path still returns the changes feed', () => {
  const a = buildActivity({ facts: [f({ recorded_at: '2026-08-12T09:00:00Z' })] });
  assert.equal(a.all.length, 1);
  assert.deepEqual(a.requests, []);
});

// ---------------------------------------------------------------------------
// session registry — cross-session presence
//
// seen-command sessions and seen (product) sessions both push updates to the site and could not see
// each other, so plans contradicted. Presence lives beside the request log in .access/.
// ---------------------------------------------------------------------------

test('a started session is active; ending it removes it', async () => {
  const A = await import('./activity.mjs');
  const v = scratch();
  try {
    A.appendSession(v, { at: '2026-08-12T10:00:00Z', event: 'start', session_id: 's1', repo: 'seen' });
    assert.equal(A.activeSessions(v, { now: '2026-08-12T11:00:00Z' }).length, 1);
    A.appendSession(v, { at: '2026-08-12T10:30:00Z', event: 'end', session_id: 's1', repo: 'seen' });
    assert.equal(A.activeSessions(v, { now: '2026-08-12T11:00:00Z' }).length, 0);
  } finally { rmSync(v, { recursive: true, force: true }); }
});

test('two sessions from different repos are both visible — the contradiction case', async () => {
  const A = await import('./activity.mjs');
  const v = scratch();
  try {
    A.appendSession(v, { at: '2026-08-12T10:00:00Z', event: 'start', session_id: 'a', repo: 'seen' });
    A.appendSession(v, { at: '2026-08-12T10:05:00Z', event: 'start', session_id: 'b', repo: 'seen-command' });
    const live = A.activeSessions(v, { now: '2026-08-12T10:10:00Z' });
    assert.deepEqual(live.map((s) => s.repo).sort(), ['seen', 'seen-command']);
  } finally { rmSync(v, { recursive: true, force: true }); }
});

test('a crashed session (no end event) goes stale instead of haunting the panel forever', async () => {
  const A = await import('./activity.mjs');
  const v = scratch();
  try {
    A.appendSession(v, { at: '2026-08-12T00:00:00Z', event: 'start', session_id: 'zombie', repo: 'seen' });
    assert.equal(A.activeSessions(v, { now: '2026-08-12T06:00:00Z' }).length, 1, 'within 12h: alive');
    assert.equal(A.activeSessions(v, { now: '2026-08-12T23:00:00Z' }).length, 0, 'past 12h: presumed dead');
  } finally { rmSync(v, { recursive: true, force: true }); }
});

test('buildActivity exposes active sessions and the count', async () => {
  const A = await import('./activity.mjs');
  const v = scratch();
  try {
    A.appendSession(v, { at: new Date().toISOString(), event: 'start', session_id: 'now1', repo: 'seen' });
    const a = A.buildActivity({ facts: [], vaultPath: v });
    assert.equal(a.counts.activeSessions, 1);
    assert.equal(a.sessions[0].session_id, 'now1');
  } finally { rmSync(v, { recursive: true, force: true }); }
});
