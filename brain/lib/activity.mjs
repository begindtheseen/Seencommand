// Brain activity — what changed, and what was asked.
//
// Two feeds, for the Chronos "Brain activity" panel:
//
//   CHANGES  — every fact write, newest first, derived straight from the vault. Each fact already
//              carries its own provenance (`recorded_at`, `by`, `change`, `supersedes`), so any AI
//              client writing through the shared writer shows up with its actual client identity.
//
//   REQUESTS — what was READ out of the brain. Nothing recorded this before: a read leaves no trace in
//              a vault of notes, so "what did an AI ask the brain?" was unanswerable. The MCP server
//              now appends one line per tool call to an append-only log.
//
// The log lives at `<vault>/.access/requests.jsonl`, which is deliberately INSIDE the vault so every
// process that resolves the vault (a Claude session's MCP server, Chronos.app, the CLI) agrees on where
// it is without new configuration — and is doubly safe from becoming brain content, because walkVault
// skips dot-directories AND only collects `.md`. It can never be parsed as a note or pushed to Supabase.
// It is per-machine runtime evidence, not shared memory.

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { withSyncDirectoryLock } from './file-lock.mjs';

export const ACCESS_LOG_REL = '.access/requests.jsonl';
export const accessLogPath = (vaultPath) => join(String(vaultPath || ''), '.access', 'requests.jsonl');

// Tools that MUTATE the brain. Everything else is a read. Kept here rather than in the MCP server so
// the panel and the logger cannot drift apart on what counts as a write.
const WRITE_TOOLS = new Set([
  'brain_add_fact', 'brain_supersede_fact', 'brain_log_decision', 'brain_append_timeline',
  'brain_artifact_begin_upload', 'brain_artifact_upload_chunk', 'brain_artifact_finish_upload',
  'brain_github_open_file_pr', 'brain_claim_ticket', 'brain_update_ticket',
]);
export const isWriteTool = (tool) => WRITE_TOOLS.has(String(tool));

// Preserve a registered security principal exactly (after bounded sanitisation). Unlike
// normalizeClientIdentity, this must not collapse role-qualified principals such as
// `claude-brain` and `claude-seenjobs` into one provider label.
export function normalizeRegisteredSource(name, fallback = 'unidentified-client') {
  const source = String(name || '').trim().toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return source || fallback;
}

// Turn MCP's standard initialize.clientInfo.name into the stable source label Chronos renders.
// Known clients collapse to a human-readable provider name; unknown clients keep a bounded,
// sanitised identity instead of being falsely attributed to Claude.
export function normalizeClientIdentity(name, fallback = 'unidentified-client') {
  const raw = String(name || '').trim();
  if (!raw) return fallback;
  const lower = raw.toLowerCase();
  if (lower.includes('codex')) return 'codex';
  if (lower.includes('claude') || lower.includes('anthropic')) return 'claude';
  if (lower.includes('seen command') || lower.includes('seen-command') || lower === 'board-room') return 'seen-command';
  return lower.replace(/[^a-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || fallback;
}

// Keep the log bounded so it can never grow without limit on a long-lived machine. Trimming keeps the
// NEWEST lines, since this is a recency feed.
const MAX_LOG_LINES = 5000;

// One-line summary of a call's arguments: enough to recognise the request, never a wall of text.
export function summarizeArgs(args) {
  if (!args || typeof args !== 'object') return '';
  const parts = [];
  for (const [k, v] of Object.entries(args)) {
    if (v == null || v === '') continue;
    if (/token|secret|credential|password/i.test(k)) { parts.push(`${k}: [redacted]`); continue; }
    if (/^(data|content|body|text)$/i.test(k)) { parts.push(`${k}: [${String(v).length} chars]`); continue; }
    const s = String(v).replace(/\s+/g, ' ').trim();
    parts.push(`${k}: ${s.length > 80 ? `${s.slice(0, 80)}…` : s}`);
    if (parts.length >= 4) break;
  }
  return parts.join(' · ');
}

// Append one request. NEVER throws — a logging failure must not break a brain call.
export function appendAccess(vaultPath, entry) {
  try {
    if (!vaultPath) return false;
    const p = accessLogPath(vaultPath);
    withSyncDirectoryLock(join(dirname(p), 'requests.lock'), () => {
      mkdirSync(dirname(p), { recursive: true });
      appendFileSync(p, `${JSON.stringify(entry)}\n`);
      // Cheap amortised trim. Append and replacement share one lock so a concurrent denial cannot
      // land after this read and then disappear under the bounded snapshot write.
      try {
        const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean);
        if (lines.length > MAX_LOG_LINES * 1.2) {
          writeFileSync(p, `${lines.slice(-MAX_LOG_LINES).join('\n')}\n`);
        }
      } catch { /* trim is best-effort */ }
    });
    return true;
  } catch { return false; }
}

// Read the request log, newest first. [] when absent — a fresh machine simply has no requests yet.
export function readAccess(vaultPath, { limit = 0 } = {}) {
  try {
    const p = accessLogPath(vaultPath);
    if (!existsSync(p)) return [];
    const rows = [];
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* skip a torn line */ }
    }
    rows.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    return limit > 0 ? rows.slice(0, limit) : rows;
  } catch { return []; }
}

