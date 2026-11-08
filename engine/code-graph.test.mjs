import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseModule, resolveSpec, buildGraph, consumersOf, usedInternally, isEntrypoint, isTest, neighbourhood } from './code-graph.mjs';

test('parseModule reads every import and export form, and only at statement level', () => {
  const m = parseModule([
    "import def, { a, b as bee } from './x.mjs';",
    "import * as ns from './ns.mjs';",
    "import './side.mjs';",
    "import {",
    "  multi,",
    "  line,",
    "} from './multi.mjs';",
    "const lazy = await import('./lazy.mjs');",
    "const old = require('./old.js');",
    "const s = \"import { fake } from './not-code.mjs'\"; // import { alsoFake } from './comment.mjs'",
    'export function fn() {}',
    'export async function afn() {}',
    'export class K {}',
    'export const arrow = (x) => x;',
    'export const VALUE = 3;',
    "export { local as renamed };",
    "export { passed } from './barrel-src.mjs';",
    "export * from './star.mjs';",
    'export default fn;',
  ].join('\n'));
  const specs = m.imports.map((i) => i.spec);
  for (const s of ['./x.mjs', './ns.mjs', './side.mjs', './multi.mjs', './lazy.mjs', './old.js', './barrel-src.mjs', './star.mjs']) assert.ok(specs.includes(s), s);
  assert.equal(specs.includes('./comment.mjs'), false, 'a commented import is not an import');
  assert.deepEqual(m.imports.find((i) => i.spec === './x.mjs').names.sort(), ['a', 'b', 'default']);
  assert.deepEqual(m.imports.find((i) => i.spec === './multi.mjs').names, ['multi', 'line']);
  assert.equal(m.imports.find((i) => i.spec === './ns.mjs').all, true);
  assert.equal(m.imports.find((i) => i.spec === './lazy.mjs').all, true, 'a dynamic import may use anything');
  for (const e of ['fn', 'afn', 'K', 'arrow', 'VALUE', 'renamed', 'passed', 'default']) assert.ok(m.exports.includes(e), e);
  assert.deepEqual([m.kinds.fn, m.kinds.afn, m.kinds.K, m.kinds.arrow, m.kinds.VALUE], ['callable', 'callable', 'callable', 'callable', 'value']);
});

test('resolveSpec handles extensions, index files, the TS ".js means .ts" idiom and the @/ alias', () => {
  const known = new Set(['lib/a.mjs', 'lib/dir/index.ts', 'lib/t.ts', 'components/Nav.tsx', 'src/hooks/useX.ts']);
  assert.equal(resolveSpec('engine/run.mjs', '../lib/a.mjs', known), 'lib/a.mjs');
  assert.equal(resolveSpec('engine/run.mjs', '../lib/a', known), 'lib/a.mjs');
  assert.equal(resolveSpec('engine/run.mjs', '../lib/dir', known), 'lib/dir/index.ts');
  assert.equal(resolveSpec('lib/x.ts', './t.js', known), 'lib/t.ts');
  assert.equal(resolveSpec('app/page.tsx', '@/components/Nav', known), 'components/Nav.tsx');
  assert.equal(resolveSpec('app/page.tsx', '@/hooks/useX', known), 'src/hooks/useX.ts');
  assert.equal(resolveSpec('app/page.tsx', 'react', known), null, 'a package is not a repo file');
});

const tree = (files) => buildGraph({ root: '/nowhere', files: Object.keys(files), read: (p) => files[p] });

test('consumersOf separates real callers from tests and follows re-export barrels', () => {
  const g = tree({
    'lib/feed.mjs': 'export function loadFeed() {}\nexport function isFresh() {}\n',
    'lib/index.mjs': "export { loadFeed } from './feed.mjs';\n",
    'engine/run.mjs': "import { loadFeed } from '../lib/index.mjs';\n",
    'lib/feed.test.mjs': "import { loadFeed, isFresh } from './feed.mjs';\n",
    'engine/evals/cases.mjs': "import { isFresh } from '../../lib/feed.mjs';\n",
  });
  assert.deepEqual(consumersOf(g, 'lib/feed.mjs', 'loadFeed', { tests: false }), ['engine/run.mjs'], 'through the barrel, to the real caller');
  assert.deepEqual(consumersOf(g, 'lib/feed.mjs', 'isFresh', { tests: false }), [], 'a test and the eval harness are not callers');
  assert.equal(consumersOf(g, 'lib/feed.mjs', 'isFresh', { tests: true }).length, 2);
  assert.deepEqual(neighbourhood(g, 'lib/feed.mjs').tests.sort(), ['engine/evals/cases.mjs', 'lib/feed.test.mjs']);
});

test('usedInternally counts a spread call and ignores member access and comments', () => {
  assert.equal(usedInternally('export function f() {}\nconst all = [...f()];\n', 'f'), true);
  assert.equal(usedInternally('export const U = {};\nreturn { ...U };\n', 'U'), true);
  assert.equal(usedInternally('export function f() {}\nobj.f();\n// f is great\n', 'f'), false);
  assert.equal(usedInternally('export function f() {}\n', 'f'), false);
});

test('entrypoints and tests are recognised by convention', () => {
  for (const p of ['scripts/x.mjs', 'api/brain.js', 'app/jobs/page.tsx', 'app/api/x/route.ts', 'brain/main.js', 'engine/server.mjs']) assert.equal(isEntrypoint(p), true, p);
  for (const p of ['lib/feed.mjs', 'engine/builder.mjs', 'components/Nav.tsx']) assert.equal(isEntrypoint(p), false, p);
  for (const p of ['a.test.mjs', 'x/y.spec.ts', 'engine/evals/cases.mjs', '__tests__/a.js']) assert.equal(isTest(p), true, p);
});

test('overrides model another state of the same tree without touching disk', () => {
  const files = { 'a.mjs': 'export function one() {}\n', 'b.mjs': "import { one } from './a.mjs';\n" };
  const before = buildGraph({ root: '/nowhere', files: Object.keys(files), read: (p) => files[p], overrides: { 'b.mjs': null, 'c.mjs': "import { one } from './a.mjs';\n" } });
  assert.deepEqual(consumersOf(before, 'a.mjs', 'one'), ['c.mjs']);
});
