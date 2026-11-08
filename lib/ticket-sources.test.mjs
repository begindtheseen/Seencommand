import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTicketSources, collectorThing, composeFixTask, BUILDER } from './ticket-sources.mjs';
import { listTickets, getTicket, claimTicket, updateTicket } from '../brain/lib/tickets.mjs';
import { recordFailure, setFailureTicketHooks } from './failure-loop.mjs';

const config = { commandRepo: () => 'begindtheseen/seen-command', githubRepo: () => 'begindtheseen/Seen' };
function setup({ builds = {}, runs = {} } = {}) {
  const v = mkdtempSync(join(tmpdir(), 'ticket-src-'));
  const src = createTicketSources({ vault: () => v, config, readBuild: (id) => builds[id] || null, readRun: (id) => runs[id] || null,
    redact: (s) => String(s ?? '').replace(/sekrit\w*/g, '[redacted]'), log: () => {} });
  return { v, src, done: () => rmSync(v, { recursive: true, force: true }) };
}

test('a failed build reported by BOTH recordFailure and the activity line is one ticket, one occurrence', () => {
  const builds = { 'task-12': { id: 'task-12', key: 'k-widget', repo: 'tool', title: 'Fix widget', task: 'Fix widget', status: 'failed', startedAt: '2026-10-21T15:00:00Z', error: 'gate red', blocked: false, log: ['a', 'b'] } };
  const { v, src, done } = setup({ builds });
  try {
    src.onActivity({ ts: '2026-10-21T15:05:00Z', kind: 'build', id: 'task-12', status: 'failed', summary: 'build FAILED — Seen Command: gate red sekrit123', detail: 'trace' });
    src.onFailure({ kind: 'build', id: 'task-12', key: 'k-widget', repo: 'tool', reason: 'gate red', at: '2026-10-21T15:05:01Z' });
    const rows = listTickets(v);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].count, 1);
    assert.equal(rows[0].kind, 'build_failed'); assert.equal(rows[0].repo, 'begindtheseen/seen-command');
    assert.equal(rows[0].lastError.includes('sekrit'), false, 'redacted on the way in');
    // The next run of the same build fails again → same ticket, ×2.
    builds['task-12'].startedAt = '2026-10-21T16:00:00Z';
    src.onFailure({ kind: 'build', id: 'task-12', key: 'k-widget', repo: 'tool', reason: 'gate red again', at: '2026-10-21T16:05:00Z' });
    assert.equal(listTickets(v)[0].count, 2);
    // …and a successful build closes it.
    builds['task-12'].pr = 'https://github.com/begindtheseen/seen-command/pull/50';
    src.onActivity({ ts: '2026-10-21T17:00:00Z', kind: 'build', id: 'task-12', status: 'pr_ready', summary: 'build pr_ready' });
    const t = getTicket(v, rows[0].id);
    assert.equal(t.status, 'resolved'); assert.match(t.resolution, /pull\/50/);
  } finally { done(); }
});

test('collector runs: failed opens, blocked marks it as the owner’s, completed resolves', () => {
  const runs = { 'run-1': { id: 'run-1', pipeline: 'indeed', label: 'Indeed Jobs', reason: 'Chrome is not reachable', stderrTail: ['err 1', 'err 2'], startedAt: '2026-10-21T10:00:00Z' } };
  const { v, src, done } = setup({ runs });
  try {
    src.onActivity({ ts: 'x', kind: 'aggregation', id: 'run-1', status: 'blocked', summary: 'Indeed Jobs run blocked — Chrome is not reachable' });
    let [t] = listTickets(v);
    assert.equal(t.kind, 'collector_failed'); assert.equal(t.blocked, true); assert.match(t.title, /Indeed Jobs collector blocked/);
    assert.equal(getTicket(v, t.id).evidence.log, 'err 1\nerr 2');
    src.onActivity({ ts: 'y', kind: 'aggregation', id: 'run-2', status: 'partial', summary: 'Indeed Jobs run partial' });
    assert.equal(listTickets(v)[0].status, 'open', 'partial is neither a failure nor a success');
    runs['run-3'] = { id: 'run-3', pipeline: 'indeed', label: 'Indeed Jobs' };
    src.onActivity({ ts: 'z', kind: 'aggregation', id: 'run-3', status: 'completed', summary: 'Indeed Jobs run completed' });
    [t] = listTickets(v, { status: 'all' });
    assert.equal(t.status, 'resolved');
    // Pull lines carry no run id.
    assert.deepEqual(collectorThing({ summary: 'employer-board pull failed: 502' }, null).thing, 'employer-board pull');
    src.onActivity({ ts: 'a', kind: 'aggregation', status: 'failed', summary: 'employer-board pull failed: Seen answered 502' });
    src.onActivity({ ts: 'b', kind: 'aggregation', status: 'done', summary: 'employer boards: 4/5 boards answered' });
    assert.equal(listTickets(v, { status: 'resolved' }).length, 2);
  } finally { done(); }
});

