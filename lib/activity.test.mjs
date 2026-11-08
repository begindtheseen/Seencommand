import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logActivity, readActivity, activityDir } from './activity.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'seen-activity-'));
// The California day (owner, 2026-10-21: Pacific time everywhere) — the same key lib/activity.mjs files by.
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

test('logActivity writes ONE JSON line to today\'s California day-file under the injected dir', () => {
  const dir = tmp();
  const ev = logActivity({ kind: 'build', id: 'task-1', status: 'pr_ready', summary: 'built it', detail: 'x' }, dir);
  assert.ok(ev && ev.ts);
  assert.deepEqual(readdirSync(dir), [`${today()}.jsonl`]); // exactly the California day-file, nothing under SEEN_HOME
  const events = readActivity({ days: 2, dir });
  assert.equal(events.length, 1);
  assert.deepEqual(
    { kind: events[0].kind, id: events[0].id, status: events[0].status, summary: events[0].summary, detail: events[0].detail },
    { kind: 'build', id: 'task-1', status: 'pr_ready', summary: 'built it', detail: 'x' },
  );
  assert.match(events[0].ts, /^\d{4}-\d{2}-\d{2}T.*Z$/); // ISO/UTC timestamp
});

test('summary truncates to ~200 and detail to ~500', () => {
  const dir = tmp();
  logActivity({ kind: 'meeting', summary: 'S'.repeat(400), detail: 'D'.repeat(900) }, dir);
  const [e] = readActivity({ dir });
  assert.equal(e.summary.length, 200);
  assert.equal(e.detail.length, 500);
});

test('defaults: id/status/detail are null and kind falls back to "event"', () => {
  const dir = tmp();
  logActivity({ summary: 'no kind given' }, dir);
  const [e] = readActivity({ dir });
  assert.equal(e.id, null);
  assert.equal(e.status, null);
  assert.equal(e.detail, null);
  assert.equal(e.kind, 'event');
});

test('NEVER throws on an unwritable dir — returns null, does not raise', () => {
  const dir = tmp();
  const notADir = join(dir, 'afile');
  writeFileSync(notADir, 'x');                       // a FILE where a dir is expected → mkdir will ENOTDIR
  const r = logActivity({ kind: 'x', summary: 'y' }, join(notADir, 'nested'));
  assert.equal(r, null);                             // swallowed silently (to stderr), never thrown
});

test('readActivity merges the last N day-files oldest→newest; corrupt lines are skipped', () => {
  const dir = tmp();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '2026-07-16.jsonl'),
    JSON.stringify({ ts: '2026-07-16T00:00:00Z', kind: 'a', summary: 'day1-a' }) + '\n'
    + JSON.stringify({ ts: '2026-07-16T01:00:00Z', kind: 'a', summary: 'day1-b' }) + '\n');
  writeFileSync(join(dir, '2026-07-17.jsonl'),
    '{ this line is not valid json\n'
    + JSON.stringify({ ts: '2026-07-17T00:00:00Z', kind: 'b', summary: 'day2-a' }) + '\n');
  writeFileSync(join(dir, '2026-07-18.jsonl'),
    JSON.stringify({ ts: '2026-07-18T00:00:00Z', kind: 'c', summary: 'day3-a' }) + '\n');
  // last 2 day-files → only 17 + 18; the corrupt line on the 17th is dropped, the good one kept.
  assert.deepEqual(readActivity({ days: 2, dir }).map((e) => e.summary), ['day2-a', 'day3-a']);
  // widening the window brings day1 in, still oldest→newest.
  assert.deepEqual(readActivity({ days: 5, dir }).map((e) => e.summary), ['day1-a', 'day1-b', 'day2-a', 'day3-a']);
});

test('readActivity returns [] when the ledger dir does not exist yet', () => {
  assert.deepEqual(readActivity({ dir: join(tmpdir(), 'seen-activity-nope-zzz-does-not-exist') }), []);
});

test('activityDir anchors on the repo checkout (…/data/activity), not SEEN_HOME', () => {
  assert.match(activityDir(), /[/\\]data[/\\]activity$/);
});
