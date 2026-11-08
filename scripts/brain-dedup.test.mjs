// brain-dedup — the SAFE cleanup for duplicate live facts already in the vault. Proves:
//   • planDedup (pure) picks out same subject+predicate facts that are BOTH open, keeps the newest,
//     and marks the rest for closing — without touching anything (dry-run correctness);
//   • applyDedup collapses those duplicates in a real vault: the older ones are CLOSED (valid_to +
//     invalidated set, bi-temporal — never hard-deleted), leaving exactly one live fact;
//   • off-topic/orphan candidates are REPORTED, never collapsed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readIndex } from '../brain/lib/vault.mjs';
import { planDedup, applyDedup } from './brain-dedup.mjs';

const NOTE = 'knowledge/seen-command.md';
const newVault = () => mkdtempSync(join(tmpdir(), 'dedup-vault-'));
const openIn = (dir) => readIndex(dir).facts.filter((f) => String(f.note) === NOTE && f.valid_to == null);
const allIn = (dir) => readIndex(dir).facts.filter((f) => String(f.note) === NOTE);

// A note whose `facts:` block holds several ALL-OPEN facts — the exact residue of the append bug:
// three copies of the same subject+predicate (recorded on different days) plus one unrelated fact.
function writeDupNote(dir) {
  const doc = `---
title: Seen Command
facts:
  - id: seen-current_focus
    subject: Seen
    predicate: current_focus
    object: onboarding
    valid_from: 2026-07-10
    valid_to: null
    recorded: 2026-07-10
  - id: seen-current_focus-2
    subject: Seen
    predicate: current_focus
    object: retention
    valid_from: 2026-07-20
    valid_to: null
    recorded: 2026-07-20
  - id: seen-current_focus-3
    subject: Seen
    predicate: current_focus
    object: retention
    valid_from: 2026-07-31
    valid_to: null
    recorded: 2026-07-31
  - id: seen-open_prs
    subject: Seen
    predicate: open_prs
    object: 3
    valid_from: 2026-07-31
    valid_to: null
    recorded: 2026-07-31
---

body
`;
  mkdirSync(join(dir, 'knowledge'), { recursive: true });
  writeFileSync(join(dir, NOTE), doc);
}

test('planDedup: groups the three open current_focus copies, keeps the newest, marks two to close', () => {
  const dir = newVault();
  try {
    writeDupNote(dir);
    const plan = planDedup(readIndex(dir).facts);
    assert.equal(plan.collapses.length, 1, 'exactly one duplicate group (current_focus); open_prs is a singleton');
    const g = plan.collapses[0];
    assert.equal(g.predicate, 'current_focus');
    assert.equal(g.keep.id, 'seen-current_focus-3', 'newest (2026-07-31, highest id suffix) is kept');
    assert.deepEqual(g.close.map((f) => f.id).sort(), ['seen-current_focus', 'seen-current_focus-2']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('planDedup is a dry-run: it never mutates the vault', () => {
  const dir = newVault();
  try {
    writeDupNote(dir);
    const before = allIn(dir).length;
    planDedup(readIndex(dir).facts);
    assert.equal(allIn(dir).length, before, 'planning wrote nothing');
    assert.equal(openIn(dir).length, 4, 'all four facts still open before apply');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('applyDedup: collapses duplicates — one current_focus left open, the rest CLOSED as history', () => {
  const dir = newVault();
  try {
    writeDupNote(dir);
    const plan = planDedup(readIndex(dir).facts);
    const r = applyDedup(dir, plan, { date: '2026-08-03' });
    assert.equal(r.closed, 2);

    const ft = allIn(dir).filter((f) => f.predicate === 'current_focus');
    assert.equal(ft.length, 3, 'no fact hard-deleted — history preserved');
    const open = ft.filter((f) => f.valid_to == null);
    assert.equal(open.length, 1, 'exactly one live current_focus fact remains');
    assert.equal(open[0].id, 'seen-current_focus-3');
    assert.equal(open[0].object, 'retention');
    for (const closed of ft.filter((f) => f.valid_to != null)) {
      assert.equal(closed.valid_to, '2026-08-03');
      assert.equal(closed.invalidated, '2026-08-03', 'transaction time closed with valid time');
    }
    // The unrelated singleton is untouched and still live.
    assert.equal(openIn(dir).filter((f) => f.predicate === 'open_prs').length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('applyDedup is idempotent: a second run finds nothing left to collapse', () => {
  const dir = newVault();
  try {
    writeDupNote(dir);
    applyDedup(dir, planDedup(readIndex(dir).facts), { date: '2026-08-03' });
    const plan2 = planDedup(readIndex(dir).facts);
    assert.equal(plan2.collapses.length, 0, 'no duplicate live facts on the second pass');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('planDedup: low-confidence open facts are REPORTED for review, never collapsed', () => {
  const dir = newVault();
  try {
    const doc = `---
title: Notes
facts:
  - id: random-thing
    subject: Random topic
    predicate: note
    object: some off-topic aside
    valid_from: 2026-07-30
    valid_to: null
    confidence: low
    recorded: 2026-07-30
---

body
`;
    mkdirSync(join(dir, 'knowledge'), { recursive: true });
    writeFileSync(join(dir, NOTE), doc);
    const plan = planDedup(readIndex(dir).facts);
    assert.equal(plan.collapses.length, 0, 'a singleton is not a duplicate');
    assert.equal(plan.review.length, 1, 'the low-confidence fact is flagged');
    assert.equal(plan.review[0].reason, 'low confidence');
    // Reported only — still fully intact and open.
    assert.equal(openIn(dir).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