test('meetings, self-updates, PR checks and schema drift each open the right kind of ticket', () => {
  const builds = { 'task-30': { id: 'task-30', repo: 'product', title: 'Add filter', pr: 'https://github.com/begindtheseen/Seen/pull/400' } };
  const { v, src, done } = setup({ builds });
  try {
    src.onActivity({ ts: 't1', kind: 'meeting', id: 'run-a', status: 'failed', summary: 'board meeting failed', detail: 'LLM timed out' });
    src.onActivity({ ts: 't2', kind: 'self-update', id: 'su', status: 'failed', summary: 'self-update failed', detail: 'merge conflict' });
    src.onActivity({ ts: 't3', kind: 'pr-status', id: 'task-30', status: 'checks_failing', summary: 'PR not ready after creation — a required check is failing' });
    src.onActivity({ ts: 't4', kind: 'drift', status: 'schema', summary: 'schema drift: live database is missing consume_credit' });
    src.onActivity({ ts: 't5', kind: 'llm', status: 'model-retired', summary: 'not a failure' });
    const kinds = listTickets(v).map((t) => t.kind).sort();
    assert.deepEqual(kinds, ['data_quality', 'meeting_failed', 'self_update_failed', 'test_red']);
    assert.equal(listTickets(v, { kind: 'data_quality' })[0].blocked, true);
    assert.equal(listTickets(v, { kind: 'test_red' })[0].repo, 'begindtheseen/Seen');
    src.onActivity({ ts: 't6', kind: 'meeting', id: 'run-b', status: 'completed', summary: 'board meeting done' });
    src.onActivity({ ts: 't7', kind: 'pr-status', id: 'task-30', status: 'ready', summary: 'PR ready' });
    assert.deepEqual(listTickets(v).map((t) => t.kind).sort(), ['data_quality', 'self_update_failed']);
  } finally { done(); }
});

test('a fixer build moves its ticket: PR opened → pr_open; failed → back to open for anyone', () => {
  const builds = {};
  const { v, src, done } = setup({ builds });
  try {
    src.reportFrom({ kind: 'deploy_drift', repo: 'begindtheseen/seen-command', thing: 'x', error: 'drifted' });
    const [row] = listTickets(v);
    claimTicket(v, { id: row.id, by: BUILDER });
    updateTicket(v, { id: row.id, by: BUILDER, status: 'in_progress', buildId: `ticket-${row.id}`, requested: 'builder' }, { asOwner: true });
    builds[`ticket-${row.id}`] = { id: `ticket-${row.id}`, repo: 'tool', pr: 'https://github.com/begindtheseen/seen-command/pull/77' };
    src.onActivity({ ts: 'a', kind: 'build', id: `ticket-${row.id}`, status: 'pr_ready', summary: 'build pr_ready' });
    let t = getTicket(v, row.id);
    assert.equal(t.status, 'pr_open'); assert.equal(t.prUrl, 'https://github.com/begindtheseen/seen-command/pull/77');
    src.onActivity({ ts: 'b', kind: 'pr-status', id: `ticket-${row.id}`, status: 'ready', summary: 'PR ready' });
    assert.equal(getTicket(v, row.id).prState, 'ready');
    // A second fixer that fails puts the ticket back in the pool instead of opening a ticket about itself.
    src.reportFrom({ kind: 'deploy_drift', repo: 'begindtheseen/seen-command', thing: 'y', error: 'drifted' });
    const other = listTickets(v).find((x) => x.status === 'open');
    claimTicket(v, { id: other.id, by: BUILDER });
    updateTicket(v, { id: other.id, by: BUILDER, status: 'in_progress', buildId: `ticket-${other.id}` }, { asOwner: true });
    src.onFailure({ kind: 'build', id: `ticket-${other.id}`, reason: 'could not reach a green gate', at: 'c' });
    t = getTicket(v, other.id);
    assert.equal(t.status, 'open'); assert.equal(t.claimant, null); assert.match(t.note, /did not land/);
    assert.equal(listTickets(v, { status: 'all' }).length, 2, 'no ticket about the fixer build itself');
  } finally { done(); }
});

test('recordFailure feeds the ticket hook only when an entry point installed it', () => {
  const { v, src, done } = setup();
  const quiet = { append: () => {}, facts: () => ({ written: 0 }), timeline: () => null, activity: () => null, dir: v };
  try {
    setFailureTicketHooks(null);
    assert.equal(recordFailure({ kind: 'build', id: 'b1', reason: 'boom' }, quiet).ticket, null);
    setFailureTicketHooks({ onFailure: src.onFailure, onResolve: src.onResolve });
    const r = recordFailure({ kind: 'build', id: 'b2', repo: 'tool', reason: 'boom', blocked: true }, quiet);
    assert.equal(r.ticket.action, 'created'); assert.equal(r.ticket.ticket.blocked, true);
  } finally { setFailureTicketHooks(null); done(); }
});

