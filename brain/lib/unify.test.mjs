import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildUnifiedGraph, supersedeStaleSnapshotFacts } from './unify.mjs';

// A minimal command state.json with a couple of facts and one work edge. No Chronos vault → we test
// the command layer's temporal anchoring in isolation (the bug that made the time-slider look dead:
// command facts were valid_from:null = always-on, so scrubbing to the past changed nothing).
function fixtureState() {
  const dir = mkdtempSync(join(tmpdir(), 'unify-'));
  const state = {
    generatedAt: '2026-07-09T04:00:00.000Z',
    threads: [{ id: 't1', title: 'Ship it', area: 'product', priority: 1, status: 'open' }],
    departments: [{ id: 'product', title: 'Product', charter: 'build' }],
    memoryGraph: {
      nodes: [
        { id: 'Seen', label: 'Seen', group: 'entity' },
        { id: 'mrr', label: 'mrr: $0', group: 'value' },
        { id: 'product', label: 'product', group: 'dept' },
        { id: 'Ship it', label: 'Ship it', group: 'thread' },
      ],
      links: [
        { source: 'Seen', target: 'mrr', kind: 'fact' },
        { source: 'product', target: 'Ship it', kind: 'work' },
      ],
    },
  };
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
  return join(dir, 'state.json');
}

test('command facts are anchored at the board-meeting MINUTE, not always-on and not just the day', () => {
  const g = buildUnifiedGraph({ statePath: fixtureState(), vaultPath: null, today: '2026-07-09' });
  const fact = g.links.find((l) => l.kind === 'fact');
  assert.equal(fact.valid_from, '2026-07-09T04:00'); // minute precision: two same-day runs scrub in separately
});

test('command work edges are anchored too, so the whole layer scrubs in together', () => {
  const g = buildUnifiedGraph({ statePath: fixtureState(), vaultPath: null, today: '2026-07-09' });
  const work = g.links.find((l) => l.kind === 'work');
  assert.equal(work.valid_from, '2026-07-09T04:00');
});

test('minute stamps prefix-compare correctly against day-only dates (mixed granularity)', () => {
  // the renderer compares ISO strings — a day string sorts before any datetime within that day
  assert.ok('2026-07-09' <= '2026-07-09T04:00');
  assert.ok('2026-07-09T04:00' < '2026-07-09T22:14');
  assert.ok('2026-07-09T22:14' < '2026-07-10');
});

test('vault note nodes carry a minute-precision file-updated stamp', () => {
  const vault = mkdtempSync(join(tmpdir(), 'unify-vault-'));
  mkdirSync(join(vault, 'knowledge'), { recursive: true });
  writeFileSync(join(vault, 'knowledge', 'seen.md'), '# Seen\n\nA note.\n');
  const g = buildUnifiedGraph({ statePath: fixtureState(), vaultPath: vault, today: '2026-07-09' });
  const note = g.nodes.find((n) => n.type === 'note');
  assert.ok(note, 'vault note node exists');
  assert.match(String(note.updated), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/); // YYYY-MM-DDTHH:MM
});

test('the date range reaches the command run date so the slider can travel to it', () => {
  const g = buildUnifiedGraph({ statePath: fixtureState(), vaultPath: null, today: '2026-05-01' });
  // even with an earlier "today", the range must extend to cover the 2026-07-09 command snapshot
  assert.ok(g.dateRange.to >= '2026-07-09', `range.to ${g.dateRange.to} should reach the command date`);
});

// ---------------------------------------------------------------------------
// supersedeStaleSnapshotFacts — one answer per question in the graph
//
// The board-meeting snapshot (origin 'command') and the brain (origin 'chronos') describe the same
// quantities under the SAME subject+predicate. Nothing reconciled them, so a snapshot fact stayed open
// forever beside the brain's newer value and Chronos rendered both as true now: that is how it showed
// "users_total = 5" from a 2026-07-09 snapshot while the brain held 7, open since 07-20.
//
// The rule is recency, and it closes rather than deletes — the snapshot WAS true until the brain
// learned otherwise, so the time slider must still show it in the past.
// ---------------------------------------------------------------------------

const cf = (origin, subject, predicate, object, valid_from, valid_to = null) =>
  ({ kind: 'fact', origin, subject, predicate, object, valid_from, valid_to });

test('a snapshot fact the brain has since moved past is closed, not left open', () => {
  const links = [
    cf('command', 'Seen', 'users_total', '5', '2026-07-09T03:35'),
    cf('chronos', 'Seen', 'users_total', '7', '2026-07-20'),
  ];
  assert.equal(supersedeStaleSnapshotFacts(links), 1);
  const snap = links[0];
  assert.equal(snap.valid_to, '2026-07-20', 'closed exactly when the brain superseded it');
  assert.equal(snap.superseded_by, 'chronos');
  assert.equal(links[1].valid_to, null, 'the brain fact stays open');
});

test('a snapshot NEWER than the brain is left alone — the meeting saw fresher data', () => {
  const links = [
    cf('command', 'Seen', 'paid_users', '3', '2026-07-09T03:35'),
    cf('chronos', 'Seen', 'paid_users', '0', '2026-07-07'),
  ];
  assert.equal(supersedeStaleSnapshotFacts(links), 0);
  assert.equal(links[0].valid_to, null);
});

test('a same-day brain fact does not close the snapshot (no thrash on equal dates)', () => {
  const links = [
    cf('command', 'Seen', 'users_total', '5', '2026-07-20T03:35'),
    cf('chronos', 'Seen', 'users_total', '7', '2026-07-20'),
  ];
  assert.equal(supersedeStaleSnapshotFacts(links), 0);
});

test('only the NEWEST open brain fact decides, and closed brain history is ignored', () => {
  const links = [
    cf('command', 'Seen', 'users_total', '5', '2026-07-09T03:35'),
    cf('chronos', 'Seen', 'users_total', '99', '2026-08-01', '2026-08-02'), // retired
    cf('chronos', 'Seen', 'users_total', '6', '2026-07-16'),
    cf('chronos', 'Seen', 'users_total', '7', '2026-07-20'),
  ];
  assert.equal(supersedeStaleSnapshotFacts(links), 1);
  assert.equal(links[0].valid_to, '2026-07-20', 'the newest OPEN brain fact sets the close date');
});

test('matching is case-insensitive on subject and predicate', () => {
  const links = [
    cf('command', 'seen', 'Users_Total', '5', '2026-07-09T03:35'),
    cf('chronos', 'Seen', 'users_total', '7', '2026-07-20'),
  ];
  assert.equal(supersedeStaleSnapshotFacts(links), 1);
});

test('an unmatched snapshot fact and non-fact links are untouched', () => {
  const links = [
    cf('command', 'Seen', 'something_only_the_meeting_knows', '42', '2026-07-09T03:35'),
    { kind: 'bridge', origin: 'bridge', source: 'a', target: 'b' },
    cf('chronos', 'Seen', 'users_total', '7', '2026-07-20'),
  ];
  assert.equal(supersedeStaleSnapshotFacts(links), 0);
  assert.equal(links[0].valid_to, null);
  assert.equal(links[1].kind, 'bridge');
});

test('a live-layer fact is never retro-closed by the brain', () => {
  const links = [
    cf('live', 'Seen', 'users_total', '9', '2026-08-12'),
    cf('chronos', 'Seen', 'users_total', '7', '2026-07-20'),
  ];
  assert.equal(supersedeStaleSnapshotFacts(links), 0, 'only origin:command is reconciled');
  assert.equal(links[0].valid_to, null);
});
