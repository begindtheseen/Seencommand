// tickets — trackable failure tickets that live IN the brain.
//
// Brandon, 2026-10-21: "when tasks fail, it doesn't leave it up to me. it creates a trackable ticket for
// it on seen's brain which any AI like codex and claude who communicate with brain can see and decide if
// it's a proper move then it can plan accordingly to build and push improvements."
//
// A ticket is one vault note, `tickets/<id>.md`. Its state is typed facts on that note, subject
// `Ticket <id>`, one predicate per field (status, claimant, plan, pr_url, occurrence, …). Every change is
// written through memory-write's recordFact, so it is bi-temporal: a new status SUPERSEDES the old one
// (the old fact is closed, never edited away), and each fact carries `recorded_at` + `by` + `change`.
// That chain IS the ticket's history — who moved it, when, and why — and it syncs to the cloud brain
// with the rest of the vault (the cloud push mirrors every note's facts). Nothing here keeps state
// anywhere else.
//
// Rules this module enforces, so every caller (the MCP tools any AI uses, the Seen Command routes, the
// automatic failure wiring) gets the same answers:
//   • ONE active ticket per failure fingerprint (kind + repo + the failing thing). A repeat failure adds
//     an occurrence and bumps the count; the same run/build reported twice (from two hooks) counts once.
//   • A ticket whose thing later SUCCEEDS is closed as `resolved` by that success.
//   • Transitions are validated (TRANSITIONS below). Only one claimant at a time, taken atomically
//     under a lock; a claim with no activity for CLAIM_TTL hours expires and can be taken by another AI.
//   • Identity is the caller's AUTHENTICATED principal (the MCP server passes its verified client name).
//     `asOwner` (the owner acting through the local app) may override a claim; nothing else can.
//   • Secrets never land in a ticket: every piece of free text is redacted first.
//   • A ticket about Seen Command ITSELF (a "tool" ticket — the assistant failing a request, the
//     builder/meeting/updater breaking) must say WHAT WOULD HAVE HELPED: a concrete ability or fix.
//     Owner, 2026-10-21: "it can offer ideas for seen command improvements when needed, like if it fails
//     to do something it creates a ticket with what would have helped, but its main priority is
//     seenjobs.io." So tool tickets exist only behind a real failure, carry the ability they lacked, and
//     list AFTER the seenjobs.io tickets.
//
// Pure filesystem + the vault writer; no network. Tests: tickets.test.mjs.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseFrontmatter, normalizeFacts } from './chronos/memoryGraph.mjs';
import { recordFact, ensureNote, appendTimeline } from './memory-write.mjs';
import { withSyncDirectoryLock } from './file-lock.mjs';

export const TICKETS_DIR = 'tickets';
export const STATUSES = ['open', 'claimed', 'planned', 'in_progress', 'pr_open', 'merged', 'resolved', 'wont_fix', 'duplicate'];
export const ACTIVE_STATUSES = new Set(['open', 'claimed', 'planned', 'in_progress', 'pr_open']);
export const TERMINAL_STATUSES = new Set(['merged', 'resolved', 'wont_fix', 'duplicate']);
// A claim in one of these states expires after CLAIM_TTL hours without activity. pr_open does not:
// a PR exists, so the ticket's fate is that PR's.
export const EXPIRING_STATUSES = new Set(['claimed', 'planned', 'in_progress']);
export const KINDS = {
  build_failed: 'Build failed', collector_failed: 'Collector failed', deploy_drift: 'Deploy drift',
  test_red: 'Tests red', data_quality: 'Data quality', pr_blocked: 'PR blocked',
  meeting_failed: 'Board meeting failed', self_update_failed: 'Self-update failed',
  approval_failed: 'Approval failed', assistant_failed: 'Assistant could not do it',
  proof_failed: 'Not proven after merge', other: 'Other',
};
// Kinds that are about Seen Command itself by definition (others are tool tickets when the caller says so).
const TOOL_KINDS = new Set(['assistant_failed']);
export const isToolTicketInput = (f = {}) => !!f.tool || TOOL_KINDS.has(f.kind);

// from → allowed to. 'claimed' is entered only through claimTicket (it needs the atomic check).
const TRANSITIONS = {
  open: ['claimed', 'resolved', 'wont_fix', 'duplicate'],
  claimed: ['planned', 'in_progress', 'pr_open', 'open', 'resolved', 'wont_fix', 'duplicate'],
  planned: ['in_progress', 'pr_open', 'open', 'resolved', 'wont_fix', 'duplicate'],
  in_progress: ['planned', 'pr_open', 'open', 'resolved', 'wont_fix', 'duplicate'],
  pr_open: ['merged', 'in_progress', 'open', 'resolved', 'wont_fix'],
  merged: [],
  resolved: ['open'],
  wont_fix: ['open'],
  duplicate: ['open'],
};
export const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);
export const nextStatuses = (from) => [...(TRANSITIONS[from] || [])];

