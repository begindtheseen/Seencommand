// failure-loop — a failure is WORK, never a dead end.
//
// Brandon, 2026-08-13: "Nothing should fail ever. And if it does it shouldn't just end there. Failed
// tasks should immediately reach out to chronos and report it and secure the fix from Claude cline or
// put it in a place where this session can see it and we can patch and improve seen command."
//
// Before this, a failed build wrote a red record into data/builds/ and stopped. Nobody was told, the
// brain never learned it, and the only way to discover it was to go looking — which is how 43 failures
// accumulated unnoticed. Now every failure lands in THREE places, and the design point is that they
// degrade independently:
//   1. An append-only queue on disk (data/failures/YYYY-MM-DD.jsonl) — the thing a future session or
//      Brandon can read to patch the platform. This is written FIRST and never depends on the network.
//   2. The Chronos brain — a timeline episode plus one open typed fact per failing subject, so the
//      board meeting, the chat, and Chronos itself can all see what is broken right now.
//   3. The activity ledger, so "review seen command updates" shows it.
//
// Resolutions are appended, never edited: the queue is a log, and openFailures() folds it. That keeps
// the history of what broke and how it was fixed, which is the raw material for making the platform
// stop failing in the first place.
//
// Every external call is injected so the tests run offline, and a brain write that fails NEVER loses
// the failure — the record says `brain: { ok: false, error }` and the queue still holds it.

