// Chronos — the bi-temporal fact engine for the Obsidian memory vault (memory/).
//
// VENDORED from the `seen` repo — CANONICAL REFERENCE: `<seen>/lib/server/memoryGraph.js`
// (paired with `<seen>/lib/server/writeFact.js`). Copied here so the packaged Chronos.app is
// self-contained. If the engine changes upstream, re-copy; do not hand-edit this copy.
//
// ⚠ SERIALIZER PARITY — READ BEFORE TOUCHING parseScalar / stripComment / unescapeDoubleQuoted.
// This parser and `../memory-write.mjs`'s `yamlScalar` MUST be exact inverses: for every value the
// vault can hold, parse(write(x)) === x and write(parse(write(x))) === write(x). Both repos write
// into the SAME shared brain (the Chronos vault + its Supabase mirror), so any drift here corrupts
// facts for BOTH. This copy drifted once — it stripped the quotes off a double-quoted scalar
// WITHOUT unescaping it, so every value containing a `"` or `\` read back different from what was
// written. Downstream that broke the "unchanged → no-op" check in every writer: the board meeting
// re-superseded the same current_focus value on every single run (verified: 6 identical writes →
// 6 supersedes), and against seen's whole-block re-emitting writer the backslashes compounded
// n → 2n+1 per cycle. Fixed to match seen's `598cf4a`.
// The drift-guard test that pins this is `../memory-write.test.mjs` — it runs the same hostile
// vector set as seen's `lib/server/writeFact.test.mjs`. Keep the two sets in sync.
//
// WHY THIS EXISTS
// The vault (memory/*.md) is the single SOURCE OF TRUTH. This module derives a queryable,
// bi-temporal graph FROM it — it never edits the vault. That one-authority / derived-index
// split is the whole design: it dissolves the "two sources of truth" problem that a
// bidirectional Obsidian<->graph sync creates (see memory/temporal.md).
//
// BI-TEMPORAL MODEL (two independent time axes per fact — this is what beats a flat vault):
//   valid_from / valid_to   — VALID time: when the fact was true in the real world.
//   recorded / invalidated  — TRANSACTION time: when WE learned it / stopped believing it.
// A superseded fact is never deleted: its valid_to (and invalidated) are closed and a new
// fact is appended. So we can answer both "what was TRUE on date X" (valid time) and
// "what did we BELIEVE on date X" (transaction time). Dates are ISO YYYY-MM-DD strings;
// ISO dates sort lexicographically, so plain string compare is correct ordering.
//
// This module is dependency-free (no YAML lib — we parse the vault's controlled frontmatter
// subset ourselves) and does no I/O, so it is unit-testable and reusable by the sync script
// (scripts/memory-sync.mjs) and the local MCP server (memory/mcp/server.mjs).

// ---------------------------------------------------------------------------
// Minimal YAML-subset parser — handles exactly the frontmatter shapes the vault uses:
//   key: scalar            (string / number / bool / null / ISO-date-as-string)
//   key: [a, b, c]         (inline flow array)
//   key:\n  - a\n  - b     (block sequence of scalars)
//   key:\n  - id: x\n    subject: y   (block sequence of mappings — used by `facts:`)
// Deliberately NOT a general YAML parser; it rejects nothing but only understands the above.
// ---------------------------------------------------------------------------

function stripComment(s) {
  // Remove a trailing ` # comment` that is not inside quotes. Our values are simple.
  // Escape-aware: inside "…" a backslash escapes the next char, so `\"` must NOT close the
  // string. Without this, `object: "he said \"hi # there"` terminated the quoted region early
  // and the value was truncated at the `#`.
  let inS = false, inD = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && inD) { i++; continue; } // escaped char inside a double-quoted scalar
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === '#' && !inS && !inD && (i === 0 || s[i - 1] === ' ')) return s.slice(0, i);
  }
  return s;
}

