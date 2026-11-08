// scripts/act.mjs ticket + merge verbs, against a stub of the app's routes (no real app, no GitHub).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const ACT = new URL('./act.mjs', import.meta.url).pathname;
const HEAD = '0123456789abcdef0123456789abcdef01234567';

function stubApp() {
  const seen = [];
  const srv = createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body: b ? JSON.parse(b) : null, origin: req.headers.origin });
      const send = (code, j) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
      if (req.url === '/api/prs/begindtheseen/Seen/7') return send(200, { pr: { title: 'Fix search', url: 'https://github.com/begindtheseen/Seen/pull/7', base: 'next-migration', head: 'fix', headSha: HEAD, state: 'open', merged: false }, canMerge: true, reasons: [], checks: 'passing', tickets: ['tkt-0123456789'] });
      if (req.url === '/api/prs/begindtheseen/Seen/8') return send(200, { pr: { headSha: HEAD, state: 'open' }, canMerge: false, reasons: ['a check is failing'], checks: 'failing' });
      if (req.url === '/api/prs/begindtheseen/Seen/7/merge') return send(200, { ok: true, merged: true, sha: 'f'.repeat(40), tickets: ['tkt-0123456789'] });
      if (req.url === '/api/tickets' && req.method === 'POST') return send(201, { ok: true, action: 'created', ticket: { id: 'tkt-0123456789' } });
      if (req.url.startsWith('/api/tickets?')) return send(200, { summary: { active: 1 }, tickets: [{ id: 'tkt-0123456789', title: 'T', status: 'open', tool: true, helped: 'h' }] });
      return send(404, { error: 'no route' });
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, seen, url: `http://127.0.0.1:${srv.address().port}` })));
}
const act = (url, args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [ACT, ...args], { env: { ...process.env, SEEN_COMMAND_URL: url } });
  let out = ''; p.stdout.on('data', (d) => { out += d; }); p.on('close', (code) => resolve({ code, json: JSON.parse(out.trim()) }));
});

test('merge-pr shows the phrase first, refuses a wrong one or a red PR, and merges only with the exact phrase', async () => {
  const { srv, seen, url } = await stubApp();
  try {
    let r = await act(url, ['merge-pr', 'begindtheseen/Seen', '7']);
    assert.equal(r.code, 0); assert.equal(r.json.merged, false);
    assert.equal(r.json.confirmPhrase, `merge begindtheseen/Seen#7 ${HEAD.slice(0, 7)}`);
    assert.equal(seen.some((x) => x.url.endsWith('/merge')), false, 'no confirm → no merge call');
    r = await act(url, ['merge-pr', 'begindtheseen/Seen', '7', 'confirm=merge it']);
    assert.equal(r.code, 1); assert.match(r.json.error, /must be exactly/);
    r = await act(url, ['merge-pr', 'begindtheseen/Seen', '8', `confirm=merge begindtheseen/Seen#8 ${HEAD.slice(0, 7)}`]);
    assert.equal(r.code, 1); assert.match(r.json.error, /not mergeable: a check is failing/);
    assert.equal(seen.some((x) => x.url.endsWith('/merge')), false);
    // The phrase arrives unquoted as separate words — still read whole.
    r = await act(url, ['merge-pr', 'begindtheseen/Seen', '7', 'confirm=merge', 'begindtheseen/Seen#7', HEAD.slice(0, 7)]);
    assert.equal(r.code, 0, JSON.stringify(r.json)); assert.equal(r.json.merged, true);
    const m = seen.find((x) => x.url.endsWith('/merge'));
    assert.deepEqual(m.body, { confirm: true, confirmText: `merge begindtheseen/Seen#7 ${HEAD.slice(0, 7)}`, expectedHeadSha: HEAD });
    assert.equal(m.origin, url, 'sent with the local app origin');
  } finally { srv.close(); }
});

test('ticket-new needs all three parts; tickets lists the compact rows', async () => {
  const { srv, seen, url } = await stubApp();
  try {
    let r = await act(url, ['ticket-new', 'only a title']);
    assert.equal(r.code, 1); assert.match(r.json.error, /what would have helped/);
    r = await act(url, ['ticket-new', 'Could not X | no route for X | a route for X']);
    assert.equal(r.code, 0); assert.equal(r.json.action, 'created');
    assert.deepEqual(seen.find((x) => x.url === '/api/tickets').body, { title: 'Could not X', error: 'no route for X', helped: 'a route for X', kind: 'assistant_failed' });
    r = await act(url, ['tickets', 'status=open']);
    assert.equal(r.json.tickets[0].seenCommand, true); assert.equal(r.json.tickets[0].helped, 'h');
    assert.match(seen.at(-1).url, /status=open/);
  } finally { srv.close(); }
});
