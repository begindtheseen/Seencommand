import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { proofErrors, productGate, toolGate, runNodeTests, memoGate, treeKey, tscErrors, PER_TEST_TIMEOUT_MS } from './gate.mjs';

const T = (name, body) => `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n${body.imports}\ntest('${name}', () => { ${body.assert} });\n`;
const feed = 'export function loadFeed(rows) {\n  return rows.filter((r) => r && r.id);\n}\n';
const guarded = `${feed}\nexport function isFresh(row, now) {\n  return row.at == null || now - row.at < 60000;\n}\n`;

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'gate-'));
  const g = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  execFileSync('git', ['init', '-b', 'main', root], { stdio: 'pipe' });
  g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false');
  put(root, { 'package.json': '{ "type": "module" }\n', ...files });
  g('add', '-A'); g('commit', '-m', 'seed');
  return root;
}
function put(root, files) { for (const [p, b] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), b); } }
const oldTest = T('loads', { imports: "import { loadFeed } from './feed.mjs';", assert: 'assert.equal(loadFeed([{ id: 1 }]).length, 1);' });
const bitingTest = T('fresh', { imports: "import { isFresh } from './feed.mjs';", assert: 'assert.equal(isFresh({ at: 0 }, 60001), false);' });

test('proof: a test that FAILS against the base proves the change; the tree is restored exactly', () => {
  const root = repo({ 'lib/feed.mjs': feed, 'lib/feed.test.mjs': oldTest });
  put(root, { 'lib/feed.mjs': guarded, 'lib/feed.test.mjs': bitingTest });
  assert.deepEqual(proofErrors(root, ['lib/feed.mjs', 'lib/feed.test.mjs']), []);
  assert.equal(readFileSync(join(root, 'lib/feed.mjs'), 'utf8'), guarded, 'the swapped source was put back');
});

test('proof: tests that PASS against the base do not prove the change, and a change with no test proves nothing', () => {
  const root = repo({ 'lib/feed.mjs': feed, 'lib/feed.test.mjs': oldTest });
  put(root, { 'lib/feed.mjs': guarded, 'lib/feed.test.mjs': `${oldTest}// touched, still only asserts old behaviour\n` });
  assert.match(proofErrors(root, ['lib/feed.mjs', 'lib/feed.test.mjs'])[0], /PASS against the base code — they do not fail without this change/);
  assert.match(proofErrors(root, ['lib/feed.mjs'])[0], /includes no test/);
  assert.equal(readFileSync(join(root, 'lib/feed.mjs'), 'utf8'), guarded);
});

test('proof: a NEW source file is removed for the base run and restored after it', () => {
  const root = repo({ 'lib/feed.mjs': feed });
  const clock = 'export function nowMs() {\n  return Date.now();\n}\n';
  put(root, { 'lib/clock.mjs': clock, 'lib/clock.test.mjs': T('now', { imports: "import { nowMs } from './clock.mjs';", assert: 'assert.ok(nowMs() > 0);' }) });
  assert.deepEqual(proofErrors(root, ['lib/clock.mjs', 'lib/clock.test.mjs']), [], 'with the module gone the test cannot even import it — red, so it bites');
  assert.equal(readFileSync(join(root, 'lib/clock.mjs'), 'utf8'), clock);
});

test('proof: what needs proving is decided by the contract kind, and by whether CODE changed', () => {
  const root = repo({ 'lib/feed.mjs': feed, 'components/Nav.jsx': 'export function Nav() { return null; }\n', 'scripts/cli.mjs': 'console.log(1);\n' });
  put(root, { 'lib/feed.mjs': `// a comment only\n${feed}` });
  assert.deepEqual(proofErrors(root, ['lib/feed.mjs']), [], 'comment-only: the comment-only layer owns that message');
  put(root, { 'lib/feed.mjs': guarded, 'components/Nav.jsx': 'export function Nav() { return 1; }\n', 'scripts/cli.mjs': 'console.log(2);\n' });
  assert.deepEqual(proofErrors(root, ['components/Nav.jsx', 'scripts/cli.mjs']), [], 'components and CLI scripts are proven by running them');
  assert.deepEqual(proofErrors(root, ['lib/feed.mjs'], { kind: 'ui' }), []);
  assert.deepEqual(proofErrors(root, ['lib/feed.mjs'], { kind: 'docs' }), []);
  assert.match(proofErrors(root, ['lib/feed.mjs'], { kind: 'refactor' })[0], /refactor, so it may not change what the module exports — before: \[loadFeed\], after: \[isFresh, loadFeed\]/);
  put(root, { 'lib/feed.mjs': 'export function loadFeed(rows) {\n  const ok = (r) => r && r.id;\n  return rows.filter(ok);\n}\n' });
  assert.deepEqual(proofErrors(root, ['lib/feed.mjs'], { kind: 'refactor' }), [], 'same surface → an honest refactor');
});

