import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { handleTicketRoutes, fixPlan, mergePhrase, refreshTicketPRs, liveTicketsSummary } from './ticket-routes.mjs';
import { reportFailure, getTicket, claimTicket, updateTicket } from '../brain/lib/tickets.mjs';
import { createGitHub } from './pr-merge.mjs';

const config = { commandRepo: () => 'begindtheseen/seen-command', githubRepo: () => 'begindtheseen/Seen', githubToken: () => 't' };
const HEAD = 'd'.repeat(40);

function call(path, { method = 'GET', body = null, origin = 'http://localhost:4599', remote = '127.0.0.1' } = {}, deps) {
  const req = Readable.from(body == null ? [] : [JSON.stringify(body)]);
  Object.assign(req, { method, url: path, headers: { host: 'localhost:4599', ...(origin ? { origin } : {}) }, socket: { remoteAddress: remote } });
  return new Promise((resolve) => {
    const res = { code: 0, writeHead(c) { this.code = c; return this; }, end(s) { resolve({ code: this.code, body: JSON.parse(s) }); } };
    handleTicketRoutes(req, res, path.split('?')[0], deps);
  });
}
const fakeGitHub = ({ runs, mergeable_state = 'clean', base = 'main', repo = 'begindtheseen/seen-command' } = {}) => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url); calls.push({ method: init.method || 'GET', path: u.pathname, body: init.body ? JSON.parse(init.body) : null });
    const ok = (b) => ({ ok: true, status: 200, text: async () => JSON.stringify(b) });
    if (u.pathname.endsWith('/merge')) return ok({ merged: true, sha: 'e'.repeat(40) });
    if (/\/pulls\/\d+$/.test(u.pathname)) return ok({ number: 9, title: 'Fix ticket', html_url: `https://github.com/${repo}/pull/9`, state: 'open', draft: false, base: { ref: base }, head: { ref: 'fix', sha: HEAD }, mergeable: true, mergeable_state, user: { login: 'codex' } });
    if (u.pathname.endsWith('/check-runs')) return ok({ check_runs: runs });
    if (u.pathname.endsWith('/status')) return ok({ state: 'success', total_count: 0, statuses: [] });
    if (/\/pulls$/.test(u.pathname)) return ok([]);
    return { ok: false, status: 404, text: async () => '{"message":"Not Found"}' };
  };
  return { github: () => createGitHub({ token: 't', fetchImpl }), calls };
};

function setup(extra = {}) {
  const v = mkdtempSync(join(tmpdir(), 'ticket-routes-'));
  const started = []; const timeline = []; const builds = extra.builds || {};
  const deps = { vault: () => v, config, startBuild: (b) => { started.push(b); }, readBuild: (id) => builds[id] || null,
    recordDevLog: (e) => { timeline.push(e); return { recorded: true }; }, logActivity: () => null, ...extra.deps };
  return { v, deps, started, timeline, done: () => rmSync(v, { recursive: true, force: true }) };
}

test('list, detail and the local-app gate', async () => {
  const s = setup();
  try {
    const { ticket } = reportFailure(s.v, { kind: 'collector_failed', thing: 'indeed', error: 'Chrome not reachable' });
    let r = await call('/api/tickets', {}, s.deps);
    assert.equal(r.code, 200); assert.equal(r.body.tickets.length, 1); assert.equal(r.body.summary.active, 1);
    r = await call(`/api/tickets/${ticket.id}`, {}, s.deps);
    assert.equal(r.body.ticket.id, ticket.id); assert.equal(r.body.fix.mode, 'ready_for_ai', 'a collector is not a repo the builder works on');
    r = await call('/api/tickets', { remote: '10.0.0.5' }, s.deps);
    assert.equal(r.code, 403);
    r = await call(`/api/tickets/${ticket.id}/note`, { method: 'POST', body: { text: 'hi' }, origin: 'https://evil.example' }, s.deps);
    assert.equal(r.code, 403, 'a web page cannot press the buttons');
    r = await call('/api/tickets/tkt-zz', {}, s.deps);
    assert.equal(r.code, 404);
    r = await call('/api/tickets', {}, { ...s.deps, vault: () => null });
    assert.equal(r.body.vault, false);
  } finally { s.done(); }
});

