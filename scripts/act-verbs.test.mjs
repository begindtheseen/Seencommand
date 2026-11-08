// The parity verbs of scripts/act.mjs against a stub of the app's routes: each sends the same method,
// path and body as its button, and no answer carries a credential. No real app, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const ACT = new URL('./act.mjs', import.meta.url).pathname;

// handler(method, url, body) → [code, json] | undefined (→ 200 { ok: true, echo: body })
function stubApp(handler = () => undefined) {
  const seen = [];
  const srv = createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
      const body = b ? JSON.parse(b) : null;
      seen.push({ method: req.method, url: req.url, body, origin: req.headers.origin });
      const [code, j] = handler(req.method, req.url, body) || [200, { ok: true, echo: body }];
      res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ seen, url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) })));
}
const act = (url, args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [ACT, ...args], { env: { ...process.env, SEEN_COMMAND_URL: url } });
  let out = ''; p.stdout.on('data', (d) => { out += d; }); p.on('close', (code) => resolve({ code, out, json: JSON.parse(out.trim()) }));
});
const last = (app) => app.seen.at(-1);

test('build files a task + starts the builder through /api/tasks/new; task verbs send the Tasks-tab bodies', async () => {
  const app = await stubApp();
  try {
    let r = await act(app.url, ['build', 'seen', 'add', 'a', 'salary', 'filter', 'to', 'the', 'jobs', 'page']);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(last(app), { method: 'POST', url: '/api/tasks/new', body: { repo: 'seen', task: 'add a salary filter to the jobs page' }, origin: app.url });
    r = await act(app.url, ['build', 'website', 'do it']);
    assert.equal(r.code, 1); assert.match(r.json.error, /build <seen\|command>/);
    await act(app.url, ['task-build', '42', 'repo=tool']);
    assert.deepEqual(last(app).body, { number: 42, repo: 'tool' });
    await act(app.url, ['task-delete', '42', 'done', 'already']);
    assert.deepEqual([last(app).url, last(app).body], ['/api/tasks/delete', { number: 42, reason: 'done already' }]);
  } finally { await app.close(); }
});

test('builds + build-status read /api/builds; build-status takes a task number and shows the log tail', async () => {
  const log = Array.from({ length: 40 }, (_, i) => `line ${i}`);
  const app = await stubApp((m, u) => (u === '/api/builds' ? [200, { builds: [{ id: 'task-7', title: 'T', repo: 'tool', status: 'building', log, task: 'do T' }] }] : undefined));
  try {
    let r = await act(app.url, ['builds']);
    assert.equal(r.json.builds[0].id, 'task-7'); assert.equal(r.json.builds[0].log, undefined, 'the list is compact');
    r = await act(app.url, ['build-status', '7']);
    assert.equal(r.json.status, 'building'); assert.equal(r.json.log.length, 25); assert.equal(r.json.log.at(-1), 'line 39');
    r = await act(app.url, ['build-status', 'task-9']);
    assert.equal(r.code, 1); assert.match(r.json.error, /no build task-9/);
  } finally { await app.close(); }
});

test('ticket drawer verbs post to /api/tickets/:id/<verb> with the drawer bodies', async () => {
  const app = await stubApp();
  const id = 'tkt-0123456789';
  try {
    await act(app.url, ['ticket-fix', id]); assert.deepEqual([last(app).url, last(app).body], [`/api/tickets/${id}/fix`, {}]);
    await act(app.url, ['ticket-note', id, 'tried', 'twice']); assert.deepEqual(last(app).body, { text: 'tried twice' });
    await act(app.url, ['ticket-wontfix', id, 'not', 'needed']); assert.deepEqual([last(app).url, last(app).body], [`/api/tickets/${id}/wont-fix`, { reason: 'not needed' }]);
    await act(app.url, ['ticket-dup', id, 'tkt-aaaaaaaaaa']); assert.deepEqual([last(app).url, last(app).body], [`/api/tickets/${id}/duplicate`, { of: 'tkt-aaaaaaaaaa' }]);
    await act(app.url, ['ticket-reopen', id]); assert.deepEqual([last(app).url, last(app).body], [`/api/tickets/${id}/open`, {}]);
  } finally { await app.close(); }
});