export function claimTtlHours(env = process.env) {
  const n = Number(env.BRAIN_TICKET_CLAIM_TTL_HOURS);
  return Number.isFinite(n) && n > 0 ? n : 6;
}

const SOURCE = 'brain/lib/tickets.mjs';
const NONE = 'none';
const clip = (v, n) => { const s = String(v == null ? '' : v); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const oneLine = (v, n) => clip(String(v == null ? '' : v).replace(/\s+/g, ' ').trim(), n);
const isoOf = (d) => (d instanceof Date ? d : new Date(d)).toISOString();

// ---- redaction ---------------------------------------------------------------------------------------
// Free text reaches a ticket from build logs, collector stderr and AI-written plans/notes. None of it may
// carry a secret into the brain (which syncs to the cloud). Known token shapes, credential-looking
// key=value pairs, URL userinfo, Authorization headers, and the literal value of any secret-named
// environment variable are all replaced. (Seen Command's side also runs the aggregation store's
// `redact` before calling in; this is the brain-side guarantee for every other caller.)
const TOKEN_SHAPES = /\b(?:sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{12,}|xox[abprs]-[A-Za-z0-9-]{8,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}|chr_[A-Za-z0-9_-]{16,}|sb_(?:secret|publishable)_[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16}|re_[A-Za-z0-9_]{16,}|gsk_[A-Za-z0-9]{16,}|vercel_[A-Za-z0-9]{16,})/g;
const KEY_VALUE = /((?:api[_-]?key|apikey|token|access[_-]?token|refresh[_-]?token|secret|client[_-]?secret|password|passwd|pwd|authorization|private[_-]?key|service[_-]?key)["']?\s*[:=]\s*["']?)([^\s"'&,;}]{4,})/gi;
const AUTH_HEADER = /\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/g;
const URL_USERINFO = /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const SECRET_ENV_NAME = /(TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL|_PAT)$/i;

export function redactSecrets(text, env = process.env) {
  let out = String(text == null ? '' : text);
  for (const [k, v] of Object.entries(env || {})) {
    const val = String(v || '').trim();
    if (SECRET_ENV_NAME.test(k) && val.length >= 8) out = out.split(val).join('[redacted]');
  }
  out = out.replace(URL_USERINFO, '$1[redacted]@')
    .replace(AUTH_HEADER, (m, scheme) => `${scheme} [redacted]`)
    .replace(KEY_VALUE, '$1[redacted]')
    .replace(TOKEN_SHAPES, '[redacted]');
  const home = env && env.HOME;
  if (home && home.length > 1) out = out.split(home).join('~');
  return out;
}
const safe = (v, n) => clip(redactSecrets(v), n);
const safeLine = (v, n) => oneLine(redactSecrets(v), n);

// ---- identity of a failure ---------------------------------------------------------------------------
export function fingerprintOf({ kind, repo, thing } = {}) {
  const k = KINDS[kind] ? kind : 'other';
  const r = String(repo || '-').trim().toLowerCase();
  const t = String(thing || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!t) throw new Error('a ticket needs the failing `thing` (a build key, a collector, a branch …)');
  return `${k}|${r}|${t}`;
}
const baseIdFor = (fp) => `tkt-${createHash('sha256').update(fp).digest('hex').slice(0, 10)}`;
export const isTicketId = (id) => /^tkt-[0-9a-f]{10}(?:-r\d{1,3})?$/.test(String(id || ''));
const notePathFor = (id) => `${TICKETS_DIR}/${id}.md`;
const subjectFor = (id) => `Ticket ${id}`;
const lockFor = (vault, id) => join(vault, TICKETS_DIR, `.${id}.lock`);
const createLock = (vault) => join(vault, TICKETS_DIR, '.create.lock');
function needVault(vault) { if (!vault) throw new Error('no brain vault (set CHRONOS_VAULT)'); }

// ---- reading -----------------------------------------------------------------------------------------
function readTicketText(vault, id) {
  if (!isTicketId(id)) return null;
  const abs = join(vault, notePathFor(id));
  return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
}
const parseJSON = (s) => { try { return JSON.parse(s); } catch { return null; } };
const HISTORY_FIELDS = ['status', 'claimant', 'plan', 'pr_url', 'pr_state', 'note', 'duplicate_of', 'requested', 'build_id', 'blocked', 'resolution', 'merge', 'regression_of', 'helped'];

