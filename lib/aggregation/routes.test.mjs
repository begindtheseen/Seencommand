import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { handleAggregation } from './routes.mjs';

function req({ method = 'GET', url = '/api/aggregation/status', remote = '127.0.0.1', host = 'localhost:4173', origin, body } = {}) {
  const r = Readable.from(body === undefined ? [] : [typeof body === 'string' ? body : JSON.stringify(body)]);
  Object.assign(r, { method, url, socket: { remoteAddress: remote }, headers: { host, ...(origin ? { origin } : {}) } });
  return r;
}
function res() {
  const o = { code: null, body: null, headers: null };
  o.writeHead = (c, h) => { o.code = c; o.headers = h; return o; };
  o.end = (b) => { o.body = b ? JSON.parse(b) : null; };
  return o;
}
const calls = [];
const manager = {
  status: async () => ({ pipelines: {} }), health: async (o) => ({ refreshed: o.refresh }), collectors: () => [], getConfig: () => ({}),
  putConfig: (b) => (calls.push(['putConfig', b]), { ok: true }), listRuns: (q) => (calls.push(['listRuns', q]), []), getRun: () => null,
  startRun: async (o) => (calls.push(['startRun', o]), { ok: true, run: { id: 'r' } }), cancelRun: (id) => ({ ok: false, code: 404, error: 'no such run' }),
  getSchedules: () => ({}), putSchedule: async () => ({ ok: true }), previewTargets: async (n) => ({ ok: true, n }),
};
const call = async (o) => { const r = res(); await handleAggregation(req(o), r, { manager }); return r; };
const ORIGIN = 'http://localhost:4173';

test('reads are loopback-only and reject a foreign Host header (DNS rebinding)', async () => {
  assert.equal((await call({})).code, 200);
  assert.equal((await call({ remote: '10.0.0.5' })).code, 403);
  assert.equal((await call({ host: 'evil.example:4173' })).code, 403);
  assert.equal((await call({ url: '/api/aggregation/health?refresh=1' })).body.refreshed, true);
});

test('every mutation needs the local app Origin', async () => {
  assert.equal((await call({ method: 'POST', url: '/api/aggregation/runs', body: { pipeline: 'indeed' } })).code, 403);
  assert.equal((await call({ method: 'POST', url: '/api/aggregation/runs', origin: 'https://evil.example', body: { pipeline: 'indeed' } })).code, 403);
  assert.equal((await call({ method: 'PUT', url: '/api/aggregation/config', body: {} })).code, 403);
  const ok = await call({ method: 'POST', url: '/api/aggregation/runs', origin: ORIGIN, body: { pipeline: 'indeed', confirmLarge: true } });
  assert.equal(ok.code, 202);
  const started = calls.find((c) => c[0] === 'startRun')[1];
  assert.equal(started.trigger, 'manual'); assert.equal(started.owner, 'local-operator'); assert.equal(started.confirmLarge, true);
});

test('inputs are validated before the manager sees them; nothing executable is accepted', async () => {
  assert.equal((await call({ method: 'POST', url: '/api/aggregation/runs', origin: ORIGIN, body: { pipeline: 'indeed', command: 'opencli x' } })).code, 400);
  assert.equal((await call({ method: 'POST', url: '/api/aggregation/runs', origin: ORIGIN, body: { pipeline: 'indeed', overrides: 'x' } })).code, 400);
  assert.equal((await call({ method: 'POST', url: '/api/aggregation/runs', origin: ORIGIN, body: '{not json' })).code, 400);
  assert.equal((await call({ method: 'POST', url: '/api/aggregation/runs', origin: ORIGIN, body: 'x'.repeat(300 * 1024) })).code, 413);
  assert.equal((await call({ url: '/api/aggregation/runs/../../etc/passwd' })).code, 404); // URL-normalized away: no path is ever read
  assert.equal((await call({ url: '/api/aggregation/runs/not-a-run-id' })).code, 400);
  assert.equal((await call({ url: '/api/aggregation/runs?pipeline=shell' })).code, 400);
  assert.equal((await call({ url: '/api/aggregation/runs?since=yesterday' })).code, 400);
  assert.equal((await call({ method: 'POST', url: '/api/aggregation/runs/agg-indeed-20261020T000000Z-abcdef/cancel', origin: ORIGIN, body: {} })).code, 404);
  assert.equal((await call({ method: 'POST', url: '/api/aggregation/company-intel/targets', origin: ORIGIN, body: { limit: 500 } })).code, 400);
  assert.equal((await call({ url: '/api/aggregation/nope' })).code, 404);
});

test('employer-board pull: local Origin required, only companies/limit accepted, upstream failures are 502', async () => {
  const m = { ...manager, boardsStatus: () => ({ running: false, last: null }), pullBoards: async (b) => (calls.push(['pullBoards', b]), b.limit === 13 ? { ok: false, error: 'Seen answered HTTP 500' } : { ok: true, saved: 5 }) };
  const c = async (o) => { const r = res(); await handleAggregation(req(o), r, { manager: m }); return r; };
  assert.deepEqual((await c({ url: '/api/aggregation/boards' })).body, { running: false, last: null });
  assert.equal((await c({ method: 'POST', url: '/api/aggregation/boards/pull', body: { limit: 5 } })).code, 403);
  assert.equal((await c({ method: 'POST', url: '/api/aggregation/boards/pull', origin: ORIGIN, body: { limit: 5, url: 'https://evil' } })).code, 400);
  const ok = await c({ method: 'POST', url: '/api/aggregation/boards/pull', origin: ORIGIN, body: { companies: ['Soylent'] } });
  assert.equal(ok.code, 200); assert.equal(ok.body.saved, 5);
  assert.equal((await c({ method: 'POST', url: '/api/aggregation/boards/pull', origin: ORIGIN, body: { limit: 13 } })).code, 502);
});

test('company job pull: local Origin required, known fields only, booleans checked, 202 on start', async () => {
  const seen = [];
  const m = { ...manager, companyJobsStatus: () => ({ running: false, last: null }), companyJobs: async (b) => (seen.push(b), b.companies.length ? { ok: true, state: { running: true } } : { ok: false, code: 400, error: 'choose 1–10 companies' }) };
  const c = async (o) => { const r = res(); await handleAggregation(req(o), r, { manager: m }); return r; };
  assert.deepEqual((await c({ url: '/api/aggregation/company-jobs' })).body, { running: false, last: null });
  assert.equal((await c({ method: 'POST', url: '/api/aggregation/company-jobs', body: { companies: ['Vandelay'] } })).code, 403);
  assert.equal((await c({ method: 'POST', url: '/api/aggregation/company-jobs', origin: ORIGIN, body: { companies: ['Vandelay'], script: 'x' } })).code, 400);
  assert.equal((await c({ method: 'POST', url: '/api/aggregation/company-jobs', origin: ORIGIN, body: { companies: ['Vandelay'], indeed: 'yes' } })).code, 400);
  assert.equal((await c({ method: 'POST', url: '/api/aggregation/company-jobs', origin: ORIGIN, body: { companies: [] } })).code, 400);
  const ok = await c({ method: 'POST', url: '/api/aggregation/company-jobs', origin: ORIGIN, body: { companies: ['Vandelay'], websites: { Vandelay: 'vandelay.example' }, siteLimit: 20, indeed: true, browser: false } });
  assert.equal(ok.code, 202);
  assert.deepEqual(seen.at(-1), { companies: ['Vandelay'], websites: { Vandelay: 'vandelay.example' }, siteLimit: 20, indeed: true, browser: false });
  assert.equal((await c({ url: '/api/aggregation/runs?source=career_site' })).code, 200);
});
