// Tests for engine/forge/verifier.mjs — the layered step verifier. Everything runs against a
// throwaway git repo with a FAKE gate and FAKE reviewFn: no network, no model, no Ollama. What's
// pinned here is the ORDER and the STANCE — cheap layers red before the expensive gate ever runs,
// gate errors flow through verbatim, and the self-review can only block on an explicit REJECT
// (availability failures are notes, never reds).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyStep, buildSelfReviewer, diffFor, syntaxErrors } from './verifier.mjs';

// A minimal real git repo: one tracked, committed, syntactically-valid module.
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'forge-verify-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'pipe' });
  g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.mjs'), 'export const x = 1;\n');
  g('add', '-A'); g('commit', '-m', 'seed');
  return dir;
}
const greenGate = () => ({ green: true, errors: [] });

test('empty touched set is an honest red — nothing to verify, gate never runs', async () => {
  const dir = makeRepo();
  let gateCalled = false;
  const r = await verifyStep({ repoRoot: dir, touched: [], gate: () => { gateCalled = true; return greenGate(); } });
  assert.equal(r.green, false);
  assert.match(r.errors[0], /no touched files/);
  assert.equal(gateCalled, false);
});

test('a first-line fence reds BEFORE the gate runs (cheap-first — a red costs seconds, not minutes)', async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, 'b.mjs'), '```js\nconst y = 2;\n');
  let gateCalled = false; let reviewCalled = false;
  const r = await verifyStep({
    repoRoot: dir, touched: ['b.mjs'],
    gate: () => { gateCalled = true; return greenGate(); },
    reviewFn: () => { reviewCalled = true; return 'APPROVE'; },
  });
  assert.equal(r.green, false);
  assert.match(r.errors[0], /FENCE/);
  assert.equal(gateCalled, false, 'a fence red must stop before the expensive full gate');
  assert.equal(reviewCalled, false, 'and before any model self-review');
});

test('a non-parsing .mjs reds at the syntax layer, before the gate', async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, 'bad.mjs'), 'this is not javascript {{{\n');
  let gateCalled = false;
  const r = await verifyStep({ repoRoot: dir, touched: ['bad.mjs'], gate: () => { gateCalled = true; return greenGate(); } });
  assert.equal(r.green, false);
  assert.match(r.errors[0], /SYNTAX bad\.mjs/);
  assert.equal(gateCalled, false);
});

test('syntaxErrors checks only .mjs/.js and passes valid code', () => {
  const dir = makeRepo();
  writeFileSync(join(dir, 'notes.md'), 'not javascript {{{\n'); // .md is never node --check'd
  assert.deepEqual(syntaxErrors(dir, ['a.mjs', 'notes.md']), []);
});

test('a comment-only edit reds (the PR #50 class) — a green suite proves nothing shipped', async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, 'a.mjs'), '// polished this comment, changed nothing\nexport const x = 1;\n');
  let gateCalled = false;
  const r = await verifyStep({ repoRoot: dir, touched: ['a.mjs'], gate: () => { gateCalled = true; return greenGate(); } });
  assert.equal(r.green, false);
  assert.match(r.errors[0], /comment-only change — nothing effective shipped/);
  assert.equal(gateCalled, false);
});

test('gate errors propagate VERBATIM — the retry loop needs the real file:line text', async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, 'a.mjs'), 'export const x = 2;\n'); // a real, effective change
  const errors = ['TESTS:\n✖ a.test.mjs:12 expected 2 to equal 3'];
  let reviewCalled = false;
  const r = await verifyStep({
    repoRoot: dir, touched: ['a.mjs'],
    gate: () => ({ green: false, errors }),
    reviewFn: () => { reviewCalled = true; return 'APPROVE'; },
  });
  assert.equal(r.green, false);
  assert.deepEqual(r.errors, errors, 'gate errors must arrive untouched');
  assert.equal(reviewCalled, false, 'no self-review on a red gate');
});

test('green path: every layer passes and the APPROVE reply lands as an advisory note', async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, 'a.mjs'), 'export const x = 2;\n');
  const events = [];
  const r = await verifyStep({
    repoRoot: dir, touched: ['a.mjs'], step: { doneMeans: 'x is 2' },
    gate: greenGate, reviewFn: async () => 'APPROVE — real, minimal change', onEvent: (m) => events.push(m),
  });
  assert.equal(r.green, true);
  assert.deepEqual(r.errors, []);
  assert.ok(r.notes.some((n) => n.includes('APPROVE')), `notes: ${JSON.stringify(r.notes)}`);
  assert.ok(events.some((m) => /green/.test(m)));
});