// EXACT inverse of the escaping `JSON.stringify` applies to a string body. The writer
// (memory-write.mjs `yamlScalar`) emits double-quoted scalars via JSON.stringify, so a
// double-quoted scalar MUST be unescaped here or every read→write cycle re-escapes the value and
// backslashes compound (n → 2n+1 per cycle: 1, 3, 7, 15 … — the historical brain-corruption bug).
// Tolerant by design: it never throws. An escape JSON.stringify would never emit (`\q`, a bad
// `\uXXXX`, a lone trailing `\`) is kept VERBATIM rather than guessed at.
function unescapeDoubleQuoted(s) {
  if (!s.includes('\\')) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\') { out += s[i]; continue; }
    const n = s[i + 1];
    if (n === undefined) { out += '\\'; break; } // lone trailing backslash → literal
    if (n === '"' || n === '\\' || n === '/') { out += n; i++; }
    else if (n === 'b') { out += '\b'; i++; }
    else if (n === 'f') { out += '\f'; i++; }
    else if (n === 'n') { out += '\n'; i++; }
    else if (n === 'r') { out += '\r'; i++; }
    else if (n === 't') { out += '\t'; i++; }
    else if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6))) {
      out += String.fromCharCode(parseInt(s.slice(i + 2, i + 6), 16)); i += 5;
    } else out += '\\'; // unknown escape: keep the backslash, let the next char emit itself
  }
  return out;
}

// Exported so the writer can prove a bare emission is lossless before choosing it (see
// memory-write.mjs `yamlScalar`) — that mutual check is what keeps the pair exact inverses.
export function parseScalar(raw) {
  let v = stripComment(String(raw)).trim();
  if (v === '' || v === '~' || v === 'null') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  // `length >= 2` so a lone `"` (which both startsWith and endsWith) isn't sliced into ''.
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return unescapeDoubleQuoted(v.slice(1, -1));
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1);
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^\[.*\]$/.test(v)) {
    const inner = v.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((x) => parseScalar(x));
  }
  return v;
}

const indentOf = (line) => line.length - line.trimStart().length;

// Parse the controlled frontmatter subset into a plain object.
export function parseYamlSubset(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim() !== '');
  const out = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (indentOf(line) !== 0) { i++; continue; }
    const m = line.match(/^([A-Za-z0-9_-]+):(.*)$/);
    if (!m) { i++; continue; }
    const key = m[1];
    const rest = m[2].trim();
    if (rest !== '') { out[key] = parseScalar(rest); i++; continue; }

    // Block value: look ahead at deeper-indented lines.
    const block = [];
    let j = i + 1;
    while (j < lines.length && indentOf(lines[j]) > 0) { block.push(lines[j]); j++; }
    if (block.length === 0) { out[key] = null; i = j; continue; }

    if (block[0].trim().startsWith('- ')) {
      out[key] = parseBlockSequence(block);
    } else {
      out[key] = parseBlockMapping(block);
    }
    i = j;
  }
  return out;
}

function parseBlockMapping(block) {
  const obj = {};
  for (const line of block) {
    const m = line.trim().match(/^([A-Za-z0-9_-]+):(.*)$/);
    if (m) obj[m[1]] = parseScalar(m[2]);
  }
  return obj;
}

function parseBlockSequence(block) {
  const items = [];
  const seqIndent = indentOf(block[0]);
  let cur = null;
  for (const line of block) {
    const ind = indentOf(line);
    const trimmed = line.trim();
    if (ind === seqIndent && trimmed.startsWith('- ')) {
      if (cur !== null) items.push(cur);
      const after = trimmed.slice(2);
      const mm = after.match(/^([A-Za-z0-9_-]+):(.*)$/);
      if (mm) { cur = {}; cur[mm[1]] = parseScalar(mm[2]); } // mapping item
      else { if (cur !== null) items.push(cur); items.push(parseScalar(after)); cur = null; } // scalar item
    } else if (cur !== null) {
      const mm = trimmed.match(/^([A-Za-z0-9_-]+):(.*)$/);
      if (mm) cur[mm[1]] = parseScalar(mm[2]);
    }
  }
  if (cur !== null) items.push(cur);
  return items;
}

// ---------------------------------------------------------------------------
// Note parsing
// ---------------------------------------------------------------------------

// Split a markdown file into { data (frontmatter object), body }.
export function parseFrontmatter(text) {
  const s = String(text).replace(/\r\n/g, '\n');
  const m = s.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { data: {}, body: s };
  return { data: parseYamlSubset(m[1]), body: s.slice(m[0].length) };
}

// Wiki-link targets, `[[target]]` or `[[target|Alias]]`, stripped of a #heading anchor.
export function extractWikiLinks(text) {
  const out = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let m;
  while ((m = re.exec(String(text))) !== null) {
    let target = m[1].split('|')[0].trim();
    if (target.startsWith('#')) continue; // in-note anchor, not an edge
    target = target.split('#')[0].trim();
    if (target) out.push(target);
  }
  return out;
}

