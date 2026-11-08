#!/usr/bin/env node
// Brain MCP server — gives AI clients READ + WRITE access to the shared memory brain, so each can
// both rely on it for context/decisions AND update it. A write-enabled superset of the seen repo's
// read-only chronos server, over the SAME vault (the source of truth) plus Seen Command's state.
//
// Transport: MCP stdio (newline-delimited JSON-RPC 2.0). Dependency-free — no SDK, no npm install.
// stdout carries only protocol messages; logs go to stderr. It re-reads the vault on every call,
// so recall is always current (including facts just written by an agent or a prior tool call).
//
// Wire each operational source through its own private workspace MCP configuration with an exact
// BRAIN_CLIENT plus BRAIN_CLIENT_CREDENTIAL_FILE. Shared project MCP config is intentionally empty.
// See brain/mcp/README.md and BRAIN_AI_CLIENT_PROTOCOL.txt.

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  searchFacts, whatsChanged, findContradictions, getTimeline, getEntity,
} from '../lib/chronos/memoryGraph.mjs';
import { readIndex } from '../lib/vault.mjs';
import { resolveSources } from '../lib/sources.mjs';
import { buildUnifiedGraph } from '../lib/unify.mjs';
import { recordFact, supersedeFact, logDecision, appendTimeline, assertNotePath } from '../lib/memory-write.mjs';
import {
  appendAccess, summarizeArgs, isWriteTool, activeSessions, normalizeClientIdentity,
  normalizeRegisteredSource,
} from '../lib/activity.mjs';
import { verifyClient } from '../lib/access-control.mjs';
import { splitMetrics, metricsLine } from '../lib/metrics.mjs';
import { detectHandoff, handoffWarning } from '../lib/handoff-detect.mjs';
import { classifyProvenance } from '../lib/provenance.mjs';
import {
  beginArtifactUpload, finishArtifactUpload, listArtifacts, MAX_ENCODED_CHUNK_CHARS,
  readArtifactChunk, writeArtifactChunk,
} from '../lib/artifacts.mjs';
import { openFileUpdatePR } from '../lib/github-broker.mjs';
import {
  listTickets, getTicket, claimTicket, updateTicket, ticketLine, ticketText, STATUSES, KINDS,
} from '../lib/tickets.mjs';

const today = () => new Date().toISOString().slice(0, 10);
let SOURCES = resolveSources();
const vault = () => SOURCES.vaultPath;

// NOTE VALIDATION LIVES HERE, at the MCP boundary, not in one writer.
//
// This is the tool that stranded three facts on 2026-08-13: a caller passed its `change` sentence as
// `note`, and both writers happily created a file NAMED after that sentence at the vault root, where
// nothing is indexed. The first fix went into the vendored writer — and MISSED, because whenever the
// seen repo is present (it is, on this machine) these handlers dispatch to the SHARED writer instead,
// which has no validation of its own. Guarding the entry point covers both dispatch paths regardless
// of which writer resolves, which is the only version that cannot rot when the resolution changes.
//
// ONE WRITER: prefer the seen repo's shared writer (<seen>/lib/server/writeFact.js, PR #166) — the
// same module Seen Command uses — so Claude's facts are byte-identical to the exec team's. The vault
// lives at <seen>/memory, so its parent is the seen repo. Falls back to the vendored writer if the
// seen repo isn't present (writes still land, just not through the shared module).
function seenWriterPath() {
  const cands = [];
  if (process.env.SEEN_REPO) cands.push(join(process.env.SEEN_REPO, 'lib', 'server', 'writeFact.js'));
  const v = vault();
  if (v) cands.push(join(dirname(v), 'lib', 'server', 'writeFact.js'));
  for (const c of cands) { try { if (existsSync(c)) return c; } catch { /* skip */ } }
  return null;
}
let shared = null;
try {
  const p = seenWriterPath();
  if (p) { shared = await import(pathToFileURL(p).href); process.stderr.write(`[brain] shared writer: ${p}\n`); }
} catch (e) { process.stderr.write(`[brain] shared writer load failed (${e.message}) — vendored\n`); shared = null; }

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const fmtFact = (f) => {
  const window = f.valid_to == null ? `since ${f.valid_from}` : `${f.valid_from} → ${f.valid_to}`;
  const conf = f.confidence ? ` · ${f.confidence}` : '';
  // The DERIVED grounding, shown next to the self-asserted confidence. `confidence` is written by
  // the same agent that writes the claim (89.7% of open facts say "high"); provenance is computed
  // from `source` and cannot be asserted. Both are shown so a reader can see them disagree.
  const prov = ` · ${classifyProvenance(f.source).name}`;
  const src = f.source ? ` · src: ${f.source}` : '';
  return `• ${f.subject} — ${f.predicate} → ${f.object}  [${window}${conf}${prov}]${src}  (${f.note})`;
};
function requireVault() { if (!vault()) throw new Error('No Chronos vault found. Set CHRONOS_VAULT to the seen repo\'s memory/ folder.'); }