test('Ask Claude to fix: re-runs a failed build, starts a fix build for a known repo, or marks it ready for an AI', async () => {
  const builds = { 'task-40': { id: 'task-40', key: 'k40', repo: 'product', task: 'Add the salary filter', title: 'Add the salary filter', issue: { repo: 'begindtheseen/seen-command', number: 40 } } };
  const s = setup({ builds });
  try {
    const b = reportFailure(s.v, { kind: 'build_failed', repo: 'begindtheseen/Seen', thing: 'k40', error: 'gate red', ref: 'task-40@t1' }).ticket;
    let r = await call(`/api/tickets/${b.id}/fix`, { method: 'POST', body: {} }, s.deps);
    assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.mode, 'rebuild');
    assert.deepEqual(s.started[0], { id: 'task-40', key: 'k40', repo: 'product', task: 'Add the salary filter', title: 'Add the salary filter', issueRepo: 'begindtheseen/seen-command', issueNumber: 40 });
    let t = getTicket(s.v, b.id);
    assert.equal(t.status, 'in_progress'); assert.equal(t.claimant, 'seen-command-builder'); assert.equal(t.buildId, 'task-40');

    const d = reportFailure(s.v, { kind: 'deploy_drift', repo: 'begindtheseen/seen-command', thing: 'x', error: 'drift' }).ticket;
    r = await call(`/api/tickets/${d.id}/fix`, { method: 'POST', body: {} }, s.deps);
    assert.equal(r.body.mode, 'builder'); assert.equal(s.started[1].id, `ticket-${d.id}`); assert.equal(s.started[1].repo, 'tool');
    assert.match(s.started[1].task, new RegExp(d.id));

    const c = reportFailure(s.v, { kind: 'collector_failed', thing: 'indeed', error: 'x' }).ticket;
    r = await call(`/api/tickets/${c.id}/fix`, { method: 'POST', body: {} }, s.deps);
    assert.equal(r.body.mode, 'ready_for_ai'); assert.equal(getTicket(s.v, c.id).requested, 'ai');
    assert.equal(s.started.length, 2);

    const blocked = reportFailure(s.v, { kind: 'build_failed', repo: 'begindtheseen/Seen', thing: 'k41', error: 'credit too low', blocked: true }).ticket;
    r = await call(`/api/tickets/${blocked.id}/fix`, { method: 'POST', body: {} }, s.deps);
    assert.equal(r.code, 409); assert.match(r.body.error, /blocked on you/);
    const taken = reportFailure(s.v, { kind: 'build_failed', repo: 'begindtheseen/Seen', thing: 'k42', error: 'x' }).ticket;
    claimTicket(s.v, { id: taken.id, by: 'codex' });
    assert.equal(fixPlan(getTicket(s.v, taken.id), { config }).mode, 'none');
  } finally { s.done(); }
});

test('won’t fix, duplicate, note and reopen are recorded as the owner', async () => {
  const s = setup();
  try {
    const a = reportFailure(s.v, { kind: 'collector_failed', thing: 'a', error: 'x' }).ticket;
    const b = reportFailure(s.v, { kind: 'collector_failed', thing: 'b', error: 'x' }).ticket;
    let r = await call(`/api/tickets/${a.id}/wont-fix`, { method: 'POST', body: { reason: 'the source is gone' } }, s.deps);
    assert.equal(r.body.ticket.status, 'wont_fix'); assert.match(r.body.ticket.note, /source is gone/);
    r = await call(`/api/tickets/${b.id}/duplicate`, { method: 'POST', body: { of: a.id } }, s.deps);
    assert.equal(r.body.ticket.status, 'duplicate'); assert.equal(r.body.ticket.duplicateOf, a.id);
    r = await call(`/api/tickets/${a.id}/open`, { method: 'POST', body: {} }, s.deps);
    assert.equal(r.body.ticket.status, 'open');
    r = await call(`/api/tickets/${a.id}/note`, { method: 'POST', body: { text: '' } }, s.deps);
    assert.equal(r.code, 400);
    assert.ok(getTicket(s.v, a.id).history.every((h) => ['seen-command', 'seen-command:owner'].includes(h.by)));
  } finally { s.done(); }
});

