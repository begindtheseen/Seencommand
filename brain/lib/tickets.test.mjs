import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  reportFailure, resolveBySuccess, claimTicket, updateTicket, getTicket, listTickets, ticketsSummary,
  fingerprintOf, redactSecrets, canTransition, isTicketId,
} from './tickets.mjs';
import { readIndex } from './vault.mjs';

const vaultDir = () => mkdtempSync(join(tmpdir(), 'tickets-vault-'));
const BUILD = { kind: 'build_failed', repo: 'begindtheseen/seen-command', thing: 'task-12', title: 'Build failed: fix the widget' };

test('one ticket per fingerprint: a repeat adds an occurrence, the same run twice counts once', () => {
  const v = vaultDir();
  try {
    const a = reportFailure(v, { ...BUILD, error: 'gate red in 3/8 rounds', ref: 'task-12@t1' });
    assert.equal(a.action, 'created'); assert.ok(isTicketId(a.ticket.id));
    assert.equal(a.ticket.status, 'open'); assert.equal(a.ticket.count, 1);
    const b = reportFailure(v, { ...BUILD, error: 'gate red again', ref: 'task-12@t2' });
    assert.equal(b.action, 'occurrence'); assert.equal(b.ticket.id, a.ticket.id); assert.equal(b.ticket.count, 2);
    const c = reportFailure(v, { ...BUILD, error: 'gate red again', ref: 'task-12@t2' }); // second hook, same run
    assert.equal(c.action, 'seen'); assert.equal(c.ticket.count, 2);
    const other = reportFailure(v, { ...BUILD, thing: 'task-13', error: 'x' });
    assert.notEqual(other.ticket.id, a.ticket.id);
    assert.equal(listTickets(v).length, 2);
    assert.equal(getTicket(v, a.ticket.id).evidence.error, 'gate red again');
    assert.equal(fingerprintOf(BUILD), 'build_failed|begindtheseen/seen-command|task-12');
  } finally { rmSync(v, { recursive: true, force: true }); }
});

test('secrets never reach the ticket note — error, log, title, notes and the change text are redacted', () => {
  const v = vaultDir();
  try {
    const env = { GITHUB_TOKEN: 'super-secret-value-123', HOME: '/Users/you' };
    assert.equal(redactSecrets('push failed with super-secret-value-123 in /Users/you/x', env), 'push failed with [redacted] in ~/x');
    const r = reportFailure(v, { ...BUILD, title: 'token ghp_abcdefghijklmnopqrstu leaked', error: 'Authorization: Bearer abcdefghijklmnop1234 password=hunter2hunter2',
      log: 'curl https://user:pa55word@example.com sk-ant-api03-abcdefghijk' });
    claimTicket(v, { id: r.ticket.id, by: 'codex' });
    updateTicket(v, { id: r.ticket.id, by: 'codex', note: 'used key=AKIAABCDEFGHIJKLMNOP to test' });
    const text = readFileSync(join(v, 'tickets', `${r.ticket.id}.md`), 'utf8');
    for (const leak of ['ghp_abcdefghijklmnopqrstu', 'abcdefghijklmnop1234', 'hunter2hunter2', 'pa55word', 'sk-ant-api03', 'AKIAABCDEFGHIJKLMNOP']) {
      assert.equal(text.includes(leak), false, `leaked ${leak}`);
    }
    assert.match(text, /\[redacted\]/);
  } finally { rmSync(v, { recursive: true, force: true }); }
});