// When a fact write happened. `recorded_at` is the precise transaction time; older facts predate it and
// only carry a `recorded` date, and the very oldest only have `valid_from`. Fall through in that order
// so nothing sorts to the bottom just for being written before provenance existed.
const whenOf = (f) => String(f.recorded_at || f.recorded || f.valid_from || '');

// PURE: turn vault facts into a newest-first change feed. `added` vs `changed` is decided by whether the
// fact supersedes an earlier value; `retired` marks a fact that is no longer current, so the panel can
// show history without implying it is still true.
export function buildChanges(facts, { limit = 0 } = {}) {
  const rows = (Array.isArray(facts) ? facts : []).map((f) => ({
    at: whenOf(f),
    kind: f.supersedes ? 'changed' : 'added',
    retired: f.valid_to != null,
    by: f.by || null,
    subject: f.subject ?? '',
    predicate: f.predicate ?? '',
    object: String(f.object ?? ''),
    note: f.note || null,
    change: f.change || null,
    source: f.source || null,
    id: f.id || null,
    valid_from: f.valid_from || null,
    valid_to: f.valid_to || null,
  })).filter((r) => r.at);
  rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return limit > 0 ? rows.slice(0, limit) : rows;
}

// Group a feed by calendar day, newest day first — what the panel renders under date headers.
export function groupByDay(rows) {
  const days = new Map();
  for (const r of rows) {
    const d = String(r.at || '').slice(0, 10) || 'unknown';
    if (!days.has(d)) days.set(d, []);
    days.get(d).push(r);
  }
  return [...days.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([day, items]) => ({ day, items }));
}

// Everything the panel needs in one call. `facts` is injected by the caller (Chronos already holds a
// vault index), so this module never reads the vault itself and stays trivially testable.
export function buildActivity({ facts = [], vaultPath = null, recentLimit = 30, allLimit = 1500, requestLimit = 300 } = {}) {
  const all = buildChanges(facts, { limit: allLimit });
  const requests = vaultPath ? readAccess(vaultPath, { limit: requestLimit }) : [];
  const writes = requests.filter((r) => isWriteTool(r.tool)).length;
  const active = vaultPath ? activeSessions(vaultPath) : [];
  return {
    recent: all.slice(0, recentLimit),
    all,
    requests,
    // Live presence: which Claude sessions are working right now, across BOTH repos. This is the
    // cross-session visibility that stops two sessions shipping contradictory plans blind.
    sessions: active,
    counts: {
      changes: all.length,
      requests: requests.length,
      requestWrites: writes,
      requestReads: requests.length - writes,
      activeSessions: active.length,
      byAuthor: all.reduce((m, r) => { const k = r.by || 'unattributed'; m[k] = (m[k] || 0) + 1; return m; }, {}),
    },
    newestChangeAt: all.length ? all[0].at : null,
    newestRequestAt: requests.length ? requests[0].at : null,
  };
}

// ---------------------------------------------------------------------------
// Session registry — who is working RIGHT NOW, across every session type
//
// The problem this solves: seen-command sessions and seen (product) sessions both push updates to the
// site independently, and neither can see the other — so plans contradict. The vault is the one place
// every session already resolves (via CHRONOS_VAULT / sibling probing), so presence lives beside the
// request log in `.access/` (same dot-dir safety: never a note, never pushed to the cloud).
//
// Events are appended by the SessionStart/SessionEnd hooks: { at, event:'start'|'end', session_id,
// repo, cwd, by }. "Active" = a start with no matching end. Sessions can crash without firing the end
// hook, so anything older than STALE_SESSION_HOURS is treated as ended rather than haunting the panel.

export const sessionsLogPath = (vaultPath) => join(String(vaultPath || ''), '.access', 'sessions.jsonl');
const STALE_SESSION_HOURS = 12;

export function appendSession(vaultPath, entry) {
  try {
    if (!vaultPath) return false;
    const p = sessionsLogPath(vaultPath);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, `${JSON.stringify(entry)}\n`);
    return true;
  } catch { return false; }
}

export function readSessions(vaultPath, { limit = 200 } = {}) {
  try {
    const p = sessionsLogPath(vaultPath);
    if (!existsSync(p)) return [];
    const rows = [];
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* torn line */ }
    }
    rows.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    return limit > 0 ? rows.slice(0, limit) : rows;
  } catch { return []; }
}

// Currently-active sessions: latest event per session_id is a `start` that is not stale. `now` is
// injectable for tests.
export function activeSessions(vaultPath, { now = new Date().toISOString() } = {}) {
  const latest = new Map();
  for (const e of readSessions(vaultPath)) {
    const id = String(e.session_id || '');
    if (id && !latest.has(id)) latest.set(id, e); // rows are newest-first
  }
  const cutoff = Date.parse(now) - STALE_SESSION_HOURS * 3600 * 1000;
  return [...latest.values()].filter((e) =>
    e.event === 'start' && Number.isFinite(Date.parse(e.at)) && Date.parse(e.at) >= cutoff);
}