import { existsSync, mkdirSync, appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './paths.mjs';
import { recordFacts, recordDevLog } from './brain.mjs';
import { logActivity } from './activity.mjs';

// Ticket hooks — set by lib/ticket-wire.mjs when an entry point loads it (via notify-wire), so every
// recorded failure also opens/updates a trackable ticket in the brain and every resolution closes it.
// Null by default: tests and libraries never write tickets as a side effect.
let ticketHooks = null;
export function setFailureTicketHooks(hooks) { ticketHooks = hooks || null; }

const clip = (v, n = 400) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const day = (d) => new Date(d).toISOString().slice(0, 10);

export function failuresDir() {
  const dir = join(dataDir(), 'failures');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

// One failure line. `blocked` marks the ones only Brandon can clear (credential, quota, red base
// branch) — the single most useful split, because a blocked failure retried by an agent just fails
// again, while an unblocked one is genuinely ours to fix.
export function recordFailure({
  kind = 'build', id, key = null, repo = null, title = null, reason, detail = null,
  blocked = false, errorKind = null, source = null, at = new Date().toISOString(),
} = {}, {
  dir = null, append = appendFileSync, facts = recordFacts, timeline = recordDevLog,
  activity = logActivity, now = () => new Date(),
} = {}) {
  if (!id || !reason) return { ok: false, error: 'a failure needs an id and a reason' };
  const record = {
    at, kind, id, ...(key ? { key } : {}), repo, title, reason: clip(reason), detail: detail ? clip(detail, 2000) : null,
    blocked: !!blocked, errorKind, source, resolved: false,
  };

  // 1) The queue FIRST — it must survive even if everything else is down.
  let queuePath = null;
  try {
    queuePath = join(dir || failuresDir(), `${day(at)}.jsonl`);
    append(queuePath, `${JSON.stringify(record)}\n`);
  } catch (e) { return { ok: false, error: `could not queue the failure: ${e.message}`, record }; }

  // 2) Chronos — an episode plus one open fact per failing subject, so it is visible AND queryable.
  const brain = { ok: false, error: null };
  try {
    const note = timeline({
      heading: `Failure — ${kind} ${id}${title ? `: ${clip(title, 80)}` : ''}`,
      text: `${record.reason}\n\nBlocked on owner: ${record.blocked ? 'YES — only Brandon can clear this' : 'no — this is ours to fix'}\nRepo: ${repo || 'n/a'} · kind: ${errorKind || kind}${source ? ` · source: ${source}` : ''}\nQueued for patching in data/failures/${day(at)}.jsonl`,
      key: `failure:${id}:${at}`,
    });
    const f = facts([{
      subject: `Seen Command failure ${id}`,
      predicate: 'status',
      object: `OPEN${record.blocked ? ' (blocked on owner)' : ''} — ${record.reason}`,
      confidence: 'high',
      source: source || 'lib/failure-loop.mjs',
    }]);
    brain.ok = !!note || !!(f && f.written);
    if (!brain.ok) brain.error = 'the vault accepted nothing (no vault configured?)';
  } catch (e) { brain.error = e.message; }

  // 3) The activity ledger — Brandon's "review seen command updates" surface.
  try {
    activity({
      kind: 'failure', id, status: record.blocked ? 'blocked' : 'open',
      summary: `${kind} ${id} FAILED — ${record.reason}`, detail: record.detail,
    });
  } catch { /* the queue and the brain already have it */ }

  // 4) The ticket — trackable work any AI on the brain can pick up (lib/ticket-wire.mjs).
  let ticket = null;
  if (ticketHooks && ticketHooks.onFailure) {
    try { ticket = ticketHooks.onFailure(record) || null; } catch (e) { ticket = { ok: false, error: e.message }; }
  }

  return { ok: true, record, queuePath, brain, ticket };
}

// Mark a queued failure resolved. Appended, never edited — the log keeps what broke AND how it was
// fixed, which is what makes the platform improvable rather than merely observable.
export function resolveFailure({ id, how = '', by = 'claude' } = {}, {
  dir = null, append = appendFileSync, facts = recordFacts, activity = logActivity,
  at = new Date().toISOString(),
} = {}) {
  if (!id) return { ok: false, error: 'an id is required' };
  try {
    append(join(dir || failuresDir(), `${day(at)}.jsonl`),
      `${JSON.stringify({ at, id, resolved: true, how: clip(how), by })}\n`);
  } catch (e) { return { ok: false, error: e.message }; }
  // Supersede the open fact rather than deleting it — the brain keeps the whole arc.
  try {
    facts([{ subject: `Seen Command failure ${id}`, predicate: 'status', object: `RESOLVED — ${clip(how) || 'fixed'}`, confidence: 'high', source: 'lib/failure-loop.mjs' }]);
  } catch { /* the queue is still authoritative */ }
  try { activity({ kind: 'failure', id, status: 'resolved', summary: `failure ${id} resolved — ${clip(how, 120)}` }); } catch { /* ignore */ }
  if (ticketHooks && ticketHooks.onResolve) { try { ticketHooks.onResolve({ id, how, by }); } catch { /* the queue is authoritative */ } }
  return { ok: true, id, how };
}

// Every recorded failure for one id, oldest first (resolutions excluded — this is the break history).
export function failureHistory(id, { days = 30, dir = null, read = readFileSync, list = readdirSync, now = Date.now() } = {}) {
  if (!id) return [];
  const root = dir || failuresDir();
  let files = [];
  try { files = list(root).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort(); } catch { return []; }
  const cutoff = now - days * 86400000;
  const out = [];
  for (const f of files) {
    if (Date.parse(f.replace('.jsonl', '')) < cutoff) continue;
    let text = '';
    try { text = String(read(join(root, f), 'utf8')); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (r.id === id && !r.resolved && r.reason) out.push(r);
    }
  }
  return out;
}

// The whole point of keeping the log: a retry that repeats a known failure is wasted money and time.
// This turns the break history into a brief the coder actually receives, so attempt N+1 starts where
// attempt N died instead of rediscovering it. Empty string when there is nothing to learn from, so
// callers can append it unconditionally.
export function failureBrief(id, opts = {}) {
  const history = failureHistory(id, opts);
  if (!history.length) return '';
  const recent = history.slice(-3);
  const blocked = recent.filter((r) => r.blocked);
  return [
    `PREVIOUS ATTEMPTS AT THIS TASK FAILED ${history.length} time(s). Do not repeat these:`,
    ...recent.map((r, i) => `${i + 1}. [${String(r.at).slice(0, 16).replace('T', ' ')}${r.errorKind ? ` · ${r.errorKind}` : ''}] ${r.reason}`),
    blocked.length
      ? `\nNOTE: ${blocked.length} of these were BLOCKED ON THE OWNER (credential, quota, or a red base branch), not a coding mistake. If the same blocker is still in place, stop and say so rather than attempting the work again.`
      : '\nThese were coding failures, not environment ones. Take a genuinely different approach — repeating the previous shape will fail the same way.',
  ].join('\n');
}

// Fold the append-only log into what is still OPEN. Newest first, with a resolution applied to every
// earlier record for the same id. A later failure of the same id REOPENS it (a fix that did not hold
// is not a resolved failure).
export function openFailures({ days = 14, dir = null, read = readFileSync, list = readdirSync, now = Date.now() } = {}) {
  let files = [];
  const root = dir || failuresDir();
  try {
    files = list(root).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  } catch { return { open: [], resolved: 0, scanned: 0 }; }
  const cutoff = now - days * 86400000;
  const byId = new Map();
  let scanned = 0;
  for (const f of files) {
    if (Date.parse(f.replace('.jsonl', '')) < cutoff) continue;
    let text = '';
    try { text = String(read(join(root, f), 'utf8')); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (!r.id) continue;
      scanned += 1;
      // Both a new failure and a resolution overwrite the current verdict for that id, in file order.
      byId.set(r.id, r.resolved ? { ...(byId.get(r.id) || {}), ...r, resolved: true } : { ...r, resolved: false });
    }
  }
  const all = [...byId.values()];
  const open = all.filter((r) => !r.resolved).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return {
    open,
    blocked: open.filter((r) => r.blocked).length,
    actionable: open.filter((r) => !r.blocked).length,
    resolved: all.filter((r) => r.resolved).length,
    scanned,
  };
}