test('transitions are validated and the claimant alone moves a claimed ticket', () => {
  const v = vaultDir();
  try {
    const { ticket } = reportFailure(v, { ...BUILD, error: 'boom' });
    const id = ticket.id;
    assert.equal(canTransition('open', 'merged'), false);
    let r = updateTicket(v, { id, by: 'codex', status: 'merged' });
    assert.equal(r.ok, false); assert.match(r.error, /cannot move open → merged/);
    r = updateTicket(v, { id, by: 'codex', plan: 'patch it' });
    assert.equal(r.ok, false); assert.match(r.error, /claim ticket .* first/);
    r = updateTicket(v, { id, by: 'codex', status: 'claimed' });
    assert.equal(r.ok, false); assert.match(r.error, /brain_claim_ticket/);
    assert.equal(claimTicket(v, { id, by: 'codex' }).ok, true);
    r = updateTicket(v, { id, by: 'claude-brain', status: 'wont_fix' });
    assert.equal(r.ok, false); assert.match(r.error, /claimed by codex/);
    assert.equal(updateTicket(v, { id, by: 'claude-brain', note: 'I saw this too' }).ok, true, 'anyone may add a note');
    r = updateTicket(v, { id, by: 'codex', plan: 'rewrite the gate step' });
    assert.equal(r.ok, true); assert.equal(r.to, 'planned');
    r = updateTicket(v, { id, by: 'codex', prUrl: 'not a url' });
    assert.equal(r.ok, false);
    r = updateTicket(v, { id, by: 'codex', prUrl: 'https://github.com/begindtheseen/seen-command/pull/41' });
    assert.equal(r.to, 'pr_open');
    r = updateTicket(v, { id, by: 'codex', status: 'duplicate', duplicateOf: id });
    assert.equal(r.ok, false, 'pr_open cannot become a duplicate, and never of itself');
    assert.equal(updateTicket(v, { id, by: 'codex', status: 'merged' }).ok, true);
    r = updateTicket(v, { id, by: 'codex', status: 'open' });
    assert.equal(r.ok, false, 'merged is final');
    // The owner (asOwner) may override someone else's claim.
    const t2 = reportFailure(v, { ...BUILD, thing: 'task-99', error: 'x' }).ticket;
    claimTicket(v, { id: t2.id, by: 'codex' });
    assert.equal(updateTicket(v, { id: t2.id, by: 'seen-command:owner', status: 'wont_fix' }, { asOwner: true }).ok, true);
    assert.throws(() => updateTicket(v, { id: t2.id, by: 'unidentified', note: 'x' }), /authenticated principal/);
  } finally { rmSync(v, { recursive: true, force: true }); }
});

test('history is superseded, never overwritten: every status stays in the vault with who and when', () => {
  const v = vaultDir();
  try {
    const { ticket } = reportFailure(v, { ...BUILD, error: 'boom' });
    claimTicket(v, { id: ticket.id, by: 'codex' });
    updateTicket(v, { id: ticket.id, by: 'codex', plan: 'p' });
    updateTicket(v, { id: ticket.id, by: 'codex', status: 'in_progress' });
    const statusFacts = readIndex(v).facts.filter((f) => f.note === `tickets/${ticket.id}.md` && f.predicate === 'status');
    assert.deepEqual(statusFacts.map((f) => f.object), ['open', 'claimed', 'planned', 'in_progress']);
    assert.equal(statusFacts.filter((f) => f.valid_to == null).length, 1, 'exactly one current status');
    assert.ok(statusFacts.slice(1).every((f) => f.supersedes), 'each new status names the fact it replaced');
    assert.deepEqual(statusFacts.map((f) => f.by), ['seen-command', 'codex', 'codex', 'codex']);
    const t = getTicket(v, ticket.id);
    assert.deepEqual(t.history.filter((h) => h.fields.status).map((h) => h.fields.status), ['open', 'claimed', 'planned', 'in_progress']);
    assert.ok(t.history.every((h) => h.at));
  } finally { rmSync(v, { recursive: true, force: true }); }
});

test('a stale claim expires after the TTL and can be taken over; a live one cannot', () => {
  const v = vaultDir();
  try {
    const { ticket } = reportFailure(v, { ...BUILD, error: 'boom' });
    const t0 = new Date('2026-10-21T10:00:00Z');
    assert.equal(claimTicket(v, { id: ticket.id, by: 'codex', now: t0, ttlHours: 2 }).ok, true);
    const early = claimTicket(v, { id: ticket.id, by: 'claude-brain', now: new Date('2026-10-21T11:00:00Z'), ttlHours: 2 });
    assert.equal(early.ok, false); assert.match(early.error, /claimed by codex until/);
    const late = claimTicket(v, { id: ticket.id, by: 'claude-brain', now: new Date('2026-10-21T12:30:00Z'), ttlHours: 2 });
    assert.equal(late.ok, true); assert.equal(late.expiredFrom, 'codex'); assert.equal(late.ticket.claimant, 'claude-brain');
    // Activity refreshes the claim: the claimant's update pushes the expiry out.
    updateTicket(v, { id: ticket.id, by: 'claude-brain', plan: 'p' }, { now: new Date('2026-10-21T14:00:00Z'), ttlHours: 2 });
    const t = getTicket(v, ticket.id, { now: new Date('2026-10-21T15:00:00Z'), ttlHours: 2 });
    assert.equal(t.claimExpired, false);
    assert.equal(t.claimExpiresAt, '2026-10-21T16:00:00.000Z');
  } finally { rmSync(v, { recursive: true, force: true }); }
});

