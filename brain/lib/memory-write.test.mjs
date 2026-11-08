// Serializer PARITY / drift guard for the shared brain writer.
//
// Seen Command and the `seen` repo write into the SAME brain (the Chronos vault + its Supabase
// mirror), through two copies of the same serializer:
//   this repo : brain/lib/memory-write.mjs (yamlScalar)  ⇄  brain/lib/chronos/memoryGraph.mjs (parseScalar)
//   seen repo : lib/server/writeFact.js    (emitVal)     ⇄  lib/server/memoryGraph.js         (parseScalar)
// This copy DRIFTED: it JSON-escaped double-quoted scalars while the parser stripped the quotes
// WITHOUT unescaping, so parse(write(x)) !== x for any value holding a `"` or `\`. Consequences
// that were actually observed in the brain:
//   • every writer's "unchanged → no-op" check compared a mis-read value against the real one and
//     never matched, so the board meeting re-superseded the SAME current_focus on every run;
//   • against seen's whole-block re-emitting writer, backslashes compounded n → 2n+1 per cycle.
// seen fixed its pair in commit 598cf4a; this file pins the same two properties here, over the
// SAME hostile vector set, so the copies cannot drift apart again silently.
//
// If you change either file, these must still hold for every vector:
//   parse(write(x)) === x                  (writer and parser are exact inverses)
//   write(parse(write(x))) === write(x)    (byte-level fixed point — escapes cannot grow)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addFact, supersedeFact, recordFact, closeFact, assertNotePath,
  appendTimeline, ensureTimelineFrontmatter } from './memory-write.mjs';
import { readIndex } from './vault.mjs';

const NOTE = 'seen-command-observations.md';

function newVault() { return mkdtempSync(join(tmpdir(), 'chronos-vault-')); }
const openFacts = (dir) => readIndex(dir).facts
  .filter((f) => String(f.note || '').endsWith(NOTE) && f.valid_to == null);
const factsIn = (dir) => readIndex(dir).facts.filter((f) => String(f.note || '').endsWith(NOTE));
const objectLine = (dir) => readFileSync(join(dir, NOTE), 'utf8')
  .split('\n').filter((l) => l.trim().startsWith('object:'));