test('the builder task for a ticket carries its evidence and forbids hiding the error', () => {
  const task = composeFixTask({ id: 'tkt-0123456789', title: 'Indeed collector failed', kind: 'collector_failed', count: 3, evidence: { error: 'Chrome not reachable', log: 'stack', at: 'now' } });
  assert.match(task, /tkt-0123456789/); assert.match(task, /Chrome not reachable/); assert.match(task, /do not hide the error/);
});

test('Seen Command’s own failures are tool tickets that say what would have helped; product ones are not', () => {
  const { v, src, done } = setup();
  try {
    src.onActivity({ kind: 'meeting', id: 'run-9', status: 'failed', ts: '2026-10-21T16:00:00Z', summary: 'board meeting failed', detail: 'reason() timed out after 120s' });
    src.onActivity({ kind: 'aggregation', id: null, status: 'failed', ts: '2026-10-21T16:01:00Z', summary: 'Indeed run failed — Chrome is not reachable' });
    const [meeting] = listTickets(v, { kind: 'meeting_failed' }); const [indeed] = listTickets(v, { kind: 'collector_failed' });
    assert.equal(meeting.tool, true); assert.match(meeting.helped, /board meeting must run end to end.*timed out after 120s/);
    assert.equal(indeed.tool, false);
    assert.deepEqual(listTickets(v).map((t) => t.id), [indeed.id, meeting.id], 'seenjobs.io first');
  } finally { done(); }
});

test('the preview verdict, post-merge proof and the Board Room assistant each open and close their own ticket', () => {
  const builds = { 'b-4': { id: 'b-4', key: 'k-search', repo: 'product', title: 'Better search', pr: 'https://github.com/begindtheseen/Seen/pull/40' } };
  const { v, src, done } = setup({ builds });
  try {
    src.onActivity({ kind: 'verdict', id: 'begindtheseen/Seen#40', status: 'ERROR', ts: '2026-10-21T17:00:00Z', summary: 'preview build ERROR — PR withdrawn' });
    let [pv] = listTickets(v, { kind: 'pr_blocked' });
    assert.equal(pv.repo, 'begindtheseen/Seen'); assert.match(pv.title, /Preview build ERROR/);
    src.onActivity({ kind: 'verdict', id: 'begindtheseen/Seen#40', status: 'READY', ts: '2026-10-21T17:30:00Z', summary: 'deployable' });
    assert.equal(getTicket(v, pv.id).status, 'resolved');

    src.onActivity({ kind: 'proof', id: 'b-4', status: 'failed', ts: '2026-10-21T18:00:00Z', summary: 'FAILED — 1/3 observed · open: schema' });
    const [pf] = listTickets(v, { kind: 'proof_failed' });
    assert.match(pf.title, /Better search/); assert.deepEqual(getTicket(v, pf.id).evidence.links, ['https://github.com/begindtheseen/Seen/pull/40']);
    src.onActivity({ kind: 'proof', id: 'b-4', status: 'proven', ts: '2026-10-21T19:00:00Z' });
    assert.equal(getTicket(v, pf.id).status, 'resolved');

    src.onActivity({ kind: 'assistant', id: 'full agent', status: 'failed', ts: '2026-10-21T20:00:00Z', summary: 'Board Room could not complete a request: find acme jobs', detail: 'the Cline lane stopped early (max_turns)' });
    src.onActivity({ kind: 'assistant', id: 'full agent', status: 'failed', ts: '2026-10-21T20:05:00Z', summary: 'Board Room could not complete a request: and again', detail: 'the claude CLI is logged out' });
    const [as] = listTickets(v, { kind: 'assistant_failed' });
    assert.equal(as.count, 2); assert.equal(as.tool, true); assert.equal(as.blocked, true, 'logged out is the owner’s to clear');
    assert.match(as.helped, /Only the owner can clear this/);
    src.resolveFrom({ kind: 'assistant_failed', repo: 'begindtheseen/seen-command', thing: 'board room full agent', how: 'answered' });
    assert.equal(getTicket(v, as.id).status, 'resolved');
  } finally { done(); }
});

test('every ticket write tells the wire (which schedules the cloud push)', () => {
  const v = mkdtempSync(join(tmpdir(), 'ticket-src-'));
  let writes = 0;
  try {
    const src = createTicketSources({ vault: () => v, config, log: () => {}, onWrite: () => { writes += 1; } });
    src.reportFrom({ kind: 'deploy_drift', repo: 'begindtheseen/Seen', thing: 'production deploy next-migration', error: 'DRIFTED', blocked: true });
    assert.equal(writes, 1);
    src.resolveFrom({ kind: 'deploy_drift', repo: 'begindtheseen/Seen', thing: 'production deploy next-migration', how: 'in sync' });
    assert.equal(writes, 2);
    src.resolveFrom({ kind: 'deploy_drift', repo: 'begindtheseen/Seen', thing: 'production deploy next-migration', how: 'in sync' });
    assert.equal(writes, 2, 'nothing to resolve → no push');
  } finally { rmSync(v, { recursive: true, force: true }); }
});
