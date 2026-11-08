// brain — Seen Command's connection to the shared memory brain (the Chronos vault).
//
// The board meeting READS the vault's accumulated facts as input and WRITES what each run learns
// (the live KPIs, the current focus, the board-meeting episode) back into the vault — the same brain
// Claude reads and updates.
//
// ONE WRITER, byte-compatible facts: writes go through the seen repo's shared, supersede-aware
// writer — `<seen>/lib/server/writeFact.js` (PR #166) — the exact module Claude's MCP server uses.
// Both repos sit side-by-side on the Mac, so Seen Command and Claude emit byte-identical frontmatter
// into the same vault. We resolve that writer at runtime (env → derive from the vault path → sibling
// probe). If it can't be found (e.g. the seen repo isn't present), we fall back to the vendored
// writer so a board meeting still records — just not through the shared module.
//
// Everything here is DEFENSIVE: if the vault or writer isn't found, or a write fails, the board
// meeting must still run. Reads fall back to [] and writes become no-ops (logged), never throwing.

import { pathToFileURL } from 'node:url';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import './config.mjs'; // side effect: load .env (sets CHRONOS_VAULT) BEFORE we resolve the writer below
import { REPO_ROOT } from './paths.mjs';
import { resolveSources } from '../brain/lib/sources.mjs';
import { currentFacts as vaultCurrentFacts, recordFact as recordFactV, appendTimeline as appendTimelineV } from '../brain/lib/memory-write.mjs';
import { readIndex } from '../brain/lib/vault.mjs';

// The ONE note Seen Command owns and writes to (per SHARED_BRAIN.md). It never edits others' notes.
export const OBSERVATIONS_NOTE = 'seen-command-observations.md';

export function brainVault() {
  try { return resolveSources().vaultPath; } catch { return null; }
}

// Locate the seen repo's shared writer. Order: explicit SEEN_REPO → derived from the vault
// (CHRONOS_VAULT is `<seen>/memory`, so its parent is the seen repo) → siblings of this repo. The
// derived path is what lets the packaged .app (running from /Applications) find it on the Mac.
function seenWriterPath() {
  const candidates = [];
  if (process.env.SEEN_REPO) candidates.push(join(process.env.SEEN_REPO, 'lib', 'server', 'writeFact.js'));
  const vault = brainVault();
  if (vault) candidates.push(join(dirname(vault), 'lib', 'server', 'writeFact.js')); // vault = <seen>/memory
  candidates.push(join(REPO_ROOT, '..', 'seen', 'lib', 'server', 'writeFact.js'));
  candidates.push(join(REPO_ROOT, '..', '..', 'seen', 'lib', 'server', 'writeFact.js'));
  for (const c of candidates) { try { if (existsSync(c)) return c; } catch { /* skip */ } }
  return null;
}

// Load the shared writer ONCE at module init (top-level await). `null` → use the vendored fallback.
let shared = null;
try {
  const p = seenWriterPath();
  if (p) { shared = await import(pathToFileURL(p).href); process.stderr.write(`[brain] shared writer: ${p}\n`); }
  else process.stderr.write('[brain] shared seen writer not found — using vendored writer\n');
} catch (e) {
  process.stderr.write(`[brain] shared writer load failed (${e.message}) — using vendored writer\n`);
  shared = null;
}

export function usingSharedWriter() { return !!shared; }

// Currently-true facts from the vault, as {subject,predicate,object,confidence} triples for merging
// into the board meeting's graph. [] if no vault.
export function readBrainFacts() {
  const v = brainVault();
  if (!v) return [];
  try { return vaultCurrentFacts(v); }
  catch (e) { process.stderr.write(`[brain] read failed: ${e.message}\n`); return []; }
}

// Currently-true facts across the whole vault, as plain triples. [] if no vault or on error.
export function currentFacts() {
  const v = brainVault();
  if (!v) return [];
  try { return vaultCurrentFacts(v); }
  catch (e) { process.stderr.write(`[brain] currentFacts failed: ${e.message}\n`); return []; }
}

// EVERY fact in Seen Command's own observations note — including superseded (closed valid_to) ones,
// so the timeline of each value is inspectable. [] if no vault / note yet.
export function readObservations() {
  const v = brainVault();
  if (!v) return [];
  try {
    return readIndex(v).facts.filter((f) => String(f.note || '').endsWith(OBSERVATIONS_NOTE));
  } catch (e) { process.stderr.write(`[brain] readObservations failed: ${e.message}\n`); return []; }
}