test('claiming is atomic across processes: of six racing claimants exactly one wins', async () => {
  const v = vaultDir();
  try {
    const { ticket } = reportFailure(v, { ...BUILD, error: 'boom' });
    const mod = new URL('./tickets.mjs', import.meta.url).href;
    const racer = join(v, 'race.mjs');
    writeFileSync(racer, `import { claimTicket } from ${JSON.stringify(mod)};\nconst r = claimTicket(process.argv[2], { id: process.argv[3], by: process.argv[4] });\nprocess.stdout.write(JSON.stringify({ ok: r.ok, by: process.argv[4] }));\n`);
    const runs = await Promise.all(['a', 'b', 'c', 'd', 'e', 'f'].map((who) => new Promise((resolve) => {
      const p = spawn(process.execPath, [racer, v, ticket.id, `ai-${who}`]);
      let out = ''; p.stdout.on('data', (c) => { out += c; }); p.on('close', () => resolve(JSON.parse(out)));
    })));
    const winners = runs.filter((r) => r.ok);
    assert.equal(winners.length, 1, JSON.stringify(runs));
    assert.equal(getTicket(v, ticket.id).claimant, winners[0].by);
  } finally { rmSync(v, { recursive: true, force: true }); }
});

test('a later success resolves the ticket; failing again after that opens a linked regression', () => {
  const v = vaultDir();
  try {
    const first = reportFailure(v, { ...BUILD, error: 'boom' }).ticket;
    const r = resolveBySuccess(v, { kind: BUILD.kind, repo: BUILD.repo, thing: BUILD.thing, ref: 'task-12', how: 'PR opened' });
    assert.equal(r.action, 'resolved'); assert.equal(r.ticket.status, 'resolved');
    assert.match(r.ticket.resolution, /resolved by success — PR opened/);
    assert.equal(resolveBySuccess(v, { kind: BUILD.kind, repo: BUILD.repo, thing: BUILD.thing }).action, 'none');
    const again = reportFailure(v, { ...BUILD, error: 'boom again' });
    assert.equal(again.action, 'regression');
    assert.equal(again.ticket.regressionOf, first.id);
    assert.equal(again.ticket.id, `${first.id}-r1`);
    // A won't-fix ticket keeps its verdict when it recurs: the occurrence is counted, nothing reopens.
    const w = reportFailure(v, { ...BUILD, thing: 'noisy', error: 'x' }).ticket;
    updateTicket(v, { id: w.id, by: 'seen-command:owner', status: 'wont_fix' }, { asOwner: true });
    const w2 = reportFailure(v, { ...BUILD, thing: 'noisy', error: 'x again' });
    assert.equal(w2.action, 'occurrence'); assert.equal(w2.ticket.status, 'wont_fix'); assert.equal(w2.ticket.count, 2);
    // An open PR is not closed under its author by a success — it gets a note.
    const p = reportFailure(v, { ...BUILD, thing: 'with-pr', error: 'x' }).ticket;
    claimTicket(v, { id: p.id, by: 'codex' });
    updateTicket(v, { id: p.id, by: 'codex', prUrl: 'https://github.com/begindtheseen/seen-command/pull/7' });
    assert.equal(resolveBySuccess(v, { kind: BUILD.kind, repo: BUILD.repo, thing: 'with-pr' }).action, 'noted');
    assert.equal(getTicket(v, p.id).status, 'pr_open');
  } finally { rmSync(v, { recursive: true, force: true }); }
});