test('runNodeTests: a red child is RED even when launched from inside a test runner, and a hang is NAMED', () => {
  assert.ok(process.env.NODE_TEST_CONTEXT, 'this test is itself running under node --test — the exact condition that used to flip red to green');
  const root = repo({ 'red.test.mjs': T('red', { imports: '', assert: 'assert.equal(1, 2);' }), 'ok.test.mjs': T('ok', { imports: '', assert: 'assert.equal(1, 1);' }) });
  assert.equal(runNodeTests(root, ['ok.test.mjs']).ok, true);
  const red = runNodeTests(root, ['ok.test.mjs', 'red.test.mjs']);
  assert.equal(red.ok, false);
  assert.match(red.output, /red/);
  let args = null;
  runNodeTests(root, ['ok.test.mjs'], { execFn: (_bin, a) => { args = a; return ''; } });
  assert.ok(args.includes(`--test-timeout=${PER_TEST_TIMEOUT_MS}`), 'a hanging test is killed and named, not a silent whole-run timeout');
});

test('tsc absent fails CLOSED; a switched-off production build is UNPROVEN, never silently passed', () => {
  const root = repo({ 'lib/a.ts': 'export const a: number = 1;\n', 'package.json': '{ "type": "module", "scripts": { "test": "node -e 0", "build": "node -e 0" } }\n' });
  assert.match(tscErrors(root, ['lib/a.ts'])[0], /cannot be type-checked here/);
  put(root, { 'lib/b.mjs': 'export const b = 2;\n' });
  process.env.PRODUCT_BUILD_GATE = '0';
  try {
    const g = productGate(root, ['lib/b.mjs'], { kind: 'docs' });
    assert.equal(g.green, true);
    assert.deepEqual(g.unproven, ['the production build was skipped (PRODUCT_BUILD_GATE=0)']);
  } finally { delete process.env.PRODUCT_BUILD_GATE; }
  assert.deepEqual(productGate(root, ['lib/b.mjs'], { kind: 'docs' }).unproven, []);
});

test('memoGate: one verdict per exact tree state — free when nothing changed, re-judged when anything did', () => {
  const root = repo({ 'lib/feed.mjs': feed });
  let runs = 0;
  const gate = memoGate((_r, touched, opts) => { runs++; return { green: true, errors: [], unproven: [], touched, opts }; }, { kind: 'refactor' });
  gate(root, ['lib/feed.mjs']); gate(root, ['lib/feed.mjs']);
  assert.equal(runs, 1);
  assert.equal(gate(root, ['lib/feed.mjs']).opts.kind, 'refactor', 'the contract kind is bound in');
  const before = treeKey(root);
  put(root, { 'lib/feed.mjs': guarded });
  assert.notEqual(treeKey(root), before);
  gate(root, ['lib/feed.mjs']);
  put(root, { 'lib/new.mjs': 'export const n = 1;\n' }); // an UNTRACKED byte changes the state too
  gate(root, ['lib/feed.mjs']);
  assert.equal(runs, 3);
  assert.equal(existsSync(join(root, 'lib/new.mjs')), true);
});

test('toolGate runs the structural and proof steps and reports unproven as an empty list', () => {
  const root = repo({ 'lib/feed.mjs': feed, 'lib/feed.test.mjs': oldTest, 'engine/run.mjs': "import { loadFeed } from '../lib/feed.mjs';\nexport const run = (r) => loadFeed(r).length;\n", 'scripts/main.mjs': "import { run } from '../engine/run.mjs';\nrun([]);\n" });
  put(root, { 'lib/feed.mjs': guarded, 'lib/feed.test.mjs': bitingTest });
  const g = toolGate(root, ['lib/feed.mjs', 'lib/feed.test.mjs']);
  assert.equal(g.green, false);
  assert.match(g.errors.join('\n'), /WIRING lib\/feed\.mjs: .*`isFresh`/, 'tested but uncalled → the wiring step speaks first');
  assert.deepEqual(g.unproven, []);
});

