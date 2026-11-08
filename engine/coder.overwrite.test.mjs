// Whole-file replacement is the exception, not the edit format (audit §4). These pin the exception's terms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { applyEdits, overwriteProblem, shownInFull, retrieve } from './coder.mjs';

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'coder-ow-'));
  for (const [p, b] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), b); }
  return root;
}
const allow = () => {};
const small = "import { x } from './x.mjs';\n\nexport function loadFeed(rows) {\n  return rows.filter((r) => r && r.id);\n}\n\nexport function count(rows) {\n  return loadFeed(rows).length;\n}\n";
const big = `${Array.from({ length: 260 }, (_, i) => `export const v${i} = ${i};`).join('\n')}\n`;

test('a genuinely NEW file is written; an existing LARGE file cannot be replaced wholesale', () => {
  const root = tree({ 'lib/big.mjs': big });
  const r = applyEdits(root, { edits: [], newFiles: [{ path: 'lib/new.mjs', content: 'export const n = 1;\n' }, { path: 'lib/big.mjs', content: 'export const v0 = 0;\n' }] }, allow);
  assert.deepEqual(r.touched, ['lib/new.mjs']);
  assert.match(r.failures[0].why, /would overwrite the existing 26\d-line lib\/big\.mjs/);
  assert.match(r.failures[0].why, /SEARCH\/REPLACE/);
  assert.equal(readFileSync(join(root, 'lib/big.mjs'), 'utf8'), big, 'untouched');
});

test('a small file may be rewritten only if no export disappears and the body does not collapse', () => {
  assert.equal(overwriteProblem('lib/feed.mjs', small, small.replace('r && r.id', 'r?.id')), null);
  assert.match(overwriteProblem('lib/feed.mjs', small, "export function loadFeed(rows) {\n  return rows;\n}\n"), /DROP its existing export\(s\): count/);
  // Same exports, body collapsed: every name survives, but most of the code is gone.
  const long = `export function score(rows) {\n${Array.from({ length: 40 }, (_, i) => `  rows = rows.map((r) => ({ ...r, s${i}: ${i} }));`).join('\n')}\n  return rows;\n}\n`;
  const gutted = 'export function score(rows) {\n  return rows;\n}\n';
  assert.match(overwriteProblem('lib/feed.mjs', long, gutted), /less than half its code .* truncation/);
});

test('the hash pin: a rewrite is refused for a file never shown in full, or changed since it was shown', () => {
  const root = tree({ 'lib/feed.mjs': small });
  const shown = shownInFull({ blocks: [{ path: 'lib/feed.mjs', from: 1, to: 9, text: small }, { path: 'lib/other.mjs', from: 40, to: 60, text: 'a window' }] });
  assert.deepEqual([...shown.keys()], ['lib/feed.mjs'], 'a mid-file window is not "shown in full"');
  const next = small.replace('r && r.id', 'r?.id');
  assert.equal(overwriteProblem('lib/feed.mjs', small, next, shown), null);
  assert.match(overwriteProblem('lib/unseen.mjs', small, next, shown), /never shown to you in full/);
  const movedOn = `${small}export const ADDED_BY_AN_EARLIER_ROUND = 1;\n`;
  assert.match(overwriteProblem('lib/feed.mjs', movedOn, next, shown), /has CHANGED since it was shown to you — your copy is stale/);
  const r = applyEdits(root, { edits: [], newFiles: [{ path: 'lib/feed.mjs', content: next }] }, allow, { shown });
  assert.deepEqual(r.touched, ['lib/feed.mjs']);
});

test('retrieval is contract-first: structural picks lead, survive maxFiles, and a lexically silent one shows its head', () => {
  const files = { 'lib/feed.mjs': small, 'engine/run.mjs': "import { count } from '../lib/feed.mjs';\nexport const go = (r) => count(r);\n",
    'lib/quiet.mjs': `${Array.from({ length: 300 }, (_, i) => `export const q${i} = ${i};`).join('\n')}\n` };
  for (let i = 0; i < 8; i++) files[`lib/noise${i}.mjs`] = `// freshness freshness freshness guard guard\nexport const n${i} = 'freshness guard';\n`;
  const root = tree(files);
  const ret = retrieve(root, 'add a freshness guard', { maxFiles: 3, priorityFiles: ['lib/feed.mjs', 'engine/run.mjs', 'lib/quiet.mjs', 'lib/missing.mjs'] });
  assert.deepEqual(ret.files.slice(0, 3), ['lib/feed.mjs', 'engine/run.mjs', 'lib/quiet.mjs'], 'contract order, ahead of every keyword-stuffed file');
  assert.ok(ret.blocks.some((b) => b.path === 'engine/run.mjs'), 'the CALLER is in context even though it never mentions the task\'s words');
  const quiet = ret.blocks.find((b) => b.path === 'lib/quiet.mjs');
  assert.deepEqual([quiet.from, quiet.to], [1, 40]);
  assert.deepEqual(retrieve(root, 'add a freshness guard', { maxFiles: 3 }).files.filter((f) => /feed|run|quiet/.test(f)), [], 'lexical alone never finds them');
});

