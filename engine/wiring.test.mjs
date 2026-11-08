import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph } from './code-graph.mjs';
import { wiringFindings } from './wiring.mjs';

const graph = (files) => buildGraph({ root: '/nowhere', files: Object.keys(files), read: (p) => files[p] });
const run = (beforeFiles, afterFiles, touched) => wiringFindings({ repoRoot: '/nowhere', touched, graphs: { before: graph(beforeFiles), after: graph(afterFiles) } });

const feed = 'export function loadFeed() {}\n';
const caller = "import { loadFeed } from '../lib/feed.mjs';\nexport function run() { return loadFeed(); }\n";
const main = "import { run } from '../engine/run.mjs';\nrun();\n";
const base = { 'lib/feed.mjs': feed, 'engine/run.mjs': caller, 'scripts/main.mjs': main };

test('unwired-export: a new tested helper that nothing calls is rejected by name', () => {
  const after = { ...base, 'lib/feed.mjs': `${feed}export function isFresh() {}\n`, 'lib/feed.test.mjs': "import { isFresh } from './feed.mjs';\n" };
  const f = run(base, after, ['lib/feed.mjs', 'lib/feed.test.mjs']);
  assert.equal(f.length, 1);
  assert.equal(f[0].rule, 'unwired-export');
  assert.match(f[0].reason, /`isFresh`.*a test is not a caller/);
});

test('unwired-export stays silent when the export is wired, internal, a value, a seam, or an entrypoint', () => {
  const wired = { ...base, 'lib/feed.mjs': `${feed}export function isFresh() {}\n`, 'engine/run.mjs': "import { loadFeed, isFresh } from '../lib/feed.mjs';\nexport function run() { return isFresh(loadFeed()); }\n" };
  assert.deepEqual(run(base, wired, ['lib/feed.mjs', 'engine/run.mjs']), []);
  const internal = { ...base, 'lib/feed.mjs': 'export function helper() {}\nexport function loadFeed() { return helper(); }\n' };
  assert.deepEqual(run(base, internal, ['lib/feed.mjs']), []);
  const value = { ...base, 'lib/feed.mjs': `${feed}export const LIMIT = 8;\nexport const _internals = { loadFeed };\n` };
  assert.deepEqual(run(base, value, ['lib/feed.mjs']), []);
  const script = { ...base, 'scripts/tool.mjs': 'export function cli() {}\n' };
  assert.deepEqual(run(base, script, ['scripts/tool.mjs']), []);
  const viaNamespace = { ...base, 'lib/feed.mjs': `${feed}export function isFresh() {}\n`, 'engine/run.mjs': "import * as feed from '../lib/feed.mjs';\nexport function run() { return feed.loadFeed(); }\n" };
  assert.deepEqual(run(base, viaNamespace, ['lib/feed.mjs', 'engine/run.mjs']), [], 'a namespace import may use anything — never accuse live code');
});

test('orphaned-export: deleting the only integration while the helper survives is rejected', () => {
  const guarded = { ...base, 'lib/feed.mjs': `${feed}export function isFresh() {}\n`, 'engine/run.mjs': "import { loadFeed, isFresh } from '../lib/feed.mjs';\nexport function run() { return isFresh(loadFeed()); }\n", 'lib/feed.test.mjs': "import { isFresh } from './feed.mjs';\n" };
  const gutted = { ...guarded, 'engine/run.mjs': caller };
  const f = run(guarded, gutted, ['engine/run.mjs']);
  assert.equal(f.length, 1);
  assert.equal(f[0].rule, 'orphaned-export');
  assert.equal(f[0].file, 'lib/feed.mjs', 'it names the ORPHAN, which the change never touched');
  assert.match(f[0].reason, /was called from engine\/run\.mjs before this change and is called from nowhere after it/);
});