// Turn a ticket note into the ticket object every caller reads.
export function parseTicket(text, note, { now = new Date(), ttlHours = claimTtlHours() } = {}) {
  const facts = normalizeFacts(parseFrontmatter(text).data, note).facts.map((f, i) => ({ ...f, _i: i }));
  const openOf = (p) => { let hit = null; for (const f of facts) if (f.predicate === p && f.valid_to == null) hit = f; return hit; };
  const val = (p, d = null) => { const f = openOf(p); return f && f.object != null ? String(f.object) : d; };
  const id = String(note).replace(/^.*\//, '').replace(/\.md$/, '');
  const occurrences = facts.filter((f) => f.predicate === 'occurrence')
    .map((f) => ({ ...(parseJSON(String(f.object)) || { error: String(f.object) }), recordedAt: f.recorded_at, by: f.by || null }))
    .sort((a, b) => (a.n || 0) - (b.n || 0));
  const latest = occurrences[occurrences.length - 1] || null;
  const status = val('status', 'open');
  const claimant = val('claimant', NONE);
  const heartbeat = val('heartbeat');
  const claimed = claimant !== NONE && (EXPIRING_STATUSES.has(status) || status === 'pr_open');
  const expiresAt = claimed && EXPIRING_STATUSES.has(status) && heartbeat
    ? new Date(Date.parse(heartbeat) + ttlHours * 3600e3).toISOString() : null;
  // One event per write operation: the facts one call wrote share its `by` + `change` and land within
  // moments of each other, so they read as one step ("open → claimed by codex"), not five rows.
  const history = [];
  for (const f of facts.filter((x) => HISTORY_FIELDS.includes(x.predicate))
    .sort((a, b) => String(a.recorded_at || '').localeCompare(String(b.recorded_at || '')) || a._i - b._i)) {
    const prev = history[history.length - 1];
    const at = f.recorded_at || null;
    if (prev && prev.by === (f.by || null) && prev.change === (f.change || null) && Math.abs(Date.parse(at) - Date.parse(prev.at)) < 5000) {
      prev.fields[f.predicate] = String(f.object);
    } else {
      history.push({ at, by: f.by || null, change: f.change || null, fields: { [f.predicate]: String(f.object) } });
    }
  }
  const updatedAt = facts.reduce((m, f) => (String(f.recorded_at || '') > m ? String(f.recorded_at) : m), '');
  return {
    id, note, subject: subjectFor(id),
    title: val('title', id), kind: val('kind', 'other'), kindLabel: KINDS[val('kind', 'other')] || 'Other',
    repo: val('repo') === '-' ? null : val('repo'), thing: val('thing'), fingerprint: val('fingerprint'),
    source: val('source'), blocked: val('blocked') === 'yes',
    tool: val('tool') === 'yes', helped: val('helped', NONE) === NONE ? null : val('helped'),
    status, active: ACTIVE_STATUSES.has(status), terminal: TERMINAL_STATUSES.has(status),
    claimant: claimant === NONE ? null : claimant, claimedAt: claimant === NONE ? null : val('claimed_at'),
    heartbeat, claimExpiresAt: expiresAt,
    claimExpired: !!(expiresAt && Date.parse(expiresAt) <= now.getTime()),
    plan: val('plan'), prUrl: val('pr_url'), prState: val('pr_state'),
    note: val('note'), duplicateOf: val('duplicate_of'), regressionOf: val('regression_of'),
    requested: val('requested', NONE) === NONE ? null : val('requested', NONE), buildId: val('build_id', NONE) === NONE ? null : val('build_id'),
    resolution: val('resolution'), merge: parseJSON(val('merge', 'null')),
    count: latest ? latest.n || occurrences.length : 0,
    firstSeen: val('first_seen') || (occurrences[0] && occurrences[0].at) || null,
    lastSeen: latest ? latest.at || latest.recordedAt : null,
    evidence: latest, occurrences, history, updatedAt: updatedAt || null,
    nextStatuses: nextStatuses(status),
  };
}

export function getTicket(vault, id, opts = {}) {
  if (!vault) return null;
  const text = readTicketText(vault, id);
  return text == null ? null : parseTicket(text, notePathFor(id), opts);
}

function allTickets(vault, opts = {}) {
  if (!vault) return [];
  const dir = join(vault, TICKETS_DIR);
  let names = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith('.md') && isTicketId(n.slice(0, -3))); } catch { return []; }
  const out = [];
  for (const n of names) {
    try { out.push(parseTicket(readFileSync(join(dir, n), 'utf8'), `${TICKETS_DIR}/${n}`, opts)); } catch { /* one bad note never hides the rest */ }
  }
  return out;
}

