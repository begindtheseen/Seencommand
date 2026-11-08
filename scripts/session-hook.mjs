#!/usr/bin/env node
// Session ↔ Chronos coordination hook. THE problem this solves: seen-command sessions and seen
// (product) sessions both push updates to the site independently and cannot see each other, so plans
// contradict. Chronos is the one store every session already resolves — these hooks make it the
// coordination layer instead of a diary.
//
//   start (SessionStart): register presence in <vault>/.access/sessions.jsonl and print a briefing to
//     stdout (which Claude Code injects as session context): who ELSE is active right now, and what the
//     brain learned today. A session that starts blind is how contradictions happen.
//   end (SessionEnd): register the end, and capture the session into the vault timeline — the opening
//     ask, what tools ran, and the closing message — keyed by session id so re-fires are idempotent.
//
// Invoked by Claude Code hooks with a JSON payload on stdin ({ session_id, transcript_path, cwd, ... }).
// NEVER blocks a session: every failure path exits 0 silently. Wall-clock matters at start (it delays
// the first prompt), so reads are bounded.

import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE); // scripts/ -> repo root; imports resolve relative to THIS file so the
                            // global hook works from any project's cwd.

const mode = process.argv[2] === 'end' ? 'end' : 'start';

function readStdin() {
  try {
    const chunks = [];
    const fd = 0;
    const buf = Buffer.alloc(65536);
    // stdin is closed by the hook runner after writing the payload, so a bounded sync read is fine.
    let n;
    try { while ((n = readSync(fd, buf, 0, buf.length)) > 0) chunks.push(Buffer.from(buf.slice(0, n))); } catch { /* EOF/EAGAIN */ }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch { return {}; }
}

// Which repo a session belongs to, from its cwd — the label other sessions see.
function repoOf(cwd) {
  const c = String(cwd || '');
  if (/command-os|seen-command/i.test(c)) return 'seen-command';
  if (/\/seen(\/|$)/i.test(c)) return 'seen';
  return basename(c) || 'unknown';
}

// Tail of a possibly-huge transcript: last `bytes` only, split into parsed JSONL rows.
function tailTranscript(path, bytes = 2 * 1024 * 1024) {
  try {
    const size = statSync(path).size;
    const fd = openSync(path, 'r');
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    closeSync(fd);
    const rows = [];
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.trim() || !line.trim().startsWith('{')) continue;
      try { rows.push(JSON.parse(line)); } catch { /* torn first line of the tail */ }
    }
    return rows;
  } catch { return []; }
}

// PURE: distill transcript rows into what another session would want to know. Exported for tests via
// the companion module pattern (this file is also importable).
export function summarizeTranscript(rows) {
  let firstUser = '';
  let lastAssistant = '';
  const tools = new Map();
  for (const r of rows) {
    const msg = r && r.message;
    if (!msg || !Array.isArray(msg.content)) continue;
    if (r.type === 'user' && !firstUser) {
      const t = msg.content.find((c) => c && c.type === 'text' && String(c.text || '').trim());
      if (t) firstUser = String(t.text).trim();
    }
    if (r.type === 'assistant') {
      for (const c of msg.content) {
        if (c && c.type === 'text' && String(c.text || '').trim()) lastAssistant = String(c.text).trim();
        if (c && c.type === 'tool_use' && c.name) tools.set(c.name, (tools.get(c.name) || 0) + 1);
      }
    }
  }
  const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
  const toolLine = [...tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([k, v]) => `${k}×${v}`).join(' · ');
  return {
    ask: clip(firstUser.replace(/\s+/g, ' '), 300),
    outcome: clip(lastAssistant.replace(/\s+/g, ' '), 700),
    tools: toolLine,
    toolCalls: [...tools.values()].reduce((a, b) => a + b, 0),
  };
}