test('orphaned-export stays silent when the helper is deleted too, moved to another caller, or was never wired', () => {
  const guarded = { ...base, 'lib/feed.mjs': `${feed}export function isFresh() {}\n`, 'engine/run.mjs': "import { loadFeed, isFresh } from '../lib/feed.mjs';\nexport function run() { return isFresh(loadFeed()); }\n" };
  assert.deepEqual(run(guarded, base, ['engine/run.mjs', 'lib/feed.mjs']), [], 'retiring the behaviour AND the helper is a real deletion');
  const moved = { ...guarded, 'engine/run.mjs': caller, 'engine/other.mjs': "import { isFresh } from '../lib/feed.mjs';\nexport const x = () => isFresh();\n", 'scripts/main.mjs': `${main}import { x } from '../engine/other.mjs';\nx();\n` };
  assert.deepEqual(run(guarded, moved, ['engine/run.mjs', 'engine/other.mjs', 'scripts/main.mjs']), []);
  const neverWired = { ...base, 'lib/feed.mjs': `${feed}export function isFresh() {}\n` };
  assert.deepEqual(run(neverWired, { ...neverWired, 'engine/run.mjs': `${caller}// tidy\n` }, ['engine/run.mjs']), [], 'pre-existing dead code is not this change\'s fault');
});

// ---- unimported-call + the lexer it stands on ---------------------------------------------------------
import { unimportedCalls } from './wiring.mjs';
import { blankLiterals } from './code-graph.mjs';

test('blankLiterals is a lexer: nested templates keep their ${code}, regexes and comments lose their contents, offsets survive', () => {
  const src = "const a = `x ${f(`y ${g()}`)} z`; // c()\nconst r = /a\\/[/]b()/g.test(s) ? h() : \"k()\";\nconst d = a / b / c();";
  const out = blankLiterals(src);
  assert.equal(out.length, src.length);
  assert.equal(out.split('\n').length, 3);
  for (const kept of ['f(', 'g()', 'h()', '.test(s)', 'c()']) assert.ok(out.includes(kept), kept);
  assert.equal(/k\(\)/.test(out), false, 'a call inside a string is prose');
  assert.equal(/b\(\)/.test(out), false, 'a call inside a regex is not a call');
  assert.match(out, /const d = a \/ b \/ c\(\);/, 'division is not a regex');
});

test('unimported-call: a function another module exports, called here with no import and no declaration', () => {
  const lib = 'export function readBuild() {}\nexport function writeBuild() {}\n';
  const files = (runner) => graph({ 'lib/builds.mjs': lib, 'engine/runner.mjs': runner });
  const bad = "import { writeBuild } from '../lib/builds.mjs';\nexport function go(id) { writeBuild(id); return { ...readBuild(id), ok: true }; }\n";
  const f = unimportedCalls({ repoRoot: '/nowhere', touched: ['engine/runner.mjs'], graph: files(bad) });
  assert.deepEqual(f.map((x) => x.name), ['readBuild'], 'a SPREAD call (`...readBuild(`) is a call, not a member access');
  assert.match(f[0].reason, /exported by lib\/builds\.mjs.*ReferenceError/);
});

test('unimported-call never accuses a name that is declared in ANY way, a method, or prose', () => {
  const lib = 'export function readBuild() {}\nexport function advisors() {}\nexport function recover() {}\n';
  const ok = (runner) => unimportedCalls({ repoRoot: '/nowhere', touched: ['engine/runner.mjs'], graph: graph({ 'lib/builds.mjs': lib, 'engine/runner.mjs': runner }) });
  assert.deepEqual(ok("import { readBuild } from '../lib/builds.mjs';\nreadBuild(1);\n"), []);
  assert.deepEqual(ok('function readBuild() {}\nreadBuild(1);\n'), []);
  assert.deepEqual(ok('const readBuild = (x) => x;\nreadBuild(1);\n'), []);
  assert.deepEqual(ok('export function go({ readBuild }) { return readBuild(1); }\n'), [], 'injected as a parameter');
  assert.deepEqual(ok('class S { recover() { return 1; } }\n'), [], 'a method DEFINITION has the shape of a call');
  assert.deepEqual(ok("const why = 'advisors() reports RLS lints';\nstore.readBuild(1);\n"), [], 'prose in a string; a method on another object');
});
