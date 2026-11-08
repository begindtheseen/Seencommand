// memory-write — the SHARED write path into the Chronos vault (the brain's source of truth).
//
// Both Claude (via brain/mcp/server.mjs) and Seen Command (via lib/brain.mjs) call these functions,
// so there is exactly ONE way memory changes — and it obeys the vault's rules:
//   • Typed facts are bi-temporal. New truth for an existing fact = SUPERSEDE, never overwrite:
//     close the old fact (valid_to + invalidated = change date) and append a new one.
//   • The markdown is the authority; writes are careful *textual* edits to a note's `facts:`
//     frontmatter (formatting/comments/body preserved), not a lossy YAML round-trip.
//   • Decisions are an append-only ledger; timeline episodes are append-only per day.
//
// After a write nothing needs rebuilding: the MCP server and Chronos.app both re-derive from the
// markdown live. (The seen repo's optional memory/.graph index can be refreshed with
// `npm run memory:sync` there, but it is not required for recall.)
//
// ⚠ SERIALIZER PARITY — READ BEFORE TOUCHING `yamlScalar`.
// CANONICAL REFERENCE: the `seen` repo's `<seen>/lib/server/writeFact.js` (`emitVal`), paired with
// `<seen>/lib/server/memoryGraph.js` (`parseScalar`). Seen Command and Claude write into the SAME
// brain, so this writer and `./chronos/memoryGraph.mjs`'s parser MUST be exact inverses:
//   parse(write(x)) === x           and   write(parse(write(x))) === write(x)
// for every value the vault can hold. The drift-guard test is `./memory-write.test.mjs` — it runs
// the same hostile vector set as seen's `lib/server/writeFact.test.mjs`. Keep the two in sync.

import { existsSync, mkdirSync } from 'node:fs';
// Every note write in this module goes through the shared lock + atomic-rename contract, so there
// is deliberately no bare writeFileSync left here.
import { withNoteWrite } from './vault-write.mjs';
import { join, dirname } from 'node:path';
import { parseFrontmatter, normalizeFacts, factTrueAsOf, parseScalar } from './chronos/memoryGraph.mjs';
import { readIndex } from './vault.mjs';

const todayISO = () => new Date().toISOString().slice(0, 10);
const nowISO = () => new Date().toISOString(); // full transaction-time stamp for `recorded_at`
const isISODate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

// Slugify a subject into a stable-ish fact id base, e.g. "Seen free tier" → "seen-free-tier".
function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'fact';
}

