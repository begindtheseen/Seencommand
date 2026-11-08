// The Creator Library's HTTP routes and Board Room chat commands over REAL SQLite projects (temp home):
// accounts with verdicts, one creator's key points, unresolved, prune → restore, purge refusal,
// discovery listing. No network, no spawn (nothing here starts a research job or opens a browser).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureCorpora, motionCorpus, writeFixtureProject } from './insights.fixtures.mjs';

const base = mkdtempSync(join(tmpdir(), 'ig-libroutes-'));
const root = join(base, 'roots'); mkdirSync(root, { recursive: true }); mkdirSync(join(base, 'jobs'), { recursive: true });
process.env.SEEN_HOME = base; process.env.VSC_READONLY_ROOTS = root; process.env.VSC_DATA_ROOT = join(base, 'jobs');
for (const c of fixtureCorpora()) await writeFixtureProject(root, c);
await writeFixtureProject(root, motionCorpus(), { unresolved: [{ knowledge_id: 'k-m2' }] });
const { handleInstagram, handleInstagramChat } = await import('./routes.mjs');
test.after(() => rmSync(base, { recursive: true, force: true }));

async function call(method, url, payload) {
  const res = { statusCode: 0, body: null, writeHead(c) { this.statusCode = c; }, end(s) { this.body = s ? JSON.parse(s) : null; } };
  const handlers = {};
  const req = { method, url, on(ev, fn) { handlers[ev] = fn; } };
  const p = handleInstagram(req, res, url);
  if (handlers.data && payload !== undefined) handlers.data(JSON.stringify(payload));
  if (handlers.end) handlers.end();
  await p;
  return res;
}

test('GET /library and /creators: every account with its keep / prune verdict, reason and open unresolved', async () => {
  const lib = await call('GET', '/api/instagram/library');
  assert.equal(lib.statusCode, 200);
  const by = Object.fromEntries(lib.body.projects.map((p) => [p.name, p]));
  assert.equal(by['instagram-alpha'].verdict.verdict, 'keep');
  assert.equal(by['instagram-motion'].verdict.verdict, 'prune');
  assert.match(by['instagram-motion'].verdict.why, /0 of 2 knowledge records \(0%\) serve Seen/);
  assert.deepEqual(by['instagram-motion'].unresolved, { total: 1, open: 1, resolved: 0 }, 'one video, no second source → still open');
  const cr = await call('GET', '/api/instagram/creators');
  const m = cr.body.creators.find((c) => c.handle === '@motion');
  assert.equal(m.verdict, 'prune');
  assert.ok(m.why);
});

test('GET /creators/:user — one creator\'s key points with citations; unknown → 404', async () => {
  const r = await call('GET', '/api/instagram/creators/alpha');
  assert.equal(r.statusCode, 200);
  assert.ok(r.body.keyPoints.length > 0);
  assert.ok(r.body.keyPoints.every((k) => k.citations.length));
  assert.match(r.body.text, /^@alpha: 8 videos/);
  assert.equal((await call('GET', '/api/instagram/creators/nobody_here')).statusCode, 404);
});

test('unresolved: GET explains what it means; POST decides one; the account count follows', async () => {
  const u = await call('GET', '/api/instagram/projects/instagram-motion/unresolved');
  assert.match(u.body.meaning, /never revisits them/);
  assert.equal(u.body.open, 1);
  const d = await call('POST', '/api/instagram/projects/instagram-motion/unresolved/k-m2', { status: 'deprecated', note: 'software trivia' });
  assert.equal(d.statusCode, 200);
  const lib = await call('GET', '/api/instagram/library');
  assert.deepEqual(lib.body.projects.find((p) => p.name === 'instagram-motion').unresolved, { total: 1, open: 0, resolved: 1 });
  assert.equal((await call('POST', '/api/instagram/projects/instagram-motion/unresolved/k-m2', { status: 'nope' })).statusCode, 400);
});

test('prune: plan → archive (gone from insights + chat) → restore; purge needs the phrase', async () => {
  const plan = await call('GET', '/api/instagram/prune');
  assert.deepEqual(plan.body.plan.accounts.map((a) => a.project), ['instagram-motion']);
  assert.ok(plan.body.plan.rows.some((r) => r.knowledge_id === 'k-c1' && r.why), "charlie's cooking tip is an off-purpose row");
  const applied = await call('POST', '/api/instagram/prune');
  assert.deepEqual(applied.body.archived, { accounts: 1, rows: plan.body.plan.rows.length });
  const ins = await call('GET', '/api/instagram/insights');
  assert.ok(!ins.body.creators.some((c) => c.project === 'instagram-motion'), 'archived account is gone from the insights');
  const kp = await call('GET', '/api/instagram/creators/motion');
  assert.equal(kp.body.archived, true);
  const chat = await handleInstagramChat('key points for @motion');
  assert.match(chat.reply, /archived by prune/);
  assert.equal((await call('POST', '/api/instagram/purge-archived', { confirm: 'yes' })).statusCode, 400, 'purge refuses without the exact phrase');
  const back = await call('POST', '/api/instagram/prune/restore', { all: true });
  assert.equal(back.body.restored.accounts, 1);
});

test('chat: "creators", "prune creator library", "restore creator library", "purge archived creators" (refused without the phrase)', async () => {
  const list = await handleInstagramChat('creators');
  assert.match(list.reply, /@motion: 3 videos .* — PRUNE: /);
  assert.match(list.reply, /@alpha: .* — KEEP: /);
  const p = await handleInstagramChat('prune creator library');
  assert.match(p.reply, /^Archived 1 account\(s\) and \d+ off-purpose knowledge row\(s\)/);
  assert.match(p.reply, /restore creator library/);
  const purge = await handleInstagramChat('purge archived creators');
  assert.match(purge.reply, /say exactly: purge archived creators confirm PURGE ARCHIVED/);
  const r = await handleInstagramChat('restore creator library');
  assert.match(r.reply, /^Restored 1 account\(s\)/);
  assert.equal(await handleInstagramChat('what is our MRR?'), null, 'unrelated messages fall through');
});

test('discovery routes: list, unknown id 404, bad goal 400 (the search itself is covered with a fake browser)', async () => {
  assert.deepEqual((await call('GET', '/api/instagram/discover')).body.discoveries, []);
  assert.equal((await call('GET', '/api/instagram/discover/disc-0000000000')).statusCode, 404);
  assert.equal((await call('POST', '/api/instagram/discover', { goal: '' })).statusCode, 400);
  assert.deepEqual((await call('GET', '/api/instagram/queue')).body.queue, []);
});