test('notifications, settings and updater verbs hit the same routes as their buttons', async () => {
  const app = await stubApp();
  try {
    await act(app.url, ['notifications-read']); assert.deepEqual([last(app).url, last(app).body], ['/api/notifications/read', { ids: 'all' }]);
    await act(app.url, ['notifications-read', '3', '4']); assert.deepEqual(last(app).body, { ids: [3, 4] });
    await act(app.url, ['notifications-clear']); assert.equal(last(app).url, '/api/notifications/clear');
    await act(app.url, ['base-health']); assert.deepEqual([last(app).method, last(app).url], ['POST', '/api/diagnostics/base-health']);
    await act(app.url, ['cline-test']); assert.equal(last(app).url, '/api/credentials/cline-test');
    await act(app.url, ['cline-signin']); assert.deepEqual(last(app).body, { provider: 'cline' });
    await act(app.url, ['fix-agents']); assert.deepEqual([last(app).method, last(app).url], ['POST', '/api/agents/setup']);
    await act(app.url, ['update-check']); assert.equal(last(app).url, '/api/update/check');
    await act(app.url, ['update']); assert.deepEqual([last(app).method, last(app).url], ['POST', '/api/update/apply']);
    await act(app.url, ['data-health-auto', 'off']); assert.deepEqual([last(app).url, last(app).body], ['/api/data-health/settings', { auto: false }]);
    await act(app.url, ['brain-refresh']); assert.equal(last(app).url, '/api/brain/refresh');
    await act(app.url, ['brain-revoke', 'cl-1']); assert.deepEqual([last(app).url, last(app).body], ['/api/brain/access/revoke', { id: 'cl-1' }]);
    await act(app.url, ['workflow-cancel', 'wf-1']); assert.equal(last(app).url, '/api/intelligence/workflows/wf-1/cancel');
    for (const s of app.seen) assert.equal(s.origin, app.url, `${s.url} carries the local origin the write gate needs`);
  } finally { await app.close(); }
});

test('no answer carries a credential: secret-set hides the value even when the app echoes it, and drops secret-shaped keys', async () => {
  const VALUE = 'sk-test-0123456789abcdef';
  const app = await stubApp((m, u, b) => {
    if (u === '/api/credentials' && m === 'POST') return [200, { groups: [{ label: 'AI', fields: [{ key: 'ANTHROPIC_API_KEY', configured: true }] }], echoed: b.values?.ANTHROPIC_API_KEY, token: 'abc123456789' }];
    if (u === '/api/credentials/cline') return [400, { error: `Cline rejected ${b.apiKey}` }];
    if (u === '/api/brain/access') return [200, { clients: [{ id: 'cl-1', name: 'claude', secret: 'shh-0123456789', apiKey: 'k-0123456789' }] }];
    return undefined;
  });
  try {
    let r = await act(app.url, ['secret-set', 'ANTHROPIC_API_KEY', VALUE]);
    assert.equal(r.code, 0, r.out); assert.deepEqual(r.json, { ok: true, key: 'ANTHROPIC_API_KEY', configured: true });
    assert.equal(last(app).body.values.ANTHROPIC_API_KEY, VALUE, 'the value reaches the app');
    assert.ok(!r.out.includes(VALUE));
    r = await act(app.url, ['cline-setup', 'anthropic', VALUE]);
    assert.equal(r.code, 1); assert.ok(!r.out.includes(VALUE), 'an error message never repeats the key'); assert.match(r.json.error, /\[hidden\]/);
    r = await act(app.url, ['brain-access']);
    assert.deepEqual(r.json.clients, [{ id: 'cl-1', name: 'claude' }]);
    r = await act(app.url, ['secret-set', 'lowercase', 'x']);
    assert.equal(r.code, 1); assert.match(r.json.error, /secret-set <KEY>/);
  } finally { await app.close(); }
});

test('pipeline verbs: start with overrides, schedule merges the saved one, company-jobs splits on ;', async () => {
  const app = await stubApp((m, u) => {
    if (m === 'GET' && u === '/api/aggregation/schedules') return [200, { schedules: { indeed: { enabled: false, frequency: 'weekly', time: '06:00', weekday: 1 } } }];
    if (m === 'GET' && u === '/api/aggregation/config') return [200, { pipelines: { indeed: { depth: 'standard', maxPages: 3 } } }];
    return undefined;
  });
  try {
    await act(app.url, ['pipeline-start', 'indeed', 'confirm-large', 'maxPages=5', 'keywords=["forklift"]']);
    assert.deepEqual([last(app).url, last(app).body], ['/api/aggregation/runs', { pipeline: 'indeed', confirmLarge: true, overrides: { maxPages: 5, keywords: ['forklift'] } }]);
    let r = await act(app.url, ['pipeline-start', 'linkedin']); assert.equal(r.code, 1);
    await act(app.url, ['pipeline-schedule', 'indeed', 'enabled=true']);
    assert.deepEqual([last(app).method, last(app).url, last(app).body], ['PUT', '/api/aggregation/schedules/indeed', { enabled: true, frequency: 'weekly', time: '06:00', weekday: 1 }]);
    await act(app.url, ['pipeline-config', 'indeed', 'maxPages=4']);
    assert.deepEqual([last(app).method, last(app).body], ['PUT', { pipelines: { indeed: { depth: 'standard', maxPages: 4 } } }]);
    await act(app.url, ['company-jobs', 'Home Depot;', 'Acme', '|', 'acme.example']);
    assert.deepEqual(last(app).body, { companies: ['Home Depot', 'Acme'], websites: { Acme: 'acme.example' }, siteLimit: 40, indeed: true, browser: true });
    await act(app.url, ['boards-pull']); assert.deepEqual(last(app).body, { limit: 200 });
    r = await act(app.url, ['pipeline-cancel', 'run-1']); assert.equal(last(app).url, '/api/aggregation/runs/run-1/cancel');
  } finally { await app.close(); }
});