test('a red gate is explained by NAME: failing tests for TESTS, the first two lines for everything else', async () => {
  const { redReason } = await import('./coder.mjs');
  const out = 'TESTS:\n    actual: \'mmitted code file(s)\'\n✖ reports checkout.ahead when HEAD is ahead (1.2ms)\n✖ every way the four can disagree (0.9ms)\nℹ fail 2\n✖ failing tests:\n✖ reports checkout.ahead when HEAD is ahead (1.2ms)';
  assert.equal(redReason(out), 'TESTS: reports checkout.ahead when HEAD is ahead | every way the four can disagree');
  assert.equal(redReason('WIRING lib/feed.mjs: adds the export `isFresh`\nmore detail\nand more'), 'WIRING lib/feed.mjs: adds the export `isFresh` ⏎ more detail');
  assert.equal(redReason(''), 'no error text');
});

test('the loop detector sees the SAME failing test through different output tails — and escalates', async () => {
  const { codeLocally } = await import('./coder.mjs');
  const root = tree({ 'lib/feed.mjs': small });
  // a real checkout: a red round REVERTS through git, so the next round's SEARCH text matches again
  const { execFileSync } = await import('node:child_process');
  const g = (...a) => execFileSync('git', a, { cwd: root, stdio: 'pipe' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false'); g('add', '-A'); g('commit', '-q', '-m', 'seed');
  const lanes = []; let n = 0;
  const reply = "*** FILE: lib/feed.mjs\n<<<<<<< SEARCH\n  return rows.filter((r) => r && r.id);\n=======\n  return rows.filter((r) => r?.id);\n>>>>>>> REPLACE\n";
  const gate = () => (++n >= 3 ? { green: true, errors: [] } : { green: false, errors: [`TESTS:\n  diff slice number ${n} ${'x'.repeat(n * 7)}\n✖ counts only fresh rows (${n}.3ms)\nℹ fail 1`] });
  const out = await codeLocally({ task: 'tweak lib/feed.mjs', repoRoot: root, assertWritable: () => {}, gate, escalate: true, retryWaitMs: 0, maxRounds: 4,
    reasonFn: async (o) => { lanes.push(o.hostedOnly ? 'hosted' : 'local'); return { text: reply, engine: o.hostedOnly ? 'groq' : 'local:stub' }; } });
  assert.deepEqual(lanes, ['local', 'local', 'hosted'], 'two reds naming the same test = a loop → the third round goes to the stronger lane');
  assert.equal(out.engine, 'groq');
});

test('APPEND adds to the end of an existing file with no anchor, and never re-declares an import', async () => {
  const { parseEdits, mergeAppend } = await import('./coder.mjs');
  const testFile = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { loadFeed } from './feed.mjs';\n\ntest('loads', () => { assert.equal(loadFeed([{ id: 1 }]).length, 1); });\n";
  const root = tree({ 'lib/feed.mjs': small, 'lib/feed.test.mjs': testFile });
  const reply = "SUMMARY: add the count test\n*** APPEND: lib/feed.test.mjs\n<<<<<<< CONTENT\nimport { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { loadFeed, count } from './feed.mjs';\n\ntest('counts', () => { assert.equal(count([{ id: 1 }, {}]), 1); });\n=======\n>>>>>>> END\n";
  const parsed = parseEdits(reply);
  assert.deepEqual(parsed.appends.map((a) => a.path), ['lib/feed.test.mjs']);
  assert.deepEqual([parsed.edits.length, parsed.newFiles.length], [0, 0], 'an APPEND is not a NEWFILE — it must never overwrite');
  const r = applyEdits(root, parsed, allow);
  assert.deepEqual(r.touched, ['lib/feed.test.mjs']);
  const out = readFileSync(join(root, 'lib/feed.test.mjs'), 'utf8');
  assert.ok(out.startsWith(testFile.trimEnd()), 'every existing line survives, in place');
  assert.equal((out.match(/from 'node:test'/g) || []).length, 1, 'a duplicate binding would be a SyntaxError');
  assert.match(out, /import \{ count \} from '\.\/feed\.mjs';/, 'only the NEW binding is imported');
  assert.match(out, /test\('counts'/);
  const { execFileSync } = await import('node:child_process');
  execFileSync(process.execPath, ['--check', join(root, 'lib/feed.test.mjs')]);
  assert.equal(mergeAppend('const a = 1;\n', "import x, * as ns from './m.mjs';\nuse(x, ns);"), "const a = 1;\n\nimport x, * as ns from './m.mjs';\nuse(x, ns);\n");
});

test('APPEND refuses a missing file, empty content and an off-limits path — each as feedback, never a throw', () => {
  const root = tree({ 'lib/feed.mjs': small });
  const r = applyEdits(root, { edits: [], newFiles: [], appends: [
    { path: 'lib/nope.test.mjs', content: 'x' }, { path: 'lib/feed.mjs', content: '   ' }, { path: 'secret/x.mjs', content: 'y' },
  ] }, (p) => { if (p.startsWith('secret/')) throw new Error('outside the task contract'); });
  assert.deepEqual(r.touched, []);
  assert.deepEqual(r.failures.map((f) => f.why.split(' — ')[0]), ['APPEND needs an existing file', 'APPEND content is empty', 'path is OFF-LIMITS (outside the task contract)']);
});