test('Merge: refused while checks are red; merged when green — recorded on the ticket and in the brain timeline', async () => {
  const s = setup();
  try {
    const t = reportFailure(s.v, { kind: 'build_failed', repo: 'begindtheseen/seen-command', thing: 'k9', error: 'x' }).ticket;
    claimTicket(s.v, { id: t.id, by: 'codex' });
    updateTicket(s.v, { id: t.id, by: 'codex', prUrl: 'https://github.com/begindtheseen/seen-command/pull/9' });
    const red = fakeGitHub({ runs: [{ name: 'test', status: 'completed', conclusion: 'failure' }] });
    let r = await call('/api/prs/begindtheseen/seen-command/9', {}, { ...s.deps, github: red.github });
    assert.equal(r.body.canMerge, false); assert.deepEqual(r.body.tickets, [t.id]);
    r = await call('/api/prs/begindtheseen/seen-command/9/merge', { method: 'POST', body: { confirm: true, expectedHeadSha: HEAD } }, { ...s.deps, github: red.github });
    assert.equal(r.code, 409); assert.match(r.body.error, /check failed/);
    assert.equal(red.calls.some((c) => c.method === 'PUT'), false);
    assert.match(getTicket(s.v, t.id).note, /Merge refused/);

    const ok = fakeGitHub({ runs: [{ name: 'test', status: 'completed', conclusion: 'success' }] });
    r = await call('/api/prs/begindtheseen/seen-command/9/merge', { method: 'POST', body: { expectedHeadSha: HEAD } }, { ...s.deps, github: ok.github });
    assert.equal(r.code, 400, 'confirmation is required');
    r = await call('/api/prs/begindtheseen/seen-command/9/merge', { method: 'POST', body: { confirm: true, expectedHeadSha: HEAD }, origin: null }, { ...s.deps, github: ok.github });
    assert.equal(r.code, 403);
    r = await call('/api/prs/begindtheseen/seen-command/9/merge', { method: 'POST', body: { confirm: true, expectedHeadSha: HEAD } }, { ...s.deps, github: ok.github });
    assert.equal(r.code, 200, JSON.stringify(r.body)); assert.equal(r.body.merged, true);
    const after = getTicket(s.v, t.id);
    assert.equal(after.status, 'merged'); assert.equal(after.merge.method, 'squash'); assert.equal(after.merge.by, 'seen-command:owner');
    assert.equal(s.timeline.length, 1); assert.match(s.timeline[0].text, /seen-command#9.*squash-merged/);
    assert.deepEqual(ok.calls.find((c) => c.method === 'PUT').body, { merge_method: 'squash', sha: HEAD });
    r = await call('/api/prs/someone/else/1', {}, { ...s.deps, github: ok.github });
    assert.equal(r.code, 403);
  } finally { s.done(); }
});

test('a merged Seen PR shows its production deploy from the existing Vercel helper and drift fact', async () => {
  const s = setup();
  try {
    const fetchImpl = async (url) => {
      const u = new URL(url); const ok = (b) => ({ ok: true, status: 200, text: async () => JSON.stringify(b) });
      if (/\/pulls\/\d+$/.test(u.pathname)) return ok({ number: 3, title: 'x', html_url: 'https://github.com/begindtheseen/Seen/pull/3', state: 'closed', merged_at: '2026-10-21T18:00:00Z', merge_commit_sha: 'f'.repeat(40), draft: false, base: { ref: 'next-migration' }, head: { ref: 'h', sha: HEAD }, mergeable: null, mergeable_state: 'unknown' });
      return ok({ check_runs: [], state: 'success', total_count: 0 });
    };
    const r = await call('/api/prs/begindtheseen/Seen/3', {}, { ...s.deps, github: () => createGitHub({ token: 't', fetchImpl }),
      deploymentForRef: async ({ ref, sha }) => ({ configured: true, state: 'READY', sha: sha.slice(0, 7), ref }),
      currentFacts: () => [{ subject: 'Seen production deploy', predicate: 'merge_vs_deploy', object: 'in sync — next-migration and production both at ffffffff' }] });
    assert.equal(r.body.deploy.deployment.state, 'READY'); assert.equal(r.body.deploy.deployment.ref, 'next-migration');
    assert.match(r.body.deploy.drift, /in sync/);
  } finally { s.done(); }
});

test('the assistant files its own failure: local app only, and only with what would have helped', async () => {
  const s = setup();
  try {
    let r = await call('/api/tickets', { method: 'POST', body: { title: 'Could not list held reports', error: 'no act verb for held reports', helped: 'an act verb `held-reports` backed by the admin route' }, origin: null }, s.deps);
    assert.equal(r.code, 403);
    r = await call('/api/tickets', { method: 'POST', body: { title: 'Could not list held reports', error: 'no act verb for held reports' } }, s.deps);
    assert.equal(r.code, 400); assert.match(r.body.error, /what would have helped/);
    r = await call('/api/tickets', { method: 'POST', body: { title: 'Could not list held reports', error: 'no act verb; token ghp_abcdefghijklmnopqrstu', helped: 'an act verb `held-reports` backed by the admin route' } }, s.deps);
    assert.equal(r.code, 201, JSON.stringify(r.body)); assert.equal(r.body.action, 'created');
    const t = getTicket(s.v, r.body.ticket.id);
    assert.equal(t.kind, 'assistant_failed'); assert.equal(t.tool, true); assert.equal(t.repo, 'begindtheseen/seen-command');
    assert.match(t.helped, /held-reports/); assert.equal(t.evidence.error.includes('ghp_abcdefghijklmnopqrstu'), false);
    assert.equal(t.history[0].by, 'seen-command:assistant');
    r = await call('/api/tickets', { method: 'POST', body: { title: 'Could not list held reports', error: 'again', helped: 'the same verb' } }, s.deps);
    assert.equal(r.code, 200); assert.equal(r.body.action, 'occurrence'); assert.equal(r.body.ticket.count, 2);
    r = await call('/api/tickets', { method: 'POST', body: { title: 'x', error: 'y', helped: 'z', repo: 'someone/else' } }, s.deps);
    assert.equal(r.code, 400);
  } finally { s.done(); }
});

test('a merge from the chat needs the exact phrase naming the head commit', async () => {
  const s = setup();
  try {
    const ok = fakeGitHub({ runs: [{ name: 'test', status: 'completed', conclusion: 'success' }] });
    let r = await call('/api/prs/begindtheseen/seen-command/9/merge', { method: 'POST', body: { confirm: true, expectedHeadSha: HEAD, confirmText: 'merge it' } }, { ...s.deps, github: ok.github });
    assert.equal(r.code, 400); assert.match(r.body.error, new RegExp(`merge begindtheseen/seen-command#9 ${HEAD.slice(0, 7)}`));
    assert.equal(ok.calls.some((c) => c.method === 'PUT'), false);
    assert.equal(mergePhrase('begindtheseen/seen-command', 9, HEAD), `merge begindtheseen/seen-command#9 ${HEAD.slice(0, 7)}`);
    r = await call('/api/prs/begindtheseen/seen-command/9/merge', { method: 'POST', body: { confirm: true, expectedHeadSha: HEAD, confirmText: mergePhrase('begindtheseen/seen-command', 9, HEAD) } }, { ...s.deps, github: ok.github });
    assert.equal(r.code, 200); assert.equal(r.body.merged, true);
  } finally { s.done(); }
});

test('PR-backed tickets stay honest on their own: ready when GitHub says so, merged when merged elsewhere', async () => {
  const s = setup();
  try {
    const mk = (thing, n) => { const t = reportFailure(s.v, { kind: 'build_failed', repo: 'begindtheseen/seen-command', thing, error: 'x' }).ticket;
      claimTicket(s.v, { id: t.id, by: 'codex' }); updateTicket(s.v, { id: t.id, by: 'codex', prUrl: `https://github.com/begindtheseen/seen-command/pull/${n}` }); return t.id; };
    const ready = mk('k1', 9); const merged = mk('k2', 10);
    const fetchImpl = async (url) => {
      const u = new URL(url); const ok = (b) => ({ ok: true, status: 200, text: async () => JSON.stringify(b) });
      const n = Number((/\/pulls\/(\d+)$/.exec(u.pathname) || [])[1]);
      if (n === 9) return ok({ number: 9, title: 'a', html_url: 'https://github.com/begindtheseen/seen-command/pull/9', state: 'open', draft: false, base: { ref: 'main' }, head: { ref: 'a', sha: HEAD }, mergeable: true, mergeable_state: 'clean' });
      if (n === 10) return ok({ number: 10, title: 'b', html_url: 'https://github.com/begindtheseen/seen-command/pull/10', state: 'closed', merged_at: '2026-10-21T21:00:00Z', merge_commit_sha: 'c'.repeat(40), draft: false, base: { ref: 'main' }, head: { ref: 'b', sha: HEAD }, mergeable: null, mergeable_state: 'unknown' });
      if (u.pathname.endsWith('/check-runs')) return ok({ check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }] });
      return ok({ state: 'success', total_count: 0, statuses: [] });
    };
    const out = await refreshTicketPRs({ vault: s.v, gh: createGitHub({ token: 't', fetchImpl }), config });
    assert.equal(out.checked, 2);
    assert.equal(getTicket(s.v, ready).prState, 'ready');
    assert.equal(getTicket(s.v, merged).status, 'merged'); assert.equal(getTicket(s.v, merged).merge.by, 'github');
    const sum = await liveTicketsSummary({ vault: s.v, config, gh: createGitHub({ token: 't', fetchImpl }), maxAgeMs: 0 });
    assert.deepEqual(sum.needsOwner.map((x) => [x.id, x.why]), [[ready, 'merge_ready']]);
  } finally { s.done(); }
});