test('a PARTIAL (step) gate keeps only what must hold at every instant; the whole-change rules wait for the finished change', () => {
  const root = repo({ 'lib/feed.mjs': feed, 'lib/feed.test.mjs': oldTest, 'engine/run.mjs': "import { loadFeed } from '../lib/feed.mjs';\nexport const run = (r) => loadFeed(r).length;\n", 'scripts/main.mjs': "import { run } from '../engine/run.mjs';\nrun([]);\n" });
  // Forge's step 1: the helper, with no caller and no test yet — both arrive in later steps.
  put(root, { 'lib/feed.mjs': guarded });
  const gate = memoGate(toolGate, { kind: 'behaviour' });
  assert.equal(gate.partial(root, ['lib/feed.mjs']).green, true, 'step 1 of a multi-step plan is not rejected for what step 2 will add');
  const full = gate(root, ['lib/feed.mjs']);
  assert.equal(full.green, false, 'the SAME tree is not shippable');
  assert.match(full.errors.join('\n'), /WIRING .*`isFresh`/);
  // …but a partial gate still refuses what is broken right now: a call to something never imported.
  put(root, { 'engine/run.mjs': "import { loadFeed } from '../lib/feed.mjs';\nexport const run = (r) => loadFeed(r).filter((x) => isFresh(x, 1)).length;\n" });
  assert.match(gate.partial(root, ['lib/feed.mjs', 'engine/run.mjs']).errors.join('\n'), /calls `isFresh\(\)` but never imports/);
});

test('a red run NAMES its failing tests first, however long the assertion diff below them is', () => {
  const long = `assert.equal('${'x'.repeat(3000)}', 'y');`;
  const root = repo({ 'red.test.mjs': T('the ahead count is reported', { imports: '', assert: long }) });
  const r = runNodeTests(root, ['red.test.mjs']);
  assert.equal(r.ok, false);
  assert.match(r.output.split('\n')[0], /^✖ the ahead count is reported$/);
});

// Live on 2026-09-21: EVERY product build was refused with "the base branch's own test suite is red"
// while that base was green (921/921). The gate handed the test child the owner's real .env; the product
// suite defaults its config from env, so the owner's live SUPABASE_URL replaced the fixture URL its fetch
// mock matches on and 8 tests failed. A gate whose verdict depends on whose machine it runs on is not a gate.
test('a TEST child is hermetic — the owner\'s credentials never decide whether the base is green', async () => {
  const { hermeticEnv, nodeTestCommand, TEST_ENV_STRIP } = await import('./gate.mjs');
  const operator = { SUPABASE_URL: 'https://real.supabase.co', SUPABASE_SERVICE_KEY: 'live-key', BRAIN_API_TOKEN: 't', CHRONOS_VAULT: '/vault', GITHUB_TOKEN: 'gh', ANTHROPIC_API_KEY: 'k', GROQ_API_KEY: 'g', VERCEL_TOKEN: 'v', STRIPE_SECRET_KEY: 's' };
  const env = hermeticEnv({ PATH: '/usr/bin', HOME: '/Users/x', SEEN_HOME: '/h', NODE_ENV: 'test', ...operator });
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'NODE_ENV', 'PATH', 'SEEN_HOME'], 'credentials and service endpoints go; the rest stays so paths still resolve');
  for (const k of Object.keys(operator)) assert.equal(TEST_ENV_STRIP.test(k), true, k);
  for (const k of ['PATH', 'HOME', 'SEEN_HOME', 'SEEN_COMMAND_REPO_DIR', 'NODE_ENV', 'TMPDIR']) assert.equal(TEST_ENV_STRIP.test(k), false, k);
  // every node:test child goes through ONE command builder, so no caller can leak the env back in
  process.env.SUPABASE_URL = 'https://real.supabase.co';
  try { assert.equal('SUPABASE_URL' in nodeTestCommand(['x.test.mjs']).env, false); } finally { delete process.env.SUPABASE_URL; }
});

test('the production build is NOT hermetic — it mimics Vercel, which builds with the project env', async () => {
  const { productBuildErrors } = await import('./gate.mjs');
  const root = repo({ 'package.json': '{ "type": "module", "scripts": { "build": "node -e 0" } }\n' });
  process.env.SUPABASE_URL = 'https://real.supabase.co';
  let saw = null;
  try { productBuildErrors(root, (_b, _a, o) => { saw = o.env; return ''; }); } finally { delete process.env.SUPABASE_URL; }
  assert.equal(saw.SUPABASE_URL, 'https://real.supabase.co', 'stripping NEXT_PUBLIC_*/service env here would invent build failures');
});
