import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { issueClient } from '../lib/access-control.mjs';

const server = new URL('./server.mjs', import.meta.url).pathname;
const request = (vault, messages, extraEnv = {}) => {
  const r = spawnSync(process.execPath, [server], {
    input: messages.map((m) => JSON.stringify(m)).join('\n') + '\n',
    encoding: 'utf8',
    env: { ...process.env, CHRONOS_VAULT: vault, SEEN_REPO: join(vault, 'missing-seen'), ...extraEnv },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().split('\n').filter(Boolean).map(JSON.parse);
};

test('anonymous clients are denied before any brain operation', () => {
  const vault = mkdtempSync(join(tmpdir(), 'brain-mcp-identity-'));
  try {
    const rows = request(vault, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ]);
    assert.equal(rows[0].error.code, -32602);
    assert.match(rows[0].error.message, /^Identify yourself:/);
    assert.equal(rows[1].error.code, -32001);
    assert.match(rows[1].error.message, /^Identify yourself:/);
    const audit = readFileSync(join(vault, '.access', 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(audit.length, 2, 'both denied attempts are visible traffic');
    assert.equal(audit[0].tool, 'initialize');
    assert.equal(audit[1].tool, 'tools/list');
    assert.equal(audit[1].by, 'unidentified');
    assert.equal(audit[1].ok, false);
    assert.match(audit[1].error, /Access denied: identify yourself/);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('a claimed source name alone never selects or obtains that source credential', () => {
  const vault = mkdtempSync(join(tmpdir(), 'brain-mcp-claim-only-'));
  try {
    issueClient(vault, { name: 'claude-brain', scopes: ['read'] });
    const rows = request(vault, [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'Claude Code', version: '1' },
    } }], { BRAIN_CLIENT: '', BRAIN_CLIENT_TOKEN: '', BRAIN_CLIENT_CREDENTIAL_FILE: '' });
    assert.equal(rows[0].error.code, -32602);
    assert.match(rows[0].error.message, /present a valid Chronos client credential/);
    const audit = readFileSync(join(vault, '.access', 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(audit[0].by, 'unidentified');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('identified Codex client is accepted and its request is audited as codex', () => {
  const vault = mkdtempSync(join(tmpdir(), 'brain-mcp-identity-'));
  try {
    const issued = issueClient(vault, { name: 'codex', scopes: ['read', 'write'] });
    const rows = request(vault, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'Codex Desktop', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'brain_contradictions', arguments: {} } },
    ], { BRAIN_CLIENT: 'codex', BRAIN_CLIENT_TOKEN: issued.secret });
    assert.equal(rows[0].result.serverInfo.name, 'seen-brain');
    assert.match(rows[1].result.content[0].text, /No contradictions/);
    const audit = readFileSync(join(vault, '.access', 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].by, 'codex');
    assert.equal(audit[0].tool, 'brain_contradictions');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('one Claude host can authenticate as a role-qualified registered source', () => {
  const vault = mkdtempSync(join(tmpdir(), 'brain-mcp-role-'));
  try {
    const issued = issueClient(vault, { name: 'claude-brain', scopes: ['read'] });
    const rows = request(vault, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'Claude Code', version: '1' },
      } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'brain_contradictions', arguments: {} } },
    ], { BRAIN_CLIENT: 'claude-brain', BRAIN_CLIENT_TOKEN: issued.secret });
    assert.equal(rows[0].result.serverInfo.authenticatedSource, 'claude-brain');
    assert.equal(rows[0].result.serverInfo.hostClient, 'claude');
    assert.match(rows[1].result.content[0].text, /No contradictions/);
    const audit = readFileSync(join(vault, '.access', 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(audit[0].by, 'claude-brain');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('a valid credential cannot impersonate a different configured source', () => {
  const vault = mkdtempSync(join(tmpdir(), 'brain-mcp-identity-'));
  try {
    const issued = issueClient(vault, { name: 'codex', scopes: ['read'] });
    const rows = request(vault, [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'Claude Code', version: '1' },
    } }], { BRAIN_CLIENT: 'claude', BRAIN_CLIENT_TOKEN: issued.secret });
    assert.equal(rows[0].error.code, -32602);
    assert.match(rows[0].error.message, /configured source does not match the credential owner/);
    const audit = readFileSync(join(vault, '.access', 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(audit[0].by, 'codex', 'the verified credential owner remains authoritative on denial');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('authenticated unknown tools are denied and remain visible under the authoritative source', () => {
  const vault = mkdtempSync(join(tmpdir(), 'brain-mcp-audit-'));
  try {
    const issued = issueClient(vault, { name: 'codex', scopes: ['read'] });
    const rows = request(vault, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'codex', version: '1' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'brain_nonexistent_probe', arguments: { subject: 'target' } } },
    ], { BRAIN_CLIENT: 'codex', BRAIN_CLIENT_TOKEN: issued.secret });
    assert.equal(rows[1].error.code, -32601);
    const audit = readFileSync(join(vault, '.access', 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(audit[0].tool, 'brain_nonexistent_probe'); assert.equal(audit[0].by, 'codex');
    assert.equal(audit[0].ok, false); assert.match(audit[0].error, /unknown tool/);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('oversized MCP lines are rejected before parsing and audited without payload bytes', () => {
  const vault = mkdtempSync(join(tmpdir(), 'brain-mcp-line-'));
  try {
    const issued = issueClient(vault, { name: 'codex', scopes: ['read'] });
    const rows = request(vault, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'codex', version: '1' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'brain_search_facts', arguments: { subject: 'x'.repeat(900) } } },
    ], { BRAIN_CLIENT: 'codex', BRAIN_CLIENT_TOKEN: issued.secret, CHRONOS_MCP_MAX_LINE_CHARS: '512' });
    assert.equal(rows[1].error.code, -32600); assert.match(rows[1].error.message, /request exceeds 512/);
    const audit = readFileSync(join(vault, '.access', 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(audit[0].tool, 'transport/request'); assert.equal(audit[0].by, 'codex');
    assert.equal(audit[0].args, 'requestChars: >512'); assert.equal(JSON.stringify(audit).includes('x'.repeat(50)), false);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('a client is denied artifact access unless its credential carries that exact scope', () => {
  const vault = mkdtempSync(join(tmpdir(), 'brain-mcp-scope-'));
  try {
    const issued = issueClient(vault, { name: 'codex', scopes: ['read'] });
    const rows = request(vault, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'codex', version: '1' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'brain_artifact_list', arguments: {} } },
    ], { BRAIN_CLIENT: 'codex', BRAIN_CLIENT_TOKEN: issued.secret });
    assert.equal(rows[0].result.serverInfo.name, 'seen-brain');
    assert.equal(rows[1].error.code, -32003);
    assert.match(rows[1].error.message, /artifact:read/);
    const audit = readFileSync(join(vault, '.access', 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(audit[0].tool, 'brain_artifact_list'); assert.equal(audit[0].mode, 'read'); assert.equal(audit[0].ok, false);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

// A handoff written as an episode is invisible to its addressee, and both writes return ok. The
// warning is the only signal, so it has to be pinned AT THE BOUNDARY — testing the detector alone
// leaves the wiring free to be removed with the suite green, which was verified by removing it.
test('an episode that reads as a handoff is answered with a warning', () => {
  const vault = mkdtempSync(join(tmpdir(), 'brain-mcp-handoff-'));
  try {
    const issued = issueClient(vault, { name: 'codex', scopes: ['read', 'write'] });
    const rows = request(vault, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'Codex Desktop', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'brain_append_timeline', arguments: {
        heading: 'HANDOFF FOR claude-brain', text: 'please rerun the canary from a fresh container',
      } } },
    ], { BRAIN_CLIENT: 'codex', BRAIN_CLIENT_TOKEN: issued.secret });
    const out = rows[1].result.content[0].text;
    assert.match(out, /Appended to/, 'the write still succeeds');
    assert.match(out, /looks like a handoff/, 'and the caller is told');
    assert.match(out, /brain_add_fact/, 'with the remedy named');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('an ordinary episode gets no warning', () => {
  // Precision matters more than recall here: a warning on every entry would be ignored.
  const vault = mkdtempSync(join(tmpdir(), 'brain-mcp-handoff-'));
  try {
    const issued = issueClient(vault, { name: 'codex', scopes: ['read', 'write'] });
    const rows = request(vault, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'Codex Desktop', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'brain_append_timeline', arguments: {
        heading: 'Dev log', text: 'Codex squash-merged PR #189 into main as a785659; read HANDOFF.md at orientation.',
      } } },
    ], { BRAIN_CLIENT: 'codex', BRAIN_CLIENT_TOKEN: issued.secret });
    const out = rows[1].result.content[0].text;
    assert.match(out, /Appended to/);
    assert.ok(!/looks like a handoff/.test(out), `ordinary narration must not warn: ${out}`);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

// Provenance must reach the READER, not just exist as a helper. Two facts that both assert
// confidence "high" have to look different when one rests on a file:line and the other on a bare
// wiki-link — that difference is the whole point, and it lives in the rendering.
test('a rendered fact shows derived provenance beside self-asserted confidence', () => {
  const vault = mkdtempSync(join(tmpdir(), 'brain-mcp-prov-'));
  try {
    mkdirSync(join(vault, 'knowledge'), { recursive: true });
    writeFileSync(join(vault, 'knowledge', 'k.md'),
      '---\ntitle: K\ntags: [knowledge]\nupdated: 2026-08-15\nfacts:\n'
      + '  - id: a-b\n    subject: Alpha\n    predicate: p\n    object: grounded\n    valid_from: 2026-08-15\n'
      + '    valid_to: null\n    confidence: high\n    recorded: 2026-08-15\n    source: brain/lib/cloud.mjs:253\n'
      + '  - id: c-d\n    subject: Beta\n    predicate: p\n    object: ungrounded\n    valid_from: 2026-08-15\n'
      + '    valid_to: null\n    confidence: high\n    recorded: 2026-08-15\n    source: "[[claude-observations]]"\n'
      + '---\n\n# K\n');
    const issued = issueClient(vault, { name: 'codex', scopes: ['read'] });
    const rows = request(vault, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'Codex Desktop', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'brain_search_facts', arguments: { query: 'Alpha' } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'brain_search_facts', arguments: { query: 'Beta' } } },
    ], { BRAIN_CLIENT: 'codex', BRAIN_CLIENT_TOKEN: issued.secret });
    const grounded = rows[1].result.content[0].text;
    const ungrounded = rows[2].result.content[0].text;
    assert.match(grounded, /· high · measured/, 'a file:line source renders as measured');
    assert.match(ungrounded, /· high · note-pointer/, 'a bare wiki-link renders as note-pointer');
    // Same asserted confidence, different derived grounding — that is the signal.
    assert.ok(grounded.includes('high') && ungrounded.includes('high'));
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

// ---- tickets over MCP: identity is the authenticated credential, never an argument ----------------
test('ticket tools: list → get → claim → update, attributed to the authenticated client', async () => {
  const vault = mkdtempSync(join(tmpdir(), 'brain-mcp-tickets-'));
  try {
    const { reportFailure, getTicket } = await import('../lib/tickets.mjs');
    const { ticket } = reportFailure(vault, { kind: 'build_failed', repo: 'begindtheseen/seen-command', thing: 'task-7', title: 'Build failed: widget', error: 'gate red' });
    const codex = issueClient(vault, { name: 'codex', scopes: ['read', 'write'] });
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'codex', version: '1' } } };
    const call = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    const rows = request(vault, [init,
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      call(3, 'brain_list_tickets', {}),
      call(4, 'brain_get_ticket', { id: ticket.id }),
      // A self-declared `by` is ignored: the claim belongs to the credential's owner.
      call(5, 'brain_claim_ticket', { id: ticket.id, by: 'claude-brain' }),
      call(6, 'brain_update_ticket', { id: ticket.id, plan: 'fix the gate step', by: 'claude-brain' }),
      call(7, 'brain_update_ticket', { id: ticket.id, status: 'merged' }),
    ], { BRAIN_CLIENT: 'codex', BRAIN_CLIENT_TOKEN: codex.secret });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const names = byId.get(2).result.tools.map((t) => t.name);
    for (const n of ['brain_list_tickets', 'brain_get_ticket', 'brain_claim_ticket', 'brain_update_ticket']) assert.ok(names.includes(n), n);
    assert.match(byId.get(3).result.content[0].text, new RegExp(`${ticket.id} \\[open\\] build_failed`));
    assert.match(byId.get(4).result.content[0].text, /## Latest evidence[\s\S]*gate red/);
    assert.match(byId.get(5).result.content[0].text, /Claimed by codex/);
    assert.match(byId.get(6).result.content[0].text, /claimed → planned/);
    assert.equal(byId.get(7).result.isError, true); assert.match(byId.get(7).result.content[0].text, /cannot move planned → merged/);
    const t = getTicket(vault, ticket.id);
    assert.equal(t.claimant, 'codex'); assert.equal(t.plan, 'fix the gate step');
    assert.ok(t.history.filter((h) => h.fields.status === 'claimed' || h.fields.plan).every((h) => h.by === 'codex'));
    const audit = readFileSync(join(vault, '.access', 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const claim = audit.find((a) => a.tool === 'brain_claim_ticket' && a.ok);
    assert.equal(claim.by, 'codex'); assert.equal(claim.mode, 'write');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('ticket tools: a second AI cannot take a live claim, and a read-only client cannot claim at all', async () => {
  const vault = mkdtempSync(join(tmpdir(), 'brain-mcp-tickets-'));
  try {
    const { reportFailure, claimTicket, getTicket } = await import('../lib/tickets.mjs');
    const { ticket } = reportFailure(vault, { kind: 'collector_failed', thing: 'indeed', error: 'Chrome not reachable' });
    claimTicket(vault, { id: ticket.id, by: 'codex' });
    const claude = issueClient(vault, { name: 'claude-brain', scopes: ['read', 'write'] });
    const reader = issueClient(vault, { name: 'claude-seenjobs', scopes: ['read'] });
    const init = (name) => ({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name, version: '1' } } });
    const call = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    const a = new Map(request(vault, [init('Claude Code'), call(2, 'brain_claim_ticket', { id: ticket.id }), call(3, 'brain_update_ticket', { id: ticket.id, status: 'wont_fix' }), call(4, 'brain_update_ticket', { id: ticket.id, note: 'I can take this if codex stops' })],
      { BRAIN_CLIENT: 'claude-brain', BRAIN_CLIENT_TOKEN: claude.secret }).map((r) => [r.id, r]));
    assert.equal(a.get(2).result.isError, true); assert.match(a.get(2).result.content[0].text, /claimed by codex/);
    assert.equal(a.get(3).result.isError, true);
    assert.match(a.get(4).result.content[0].text, /Updated/);
    const b = new Map(request(vault, [init('Claude Code'), call(2, 'brain_list_tickets', {}), call(3, 'brain_claim_ticket', { id: ticket.id })],
      { BRAIN_CLIENT: 'claude-seenjobs', BRAIN_CLIENT_TOKEN: reader.secret }).map((r) => [r.id, r]));
    assert.match(b.get(2).result.content[0].text, /1 ticket/);
    assert.equal(b.get(3).error.code, -32003, 'claiming is a write');
    const t = getTicket(vault, ticket.id);
    assert.equal(t.claimant, 'codex'); assert.equal(t.note, 'I can take this if codex stops');
    assert.equal(t.history.find((h) => h.fields.note).by, 'claude-brain');
  } finally { rmSync(vault, { recursive: true, force: true }); }
});

test('ticket tools: Seen Command’s own principal names cannot act over MCP; "what would have helped" is shown and editable', async () => {
  const vault = mkdtempSync(join(tmpdir(), 'brain-mcp-tickets-'));
  try {
    const { reportFailure, getTicket } = await import('../lib/tickets.mjs');
    const { ticket } = reportFailure(vault, { kind: 'assistant_failed', repo: 'begindtheseen/seen-command', thing: 'board room', error: 'no verb for held reports', helped: 'an act verb for held reports' });
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'x', version: '1' } } };
    const call = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    const builder = issueClient(vault, { name: 'seen-command-builder', scopes: ['read', 'write'] });
    const b = new Map(request(vault, [init, call(2, 'brain_claim_ticket', { id: ticket.id })], { BRAIN_CLIENT: 'seen-command-builder', BRAIN_CLIENT_TOKEN: builder.secret }).map((r) => [r.id, r]));
    assert.equal(b.get(2).result.isError, true); assert.match(b.get(2).result.content[0].text, /reserved for Seen Command/);
    const codex = issueClient(vault, { name: 'codex', scopes: ['read', 'write'] });
    const c = new Map(request(vault, [init, call(2, 'brain_get_ticket', { id: ticket.id }), call(3, 'brain_claim_ticket', { id: ticket.id }),
      call(4, 'brain_update_ticket', { id: ticket.id, helped: 'GET /api/held-reports + act verb `held`' })], { BRAIN_CLIENT: 'codex', BRAIN_CLIENT_TOKEN: codex.secret }).map((r) => [r.id, r]));
    assert.match(c.get(2).result.content[0].text, /what would have helped: an act verb for held reports/);
    assert.match(c.get(2).result.content[0].text, /about: Seen Command itself/);
    assert.match(c.get(4).result.content[0].text, /helped/);
    const t = getTicket(vault, ticket.id);
    assert.equal(t.claimant, 'codex'); assert.match(t.helped, /held-reports/);
  } finally { rmSync(vault, { recursive: true, force: true }); }
});
