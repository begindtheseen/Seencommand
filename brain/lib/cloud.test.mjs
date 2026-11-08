// Push clobber guard for the online brain (brain/lib/cloud.mjs).
//
// `pushBrain` upserts the whole local vault over the cloud copy. Before this guard, a push from the
// Mac (every board meeting does one) unconditionally overwrote `brain_notes` — so any write made
// online after this machine last synced was silently destroyed. The guard compares each cloud row
// against a locally persisted watermark and skips + lists the ones that moved.
//
// ⚠ NO LIVE NETWORK. Every test injects a fake `rest` implementation, so no fetch is ever made, and
// points SUPABASE_URL at an unroutable localhost port purely so `cloudConfigured()` returns true —
// if an injection ever regressed, the real client would fail to connect rather than touch the
// production brain. The watermark file is redirected into a temp dir.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Obviously-fake config, set BEFORE importing the module under test. lib/config.mjs never overrides
// an already-set key ("real env wins"), so these hold even on a machine whose .env has live keys.
process.env.SUPABASE_URL = 'http://127.0.0.1:1/never-reached';
process.env.SUPABASE_SERVICE_KEY = 'test-fake-not-a-real-key';

// Tripwire: if any code path ever bypasses the injected REST layer, fail loudly instead of
// reaching the network. Nothing in this file may perform real I/O against Supabase.
globalThis.fetch = () => { throw new Error('cloud.test.mjs attempted a real network call — the REST layer must be injected'); };

const { pushBrain, syncDown, pullBrain, planNotePush, mergeNoteText, classifyNoteDivergence, fetchBrainAccess,
  planTimelinePull, pullTimeline, parseTimelineSections, syncAccessClient, tsCanon } = await import('./cloud.mjs');

// --- a minimal in-memory stand-in for the PostgREST layer ---------------------
function mockRest(rowsByPath) {
  const calls = [];
  const rest = async (path, opts = {}) => {
    calls.push({ path, method: opts.method || 'GET', body: opts.body });
    if (opts.method === 'POST') return null; // upserts return=minimal
    if (path.startsWith('brain_notes?select=path,updated_at')) {
      return [...rowsByPath.values()].map((r) => ({ path: r.path, updated_at: r.updated_at }));
    }
    if (path.startsWith('brain_notes?select=')) return [...rowsByPath.values()];
    return [];
  };
  rest.calls = calls;
  // A note and its fact mirror travel together in ONE rpc/brain_replace_note transaction.
  rest.replaced = () => calls.filter((c) => c.method === 'POST' && c.path === 'rpc/brain_replace_note').map((c) => c.body);
  rest.notesPushed = () => rest.replaced().map((b) => b.p_path);
  rest.factsPushed = () => rest.replaced().flatMap((b) => b.p_facts);
  return rest;
}

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'cloud-test-'));
  const vault = join(root, 'vault');
  mkdirSync(vault, { recursive: true });
  return { root, vault, statePath: join(root, 'cloud-sync.json') };
}
const note = (vault, rel, text) => { mkdirSync(join(vault, rel, '..'), { recursive: true }); writeFileSync(join(vault, rel), text); };
const factNote = (subject, predicate, object) =>
  `---\ntitle: T\nfacts:\n  - id: ${subject}-${predicate}\n    subject: ${subject}\n    predicate: ${predicate}\n    object: ${object}\n    valid_from: 2026-07-10\n    valid_to: null\n---\n\nbody\n`;
const seedWatermarks = (statePath, notes) => writeFileSync(statePath, JSON.stringify({ syncedAt: 'x', notes }));

// ---------------------------------------------------------------------------
// planNotePush — the conflict rule itself (pure)
// ---------------------------------------------------------------------------

const remote = (rows) => new Map(rows.map((r) => [r.path, r]));

test('planNotePush: a note with no cloud row is pushed (nothing to clobber)', () => {
  const r = planNotePush([{ path: 'a.md', text: 'local' }], remote([]), {});
  assert.deepEqual(r.push.map((n) => n.path), ['a.md']);
  assert.equal(r.conflicts.length, 0);
});

test('planNotePush: identical content is UNCHANGED — not pushed, not a conflict', () => {
  // An upsert of identical content is not a no-op: it rewrites the row's updated_at, which stamps all
  // 60 notes with one timestamp every sync and fabricates a change signal for every other client.
  // Caught live by a seen session doing forensics on 2026-08-12.
  const r = planNotePush([{ path: 'a.md', text: 'same' }],
    remote([{ path: 'a.md', content: 'same', updated_at: '2026-07-20T00:00:00Z' }]), {});
  assert.equal(r.push.length, 0, 'identical content must not be re-upserted');
  assert.equal(r.conflicts.length, 0);
  assert.deepEqual(r.unchanged.map((u) => u.path), ['a.md']);
  assert.equal(r.unchanged[0].updated_at, '2026-07-20T00:00:00Z', 'carries the cloud stamp for the watermark');
});

