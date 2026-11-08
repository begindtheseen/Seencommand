import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { lintDiff, packageOf, addedLines, exportedNames, relativeNamedImport } from './lint.mjs';

// A tiny git repo shaped like the failures the lint exists to catch.
function repo(seed = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lint-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'pipe' });
  g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.1', dependencies: { realdep: '1.0.0' } }));
  writeFileSync(join(dir, 'lib.mjs'), 'export function realHelper(a) { return a; }\nexport const realConst = 1;\n');
  for (const [p, c] of Object.entries(seed)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c); }
  g('add', '-A'); g('commit', '-m', 'seed');
  return dir;
}

test('a call to a function defined NOWHERE reds the lint (the PR #46 class)', () => {
  const dir = repo({ 'a.mjs': 'const x = 1;\nexport { x };\n' });
  writeFileSync(join(dir, 'a.mjs'), 'const y = await selfUpdateCheck();\nconst x = 1;\nexport { x };\n');
  const errs = lintDiff(dir, ['a.mjs']);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /selfUpdateCheck.*defined NOWHERE/s);
});

test('calls to repo-defined, imported, same-diff-defined, global, and method names all pass', () => {
  const dir = repo({ 'a.mjs': 'const x = 1;\nexport { x };\n' });
  writeFileSync(join(dir, 'a.mjs'), [
    "import { realHelper } from './lib.mjs';",
    'function newLocal(n) { return n; }',
    'const a = realHelper(1);',
    'const b = newLocal(2);',
    'const c = JSON.stringify(a);',
    'const d = console.log(b);',
    'const e = someObj.dynamicMethod(c);',
    'const someObj = { dynamicMethod: (v) => v };',
    'export { a, b, c, d, e };',
  ].join('\n'));
  assert.deepEqual(lintDiff(dir, ['a.mjs']), []);
});

test('require() in an ES module reds the lint (the PR #185 crash)', () => {
  const dir = repo();
  writeFileSync(join(dir, 'script.mjs'), "const moment = require('moment');\nconsole.log(moment);\n");
  const errs = lintDiff(dir, ['script.mjs']);
  assert.ok(errs.some((e) => /require\(\) in an ES module/.test(e)));
});

test('importing a package the repo does not declare reds the lint', () => {
  const dir = repo();
  writeFileSync(join(dir, 'new.mjs'), "import m from 'moment';\nimport ok from 'realdep';\nimport fs from 'node:fs';\nexport default m || ok || fs;\n");
  const errs = lintDiff(dir, ['new.mjs']);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /'moment' which is NOT in this repo's package.json/);
});

test('a NEW file that defines and calls its own helpers passes', () => {
  const dir = repo();
  writeFileSync(join(dir, 'fresh.mjs'), 'function helper(a) { return a; }\nexport const out = helper(1);\n');
  assert.deepEqual(lintDiff(dir, ['fresh.mjs']), []);
});

test('CODER_LINT=0 disables the lint', () => {
  const dir = repo({ 'a.mjs': 'const x = 1;\n' });
  writeFileSync(join(dir, 'a.mjs'), 'const y = totallyPhantom();\n');
  process.env.CODER_LINT = '0';
  try { assert.deepEqual(lintDiff(dir, ['a.mjs']), []); }
  finally { delete process.env.CODER_LINT; }
});

test('a named import of a binding the RELATIVE module does not export reds the lint (the PR #78 class)', () => {
  const dir = repo({ 'engine/server.mjs': "export function serve() { return 1; }\n" });
  writeFileSync(join(dir, 'engine/server.mjs'),
    "import { realHelper, optimizedReadBrainFacts } from '../lib.mjs';\nexport function serve() { return realHelper(1); }\n");
  const errs = lintDiff(dir, ['engine/server.mjs']);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /does NOT export optimizedReadBrainFacts/);
  assert.match(errs[0], /does not provide an export named/);
  assert.match(errs[0], /exports are: realConst, realHelper/); // lists the real surface for self-correction
});

test('a named import of a REAL export passes', () => {
  const dir = repo({ 'engine/server.mjs': "export function serve() { return 1; }\n" });
  writeFileSync(join(dir, 'engine/server.mjs'),
    "import { realHelper, realConst } from '../lib.mjs';\nexport function serve() { return realHelper(realConst); }\n");
  assert.deepEqual(lintDiff(dir, ['engine/server.mjs']), []);
});

