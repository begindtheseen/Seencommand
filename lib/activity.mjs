// activity — Seen Command's append-only ACTIVITY LEDGER: the ONE place a Claude session looks to see
// what the running app actually DID. Every board meeting, approval, build, delivery, self-update, and
// deployability verdict lands here as one JSON line. Brandon asked for exactly this — "every process
// seen command attempts should get logged somewhere claude will see it … so i dont have to tell you
// every time something fails". The app's build/meeting state lives under SEEN_HOME (…/Library/
// Application Support/seen-command/data) where Claude sessions never look; this ledger lives in the
// REPO checkout, which is what a session reads.
//
// CRITICAL: the path anchors on the REPO checkout via config.commandRepoDir() (NOT dataDir()/SEEN_HOME),
// so the packaged .app AND a plain CLI run both append to the SAME repo-local ledger. One writer, one
// place, chronological.
//
// Everything here is DEFENSIVE, like lib/brain.mjs: a ledger write must NEVER break a board meeting or
// a build. On any failure it logs to stderr and returns null — it never throws. On read, a corrupt
// line is skipped, never fatal.

import { appendFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

// The ledger dir: <commandRepoDir>/data/activity. Resolved at CALL time (env can change under tests),
// so the packaged app and the CLI land in the same repo-local folder Claude reads.
export function activityDir() {
  return join(config.commandRepoDir(), 'data', 'activity');
}

// The California day-file a moment belongs to (owner, 2026-10-21: Pacific time everywhere). Each event
// still carries its absolute ISO `ts`, so ordering is exact across the DST change.
const dayKey = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }); // YYYY-MM-DD
const clip = (v, n) => { const s = v == null ? '' : String(v); return s.length > n ? s.slice(0, n) : s; };

// The ledger is also the notification source for everything that is not a collector run (those notify from
// the aggregation manager with their numbers): a finished board meeting, a build that shipped or broke, a PR
// that is ready, a self-update. One mapping, so a new producer only has to log.
export function noticeFromActivity(ev) {
  const s = ev.status, sum = ev.summary || '';
  if (ev.kind === 'meeting' && s === 'completed') return { kind: 'meeting', level: 'info', title: 'Board meeting finished', body: sum.replace(/^board meeting done — /, ''), tab: 'home', ref: ev.id };
  if (ev.kind === 'meeting' && s === 'failed') return { kind: 'meeting', level: 'error', title: 'Board meeting failed', body: ev.detail || sum, tab: 'home', ref: ev.id };
  if (ev.kind === 'build' && ['pr_ready', 'merged', 'green_dry'].includes(s)) return { kind: 'build', level: 'success', title: s === 'merged' ? 'Build merged' : 'Build ready — PR open', body: sum, tab: 'tasks', ref: ev.id };
  if (ev.kind === 'build' && ['failed', 'preview_failed'].includes(s)) return { kind: 'build', level: 'error', title: s === 'preview_failed' ? 'Build preview failed' : 'Build failed', body: ev.detail || sum, tab: 'tasks', ref: ev.id };
  if (ev.kind === 'pr-status' && s === 'ready') return { kind: 'pr', level: 'success', title: 'PR ready to merge', body: sum, tab: 'tasks', ref: ev.id };
  if (ev.kind === 'self-update' && ['updated', 'failed'].includes(s)) return { kind: 'self-update', level: s === 'updated' ? 'success' : 'error', title: s === 'updated' ? 'Seen Command updated itself' : 'Self-update failed', body: ev.detail || sum, tab: 'settings', ref: ev.id };
  if (ev.kind === 'approval' && s === 'failed') return { kind: 'approval', level: 'error', title: 'An approval did not go through', body: ev.detail || sum, tab: 'home', ref: ev.id };
  return null;
}
let notifyHook = null;
// Loaded lazily so tests (and any process without a runtime home) never write notifications by accident.
export function enableActivityNotifications(fn) { notifyHook = fn; }
// Raw-event listeners (every logged line, not just the ones that map to a notification). The ticket
// wiring (lib/ticket-wire.mjs) subscribes here so a failed collector run, a failed board meeting, a red
// PR… opens a brain ticket without each producer having to know tickets exist. Registered only by entry
// points (via notify-wire), so tests and libraries never open tickets as a side effect.
const listeners = new Set();
export function onActivity(fn) { if (typeof fn === 'function') listeners.add(fn); return () => listeners.delete(fn); }

// Append ONE event — { ts, kind, id, status, summary, detail } — to today's day-file. Never throws.
// `dir` is the injectable seam (tests pass a temp dir); it defaults to the repo-local ledger dir.
export function logActivity({ kind, id = null, status = null, summary, detail = null } = {}, dir = activityDir()) {
  try {
    const event = {
      ts: new Date().toISOString(),
      kind: clip(kind, 40) || 'event',
      id: id == null ? null : clip(id, 80),
      status: status == null ? null : clip(status, 40),
      summary: clip(summary, 200),
      detail: detail == null ? null : clip(detail, 500),
    };
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `${dayKey()}.jsonl`), JSON.stringify(event) + '\n');
    if (notifyHook) { try { const n = noticeFromActivity(event); if (n) notifyHook(n); } catch { /* never breaks the ledger */ } }
    for (const fn of listeners) { try { fn(event); } catch { /* a listener never breaks the ledger */ } }
    return event;
  } catch (e) {
    process.stderr.write(`[activity] log failed: ${e.message}\n`);
    return null;
  }
}

// The last N day-files (by sorted date), parsed oldest→newest. Missing dir → []. Corrupt lines skipped.
export function readActivity({ days = 2, dir = activityDir() } = {}) {
  let files = [];
  try { files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort(); }
  catch { return []; } // no ledger yet
  const out = [];
  for (const f of files.slice(-days)) {
    let text = '';
    try { text = readFileSync(join(dir, f), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      const l = line.trim();
      if (!l) continue;
      try { out.push(JSON.parse(l)); } catch { /* skip corrupt line */ }
    }
  }
  return out;
}