// The registered source is structural, not a model-authored tool argument. BRAIN_CLIENT names the
// exact security principal (for example claude-brain), while initialize.clientInfo.name identifies
// only the host software (for example Claude Code). The credential remains authoritative for both
// identity and scopes; neither claimed string can select or replace a credential.
const configuredSource = normalizeRegisteredSource(process.env.BRAIN_CLIENT);
let clientIdentity = 'unidentified-client';
let authenticatedClient = null;
let identityVerified = false;
function presentedCredential() {
  if (process.env.BRAIN_CLIENT_TOKEN) return process.env.BRAIN_CLIENT_TOKEN.trim();
  if (process.env.BRAIN_CLIENT_CREDENTIAL_FILE) {
    try { return String(readFileSync(process.env.BRAIN_CLIENT_CREDENTIAL_FILE, 'utf8')).trim(); } catch { return ''; }
  }
  return '';
}
// Ticket writes need a real, non-reserved principal (see brain/lib/tickets.mjs).
const RESERVED_TICKET_PRINCIPALS = new Set(['seen-command', 'seen-command-builder', 'seen-command:owner', 'seen-command:assistant']);
function ticketPrincipal() {
  if (!identityVerified || !authenticatedClient) throw new Error('ticket changes need an authenticated client');
  if (RESERVED_TICKET_PRINCIPALS.has(String(clientIdentity).toLowerCase())) throw new Error(`${clientIdentity} is reserved for Seen Command itself and cannot claim or change tickets here`);
  return clientIdentity;
}
const writtenBy = (a) => clientIdentity !== 'unidentified-client'
  ? clientIdentity
  : normalizeClientIdentity(a && a.by);