test('phantom-import check stays quiet when the target re-exports with `export *` (inconclusive, not a false positive)', () => {
  const dir = repo({
    'barrel.mjs': "export * from './lib.mjs';\nexport const own = 1;\n",
    'user.mjs': "export const u = 1;\n",
  });
  writeFileSync(join(dir, 'user.mjs'), "import { whoKnows } from './barrel.mjs';\nexport const u = whoKnows;\n");
  assert.deepEqual(lintDiff(dir, ['user.mjs']), []); // can't know barrel's full surface → must not flag
});

test('side-effect imports, namespace imports, and package imports do not trip the named-import check', () => {
  const dir = repo({ 'user.mjs': "export const u = 1;\n" });
  writeFileSync(join(dir, 'user.mjs'), [
    "import './lib.mjs';",             // side-effect: no names
    "import * as everything from './lib.mjs';", // namespace: no specific names
    "import ok from 'realdep';",       // package default (declared) — check #2's domain, not this one
    'export const u = everything.realConst;',
  ].join('\n'));
  assert.deepEqual(lintDiff(dir, ['user.mjs']), []);
});

test('exportedNames parses functions, consts, classes, default, and aliased export lists', () => {
  const names = exportedNames([
    'export function a() {}',
    'export async function b() {}',
    'export const c = 1;',
    'export class D {}',
    'export default function () {}',
    "export { e, f as g } from './x.mjs';",
    'const h = 1; export { h };',
  ].join('\n'));
  assert.ok(names.has('a') && names.has('b') && names.has('c') && names.has('D'));
  assert.ok(names.has('default') && names.has('e') && names.has('g') && names.has('h'));
  assert.ok(!names.has('f')); // `f as g` exports g, not f
});

test('exportedNames returns null (inconclusive) for a module with `export * from`', () => {
  assert.equal(exportedNames("export * from './other.mjs';\nexport const own = 1;\n"), null);
});

test('relativeNamedImport extracts exported names (pre-alias) only for relative specifiers', () => {
  assert.deepEqual(relativeNamedImport("import { a, b as c } from './x.mjs';"), { spec: './x.mjs', names: ['a', 'b'] });
  assert.deepEqual(relativeNamedImport("import Def, { a } from '../y.mjs';"), { spec: '../y.mjs', names: ['a'] });
  assert.equal(relativeNamedImport("import { a } from 'some-package';"), null); // packages aren't this check's job
  assert.equal(relativeNamedImport("import './side-effect.mjs';"), null);
  assert.equal(relativeNamedImport("import * as ns from './x.mjs';"), null);
});

test('packageOf resolves specifiers', () => {
  assert.equal(packageOf('moment'), 'moment');
  assert.equal(packageOf('@scope/pkg/deep'), '@scope/pkg');
  assert.equal(packageOf('./local.mjs'), null);
  assert.equal(packageOf('node:fs'), null);
});

test('addedLines: unstaged edits for tracked files, whole content for new files', () => {
  const dir = repo({ 'a.mjs': 'line1\n' });
  writeFileSync(join(dir, 'a.mjs'), 'line1\nline2-added\n');
  assert.deepEqual(addedLines(dir, 'a.mjs').filter(Boolean), ['line2-added']);
  writeFileSync(join(dir, 'brand-new.mjs'), 'n1\nn2\n');
  assert.deepEqual(addedLines(dir, 'brand-new.mjs').filter(Boolean), ['n1', 'n2']);
});

const W = (dir, p, c) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c); };

// ---- secret motion (the PR #190 class) -------------------------------------------------------------
test('a NEXT_PUBLIC_ name holding a service/secret key reds the lint', () => {
  const dir = repo({ 'lib/hooks/useX.ts': 'export const a = 1;\n' });
  W(dir, 'lib/hooks/useX.ts', "export const k = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_KEY ?? '';\n");
  const errs = lintDiff(dir, ['lib/hooks/useX.ts']);
  assert.ok(errs.some((e) => /NEXT_PUBLIC_SUPABASE_SERVICE_KEY/.test(e) && /CLIENT bundle/.test(e)), errs.join('\n'));
});

test('a server-secret env read in a client dir reds; the same read in lib/server passes', () => {
  const dir = repo({ 'components/Widget.tsx': 'export const a = 1;\n', 'lib/server/x.js': 'export const b = 1;\n' });
  W(dir, 'components/Widget.tsx', 'const key = process.env.SUPABASE_SERVICE_KEY;\nexport const a = key;\n');
  W(dir, 'lib/server/x.js', 'const key = process.env.SUPABASE_SERVICE_KEY;\nexport const b = key;\n');
  const bad = lintDiff(dir, ['components/Widget.tsx']);
  assert.ok(bad.some((e) => /server secret SUPABASE_SERVICE_KEY in a client-side path/.test(e)), bad.join('\n'));
  assert.deepEqual(lintDiff(dir, ['lib/server/x.js']), []);
});