// Write one triple into the observations note through the shared writer if available, else the
// vendored one. Both supersede-not-overwrite. Returns 1 if a fact was created/superseded, else 0.
function writeOne(v, open, f) {
  const obj = String(f.object);
  const source = f.source || 'engine/run.mjs (board meeting)';
  if (shared) {
    // seen's recordFact reads the note itself, supersedes the open fact, and no-ops if unchanged.
    const r = shared.recordFact(v, OBSERVATIONS_NOTE, { subject: f.subject, predicate: f.predicate, object: obj, confidence: f.confidence || 'medium', source });
    return r && r.written ? 1 : 0;
  }
  // vendored fallback — ONE dedup implementation (memory-write `recordFact`): add / supersede / no-op.
  // We pass the pre-read `open` facts so a batch of recordFacts doesn't re-walk the vault per fact.
  const r = recordFactV(v, OBSERVATIONS_NOTE, { subject: f.subject, predicate: f.predicate, object: obj, confidence: f.confidence, source }, open);
  return r.written;
}

// Record live business facts into the observations note. Bi-temporal, supersede-never-overwrite.
// Returns { written } = how many facts were created or superseded. Never throws.
export function recordFacts(facts = []) {
  const v = brainVault();
  if (!v) { process.stderr.write('[brain] recordFacts skipped — no vault\n'); return { written: 0 }; }
  // Pre-read open facts only for the vendored path (the shared writer reads the note itself).
  let open = [];
  if (!shared) {
    try { open = readIndex(v).facts.filter((f) => String(f.note || '').endsWith(OBSERVATIONS_NOTE) && f.valid_to == null); }
    catch (e) { process.stderr.write(`[brain] recordFacts read failed: ${e.message}\n`); }
  }
  let written = 0;
  for (const f of facts) {
    if (f == null || f.subject == null || f.predicate == null || f.object == null) continue;
    try { written += writeOne(v, open, f); }
    catch (e) { process.stderr.write(`[brain] recordFacts(${f.subject}·${f.predicate}) failed: ${e.message}\n`); }
  }
  return { written };
}

// Merge SEED facts with vault facts, deduped by subject|predicate|object (case-insensitive). SEED
// wins on formatting; vault adds everything the brain has accumulated.
export function mergeFacts(seedFacts, brainFacts) {
  const key = (f) => `${f.subject}|${f.predicate}|${f.object}`.toLowerCase();
  const out = [];
  const seen = new Set();
  for (const f of [...(seedFacts || []), ...(brainFacts || [])]) {
    const k = key(f);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  return out;
}

// ---- multi-day context ------------------------------------------------------------------------
// Digest a timeline directory of YYYY-MM-DD.md notes into a compact prompt block: per day, the entry
// headings plus the first line under each. Pure + testable. '' when the dir is missing/empty.
export function digestTimelineDir(dir, days = 7, maxChars = 1400) {
  let files = [];
  try { files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort(); } catch { return ''; }
  const out = [];
  for (const f of files.slice(-days)) {
    let text = '';
    try { text = readFileSync(join(dir, f), 'utf8'); } catch { continue; }
    const day = f.replace('.md', '');
    const entries = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length && entries.length < 5; i++) {
      const l = lines[i].trim();
      if (!l.startsWith('## ')) continue;
      let first = '';
      for (let j = i + 1; j < lines.length; j++) { const b = lines[j].trim(); if (b && !b.startsWith('#')) { first = b; break; } if (b.startsWith('#')) break; }
      entries.push(`  - ${l.slice(3)}${first ? `: ${first.slice(0, 130)}` : ''}`);
    }
    if (entries.length) out.push(`${day}:\n${entries.join('\n')}`);
  }
  let s = out.join('\n');
  if (s.length > maxChars) s = s.slice(s.length - maxChars); // keep the most RECENT tail
  return s;
}

// The last N days of the vault timeline, digested for prompts — the multi-day context the CEO chat
// and the board meeting reason over. '' if no vault.
export function readTimelineDigest(days = 7, maxChars = 1400) {
  const v = brainVault();
  if (!v) return '';
  try { return digestTimelineDir(join(v, 'timeline'), days, maxChars); }
  catch (e) { process.stderr.write(`[brain] timeline digest failed: ${e.message}\n`); return ''; }
}

// Structured timeline: the last N days as [{ date, entries: [{heading, text}] }] — the Vault tab's
// "This week" feed. Pure parser exported for tests.
export function parseTimelineMd(text) {
  const entries = [];
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l.startsWith('## ')) continue;
    let body = '';
    for (let j = i + 1; j < lines.length; j++) { const b = lines[j].trim(); if (b.startsWith('#')) break; if (b) { body = b; break; } }
    entries.push({ heading: l.slice(3).trim(), text: body.slice(0, 400) });
  }
  return entries;
}
export function readTimelineEntries(days = 7) {
  const v = brainVault();
  if (!v) return [];
  try {
    const dir = join(v, 'timeline');
    const files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().slice(-days);
    return files.map((f) => ({ date: f.replace('.md', ''), entries: parseTimelineMd(readFileSync(join(dir, f), 'utf8')) }))
      .filter((d) => d.entries.length).reverse(); // newest day first
  } catch (e) { process.stderr.write(`[brain] timeline entries failed: ${e.message}\n`); return []; }
}