test('an explicit REJECT blocks with the review text as the error', async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, 'a.mjs'), 'export const x = 2;\n');
  const r = await verifyStep({ repoRoot: dir, touched: ['a.mjs'], gate: greenGate, reviewFn: async () => 'REJECT: fake stub' });
  assert.equal(r.green, false);
  assert.deepEqual(r.errors, ['REJECT: fake stub']);
  // case-insensitive + leading whitespace still counts as a rejection
  const r2 = await verifyStep({ repoRoot: dir, touched: ['a.mjs'], gate: greenGate, reviewFn: async () => '   reject: lowercase, indented' });
  assert.equal(r2.green, false);
});

test('a throwing or empty reviewer NEVER reds — fail-open on availability, red only on judgment', async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, 'a.mjs'), 'export const x = 2;\n');
  const thrown = await verifyStep({ repoRoot: dir, touched: ['a.mjs'], gate: greenGate, reviewFn: async () => { throw new Error('lane down'); } });
  assert.equal(thrown.green, true);
  assert.ok(thrown.notes.includes('self-review unavailable'), `notes: ${JSON.stringify(thrown.notes)}`);
  const empty = await verifyStep({ repoRoot: dir, touched: ['a.mjs'], gate: greenGate, reviewFn: async () => '' });
  assert.equal(empty.green, true);
  assert.ok(empty.notes.includes('self-review unavailable'));
});

test('FORGE_SELF_REVIEW=0 skips the reviewer entirely — the spy is never called', async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, 'a.mjs'), 'export const x = 2;\n');
  const prev = process.env.FORGE_SELF_REVIEW;
  process.env.FORGE_SELF_REVIEW = '0';
  try {
    let called = false;
    const r = await verifyStep({ repoRoot: dir, touched: ['a.mjs'], gate: greenGate, reviewFn: () => { called = true; return 'REJECT: would block'; } });
    assert.equal(r.green, true);
    assert.equal(called, false, 'the kill switch must skip the reviewFn call itself');
    assert.deepEqual(r.notes, []);
  } finally {
    if (prev === undefined) delete process.env.FORGE_SELF_REVIEW; else process.env.FORGE_SELF_REVIEW = prev;
  }
});

test('an untracked NEW file appears in the diff handed to the reviewer (/dev/null-style hunk)', async () => {
  const dir = makeRepo();
  mkdirSync(join(dir, 'lib'), { recursive: true });
  writeFileSync(join(dir, 'lib', 'new-thing.mjs'), 'export const NEW_MARKER = 42;\n');
  writeFileSync(join(dir, 'a.mjs'), 'export const x = 3;\n'); // a tracked change alongside it
  let seen = null;
  const r = await verifyStep({
    repoRoot: dir, touched: ['a.mjs', 'lib/new-thing.mjs'], gate: greenGate,
    reviewFn: async ({ diff }) => { seen = diff; return 'APPROVE'; },
  });
  assert.equal(r.green, true);
  assert.match(seen, /\/dev\/null/, 'the new file gets a /dev/null-style header');
  assert.match(seen, /\+\+\+ b\/lib\/new-thing\.mjs/);
  assert.match(seen, /\+export const NEW_MARKER = 42;/, 'every new-file line is visible +content');
  assert.match(seen, /const x = 3/, 'the tracked edit is in the same diff');
});

test('diffFor returns empty for an unreadable path instead of throwing', () => {
  const dir = makeRepo();
  assert.equal(diffFor(dir, ['does-not-exist.mjs']), '');
});

// ---- buildSelfReviewer ------------------------------------------------------
test('buildSelfReviewer wires the review competence and surfaces the verdict text', async () => {
  let captured = null;
  const fn = buildSelfReviewer(async (args) => { captured = args; return { text: '  APPROVE\nlooks real', engine: 'groq' }; });
  const out = await fn({ diff: '+const a = 1;', step: { doneMeans: 'the alpha flag actually toggles' } });
  assert.equal(out, 'APPROVE\nlooks real'); // trimmed, verbatim
  assert.equal(captured.deptId, 'product');
  assert.equal(captured.competence, 'review');
  assert.equal(captured.maxTokens, 500);
  assert.equal(captured.fallback, '');
  assert.match(captured.prompt, /the alpha flag actually toggles/, 'the step done-condition reaches the prompt');
  assert.match(captured.prompt, /\+const a = 1;/, 'the diff reaches the prompt');
  assert.match(captured.prompt, /APPROVE/); assert.match(captured.prompt, /REJECT/);
});

test('buildSelfReviewer returns "" when no lane answers — the caller treats it as unavailable', async () => {
  const fn = buildSelfReviewer(async () => ({ text: '', engine: 'fallback' })); // reason()'s all-lanes-dead shape
  assert.equal(await fn({ diff: '+x', step: { doneMeans: 'y' } }), '');
});