// Chars that break the LINE/BLOCK layer if emitted bare: YAML-significant punctuation, a leading
// YAML indicator, edge whitespace, a backslash (the parser now unescapes those), and any control
// char — including a newline, which would split one value across frontmatter lines.
const UNSAFE_BARE = /[:#[\]{}"'`\\]|^\s|\s$|^[>|&*!%@]|[\u0000-\u001f\u007f]/;

// Serialize one scalar so the vault's frontmatter subset reads it back IDENTICALLY.
//
// Bare emission is allowed only when it is provably lossless: no structurally-unsafe char AND
// `parseScalar` reads the bare form back as this exact value. That second gate is what rules out
// the values that would silently COERCE on read — "42" → 42, "true" → true, "null"/"" → null,
// "[a, b]" → array — each of which used to make the writer's "unchanged?" comparison false forever.
// Everything else is JSON-quoted, and the parser's double-quoted branch is the exact inverse of
// JSON.stringify. That inverse pair is what makes parse(write(x)) === x and stops escapes from
// compounding across write cycles.
//
// Known limit of the frontmatter subset (unchanged, and shared with seen): it has no float scalar
// type, so a non-integer NUMBER is emitted bare and reads back as its string form ('3.5'). That is
// a stable fixed point — write(parse(write(3.5))) === write(3.5) — it just widens number→string
// once. Integers round-trip exactly.
function yamlScalar(v) {
  if (v === null || v === undefined) return 'null';
  const s = String(v);
  if (!UNSAFE_BARE.test(s) && parseScalar(s) === s) return s;   // provably lossless bare
  if (typeof v === 'number' && parseScalar(s) === v) return s;  // integers re-parse to this number
  return JSON.stringify(s);                                     // double-quoted, escapes intact
}

const FACT_ORDER = ['id', 'subject', 'predicate', 'object', 'valid_from', 'valid_to',
  'confidence', 'source', 'recorded', 'recorded_at', 'invalidated', 'by', 'change', 'supersedes'];

// Render a fact as an indented block sequence item (2-space seq indent, 4-space field indent).
function serializeFactBlock(fact) {
  const lines = [];
  FACT_ORDER.forEach((k, i) => {
    if (fact[k] === undefined) return;
    lines.push((i === 0 ? '  - ' : '    ') + k + ': ' + yamlScalar(fact[k]));
  });
  return lines.join('\n');
}

// --- low-level frontmatter surgery -----------------------------------------
// Split into { fmLines, body, hadFm }. fmLines are the raw frontmatter lines (no fences).
function splitNote(text) {
  const s = String(text).replace(/\r\n/g, '\n');
  const m = s.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { fmLines: [], body: s, hadFm: false };
  return { fmLines: m[1].split('\n'), body: s.slice(m[0].length), hadFm: true };
}
function joinNote(fmLines, body) {
  return '---\n' + fmLines.join('\n') + '\n---\n' + body;
}
const indentOf = (line) => line.length - line.trimStart().length;

// Find the [start, end) line range of the `facts:` block within fmLines (start = the `facts:` line;
// end = first line after its indented children). Returns null if there is no `facts:` key.
function findFactsBlock(fmLines) {
  let start = -1;
  for (let i = 0; i < fmLines.length; i++) {
    if (indentOf(fmLines[i]) === 0 && /^facts:\s*$/.test(fmLines[i])) { start = i; break; }
  }
  if (start === -1) return null;
  let end = start + 1;
  while (end < fmLines.length && (fmLines[end].trim() === '' || indentOf(fmLines[end]) > 0)) end++;
  return { start, end };
}

// Line range [start, end) of the fact item whose `- id: <id>` matches, within the facts block.
function findFactItem(fmLines, block, id) {
  let start = -1;
  for (let i = block.start + 1; i < block.end; i++) {
    const t = fmLines[i].trim();
    if (t.startsWith('- ') && new RegExp('^- id:\\s*' + '["\']?' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '["\']?\\s*$').test(t)) { start = i; break; }
  }
  if (start === -1) return null;
  const seqIndent = indentOf(fmLines[start]);
  let end = start + 1;
  while (end < block.end && !(indentOf(fmLines[end]) === seqIndent && fmLines[end].trim().startsWith('- '))) end++;
  return { start, end };
}

// Set (or insert) a field within a fact item's line range.
function setFactField(fmLines, item, field, value) {
  const fieldIndent = '    ';
  for (let i = item.start; i < item.end; i++) {
    const re = new RegExp('^(\\s*)' + field + ':\\s*.*$');
    if (re.test(fmLines[i])) { fmLines[i] = fieldIndent + field + ': ' + yamlScalar(value); return item; }
  }
  fmLines.splice(item.end, 0, fieldIndent + field + ': ' + yamlScalar(value));
  return { start: item.start, end: item.end + 1 };
}

// A `note` is a vault PATH, never prose.
//
// This was unvalidated, and it cost us three facts on 2026-08-13. A caller passed its `change`
// sentence where `note` belongs; the writer happily created a file NAMED after that sentence at the
// vault root, wrote the fact into it, and returned success. Root files are not indexed, so the fact
// was unreadable from the instant it was written — including the measured cloud-sandbox limits that
// HANDOFF explicitly says not to re-derive, and which cost two live fires per routine to establish.
//
// That is the silent-zero class at the STORAGE layer, and the worst variant of it: invisible from
// both ends, because the write reports ok and the read reports a legitimate-looking empty. So a note
// that cannot be read back must FAIL LOUDLY here rather than succeed into a void.
export const NOTE_PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
export function assertNotePath(note) {
  const n = String(note ?? '').trim();
  if (!n) throw new Error('brain write rejected: `note` is required — a vault path like "knowledge/seen-command.md"');
  if (n.includes('..')) throw new Error(`brain write rejected: \`note\` must not traverse directories — got ${JSON.stringify(n)}`);
  if (!NOTE_PATH_RE.test(n) || n.length > 120) {
    throw new Error(
      `brain write rejected: \`note\` must be a vault path like "knowledge/seen-command.md", not prose — got ${JSON.stringify(n.length > 60 ? `${n.slice(0, 60)}…` : n)}. `
      + 'Passing a sentence here creates an unindexed file at the vault root, so the fact would be written and never readable.',
    );
  }
  return n.endsWith('.md') ? n : `${n}.md`;
}

// Resolve the absolute path of a vault note, creating parent dirs as needed.
function noteAbsPath(vaultPath, note) {
  return join(vaultPath, assertNotePath(note));
}

// The starting text for a note that does not exist yet. Built INSIDE the write lock by its callers,
// where the "does it exist" answer is still true by the time we write.
function defaultNoteText(note) {
  const title = (note.split('/').pop() || note).replace(/\.md$/, '').replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return `---\ntitle: ${title}\ntags: [knowledge]\nupdated: ${todayISO()}\n---\n\n# ${title}\n\n`
    + `_Created by the shared brain writer._\n`;
}

// --- public API ------------------------------------------------------------

// Append a NEW typed fact to a note (creating the note if needed). Does NOT supersede — use
// supersedeFact when replacing the value of an existing open fact. Returns the fact written.
export function addFact(vaultPath, { note, subject, predicate, object, valid_from, valid_to = null,
  confidence = 'medium', source = null, id, change = null, by = null, supersedes = null } = {}) {
  if (!vaultPath) throw new Error('addFact: no vault path (set CHRONOS_VAULT)');
  if (!note) throw new Error('addFact: `note` is required (e.g. "knowledge/seen-command.md")');
  for (const req of ['subject', 'predicate', 'object']) {
    if (subject == null || predicate == null || object == null) throw new Error(`addFact: \`${req}\` is required`);
  }
  const vf = isISODate(valid_from) ? valid_from : todayISO();
  const abs = noteAbsPath(vaultPath, note);
  mkdirSync(dirname(abs), { recursive: true });
  // Locked read-modify-write: two agents appending facts to the same note used to be able to lose
  // one of them, exactly like the timeline day note did.
  return withNoteWrite(abs, (currentText) => {
  const created = currentText === null;
  const text = currentText ?? defaultNoteText(note);
  const { fmLines, body } = splitNote(text);

  // unique id within the note. addFact is the LOW-LEVEL append — deduping (is this a repeat of an
  // open subject+predicate?) is the CALLER's job, done once in `recordFact` below. So the `-2/-3`
  // suffix here is NOT a dedup escape hatch: by the time we reach addFact the caller has already
  // decided this is a genuinely new fact, and the suffix only disambiguates the rare case of two
  // legitimately-different facts whose subject+predicate slugs collide (or an explicit `id` reused).
  const existing = new Set(normalizeFacts(parseFrontmatter(text).data, note).facts.map((f) => f.id));
  let fid = id || `${slug(subject)}-${slug(predicate)}`;
  if (existing.has(fid)) { let n = 2; while (existing.has(`${fid}-${n}`)) n++; fid = `${fid}-${n}`; }

  const fact = { id: fid, subject, predicate, object, valid_from: vf, valid_to,
    confidence, recorded: todayISO(), recorded_at: nowISO() };
  if (source != null) fact.source = source; // omit rather than write `source: null` noise
  // Provenance (omitted when null, like source): who/what wrote it, a plain-language what/why, and
  // the id of the fact this one replaced. These make every datapoint self-explaining downstream.
  if (by != null) fact.by = by;
  if (change != null) fact.change = change;
  if (supersedes != null) fact.supersedes = supersedes;
  const factBlock = serializeFactBlock(fact);

  const block = findFactsBlock(fmLines);
  if (block) {
    fmLines.splice(block.end, 0, ...factBlock.split('\n'));
  } else {
    // add a facts: key at the end of frontmatter
    fmLines.push('facts:', ...factBlock.split('\n'));
  }
  bumpUpdated(fmLines);
  return { content: joinNote(fmLines, body), value: { note, created, fact } };
  });
}

// Supersede an existing open fact: close it (valid_to + invalidated = date) and append a new fact
// with the new value (valid_from = date). The old fact stays in the note as history — this is the
// bi-temporal "never overwrite" rule. Identify the old fact by `id`, or by subject+predicate (the
// currently-open one is chosen). Returns { closed, added }.
export function supersedeFact(vaultPath, { note, id, subject, predicate, object,
  date, confidence = 'high', source = null, change = null, by = null } = {}) {
  if (!vaultPath) throw new Error('supersedeFact: no vault path (set CHRONOS_VAULT)');
  if (!note) throw new Error('supersedeFact: `note` is required');
  if (object == null) throw new Error('supersedeFact: `object` (the new value) is required');
  const when = isISODate(date) ? date : todayISO();
  const abs = noteAbsPath(vaultPath, note);
  if (!existsSync(abs)) throw new Error(`supersedeFact: note not found: ${note}`);
  // Close the old fact under the note's lock, then append the replacement in a SECOND locked
  // section below. Two transactions is deliberate: the lock is not reentrant and addFact takes the
  // same one, so nesting them would deadlock until the lock timeout.
  const target = withNoteWrite(abs, (existing) => {
    const text = existing ?? '';
    const parsed = normalizeFacts(parseFrontmatter(text).data, note).facts;

    // find the target open fact
    let found = null;
    if (id) found = parsed.find((f) => f.id === id);
    else {
      const open = parsed.filter((f) => f.valid_to == null &&
        String(f.subject).toLowerCase() === String(subject).toLowerCase() &&
        String(f.predicate).toLowerCase() === String(predicate).toLowerCase());
      found = open[open.length - 1] || null;
    }
    if (!found) throw new Error(`supersedeFact: no open fact for ${id || subject + ' / ' + predicate} in ${note}`);
    if (String(found.object) === String(object)) throw new Error('supersedeFact: new value equals current value — nothing to supersede');

    // close the old fact in-place
    const { fmLines, body } = splitNote(text);
    const block = findFactsBlock(fmLines);
    const item = findFactItem(fmLines, block, found.id);
    if (!item) throw new Error(`supersedeFact: could not locate fact "${found.id}" in frontmatter`);
    let it = setFactField(fmLines, item, 'valid_to', when);
    setFactField(fmLines, it, 'invalidated', when);
    bumpUpdated(fmLines);
    return { content: joinNote(fmLines, body), value: found };
  });

  // append the new fact (reads the file fresh). `supersedes: target.id` links the new fact to the one
  // it just replaced, so the history chain is explicit rather than inferred from subject+predicate.
  const added = addFact(vaultPath, {
    note, subject: target.subject, predicate: target.predicate, object,
    valid_from: when, confidence, source, change, by, supersedes: target.id,
  });
  return { closed: { ...target, valid_to: when, invalidated: when }, added: added.fact };
}

// Add-or-supersede-or-no-op — the DEDUP decision, in ONE place. This is the single implementation
// both vendored write paths share (lib/brain.mjs `writeOne` and brain/mcp/server.mjs `brain_add_fact`),
// and it is the exact analogue of the `seen` repo's shared writer `recordFact(vault, note, {…})`, so
// the vendored fallback behaves identically to the shared module. Against a note's currently-open
// facts, match subject+predicate CASE-INSENSITIVELY:
//   • no open fact for this subject+predicate → addFact       (a genuinely new fact)
//   • an open fact with a DIFFERENT object     → supersedeFact (close old, append new — bi-temporal)
//   • an open fact with the SAME object        → NO-OP         (nothing changed; return written: 0)
// This is what stops a repeated write of the same subject+predicate from piling up duplicate live
// facts — the bug where `brain_add_fact` plain-appended every time. `openFacts` is an OPTIONAL
// pre-read of the note's open facts: the batch caller (recordFacts) passes it to avoid re-walking the
// vault per fact; omit it and this reads them itself. Returns { written: 0|1, action, … }.
export function recordFact(vaultPath, note, {
  subject, predicate, object, valid_from, confidence, source = null, change = null, by = null,
} = {}, openFacts) {
  if (!vaultPath) throw new Error('recordFact: no vault path (set CHRONOS_VAULT)');
  if (!note) throw new Error('recordFact: `note` is required');
  if (subject == null || predicate == null || object == null) {
    throw new Error('recordFact: `subject`, `predicate`, and `object` are required');
  }
  const obj = String(object);
  const rel = note.endsWith('.md') ? note : `${note}.md`;
  const open = Array.isArray(openFacts) ? openFacts
    : readIndex(vaultPath).facts.filter((f) => String(f.note) === rel && f.valid_to == null);
  const cur = open.find((o) => String(o.subject).toLowerCase() === String(subject).toLowerCase()
    && String(o.predicate).toLowerCase() === String(predicate).toLowerCase());
  if (!cur) {
    const r = addFact(vaultPath, { note, subject, predicate, object: obj, valid_from,
      confidence: confidence || 'medium', source, change, by });
    return { written: 1, action: 'added', note: r.note, created: r.created, fact: r.fact };
  }
  if (String(cur.object) !== obj) {
    const r = supersedeFact(vaultPath, { note, id: cur.id, object: obj, date: valid_from,
      confidence: confidence || 'high', source, change, by });
    return { written: 1, action: 'superseded', closed: r.closed, added: r.added };
  }
  return { written: 0, action: 'noop', fact: cur };
}

// Close an open fact WITHOUT appending a replacement: set valid_to + invalidated = date. This is the
// primitive the dedup cleanup (scripts/brain-dedup.mjs) uses to collapse duplicate LIVE facts — keep
// the newest, retire the rest — because supersedeFact always appends a new value, which is wrong when
// we are simply retiring a duplicate. Bi-temporal-correct: the fact stays in the note as history and
// is never hard-deleted, so as-of queries still see it. Returns { closed }.
export function closeFact(vaultPath, { note, id, date } = {}) {
  if (!vaultPath) throw new Error('closeFact: no vault path (set CHRONOS_VAULT)');
  if (!note) throw new Error('closeFact: `note` is required');
  if (!id) throw new Error('closeFact: `id` is required');
  const when = isISODate(date) ? date : todayISO();
  const abs = noteAbsPath(vaultPath, note);
  if (!existsSync(abs)) throw new Error(`closeFact: note not found: ${note}`);
  return withNoteWrite(abs, (existing) => {
    const { fmLines, body } = splitNote(existing ?? '');
    const block = findFactsBlock(fmLines);
    if (!block) throw new Error(`closeFact: no facts block in ${note}`);
    const item = findFactItem(fmLines, block, id);
    if (!item) throw new Error(`closeFact: could not locate fact "${id}" in ${note}`);
    const it = setFactField(fmLines, item, 'valid_to', when);
    setFactField(fmLines, it, 'invalidated', when);
    bumpUpdated(fmLines);
    return { content: joinNote(fmLines, body),
      value: { closed: { note, id, valid_to: when, invalidated: when } } };
  });
}

// Create a note with its own frontmatter + body if it does not exist yet; never touch an existing
// one. Records that own a note (a ticket in tickets/<id>.md) need a real title and tags rather than
// addFact's generic "knowledge" skeleton. The facts that follow still go through addFact /
// supersedeFact. Same lock + atomic-rename contract as every other write here.
export function ensureNote(vaultPath, { note, title, tags = ['knowledge'], type = null, body = '' } = {}) {
  if (!vaultPath) throw new Error('ensureNote: no vault path (set CHRONOS_VAULT)');
  const abs = noteAbsPath(vaultPath, note);
  mkdirSync(dirname(abs), { recursive: true });
  return withNoteWrite(abs, (existing) => {
    if (existing !== null) return { content: null, value: { note: assertNotePath(note), created: false } };
    const t = String(title || note).replace(/[\r\n]+/g, ' ').trim();
    const fm = [`title: ${yamlScalar(t)}`, `tags: [${tags.map((x) => String(x).replace(/[^\w-]/g, '')).filter(Boolean).join(', ')}]`];
    if (type) fm.push(`type: ${String(type).replace(/[^\w-]/g, '')}`);
    fm.push(`updated: ${todayISO()}`);
    return { content: joinNote(fm, `\n# ${t}\n\n${String(body || '').trim()}\n`), value: { note: assertNotePath(note), created: true } };
  });
}

// Append a locked decision to the append-only ledger (decisions/log.md).
export function logDecision(vaultPath, { title, body = '', date } = {}) {
  if (!vaultPath) throw new Error('logDecision: no vault path (set CHRONOS_VAULT)');
  if (!title) throw new Error('logDecision: `title` is required');
  const when = isISODate(date) ? date : todayISO();
  const abs = join(vaultPath, 'decisions', 'log.md');
  mkdirSync(dirname(abs), { recursive: true });
  // The decision ledger is append-only and written by every agent, so it races the same way a day
  // note does.
  return withNoteWrite(abs, (existing) => {
    const text = existing
      ?? `---\ntitle: Decision Log\ntags: [meta, decision]\nupdated: ${when}\n---\n\n# Decision Log\n\nLocked decisions — do not relitigate.\n`;
    const entry = `\n## ${when} — ${title}\n\n${body.trim()}\n`;
    return { content: text.replace(/\s*$/, '\n') + entry,
      value: { note: 'decisions/log.md', title, date: when } };
  });
}

// Repair the two legacy timeline shapes without touching their append-only body: cloud-created notes
// omitted `type: daily`, while one old day was written with no frontmatter at all. A malformed,
// unterminated frontmatter block is left alone rather than guessed at.
export function ensureTimelineFrontmatter(content, date) {
  const cur = String(content || '');
  const header = `---\ntitle: ${date}\ntags: [timeline]\ntype: daily\ndate: ${date}\nupdated: ${date}\n---`;
  if (!cur.trim()) return `${header}\n\n# ${date}\n`;
  if (!cur.startsWith('---\n')) return `${header}\n\n${cur}`;
  const end = cur.indexOf('\n---', 4);
  if (end < 0) return cur;

  const lines = cur.slice(4, end).split('\n');
  if (!lines.some((line) => /^type:\s*daily\s*$/i.test(line))) {
    const dateAt = lines.findIndex((line) => /^date:\s*/i.test(line));
    lines.splice(dateAt >= 0 ? dateAt : lines.length, 0, 'type: daily');
  }
  if (!lines.some((line) => /^date:\s*/i.test(line))) lines.push(`date: ${date}`);
  return `---\n${lines.join('\n')}\n---${cur.slice(end + 4)}`;
}

// Append an episode line to a day's timeline note (append-only per day). Idempotent by `key`: if a
// line containing `key` already exists in the note, it is not added again. Existing legacy day-note
// headers are repaired before either the idempotent return or the append.
export function appendTimeline(vaultPath, { date, heading = 'Log', text = '', key } = {}) {
  if (!vaultPath) throw new Error('appendTimeline: no vault path (set CHRONOS_VAULT)');
  const when = isISODate(date) ? date : todayISO();
  const abs = join(vaultPath, 'timeline', `${when}.md`);
  mkdirSync(dirname(abs), { recursive: true });
  // The read, the idempotency check and the write are ONE locked section. Splitting them is what
  // let a concurrent writer observe this note mid-truncation and write the empty result back.
  return withNoteWrite(abs, (existing) => {
    const original = existing
      ?? `---\ntitle: ${when}\ntags: [timeline]\ntype: daily\ndate: ${when}\nupdated: ${when}\n---\n\n# ${when}\n`;
    let content = ensureTimelineFrontmatter(original, when);
    if (key && content.includes(key)) {
      const repaired = content !== original;
      return { content: repaired ? content : null,
        value: { note: `timeline/${when}.md`, skipped: true, repaired } };
    }
    const line = `- ${text}`;
    if (new RegExp('^##\\s+' + heading + '\\s*$', 'm').test(content)) {
      content = content.replace(new RegExp('(^##\\s+' + heading + '\\s*$)', 'm'), '$1\n' + line);
    } else {
      content = content.replace(/\s*$/, '\n') + `\n## ${heading}\n${line}\n`;
    }
    return { content, value: { note: `timeline/${when}.md`, added: line } };
  });
}

// Bump/insert the frontmatter `updated:` date.
function bumpUpdated(fmLines) {
  for (let i = 0; i < fmLines.length; i++) {
    if (indentOf(fmLines[i]) === 0 && /^updated:\s*/.test(fmLines[i])) { fmLines[i] = `updated: ${todayISO()}`; return; }
  }
  // insert after title if present, else at top
  const ti = fmLines.findIndex((l) => /^title:\s*/.test(l));
  fmLines.splice(ti >= 0 ? ti + 1 : 0, 0, `updated: ${todayISO()}`);
}

// Convenience: the vault's currently-true facts (valid now), as plain triples.
export function currentFacts(vaultPath) {
  const idx = readIndex(vaultPath);
  // `id` and the bi-temporal bounds are part of the projection on purpose. Without them a caller
  // cannot tell WHEN a fact became true, so anything comparing brain freshness against another source
  // silently no-ops (the Command Center KPI reconcile hit exactly this), `closeFact` cannot be handed
  // an id, and /api/vault reported `valid_from: null` for every fact it served.
  return idx.facts.filter((f) => factTrueAsOf(f, null)).map((f) => ({
    id: f.id, subject: f.subject, predicate: f.predicate, object: f.object,
    confidence: f.confidence, source: f.source, note: f.note,
    valid_from: f.valid_from ?? null, valid_to: f.valid_to ?? null,
  }));
}