// ---- tools ----------------------------------------------------------------
const TOOLS = {
  brain_search_facts: {
    def: { name: 'brain_search_facts',
      description: 'Search the memory brain for typed facts, optionally AS OF a past date (bi-temporal point-in-time recall). Use as_of to ask "what was true on date X"; omit for what is currently true. Read this for context before making decisions.',
      inputSchema: { type: 'object', properties: {
        query: { type: 'string', description: 'free-text matched against subject/predicate/object' },
        as_of: { type: 'string', description: 'ISO date YYYY-MM-DD; facts valid at this moment. Omit for now.' },
        subject: { type: 'string' }, predicate: { type: 'string' } } } },
    run: (a) => { const idx = readIndex(vault());
      const r = searchFacts(idx.facts, { query: a.query, asOf: a.as_of, subject: a.subject, predicate: a.predicate });
      const when = a.as_of ? `as of ${a.as_of}` : 'currently true';
      return text(r.length ? `${r.length} fact(s) ${when}:\n${r.map(fmtFact).join('\n')}` : `No facts ${when} for that query.`); },
  },
  brain_whats_changed: {
    def: { name: 'brain_whats_changed',
      description: 'Transaction-time delta: facts RECORDED or INVALIDATED on/after a date. Call at session START with the last session date to see what the brain learned or unlearned since.',
      inputSchema: { type: 'object', properties: { since: { type: 'string', description: 'ISO date YYYY-MM-DD' } }, required: ['since'] } },
    // What was LEARNED leads; KPI refreshes (each one a "new fact", each closing the last) fold into one
    // line per list — counted, never dropped. Unfolded, a week of change is mostly active_jobs readings.
    run: (a) => { const idx = readIndex(vault()); const { added, invalidated } = whatsChanged(idx.facts, a.since);
      const A = splitMetrics(added); const I = splitMetrics(invalidated);
      const block = (s) => [...s.knowledge.map(fmtFact), ...(s.metrics.length ? [`  ${metricsLine(s.metrics)}`] : [])].join('\n') || '  (none)';
      return text(`Added since ${a.since} (${A.knowledge.length} learned${A.metrics.length ? ` + ${added.length - A.knowledge.length} KPI readings` : ''}):\n${block(A)}\n\nInvalidated since ${a.since} (${I.knowledge.length} retired${I.metrics.length ? ` + ${invalidated.length - I.knowledge.length} superseded KPI readings` : ''}):\n${block(I)}`); },
  },
  brain_get_entity: {
    def: { name: 'brain_get_entity',
      description: 'Everything the brain knows about one entity (person/project/concept): its note, current + historical facts, and linked/backlinked notes.',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
    run: (a) => { const idx = readIndex(vault()); const e = getEntity(idx, a.name);
      if (!e) return text(`No entity matching "${a.name}".`);
      return text(`# ${e.entity.title} (${e.entity.path})\n\nFacts (${e.facts.length}):\n${e.facts.map(fmtFact).join('\n') || '  (none)'}\n\nLinks → ${e.links.join(', ') || '(none)'}\nBacklinks ← ${e.backlinks.join(', ') || '(none)'}`); },
  },
  brain_timeline: {
    def: { name: 'brain_timeline',
      description: 'Dated timeline episodes (session logs / board-meeting records) in a date range, newest first.',
      inputSchema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } } },
    run: (a) => { const idx = readIndex(vault()); const eps = getTimeline(idx.episodes, { from: a.from || null, to: a.to || null });
      return text(eps.length ? eps.map((e) => `## ${e.date} (${e.id})\n${(e.sections['Shipped'] || e.text).slice(0, 600)}`).join('\n\n') : 'No episodes in that range.'); },
  },
  brain_contradictions: {
    def: { name: 'brain_contradictions',
      description: 'Hygiene check: facts with the same subject+predicate whose validity windows overlap but values differ (usually a supersede that forgot to close valid_to). Run after writes.',
      inputSchema: { type: 'object', properties: {} } },
    run: () => { const idx = readIndex(vault()); const c = findContradictions(idx.facts);
      return text(c.length ? `${c.length} contradiction(s):\n${c.map((p) => `• ${p.a.subject} ${p.a.predicate}: "${p.a.object}" (${p.a.note}) vs "${p.b.object}" (${p.b.note})`).join('\n')}` : 'No contradictions — validity windows are clean.'); },
  },
  brain_overview: {
    def: { name: 'brain_overview',
      description: 'A snapshot of the whole unified brain: node/fact counts across both stores (Seen Command graph + Chronos vault), the cross-store bridges, and how many facts are active today. Good first call to see what the system knows.',
      inputSchema: { type: 'object', properties: {} } },
    run: () => { const g = buildUnifiedGraph({ statePath: SOURCES.statePath, vaultPath: vault(), today: today() });
      const c = g.counts;
      // Presence is part of the overview on purpose: seen and seen-command sessions both ship changes,
      // and the historical failure mode is neither knowing the other exists. Any session that calls
      // brain_overview mid-flight sees who else is live before it commits to a plan.
      let sessions = '';
      try {
        const live = activeSessions(vault());
        sessions = live.length
          ? `\n  ⚠ Active Claude sessions RIGHT NOW: ${live.map((s) => `${s.repo} (since ${String(s.at).slice(11, 16)}Z)`).join(' · ')} — coordinate before shipping plan changes.`
          : '\n  No other Claude sessions active right now.';
      } catch { /* registry unavailable → omit rather than fail the overview */ }
      return text(`Unified brain @ ${today()}\n`
        + `  Chronos vault: ${c.chronos.notes} notes · ${c.chronos.facts} typed facts · ${c.chronos.links} wiki-links\n`
        + `  Seen Command:  ${c.command.nodes} nodes · ${c.command.facts} facts · ${c.command.threads} work threads\n`
        + `  Bridges (same entity in both): ${c.bridges}\n`
        + `  Total: ${c.total.nodes} nodes · ${c.total.links} links · span ${g.dateRange.from} → ${g.dateRange.to}\n`
        + `  vault: ${vault() || '(not found)'} · state: ${SOURCES.stateFound ? SOURCES.statePath : '(not found)'}${sessions}`); },
  },
  brain_add_fact: {
    def: { name: 'brain_add_fact',
      description: 'Record a NEW typed fact into the brain (the durable vault). Use for a new truth. To CHANGE the value of an existing fact, use brain_supersede_fact instead (never overwrite). Writes are append-only history and reversible via git.',
      inputSchema: { type: 'object', properties: {
        note: { type: 'string', description: 'vault note to hold the fact, e.g. "knowledge/seen-command.md". Group by subject area.' },
        subject: { type: 'string' }, predicate: { type: 'string' }, object: { type: 'string' },
        valid_from: { type: 'string', description: 'ISO date the fact became true. Omit = today.' },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        source: { type: 'string', description: 'provenance — a wiki-link and/or path:line' },
        change: { type: 'string', description: 'plain-language WHAT this changed and WHY (provenance)' },
        by: { type: 'string', description: 'who/what wrote it, e.g. "claude:<session>" or "seen-command"' },
        supersedes: { type: 'string', description: 'id of a fact this replaces (optional; usually set via brain_supersede_fact)' } },
        required: ['note', 'subject', 'predicate', 'object'] } },
    run: (a) => { requireVault(); assertNotePath(a.note);
      if (shared) { // shared writer upserts (add-or-supersede) and no-ops if unchanged — byte-compatible
        const r = shared.recordFact(vault(), a.note, { subject: a.subject, predicate: a.predicate, object: a.object, confidence: a.confidence, source: a.source, change: a.change, by: writtenBy(a) });
        return text(r.written ? `Recorded: ${a.subject} — ${a.predicate} → ${a.object}  (${a.note})` : `Unchanged (already current): ${a.subject} — ${a.predicate}`);
      }
      // Vendored fallback — DEDUP-AWARE via the SAME recordFact lib/brain.mjs `writeOne` uses, so a
      // repeated add of the same subject+predicate no-ops or supersedes instead of plain-appending a
      // duplicate (the bug that piled up duplicate live facts). Not a raw addFact.
      const r = recordFact(vault(), a.note, { subject: a.subject, predicate: a.predicate, object: a.object, valid_from: a.valid_from, confidence: a.confidence, source: a.source, change: a.change, by: writtenBy(a) });
      if (r.action === 'noop') return text(`Unchanged (already current): ${a.subject} — ${a.predicate}`);
      if (r.action === 'superseded') return text(`Superseded: ${a.subject} — ${a.predicate} → ${a.object}  (${a.note})`);
      return text(`Recorded${r.created ? ` (new note ${r.note})` : ''}: ${fmtFact({ ...r.fact, note: r.note })}`); },
  },
  brain_supersede_fact: {
    def: { name: 'brain_supersede_fact',
      description: 'Change the value of an existing OPEN fact the bi-temporal way: closes the old fact (valid_to = date) and appends a new one (valid_from = date). History is preserved — as-of queries still see the old value. Identify the fact by id, or by subject+predicate.',
      inputSchema: { type: 'object', properties: {
        note: { type: 'string' }, id: { type: 'string', description: 'the existing fact id (preferred)' },
        subject: { type: 'string' }, predicate: { type: 'string' },
        object: { type: 'string', description: 'the NEW value' },
        date: { type: 'string', description: 'ISO change date. Omit = today.' },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] }, source: { type: 'string' },
        change: { type: 'string', description: 'plain-language WHAT changed and WHY (provenance)' },
        by: { type: 'string', description: 'who/what made the change' } },
        required: ['note', 'object'] } },
    run: (a) => { requireVault(); assertNotePath(a.note);
      // Prefer the shared writer when identified by subject+predicate (it closes the open fact and
      // appends the new value). Fall back to the vendored writer for id-only supersede / backdating.
      if (shared && a.subject && a.predicate) {
        const r = shared.recordFact(vault(), a.note, { subject: a.subject, predicate: a.predicate, object: a.object, confidence: a.confidence, source: a.source, change: a.change, by: writtenBy(a) });
        return text(r.written ? `Superseded: ${a.subject} — ${a.predicate} → ${a.object}  (${a.note})` : `Unchanged (already current): ${a.subject} — ${a.predicate}`);
      }
      const r = supersedeFact(vault(), { ...a, by: writtenBy(a) });
      return text(`Superseded. Closed ${r.closed.id} (valid_to ${r.closed.valid_to}); new value → ${fmtFact({ ...r.added, note: a.note })}`); },
  },
  brain_log_decision: {
    def: { name: 'brain_log_decision',
      description: 'Append a locked decision to the append-only ledger (decisions/log.md) — pricing, policy, infra, architecture choices that must not be relitigated.',
      inputSchema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' }, date: { type: 'string' } }, required: ['title'] } },
    run: (a) => { requireVault(); const r = logDecision(vault(), a); return text(`Logged decision "${r.title}" → ${r.note} (${r.date}).`); },
  },
  brain_append_timeline: {
    def: { name: 'brain_append_timeline',
      description: 'Append an episode line to today\'s (or a given date\'s) timeline note — what happened, shipped, or was verified this session. Append-only per day.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' }, heading: { type: 'string' }, date: { type: 'string' } }, required: ['text'] } },
    run: (a) => { requireVault();
      // Checked at the MCP BOUNDARY, not inside a writer. This tool dispatches to the seen repo's
      // SHARED writer whenever that repo is present — which it is — so a check living only in the
      // vendored brain/lib writer would sit on the branch not taken. That is exactly the mistake
      // bc0b231 made with note-path validation before 18ea9a8 moved it here.
      const flag = detectHandoff({ heading: a.heading, text: a.text });
      const warn = flag.handoff ? `\n\n⚠ ${handoffWarning(flag.signals)}` : '';
      if (shared) { const r = shared.appendTimeline(vault(), a.date || today(), a.heading || 'Log', a.text); return text(`Appended to ${r.path}.${warn}`); }
      const r = appendTimeline(vault(), a);
      return text((r.skipped ? `Already recorded in ${r.note}.` : `Appended to ${r.note}: ${r.added}`) + warn); },
  },
  // ---- tickets: failures Seen Command turned into trackable work (brain/lib/tickets.mjs) ----------
  // Identity is ALWAYS the authenticated principal (clientIdentity), never an argument: a claim or a
  // status change is attributed to whoever's credential made the call. The names Seen Command itself
  // writes under (its system, builder, owner and assistant principals) are never usable from here.
  brain_list_tickets: {
    def: { name: 'brain_list_tickets',
      description: 'List failure tickets Seen Command opened automatically (failed builds, collector runs, deploy drift, red tests …). Default: every active ticket, ready-for-AI first. Read one with brain_get_ticket, judge whether fixing it is the right move, then brain_claim_ticket.',
      inputSchema: { type: 'object', properties: {
        status: { type: 'string', description: `"active" (default: not yet closed), "all", or a comma list of: ${STATUSES.join(', ')}` },
        repo: { type: 'string', description: 'e.g. begindtheseen/seen-command or begindtheseen/Seen' },
        kind: { type: 'string', description: `comma list of: ${Object.keys(KINDS).join(', ')}` },
        limit: { type: 'integer' } } } },
    run: (a) => { requireVault();
      const rows = listTickets(vault(), { status: a.status || 'active', repo: a.repo || null, kind: a.kind || null, limit: a.limit || 50 });
      return text(rows.length ? `${rows.length} ticket(s):\n${rows.map(ticketLine).join('\n')}` : 'No tickets match.'); },
  },
  brain_get_ticket: {
    def: { name: 'brain_get_ticket',
      description: 'One ticket in full: the failure evidence (redacted error, log excerpt, run/build ids, links), every occurrence, its plan, PR, claimant, the allowed next statuses, and the whole who/when history.',
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'tkt-…' } }, required: ['id'] } },
    run: (a) => { requireVault(); const t = getTicket(vault(), a.id);
      if (!t) throw new Error(`no ticket ${a.id}`);
      return text(ticketText(t)); },
  },
  brain_claim_ticket: {
    def: { name: 'brain_claim_ticket',
      description: 'Claim a ticket so you alone work on it. Atomic: if another AI holds a live claim this fails. A claim with no activity for the claim window (default 6 h) expires and can be taken over. Claim only after judging the fix is a proper move.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
    run: (a) => { requireVault(); ticketPrincipal();
      const r = claimTicket(vault(), { id: a.id, by: clientIdentity });
      if (!r.ok) throw new Error(r.error);
      return text(`${r.already ? 'Already yours — claim refreshed' : `Claimed by ${clientIdentity}`}${r.expiredFrom ? ` (took over ${r.expiredFrom}'s expired claim)` : ''}. Next: brain_update_ticket with your plan, then the PR url.\n\n${ticketLine({ ...r.ticket, lastError: r.ticket.evidence && r.ticket.evidence.error })}`); },
  },
  brain_update_ticket: {
    def: { name: 'brain_update_ticket',
      description: 'Move a ticket forward: your plan (moves claimed → planned), status (validated transitions), the PR url (moves to pr_open), a note, or duplicate_of. Only the claimant changes a claimed ticket; anyone may add a note. Use wont_fix with a note when fixing it is not a proper move.',
      inputSchema: { type: 'object', properties: {
        id: { type: 'string' },
        status: { type: 'string', enum: STATUSES.filter((s) => s !== 'claimed') },
        plan: { type: 'string', description: 'how you will fix it — files, approach, how you will verify' },
        pr_url: { type: 'string', description: 'https://github.com/<owner>/<repo>/pull/<n>' },
        note: { type: 'string' },
        duplicate_of: { type: 'string', description: 'tkt-… (sets status duplicate)' },
        helped: { type: 'string', description: 'what would have helped — the concrete ability or fix (a Seen Command ticket always keeps one)' } },
        required: ['id'] } },
    run: (a) => { requireVault(); ticketPrincipal();
      const r = updateTicket(vault(), { id: a.id, by: clientIdentity, status: a.status, plan: a.plan, prUrl: a.pr_url, note: a.note, duplicateOf: a.duplicate_of, helped: a.helped });
      if (!r.ok) throw new Error(r.error);
      return text(`Updated ${a.id}: ${r.from === r.to ? `still ${r.to}` : `${r.from} → ${r.to}`}${r.changed.length ? ` (${r.changed.filter((c) => c !== 'heartbeat').join(', ')})` : ''}.`); },
  },
  brain_artifact_begin_upload: {
    scope: 'artifact:write', mode: 'write',
    def: { name: 'brain_artifact_begin_upload',
      description: 'Begin a bounded, expiring, SHA-256-verified large-file upload to Chronos. Send chunks in order, then finish. File bytes never enter Brain notes or audit logs.',
      inputSchema: { type: 'object', properties: {
        name: { type: 'string' }, mime: { type: 'string' }, size: { type: 'integer' },
        sha256: { type: 'string' }, ttlHours: { type: 'number' },
      }, required: ['name', 'size', 'sha256'] } },
    run: (a) => text(JSON.stringify(beginArtifactUpload(vault(), { ...a, by: clientIdentity }))),
  },
  brain_artifact_upload_chunk: {
    scope: 'artifact:write', mode: 'write',
    def: { name: 'brain_artifact_upload_chunk',
      description: 'Upload one base64 artifact chunk. Chunks must be sequential and no larger than the size returned by begin_upload.',
      inputSchema: { type: 'object', properties: { uploadId: { type: 'string' }, index: { type: 'integer' }, data: { type: 'string' } }, required: ['uploadId', 'index', 'data'] } },
    run: (a) => text(JSON.stringify(writeArtifactChunk(vault(), a))),
  },
  brain_artifact_finish_upload: {
    scope: 'artifact:write', mode: 'write',
    def: { name: 'brain_artifact_finish_upload',
      description: 'Verify the completed upload size and SHA-256, then publish its expiring content-addressed handle.',
      inputSchema: { type: 'object', properties: { uploadId: { type: 'string' } }, required: ['uploadId'] } },
    run: (a) => text(JSON.stringify(finishArtifactUpload(vault(), a))),
  },
  brain_artifact_list: {
    scope: 'artifact:read', mode: 'read',
    def: { name: 'brain_artifact_list', description: 'List active artifact metadata and SHA-256 handles; never returns file bytes.',
      inputSchema: { type: 'object', properties: {} } },
    run: () => text(JSON.stringify(listArtifacts(vault()))),
  },
  brain_artifact_read_chunk: {
    scope: 'artifact:read', mode: 'read',
    def: { name: 'brain_artifact_read_chunk', description: 'Read a bounded base64 range from an active artifact by SHA-256 handle.',
      inputSchema: { type: 'object', properties: { sha256: { type: 'string' }, offset: { type: 'integer' }, length: { type: 'integer' } }, required: ['sha256'] } },
    run: (a) => text(JSON.stringify(readArtifactChunk(vault(), a))),
  },
  brain_github_open_file_pr: {
    scope: 'github:write', mode: 'write',
    def: { name: 'brain_github_open_file_pr',
      description: 'Update one allowlisted GitHub repository file through a new codex/* branch and DRAFT pull request. Never writes a protected branch directly and never exposes the GitHub token.',
      inputSchema: { type: 'object', properties: {
        repo: { type: 'string' }, base: { type: 'string' }, path: { type: 'string' }, content: { type: 'string' },
        mode: { type: 'string', enum: ['replace', 'append'] }, title: { type: 'string' }, body: { type: 'string' },
      }, required: ['repo', 'base', 'path', 'content', 'title'] } },
    run: async (a) => text(JSON.stringify(await openFileUpdatePR({ ...a, client: clientIdentity }))),
  },
};

// ---- minimal MCP stdio JSON-RPC loop --------------------------------------
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyErr(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

// A denial is still traffic. Record what was attempted and why it was refused before responding,
// while keeping the same bounded/non-sensitive argument summary as successful calls.
function auditDenied(method, params, error) {
  try {
    const tool = method === 'tools/call' ? String(params && params.name || 'tools/call') : String(method || '(none)');
    const args = method === 'tools/call'
      ? summarizeArgs(params && params.arguments)
      : summarizeArgs({ client: params && params.clientInfo && params.clientInfo.name || '(missing)' });
    appendAccess(vault(), {
      at: new Date().toISOString(), tool, mode: isWriteTool(tool) ? 'write' : 'read', args,
      ok: false, ms: 0, by: authenticatedClient?.name || 'unidentified', error,
    });
  } catch { /* denial logging must never open access or crash the boundary */ }
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    const hostClient = normalizeClientIdentity(params && params.clientInfo && params.clientInfo.name);
    // The host must present a credential through protected process configuration. BRAIN_CLIENT must
    // name its owner exactly. The MCP clientInfo value is audited metadata only: Claude Code uses the
    // same software name for multiple separately authenticated operational roles.
    const verified = verifyClient(vault(), presentedCredential(), { scope: null });
    authenticatedClient = verified.ok ? verified.identity : null;
    clientIdentity = authenticatedClient ? authenticatedClient.name : 'unidentified';
    identityVerified = !!authenticatedClient
      && configuredSource !== 'unidentified-client'
      && configuredSource === authenticatedClient.name;
    if (!identityVerified) {
      const error = authenticatedClient
        ? 'Access denied: configured source does not match the credential owner.'
        : 'Access denied: present a valid Chronos client credential.';
      auditDenied(method, params, error);
      return replyErr(id, -32602, `Identify yourself: configure an exact BRAIN_CLIENT and protected credential. ${error}`);
    }
    return reply(id, {
      protocolVersion: (params && params.protocolVersion) || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'seen-brain', version: '0.2.0', authenticatedSource: clientIdentity, hostClient },
    });
  }
  if (!identityVerified && method !== 'notifications/cancelled') {
    const error = 'Access denied: identify yourself before accessing the Chronos brain.';
    auditDenied(method, params, error);
    return replyErr(id, -32001, `Identify yourself: configure an exact BRAIN_CLIENT and protected credential before continuing. ${error}`);
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: Object.values(TOOLS).map((t) => t.def) });
  if (method === 'tools/call') {
    const name = params && params.name;
    const t = TOOLS[name];
    if (!t) {
      const error = `Access denied: unknown tool ${String(name || '(missing)')}.`;
      auditDenied(method, params, error);
      return replyErr(id, -32601, `Unknown tool: ${name}`);
    }
    const args = (params && params.arguments) || {};
    const requiredScope = t.scope || (isWriteTool(name) ? 'write' : 'read');
    const scoped = verifyClient(vault(), presentedCredential(), { scope: requiredScope });
    if (!scoped.ok || !authenticatedClient || scoped.identity.id !== authenticatedClient.id) {
      const error = `Access denied: authenticated client lacks ${requiredScope} permission or its credential is no longer valid.`;
      appendAccess(vault(), { at: new Date().toISOString(), tool: name, mode: t.mode || (isWriteTool(name) ? 'write' : 'read'),
        args: summarizeArgs(args), ok: false, ms: 0, by: authenticatedClient?.name || 'unidentified', error });
      return replyErr(id, -32003, error);
    }
    const started = Date.now();
    // Log the call BEFORE running it, then again with the outcome — so a request that crashes the tool
    // still appears in the panel rather than vanishing. A read leaves no trace in a vault of notes, so
    // without this "what did an AI ask the brain?" is unanswerable. Never allowed to break the call.
    const note = (ok, error) => {
      try {
        appendAccess(vault(), {
          at: new Date().toISOString(), tool: name,
          mode: t.mode || (isWriteTool(name) ? 'write' : 'read'),
          args: summarizeArgs(args), ok, ms: Date.now() - started,
          ...(error ? { error: String(error).slice(0, 200) } : {}),
          by: clientIdentity,
        });
      } catch { /* logging must never break a brain call */ }
    };
    try {
      SOURCES = resolveSources();
      const out = await t.run(args);
      note(true);
      return reply(id, out);
    } catch (e) {
      note(false, e.message);
      return reply(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
    }
  }
  if (id !== undefined) {
    const error = `Access denied: method not found ${String(method || '(missing)')}.`;
    auditDenied(method, params, error);
    replyErr(id, -32601, `Method not found: ${method}`);
  }
}

const defaultMaxRequestLineChars = MAX_ENCODED_CHUNK_CHARS + 64 * 1024;
const configuredMaxRequestLineChars = Number(process.env.CHRONOS_MCP_MAX_LINE_CHARS || defaultMaxRequestLineChars);
const MAX_REQUEST_LINE_CHARS = Number.isSafeInteger(configuredMaxRequestLineChars) && configuredMaxRequestLineChars >= 256
  ? configuredMaxRequestLineChars
  : defaultMaxRequestLineChars;
let buf = '';
let droppingOversizedLine = false;
function denyOversizedLine() {
  const error = `Access denied: MCP request exceeds ${MAX_REQUEST_LINE_CHARS} characters.`;
  try {
    appendAccess(vault(), {
      at: new Date().toISOString(), tool: 'transport/request', mode: 'read',
      args: `requestChars: >${MAX_REQUEST_LINE_CHARS}`, ok: false, ms: 0,
      by: authenticatedClient?.name || 'unidentified', error,
    });
  } catch { /* a transport denial must not crash the boundary */ }
  replyErr(null, -32600, error);
}
function processLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  try { void handle(JSON.parse(trimmed)).catch((e) => process.stderr.write(`[brain] request error: ${e.message}\n`)); }
  catch (e) {
    const error = `Access denied: invalid JSON-RPC request (${e.message}).`;
    auditDenied('transport/parse', { requestChars: trimmed.length }, error);
    process.stderr.write(`[brain] parse error: ${e.message}\n`);
  }
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  let start = 0;
  while (start < chunk.length) {
    const nl = chunk.indexOf('\n', start);
    const end = nl === -1 ? chunk.length : nl;
    const piece = chunk.slice(start, end);
    if (droppingOversizedLine) {
      if (nl !== -1) droppingOversizedLine = false;
    } else if (buf.length + piece.length > MAX_REQUEST_LINE_CHARS) {
      buf = '';
      droppingOversizedLine = nl === -1;
      denyOversizedLine();
    } else {
      buf += piece;
      if (nl !== -1) { processLine(buf); buf = ''; }
    }
    if (nl === -1) break;
    start = nl + 1;
  }
});
process.stderr.write(`[brain] MCP ready — vault ${vault() || '(none)'}, state ${SOURCES.stateFound ? 'found' : 'missing'}\n`);