// The decisions ledger, parsed from decisions/log.md bullets: `- **YYYY-MM-DD — Title.** detail`.
// Section headings (## …) become the category. Newest first. Pure parser exported for tests.
export function parseDecisionsMd(text) {
  const out = [];
  let section = '';
  for (const raw of String(text || '').split('\n')) {
    const l = raw.trim();
    if (l.startsWith('## ')) { section = l.slice(3).replace(/\[\[[^\]]*\]\]/g, '').replace(/[()]/g, '').trim(); continue; }
    const m = l.match(/^-\s+\*\*(\d{4}-\d{2}-\d{2})\s*—\s*([^*]+)\*\*\s*(.*)$/);
    if (m) out.push({ date: m[1], title: m[2].trim().replace(/[.:]$/, ''), detail: m[3].replace(/\[\[([^\]|]*)(\|[^\]]*)?\]\]/g, '$1').trim().slice(0, 300), section });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}
export function readDecisions(limit = 40) {
  const v = brainVault();
  if (!v) return [];
  try { return parseDecisionsMd(readFileSync(join(v, 'decisions', 'log.md'), 'utf8')).slice(0, limit); }
  catch (e) { process.stderr.write(`[brain] decisions read failed: ${e.message}\n`); return []; }
}

// Record an APPROVED action as a real, dated action item in the brain (visible in Chronos). This is
// what "approve" does for actions with no auto-execution integration: the exec team's drafted work
// becomes a committed action in the shared memory, for Brandon to execute. Never throws.
export function recordApproval({ dept, agent, action, draft, date } = {}) {
  const v = brainVault();
  if (!v) { process.stderr.write('[brain] recordApproval skipped — no vault\n'); return null; }
  const when = date || new Date().toISOString().slice(0, 10);
  const text = `**${action}** — ${dept}${agent ? ` · ${agent}` : ''}\n${draft || ''}`;
  try {
    const r = shared
      ? shared.appendTimeline(v, when, `Approved action — ${action}`, text)
      : appendTimelineV(v, { date: when, heading: 'Approved actions', text });
    return { recorded: true, note: (r && r.note) || (r && r.path) || `timeline/${when}.md`, action };
  } catch (e) { process.stderr.write(`[brain] recordApproval failed: ${e.message}\n`); return null; }
}

// Record a NARRATIVE dev-log episode (git → brain): the PRs merged since the last board meeting.
// Same one-writer dispatch as the episodes above — shared seen writer when present, vendored
// otherwise — so nothing here reaches the vault or Supabase by any other route.
//
// The return value is load-bearing: brain/lib/git-episodes.mjs advances its commit cursor ONLY when
// this returns truthy, so a failed write is retried on the next run instead of being lost. Never
// throws (a narration failure must not fail a board meeting); returns null on every failure path.
export function recordDevLog({ date, heading, text, key } = {}) {
  const v = brainVault();
  if (!v) { process.stderr.write('[brain] recordDevLog skipped — no vault\n'); return null; }
  if (!heading || !text) { process.stderr.write('[brain] recordDevLog skipped — empty heading/text\n'); return null; }
  const when = date || new Date().toISOString().slice(0, 10);
  try {
    // `key` is the vendored writer's idempotency check (`content.includes(key)`), so the caller puts
    // the key inside `text`. The shared writer has no key parameter; there, the cloud mirror's
    // unique (date, heading, body) is the backstop.
    const r = shared
      ? shared.appendTimeline(v, when, heading, text)
      : appendTimelineV(v, { date: when, heading, text, key });
    return { recorded: true, note: (r && r.note) || (r && r.path) || `timeline/${when}.md`, skipped: !!(r && r.skipped) };
  } catch (e) { process.stderr.write(`[brain] recordDevLog failed: ${e.message}\n`); return null; }
}

// Record a board meeting back into the brain: a timeline episode for the run, and the current focus
// as a superseding fact on the observations note. Returns a short summary or null.
export function recordBoardMeeting(vault, { runId, date, autoExecuted, parked, openItems, focus }) {
  const v = vault || brainVault();
  if (!v) return null;
  const results = { timeline: null, focus: null };
  const text = `${runId}: focus "${focus}" · ${autoExecuted} auto-executed · ${parked} parked · ${openItems} open items`;
  try {
    results.timeline = shared
      ? shared.appendTimeline(v, date, `Board meeting ${runId}`, text)         // shared writer (Claude-compatible)
      : appendTimelineV(v, { date, heading: 'Board meetings', key: runId, text }); // vendored (idempotent by key)
  } catch (e) { process.stderr.write(`[brain] timeline write failed: ${e.message}\n`); }

  // current focus as a bi-temporal fact — recordFacts handles supersede-or-no-op through one writer.
  try {
    const r = recordFacts([{ subject: 'Seen Command', predicate: 'current_focus', object: focus, confidence: 'high' }]);
    results.focus = r.written ? 'updated' : 'unchanged';
  } catch (e) { process.stderr.write(`[brain] focus write failed: ${e.message}\n`); }

  return results;
}