test('duplicates need a real target, and the summary lists only what needs the owner', () => {
  const v = vaultDir();
  try {
    const a = reportFailure(v, { ...BUILD, error: 'boom' }).ticket;
    const b = reportFailure(v, { ...BUILD, thing: 'task-13', error: 'boom' }).ticket;
    const blocked = reportFailure(v, { ...BUILD, thing: 'task-14', error: 'Anthropic credit balance too low', blocked: true }).ticket;
    assert.equal(updateTicket(v, { id: b.id, by: 'codex', status: 'duplicate', duplicateOf: 'tkt-0000000000' }).code, 404);
    assert.equal(updateTicket(v, { id: b.id, by: 'codex', status: 'duplicate', duplicateOf: a.id }).ok, true);
    const ready = reportFailure(v, { ...BUILD, thing: 'task-15', error: 'boom' }).ticket;
    claimTicket(v, { id: ready.id, by: 'codex' });
    updateTicket(v, { id: ready.id, by: 'codex', prUrl: 'https://github.com/begindtheseen/seen-command/pull/8' });
    updateTicket(v, { id: ready.id, by: 'seen-command:owner', prState: 'ready' }, { asOwner: true });
    const s = ticketsSummary(v);
    assert.deepEqual(s.needsOwner.map((x) => [x.id, x.why]).sort(), [[blocked.id, 'blocked'], [ready.id, 'merge_ready']].sort());
    assert.equal(s.active, 3); assert.equal(s.claimed, 1);
    assert.deepEqual(listTickets(v, { status: 'duplicate' }).map((t) => t.id), [b.id]);
    assert.deepEqual(listTickets(v, { kind: 'test_red' }), []);
    assert.equal(ticketsSummary(null).active, 0);
  } finally { rmSync(v, { recursive: true, force: true }); }
});

test('a Seen Command ticket must say what would have helped; a sharper one supersedes, history kept', () => {
  const v = vaultDir();
  try {
    assert.throws(() => reportFailure(v, { kind: 'assistant_failed', repo: 'begindtheseen/seen-command', thing: 'board room', error: 'no route for X' }), /needs `helped`/);
    assert.throws(() => reportFailure(v, { ...BUILD, tool: true, error: 'gate red', helped: '   ' }), /needs `helped`/);
    const a = reportFailure(v, { kind: 'assistant_failed', repo: 'begindtheseen/seen-command', thing: 'board room', error: 'no route for X', helped: 'a route that lists X', ref: 'r1' });
    assert.equal(a.ticket.tool, true); assert.equal(a.ticket.helped, 'a route that lists X');
    const b = reportFailure(v, { kind: 'assistant_failed', repo: 'begindtheseen/seen-command', thing: 'board room', error: 'no route for X again', helped: 'GET /api/x with a since= filter', ref: 'r2' });
    assert.equal(b.ticket.helped, 'GET /api/x with a since= filter'); assert.equal(b.ticket.count, 2);
    const helpedHistory = b.ticket.history.filter((h) => h.fields.helped).map((h) => h.fields.helped);
    assert.deepEqual(helpedHistory, ['a route that lists X', 'GET /api/x with a since= filter']);
    // A product ticket does not need it; a tool ticket cannot be emptied of it.
    const p = reportFailure(v, { kind: 'collector_failed', repo: 'begindtheseen/Seen', thing: 'indeed', error: 'Chrome closed' });
    assert.equal(p.ticket.tool, false); assert.equal(p.ticket.helped, null);
    const r = updateTicket(v, { id: a.ticket.id, by: 'seen-command:owner', helped: '' }, { asOwner: true });
    assert.equal(r.ok, false); assert.match(r.error, /keeps its "what would have helped"/);
  } finally { rmSync(v, { recursive: true, force: true }); }
});

test('seenjobs.io tickets list before Seen Command’s own; ready-for-AI still leads', () => {
  const v = vaultDir();
  try {
    const tool = reportFailure(v, { kind: 'meeting_failed', repo: 'begindtheseen/seen-command', thing: 'board meeting', tool: true, error: 'x', helped: 'retry the step', at: '2026-10-21T20:00:00Z' }).ticket;
    const prod = reportFailure(v, { kind: 'collector_failed', repo: 'begindtheseen/Seen', thing: 'indeed', error: 'y', at: '2026-10-21T10:00:00Z' }).ticket;
    assert.deepEqual(listTickets(v).map((t) => t.id), [prod.id, tool.id], 'the product first even though the tool one is newer');
    updateTicket(v, { id: tool.id, by: 'seen-command:owner', requested: 'ai' }, { asOwner: true });
    assert.deepEqual(listTickets(v).map((t) => t.id), [tool.id, prod.id], 'the owner’s explicit ask outranks it');
  } finally { rmSync(v, { recursive: true, force: true }); }
});