test('timeline writer repairs a headerless existing day before appending', () => {
  const dir = newVault();
  try {
    mkdirSync(join(dir, 'timeline'));
    const path = join(dir, 'timeline', '2026-08-14.md');
    writeFileSync(path, '## Existing\n\nkept verbatim\n', { flag: 'wx' });
    appendTimeline(dir, { date: '2026-08-14', heading: 'New', text: 'added' });
    const text = readFileSync(path, 'utf8');
    assert.match(text, /^---\n/);
    assert.match(text, /^type: daily$/m);
    assert.match(text, /^date: 2026-08-14$/m);
    assert.match(text, /## Existing\n\nkept verbatim/);
    assert.match(text, /## New\n- added/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('timeline writer repairs type-less frontmatter even on an idempotent skip', () => {
  const dir = newVault();
  try {
    mkdirSync(join(dir, 'timeline'));
    const path = join(dir, 'timeline', '2026-08-13.md');
    writeFileSync(path, '---\ntitle: 2026-08-13\ndate: 2026-08-13\ntags: [timeline]\n---\n\n## Log\n- stable-key\n', { flag: 'wx' });
    const out = appendTimeline(dir, { date: '2026-08-13', heading: 'Log', text: 'stable-key', key: 'stable-key' });
    assert.equal(out.skipped, true);
    assert.equal(out.repaired, true);
    assert.match(readFileSync(path, 'utf8'), /^type: daily$/m);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('timeline header repair leaves malformed frontmatter unchanged', () => {
  const malformed = '---\ntitle: broken\n## body\n';
  assert.equal(ensureTimelineFrontmatter(malformed, '2026-08-14'), malformed);
});

// The exact vendored write path lib/brain.mjs `writeOne()` runs each board meeting: look up the
// currently-open fact, no-op when the value is unchanged, otherwise supersede. Returns 1 if it
// wrote. Reproduced here (rather than imported) so this test exercises brain/lib in isolation.
function boardMeetingWrite(dir, subject, predicate, object) {
  const obj = String(object);
  const cur = openFacts(dir).find((o) => String(o.subject).toLowerCase() === subject.toLowerCase()
    && String(o.predicate).toLowerCase() === predicate.toLowerCase());
  if (!cur) { addFact(dir, { note: NOTE, subject, predicate, object: obj, confidence: 'high', source: 'engine/run.mjs (board meeting)' }); return 1; }
  if (String(cur.object) !== obj) { supersedeFact(dir, { note: NOTE, id: cur.id, object: obj, confidence: 'high' }); return 1; }
  return 0; // unchanged
}

// ---------------------------------------------------------------------------
// The hostile vector set — kept identical to seen's lib/server/writeFact.test.mjs.
// Adding a vector here means adding it there too (and vice versa).
// ---------------------------------------------------------------------------
const HOSTILE = [
  ['double quotes + unicode middot', 'The "Optimized with Seen · seenjobs.io" PDF footer is mandatory'],
  ['single quotes', "it's a 'quoted' phrase"],
  ['windows path backslashes', 'C:\\Users\\you\\resume.pdf'],
  ['backslash immediately before a quote', 'a\\"b'],
  ['colons + em dash', 'ratio: 3:1 — measured on 2026-07-29'],
  ['brackets / wiki-link shape', '[[environment]] and [array, like]'],
  ['newlines-as-spaces', 'line one line two line three'],
  ['real newline + tab', 'newline\nliteral\ttab'],
  ['unicode accents + check', 'café ✓ — résumé · naïve'],
  ['leading hash (comment bait)', '# not a comment'],
  ['trailing space', 'trailing space '],
  ['leading space', '  leading space'],
  ['digit string', '42'],
  ['bool string', 'true'],
  ['null string', 'null'],
  ['json blob', '{"json":"blob","n":[1,2]}'],
  ['hash AND quote together', 'has # hash and "quote" together'],
  ['lone backslash', '\\'],
  ['double backslash', '\\\\'],
  ['fully quoted value', '"fully quoted"'],
  ['quote with a hash inside', 'he said "hi # there" loudly'],
  ['tilde (yaml null bait)', '~'],
  ['leading yaml indicators', '> folded | literal & anchor'],
];

for (const [label, value] of HOSTILE) {
  test(`parity: parse(write(x)) === x — ${label}`, () => {
    const dir = newVault();
    try {
      addFact(dir, { note: NOTE, subject: 'S', predicate: 'p', object: value, confidence: 'high' });
      const f = openFacts(dir).find((x) => x.predicate === 'p');
      assert.equal(f.object, value, 'value did not survive one write→read cycle');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test(`parity: stable across 6 write cycles, no escape compounding — ${label}`, () => {
    const dir = newVault();
    try {
      assert.equal(boardMeetingWrite(dir, 'Seen Command', 'p', value), 1, 'first write must record');
      const firstLine = objectLine(dir)[0];
      for (let i = 2; i <= 6; i++) {
        const wrote = boardMeetingWrite(dir, 'Seen Command', 'p', value);
        assert.equal(wrote, 0, `cycle ${i}: identical value was re-superseded (thrash)`);
        assert.equal(openFacts(dir).find((x) => x.predicate === 'p').object, value, `cycle ${i}: value drifted`);
      }
      // Byte-level fixed point: the serialized line is unchanged, so escapes cannot have grown.
      assert.deepEqual(objectLine(dir), [firstLine], 'serialized bytes drifted across cycles');
      // And exactly ONE fact exists — the supersede thrash produced one per meeting.
      assert.equal(factsIn(dir).filter((f) => f.predicate === 'p').length, 1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('parity: a genuinely changed value still supersedes (no-op guard is not over-eager)', () => {
  const dir = newVault();
  try {
    assert.equal(boardMeetingWrite(dir, 'Seen Command', 'current_focus', 'Raw user growth'), 1);
    assert.equal(boardMeetingWrite(dir, 'Seen Command', 'current_focus', 'Raw user growth'), 0);
    assert.equal(boardMeetingWrite(dir, 'Seen Command', 'current_focus', 'Revenue / MRR'), 1);
    const all = factsIn(dir).filter((f) => f.predicate === 'current_focus');
    assert.equal(all.length, 2, 'history preserved — supersede, never overwrite');
    const open = all.filter((f) => f.valid_to == null);
    assert.equal(open.length, 1);
    assert.equal(open[0].object, 'Revenue / MRR');
    const closed = all.find((f) => f.valid_to != null);
    assert.equal(closed.object, 'Raw user growth');
    assert.equal(closed.invalidated, closed.valid_to, 'transaction time closed with valid time');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('parity: the current_focus thrash regression — 8 board meetings on a quoted focus write once', () => {
  const dir = newVault();
  try {
    // The real shape of the bug: a focus Brandon typed with quotes in it. Before the fix this
    // recorded 8 supersedes of the identical value on the same day.
    const focus = 'focus on "getting real users" — not paid';
    let wrote = 0;
    for (let i = 0; i < 8; i++) wrote += boardMeetingWrite(dir, 'Seen Command', 'current_focus', focus);
    assert.equal(wrote, 1, 'the focus was re-recorded on later meetings');
    assert.equal(factsIn(dir).filter((f) => f.predicate === 'current_focus').length, 1);
    const note = readFileSync(join(dir, NOTE), 'utf8');
    // Two quotes in the value → exactly two `\"` escapes, forever. Compounding reached 1022 in seen.
    assert.equal((note.match(/\\/g) || []).length, 2, 'escapes multiplied');
    assert.ok(!/\\{2,}/.test(note), 'a compounded backslash run appeared');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('parity: values that would COERCE on read are quoted, so they compare equal forever', () => {
  const dir = newVault();
  try {
    // '42' bare would read back as the NUMBER 42, 'true' as a boolean, 'null'/'' as null — each
    // making String(cur.object) !== obj on the next meeting and thrashing forever.
    for (const [p, v] of [['n', '42'], ['b', 'true'], ['z', 'null'], ['arr', '[a, b]']]) {
      assert.equal(boardMeetingWrite(dir, 'S', p, v), 1);
      assert.equal(boardMeetingWrite(dir, 'S', p, v), 0, `${p}: re-recorded a coerced value`);
      assert.equal(openFacts(dir).find((f) => f.predicate === p).object, v);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('parity: real integers still round-trip as numbers (bare emission stays lossless)', () => {
  const dir = newVault();
  try {
    addFact(dir, { note: NOTE, subject: 'S', predicate: 'count', object: 7 });
    assert.equal(openFacts(dir).find((f) => f.predicate === 'count').object, 7);
    assert.match(readFileSync(join(dir, NOTE), 'utf8'), /object: 7$/m, 'integer should stay bare');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('parity: an inline `# comment` after a bare value is still stripped', () => {
  // Escape-awareness must not break the ordinary comment case the parser has always handled.
  const dir = newVault();
  try {
    const doc = `---\ntitle: T\nfacts:\n  - id: a\n    subject: S\n    predicate: p\n    object: plain value # trailing note\n    valid_from: 2026-07-10\n    valid_to: null\n---\n\nbody\n`;
    writeFileSync(join(dir, NOTE), doc);
    assert.equal(openFacts(dir).find((f) => f.predicate === 'p').object, 'plain value');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('parity: a `#` inside a quoted value is NOT treated as a comment', () => {
  const dir = newVault();
  try {
    addFact(dir, { note: NOTE, subject: 'S', predicate: 'p', object: 'he said "hi # there"' });
    assert.equal(openFacts(dir).find((f) => f.predicate === 'p').object, 'he said "hi # there"');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Provenance fields — recorded_at / by / change / supersedes. Additive: they make each datapoint
// self-explaining (when, who, what/why, what-it-replaced) WITHOUT changing the serializer's parity
// contract above. These are command-os-side today; the seen canonical copy + gateway + Supabase
// columns are the next parity increment.
// ---------------------------------------------------------------------------

test('provenance: addFact stamps a full-timestamp recorded_at and carries by/change', () => {
  const dir = newVault();
  try {
    addFact(dir, { note: NOTE, subject: 'Seen', predicate: 'free_tier', object: '1 credit/day',
      confidence: 'high', by: 'claude:test-session', change: 'Set the launch free tier' });
    const f = openFacts(dir).find((x) => x.predicate === 'free_tier');
    assert.equal(f.by, 'claude:test-session');
    assert.equal(f.change, 'Set the launch free tier');
    assert.match(String(f.recorded_at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'recorded_at is a full ISO timestamp');
    assert.match(String(f.recorded), /^\d{4}-\d{2}-\d{2}$/, 'recorded stays a day-granular date');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('provenance: supersedeFact links the new fact to the one it replaced via `supersedes`', () => {
  const dir = newVault();
  try {
    const first = addFact(dir, { note: NOTE, subject: 'Seen', predicate: 'free_tier', object: '3 credits/day', confidence: 'high' });
    supersedeFact(dir, { note: NOTE, id: first.fact.id, object: '1 credit/day', confidence: 'high',
      by: 'claude:test-session', change: 'Cut 3 to 1/day to protect margin' });
    const open = openFacts(dir).find((f) => f.predicate === 'free_tier');
    assert.equal(open.object, '1 credit/day');
    assert.equal(open.supersedes, first.fact.id, 'new fact points at the fact it replaced');
    assert.equal(open.change, 'Cut 3 to 1/day to protect margin');
    assert.equal(open.by, 'claude:test-session');
    const closed = factsIn(dir).find((f) => f.predicate === 'free_tier' && f.valid_to != null);
    assert.equal(closed.id, first.fact.id, 'the replaced fact is preserved as history');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('provenance: a `change` holding hostile chars round-trips (parity holds for the new fields)', () => {
  const dir = newVault();
  try {
    const change = 'raised to "1/day" — was 3; path C:\\x\\y # note';
    addFact(dir, { note: NOTE, subject: 'S', predicate: 'p', object: 'v', confidence: 'high', change });
    assert.equal(openFacts(dir).find((x) => x.predicate === 'p').change, change, 'change survived a write→read cycle');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('provenance: legacy facts without the new fields still parse (back-compat, read as null)', () => {
  const dir = newVault();
  try {
    const doc = `---\ntitle: T\nfacts:\n  - id: a\n    subject: S\n    predicate: p\n    object: legacy value\n    valid_from: 2026-07-10\n    valid_to: null\n    confidence: high\n    recorded: 2026-07-10\n    invalidated: null\n---\n\nbody\n`;
    writeFileSync(join(dir, NOTE), doc);
    const f = openFacts(dir).find((x) => x.predicate === 'p');
    assert.equal(f.object, 'legacy value');
    assert.equal(f.change, null);
    assert.equal(f.by, null);
    assert.equal(f.supersedes, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// recordFact — the ONE dedup implementation the MCP server's brain_add_fact and lib/brain.mjs's
// writeOne both call now. Proves the core fix: a repeated add of the same subject+predicate no-ops
// or supersedes instead of piling on a duplicate live fact.
// ---------------------------------------------------------------------------

// A vault-relative note in a SUBDIRECTORY, the shape Claude's brain_add_fact writes ('knowledge/…').
const KNOTE = 'knowledge/seen-command.md';
const openIn = (dir, note) => readIndex(dir).facts.filter((f) => String(f.note) === note && f.valid_to == null);
const allIn = (dir, note) => readIndex(dir).facts.filter((f) => String(f.note) === note);

test('recordFact: first write of a subject+predicate ADDS one open fact', () => {
  const dir = newVault();
  try {
    const r = recordFact(dir, KNOTE, { subject: 'Seen', predicate: 'free_tier', object: '1 credit/day', confidence: 'high' });
    assert.equal(r.written, 1);
    assert.equal(r.action, 'added');
    assert.equal(openIn(dir, KNOTE).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('recordFact: repeated add of the SAME subject+predicate+object is a NO-OP (fact count unchanged)', () => {
  const dir = newVault();
  try {
    recordFact(dir, KNOTE, { subject: 'Seen', predicate: 'free_tier', object: '1 credit/day', confidence: 'high' });
    // Simulate the exact repeat that used to duplicate: 5 more identical brain_add_fact calls.
    for (let i = 0; i < 5; i++) {
      const r = recordFact(dir, KNOTE, { subject: 'Seen', predicate: 'free_tier', object: '1 credit/day', confidence: 'high' });
      assert.equal(r.written, 0, `repeat ${i}: identical add should no-op`);
      assert.equal(r.action, 'noop');
    }
    assert.equal(allIn(dir, KNOTE).length, 1, 'exactly ONE fact — no duplicates piled up');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('recordFact: a CHANGED object supersedes (old closed, exactly one open) — history preserved', () => {
  const dir = newVault();
  try {
    recordFact(dir, KNOTE, { subject: 'Seen', predicate: 'free_tier', object: '3 credits/day', confidence: 'high' });
    const r = recordFact(dir, KNOTE, { subject: 'Seen', predicate: 'free_tier', object: '1 credit/day', confidence: 'high' });
    assert.equal(r.written, 1);
    assert.equal(r.action, 'superseded');
    const all = allIn(dir, KNOTE).filter((f) => f.predicate === 'free_tier');
    assert.equal(all.length, 2, 'supersede, never overwrite — old fact kept as history');
    const open = all.filter((f) => f.valid_to == null);
    assert.equal(open.length, 1);
    assert.equal(open[0].object, '1 credit/day');
    const closed = all.find((f) => f.valid_to != null);
    assert.equal(closed.object, '3 credits/day');
    assert.equal(closed.invalidated, closed.valid_to);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('recordFact: subject+predicate match is case-insensitive (does not re-add on case drift)', () => {
  const dir = newVault();
  try {
    recordFact(dir, KNOTE, { subject: 'Seen', predicate: 'Free_Tier', object: '1 credit/day' });
    const r = recordFact(dir, KNOTE, { subject: 'seen', predicate: 'free_tier', object: '1 credit/day' });
    assert.equal(r.written, 0, 'case-only difference is the same fact');
    assert.equal(allIn(dir, KNOTE).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('closeFact: retires an open fact (valid_to + invalidated set) WITHOUT appending a replacement', () => {
  const dir = newVault();
  try {
    const a = addFact(dir, { note: NOTE, subject: 'S', predicate: 'p', object: 'v', confidence: 'high' });
    closeFact(dir, { note: NOTE, id: a.fact.id, date: '2026-08-03' });
    const all = factsIn(dir).filter((f) => f.predicate === 'p');
    assert.equal(all.length, 1, 'no new fact appended — the duplicate is simply retired');
    assert.equal(all[0].valid_to, '2026-08-03');
    assert.equal(all[0].invalidated, '2026-08-03');
    assert.equal(openFacts(dir).filter((f) => f.predicate === 'p').length, 0, 'no longer live');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- `note` must be a PATH, never prose -------------------------------------------------------
// Three real facts were lost on 2026-08-13 because a caller passed its `change` sentence as `note`:
// the writer created a file named after that sentence at the vault ROOT, wrote the fact into it, and
// returned success. Root files are not indexed, so those facts were unreadable from the instant they
// were written. A write that cannot be read back must fail loudly instead of succeeding into a void.
test('assertNotePath accepts real vault paths, including root-level notes', () => {
  assert.equal(assertNotePath('knowledge/seen-command.md'), 'knowledge/seen-command.md');
  assert.equal(assertNotePath('seen-command-observations.md'), 'seen-command-observations.md');
  assert.equal(assertNotePath('knowledge/seen-command'), 'knowledge/seen-command.md', 'adds the extension');
  assert.equal(assertNotePath('  knowledge/a-b_c.md  '), 'knowledge/a-b_c.md', 'trims');
});

test('assertNotePath REJECTS the prose that stranded three facts', () => {
  // Verbatim shapes of the filenames found at the vault root on 2026-08-13.
  const prose = [
    'Another instance of the silent-zero class: a check that cannot run must not report the same shape as a check that ran and found nothing wrong.',
    'Established by two live fires per routine on 2026-08-13.',
    'seen-command PR #180. Both routine prompts now mandate the heading prefix.',
  ];
  for (const p of prose) {
    assert.throws(() => assertNotePath(p), /must be a vault path/, `must reject: ${p.slice(0, 40)}…`);
  }
});

test('assertNotePath rejects empty, traversing, and over-long notes', () => {
  assert.throws(() => assertNotePath(''), /`note` is required/);
  assert.throws(() => assertNotePath(null), /`note` is required/);
  assert.throws(() => assertNotePath('../../etc/passwd'), /must not traverse/);
  assert.throws(() => assertNotePath(`knowledge/${'x'.repeat(130)}.md`), /must be a vault path/);
});

test('the rejection explains WHY, so the caller can fix the call', () => {
  try { assertNotePath('some long explanatory sentence about what changed'); assert.fail('should have thrown'); }
  catch (e) {
    assert.match(e.message, /knowledge\/seen-command\.md/, 'shows a correct example');
    assert.match(e.message, /never readable/, 'names the consequence');
  }
});
