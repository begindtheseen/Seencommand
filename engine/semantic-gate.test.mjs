// Tests for the semantic gate (engine/semantic-gate.mjs).
//
// This gate FAILS BUILDS, so the tests are weighted toward what must NOT be flagged. A miss costs
// what we already pay (the reviewer catches it a round later); a false positive rejects working code.
// The caught shapes are taken verbatim from the reviewer's own words on real failures:
// task-147 (empty new file), run-…a3 (test with no assertions), task-96 (comments only).
//
// A fourth rule (calls-a-symbol-defined-nowhere, the task-78 shape) was written, passed tests like
// these, and was then REMOVED: against 139 real source files it produced 1,216 false positives. See
// the module header. These three were measured against the same corpus and produced zero.

import test from 'node:test';
import assert from 'node:assert/strict';
import { semanticGateFindings, semanticGateMessage, codeLines } from './semantic-gate.mjs';

const gate = (files, opts = {}) => semanticGateFindings({
  touched: Object.keys(files),
  readFile: (p) => files[p],
  ...opts,
});

// --- the three shapes it must catch --------------------------------------------------------------

test('an empty new file is rejected — the task-147 shape', () => {
  const f = gate({ 'scripts/content-parser.mjs': '\n\n// TODO: implement\n\n' }, { isNew: () => true });
  assert.equal(f.length, 1);
  assert.equal(f[0].rule, 'empty-new-file');
  assert.match(f[0].reason, /scripts\/content-parser\.mjs/);
  assert.match(f[0].reason, /write the actual implementation/);
});

test('a test file with cases but no assertions is rejected', () => {
  const f = gate({ 'lib/x.test.mjs': "import test from 'node:test';\ntest('works', () => {\n  const a = 1;\n});\n" });
  assert.equal(f[0].rule, 'test-without-assertions');
  assert.match(f[0].reason, /passes no matter what/);
});

test('a change that edits only comments is rejected — the task-96 shape', () => {
  const f = gate({ 'engine/a.mjs': '// explain the thing\n\n/* block */\n', 'engine/b.mjs': '// more words\n' });
  assert.equal(f.length, 1);
  assert.equal(f[0].rule, 'comments-only');
  assert.match(f[0].reason, /nothing effective to ship/);
});

// --- what it must NEVER flag (false positives are the expensive direction) ----------------------

test('ordinary working code passes untouched', () => {
  assert.deepEqual(gate({
    'lib/a.mjs': "import { join } from 'node:path';\nexport function build(x) {\n  return join(x, 'y');\n}\n",
  }), []);
});

test('an existing (non-new) file that is currently comment-only alongside real code is fine', () => {
  // b.mjs contributes real code, so the change as a whole DOES something.
  assert.deepEqual(gate({
    'engine/a.mjs': '// just a note\n',
    'engine/b.mjs': 'export const x = 1;\n',
  }), []);
});

test('non-code files are ignored entirely', () => {
  assert.deepEqual(gate({ 'README.md': '', 'docs/x.json': '{}' }, { isNew: () => true }), []);
});

test('an unreadable file is unknown, not a violation', () => {
  const f = semanticGateFindings({
    touched: ['lib/a.mjs'],
    readFile: () => { throw new Error('EACCES'); },
    isNew: () => true,
  });
  assert.deepEqual(f, []);
});

test('a test file WITH assertions passes', () => {
  const src = "import test from 'node:test';\nimport assert from 'node:assert';\ntest('x', () => { assert.equal(1, 1); });\n";
  assert.deepEqual(gate({ 'lib/x.test.mjs': src }), []);
});

// --- helpers -------------------------------------------------------------------------------------

test('codeLines strips line, block and hash comments', () => {
  assert.deepEqual(codeLines('// a\nconst x = 1;\n/* b\n c */\n# d\n\nconst y = 2;'),
    ['const x = 1;', 'const y = 2;']);
});

test('the message teaches — it lists every problem so a retry can act on it', () => {
  const msg = semanticGateMessage([
    { file: 'a.mjs', rule: 'empty-new-file', reason: 'a.mjs is a NEW file containing no code' },
    { file: 'b.mjs', rule: 'undefined-symbol', reason: 'b.mjs calls foo()' },
  ]);
  assert.match(msg, /2 problems found before review/);
  assert.match(msg, /\[empty-new-file\]/);
  assert.match(msg, /\[undefined-symbol\]/);
  assert.equal(semanticGateMessage([]), null);
});