test('pushBrain: an unchanged note is skipped but its watermark still reconciles', async () => {
  const { root, vault, statePath } = scratch();
  try {
    const same = factNote('Seen', 'mrr', '$0');
    note(vault, 'a.md', same);
    const rest = mockRest(new Map([['a.md', { path: 'a.md', content: same, updated_at: '2026-08-12T10:00:00Z' }]]));

    const r = await pushBrain(vault, { rest, statePath });
    assert.equal(r.unchanged, 1);
    assert.deepEqual(rest.notesPushed(), [], 'no upsert for identical content — updated_at is preserved');
    const mark = JSON.parse(readFileSync(statePath, 'utf8')).notes['a.md'];
    assert.equal(mark.at, '2026-08-12T10:00:00Z', 'watermark reconciled to the untouched cloud row');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('planNotePush: cloud row newer than the watermark + different content = conflict', () => {
  const r = planNotePush([{ path: 'a.md', text: 'local edit' }],
    remote([{ path: 'a.md', content: 'cloud edit', updated_at: '2026-07-20T10:00:00Z' }]),
    { 'a.md': '2026-07-20T09:00:00Z' });
  assert.equal(r.push.length, 0);
  assert.deepEqual(r.conflicts, [{ path: 'a.md', remoteUpdatedAt: '2026-07-20T10:00:00Z', lastSynced: '2026-07-20T09:00:00Z' }]);
});

test('planNotePush: cloud row still at the watermark = our edits sit on top, push allowed', () => {
  const r = planNotePush([{ path: 'a.md', text: 'local edit' }],
    remote([{ path: 'a.md', content: 'older', updated_at: '2026-07-20T09:00:00Z' }]),
    { 'a.md': '2026-07-20T09:00:00Z' });
  assert.deepEqual(r.push.map((n) => n.path), ['a.md']);
  assert.equal(r.conflicts.length, 0);
});

test('planNotePush: never synced + different content = conflict (conservative, no silent clobber)', () => {
  const r = planNotePush([{ path: 'a.md', text: 'local' }],
    remote([{ path: 'a.md', content: 'cloud', updated_at: '2026-07-20T10:00:00Z' }]), {});
  assert.equal(r.push.length, 0);
  assert.equal(r.conflicts[0].lastSynced, null);
});

test('planNotePush: force overrides every conflict', () => {
  const r = planNotePush([{ path: 'a.md', text: 'local' }],
    remote([{ path: 'a.md', content: 'cloud', updated_at: '2026-07-20T10:00:00Z' }]), {}, { force: true });
  assert.deepEqual(r.push.map((n) => n.path), ['a.md']);
  assert.equal(r.conflicts.length, 0);
});

// ---------------------------------------------------------------------------
// pushBrain — end to end over a temp vault + mocked REST
// ---------------------------------------------------------------------------

test('pushBrain: skips a note the cloud changed after our last sync, pushes the rest', async () => {
  const { root, vault, statePath } = scratch();
  try {
    note(vault, 'stale.md', factNote('Seen', 'mrr', '$99'));      // local, but cloud moved on
    note(vault, 'mine.md', factNote('Seen', 'users_total', '12')); // local-only edit
    const rest = mockRest(new Map([
      ['stale.md', { path: 'stale.md', content: factNote('Seen', 'mrr', '$100'), updated_at: '2026-07-20T10:00:00Z' }],
      ['mine.md', { path: 'mine.md', content: 'older text', updated_at: '2026-07-20T08:00:00Z' }],
    ]));
    seedWatermarks(statePath, { 'stale.md': '2026-07-20T09:00:00Z', 'mine.md': '2026-07-20T08:00:00Z' });

    const r = await pushBrain(vault, { rest, statePath });

    assert.deepEqual(rest.notesPushed(), ['mine.md'], 'the clobbering write must not be sent');
    assert.equal(r.notes, 1);
    assert.deepEqual(r.skipped.map((s) => s.path), ['stale.md']);
    // Facts derived from the skipped note are withheld too — they would reintroduce the stale value.
    assert.deepEqual(rest.factsPushed().map((f) => f.note), ['mine.md']);
    // The skipped note keeps its OLD watermark, so it stays flagged until reconciled.
    const marks = JSON.parse(readFileSync(statePath, 'utf8')).notes;
    assert.equal(marks['stale.md'], '2026-07-20T09:00:00Z');
    assert.equal(marks['mine.md'].at, '2026-07-20T08:00:00Z', 'refreshed from the row the server reports');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pushBrain: force pushes the conflicting note and reports nothing skipped', async () => {
  const { root, vault, statePath } = scratch();
  try {
    note(vault, 'stale.md', factNote('Seen', 'mrr', '$99'));
    const rest = mockRest(new Map([['stale.md', { path: 'stale.md', content: 'cloud wrote this', updated_at: '2026-07-20T10:00:00Z' }]]));
    seedWatermarks(statePath, { 'stale.md': '2026-07-20T09:00:00Z' });

    const r = await pushBrain(vault, { rest, statePath, force: true });

    assert.deepEqual(rest.notesPushed(), ['stale.md']);
    assert.equal(r.skipped.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pushBrain: identical local/cloud content is no conflict AND no re-upsert', async () => {
  const { root, vault, statePath } = scratch();
  try {
    const text = factNote('Seen', 'mrr', '$0');
    note(vault, 'same.md', text);
    // No watermark at all, and the cloud row is newer — but the bytes match, so nothing can be lost.
    // Since the timestamp-flattening fix, matching bytes also means no write: an upsert would rewrite
    // updated_at and fabricate a change signal for every other brain client.
    const rest = mockRest(new Map([['same.md', { path: 'same.md', content: text, updated_at: '2026-07-25T10:00:00Z' }]]));

    const r = await pushBrain(vault, { rest, statePath });

    assert.deepEqual(rest.notesPushed(), [], 'no upsert — the cloud row is already this content');
    assert.equal(r.skipped.length, 0, 'and no conflict either');
    assert.equal(r.unchanged, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pushBrain: a first-ever push to an empty cloud sends everything and records watermarks', async () => {
  const { root, vault, statePath } = scratch();
  try {
    note(vault, 'a.md', factNote('Seen', 'mrr', '$0'));
    note(vault, 'timeline/2026-07-10.md', '---\ntitle: 2026-07-10\ntype: daily\ndate: 2026-07-10\n---\n\n## Board meetings\n- ran\n');
    const rest = mockRest(new Map());

    const r = await pushBrain(vault, { rest, statePath });

    assert.equal(r.notes, 2);
    assert.equal(r.skipped.length, 0);
    assert.equal(r.episodes, 1, 'timeline sections still extracted');
    assert.ok(existsSync(statePath), 'watermarks persisted for the next push');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pushBrain: a corrupt watermark file degrades to "conflict", never to silent clobber', async () => {
  const { root, vault, statePath } = scratch();
  try {
    note(vault, 'a.md', factNote('Seen', 'mrr', '$0'));
    writeFileSync(statePath, 'not json {{{');
    const rest = mockRest(new Map([['a.md', { path: 'a.md', content: 'cloud copy', updated_at: '2026-07-20T10:00:00Z' }]]));

    const r = await pushBrain(vault, { rest, statePath });

    assert.equal(rest.notesPushed().length, 0);
    assert.deepEqual(r.skipped.map((s) => s.path), ['a.md']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pushBrain: the brain_facts payload carries provenance (recorded_at/by/change/supersedes)', async () => {
  const { root, vault, statePath } = scratch();
  try {
    note(vault, 'k.md', `---\ntitle: T\nfacts:\n  - id: seen-tier\n    subject: Seen\n    predicate: free_tier\n    object: 1 credit/day\n    valid_from: 2026-07-31\n    valid_to: null\n    recorded: 2026-07-31\n    recorded_at: "2026-07-31T10:00:00.000Z"\n    by: "claude:test"\n    change: cut 3 to 1 to protect margin\n    supersedes: seen-tier-old\n---\n\nbody\n`);
    const rest = mockRest(new Map());
    await pushBrain(vault, { rest, statePath });
    const f = rest.factsPushed().find((x) => x.id === 'seen-tier');
    assert.ok(f, 'the fact was pushed');
    assert.equal(f.recorded_at, '2026-07-31T10:00:00.000Z');
    assert.equal(f.by, 'claude:test');
    assert.equal(f.change, 'cut 3 to 1 to protect margin');
    assert.equal(f.supersedes, 'seen-tier-old');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pushBrain: a note and its exact fact mirror land in ONE atomic rpc/brain_replace_note', async () => {
  const { root, vault, statePath } = scratch();
  try {
    note(vault, 'k.md', factNote('Seen', 'mrr', '$100'));
    note(vault, 'plain.md', '# no facts here\n');
    const rest = mockRest(new Map());
    const out = await pushBrain(vault, { rest, statePath });
    assert.equal(out.atomic, true);
    const byPath = new Map(rest.replaced().map((b) => [b.p_path, b]));
    assert.deepEqual([...byPath.keys()].sort(), ['k.md', 'plain.md']);
    assert.equal(byPath.get('k.md').p_facts.length, 1);
    assert.equal(byPath.get('k.md').p_facts[0].note, 'k.md');
    assert.deepEqual(byPath.get('plain.md').p_facts, [], 'a factless note still clears any stale mirror rows');
    // The two-phase path is what let a note land without its facts (live 2026-09-10). It must not run.
    assert.equal(rest.calls.some((c) => c.method === 'POST' && (c.path === 'brain_notes' || c.path.startsWith('brain_facts'))), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pushBrain: a database without the RPC degrades loudly to the two-phase push instead of freezing', async () => {
  const { root, vault, statePath } = scratch();
  const warn = console.warn; const warned = []; console.warn = (...a) => warned.push(a.join(' '));
  try {
    note(vault, 'k.md', factNote('Seen', 'mrr', '$100'));
    const base = mockRest(new Map());
    const rest = async (path, opts = {}) => {
      if (path === 'rpc/brain_replace_note') {
        base.calls.push({ path, method: 'POST', body: opts.body });
        throw new Error('supabase POST rpc/brain_replace_note → 404: {"code":"PGRST202"}');
      }
      return base(path, opts);
    };
    const out = await pushBrain(vault, { rest, statePath });
    assert.equal(out.atomic, false);
    assert.match(warned.join('\n'), /brain_replace_note is missing/);
    const factCall = base.calls.find((c) => c.method === 'POST' && c.path.startsWith('brain_facts'));
    // Without a conflict target PostgREST cannot merge duplicate ids. The natural key is (note, id).
    assert.equal(factCall.path, 'brain_facts?on_conflict=note,id');
    assert.deepEqual(base.calls.filter((c) => c.method === 'POST' && c.path === 'brain_notes').flatMap((c) => c.body).map((r) => r.path), ['k.md']);
  } finally { console.warn = warn; rmSync(root, { recursive: true, force: true }); }
});

test('pushBrain: a real RPC failure is NOT swallowed by the missing-function fallback', async () => {
  const { root, vault, statePath } = scratch();
  try {
    note(vault, 'k.md', factNote('Seen', 'mrr', '$100'));
    const base = mockRest(new Map());
    const rest = async (path, opts = {}) => {
      // Shaped exactly like a real rest() error: it NAMES the function, and must still not be swallowed.
      if (path.startsWith('rpc/')) throw new Error('supabase POST rpc/brain_replace_note → 500: {"code":"40P01","message":"deadlock detected"}');
      return base(path, opts);
    };
    await assert.rejects(() => pushBrain(vault, { rest, statePath }), /deadlock detected/);
    assert.equal(base.calls.some((c) => c.method === 'POST'), false, 'nothing was written non-atomically');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// The watermark producers — syncDown / pullBrain must unblock the next push
// ---------------------------------------------------------------------------

test('syncDown records a watermark for every row it checked, which unblocks the next push', async () => {
  const { root, vault, statePath } = scratch();
  try {
    const cloudText = factNote('Seen', 'mrr', '$100');
    const rows = new Map([['a.md', { path: 'a.md', content: cloudText, updated_at: '2026-07-20T10:00:00Z' }]]);
    const rest = mockRest(rows);

    const s = await syncDown(vault, { rest, statePath });
    assert.equal(s.changed, 1);
    assert.equal(readFileSync(join(vault, 'a.md'), 'utf8'), cloudText);
    assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).notes['a.md'].at, '2026-07-20T10:00:00Z');

    // Now edit locally on top of the version we just reconciled with — that push must go through.
    note(vault, 'a.md', factNote('Seen', 'mrr', '$120'));
    const r = await pushBrain(vault, { rest: mockRest(rows), statePath });
    assert.equal(r.skipped.length, 0, 'a local edit on top of the synced version is not a conflict');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pullBrain watermarks only the notes it actually wrote', async () => {
  const { root, vault, statePath } = scratch();
  try {
    note(vault, 'kept.md', 'local copy that pullBrain leaves alone');
    const rest = mockRest(new Map([
      ['kept.md', { path: 'kept.md', content: 'cloud copy', updated_at: '2026-07-20T10:00:00Z' }],
      ['new.md', { path: 'new.md', content: 'cloud only', updated_at: '2026-07-20T11:00:00Z' }],
    ]));

    const p = await pullBrain(vault, { rest, statePath });
    assert.equal(p.written, 1);
    assert.equal(p.skipped, 1);

    const marks = JSON.parse(readFileSync(statePath, 'utf8')).notes;
    assert.equal(marks['new.md'].at, '2026-07-20T11:00:00Z');
    assert.equal(marks['kept.md'], undefined, 'an unreconciled note must stay conflict-eligible');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// PULL GUARD — syncDown must never destroy a local write
//
// The bug these lock down: syncDown wrote the cloud copy over local whenever the two differed, with
// no test of which side was newer. A local write is BY DEFINITION a difference, so Chronos (which
// polls syncDown) destroyed every locally written fact within one poll — and then advanced the push
// watermark, so the write could not be pushed either. Local lost twice.
// ---------------------------------------------------------------------------

// Two facts in one note, so a union is observable. `ids` picks which facts are present.
const multiFactNote = (ids, updated = '2026-07-10') => `---
title: T
updated: ${updated}
facts:
${ids.map((id) => `  - id: ${id}\n    subject: S-${id}\n    predicate: p\n    object: o-${id}\n    valid_from: 2026-07-10\n    valid_to: null`).join('\n')}
---

body
`;
const idsIn = (text) => [...text.matchAll(/^\s+-\s*id:\s*(.+)$/gm)].map((m) => m[1].trim());

test('classifyNoteDivergence: remote facts local lacks → merge to the union, local order first', () => {
  const c = classifyNoteDivergence(multiFactNote(['a']), multiFactNote(['b']));
  assert.equal(c.kind, 'merge');
  assert.deepEqual(idsIn(c.text), ['a', 'b']);
});

test('classifyNoteDivergence: local already has every remote fact → ahead, not a conflict', () => {
  assert.equal(classifyNoteDivergence(multiFactNote(['a', 'b']), multiFactNote(['a'])).kind, 'ahead');
});

test('classifyNoteDivergence: a differing body is a conflict, never a silent overwrite', () => {
  const local = multiFactNote(['a']);
  const c = classifyNoteDivergence(local, local.replace('body', 'DIFFERENT prose'));
  assert.equal(c.kind, 'conflict');
});

test('mergeNoteText advances `updated:` to the later of the two and keeps every fact', () => {
  const merged = mergeNoteText(multiFactNote(['a'], '2026-07-10'), multiFactNote(['b'], '2026-08-01'));
  assert.match(merged, /^updated: 2026-08-01$/m);
  assert.deepEqual(idsIn(merged), ['a', 'b']);
});

test('syncDown does NOT overwrite a locally written fact — it keeps the union (the regression)', async () => {
  const { root, vault, statePath } = scratch();
  try {
    note(vault, 'a.md', multiFactNote(['local-write']));
    const rest = mockRest(new Map([['a.md',
      { path: 'a.md', content: multiFactNote(['cloud-write']), updated_at: '2026-07-20T10:00:00Z' }]]));

    const s = await syncDown(vault, { rest, statePath });
    const after = readFileSync(join(vault, 'a.md'), 'utf8');
    assert.equal(s.merged, 1);
    assert.equal(s.changed, 0, 'the local file must not be replaced wholesale');
    assert.deepEqual(idsIn(after).sort(), ['cloud-write', 'local-write'], 'BOTH writes survive');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('syncDown DOES take the cloud copy when local is merely stale (hash matches last reconcile)', async () => {
  const { root, vault, statePath } = scratch();
  try {
    const reconciled = multiFactNote(['a']);
    note(vault, 'a.md', reconciled);
    // First sync with identical content records the hash of what we reconciled with.
    const same = mockRest(new Map([['a.md', { path: 'a.md', content: reconciled, updated_at: '2026-07-20T10:00:00Z' }]]));
    await syncDown(vault, { rest: same, statePath });

    // Cloud moves on; local was never touched. Since the restored-older-remote trap fix, this arrives
    // via the MERGE path (classify runs before the hash guard) — same resulting content, but a route
    // that can never delete local facts. What matters is the outcome: both facts present.
    const moved = mockRest(new Map([['a.md',
      { path: 'a.md', content: multiFactNote(['a', 'b']), updated_at: '2026-07-21T10:00:00Z' }]]));
    const s = await syncDown(vault, { rest: moved, statePath });
    assert.equal(s.merged + s.changed, 1, 'the remote update lands, by merge or take');
    assert.deepEqual(idsIn(readFileSync(join(vault, 'a.md'), 'utf8')), ['a', 'b']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('syncDown preserves local and reports a conflict when the divergence is unmergeable', async () => {
  const { root, vault, statePath } = scratch();
  try {
    const local = multiFactNote(['a']);
    note(vault, 'a.md', local);
    const rest = mockRest(new Map([['a.md',
      { path: 'a.md', content: local.replace('body', 'CLOUD prose'), updated_at: '2026-07-20T10:00:00Z' }]]));

    const s = await syncDown(vault, { rest, statePath });
    assert.equal(s.preserved, 1);
    assert.equal(s.conflicts[0].path, 'a.md');
    assert.equal(readFileSync(join(vault, 'a.md'), 'utf8'), local, 'local is byte-identical afterwards');
    // The watermark must stay absent so the push guard keeps flagging it.
    assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).notes['a.md'], undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('syncDown leaves a local-ahead note completely alone and stays quiet', async () => {
  const { root, vault, statePath } = scratch();
  try {
    const local = multiFactNote(['a', 'fresh-local']);
    note(vault, 'a.md', local);
    const rest = mockRest(new Map([['a.md',
      { path: 'a.md', content: multiFactNote(['a']), updated_at: '2026-07-20T10:00:00Z' }]]));

    const s = await syncDown(vault, { rest, statePath });
    assert.equal(s.ahead, 1);
    assert.equal(s.preserved, 0, 'an ordinary local write is not a conflict');
    assert.equal(readFileSync(join(vault, 'a.md'), 'utf8'), local);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('syncDown force:true still takes the cloud copy, for callers that mean it', async () => {
  const { root, vault, statePath } = scratch();
  try {
    note(vault, 'a.md', multiFactNote(['local-write']));
    const cloud = multiFactNote(['cloud-write']);
    const rest = mockRest(new Map([['a.md', { path: 'a.md', content: cloud, updated_at: '2026-07-20T10:00:00Z' }]]));

    const s = await syncDown(vault, { rest, statePath, force: true });
    assert.equal(s.changed, 1);
    assert.equal(readFileSync(join(vault, 'a.md'), 'utf8'), cloud);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a legacy string watermark still works and is never treated as a licence to overwrite', async () => {
  const { root, vault, statePath } = scratch();
  try {
    note(vault, 'a.md', multiFactNote(['local-write']));
    seedWatermarks(statePath, { 'a.md': '2026-07-01T00:00:00Z' }); // pre-hash format
    const rest = mockRest(new Map([['a.md',
      { path: 'a.md', content: multiFactNote(['cloud-write']), updated_at: '2026-07-20T10:00:00Z' }]]));

    const s = await syncDown(vault, { rest, statePath });
    assert.equal(s.changed, 0, 'no hash means unknown provenance, so local is protected');
    assert.deepEqual(idsIn(readFileSync(join(vault, 'a.md'), 'utf8')).sort(), ['cloud-write', 'local-write']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// The ahead-case watermark, and the oversized timeline section
//
// Both of these froze the real cloud brain at 2026-08-05 for a week:
//   • syncDown found local AHEAD of the cloud and left the watermark stale, so planNotePush then
//     refused to publish that note forever — a deadlock between two individually-correct guards.
//   • one timeline section exceeded the btree index limit, so the brain_timeline INSERT threw 54000
//     and aborted the WHOLE push — notes and facts never landed — and pushBrainSafe swallowed it.
// ---------------------------------------------------------------------------

test('syncDown advances the watermark when local is AHEAD, so the push is not deadlocked', async () => {
  const { root, vault, statePath } = scratch();
  try {
    // Local holds every remote fact plus one of its own.
    note(vault, 'a.md', multiFactNote(['shared', 'local-only']));
    const rows = new Map([['a.md',
      { path: 'a.md', content: multiFactNote(['shared']), updated_at: '2026-08-05T05:26:43Z' }]]);

    const s = await syncDown(vault, { rest: mockRest(rows), statePath });
    assert.equal(s.ahead, 1);
    assert.equal(s.changed, 0, 'local is never overwritten');
    const mark = JSON.parse(readFileSync(statePath, 'utf8')).notes['a.md'];
    assert.equal(mark.at, '2026-08-05T05:26:43Z', 'the watermark moves to the incorporated cloud version');

    // The push must now go through instead of being blocked forever.
    const r = await pushBrain(vault, { rest: mockRest(rows), statePath });
    assert.equal(r.skipped.length, 0, 'an ahead-of-cloud note must be publishable');
    assert.deepEqual(r.notes, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pushBrain publishes oversized timeline sections since the md5 key (migration 069)', async () => {
  // History: the old unique(date,heading,body) key capped btree entries at ~2704 bytes, so oversized
  // sections first ABORTED the whole push, then were SKIPPED as a workaround — silently withholding
  // seven real sections. The key is now (date,heading,body_md5), so any size publishes and the
  // on_conflict target must name the md5 column (an arbiter pointing at the dropped index would 400).
  const { root, vault, statePath } = scratch();
  try {
    const big = 'x'.repeat(3000);
    note(vault, 'timeline/2026-08-12.md', `---\ntitle: T\n---\n\n## Fine section\nshort body\n\n## Huge section\n${big}\n`);
    const rest = mockRest(new Map());

    const r = await pushBrain(vault, { rest, statePath });
    assert.deepEqual(rest.notesPushed(), ['timeline/2026-08-12.md']);
    const timelinePosts = rest.calls.filter((c) => c.method === 'POST' && c.path.startsWith('brain_timeline'));
    for (const c of timelinePosts) {
      assert.match(c.path, /on_conflict=date,heading,body_md5/, 'arbiter must be the md5 key');
      for (const row of c.body) assert.equal('body_md5' in row, false, 'generated column must never be sent');
    }
    const sent = timelinePosts.flatMap((c) => c.body).map((e) => e.heading);
    assert.ok(sent.includes('Fine section'), 'the small section is pushed');
    assert.ok(sent.includes('Huge section'), 'the oversized one now publishes too');
    assert.equal(r.episodes, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// fetchBrainAccess — cloud sessions' gateway audit, rendered beside local requests
// ---------------------------------------------------------------------------

test('fetchBrainAccess maps gateway rows including denials to the local request shape, tagged cloud', async () => {
  const rest = async () => ([{ at: '2026-08-12T12:00:00Z', op: 'notes', mode: 'read', by: 'unidentified', args: '', ok: false, ms: 0, error: 'Access denied: identify yourself.' }]);
  const rows = await fetchBrainAccess({ rest });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tool, 'notes');
  assert.equal(rows[0].origin, 'cloud');
  assert.equal(rows[0].by, 'unidentified');
  assert.equal(rows[0].ok, false);
  assert.equal(rows[0].error, 'Access denied: identify yourself.');
});

test('fetchBrainAccess is [] on any failure — the local feed must never break on the cloud one', async () => {
  const rows = await fetchBrainAccess({ rest: async () => { throw new Error('relation brain_access does not exist'); } });
  assert.deepEqual(rows, []);
});

// ---------------------------------------------------------------------------
// The restored-older-remote trap — real data loss, 2026-08-13
//
// A cloud client rewrote a note from a STALE copy (its record_fact rebuilds the whole note from what
// it last fetched), which moved updated_at. Locally, the 'ahead' path had stamped the watermark with
// the CURRENT local hash — so the old hash guard read "local == last reconciled" and took the
// restored-older remote, silently deleting every locally-written fact the stale copy never had.
// An entire session's writes vanished vault-wide this way.
// ---------------------------------------------------------------------------

test('syncDown never takes a remote that LACKS local facts, even when the hash guard matches', async () => {
  const { root, vault, statePath } = scratch();
  try {
    const localWithFacts = multiFactNote(['shared', 'mine-1', 'mine-2']);
    note(vault, 'a.md', localWithFacts);
    // Arm the trap exactly as production did: mark sha == hash of CURRENT local (the ahead stamp).
    seedWatermarks(statePath, { 'a.md': { at: '2026-08-13T04:00:00Z', sha: null } });
    const ahead = await syncDown(vault, { rest: mockRest(new Map([['a.md',
      { path: 'a.md', content: multiFactNote(['shared']), updated_at: '2026-08-13T04:00:00Z' }]])), statePath });
    assert.equal(ahead.ahead, 1, 'precondition: ahead stamps the watermark with the local hash');

    // A stale client now rewrites the remote note WITHOUT the local facts, moving updated_at.
    const s = await syncDown(vault, { rest: mockRest(new Map([['a.md',
      { path: 'a.md', content: multiFactNote(['shared']), updated_at: '2026-08-13T05:00:00Z' }]])), statePath });

    assert.equal(s.changed, 0, 'the restored-older remote must NOT be taken');
    assert.deepEqual(idsIn(readFileSync(join(vault, 'a.md'), 'utf8')).sort(),
      ['mine-1', 'mine-2', 'shared'], 'every local fact survives');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('syncDown still takes remote on a PROSE change when local is untouched since reconcile', async () => {
  const { root, vault, statePath } = scratch();
  try {
    const reconciledText = multiFactNote(['a']);
    note(vault, 'a.md', reconciledText);
    const same = mockRest(new Map([['a.md', { path: 'a.md', content: reconciledText, updated_at: '2026-08-13T04:00:00Z' }]]));
    await syncDown(vault, { rest: same, statePath }); // records the reconcile hash

    // Remote changes PROSE (not facts) — unmergeable divergence, but local is untouched → take it.
    const proseChanged = reconciledText.replace('body', 'rewritten prose from another machine');
    const s = await syncDown(vault, { rest: mockRest(new Map([['a.md',
      { path: 'a.md', content: proseChanged, updated_at: '2026-08-13T05:00:00Z' }]])), statePath });
    assert.equal(s.changed, 1, 'legitimate remote prose update still lands');
    assert.match(readFileSync(join(vault, 'a.md'), 'utf8'), /rewritten prose/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Closure is monotonic — the resurrection bug, 2026-08-13
//
// Unioning facts by id alone let a STALE copy's still-OPEN entry win over a CLOSED one. Since
// supersession is encoded only in valid_to, that resurrected retired facts and recreated the very
// contradictions their supersede had resolved. It happened twice in one night, and the second
// resurrection blocked every record_fact into the note with a contradiction error — a data-integrity
// bug that presented as a write outage.
// ---------------------------------------------------------------------------

// Same fact id, one side closed. `closed` controls valid_to.
const idNote = (id, closed, extra = []) => `---
title: T
updated: 2026-08-13
facts:
  - id: ${id}
    subject: S
    predicate: p
    object: o
    valid_from: 2026-08-13
    valid_to: ${closed ? '2026-08-13' : 'null'}
    invalidated: ${closed ? '2026-08-13' : 'null'}
${extra.map((e) => `  - id: ${e}\n    subject: S-${e}\n    predicate: p\n    object: o-${e}\n    valid_from: 2026-08-13\n    valid_to: null`).join('\n')}
---

body
`;
const isClosedInText = (text, id) => {
  const block = text.split(/^\s+- id: /m).find((b) => b.startsWith(id));
  return !!block && /valid_to:\s*2026-08-13/.test(block);
};

test('a CLOSED remote fact re-closes a locally-open one — retired facts never resurrect', () => {
  const local = idNote('f1', false);        // local still has it open (stale)
  const remote = idNote('f1', true);        // remote retired it
  const c = classifyNoteDivergence(local, remote);
  assert.equal(c.kind, 'merge', 'a closure difference is a real merge, not "ahead"');
  assert.ok(isClosedInText(c.text, 'f1'), 'the closed version wins');
});

test('local-ahead is still "ahead" when no closure differs', () => {
  const local = idNote('f1', false, ['f2']);
  const remote = idNote('f1', false);
  assert.equal(classifyNoteDivergence(local, remote).kind, 'ahead');
});

test('a locally-closed fact is NOT re-opened by a stale remote that still has it open', () => {
  const local = idNote('f1', true);
  const remote = idNote('f1', false);
  const c = classifyNoteDivergence(local, remote);
  // Nothing incoming and no re-closure needed: local already holds the retirement.
  assert.equal(c.kind, 'ahead');
  assert.ok(isClosedInText(local, 'f1'), 'local retirement stands');
});

test('closure and new facts merge together in one pass', () => {
  const local = idNote('f1', false);
  const remote = idNote('f1', true, ['f9']);
  const c = classifyNoteDivergence(local, remote);
  assert.equal(c.kind, 'merge');
  assert.ok(isClosedInText(c.text, 'f1'), 'the retirement lands');
  assert.match(c.text, /id: f9/, 'and the new remote fact lands too');
});

// ---------------------------------------------------------------------------
// TIMELINE PULL — brain_timeline used to be push-only, so a digest INSERTED in the cloud (either 4am
// routine, or any cloud session) landed in a table this Mac never read and Chronos never rendered.
// The pull is append-only: it must never lose, reorder, or re-append an entry.
// ---------------------------------------------------------------------------

const tlDay = (date, sections) => `---\ntitle: ${date}\ndate: ${date}\ntags: [timeline]\n---\n\n`
  + sections.map(([h, b]) => `## ${h}\n\n${b}`).join('\n\n') + '\n';

test('planTimelinePull appends only what is missing, and keeps every local section untouched', () => {
  const local = tlDay('2026-08-13', [['local entry', 'written on the Mac']]);
  const plan = planTimelinePull(local, [
    { heading: 'local entry', body: 'written on the Mac' },      // already held → skipped
    { heading: '4am — seenjobs.io: board count', body: 'still 27' },
  ], '2026-08-13');
  assert.equal(plan.added, 1);
  assert.match(plan.text, /## local entry/, 'the local section survives verbatim');
  assert.match(plan.text, /written on the Mac/);
  assert.match(plan.text, /## 4am — seenjobs\.io: board count/);
  assert.equal(parseTimelineSections(plan.text).length, 2);
});

test('planTimelinePull is idempotent — a second pass over the same rows adds nothing', () => {
  const rows = [{ heading: 'digest', body: 'body text' }];
  const first = planTimelinePull(tlDay('2026-08-13', []), rows, '2026-08-13');
  assert.equal(first.added, 1);
  assert.equal(planTimelinePull(first.text, rows, '2026-08-13'), null);
});

test('planTimelinePull matches on the TRIMMED body, so whitespace never duplicates an entry', () => {
  const local = tlDay('2026-08-13', [['digest', 'body text']]);
  assert.equal(planTimelinePull(local, [{ heading: 'digest', body: '  body text\n\n' }], '2026-08-13'), null);
});

test('planTimelinePull creates a day-note with vault frontmatter when none exists', () => {
  const plan = planTimelinePull(null, [{ heading: 'first ever', body: 'b' }], '2026-08-14');
  assert.match(plan.text, /^---\ntitle: 2026-08-14\ntype: daily\ndate: 2026-08-14\ntags: \[timeline\]\n---/);
  assert.match(plan.text, /## first ever/);
});

test('planTimelinePull keeps two entries that share a heading but differ in body', () => {
  // In an append-only log a near-duplicate heading is strictly better than a lost entry.
  const local = tlDay('2026-08-13', [['status', 'first']]);
  const plan = planTimelinePull(local, [{ heading: 'status', body: 'second' }], '2026-08-13');
  assert.equal(plan.added, 1);
  assert.equal(parseTimelineSections(plan.text).length, 2);
});

test('planTimelinePull drops rows with an empty heading or body rather than writing junk', () => {
  assert.equal(planTimelinePull('', [{ heading: '', body: 'b' }, { heading: 'h', body: '  ' }], '2026-08-13'), null);
});

// --- the two-phase fetch ---------------------------------------------------
function tlRest(rows) {
  const calls = [];
  const md5 = (t) => require$md5(t);
  const rest = async (path) => {
    calls.push(path);
    if (path.startsWith('brain_timeline?select=date,heading,body_md5')) {
      return rows.map((r) => ({ date: r.date, heading: r.heading, body_md5: md5(r.body) }));
    }
    if (path.startsWith('brain_timeline?select=heading,body')) {
      const m = /date=eq\.(\d{4}-\d{2}-\d{2})/.exec(path);
      return rows.filter((r) => r.date === m[1]).map((r) => ({ heading: r.heading, body: r.body }));
    }
    return [];
  };
  rest.calls = calls;
  return rest;
}
const { createHash } = await import('node:crypto');
function require$md5(t) { return createHash('md5').update(String(t)).digest('hex'); }

test('pullTimeline writes a cloud-only digest into the vault and reports the day it touched', async () => {
  const s = scratch();
  const rest = tlRest([{ date: '2026-08-13', heading: '4am — applications: all clean', body: 'the digest' }]);
  const r = await pullTimeline(s.vault, { rest, days: 3, today: '2026-08-13' });
  assert.equal(r.added, 1);
  assert.deepEqual(r.days, ['2026-08-13']);
  const written = readFileSync(join(s.vault, 'timeline', '2026-08-13.md'), 'utf8');
  assert.match(written, /## 4am — applications: all clean/);
  assert.match(written, /the digest/);
  rmSync(s.root, { recursive: true, force: true });
});

test('pullTimeline skips the expensive body fetch entirely when nothing is missing', async () => {
  const s = scratch();
  mkdirSync(join(s.vault, 'timeline'), { recursive: true });
  writeFileSync(join(s.vault, 'timeline', '2026-08-13.md'), tlDay('2026-08-13', [['held', 'body']]));
  const rest = tlRest([{ date: '2026-08-13', heading: 'held', body: 'body' }]);
  const r = await pullTimeline(s.vault, { rest, days: 3, today: '2026-08-13' });
  assert.equal(r.added, 0);
  // Phase one only: the light (date,heading,body_md5) query, never a body fetch. This is what keeps
  // Chronos's 30-second poll cheap — steady state is one small request.
  assert.equal(rest.calls.length, 1);
  assert.match(rest.calls[0], /select=date,heading,body_md5/);
  rmSync(s.root, { recursive: true, force: true });
});

test('pullTimeline asks only for days inside the window', async () => {
  const s = scratch();
  const rest = tlRest([]);
  await pullTimeline(s.vault, { rest, days: 3, today: '2026-08-13' });
  assert.match(rest.calls[0], /date=gte\.2026-08-11/);
  rmSync(s.root, { recursive: true, force: true });
});

test('a timeline pull failure never sinks the note pull — notes are the load-bearing half', async () => {
  const s = scratch();
  note(s.vault, 'a.md', 'local');
  const rest = async (path) => {
    if (path.startsWith('brain_notes?select=path,content')) return [{ path: 'b.md', content: 'from cloud', updated_at: 't1' }];
    if (path.startsWith('brain_timeline')) throw new Error('timeline table unreachable');
    return [];
  };
  const r = await syncDown(s.vault, { rest, statePath: s.statePath });
  assert.equal(r.changed, 1, 'the cloud-only note still landed');
  assert.equal(r.timeline, 0, 'and the timeline count is honestly zero, not a crash');
  assert.equal(readFileSync(join(s.vault, 'b.md'), 'utf8'), 'from cloud');
  rmSync(s.root, { recursive: true, force: true });
});

test('syncAccessClient mirrors only the verifier record and never a client secret', async () => {
  const calls = [];
  const record = {
    id: 'client_1', name: 'codex', scopes: ['read', 'artifact:read'], salt: 'a'.repeat(32),
    lookup: 'c'.repeat(64), verifier: 'b'.repeat(64), createdAt: '2026-08-14T00:00:00.000Z', expiresAt: null,
    revokedAt: null, lastUsedAt: null,
  };
  const out = await syncAccessClient(record, { rest: async (path, opts) => { calls.push({ path, opts }); return null; } });
  assert.equal(out.synced, true); assert.equal(calls.length, 1);
  assert.match(calls[0].path, /^brain_clients\?on_conflict=id/);
  assert.deepEqual(calls[0].opts.body[0], {
    id: 'client_1', name: 'codex', scopes: ['read', 'artifact:read'], lookup: 'c'.repeat(64), salt: 'a'.repeat(32),
    verifier: 'b'.repeat(64), created_at: '2026-08-14T00:00:00.000Z', expires_at: null,
    revoked_at: null, last_used_at: null,
  });
  assert.equal(JSON.stringify(calls).includes('chr_'), false);
});

// ---------------------------------------------------------------------------
// INCREMENTAL SYNC — the egress fix (October 2026)
//
// Chronos polled syncDown every 30s and each tick downloaded the WHOLE vault (1.15 MB measured), and
// pushBrain did the same to compare. That blew the Supabase Free-plan 5 GB egress quota. These tests
// pin the new request shape: an idle vault costs one "[]", a change costs exactly that note, and none
// of the pull/push guards above loosen. The mock below HONOURS the PostgREST filters it is sent
// (gte/gt/in, order, limit, and a server row cap), so it can catch a filter that is wrong, not just
// a request that is missing.
// ---------------------------------------------------------------------------

function pgMock(initial = [], { cap = 1000, restamp = null } = {}) {
  const rows = new Map(initial.map((r) => [r.path, { ...r }]));
  const calls = [];
  const unq = (v) => v.replace(/\\(.)/g, '$1');
  const rest = async (path, opts = {}) => {
    const method = opts.method || 'GET';
    const [table, qs = ''] = path.split('?');
    if (method === 'POST') {
      if (table === 'rpc/brain_replace_note') {
        const b = opts.body;
        rows.set(b.p_path, { path: b.p_path, content: b.p_content, updated_at: restamp ? restamp(b.p_updated_at) : b.p_updated_at });
      }
      calls.push({ path, method, body: opts.body, bytes: 0 });
      return null;
    }
    let out = [];
    if (table === 'brain_notes') {
      const p = new URLSearchParams(qs);
      let list = [...rows.values()];
      for (const [k, val] of p) {
        if (k === 'select' || k === 'order' || k === 'limit') continue;
        const m = /^(gte|gt|in)\.([\s\S]*)$/.exec(val);
        assert.ok(m, `mock does not understand filter ${k}=${val}`);
        const get = (r) => (k === 'updated_at' ? tsCanon(r.updated_at) : String(r[k]));
        if (m[1] === 'gte') list = list.filter((r) => get(r) >= (k === 'updated_at' ? tsCanon(m[2]) : m[2]));
        if (m[1] === 'gt') list = list.filter((r) => get(r) > (k === 'updated_at' ? tsCanon(m[2]) : m[2]));
        if (m[1] === 'in') {
          const want = new Set([...m[2].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => unq(x[1])));
          list = list.filter((r) => want.has(String(r[k])));
        }
      }
      const key = (p.get('order') || 'path.asc').split('.')[0];
      const kv = (r) => (key === 'updated_at' ? tsCanon(r.updated_at) : r.path);
      list.sort((a, b) => (kv(a) < kv(b) ? -1 : kv(a) > kv(b) ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      list = list.slice(0, Math.min(Number(p.get('limit')) || Infinity, cap)); // the server's max-rows cap
      const fields = (p.get('select') || '').split(',');
      out = list.map((r) => Object.fromEntries(fields.map((f) => [f, r[f]])));
    }
    calls.push({ path, method, bytes: JSON.stringify(out).length });
    return out;
  };
  rest.rows = rows;
  rest.calls = calls;
  rest.reset = () => { calls.length = 0; };
  rest.gets = () => calls.filter((c) => c.method === 'GET');
  rest.noteGets = () => rest.gets().filter((c) => c.path.startsWith('brain_notes'));
  rest.contentGets = () => rest.gets().filter((c) => /select=path,content/.test(c.path));
  rest.inPaths = () => rest.contentGets().flatMap((c) => {
    const v = new URLSearchParams(c.path.split('?')[1]).get('path') || '';
    return [...v.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => unq(x[1]));
  });
  rest.set = (path, content, updated_at) => rows.set(path, { path, content, updated_at });
  return rest;
}

const T0 = Date.parse('2026-10-17T12:00:00Z');
const at = (ms) => new Date(ms).toISOString();
const MIN = 60 * 1000;
const clock = (ms) => () => ms;
const marksOf = (statePath) => JSON.parse(readFileSync(statePath, 'utf8')).notes;

// Three reconciled notes, stamped well before the window, and one deep pass at T0 to start from.
async function reconciledVault() {
  const s = scratch();
  const rest = pgMock([
    { path: 'a.md', content: multiFactNote(['a']), updated_at: at(T0 - 3 * 60 * MIN) },
    { path: 'b.md', content: multiFactNote(['b']), updated_at: at(T0 - 2 * 60 * MIN) },
    { path: 'timeline/2026-10-16.md', content: '---\ntitle: 2026-10-16\n---\n\n## x\n\ny\n', updated_at: at(T0 - 60 * MIN) },
  ]);
  const first = await syncDown(s.vault, { rest, statePath: s.statePath, now: clock(T0) });
  assert.equal(first.mode, 'deep', 'no cursor yet → the first pull is a deep one');
  assert.equal(first.changed, 3);
  rest.reset();
  return { ...s, rest };
}

test('incremental: an idle vault costs ONE request per tick, and it returns "[]"', async () => {
  const { root, vault, statePath, rest } = await reconciledVault();
  try {
    for (let i = 1; i <= 5; i++) {
      const r = await syncDown(vault, { rest, statePath, now: clock(T0 + i * MIN) });
      assert.equal(r.mode, 'fast');
      assert.equal(r.fetched, 0);
    }
    assert.equal(rest.calls.length, 5, 'one request per tick — no content, no timeline, no listing');
    for (const c of rest.calls) {
      assert.match(c.path, /^brain_notes\?select=path,updated_at&updated_at=gte\./);
      assert.doesNotMatch(c.path, /content/);
      assert.equal(c.bytes, 2, 'the whole response body is "[]"');
    }
    // The window starts at the PREVIOUS pass minus the overlap, URL-encoded.
    const since = new URLSearchParams(rest.calls[4].path.split('?')[1]).get('updated_at');
    assert.equal(since, `gte.${at(T0 + 4 * MIN - 10 * MIN)}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('incremental: a changed note is the ONLY note downloaded', async () => {
  const { root, vault, statePath, rest } = await reconciledVault();
  try {
    rest.set('b.md', multiFactNote(['b', 'b2']), at(T0 + 30 * 1000));
    const r = await syncDown(vault, { rest, statePath, now: clock(T0 + MIN) });
    assert.equal(r.mode, 'fast');
    assert.deepEqual(rest.inPaths(), ['b.md'], 'content is requested for b.md alone');
    assert.equal(rest.calls.length, 2, 'the window query + one content fetch');
    assert.deepEqual(idsIn(readFileSync(join(vault, 'b.md'), 'utf8')), ['b', 'b2']);
    assert.equal(marksOf(statePath)['b.md'].at, at(T0 + 30 * 1000));

    // The overlap window still returns b.md for the next ~10 min, as ~100 bytes — never re-downloaded.
    rest.reset();
    await syncDown(vault, { rest, statePath, now: clock(T0 + 2 * MIN) });
    assert.equal(rest.contentGets().length, 0, 'a reconciled row inside the overlap is de-duplicated by stamp');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('incremental: a remote deletion is detected on the slow pass; the local copy is KEPT', async () => {
  const { root, vault, statePath, rest } = await reconciledVault();
  const err = process.stderr.write; const said = []; process.stderr.write = (m) => { said.push(String(m)); return true; };
  try {
    rest.rows.delete('b.md');
    const fast = await syncDown(vault, { rest, statePath, now: clock(T0 + MIN) });
    assert.deepEqual(fast.remoteDeleted, [], 'a fast pass cannot see a deletion — and does not guess');

    const slow = await syncDown(vault, { rest, statePath, now: clock(T0 + 16 * MIN) });
    assert.equal(slow.mode, 'full', 'the ~15 min slow pass came due');
    assert.deepEqual(slow.remoteDeleted, ['b.md']);
    assert.ok(existsSync(join(vault, 'b.md')), 'a local file is never deleted by a pull');
    assert.equal(marksOf(statePath)['b.md'], undefined, 'the stale mark is retired');
    assert.match(said.join(''), /deleted or renamed in the cloud[\s\S]*b\.md/);
    assert.equal(rest.contentGets().length, 0, 'the slow pass listed stamps only — nothing else had moved');

    const again = await syncDown(vault, { rest, statePath, now: clock(T0 + 32 * MIN) });
    assert.deepEqual(again.remoteDeleted, [], 'reported once, not on every pass');
  } finally { process.stderr.write = err; rmSync(root, { recursive: true, force: true }); }
});

test('incremental: more than 1000 rows are PAGED — nothing past the server cap is dropped', async () => {
  const s = scratch();
  try {
    const N = 2500;
    const name = (i) => `bulk/n${String(i).padStart(4, '0')}.md`;
    const initial = Array.from({ length: N }, (_, i) => ({ path: name(i), content: `v1 ${i}`, updated_at: at(T0 - 60 * MIN) }));
    // A server cap LOWER than our page size: completeness must not depend on knowing the cap.
    const rest = pgMock(initial, { cap: 150 });
    const deep = await syncDown(s.vault, { rest, statePath: s.statePath, now: clock(T0) });
    assert.equal(deep.changed, N, 'every note restored, not the first 150 / 1000');
    assert.ok(rest.contentGets().length >= Math.ceil(N / 150), 'paged');
    assert.ok(rest.contentGets().slice(1).every((c) => /&path=gt\./.test(c.path)), 'by keyset on path, not offset');

    // 1,500 notes change at once (a forced push). The fast page fills, so the pull falls back to the
    // paged stamp listing and downloads exactly the changed 1,500.
    for (let i = 0; i < 1500; i++) rest.set(name(i), `v2 ${i}`, at(T0 + 10 * 1000));
    rest.reset();
    const r = await syncDown(s.vault, { rest, statePath: s.statePath, now: clock(T0 + MIN) });
    assert.equal(r.mode, 'full', 'a full fast page is a burst → paged listing');
    assert.equal(r.fetched, 1500);
    assert.equal(new Set(rest.inPaths()).size, 1500, 'only the changed notes were downloaded');
    assert.equal(readFileSync(join(s.vault, name(1499)), 'utf8'), 'v2 1499');
    assert.equal(readFileSync(join(s.vault, name(1500)), 'utf8'), 'v1 1500');
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test('incremental: a row sharing an already-reconciled stamp is NOT skipped (gte, not gt)', async () => {
  const { root, vault, statePath, rest } = await reconciledVault();
  try {
    // A push stamps every note with ONE `now` taken before its loop; c.md commits after we already
    // pulled a.md at that same stamp. A `gt <max stamp>` cursor would skip c.md forever.
    const stamp = at(T0 - 30 * 1000);
    rest.set('a.md', multiFactNote(['a', 'a2']), stamp);
    await syncDown(vault, { rest, statePath, now: clock(T0 + MIN) });
    rest.set('c.md', multiFactNote(['c']), stamp);
    rest.reset();
    const r = await syncDown(vault, { rest, statePath, now: clock(T0 + 2 * MIN) });
    assert.equal(r.mode, 'fast');
    assert.deepEqual(rest.inPaths(), ['c.md'], 'c.md is fetched; a.md (same stamp, reconciled) is not');
    assert.ok(existsSync(join(vault, 'c.md')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('incremental: a write from a clock running BEHIND the window lands on the next slow pass', async () => {
  const { root, vault, statePath, rest } = await reconciledVault();
  try {
    // Writer's clock is 2 h slow: its fresh write carries a stamp older than the fast window. The
    // fast pass honestly cannot see it; the slow pass compares stamps for INEQUALITY and must.
    rest.set('a.md', multiFactNote(['a', 'skewed']), at(T0 - 2 * 60 * MIN));
    const fast = await syncDown(vault, { rest, statePath, now: clock(T0 + MIN) });
    assert.equal(fast.fetched, 0);
    const slow = await syncDown(vault, { rest, statePath, now: clock(T0 + 16 * MIN) });
    assert.equal(slow.mode, 'full');
    assert.equal(slow.fetched, 1, 'caught by the stamp-inequality listing');
    assert.deepEqual(idsIn(readFileSync(join(vault, 'a.md'), 'utf8')), ['a', 'skewed']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('incremental: a content change that kept its stamp is caught by the daily deep pass', async () => {
  const { root, vault, statePath, rest } = await reconciledVault();
  try {
    const stamp = rest.rows.get('b.md').updated_at;
    rest.set('b.md', multiFactNote(['b', 'hand-sql']), stamp); // e.g. a hand SQL edit that forgot updated_at
    assert.equal((await syncDown(vault, { rest, statePath, now: clock(T0 + 16 * MIN) })).fetched, 0, 'invisible to stamps');
    const deep = await syncDown(vault, { rest, statePath, now: clock(T0 + 25 * 60 * MIN) });
    assert.equal(deep.mode, 'deep');
    assert.deepEqual(idsIn(readFileSync(join(vault, 'b.md'), 'utf8')), ['b', 'hand-sql']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('incremental: locally written, unpushed facts are still never overwritten', async () => {
  const { root, vault, statePath, rest } = await reconciledVault();
  try {
    // A local write the cloud has not seen yet.
    note(vault, 'a.md', multiFactNote(['a', 'local-unpushed']));
    // Remote unchanged → the pull does not even look at a.md, so it cannot touch it.
    await syncDown(vault, { rest, statePath, now: clock(T0 + MIN) });
    assert.deepEqual(idsIn(readFileSync(join(vault, 'a.md'), 'utf8')), ['a', 'local-unpushed']);

    // Remote moves with a STALE rewrite that lacks the local fact (the 2026-08-13 trap) → held.
    rest.set('a.md', multiFactNote(['a']), at(T0 + 90 * 1000));
    const held = await syncDown(vault, { rest, statePath, now: clock(T0 + 2 * MIN) });
    assert.equal(held.changed, 0);
    assert.deepEqual(idsIn(readFileSync(join(vault, 'a.md'), 'utf8')), ['a', 'local-unpushed']);

    // Remote moves with a NEW fact of its own → the union, both survive.
    rest.set('a.md', multiFactNote(['a', 'cloud-new']), at(T0 + 150 * 1000));
    const m = await syncDown(vault, { rest, statePath, now: clock(T0 + 3 * MIN) });
    assert.equal(m.merged, 1);
    assert.deepEqual(idsIn(readFileSync(join(vault, 'a.md'), 'utf8')).sort(), ['a', 'cloud-new', 'local-unpushed']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('incremental: an unmergeable conflict is not re-downloaded every tick, but IS re-checked on the slow pass', async () => {
  const { root, vault, statePath, rest } = await reconciledVault();
  const err = process.stderr.write; process.stderr.write = () => true;
  try {
    note(vault, 'b.md', multiFactNote(['b']).replace('body', 'LOCAL prose'));
    rest.set('b.md', multiFactNote(['b']).replace('body', 'CLOUD prose'), at(T0 + 30 * 1000));
    const c1 = await syncDown(vault, { rest, statePath, now: clock(T0 + MIN) });
    assert.equal(c1.preserved, 1);
    rest.reset();
    const c2 = await syncDown(vault, { rest, statePath, now: clock(T0 + 2 * MIN) });
    assert.equal(rest.contentGets().length, 0, 'the same conflicting version is not fetched again on a fast tick');
    assert.equal(c2.preserved, 0);
    // The owner reconciles by hand; the slow pass re-checks and the conflict clears.
    note(vault, 'b.md', rest.rows.get('b.md').content);
    const c3 = await syncDown(vault, { rest, statePath, now: clock(T0 + 17 * MIN) });
    assert.equal(c3.mode, 'full');
    assert.equal(c3.preserved, 0);
    assert.equal(marksOf(statePath)['b.md'].at, at(T0 + 30 * 1000), 'reconciled at last');
  } finally { process.stderr.write = err; rmSync(root, { recursive: true, force: true }); }
});

test('incremental: pushBrain reads stamps, not content — an unchanged vault pushes and downloads nothing', async () => {
  const { root, vault, statePath, rest } = await reconciledVault();
  try {
    const idle = await pushBrain(vault, { rest, statePath });
    assert.equal(idle.notes, 0);
    assert.equal(idle.unchanged, 3);
    assert.equal(rest.contentGets().length, 0, 'identical is known from the mark, without the content');
    assert.ok(rest.noteGets().every((c) => c.path.startsWith('brain_notes?select=path,updated_at')));

    // One local edit → exactly one RPC, no content download, and only that row re-read.
    note(vault, 'a.md', multiFactNote(['a', 'edited']));
    rest.reset();
    const r = await pushBrain(vault, { rest, statePath });
    assert.deepEqual(rest.calls.filter((c) => c.path === 'rpc/brain_replace_note').map((c) => c.body.p_path), ['a.md']);
    assert.equal(rest.contentGets().length, 0);
    const reread = rest.noteGets().filter((c) => /path=in\./.test(c.path));
    assert.equal(reread.length, 1);
    assert.match(decodeURIComponent(reread[0].path), /path=in\.\("a\.md"\)/);
    assert.equal(r.notes, 1);

    // The pushed stamp is ours, so the next pull does not re-download what we just uploaded. (push
    // stamps with the real clock, so put the pull cursor on the real clock too.)
    const st = JSON.parse(readFileSync(statePath, 'utf8'));
    const wall = Date.now();
    writeFileSync(statePath, JSON.stringify({ ...st, cursor: { pollFrom: wall, fullAt: wall, deepAt: wall } }));
    rest.reset();
    const pulled = await syncDown(vault, { rest, statePath, now: clock(wall + MIN) });
    assert.equal(pulled.mode, 'fast');
    assert.equal(pulled.checked, 1, 'the just-pushed row IS in the window…');
    assert.equal(rest.contentGets().length, 0, '…and is not downloaded back');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('incremental: pushBrain fetches content ONLY for a note whose cloud row moved — and still guards it', async () => {
  const { root, vault, statePath, rest } = await reconciledVault();
  const err = process.stderr.write; process.stderr.write = () => true;
  try {
    note(vault, 'a.md', multiFactNote(['a', 'local-edit']));
    rest.set('a.md', multiFactNote(['a', 'cloud-edit']), at(T0 + MIN)); // moved remotely, not yet pulled
    const r = await pushBrain(vault, { rest, statePath });
    assert.deepEqual(rest.inPaths(), ['a.md'], 'content for the moved note alone');
    assert.deepEqual(r.skipped.map((x) => x.path), ['a.md'], 'the clobber guard still holds');
    assert.equal(rest.calls.filter((c) => c.path === 'rpc/brain_replace_note').length, 0);
  } finally { process.stderr.write = err; rmSync(root, { recursive: true, force: true }); }
});

test('incremental: a legacy mark without a remote hash costs ONE content fetch, then none', async () => {
  const s = scratch();
  try {
    note(s.vault, 'a.md', 'same');
    const rest = pgMock([{ path: 'a.md', content: 'same', updated_at: '2026-07-20T10:00:00+00:00' }]);
    seedWatermarks(s.statePath, { 'a.md': { at: '2026-07-20T10:00:00Z', sha: null } }); // pre-rsha, other format
    await pushBrain(s.vault, { rest, statePath: s.statePath });
    assert.equal(rest.contentGets().length, 1);
    rest.reset();
    await pushBrain(s.vault, { rest, statePath: s.statePath });
    assert.equal(rest.contentGets().length, 0, 'the mark was upgraded with the remote hash');
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test('incremental: a post-push stamp that is not ours (trigger/racing writer) is verified once by the next pull', async () => {
  const s = scratch();
  try {
    note(s.vault, 'a.md', 'mine');
    const rest = pgMock([], { restamp: () => at(Date.now() + 5000) }); // the DB writes its own stamp
    await pushBrain(s.vault, { rest, statePath: s.statePath });
    assert.equal(marksOf(s.statePath)['a.md'].verify, true);
    rest.reset();
    const st = JSON.parse(readFileSync(s.statePath, 'utf8'));
    // Give it a cursor so the pull is a fast one.
    writeFileSync(s.statePath, JSON.stringify({ ...st, cursor: { pollFrom: Date.now(), fullAt: Date.now(), deepAt: Date.now() } }));
    await syncDown(s.vault, { rest, statePath: s.statePath, now: clock(Date.now() + MIN) });
    assert.deepEqual(rest.inPaths(), ['a.md'], 'the unattributed stamp is checked against content once');
    assert.equal(marksOf(s.statePath)['a.md'].verify, undefined);
    rest.reset();
    await syncDown(s.vault, { rest, statePath: s.statePath, now: clock(Date.now() + 2 * MIN) });
    assert.equal(rest.contentGets().length, 0, '…and then trusted');
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test('planNotePush: a cloud row stamped OLDER than the watermark (writer clock behind) is a conflict, not overwritten', () => {
  const r = planNotePush([{ path: 'a.md', text: 'local edit' }],
    remote([{ path: 'a.md', content: 'skewed cloud edit', updated_at: '2026-07-20T09:00:00Z' }]),
    { 'a.md': { at: '2026-07-20T10:00:00Z', sha: 'x', rsha: 'y' } });
  assert.equal(r.push.length, 0);
  assert.equal(r.conflicts.length, 1);
});

test('tsCanon: one instant in any PostgREST/ISO spelling is ONE stamp; microseconds are kept', () => {
  const a = tsCanon('2026-10-17T12:00:00.12Z');
  assert.equal(a, '2026-10-17T12:00:00.120000Z');
  assert.equal(tsCanon('2026-10-17T12:00:00.120+00:00'), a);
  assert.equal(tsCanon('2026-10-17 14:00:00.12+02'), a);
  assert.equal(tsCanon('2026-10-17T14:00:00.12+0200'), a);
  assert.notEqual(tsCanon('2026-10-17T12:00:00.120001+00:00'), a, 'sub-millisecond writes stay distinct');
  assert.equal(tsCanon('t1'), 't1', 'unparseable input compares only to itself');
  assert.equal(tsCanon(null), '');
});

test('incremental: the startup/meeting `full` option forces a listing even when a fast pass would do', async () => {
  const { root, vault, statePath, rest } = await reconciledVault();
  try {
    const r = await syncDown(vault, { rest, statePath, now: clock(T0 + MIN), full: true });
    assert.equal(r.mode, 'full');
    assert.equal(r.checked, 3);
    assert.equal(rest.contentGets().length, 0, 'a full pass over an unchanged vault still downloads no content');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
