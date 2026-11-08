import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Cache isolation: repo-map caches live in the APP data home (dataDir() respects SEEN_HOME at call
// time) — point it at a throwaway dir so tests never touch the real app data.
process.env.SEEN_HOME = mkdtempSync(join(tmpdir(), 'forge-home-'));
import {
  buildRepoMap, saveRepoMap, loadRepoMap, repoMapFor, repoMapSummary,
  extractExports, extractImports,
} from './repo-map.mjs';

// A real throwaway git repo — local subprocess only, no network, no model. Seeded with files that
// exercise every extraction shape plus the exclusion dirs.
function seedRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'forge-map-'));
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 'forge@test');
  g('config', 'user.name', 'forge');
  mkdirSync(join(dir, 'engine'), { recursive: true });
  writeFileSync(join(dir, 'engine', 'alpha.mjs'), [
    "import { helper } from '../lib/util.mjs';",
    "import 'node:path';",
    'export function runAlpha() { return helper(); }',
    'export const ALPHA_MODE = 1;',
    'export class AlphaEngine {}',
    'export {', '  runAlpha as go,', '  ALPHA_MODE,', '}', // multi-line brace list + alias
    '',
  ].join('\n'));
  mkdirSync(join(dir, 'lib'));
  writeFileSync(join(dir, 'lib', 'util.mjs'), 'export function helper() { return 42; }\n');
  writeFileSync(join(dir, 'lib', 'util.test.mjs'), "import { helper } from './util.mjs';\n");
  mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'x', 'index.js'), 'module.exports = 1;\n');
  mkdirSync(join(dir, 'data'));
  writeFileSync(join(dir, 'data', 'blob.js'), 'export const nope = 1;\n');
  writeFileSync(join(dir, 'README.md'), '# not code\n');
  g('add', '-A', '-f'); // -f: no .gitignore in the fixture, so node_modules IS tracked — exclusion must still drop it
  g('commit', '-q', '-m', 'seed');
  return dir;
}

test('buildRepoMap: shape, headSha, export/import extraction, dirs, testFiles', () => {
  const dir = seedRepo();
  const map = buildRepoMap(dir);
  assert.equal(map.headSha, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim());
  assert.ok(map.generatedAt && !Number.isNaN(Date.parse(map.generatedAt)));
  const alpha = map.files.find((f) => f.path === 'engine/alpha.mjs');
  assert.ok(alpha, 'engine/alpha.mjs is on the map');
  assert.ok(alpha.size > 0);
  for (const name of ['runAlpha', 'ALPHA_MODE', 'AlphaEngine', 'go']) assert.ok(alpha.exports.includes(name), `export ${name}`);
  assert.ok(alpha.imports.includes('../lib/util.mjs'), 'from-import');
  assert.ok(alpha.imports.includes('node:path'), 'bare side-effect import');
  assert.deepEqual(map.dirs, { engine: 1, lib: 2 });
  assert.equal(map.testFiles, 1);
  // deterministic: files path-sorted
  assert.deepEqual(map.files.map((f) => f.path), [...map.files.map((f) => f.path)].sort());
});

test('buildRepoMap: excludes node_modules/ and data/, and non-code extensions', () => {
  const map = buildRepoMap(seedRepo());
  const paths = map.files.map((f) => f.path);
  assert.ok(!paths.some((p) => p.startsWith('node_modules/')), 'node_modules excluded even when tracked');
  assert.ok(!paths.some((p) => p.startsWith('data/')), 'data/ excluded');
  assert.ok(!paths.includes('README.md'), '.md is not code');
});

