import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schemaFindings, definedFunctions, schemaErrors } from './schema-refs.mjs';

function repo({ migrations = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'schema-refs-'));
  const g = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  execFileSync('git', ['init', '-b', 'main', root], { stdio: 'pipe' });
  g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false');
  mkdirSync(join(root, 'lib'), { recursive: true });
  writeFileSync(join(root, 'lib/store.mjs'), "export async function put(rest) { await rest('rpc/brain_replace_note', {}); }\n");
  if (migrations) {
    mkdirSync(join(root, 'supabase/migrations'), { recursive: true });
    writeFileSync(join(root, 'supabase/migrations/001.sql'), 'create or replace function public.brain_replace_note(p_path text) returns void language sql as $$ select 1 $$;\nCREATE FUNCTION "public"."consume_credit"() returns void language sql as $$ select 1 $$;\n');
  }
  g('add', '-A'); g('commit', '-m', 'seed');
  return root;
}
const only = (root) => [{ root, ref: null }];

test('a call to an RPC that a migration defines passes; one that nothing defines is named', () => {
  const root = repo();
  writeFileSync(join(root, 'lib/store.mjs'), "export async function put(rest) { await rest('rpc/brain_replace_note', {}); }\nexport async function touch(db) { await db.rpc('brain_touch_feed'); await rest('rpc/consume_credit'); }\n");
  const f = schemaFindings({ repoRoot: root, touched: ['lib/store.mjs'], roots: only(root) });
  assert.deepEqual(f.map((x) => x.name), ['brain_touch_feed']);
  assert.match(f[0].reason, /no migration under supabase\/migrations creates it/);
  assert.deepEqual([...definedFunctions(only(root)).defined].sort(), ['brain_replace_note', 'consume_credit']);
});

test('only ADDED calls are judged — a pre-existing call is not this change\'s problem, nor is a comment or a test', () => {
  const root = repo({ migrations: true });
  writeFileSync(join(root, 'supabase/migrations/001.sql'), '-- no functions\n'); // brain_replace_note now undefined, but its call is OLD
  writeFileSync(join(root, 'lib/store.mjs'), "export async function put(rest) { await rest('rpc/brain_replace_note', {}); }\n// later: rest('rpc/imaginary_fn')\nexport const N = 1;\n");
  writeFileSync(join(root, 'lib/store.test.mjs'), "await rest('rpc/only_in_a_test');\n");
  assert.deepEqual(schemaFindings({ repoRoot: root, touched: ['lib/store.mjs', 'lib/store.test.mjs'], roots: only(root) }), []);
});

test('with no migrations anywhere the check fails closed, and SCHEMA_CHECK=0 is the explicit escape hatch', () => {
  const root = repo({ migrations: false });
  writeFileSync(join(root, 'lib/store.mjs'), "export async function put(rest) { await rest('rpc/new_fn', {}); }\n");
  const f = schemaFindings({ repoRoot: root, touched: ['lib/store.mjs'], roots: only(root) });
  assert.match(f[0].reason, /fails closed/);
  process.env.SCHEMA_CHECK = '0';
  try { assert.deepEqual(schemaErrors(root, ['lib/store.mjs'], { roots: only(root) }), []); } finally { delete process.env.SCHEMA_CHECK; }
});

test('a migration present only on the base REF (not the working tree) still counts', () => {
  const root = repo();
  execFileSync('git', ['checkout', '-q', '-b', 'feature'], { cwd: root });
  execFileSync('git', ['rm', '-q', '-r', 'supabase'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'feature branch lacks the migration'], { cwd: root });
  assert.equal(definedFunctions([{ root, ref: 'main' }]).defined.has('brain_replace_note'), true);
  assert.equal(definedFunctions(only(root)).defined.has('brain_replace_note'), false);
});