// Fact fields. `recorded_at` (full timestamp), `by` (who/what wrote it), `change` (plain-language
// what/why), and `supersedes` (id of the fact this one replaced) are the PROVENANCE fields — additive
// scalars, so the writer/parser serializer-parity rules are unaffected. `version` is parse-only (inert).
const FACT_FIELDS = ['id', 'subject', 'predicate', 'object', 'valid_from', 'valid_to', 'confidence', 'source', 'recorded', 'recorded_at', 'invalidated', 'by', 'change', 'supersedes', 'version'];

// Normalize + validate the `facts:` list of one note. `notePath` is the vault-relative path
// (its stable id). Returns { facts, errors }.
export function normalizeFacts(data, notePath) {
  const facts = [];
  const errors = [];
  const raw = Array.isArray(data && data.facts) ? data.facts : [];
  raw.forEach((f, idx) => {
    if (!f || typeof f !== 'object') { errors.push(`${notePath}: fact #${idx} is not a mapping`); return; }
    for (const req of ['id', 'subject', 'predicate', 'object', 'valid_from']) {
      if (f[req] === undefined || f[req] === null || f[req] === '') {
        errors.push(`${notePath}: fact "${f.id || idx}" missing required field "${req}"`);
      }
    }
    const fact = { note: notePath };
    for (const k of FACT_FIELDS) fact[k] = f[k] === undefined ? null : f[k];
    if (fact.valid_to === undefined) fact.valid_to = null;
    if (fact.confidence == null) fact.confidence = 'medium';
    facts.push(fact);
  });
  return { facts, errors };
}

// Parse a timeline day note into an episode. Canonical notes carry `type: daily` + `date:`, but
// older cloud writers emitted only `tags: [timeline]` + `date:` and one historical day is entirely
// headerless. The vault-relative timeline/YYYY-MM-DD.md path is authoritative enough to recover
// those append-only logs without rewriting their contents.
export function parseTimelineEpisode(data, body, notePath) {
  const pathMatch = /^timeline\/(\d{4}-\d{2}-\d{2})\.md$/i.exec(String(notePath || ''));
  const tags = Array.isArray(data && data.tags) ? data.tags.map((t) => String(t).toLowerCase()) : [];
  const isTimeline = !!pathMatch || (data && data.type === 'daily') || tags.includes('timeline');
  const date = (data && data.date) || (pathMatch && pathMatch[1]);
  if (!isTimeline || !date) return null;
  const sections = {};
  const re = /^##\s+(.+)$/gm;
  let m; const marks = [];
  while ((m = re.exec(body)) !== null) marks.push({ title: m[1].trim(), start: m.index + m[0].length });
  marks.forEach((mk, i) => {
    const end = i + 1 < marks.length ? body.lastIndexOf('\n##', marks[i + 1].start) : body.length;
    sections[mk.title] = body.slice(mk.start, end).trim();
  });
  return {
    id: notePath,
    date: String(date),
    tags: (data && data.tags) || [],
    sessions: (data && data.sessions) || 1,
    sections,
    links: extractWikiLinks(body),
    text: body.trim(),
  };
}

// Build the derived index from a list of { path, text } vault notes.
export function buildIndex(notes) {
  const facts = [];
  const episodes = [];
  const edges = [];
  const entities = [];
  const errors = [];
  for (const note of notes) {
    const { data, body } = parseFrontmatter(note.text);
    const nf = normalizeFacts(data, note.path);
    facts.push(...nf.facts);
    errors.push(...nf.errors);
    const ep = parseTimelineEpisode(data, body, note.path);
    if (ep) episodes.push(ep);
    for (const target of extractWikiLinks(body)) edges.push({ from: note.path, to: target });
    entities.push({
      path: note.path,
      title: (data && data.title) || note.path,
      aliases: (data && data.aliases) || [],
      tags: (data && data.tags) || [],
      updated: (data && data.updated) || (data && data.date) || null,
      factCount: nf.facts.length,
    });
  }
  return { facts, episodes, edges, entities, errors };
}

// ---------------------------------------------------------------------------
// Bi-temporal queries (pure; operate on a facts array)
// ---------------------------------------------------------------------------