async function main() {
  const payload = readStdin();
  const sessionId = String(payload.session_id || `pid-${process.pid}`);
  const cwd = String(payload.cwd || process.cwd());
  const repo = repoOf(cwd);
  const now = new Date().toISOString();

  // Resolve the vault through this repo's own resolver (CHRONOS_VAULT first, then sibling probing) so
  // the same script works from either repo and from the global hook. lib/config.mjs is imported FIRST
  // for its side effect — it loads the repo .env, which is where CHRONOS_VAULT lives; without it a hook
  // fired from a git worktree (no sibling seen/, no shell env) resolves nothing and silently no-ops,
  // which is the exact silent-failure class that hid the brain being disconnected for a whole session.
  let vault = null, A = null;
  try {
    try { await import(join(REPO, 'lib', 'config.mjs')); } catch { /* packaged/partial checkout */ }
    const S = await import(join(REPO, 'brain', 'lib', 'sources.mjs'));
    A = await import(join(REPO, 'brain', 'lib', 'activity.mjs'));
    vault = S.resolveVaultPath();
  } catch { /* no vault → silent no-op */ }
  if (!vault || !A) process.exit(0);

  if (mode === 'start') {
    A.appendSession(vault, { at: now, event: 'start', session_id: sessionId, repo, cwd, by: process.env.BRAIN_CLIENT || 'claude-session' });
    // The briefing — stdout becomes session context. Who else is live, and what moved today.
    try {
      const others = A.activeSessions(vault).filter((s) => s.session_id !== sessionId);
      const lines = [];
      if (others.length) {
        lines.push(`⚠ ${others.length} OTHER Claude session(s) are active right now — coordinate through the brain before shipping anything that changes plans:`);
        for (const s of others.slice(0, 5)) lines.push(`  • ${s.repo} session since ${String(s.at).slice(11, 16)} UTC (${s.cwd})`);
      } else {
        lines.push('No other Claude sessions are active right now.');
      }
      try {
        const V = await import(join(REPO, 'brain', 'lib', 'vault.mjs'));
        const facts = V.readIndex(vault).facts;
        const today = now.slice(0, 10);
        const todays = facts.filter((f) => String(f.recorded_at || f.recorded || '').startsWith(today));
        if (todays.length) {
          // What was LEARNED leads, newest first by TIME. This used to print `todays.slice(-3)` under the
          // word "Newest" — the last three in note-PATH order — and KPI refreshes (each a "new fact")
          // filled all three slots: "Newest: active_jobs 46790, 45389, 46563".
          const M = await import(join(REPO, 'brain', 'lib', 'metrics.mjs'));
          const { knowledge, metrics } = M.splitMetrics(todays);
          if (knowledge.length) {
            lines.push(`The brain learned ${knowledge.length} new fact(s) today. Newest:`);
            for (const f of knowledge.slice(0, 3)) lines.push(`  • ${f.subject} — ${f.predicate}: ${String(f.object).slice(0, 100)}`);
          }
          if (metrics.length) lines.push(M.metricsLine(metrics));
        }
      } catch { /* briefing degrades to presence only */ }
      lines.push('Durable findings from THIS session must be written to the brain (it is the cross-session coordination layer). At session end this is captured automatically, but write verified facts as you go.');
      process.stdout.write(lines.join('\n'));
    } catch { /* no briefing beats a broken start */ }
    process.exit(0);
  }

  // mode === 'end'
  A.appendSession(vault, { at: now, event: 'end', session_id: sessionId, repo, cwd, reason: String(payload.reason || '') });
  try {
    const rows = tailTranscript(String(payload.transcript_path || ''));
    const s = summarizeTranscript(rows);
    if (s.ask || s.outcome) {
      const W = await import(join(REPO, 'brain', 'lib', 'memory-write.mjs'));
      const text = [
        s.ask ? `**Ask:** ${s.ask}` : null,
        s.outcome ? `**Closing state:** ${s.outcome}` : null,
        s.tools ? `**Tools:** ${s.toolCalls} calls — ${s.tools}` : null,
        `_Captured automatically at SessionEnd (${repo}, ${sessionId.slice(0, 8)})._`,
      ].filter(Boolean).join('\n');
      W.appendTimeline(vault, { date: now.slice(0, 10), heading: `Claude session — ${repo}`, text, key: sessionId });
    }
  } catch { /* capture is best-effort; the end event above already landed */ }
  process.exit(0);
}

// Run ONLY when executed as a hook — never on import. The test suite imports this file for
// summarizeTranscript, and an import-time main() would block forever on stdin under node --test.
const isDirect = (() => {
  try { return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href; } catch { return false; }
})();
if (isDirect) main().catch(() => process.exit(0));
