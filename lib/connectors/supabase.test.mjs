import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advisors } from './supabase.mjs';

const ADVISOR_URL = /\/v1\/projects\/[^/]+\/advisors\//;
const PROJECTS_URL = /\/v1\/projects$/;

function withEnv(token, ref, fn) {
  const prev = [process.env.SUPABASE_ACCESS_TOKEN, process.env.SUPABASE_PROJECT_REF];
  process.env.SUPABASE_ACCESS_TOKEN = token;
  process.env.SUPABASE_PROJECT_REF = ref;
  return Promise.resolve(fn()).finally(() => {
    [process.env.SUPABASE_ACCESS_TOKEN, process.env.SUPABASE_PROJECT_REF] = prev;
    if (prev[0] === undefined) delete process.env.SUPABASE_ACCESS_TOKEN;
    if (prev[1] === undefined) delete process.env.SUPABASE_PROJECT_REF;
  });
}

// { advisor: <status>, projects: <status> } → a fetch stub that also records what was called.
function api({ advisor = 200, projects = 200, lints = [], body = '' } = {}) {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(String(url));
    const status = ADVISOR_URL.test(String(url)) ? advisor : projects;
    return { ok: status < 400, status, json: async () => ({ lints }), text: async () => body };
  };
  return { fetchFn, calls };
}

test('a working token returns the advisor lints', async () => {
  const { fetchFn, calls } = api({ lints: [{ name: 'rls_disabled' }] });
  const r = await withEnv('sbp_live', 'proj', () => advisors('security', { fetchFn }));
  assert.equal(r.available, true);
  assert.equal(r.count, 1);
  assert.equal(calls.length, 1); // the token probe only runs on the failure path
});

test('a service-role JWT in the token field is named as the wrong credential, without calling the API', async () => {
  const { fetchFn, calls } = api();
  const r = await withEnv('eyJhbGciOiJIUzI1NiJ9.x.y', 'proj', () => advisors('security', { fetchFn }));
  assert.equal(r.available, false);
  assert.equal(r.reason, 'wrong-credential');
  assert.match(r.fix, /sbp_/);
  assert.equal(calls.length, 0);
});

test('a 401 on a dead token is reported as a revoked token, not as a bad project reference', async () => {
  const { fetchFn } = api({ advisor: 401, projects: 401, body: '{"message":"Unauthorized"}' });
  const r = await withEnv('sbp_dead', 'proj', () => advisors('security', { fetchFn }));
  assert.equal(r.status, 401);
  assert.equal(r.reason, 'token-rejected');
  assert.match(r.fix, /revoked, expired, or mistyped/);
  assert.match(r.message, /Unauthorized/);
});

test('a live token that cannot see the project blames the project reference', async () => {
  const { fetchFn } = api({ advisor: 404, projects: 200 });
  const r = await withEnv('sbp_live', 'wrong-ref', () => advisors('security', { fetchFn }));
  assert.equal(r.reason, 'unknown-project');
  assert.match(r.fix, /wrong-ref/);
});

test('a live token rejected on the project (403) reports a permission problem', async () => {
  const { fetchFn } = api({ advisor: 403, projects: 200 });
  const r = await withEnv('sbp_live', 'proj', () => advisors('security', { fetchFn }));
  assert.equal(r.reason, 'project-forbidden');
  assert.match(r.fix, /organization/);
});

test('a 500 is reported as a transient API failure, with no extra token probe', async () => {
  const { fetchFn, calls } = api({ advisor: 500 });
  const r = await withEnv('sbp_live', 'proj', () => advisors('security', { fetchFn }));
  assert.equal(r.reason, 'http');
  assert.equal(calls.length, 1);
});

test('missing credentials stay "not configured" rather than reporting a failure', async () => {
  const r = await withEnv('', '', () => advisors('security', { fetchFn: async () => { throw new Error('must not be called'); } }));
  assert.equal(r.reason, 'not-configured');
});

test('a network failure is reported without pretending the token is bad', async () => {
  const r = await withEnv('sbp_live', 'proj', () => advisors('security', { fetchFn: async () => { throw new Error('getaddrinfo ENOTFOUND'); } }));
  assert.equal(r.reason, 'network');
  assert.match(r.error, /ENOTFOUND/);
});
