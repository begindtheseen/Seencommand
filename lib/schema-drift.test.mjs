import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rpcRefsInRepo, liveRpcs, schemaDrift } from './schema-drift.mjs';

const FILES = {
  'lib/store.mjs': "await rest('rpc/brain_replace_note', {});\n// await rest('rpc/commented_out')\nconst u = 'https://www.indeed.com/rpc/jobdescs?jks=1';\n",
  'api/credit.js': "const { data } = await supabase.rpc('atomic_consume_credit', { uid });\nfetch(`${url}/rest/v1/rpc/brain_touch`);\n",
  'lib/store.test.mjs': "await rest('rpc/only_in_a_test');\n",
};
const refs = () => rpcRefsInRepo('/r', { files: Object.keys(FILES), read: (f) => FILES[f] });
const openapi = (paths) => async () => ({ ok: true, json: async () => ({ paths: Object.fromEntries(paths.map((p) => [p, {}])) }) });

test('a DATABASE call is recognised; a comment, a test and someone else\'s /rpc/ URL are not', () => {
  assert.deepEqual([...refs().keys()].sort(), ['atomic_consume_credit', 'brain_replace_note', 'brain_touch']);
  assert.deepEqual(refs().get('brain_replace_note'), ['lib/store.mjs']);
});

test('drift names every function the code calls that the LIVE database does not serve', async () => {
  const r = await schemaDrift({ refs: refs(), url: 'https://x.supabase.co', key: 'k', fetchFn: openapi(['/brain_notes', '/rpc/atomic_consume_credit', '/rpc/unrelated']) });
  assert.equal(r.checked, 3);
  assert.deepEqual(r.missing.map((m) => m.fn).sort(), ['brain_replace_note', 'brain_touch']);
  const ok = await schemaDrift({ refs: refs(), url: 'u', key: 'k', fetchFn: openapi(['/t', '/rpc/atomic_consume_credit', '/rpc/brain_replace_note', '/rpc/brain_touch']) });
  assert.deepEqual(ok.missing, []);
});

test('"could not ask" THROWS — it must never read as "nothing is missing"', async () => {
  await assert.rejects(liveRpcs({ url: '', key: '' }), /cannot be read/);
  await assert.rejects(liveRpcs({ url: 'u', key: 'k', fetchFn: async () => ({ ok: false, status: 401 }) }), /HTTP 401/);
  await assert.rejects(liveRpcs({ url: 'u', key: 'k', fetchFn: openapi([]) }), /lists no paths at all — refusing to conclude/);
});