test('a hardcoded credential-shaped literal reds the lint', () => {
  const dir = repo({ 'a.mjs': 'export const x = 1;\n' });
  W(dir, 'a.mjs', 'const token = "ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";\nexport const x = token;\n');
  const errs = lintDiff(dir, ['a.mjs']);
  assert.ok(errs.some((e) => /hardcoded credential-shaped literal/.test(e)), errs.join('\n'));
});

// ---- verbatim adjacent duplicate (the PR #66 class) ------------------------------------------------
test('an added line duplicating its neighbor verbatim reds the lint', () => {
  const dir = repo();
  W(dir, 'engine/dup.mjs', [
    'export function resolver(list, q) {',
    '  if (Array.isArray(list) && list.some((a) => String(a).toLowerCase() === q)) return q;',
    '  if (Array.isArray(list) && list.some((a) => String(a).toLowerCase() === q)) return q;',
    '  return null;',
    '}',
    'const use = resolver([], "");',
    '',
  ].join('\n'));
  const errs = lintDiff(dir, ['engine/dup.mjs']);
  assert.ok(errs.some((e) => /duplicates the line directly above it verbatim/.test(e)), errs.join('\n'));
});

// ---- unwired new modules (the PR #189/#190 class) --------------------------------------------------
test('a NEW lib module that nothing imports reds; wiring a caller in the same change clears it', async () => {
  const { unwiredNewModules } = await import('./lint.mjs');
  const dir = repo();
  W(dir, 'lib/deadRealtime.mjs', 'export function subscribeDeadRealtime() { return 1; }\n');
  const dead = unwiredNewModules(dir, ['lib/deadRealtime.mjs']);
  assert.equal(dead.length, 1);
  assert.match(dead[0], /nothing imports/);
  // same change also ships a caller (another untracked file) → wired, clean
  W(dir, 'engine/consumer.mjs', "import { subscribeDeadRealtime } from '../lib/deadRealtime.mjs';\nexport const c = subscribeDeadRealtime();\n");
  assert.deepEqual(unwiredNewModules(dir, ['lib/deadRealtime.mjs']), []);
  // scripts/ and tests are legitimately standalone
  W(dir, 'scripts/one-off.mjs', 'export const x = 1;\n');
  assert.deepEqual(unwiredNewModules(dir, ['scripts/one-off.mjs']), []);
});

// ---- phantom CONCEPT (the #81 class) ---------------------------------------------------------------
// After #81 was closed, a build fabricated lib/chronos/client.mjs to satisfy the phantom "Chronos SDK"
// premise; the gate went green. The lint now reds any touched PATH or ADDED line naming a phantom
// concept — comments included, since a phantom concept in a comment is still fabrication bait.
test('a diff adding a line that names the Chronos SDK reds the lint, even in a comment (the #81 class)', () => {
  const dir = repo({ 'engine/x.mjs': 'export const x = 1;\n' });
  W(dir, 'engine/x.mjs', '// integrate the Chronos SDK client here\nexport const x = 1;\n');
  const errs = lintDiff(dir, ['engine/x.mjs']);
  assert.ok(errs.some((e) => /chronos-sdk/.test(e) && /does not exist/.test(e)), errs.join('\n'));
});

test('a NEW file whose PATH names the Chronos SDK reds the lint (path hit)', () => {
  const dir = repo();
  W(dir, 'lib/chronos-sdk/client.mjs', 'export function connect() { return 1; }\n');
  const errs = lintDiff(dir, ['lib/chronos-sdk/client.mjs']);
  assert.ok(errs.some((e) => /chronos-sdk/.test(e) && /file PATH/.test(e)), errs.join('\n'));
});

test('a line naming a REAL third-party SDK ("the Supabase SDK") does NOT trip the phantom-concept lint', () => {
  // Mirrors the PR #82 co-occurrence bug: "Chronos" and "Supabase SDK" in one line names a real vendor
  // SDK, unrelated to any nonexistent "Chronos SDK" — PHANTOM_CONCEPTS are PAIRED phrases, so it passes.
  const dir = repo({ 'engine/y.mjs': 'export const y = 1;\n' });
  W(dir, 'engine/y.mjs', '// compare Chronos poll latency against the Supabase SDK\nexport const y = 1;\n');
  assert.deepEqual(lintDiff(dir, ['engine/y.mjs']), []);
});