// Is a fact true in the real world at `asOf` (ISO date)? valid_from <= asOf < valid_to.
export function factTrueAsOf(fact, asOf) {
  if (!asOf) return fact.valid_to == null; // no date given → "currently true"
  if (fact.valid_from && fact.valid_from > asOf) return false;
  if (fact.valid_to != null && asOf >= fact.valid_to) return false;
  return true;
}

const matchesQuery = (fact, q) => {
  if (!q) return true;
  const hay = `${fact.subject} ${fact.predicate} ${fact.object} ${fact.id}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((t) => hay.includes(t));
};

// Point-in-time fact search. opts: { query, asOf, subject, predicate }.
export function searchFacts(facts, opts = {}) {
  const { query, asOf, subject, predicate } = opts;
  return facts.filter((f) =>
    factTrueAsOf(f, asOf) &&
    matchesQuery(f, query) &&
    (!subject || String(f.subject).toLowerCase() === String(subject).toLowerCase()) &&
    (!predicate || String(f.predicate).toLowerCase() === String(predicate).toLowerCase()));
}

// Transaction-time delta: facts we RECORDED or INVALIDATED on/after `since` (ISO date).
// This is the "what changed since last session" query.
// NEWEST FIRST, always — kept in step with <seen>/lib/server/memoryGraph.js. Index order is note-path
// order; an unsorted list handed to a capped consumer drops whichever changes live in a late-sorting
// note, routinely the most recent (the cloud briefing did exactly this until 2026-09-18).
const newestFirst = (key) => (a, b) => String(b[key] || '').localeCompare(String(a[key] || ''))
  || String(b.recorded_at || '').localeCompare(String(a.recorded_at || ''));
export function whatsChanged(facts, since) {
  const added = facts.filter((f) => f.recorded && f.recorded >= since).sort(newestFirst('recorded'));
  const invalidated = facts.filter((f) => f.invalidated && f.invalidated >= since).sort(newestFirst('invalidated'));
  return { added, invalidated };
}

// Contradiction / hygiene check: same subject+predicate, overlapping VALID windows, different
// object. Overlapping active facts usually mean a supersede that forgot to close valid_to.
export function findContradictions(facts) {
  const groups = new Map();
  for (const f of facts) {
    const key = `${String(f.subject).toLowerCase()}|${String(f.predicate).toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  const conflicts = [];
  for (const group of groups.values()) {
    for (let a = 0; a < group.length; a++) {
      for (let b = a + 1; b < group.length; b++) {
        const x = group[a], y = group[b];
        if (String(x.object) === String(y.object)) continue;
        if (windowsOverlap(x, y)) conflicts.push({ a: x, b: y });
      }
    }
  }
  return conflicts;
}

function windowsOverlap(x, y) {
  // [valid_from, valid_to) half-open; null valid_to = open-ended (+infinity).
  const xEnd = x.valid_to == null ? '9999-12-31' : x.valid_to;
  const yEnd = y.valid_to == null ? '9999-12-31' : y.valid_to;
  const xStart = x.valid_from || '0000-01-01';
  const yStart = y.valid_from || '0000-01-01';
  return xStart < yEnd && yStart < xEnd;
}

// Episodes in a date range (inclusive). from/to are ISO dates or null (open).
export function getTimeline(episodes, { from = null, to = null } = {}) {
  return episodes
    .filter((e) => (!from || e.date >= from) && (!to || e.date <= to))
    .sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first
}

// Everything known about one entity: its note, current + historical facts, and edges.
export function getEntity(index, name) {
  const q = String(name).toLowerCase();
  const entity = index.entities.find((e) =>
    e.path.toLowerCase() === q ||
    String(e.title).toLowerCase() === q ||
    e.path.toLowerCase().endsWith(`/${q}.md`) ||
    e.path.toLowerCase() === `${q}.md` ||
    (Array.isArray(e.aliases) && e.aliases.some((a) => String(a).toLowerCase() === q)));
  if (!entity) return null;
  const subjectName = String(entity.title);
  const facts = index.facts.filter((f) =>
    f.note === entity.path ||
    String(f.subject).toLowerCase() === subjectName.toLowerCase() ||
    String(f.subject).toLowerCase() === q);
  const links = index.edges.filter((e) => e.from === entity.path).map((e) => e.to);
  const backlinks = index.edges
    .filter((e) => e.to.toLowerCase() === q || e.to.toLowerCase().endsWith(`/${q}`))
    .map((e) => e.from);
  return { entity, facts, links, backlinks };
}