// The list row: everything a picker needs, no history.
export const summarizeTicket = (t) => ({
  id: t.id, title: t.title, kind: t.kind, kindLabel: t.kindLabel, repo: t.repo, status: t.status, blocked: t.blocked,
  tool: t.tool, helped: t.helped ? oneLine(t.helped, 240) : null,
  claimant: t.claimant, claimedAt: t.claimedAt, claimExpiresAt: t.claimExpiresAt, claimExpired: t.claimExpired,
  count: t.count, firstSeen: t.firstSeen, lastSeen: t.lastSeen, updatedAt: t.updatedAt,
  lastError: t.evidence ? oneLine(t.evidence.error, 240) : null, prUrl: t.prUrl, prState: t.prState,
  requested: t.requested, buildId: t.buildId && t.buildId !== NONE ? t.buildId : null, duplicateOf: t.duplicateOf, plan: t.plan ? oneLine(t.plan, 160) : null,
});

const wantList = (v) => (v == null || v === '' ? null : String(v).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
// filters: status ('active' = every non-terminal state, 'all', or a comma list), repo, kind, limit.
export function listTickets(vault, { status = 'active', repo = null, kind = null, limit = 100 } = {}, opts = {}) {
  const st = wantList(status) || ['active'];
  const rp = wantList(repo); const kd = wantList(kind);
  const rows = allTickets(vault, opts).filter((t) => {
    if (!st.includes('all') && !(st.includes('active') && t.active) && !st.includes(t.status)) return false;
    if (rp && !rp.includes(String(t.repo || '').toLowerCase())) return false;
    if (kd && !kd.includes(t.kind)) return false;
    return true;
  });
  // Ready-for-AI first, then seenjobs.io work before Seen Command's own (the product is the priority),
  // then the newest activity.
  rows.sort((a, b) => (Number(b.requested === 'ai') - Number(a.requested === 'ai'))
    || (Number(a.tool) - Number(b.tool))
    || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return rows.slice(0, Math.max(1, Math.min(500, Number(limit) || 100))).map(summarizeTicket);
}

// What the Home screen and the chat need: counts, and ONLY the tickets that are the owner's move — a
// failure blocked on something only Brandon can clear, or a PR whose checks are green and waiting for a
// merge. Everything an AI can pick up stays off Home on purpose.
export function ticketsSummary(vault, opts = {}) {
  const all = allTickets(vault, opts);
  const active = all.filter((t) => t.active);
  const byStatus = {};
  for (const t of all) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  const needsOwner = [];
  for (const t of active) {
    if (t.status === 'pr_open' && t.prState === 'ready') needsOwner.push({ id: t.id, title: t.title, why: 'merge_ready', prUrl: t.prUrl, body: `PR ready to merge — ${t.prUrl}` });
    else if (t.blocked) needsOwner.push({ id: t.id, title: t.title, why: 'blocked', body: t.evidence ? oneLine(t.evidence.error, 200) : 'blocked on the owner' });
  }
  return {
    vault: !!vault, active: active.length, byStatus, needsOwner,
    readyForAI: active.filter((t) => t.requested === 'ai' && !t.claimant).length,
    claimed: active.filter((t) => t.claimant).length,
    unclaimed: active.filter((t) => !t.claimant && !t.blocked).length,
  };
}

// ---- writing -----------------------------------------------------------------------------------------
function openFactsOf(vault, note) {
  const abs = join(vault, note);
  if (!existsSync(abs)) return [];
  return normalizeFacts(parseFrontmatter(readFileSync(abs, 'utf8')).data, note).facts.filter((f) => f.valid_to == null);
}
// Write field values in order through the vault writer (add / supersede / no-op per field).
function writeFields(vault, id, pairs, { by, change }) {
  const note = notePathFor(id);
  const written = [];
  for (const [predicate, value] of pairs) {
    if (value === undefined) continue;
    const r = recordFact(vault, note, {
      subject: subjectFor(id), predicate, object: value == null ? NONE : String(value),
      confidence: 'high', source: SOURCE, change: change ? safeLine(change, 300) : null, by: by || null,
    }, openFactsOf(vault, note));
    if (r.written) written.push(predicate);
  }
  return written;
}
function narrate(vault, t, text, at) {
  try {
    appendTimeline(vault, { heading: 'Tickets', key: `ticket:${t.id}:${at}`,
      text: `${t.id} · ${oneLine(t.title, 90)} — ${oneLine(text, 220)} (ticket:${t.id}:${at})` });
  } catch { /* the facts are the record; the episode is narration */ }
}

const occurrenceValue = ({ n, at, ref, error, log, links, source }) => JSON.stringify({
  n, at, ref: ref ? safeLine(ref, 120) : null, error: safe(error, 1500),
  log: log ? safe(Array.isArray(log) ? log.join('\n') : log, 2500) : null,
  links: (Array.isArray(links) ? links : []).filter((l) => /^https?:\/\//.test(String(l))).slice(0, 6).map((l) => safeLine(l, 300)),
  source: source ? safeLine(source, 120) : null,
});

function createTicket(vault, id, fp, f, { regressionOf = null } = {}) {
  const title = safeLine(f.title || `${KINDS[f.kind] || 'Failure'}: ${f.thing}`, 160);
  ensureNote(vault, { note: notePathFor(id), title: `Ticket ${id} — ${title}`, tags: ['ticket'], type: 'ticket',
    body: 'A Seen Command failure ticket. Its state is the typed facts above: every change supersedes, never overwrites, so the closed facts are its history (who, when, why).\n\n'
      + 'Pick it up through the brain MCP: `brain_get_ticket` → judge if fixing it is the right move → `brain_claim_ticket` → `brain_update_ticket` with your plan, then the PR url.' });
  const by = f.by || 'seen-command';
  writeFields(vault, id, [
    ['title', title], ['kind', KINDS[f.kind] ? f.kind : 'other'], ['repo', f.repo || '-'], ['thing', safeLine(f.thing, 200)],
    ['fingerprint', fp], ['source', f.source ? safeLine(f.source, 120) : 'unknown'], ['first_seen', f.at],
    ['blocked', f.blocked ? 'yes' : 'no'], ['tool', isToolTicketInput(f) ? 'yes' : 'no'],
    ...(f.helped ? [['helped', safe(f.helped, 1200)]] : []),
    ['status', 'open'], ['claimant', NONE],
    ...(regressionOf ? [['regression_of', regressionOf]] : []),
    ['occurrence', occurrenceValue({ ...f, n: 1 })],
  ], { by, change: regressionOf ? `failed again after ${regressionOf} closed — new ticket` : `${by === 'seen-command' ? 'opened automatically' : `opened by ${oneLine(by, 60)}`}: ${oneLine(f.error, 160)}` });
  return getTicket(vault, id);
}

// A failure happened. Open a ticket for it, or add an occurrence to the one already tracking it.
// f: { kind, repo, thing, title, error, helped?, tool?, log?, ref?, links?, source?, blocked?, at?, by? }
// `helped` = what would have helped (a concrete ability or fix). Required for a tool ticket.
export function reportFailure(vault, input = {}) {
  needVault(vault);
  if (!input.error) throw new Error('a failure needs its `error` text');
  if (isToolTicketInput(input) && !String(input.helped || '').trim()) {
    throw new Error('a ticket about Seen Command itself needs `helped`: the concrete ability or fix that would have let it succeed');
  }
  const f = { ...input, at: input.at ? isoOf(input.at) : new Date().toISOString(), kind: KINDS[input.kind] ? input.kind : 'other' };
  const fp = fingerprintOf(f);
  const base = baseIdFor(fp);
  return withSyncDirectoryLock(createLock(vault), () => {
    const family = allTickets(vault).filter((t) => t.fingerprint === fp).sort((a, b) => String(a.firstSeen).localeCompare(String(b.firstSeen)));
    const live = family.find((t) => t.active) || family.find((t) => t.status === 'wont_fix' || t.status === 'duplicate');
    if (!live) {
      const prev = family[family.length - 1];
      const id = prev ? `${base}-r${family.length}` : base;
      const t = createTicket(vault, id, fp, f, { regressionOf: prev ? prev.id : null });
      return { ok: true, action: prev ? 'regression' : 'created', ticket: t };
    }
    // The same run/build reported by two hooks is one occurrence, not two.
    if (f.ref && live.occurrences.some((o) => o.ref && o.ref === safeLine(f.ref, 120))) return { ok: true, action: 'seen', ticket: live };
    return withSyncDirectoryLock(lockFor(vault, live.id), () => {
      const cur = getTicket(vault, live.id);
      const n = (cur.count || cur.occurrences.length || 0) + 1;
      writeFields(vault, cur.id, [
        ['occurrence', occurrenceValue({ ...f, n })],
        ...(!!f.blocked !== cur.blocked ? [['blocked', f.blocked ? 'yes' : 'no']] : []),
        // A sharper "what would have helped" from the newest failure supersedes the old one (history kept).
        ...(f.helped && safe(f.helped, 1200) !== cur.helped ? [['helped', safe(f.helped, 1200)]] : []),
      ], { by: f.by || 'seen-command', change: `failed again (×${n})${cur.terminal ? ` — kept as ${cur.status}` : ''}: ${oneLine(f.error, 140)}` });
      return { ok: true, action: 'occurrence', ticket: getTicket(vault, cur.id) };
    });
  });
}

// The failing thing worked. Close its active ticket as resolved by that success. A ticket with an open
// PR is not closed under the PR's author — it gets a note, and the PR decides.
export function resolveBySuccess(vault, { kind, repo, thing, ref = null, how = null, by = 'seen-command', at = new Date() } = {}) {
  if (!vault) return { ok: false, action: 'none', error: 'no brain vault' };
  const fp = fingerprintOf({ kind, repo, thing });
  const live = allTickets(vault).find((t) => t.fingerprint === fp && t.active);
  if (!live) return { ok: true, action: 'none' };
  return withSyncDirectoryLock(lockFor(vault, live.id), () => {
    const t = getTicket(vault, live.id);
    if (!t.active) return { ok: true, action: 'none' };
    const why = safeLine(how || `${t.thing} succeeded${ref ? ` (${ref})` : ''}`, 300);
    if (t.status === 'pr_open') {
      writeFields(vault, t.id, [['note', `Resolved by success while the PR was open: ${why}`]], { by, change: 'the failing thing succeeded on its own' });
      return { ok: true, action: 'noted', ticket: getTicket(vault, t.id) };
    }
    const stamp = isoOf(at);
    writeFields(vault, t.id, [['resolution', `resolved by success — ${why}`], ['status', 'resolved']], { by, change: `${t.status} → resolved by success: ${why}` });
    narrate(vault, t, `resolved by success: ${why}`, stamp);
    return { ok: true, action: 'resolved', ticket: getTicket(vault, t.id) };
  });
}

const principal = (by) => {
  const s = String(by || '').trim();
  if (!s || s === 'unidentified' || s === 'unidentified-client') throw new Error('an authenticated principal is required');
  return oneLine(s, 80);
};

// Take a ticket. Atomic under the ticket's lock: of two AIs claiming at once, exactly one wins.
export function claimTicket(vault, { id, by, now = new Date(), ttlHours = claimTtlHours() } = {}) {
  needVault(vault);
  const who = principal(by);
  if (!getTicket(vault, id)) return { ok: false, code: 404, error: `no ticket ${id}` };
  return withSyncDirectoryLock(lockFor(vault, id), () => {
    const t = getTicket(vault, id, { now, ttlHours });
    const stamp = isoOf(now);
    if (t.terminal) return { ok: false, code: 409, error: `ticket ${id} is ${t.status} — reopen it before claiming`, ticket: t };
    if (t.claimant === who) {
      writeFields(vault, id, [['heartbeat', stamp]], { by: who, change: 'claim refreshed' });
      return { ok: true, already: true, ticket: getTicket(vault, id, { now, ttlHours }) };
    }
    if (t.status === 'pr_open') return { ok: false, code: 409, error: `ticket ${id} already has a PR open (${t.prUrl}) by ${t.claimant || 'someone'} — leave a note or ask the owner`, ticket: t };
    let expiredFrom = null;
    if (t.claimant && EXPIRING_STATUSES.has(t.status)) {
      if (!t.claimExpired) return { ok: false, code: 409, error: `ticket ${id} is claimed by ${t.claimant} until ${t.claimExpiresAt} — leave a note instead`, ticket: t };
      expiredFrom = t.claimant;
    }
    writeFields(vault, id, [['claimant', who], ['claimed_at', stamp], ['heartbeat', stamp], ['status', 'claimed']], {
      by: who, change: expiredFrom ? `claim by ${expiredFrom} expired after ${ttlHours} h of no activity — claimed by ${who}` : `${t.status} → claimed by ${who}`,
    });
    const after = getTicket(vault, id, { now, ttlHours });
    narrate(vault, after, `claimed by ${who}${expiredFrom ? ` (${expiredFrom}'s claim expired)` : ''}`, stamp);
    return { ok: true, ticket: after, expiredFrom };
  });
}

const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;

// Change a ticket: status, plan, PR url, a note, duplicate-of, and (system/owner) bookkeeping fields.
// Validated: the transition must be allowed; a claimed ticket is changed only by its claimant (or the
// owner); in-progress states need a claim; pr_open/merged need a PR url; duplicate needs its target.
export function updateTicket(vault, {
  id, by, status, plan, prUrl, note, duplicateOf, prState, requested, buildId, resolution, merge, blocked, helped,
} = {}, { asOwner = false, now = new Date(), ttlHours = claimTtlHours() } = {}) {
  needVault(vault);
  const who = principal(by);
  if (!getTicket(vault, id)) return { ok: false, code: 404, error: `no ticket ${id}` };
  return withSyncDirectoryLock(lockFor(vault, id), () => {
    const t = getTicket(vault, id, { now, ttlHours });
    const stamp = isoOf(now);
    const fail = (error, code = 409) => ({ ok: false, code, error, ticket: t });
    const holdsClaim = t.claimant && t.claimant === who;
    const liveClaim = t.claimant && !t.claimExpired && (EXPIRING_STATUSES.has(t.status) || t.status === 'pr_open');
    const changesWork = status !== undefined || plan !== undefined || prUrl !== undefined || duplicateOf !== undefined || helped !== undefined;
    if (liveClaim && !holdsClaim && !asOwner && changesWork) return fail(`ticket ${id} is claimed by ${t.claimant} — only they (or the owner) can change it; add a note instead`);
    if (prUrl !== undefined && prUrl !== null && !PR_URL.test(String(prUrl))) return fail('pr_url must look like https://github.com/<owner>/<repo>/pull/<n>', 400);

    // The status this update moves to. A plan on a fresh claim means "planned"; a PR url on work in
    // flight means "pr_open". Explicit status always wins.
    let to = status === undefined || status === null || status === '' ? null : String(status);
    if (!to && prUrl && EXPIRING_STATUSES.has(t.status)) to = 'pr_open';
    if (!to && plan && t.status === 'claimed') to = 'planned';
    if (to && !STATUSES.includes(to)) return fail(`unknown status ${to} — one of ${STATUSES.join(', ')}`, 400);
    if (to === t.status) to = null;
    if (to === 'claimed') return fail('use brain_claim_ticket to claim a ticket', 400);
    if (to && !canTransition(t.status, to)) return fail(`cannot move ${t.status} → ${to}; allowed: ${nextStatuses(t.status).join(', ') || 'none (final)'}`);
    const needsClaim = ['planned', 'in_progress', 'pr_open', 'merged'].includes(to) || plan !== undefined || (prUrl !== undefined && prUrl !== null);
    if (needsClaim && !asOwner && !holdsClaim) return fail(`claim ticket ${id} first (brain_claim_ticket) before planning or building it`);
    const pr = prUrl || t.prUrl;
    if ((to === 'pr_open' || to === 'merged') && !pr) return fail(`${to} needs the PR url`, 400);
    let dup = undefined;
    if (to === 'duplicate' || duplicateOf !== undefined) {
      dup = String(duplicateOf || '').trim();
      if (!isTicketId(dup) || dup === id) return fail('duplicate_of must be another ticket id (tkt-…)', 400);
      const target = getTicket(vault, dup);
      if (!target) return fail(`no ticket ${dup} to be a duplicate of`, 404);
      if (to !== 'duplicate' && t.status !== 'duplicate') { if (!canTransition(t.status, 'duplicate')) return fail(`cannot mark a ${t.status} ticket duplicate`); to = 'duplicate'; }
    }

    const pairs = [];
    if (plan !== undefined) pairs.push(['plan', safe(plan, 4000)]);
    if (prUrl !== undefined && prUrl !== null) pairs.push(['pr_url', String(prUrl)]);
    if (prState !== undefined) pairs.push(['pr_state', safeLine(prState, 40)]);
    if (dup !== undefined) pairs.push(['duplicate_of', dup]);
    if (requested !== undefined) pairs.push(['requested', requested ? safeLine(requested, 40) : NONE]);
    if (buildId !== undefined) pairs.push(['build_id', buildId ? safeLine(buildId, 120) : NONE]);
    if (resolution !== undefined) pairs.push(['resolution', safe(resolution, 600)]);
    if (merge !== undefined) pairs.push(['merge', JSON.stringify(merge).slice(0, 1500)]);
    if (blocked !== undefined) pairs.push(['blocked', blocked ? 'yes' : 'no']);
    if (helped !== undefined) {
      if (!String(helped || '').trim() && t.tool) return fail('a Seen Command ticket keeps its "what would have helped" — rewrite it, do not clear it', 400);
      pairs.push(['helped', String(helped || '').trim() ? safe(helped, 1200) : NONE]);
    }
    if (note !== undefined && note !== null && String(note).trim()) pairs.push(['note', safe(note, 2000)]);
    if (to) {
      pairs.push(['status', to]);
      if (to === 'open') pairs.push(['claimant', NONE]);
    }
    if (holdsClaim && !TERMINAL_STATUSES.has(to || t.status)) pairs.push(['heartbeat', stamp]);
    if (!pairs.length) return fail('nothing to change', 400);
    const change = to ? `${t.status} → ${to} by ${who}${note ? `: ${oneLine(redactSecrets(note), 140)}` : ''}`
      : `${pairs.map((p) => p[0]).filter((p) => p !== 'heartbeat').join(', ')} updated by ${who}`;
    const changed = writeFields(vault, id, pairs, { by: who, change });
    const after = getTicket(vault, id, { now, ttlHours });
    if (to) narrate(vault, after, `${t.status} → ${to} by ${who}${to === 'pr_open' || to === 'merged' ? ` — ${pr}` : ''}`, stamp);
    return { ok: true, ticket: after, changed, from: t.status, to: to || t.status };
  });
}

// Plain-text rendering for the MCP tools (any AI reads this).
const ptTime = (iso) => { if (!iso) return '—'; const d = new Date(iso); return Number.isNaN(d.getTime()) ? String(iso) : `${d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })} PT`; };
export function ticketLine(t) {
  const who = t.claimant ? ` · claimed by ${t.claimant}${t.claimExpired ? ' (claim expired)' : ''}` : '';
  return `• ${t.id} [${t.status}${t.blocked ? ', BLOCKED ON OWNER' : ''}${t.requested === 'ai' ? ', ready for AI' : ''}${t.tool ? ', Seen Command itself' : ''}] ${t.kind} · ${t.repo || 'no repo'} · ×${t.count || 1}${who} · last ${ptTime(t.lastSeen)}\n    ${t.title}${t.lastError ? `\n    error: ${t.lastError}` : ''}${t.helped ? `\n    would have helped: ${t.helped}` : ''}${t.prUrl ? `\n    PR: ${t.prUrl}` : ''}`;
}
export function ticketText(t) {
  const ev = t.evidence || {};
  const lines = [
    `# ${t.id} — ${t.title}`,
    `status: ${t.status}${t.terminal ? ' (final)' : ''} · kind: ${t.kind} · repo: ${t.repo || '—'} · occurrences: ${t.count} · first ${ptTime(t.firstSeen)} · last ${ptTime(t.lastSeen)}`,
    `blocked on owner: ${t.blocked ? 'YES — retrying cannot fix this; say what the owner must clear' : 'no'}`,
    t.tool ? 'about: Seen Command itself (seenjobs.io work comes first)' : null,
    t.helped ? `what would have helped: ${t.helped}` : null,
    `claimant: ${t.claimant ? `${t.claimant} since ${ptTime(t.claimedAt)}${t.claimExpiresAt ? `, expires ${ptTime(t.claimExpiresAt)}${t.claimExpired ? ' (EXPIRED — claimable)' : ''}` : ''}` : 'nobody'}`,
    `next allowed: ${t.nextStatuses.join(', ') || 'none'}`,
    t.requested ? `requested: ${t.requested === 'ai' ? 'the owner asked an AI to fix this' : t.requested}` : null,
    t.plan ? `\n## Plan\n${t.plan}` : null,
    t.prUrl ? `\nPR: ${t.prUrl}${t.prState ? ` (${t.prState})` : ''}` : null,
    t.duplicateOf ? `duplicate of: ${t.duplicateOf}` : null,
    t.regressionOf ? `regression of: ${t.regressionOf}` : null,
    t.resolution ? `resolution: ${t.resolution}` : null,
    `\n## Latest evidence (occurrence ${ev.n || '—'}, ${ptTime(ev.at)})`,
    ev.error ? `error: ${ev.error}` : '(none)',
    ev.ref ? `ref: ${ev.ref}` : null,
    ev.source ? `source: ${ev.source}` : null,
    (ev.links || []).length ? `links: ${ev.links.join(' · ')}` : null,
    ev.log ? `log excerpt:\n${ev.log}` : null,
    t.occurrences.length > 1 ? `\n## Earlier occurrences\n${t.occurrences.slice(0, -1).slice(-5).map((o) => `- #${o.n} ${ptTime(o.at)}${o.ref ? ` (${o.ref})` : ''}: ${oneLine(o.error, 200)}`).join('\n')}` : null,
    `\n## History\n${t.history.map((h) => `- ${ptTime(h.at)}${h.by ? ` · ${h.by}` : ''} — ${oneLine(h.change || Object.keys(h.fields).join(', '), 200)}${h.fields.status ? ` [status ${h.fields.status}]` : ''}`).join('\n') || '(none)'}`,
  ];
  return lines.filter((l) => l != null).join('\n');
}