test('money + growth verbs send the form bodies (nested brand fields, results, allocation)', async () => {
  const app = await stubApp();
  try {
    await act(app.url, ['cost-remove', 'Vercel', 'Pro']); assert.deepEqual(last(app).body, { name: 'Vercel Pro', remove: true });
    await act(app.url, ['cash', 'none']); assert.deepEqual(last(app).body, { amount: null });
    await act(app.url, ['allocate-set', 'seed', 'profit=5', 'opex=65']); assert.deepEqual(last(app).body, { stage: 'seed', pcts: { profit: 5, opex: 65 } });
    await act(app.url, ['channel-set', 'reddit', 'ads', 'spend=50', 'signups=10', 'paid=1']); assert.deepEqual(last(app).body, { name: 'reddit ads', spend30d: '50', signups30d: '10', paid30d: '1' });
    await act(app.url, ['readiness', 'r1', 'done']); assert.deepEqual(last(app).body, { id: 'r1', done: true });
    await act(app.url, ['brand-set', 'colors.primary=#111', 'tagline=Know who ghosts', 'note=darker']);
    assert.deepEqual(last(app).body, { patch: { colors: { primary: '#111' }, tagline: 'Know who ghosts' }, note: 'darker' });
    await act(app.url, ['calendar-status', 'c1', 'posted']); assert.deepEqual([last(app).url, last(app).body], ['/api/growth/calendar/c1/status', { status: 'posted' }]);
    await act(app.url, ['calendar-results', 'c1', 'views=900', 'signups=4']); assert.deepEqual(last(app).body, { views: '900', signups: '4' });
    await act(app.url, ['growth-replan', 'weeks=8']); assert.deepEqual([last(app).url, last(app).body], ['/api/growth/plan', { weeks: 8 }]);
  } finally { await app.close(); }
});

test('creator verbs resolve @user to its project; cleanup previews first and confirms with the preview token', async () => {
  const app = await stubApp((m, u) => {
    if (u === '/api/instagram/creators') return [200, { creators: [{ handle: '@coach', project: 'instagram-coach' }] }];
    if (u === '/api/instagram/jobs') return [200, { jobs: [{ id: 'instagram-coach-20261020120000', username: 'coach' }] }];
    if (u.endsWith('/cleanup-preview')) return [200, { ok: true, preview: { ready: true, token: 'tok-1', file_count: 3 } }];
    return undefined;
  });
  try {
    await act(app.url, ['creator-search', '@coach', 'ghosting', 'hooks']);
    assert.deepEqual([last(app).url, last(app).body], ['/api/instagram/projects/instagram-coach/search', { query: 'ghosting hooks', limit: 25 }]);
    let r = await act(app.url, ['creator-cleanup', 'coach']);
    assert.equal(r.json.next, 'to delete the raw media: creator-cleanup coach confirm');
    assert.equal(r.json.preview.token, undefined, 'the cleanup token is not shown');
    assert.ok(!app.seen.some((s) => s.url.endsWith('/cleanup-confirm')), 'no confirm without "confirm"');
    await act(app.url, ['creator-cleanup', 'coach', 'confirm']);
    assert.deepEqual([last(app).url, last(app).body], ['/api/instagram/jobs/instagram-coach-20261020120000/cleanup-confirm', { token: 'tok-1' }]);
    await act(app.url, ['creator-delete', 'coach', 'instagram-coach']);
    assert.deepEqual([last(app).url, last(app).body], ['/api/instagram/projects/instagram-coach/delete', { confirm: 'instagram-coach' }]);
    r = await act(app.url, ['creator-search', 'nobody', 'x']); assert.equal(r.code, 1); assert.match(r.json.error, /not in the Creator Library/);
  } finally { await app.close(); }
});

test('help lists every verb by group', async () => {
  const r = await act('http://127.0.0.1:9', ['help']);
  assert.equal(r.code, 0);
  const all = r.json.groups.flatMap((g) => g.verbs);
  for (const v of ['build <seen|command>', 'fix-agents', 'update ', 'merge-pr ']) assert.ok(all.some((x) => x.startsWith(v)), v);
});