test('buildRepoMap: over maxFiles keeps signal dirs over misc, stable order', () => {
  const dir = seedRepo();
  mkdirSync(join(dir, 'misc'));
  writeFileSync(join(dir, 'misc', 'a.js'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'misc', 'b.js'), 'export const b = 2;\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'misc'], { cwd: dir });
  const map = buildRepoMap(dir, { maxFiles: 3 }); // 5 code files → 3 kept
  const paths = map.files.map((f) => f.path);
  assert.equal(paths.length, 3);
  assert.deepEqual(paths, ['engine/alpha.mjs', 'lib/util.mjs', 'lib/util.test.mjs']); // signal tier survives, misc/ dropped
  assert.equal(map.testFiles, 1, 'test census runs over the FULL list, pre-trim');
});

test('buildRepoMap: fully injectable — fake execFn/readFn, no subprocess at all', () => {
  const calls = [];
  const execFn = (cmd, args) => {
    calls.push(args[0]);
    if (args[0] === 'ls-files') return 'lib/one.mjs\nnode_modules/dep/x.js\n';
    if (args[0] === 'rev-parse') return 'abc1234\n';
    throw new Error(`unexpected git ${args[0]}`);
  };
  const readFn = () => "import { z } from './z.mjs';\nexport const one = 1;\n";
  const map = buildRepoMap('/nowhere', { execFn, readFn });
  assert.equal(map.headSha, 'abc1234');
  assert.deepEqual(map.files, [{ path: 'lib/one.mjs', size: readFn().length, exports: ['one'], imports: ['./z.mjs'] }]);
  assert.ok(calls.includes('ls-files') && calls.includes('rev-parse'));
});

test('extractExports/extractImports handle the awkward shapes', () => {
  const src = [
    'export default async function main() {}',
    'export async function* stream() {}',
    "export { a as b, c } from './re.mjs'", // re-export: names land in exports, spec lands in imports
    "import type { T } from './types.ts'",
  ].join('\n');
  const ex = extractExports(src);
  for (const name of ['main', 'default', 'stream', 'b', 'c']) assert.ok(ex.includes(name), `export ${name}`);
  const im = extractImports(src);
  assert.ok(im.includes('./re.mjs') && im.includes('./types.ts'));
});

test('cache: save→load roundtrip OUTSIDE the target repo; load returns null on missing', () => {
  const dir = seedRepo();
  assert.equal(loadRepoMap(dir), null, 'no cache yet');
  const map = buildRepoMap(dir);
  const where = saveRepoMap(dir, map);
  // The e2e's first real catch: the cache must live in the APP's data home, keyed per-repo — never
  // inside the target repo (the product checkout doesn't gitignore data/, so in-repo caching littered
  // every repo forge mapped).
  assert.ok(!where.startsWith(dir), `cache path ${where} must be OUTSIDE the mapped repo`);
  assert.ok(existsSync(where));
  assert.ok(!existsSync(join(dir, 'data', 'forge')), 'no cache dir was created inside the target repo');
  assert.deepEqual(loadRepoMap(dir), map);
});

test('repoMapFor: serves the cache when headSha matches, rebuilds when it does not', () => {
  const dir = seedRepo();
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  // A sentinel cache with the CURRENT sha must be returned verbatim (no rebuild).
  saveRepoMap(dir, { generatedAt: 'CACHED', headSha: head, files: [], dirs: {}, testFiles: 0 });
  assert.equal(repoMapFor(dir).generatedAt, 'CACHED');
  // Stale sha → rebuild AND the cache is refreshed to the real map.
  saveRepoMap(dir, { generatedAt: 'STALE', headSha: 'deadbeef', files: [], dirs: {}, testFiles: 0 });
  const fresh = repoMapFor(dir);
  assert.notEqual(fresh.generatedAt, 'STALE');
  assert.equal(fresh.headSha, head);
  assert.equal(loadRepoMap(dir).headSha, head, 'rebuild rewrote the cache');
});

test('repoMapFor: corrupt cache file → rebuild, never a throw', () => {
  const dir = seedRepo();
  // Locate this repo's cache file via a real save, then corrupt it in place.
  const where = saveRepoMap(dir, buildRepoMap(dir));
  writeFileSync(where, 'not json {{{');
  assert.equal(loadRepoMap(dir), null, 'corrupt reads as absent');
  const map = repoMapFor(dir); // must not throw
  assert.ok(map.files.some((f) => f.path === 'engine/alpha.mjs'));
  // wrong-shape-but-valid JSON is corrupt too
  writeFileSync(where, '{"files": "not an array"}');
  assert.equal(loadRepoMap(dir), null);
  assert.ok(readFileSync(where, 'utf8')); // sanity: file existed, we still degraded
});

test('repoMapSummary: dirs overview line first, task-relevant file ranked to the top', () => {
  const map = buildRepoMap(seedRepo());
  const s = repoMapSummary(map, 'wire the helper util');
  const lines = s.split('\n');
  assert.match(lines[0], /^dirs: /);
  assert.match(lines[0], /lib\(2\)/);
  // lib/util.mjs wins on export ('helper') + path ('util') overlap — NOT alphabetical order, which
  // would put engine/alpha.mjs first; this is the ranking doing real work.
  assert.equal(lines[1], 'lib/util.mjs — exports: helper');
  assert.ok(s.includes('engine/alpha.mjs — exports: '), 'unranked files still listed under budget');
});

test('repoMapSummary: respects the char budget and stays deterministic', () => {
  const map = buildRepoMap(seedRepo());
  const tight = repoMapSummary(map, 'wire the helper util', { budget: 40 });
  assert.ok(tight.length <= 40, `budget held (${tight.length})`);
  assert.match(tight, /^dirs: /); // the overview line survives even a tight budget
  assert.equal(repoMapSummary(map, 'wire the helper util'), repoMapSummary(map, 'wire the helper util'), 'same map + task → same string');
});

test('empty repo (no commits): empty map, no crash, summary still renders', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-empty-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const map = buildRepoMap(dir);
  assert.deepEqual(map.files, []);
  assert.deepEqual(map.dirs, {});
  assert.equal(map.testFiles, 0);
  assert.equal(map.headSha, null, 'no HEAD yet → null, never a fake key');
  const s = repoMapSummary(map, 'anything at all');
  assert.match(s, /^dirs: /);
  const viaFor = repoMapFor(dir); // null headSha must never match a cache; rebuild path works end-to-end
  assert.deepEqual(viaFor.files, []);
});
