#!/usr/bin/env node
// Chronos cloud — the ONLINE half of the brain. Chronos remains the one brain layer every app
// writes through (the shared writer); this module is how that layer DELEGATES storage to Supabase:
//
//   • brain_notes    — the full vault, note-for-note (verbatim markdown). Complete restore on any
//                      machine: `npm run brain:restore` rebuilds the vault from the cloud.
//   • brain_facts    — every bi-temporal typed fact, queryable online (phone, future clients).
//   • brain_timeline — dated episode sections, queryable ("what happened yesterday").
//
// The local vault stays the fast working copy that Chronos.app visualizes; the cloud is the durable
// online truth. Push after writes (the board meeting does this automatically); pull to restore.
// Dependency-free (fetch + PostgREST, service key). RLS is on with no policies, so ONLY the service
// key can read/write the brain — it is never publicly accessible.
//
// BOTH DIRECTIONS ARE GUARDED. Neither side may silently destroy the other's writes.
//
// PUSH: `pushBrain` upserts the local vault over the cloud copy, so an unconditional push from the
// Mac can destroy writes another client made online since this machine last synced. Every push
// compares the cloud row against a locally persisted watermark and SKIPS (loudly, by name) any note
// that moved remotely and differs locally, unless `--force`/{force:true}. Identical content is never
// a conflict. See "Push conflicts" in SHARED_BRAIN.md.
//
// PULL: `syncDown` used to write the cloud copy over local whenever the two differed — with no test
// of which side was newer. Since a local write is BY DEFINITION a difference, Chronos (which polls
// syncDown and watches the vault) destroyed every locally written fact within one poll, and then
// advanced the push watermark so the write could never be pushed either. Local always lost, twice.
// Now the watermark also carries a HASH of the last-reconciled content, which is what makes "local is
// stale" distinguishable from "local was edited here". A local edit is never overwritten: the two
// fact sets are MERGED as a union (see mergeNoteText), and anything unmergeable preserves local and
// is reported. `force: true` opts back into take-the-cloud-copy for callers that really want it.
//
// EGRESS. Both directions used to download the WHOLE vault (`select=path,content,updated_at`, no
// filter — 1.15 MB measured) on every call, and Chronos called syncDown every 30s with an app-
// suspension blocker keeping it alive: ~28–100 GB/month against a 5 GB Free-plan egress quota, which
// the org blew through in October 2026. Both directions are now INCREMENTAL — see "Incremental
// sync" above syncDown for the request sequence and the clock-skew reasoning. The guards above are
// unchanged: every note that is fetched goes through exactly the same reconcile rules as before.
//
// CLI:  node brain/lib/cloud.mjs status | push [--force] | pull [--overwrite]

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readNotes, readIndex } from './vault.mjs';
import { withNoteWrite } from './vault-write.mjs';
import { resolveSources, SEEN_COMMAND_ROOT } from './sources.mjs';

// Load .env via the repo config when available (CLI runs); fall back to process.env (packaged apps).
try { await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib', 'config.mjs')).href); } catch { /* env must be pre-set */ }

const env = (k) => { const v = process.env[k]; return v && v.trim() ? v.trim() : null; };
const envMs = (k, d) => { const n = Number(env(k)); return Number.isFinite(n) && n > 0 ? n : d; };
const supaUrl = () => (env('SUPABASE_URL') || '').replace(/\/+$/, '');
const supaKey = () => env('SUPABASE_SERVICE_KEY') || env('SUPABASE_SERVICE_ROLE_KEY');

export const cloudConfigured = () => !!(supaUrl() && supaKey());

async function rest(path, { method = 'GET', body, prefer } = {}) {
  const key = supaKey();
  const res = await fetch(`${supaUrl()}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key, authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      ...(prefer ? { prefer } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`supabase ${method} ${path.split('?')[0]} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const UPSERT = 'resolution=merge-duplicates,return=minimal';


// ---- sync watermark --------------------------------------------------------
// Per-note record of the remote `updated_at` this machine last RECONCILED WITH — set by syncDown /
// pullBrain (versions we pulled in) and by pushBrain (versions we just wrote). A push may overwrite
// a cloud note only while that watermark still matches the cloud row; if the row moved, somebody
// else wrote it after our last sync and pushing the local copy over it would destroy their work.
//
// It lives OUTSIDE the vault on purpose — it is per-machine runtime state, not brain content, and
// must never be pushed as a note. Path mirrors lib/paths.mjs `seenHome()` (SEEN_HOME when packaged,
// else the repo) but is computed locally: the packaged Chronos.app bundles only brain/lib/**, so
// this module must not import from the repo's lib/.
const syncStatePath = () => {
  const home = (process.env.SEEN_HOME && process.env.SEEN_HOME.trim()) || SEEN_COMMAND_ROOT;
  // Defense-in-depth: NEVER write runtime state inside a read-only .app bundle — it invalidates the
  // code-signature seal on every sync ("a sealed resource is missing or invalid"). If we somehow
  // resolved to a bundle (e.g. a packaged process that didn't set SEEN_HOME), use the per-user dir.
  const safe = home.includes('.app/Contents/') ? join(homedir(), 'Library', 'Application Support', 'seen-command') : home;
  return join(safe, 'data', 'cloud-sync.json');
};

// The state file holds three things, all per-machine:
//   • notes     — the per-note reconcile watermarks (below)
//   • cursor    — { pollFrom, fullAt, deepAt }: LOCAL-clock ms of the last successful fast / full /
//                 deep pull (see "Incremental sync"). Absent → the next pull is a deep one.
//   • evaluated — { path: updated_at } of remote versions syncDown fetched and could NOT reconcile
//                 (conflicts), so the 30–60s fast pass does not re-download them every tick. The
//                 slow passes ignore it, so a conflict is still re-checked every ~15 minutes.
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
function readSyncState(file) {
  try {
    const j = JSON.parse(readFileSync(file || syncStatePath(), 'utf8'));
    return {
      notes: isObj(j && j.notes) ? j.notes : {},
      cursor: isObj(j && j.cursor) ? j.cursor : {},
      evaluated: isObj(j && j.evaluated) ? j.evaluated : {},
    };
  } catch { return { notes: {}, cursor: {}, evaluated: {} }; } // absent/corrupt → no watermarks → every differing note is a conflict, and the next pull is deep
}
function readWatermarks(file) { return readSyncState(file).notes; }

// A watermark records the version of a note this machine last RECONCILED with the cloud: the cloud
// row's `updated_at` (used by the push guard) AND a hash of that exact content (used by the pull
// guard). The hash is what makes "local is merely stale" distinguishable from "local was edited here
// and must not be destroyed" — without it, syncDown cannot tell the two apart and used to assume
// stale, which silently ate every local write. Legacy watermarks were a bare `updated_at` string;
// they still read correctly and simply carry no hash (treated as "provenance unknown" → never
// overwrite), so an existing cloud-sync.json keeps working and self-heals on the next reconcile.
//
// `rsha` (added with incremental sync) is the hash of the CLOUD content at version `at`. It is what
// lets a push decide "identical / safe to push" for a note whose cloud row has not moved WITHOUT
// downloading that note: `sha` alone cannot, because after a merge or an 'ahead' reconcile the local
// text deliberately differs from the cloud text. A mark without `rsha` (legacy, or `verify`) simply
// costs one content fetch the next time it matters, and is then upgraded.
// `verify: true` marks a note whose post-push cloud stamp was not the one we sent (a DB trigger, or
// another writer landing in between) — the next pull fetches its content once instead of trusting
// the timestamp.
const hashOf = (text) => createHash('sha256').update(String(text)).digest('hex').slice(0, 32);
const mkMark = (updatedAt, contentHash, remoteHash = null, extra = null) =>
  ({ at: String(updatedAt || ''), sha: contentHash, ...(remoteHash ? { rsha: remoteHash } : {}), ...(extra || {}) });
const markAt = (m) => (m && typeof m === 'object' ? String(m.at || '') : (m ? String(m) : ''));
const markSha = (m) => (m && typeof m === 'object' && m.sha ? String(m.sha) : null);
const markRsha = (m) => (m && typeof m === 'object' && m.rsha && !m.verify ? String(m.rsha) : null);

// Canonical form of a Postgres/ISO timestamp, for EXACT equality and ordering: UTC, microsecond
// precision, trailing Z. PostgREST returns `2026-10-17T12:00:00.123+00:00` while this module sends
// `…123Z`, and Postgres drops trailing fractional zeros — comparing the raw strings made one instant
// look like two (or, with `>`, ordered '+' before 'Z'). Unparseable input is returned unchanged so it
// can still compare equal to itself and never to anything else.
export function tsCanon(s) {
  if (s == null || s === '') return '';
  const str = String(s).trim();
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i.exec(str);
  if (!m) return str;
  let off = (m[4] || 'Z').toUpperCase();
  if (off !== 'Z') off = off.length === 3 ? `${off}:00` : off.includes(':') ? off : `${off.slice(0, 3)}:${off.slice(3)}`;
  const ms = Date.parse(`${m[1]}T${m[2]}${off}`);
  if (!Number.isFinite(ms)) return str;
  return `${new Date(ms).toISOString().slice(0, 19)}.${(m[3] || '').padEnd(6, '0').slice(0, 6)}Z`;
}
const sameStamp = (a, b) => { const x = tsCanon(a); return x !== '' && x === tsCanon(b); };

// What the cloud content of row `r` hashes to, WITHOUT downloading it when possible: the row's own
// content if it was fetched, else the mark's remote hash — valid only while the row still carries the
// exact stamp the mark recorded. null = unknown → the caller must fetch the content.
const knownRemoteHash = (r, mark) => {
  if (typeof r.content === 'string') return hashOf(r.content);
  const rsha = markRsha(mark);
  return rsha && sameStamp(r.updated_at, markAt(mark)) ? rsha : null;
};

function writeSyncState(state, file) {
  const p = file || syncStatePath();
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({
      syncedAt: new Date().toISOString(), notes: state.notes || {},
      cursor: state.cursor || {}, evaluated: state.evaluated || {},
    }, null, 2));
  } catch (e) {
    process.stderr.write(`[cloud] could not persist the sync watermark (${e.message}) — the next push will flag every differing note as a conflict\n`);
  }
}
// Push/pull persist marks only; the pull cursor and the conflict memo already on disk are carried
// over untouched. (A cursor that comes back OLDER than another process just wrote is always safe: it
// only widens the next fast pull's window.)
function writeWatermarks(marks, file) {
  const prev = readSyncState(file);
  writeSyncState({ ...prev, notes: marks }, file);
}

// ---- bounded reads ---------------------------------------------------------
// PostgREST (Supabase `max-rows`, default 1000) silently CAPS every response. The old unpaged
// `select=path,content,updated_at` would have dropped every note past the 1000th without a word.
// Every multi-row read here is therefore paged by keyset on `path` (stable under concurrent writes —
// a row cannot move between pages the way it can under offset paging) and continues until a page
// brings nothing new, so a server whose cap is LOWER than our `limit` is still read completely.
const NOTE_PAGE = 1000;     // path,updated_at listing page (~100 B a row)
const CONTENT_PAGE = 200;   // full-content page (deep pass / restore)
const IN_CHUNK = 40;        // paths per `path=in.(…)` request — keeps the URL well under any proxy limit
const FAST_MAX = 100;       // a fast pull returning this many rows falls back to the paged listing
const q = encodeURIComponent;
// PostgREST in-list with every value double-quoted, so a path containing a comma, dot or parenthesis
// cannot be misparsed. Inside quotes, `"` and `\` are backslash-escaped.
const inList = (paths) => q(`(${paths.map((p) => `"${String(p).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')})`);

async function pageNotes(restFn, select, pageSize = NOTE_PAGE) {
  const out = [];
  const seen = new Set();
  let after = null;
  for (;;) {
    const page = (await restFn(`brain_notes?select=${select}&order=path.asc&limit=${pageSize}${after != null ? `&path=gt.${q(after)}` : ''}`)) || [];
    const fresh = page.filter((r) => r && r.path != null && !seen.has(r.path));
    for (const r of fresh) { seen.add(r.path); out.push(r); }
    // Done when the server has nothing more. This also ends on a page that only repeats rows already
    // read, so a REST layer that ignored the keyset filter can never spin this forever.
    if (!fresh.length) return out;
    after = fresh[fresh.length - 1].path;
  }
}

// Fetch exactly these notes (and nothing else, even if the REST layer over-returns).
async function fetchNoteRows(restFn, paths, select = 'path,content,updated_at') {
  const want = new Set(paths);
  const out = new Map();
  for (const batch of chunk([...want], IN_CHUNK)) {
    for (const r of (await restFn(`brain_notes?select=${select}&path=in.${inList(batch)}`)) || []) {
      if (r && want.has(r.path)) out.set(r.path, r);
    }
  }
  return [...out.values()];
}

// Split a timeline day-note body into its `## heading` + body sections.
export function parseTimelineSections(content) {
  const out = [];
  const parts = String(content || '').split(/^## +/m).slice(1); // drop preamble
  for (const part of parts) {
    const nl = part.indexOf('\n');
    const heading = (nl === -1 ? part : part.slice(0, nl)).trim();
    const body = (nl === -1 ? '' : part.slice(nl + 1)).trim();
    if (heading && body) out.push({ heading, body });
  }
  return out;
}

// Parse a timeline day-note into { date, heading, body } sections for the queryable table.
function timelineSections(path, content) {
  const m = path.match(/timeline\/(\d{4}-\d{2}-\d{2})\.md$/);
  if (!m) return [];
  return parseTimelineSections(content).map((s) => ({ date: m[1], ...s }));
}

// ---- timeline PULL --------------------------------------------------------------------------------
// brain_timeline was push-only, and that was a hole: pushing DERIVES rows from local day-notes, but a
// cloud session — or either 4am cloud routine — INSERTS rows directly. Those had no way home. syncDown
// pulled brain_notes alone, so a digest written in the cloud sat in a table this Mac never read and
// Chronos never rendered: work happened overnight and left no visible trace locally.
//
// The pull is APPEND-ONLY and keyed on (heading, md5 of the trimmed body). An entry we already hold is
// skipped; one we lack is appended verbatim. It never rewrites, reorders, or drops what is already in
// the file — this is an append-only log, so two similar headings are strictly better than a lost entry.
// ONE definition of the entry key, used by both phases: the cheap phase already has a body hash from
// the server, the thorough phase hashes the body itself, and the two must agree byte for byte or the
// pull re-fetches (or worse, re-appends) forever. Neither side may rebuild this format by hand.
// The separator stays printable ASCII deliberately: a NUL byte here lives in this module's SOURCE
// text and makes grep/ripgrep treat the whole file as binary, silently breaking codebase search.
const md5 = (text) => createHash('md5').update(String(text)).digest('hex');
const entryKey = (heading, bodyHash) => `${String(heading || '').trim()} :: ${bodyHash}`;
const sectionKey = (heading, body) => entryKey(heading, md5(String(body).trim()));

export function planTimelinePull(localText, rows, date) {
  const cur = String(localText || '');
  const have = new Set(parseTimelineSections(cur).map((s) => sectionKey(s.heading, s.body)));
  const add = [];
  for (const r of rows || []) {
    const heading = String(r.heading || '').trim();
    const body = String(r.body || '').trim();
    if (!heading || !body) continue;
    const key = sectionKey(heading, body);
    if (have.has(key)) continue;
    have.add(key); // also de-dupes within the incoming batch
    add.push({ heading, body });
  }
  if (!add.length) return null;
  // A day-note we have never seen starts with the same frontmatter the vault's own notes carry, so
  // it indexes and renders identically to a locally authored day.
  const head = cur.trim() || `---\ntitle: ${date}\ntype: daily\ndate: ${date}\ntags: [timeline]\n---`;
  const body = add.map((s) => `## ${s.heading}\n\n${s.body}`).join('\n\n');
  return { text: `${head.trimEnd()}\n\n${body}\n`, added: add.length };
}

// Decide, per note, whether pushing the local copy over the cloud copy is safe. PURE + exported so
// the conflict rule is unit-testable without any network. Rules, in order:
//   1. no cloud row yet                  → push (nothing to clobber)
//   2. cloud content === local content   → UNCHANGED: skip the write entirely. This used to push "as a
//      no-op", but an upsert is not a no-op — it rewrites the row's updated_at. An hourly sync was
//      therefore stamping ALL 60 notes with one identical timestamp every cycle, which (a) destroyed
//      updated_at as a truthful per-note change signal for every other brain client (a cloud session
//      doing forensics saw "wholesale vault push" where nothing had changed), and (b) made other
//      machines' push guards see phantom remote movement on every note. Caught live by a seen session
//      on 2026-08-12.
//   3. cloud row moved since our last reconcile (updated_at != watermark, or NO watermark at all —
//      this machine has never synced that note) → CONFLICT: skip unless force. This was `>`, which let
//      a row stamped by a writer whose clock runs BEHIND ours read as "not moved" and be overwritten;
//      any difference from the reconciled stamp means somebody wrote it.
//   4. otherwise the cloud row is still the version we last saw → push (our edits sit on top of it)
//
// A cloud row may arrive WITHOUT `content` (pushBrain reads only path,updated_at): rule 2 then uses
// the mark's remote hash, which is valid only while the row still carries the stamp the mark
// recorded. If neither is available the note is held as a conflict rather than guessed at — pushBrain
// fetches content for exactly those notes before planning, so this is a backstop, not a path.
export function planNotePush(notes, remoteByPath, marks = {}, { force = false } = {}) {
  const push = [];
  const conflicts = [];
  const unchanged = [];
  for (const n of notes) {
    const r = remoteByPath.get(n.path);
    if (!r) { push.push(n); continue; }
    const rHash = knownRemoteHash(r, marks[n.path]);
    if (rHash !== null && rHash === hashOf(n.text)) { unchanged.push({ path: n.path, text: n.text, updated_at: r.updated_at }); continue; }
    const seen = markAt(marks[n.path]) || null;
    const movedRemotely = !seen || !sameStamp(r.updated_at, seen) || rHash === null;
    if (movedRemotely && !force) {
      conflicts.push({ path: n.path, remoteUpdatedAt: r.updated_at || null, lastSynced: seen });
      continue;
    }
    push.push(n);
  }
  return { push, conflicts, unchanged };
}

function warnConflicts(conflicts) {
  if (!conflicts.length) return;
  process.stderr.write(
    `\n[cloud] ⚠ PUSH GUARD — ${conflicts.length} note(s) changed in the cloud after this machine last synced and differ locally. NOT pushed:\n`
    + conflicts.map((c) => `    • ${c.path}   (cloud updated_at ${c.remoteUpdatedAt || 'unknown'}; last reconciled here: ${c.lastSynced || 'never'})\n`).join('')
    + `  Fix: pull the cloud copy first (\`npm run brain:restore\` / syncDown), reconcile, then push again.\n`
    + `  To overwrite the cloud with THIS machine's copy anyway: \`node brain/lib/cloud.mjs push --force\`.\n\n`);
}

// Push the whole brain (notes + facts + timeline sections) to Supabase. Idempotent upserts, and
// clobber-guarded: notes the cloud changed since our last sync are skipped and listed (see
// planNotePush) unless `force` is set. Facts belonging to a skipped note are skipped with it — they
// are derived from that note's text, so pushing them would reintroduce the stale value anyway.
// `rest`/`statePath` are test seams (a mocked REST layer, a temp watermark file); production
// callers pass neither.
export async function pushBrain(vaultPath, { force = false, rest: restFn = rest, statePath } = {}) {
  if (!cloudConfigured()) throw new Error('cloud not configured (set SUPABASE_URL + SUPABASE_SERVICE_KEY)');
  const v = vaultPath || resolveSources().vaultPath;
  if (!v) throw new Error('no vault found (set CHRONOS_VAULT)');
  const now = new Date().toISOString();

  const all = readNotes(v);

  // What does the cloud hold right now? Only path + updated_at (~100 B a note) — this used to pull
  // every note's full content (the whole vault, 1.15 MB) on every push just to compare it. Content is
  // fetched ONLY for notes whose cloud hash cannot be known from the reconcile mark: the row moved
  // since we last reconciled it, or the mark predates `rsha`. In steady state that is nothing.
  const marks = readWatermarks(statePath);
  const remoteByPath = new Map();
  for (const r of await pageNotes(restFn, 'path,updated_at')) remoteByPath.set(r.path, { path: r.path, updated_at: r.updated_at });
  const needContent = all
    .filter((n) => { const r = remoteByPath.get(n.path); return r && knownRemoteHash(r, marks[n.path]) === null; })
    .map((n) => n.path);
  // Content and stamp come from the SAME row read, so a note that moved between the listing and this
  // fetch is judged on its newer, consistent version.
  for (const r of needContent.length ? await fetchNoteRows(restFn, needContent) : []) remoteByPath.set(r.path, r);

  const { push: notes, conflicts, unchanged } = planNotePush(all, remoteByPath, marks, { force });
  warnConflicts(conflicts);

  // Unchanged notes are NOT re-upserted (see planNotePush rule 2 — an upsert rewrites updated_at and
  // fabricates a change signal for every other client). Their watermarks are still reconciled to the
  // cloud row they already match, so the push guard cannot later mistake them for conflicts.
  for (const u of unchanged) { const h = hashOf(u.text); marks[u.path] = mkMark(u.updated_at, h, h); }

  // One transaction per note owns the canonical text AND its exact derived fact mirror
  // (rpc/brain_replace_note, the same call the cloud gateway's writer makes). This used to be two
  // phases — upsert every note, THEN upsert the facts — so a push that died between them left the
  // cloud holding a note whose facts the mirror had never heard of, and an upsert could never remove
  // a mirror row whose fact had left its note. Found live 2026-09-18: a note pushed 09-10 11:42 whose
  // mirror had last synced at 06:35, which is why `counts` and `briefing.counts` disagreed.
  const idx = readIndex(v);
  const factsByNote = new Map();
  for (const f of idx.facts) {
    const key = String(f.note);
    if (!factsByNote.has(key)) factsByNote.set(key, []);
    factsByNote.get(key).push({
      note: f.note, id: f.id, subject: String(f.subject), predicate: String(f.predicate), object: String(f.object),
      valid_from: f.valid_from || null, valid_to: f.valid_to || null,
      confidence: f.confidence || null, source: f.source || null,
      recorded: f.recorded || null, recorded_at: f.recorded_at || null, invalidated: f.invalidated || null,
      by: f.by || null, change: f.change || null, supersedes: f.supersedes || null, synced_at: now,
    });
  }
  const facts = notes.flatMap((n) => factsByNote.get(n.path) || []);
  let atomic = true;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    try {
      await restFn('rpc/brain_replace_note', {
        method: 'POST', prefer: 'return=minimal',
        body: { p_path: n.path, p_content: n.text, p_updated_at: now, p_facts: factsByNote.get(n.path) || [] },
      });
    } catch (e) {
      // A database without the function (PGRST202) must not freeze the whole push — a frozen cloud
      // brain is the worse failure. Fall back to the two-phase path for the REST of this push and say
      // so loudly; nothing has been half-written, because each RPC is all-or-nothing.
      // PGRST202 = PostgREST "function not found". Match the CODE only: every rest() error names the
      // path, so matching the function name would swallow a deadlock or a constraint failure too.
      if (!/PGRST202/.test(String(e && e.message))) throw e;
      console.warn('[chronos] rpc/brain_replace_note is missing — pushing non-atomically. Apply the atomic_brain_note_replace migration.');
      atomic = false;
      const rest2 = notes.slice(i);
      for (const batch of chunk(rest2.map((m) => ({ path: m.path, content: m.text, updated_at: now })), 100)) {
        await restFn('brain_notes', { method: 'POST', body: batch, prefer: UPSERT });
      }
      // (note, id) is brain_facts' composite PK — VERIFIED 2026-08-11 against the live project — so
      // this target is correct; do not "simplify" it to on_conflict=id.
      for (const batch of chunk(rest2.flatMap((m) => factsByNote.get(m.path) || []), 200)) {
        await restFn('brain_facts?on_conflict=note,id', { method: 'POST', body: batch, prefer: UPSERT });
      }
      break;
    }
  }

  // Timeline rows are append-only (ignore-duplicates), so they can never clobber. History of this
  // block, because it has bitten twice: the unique key used to be (date, heading, body), and Postgres
  // caps a btree entry at ~2704 bytes — one oversized section threw 54000, aborted the ENTIRE push
  // (froze the cloud brain for a week), and was then worked around by SKIPPING oversized sections,
  // which silently withheld seven of them. Since migration 069 the key is (date, heading, body_md5)
  // — body_md5 is a STORED generated column — so any body size is indexable, exact-duplicate
  // detection survives, nothing is skipped, and the on_conflict target below matches the new index.
  // body_md5 is never sent in the payload: Postgres computes it, and PostgREST rejects writes to
  // generated columns.
  const episodes = notes.flatMap((n) => timelineSections(n.path, n.text));
  for (const batch of chunk(episodes, 200)) {
    await restFn('brain_timeline?on_conflict=date,heading,body_md5', { method: 'POST', body: batch, prefer: 'resolution=ignore-duplicates,return=minimal' });
  }

  // Re-read the authoritative updated_at of what we just wrote rather than assuming the row kept the
  // `now` we sent (a DB default/trigger may set its own). Watermarks for SKIPPED notes are left
  // untouched, so they stay flagged until someone actually reconciles them.
  // Only the rows we pushed are re-read (this used to list the whole table again).
  if (notes.length) {
    const after = new Map();
    for (const r of await fetchNoteRows(restFn, notes.map((n) => n.path), 'path,updated_at')) after.set(r.path, r.updated_at);
    // Hash the exact text we pushed: after a successful push, local and cloud hold THIS content, so
    // the pull guard must treat it as reconciled rather than as a local edit to protect.
    // The remote hash is recorded only when the row carries EXACTLY the stamp we sent — proof the row
    // is our write. Otherwise (a DB trigger restamped it, or another writer landed in between) the
    // mark keeps the server's stamp but no remote hash, plus `verify`, so the next pull downloads that
    // one note once rather than trusting a timestamp it cannot attribute.
    for (const n of notes) {
      const h = hashOf(n.text);
      const at = after.get(n.path);
      marks[n.path] = at != null && sameStamp(at, now) ? mkMark(at, h, h) : mkMark(at ?? now, h, null, { verify: true });
    }
  }
  // Persist when ANYTHING reconciled — pushed or unchanged. An all-unchanged push used to skip this
  // write entirely, leaving the unchanged notes' watermarks stale on disk.
  if (notes.length || unchanged.length) writeWatermarks(marks, statePath);

  return { notes: notes.length, unchanged: unchanged.length, facts: facts.length, episodes: episodes.length, skipped: conflicts, atomic };
}

// Restore the vault from the cloud mirror. Writes any note that's missing locally; --overwrite
// replaces local notes with the cloud copy (fresh-machine restore).
// Watermarks are recorded ONLY for notes actually written: a note kept because a local copy already
// existed has not been reconciled, so the push guard must still treat it as a possible conflict.
export async function pullBrain(vaultPath, { overwrite = false, rest: restFn = rest, statePath } = {}) {
  if (!cloudConfigured()) throw new Error('cloud not configured');
  const v = vaultPath || resolveSources().vaultPath || env('CHRONOS_VAULT');
  if (!v) throw new Error('no vault path (set CHRONOS_VAULT to where the vault should live)');
  // A restore is a deliberate full download — but paged, so a vault past the server's row cap is
  // restored completely instead of silently truncated at row 1000.
  const rows = await pageNotes(restFn, 'path,content,updated_at', CONTENT_PAGE);
  const marks = readWatermarks(statePath);
  let written = 0, skipped = 0;
  for (const r of rows || []) {
    const abs = join(v, r.path);
    if (existsSync(abs) && !overwrite) { skipped++; continue; }
    mkdirSync(dirname(abs), { recursive: true });
    withNoteWrite(abs, () => ({ content: r.content, value: true }));
    const h = hashOf(r.content);
    marks[r.path] = mkMark(r.updated_at, h, h);
    written++;
  }
  if (written) writeWatermarks(marks, statePath);
  return { cloudNotes: (rows || []).length, written, skipped };
}

// ---- note merge (the pull side of "never clobber") -------------------------

// Split a note into { fm, body } — frontmatter LINES without the fences, plus the rest verbatim.
// Returns null when there is no frontmatter fence, which is the signal not to attempt a merge.
function splitNoteText(text) {
  const lines = String(text).split('\n');
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end === -1) return null;
  return { fm: lines.slice(1, end), body: lines.slice(end + 1).join('\n') };
}

// Locate the top-level `facts:` key and the extent of its list. The list ends at the first line that
// begins a new top-level key (i.e. a non-whitespace first character).
function factsRegion(fm) {
  const start = fm.findIndex((l) => /^facts:\s*$/.test(l));
  if (start === -1) return null;
  let end = fm.length;
  for (let i = start + 1; i < fm.length; i++) if (/^\S/.test(fm[i])) { end = i; break; }
  return { start, end };
}

// Split a facts block into [{ id, lines }]. An entry starts with `  - ` and runs until the next one.
function factEntries(fm, region) {
  const out = [];
  for (let i = region.start + 1; i < region.end; i++) {
    if (/^\s+-\s/.test(fm[i])) out.push({ id: null, lines: [fm[i]] });
    else if (out.length) out[out.length - 1].lines.push(fm[i]);
  }
  for (const e of out) {
    const m = e.lines.join('\n').match(/^\s*(?:-\s*)?id:\s*(.+)$/m);
    e.id = m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
  }
  return out;
}

// Is a raw fact entry CLOSED? A fact is retired by `valid_to` (and `invalidated`) carrying a real date
// rather than null. Read from the raw lines because this merge is deliberately text-level and lossless.
function entryIsClosed(entry) {
  for (const line of entry.lines) {
    const m = /^\s*(?:-\s*)?valid_to:\s*(.+?)\s*$/.exec(line);
    if (m) {
      const v = m[1].replace(/^["']|["']$/g, '').trim();
      return !!v && v !== 'null' && v !== '~';
    }
  }
  return false;
}

const updatedOf = (fm) => {
  const l = fm.find((x) => /^updated:\s/.test(x));
  return l ? l.replace(/^updated:\s*/, '').trim() : '';
};

// Merge a remote note INTO the local one so that NEITHER side wins outright: the union of typed facts
// by id, local order preserved, remote-only facts appended, and `updated:` advanced to the later of
// the two. This is the "communicate instead of overwrite" path — both machines' facts survive.
//
// Returns the merged text, or null when a safe merge is not possible: no frontmatter, differing
// bodies (prose we cannot reconcile mechanically), no facts on either side, an unparseable fact id,
// or a remote that adds nothing (so the difference lives somewhere we should not silently rewrite).
// A null return means the caller PRESERVES LOCAL and reports a conflict rather than guessing.
export function mergeNoteText(localText, remoteText) {
  const c = classifyNoteDivergence(localText, remoteText);
  return c.kind === 'merge' ? c.text : null;
}

// Classify a local/remote divergence. PURE + exported so the whole reconcile rule is unit-testable
// with no network. One of:
//   • { kind: 'merge', text }  — remote carries facts local lacks; the union is the answer
//   • { kind: 'ahead' }        — local already contains every remote fact (a fresh local write the
//                               cloud has not seen). NOT a conflict: keep local, stay quiet, and let
//                               the next push carry it up. Without this case, every ordinary local
//                               write would be reported as a conflict on every Chronos poll.
//   • { kind: 'conflict', reason } — not mechanically reconcilable; caller preserves local and reports
export function classifyNoteDivergence(localText, remoteText) {
  const no = (reason) => ({ kind: 'conflict', reason });
  const L = splitNoteText(localText); const R = splitNoteText(remoteText);
  if (!L || !R) return no('one side has no frontmatter to reconcile');
  if (L.body.trim() !== R.body.trim()) return no('the note body differs, which cannot be merged mechanically');
  const lr = factsRegion(L.fm); const rr = factsRegion(R.fm);
  if (!lr && !rr) return no('neither side has a facts block, so the difference is elsewhere');
  const lEntries = lr ? factEntries(L.fm, lr) : [];
  const rEntries = rr ? factEntries(R.fm, rr) : [];
  if ([...lEntries, ...rEntries].some((e) => !e.id)) return no('a fact entry has no parseable id');
  const localIds = new Set(lEntries.map((e) => e.id));
  const incoming = rEntries.filter((e) => !localIds.has(e.id));

  // CLOSURE IS MONOTONIC. A fact that has been retired must never re-open. Unioning by id alone let a
  // STALE copy's still-open entry win over a closed one — and since supersession is encoded ONLY in
  // valid_to, resurrecting the old row recreated the exact contradiction the supersede had resolved.
  // Observed twice on 2026-08-13: a retracted root-cause fact and a de-duplicated KPI fact both came
  // back to life, and the second resurrection blocked every record_fact into the note with a
  // contradiction error. So where both sides carry the same id and EITHER is closed, the closed
  // version wins, whichever side it came from.
  const rById = new Map(rEntries.map((e) => [e.id, e]));
  let reclosed = 0;
  const merged = lEntries.map((e) => {
    const r = rById.get(e.id);
    if (r && entryIsClosed(r) && !entryIsClosed(e)) { reclosed++; return r; }
    return e;
  });
  if (!incoming.length && !reclosed) return { kind: 'ahead' };

  const entryLines = [...merged, ...incoming].flatMap((e) => e.lines);
  let fm = lr
    ? [...L.fm.slice(0, lr.start), 'facts:', ...entryLines, ...L.fm.slice(lr.end)]
    : [...L.fm, 'facts:', ...entryLines];
  const ru = updatedOf(R.fm);
  if (ru && ru > updatedOf(fm)) fm = fm.map((x) => (/^updated:\s/.test(x) ? `updated: ${ru}` : x));
  return { kind: 'merge', text: ['---', ...fm, '---', L.body].join('\n') };
}

function warnPullConflicts(conflicts) {
  if (!conflicts.length) return;
  process.stderr.write(
    `\n[cloud] ⚠ PULL GUARD — ${conflicts.length} note(s) differ locally and could not be merged. LOCAL WAS KEPT, nothing was overwritten:\n`
    + conflicts.map((c) => `    • ${c.path}   (cloud updated_at ${c.remoteUpdatedAt || 'unknown'}; ${c.reason})\n`).join('')
    + `  Nothing is lost: your local copy is intact and the cloud copy is untouched. Reconcile by hand,\n`
    + `  or take the cloud version for a specific note with \`node brain/lib/cloud.mjs pull --overwrite\`.\n\n`);
}

// Sync the vault DOWN from the cloud, writing ONLY notes whose content actually changed (so a
// file-watcher fires solely on real updates, not every tick). This is how Chronos stays live on the
// online brain: poll this on an interval, and any change made on ANY machine appears here. Returns
// { mode, changed, merged, ahead, timeline, preserved, conflicts, remoteDeleted, checked, fetched }.
// It also refreshes the push watermark for every row whose content it reconciled — after a syncDown
// the local vault is reconciled with exactly those cloud versions, which is what lets the very next
// push proceed. (The board meeting runs a FULL syncDown first and pushBrain last, so only notes
// written online DURING a meeting can trip the guard.)
//
// PULL IS GUARDED, exactly as push is. For each cloud note whose content is fetched:
//   1. identical to local            → already reconciled; refresh the watermark only
//   2. absent locally                → write it (nothing local to lose)
//   3. differs, but local matches the hash we last reconciled → local is merely STALE → take remote
//   4. differs and local does NOT match that hash → a LOCAL EDIT lives here. Never overwrite it.
//      Classify (classifyNoteDivergence): remote has facts local lacks → keep the UNION; local already
//      has every remote fact → local is simply AHEAD of the cloud, keep it and stay quiet (the next
//      push carries it up); otherwise → conflict.
//   5. conflict → PRESERVE LOCAL, report it, and deliberately leave the watermark alone so the push
//      guard keeps flagging it until a human reconciles.
// `force: true` restores the old take-the-cloud-copy behaviour for callers that explicitly want it.
//
// ---- Incremental sync (why syncDown no longer downloads the vault) ---------
// Each call is ONE of three passes, chosen from the persisted cursor (local-clock ms):
//
//   FAST (every Chronos tick)  GET brain_notes?select=path,updated_at&updated_at=gte.<since>
//                                  &order=updated_at.asc&limit=100
//        → "[]" when nothing moved. Content is then fetched (path=in.(…)) ONLY for returned rows
//          whose stamp differs from the reconcile mark (or whose local file is missing, or whose
//          mark says `verify`). 100 rows back → fall through to FULL.
//   FULL (every ~15 min, on Chronos startup, before a board meeting, or on fallback)
//        GET brain_notes?select=path,updated_at, keyset-paged  (~100 B a note)
//        → content only for paths whose stamp != the mark; notes held in the marks but absent from
//          the cloud are reported as REMOTE DELETIONS; cloud-inserted timeline rows are pulled.
//   DEEP (every ~24 h, or when there is no cursor at all — first run / lost state)
//        GET brain_notes?select=path,content,updated_at, keyset-paged — the old full-content
//        comparison, kept as the backstop for a content change that did NOT move updated_at (a hand
//        SQL edit that forgot the column): no timestamp scheme can see that, so one pass a day does.
//
// WHY `gte` + an overlap window, keyed on OUR clock rather than on the stamps we hold:
//   updated_at is written by the CLIENT (pushBrain's `now`, the gateway's nowIso(), occasionally the
//   DB's now()), so it is only as good as that writer's clock, and a push stamps every note with one
//   `now` taken BEFORE a loop that may take minutes to commit them all. The fast pass asks for
//   `updated_at >= (start of the last successful pass) - overlap` (default 10 min). A row is seen by
//   the fast pass whenever (commit lag + how far the writer's clock runs BEHIND ours) <= overlap.
//   `gte`, not `gt`, so a row sharing a stamp with one we already hold is never skipped; rows we
//   already reconciled are de-duplicated by EXACT (path, canonical updated_at) against the marks, so
//   the overlap costs ~100 bytes a recently-changed row and never a re-download.
//   Anything the fast pass cannot see — a writer more than `overlap` behind, a stamp written in the
//   past — is caught by the FULL pass, which compares every row's stamp to its mark for INEQUALITY
//   (never ordering), so no clock relationship at all is assumed there. Worst case a skewed write
//   arrives ~15 min late; it is never missed. A future-stamped row (writer ahead) is simply returned
//   by every fast pass, as ~100 bytes, until our clock passes it.
//   The cursor advances only after a pass completes; a failed pass leaves it, so the next window is
//   wider, never narrower. A clock that jumped backwards is clamped (`min(cursor, now)`).
//
// Every row whose content IS fetched goes through exactly the reconcile rules above — the passes
// change what is downloaded, never how a download is judged.
export async function syncDown(vaultPath, {
  rest: restFn = rest, statePath, force = false, full = false, deep = false, now = Date.now,
  overlapMs = envMs('CHRONOS_CLOUD_OVERLAP_MS', 10 * 60 * 1000),
  fullEveryMs = envMs('CHRONOS_CLOUD_FULL_MS', 15 * 60 * 1000),
  deepEveryMs = envMs('CHRONOS_CLOUD_DEEP_MS', 24 * 60 * 60 * 1000),
} = {}) {
  const empty = { changed: 0, checked: 0, fetched: 0, merged: 0, ahead: 0, preserved: 0, conflicts: [], remoteDeleted: [] };
  if (!cloudConfigured()) return { ...empty, skipped: 'not configured' };
  const v = vaultPath || resolveSources().vaultPath || env('CHRONOS_VAULT');
  if (!v) return { ...empty, skipped: 'no vault' };

  const state = readSyncState(statePath);
  const marks = state.notes;
  const evaluated = state.evaluated;
  const started = now();
  const last = (k) => Number(state.cursor[k]) || 0;
  // A stamp in the future (clock jumped back) counts as "due": better one extra pass than a stale one.
  const due = (k, every) => !last(k) || started - last(k) >= every || started < last(k);
  let mode = (deep || !last('pollFrom') || due('deepAt', deepEveryMs)) ? 'deep'
    : (full || due('fullAt', fullEveryMs)) ? 'full' : 'fast';

  let listed = null;
  if (mode === 'fast') {
    const since = new Date(Math.min(last('pollFrom'), started) - overlapMs).toISOString();
    const rows = (await restFn(`brain_notes?select=path,updated_at&updated_at=gte.${q(since)}&order=updated_at.asc&limit=${FAST_MAX}`)) || [];
    if (rows.length >= FAST_MAX) mode = 'full'; // a burst bigger than one fast page: list everything, paged
    else listed = rows;
  }
  let contentRows;
  if (mode === 'deep') {
    contentRows = await pageNotes(restFn, 'path,content,updated_at', CONTENT_PAGE);
    listed = contentRows;
  } else {
    if (mode === 'full') listed = await pageNotes(restFn, 'path,updated_at');
    const need = [...new Set(listed.filter((r) => r && r.path != null).filter((r) => {
      const mark = marks[r.path];
      if (!sameStamp(r.updated_at, markAt(mark)) || (mark && mark.verify)) {
        // A conflict we already evaluated at this exact version is not re-downloaded every tick; the
        // slow passes re-check it (so a hand-reconciled local copy still converges).
        return !(mode === 'fast' && sameStamp(r.updated_at, evaluated[r.path]));
      }
      return !existsSync(join(v, r.path)); // reconciled, but the local file is gone → restore it, as before
    }).map((r) => r.path))];
    contentRows = need.length ? await fetchNoteRows(restFn, need) : [];
  }

  let changed = 0, merged = 0, ahead = 0;
  const conflicts = [];
  // Goes through the shared note-write contract so a sync write cannot land in the middle of an
  // appendTimeline/addFact read-modify-write on the same note.
  const take = (abs, text) => {
    mkdirSync(dirname(abs), { recursive: true }); // keep default dir perms; the lock would create 0700
    withNoteWrite(abs, () => ({ content: text, value: true }));
  };

  for (const r of contentRows) {
    const abs = join(v, r.path);
    let cur = null;
    try { cur = readFileSync(abs, 'utf8'); } catch { /* missing locally */ }
    const rh = hashOf(r.content);
    delete evaluated[r.path];

    if (cur === r.content) { marks[r.path] = mkMark(r.updated_at, rh, rh); continue; }
    if (cur === null) { take(abs, r.content); changed++; marks[r.path] = mkMark(r.updated_at, rh, rh); continue; }

    // ORDER MATTERS, learned from real data loss on 2026-08-13: classify BEFORE trusting the hash.
    // The hash guard's premise — "local matches what we last reconciled, so taking remote loses
    // nothing" — is only true when remote moved FORWARD. A client rewriting a note from a STALE copy
    // (a cloud session's record_fact rebuilds the whole note from what it last fetched) also moves
    // updated_at, and taking that restored-older content silently deletes every fact the remote copy
    // never had. And the 'ahead' watermark advance stamps local as reconciled, which is exactly what
    // arms this trap. So: if local holds facts remote lacks, MERGE or HOLD (ahead) regardless of the
    // hash; the hash may only authorize take-remote when the divergence is not fact-mergeable
    // (e.g. prose changed) AND local is untouched since the last reconcile. `force` still overrides.
    const reconciled = markSha(marks[r.path]);
    if (force) {
      take(abs, r.content); changed++; marks[r.path] = mkMark(r.updated_at, rh, rh); continue;
    }

    const c = classifyNoteDivergence(cur, r.content);
    if (c.kind === 'conflict' && reconciled && reconciled === hashOf(cur)) {
      // Not fact-mergeable, and local is byte-identical to the last reconcile → genuinely stale.
      take(abs, r.content); changed++; marks[r.path] = mkMark(r.updated_at, rh, rh); continue;
    }
    if (c.kind === 'merge') {
      // We have now incorporated this cloud version, so advance the watermark: the next push carries
      // the merged union up, which is how the other machine's facts get the local ones back.
      take(abs, c.text); merged++; marks[r.path] = mkMark(r.updated_at, hashOf(c.text), rh); continue;
    }
    if (c.kind === 'ahead') {
      // Local already contains every remote fact, so this machine HAS incorporated the cloud version —
      // it is simply further along. Advance the watermark (keeping the LOCAL hash, since local is what
      // sits on disk) so the push guard lets this note publish. Leaving it stale deadlocks the pair:
      // syncDown correctly writes nothing, planNotePush correctly refuses to push a note whose remote
      // row moved past the watermark, and the local edit can never reach the cloud. Observed exactly
      // that on 2026-08-12 — the vault could not publish for a week.
      ahead++;
      marks[r.path] = mkMark(r.updated_at, hashOf(cur), rh);
      continue;
    }
    // Conflict: the watermark is deliberately left alone (the push guard keeps flagging it). Remember
    // the version we judged so the fast pass does not re-download it every tick.
    evaluated[r.path] = String(r.updated_at || '');
    conflicts.push({ path: r.path, remoteUpdatedAt: r.updated_at || null, reason: c.reason });
  }

  // REMOTE DELETIONS (and the old half of a rename) are only knowable from a complete listing. The
  // local copy is NEVER deleted: a note absent from the cloud is indistinguishable, locally, from one
  // written here and not yet pushed, and deleting a file is the one action no guard can undo. The
  // stale mark is retired (so this is reported once, not every pass) and the owner is told by name.
  const remoteDeleted = [];
  if (mode !== 'fast') {
    const present = new Set(listed.map((r) => r && r.path));
    for (const p of Object.keys(marks)) {
      if (present.has(p)) continue;
      remoteDeleted.push(p);
      delete marks[p];
      delete evaluated[p];
    }
    if (remoteDeleted.length) {
      process.stderr.write(`\n[cloud] ${remoteDeleted.length} note(s) were deleted or renamed in the cloud after this machine last reconciled them. LOCAL COPIES WERE KEPT:\n`
        + remoteDeleted.map((p) => `    • ${p}\n`).join('')
        + `  A later push will re-publish any of them that still exist locally. Delete the local file first if the removal was intended.\n\n`);
    }
  }

  const cursor = { ...state.cursor, pollFrom: started };
  if (mode !== 'fast') cursor.fullAt = started;
  if (mode === 'deep') cursor.deepAt = started;
  writeSyncState({ notes: marks, cursor, evaluated }, statePath);
  warnPullConflicts(conflicts);

  // Cloud-inserted timeline entries (4am routines, cloud sessions) come home too — on the slow passes
  // only. Entries written through the gateway also rewrite the day's brain_notes row, so those arrive
  // on the fast pass; only rows INSERTed straight into brain_timeline wait for the next full pass
  // (≤ ~15 min). The light query re-reads a 3-day window (~100 B a row), which at 2,880 ticks a day was
  // itself ~20 MB/day. Never let this sink the whole pull: notes are the load-bearing half.
  let timeline = 0;
  if (mode !== 'fast') {
    try { timeline = (await pullTimeline(v, { rest: restFn })).added; }
    catch (e) { process.stderr.write(`[cloud] timeline pull skipped: ${e.message}\n`); }
  }
  return {
    mode, changed, merged, ahead, timeline, preserved: conflicts.length, conflicts, remoteDeleted,
    checked: listed.length, fetched: contentRows.length,
  };
}

// Bring cloud-inserted timeline entries into the vault's day-notes. TWO PHASES so each pull stays
// cheap: first ask only for (date, heading, body_md5) — a few dozen bytes a row — and fetch actual
// bodies ONLY for entries this vault does not already hold. Steady state is one small query, and
// syncDown runs it on its slow (full/deep) passes only, not on every Chronos tick.
//
// The authoritative comparison is always md5 of the TRIMMED body computed here, never the server's
// body_md5 column: a row inserted with trailing whitespace hashes differently there. Trusting the
// column would then re-append that entry on every poll. Using it only as a cheap HINT for phase two
// costs at most one redundant body fetch and can never duplicate or drop an entry.
export async function pullTimeline(vaultPath, { rest: restFn = rest, days = 3, today = null } = {}) {
  const since = new Date(`${today || new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  since.setUTCDate(since.getUTCDate() - Math.max(0, days - 1));
  const from = since.toISOString().slice(0, 10);

  const light = await restFn(`brain_timeline?select=date,heading,body_md5&date=gte.${from}&order=date.asc&limit=2000`);
  if (!light || !light.length) return { added: 0, days: [] };

  // Group by day, and per day work out whether anything looks absent locally.
  const byDate = new Map();
  for (const r of light) {
    if (!r || !r.date) continue;
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date).push(r);
  }

  let added = 0;
  const touched = [];
  for (const [date, rows] of byDate) {
    const abs = join(vaultPath, 'timeline', `${date}.md`);
    let cur = null;
    try { cur = readFileSync(abs, 'utf8'); } catch { /* no local day-note yet */ }
    const have = new Set(parseTimelineSections(cur).map((s) => sectionKey(s.heading, s.body)));
    const maybeMissing = rows.some((r) => !have.has(entryKey(r.heading, r.body_md5)));
    if (!maybeMissing) continue;

    const full = await restFn(`brain_timeline?select=heading,body&date=eq.${date}&order=id.asc&limit=2000`);
    mkdirSync(dirname(abs), { recursive: true });
    // Re-read the note INSIDE the lock rather than reusing `cur`. `cur` was read before the network
    // round trip above, so another writer may have appended since; planning from it would rewrite
    // the file from stale content and drop whatever landed in between.
    const plan = withNoteWrite(abs, (existing) => {
      const fresh = planTimelinePull(existing, full, date);
      if (!fresh) return { value: null };
      return { content: fresh.text, value: fresh };
    });
    if (!plan) continue;
    added += plan.added;
    touched.push(date);
  }
  return { added, days: touched };
}

// Never-throws wrapper for the polling loop.
export async function syncDownSafe(vaultPath, opts) {
  try { return await syncDown(vaultPath, opts); }
  catch (e) { process.stderr.write(`[cloud] syncDown skipped: ${e.message}\n`); return { changed: 0, error: e.message }; }
}

// ---- CEO conversation memory (durable, in the online brain) ----------------
export async function appendMessage(role, text, dept) {
  if (!cloudConfigured() || !text) return null;
  return rest('brain_conversation', { method: 'POST', body: [{ role, text: String(text), dept: dept || null }], prefer: 'return=minimal' });
}
export async function getConversation(limit = 200) {
  if (!cloudConfigured()) return [];
  // NEWEST N, returned in chronological order. (order=at.asc&limit would return the OLDEST N — once
  // the conversation outgrew the limit, the CEO was remembering the distant past and blind to the
  // present. That bug made it argue with Brandon about long-superseded focuses.)
  const rows = await rest(`brain_conversation?select=role,text,dept,at&order=at.desc&limit=${limit}`);
  return (rows || []).reverse();
}
export async function appendMessageSafe(role, text, dept) {
  try { return await appendMessage(role, text, dept); } catch (e) { process.stderr.write(`[cloud] appendMessage: ${e.message}\n`); return null; }
}
export async function getConversationSafe(limit) {
  try { return await getConversation(limit); } catch (e) { process.stderr.write(`[cloud] getConversation: ${e.message}\n`); return []; }
}

// Local vs cloud snapshot.
export async function cloudStatus(vaultPath) {
  const v = vaultPath || resolveSources().vaultPath;
  const local = v ? { notes: readNotes(v).length, facts: readIndex(v).facts.length } : { notes: 0, facts: 0 };
  if (!cloudConfigured()) return { configured: false, local };
  const [n, f, t] = await Promise.all([
    rest('brain_notes?select=path&limit=10000'), rest('brain_facts?select=id&limit=10000'), rest('brain_timeline?select=id&limit=10000'),
  ]);
  return { configured: true, local, cloud: { notes: (n || []).length, facts: (f || []).length, episodes: (t || []).length }, vault: v };
}

// Guarded push for callers that must never fail (the board meeting). Logs, returns null on error.
// Conflict-skips are NOT errors: they come back in the result's `skipped` list (and are warned
// about on stderr) so the caller can surface them without the push failing.
export async function pushBrainSafe(vaultPath, opts) {
  try { return await pushBrain(vaultPath, opts); }
  catch (e) { process.stderr.write(`[cloud] push skipped: ${e.message}\n`); return null; }
}

// ---- CLI -------------------------------------------------------------------
const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const cmd = process.argv[2] || 'status';
  try {
    if (cmd === 'push') {
      const force = process.argv.includes('--force');
      const r = await pushBrain(undefined, { force });
      console.log(`Pushed brain → Supabase: ${r.notes} notes · ${r.facts} facts · ${r.episodes} timeline sections${force ? ' (FORCED — cloud-side changes were overwritten)' : ''}.`);
      if (r.skipped.length) {
        console.log(`Held back ${r.skipped.length} note(s) newer in the cloud: ${r.skipped.map((s) => s.path).join(', ')}`);
        console.log('Pull + reconcile, or re-run with --force to overwrite them.');
        process.exitCode = 2; // a partial push must not read as a clean success in a script
      }
    } else if (cmd === 'pull' && !cloudConfigured()) {
      // `npm run update` runs this before reinstalling the app. A Mac without the cloud copy set up
      // has nothing to restore, and failing here stopped the update before the app was rebuilt.
      console.log('Cloud brain copy not set up on this machine (SUPABASE_URL + SUPABASE_SERVICE_KEY) — nothing to restore, skipped.');
    } else if (cmd === 'pull') {
      const r = await pullBrain(undefined, { overwrite: process.argv.includes('--overwrite') });
      console.log(`Pulled brain ← Supabase: ${r.cloudNotes} cloud notes → ${r.written} written, ${r.skipped} kept local.`);
    } else {
      const s = await cloudStatus();
      console.log(JSON.stringify(s, null, 2));
    }
  } catch (e) { console.error(`cloud ${cmd} failed: ${e.message}`); process.exit(1); }
}

// ---- gateway access audit (cloud sessions, visible in Chronos) --------------
// Cloud Claude sessions reach the brain through the product's gateway (api/brain.js), which audits
// every op into public.brain_access — because a cloud session's READS otherwise leave no trace
// anywhere, and the owner's Mac app is the coordination layer that must see them live. This is the
// Chronos-side reader. Rows come back in the SAME shape as the local requests.jsonl entries
// (at/tool/mode/by/args/ok/ms/error) plus origin:'cloud', so the activity panel renders both feeds with one
// code path. [] on ANY failure — offline, unconfigured, or the table not existing yet on an older
// deploy — because the local feed must never break waiting on the cloud one.
export async function fetchBrainAccess({ limit = 200, rest: restFn = rest } = {}) {
  if (!cloudConfigured()) return [];
  try {
    const rows = await restFn(`brain_access?select=at,op,mode,by,args,ok,ms,error&order=at.desc&limit=${Math.max(1, limit)}`);
    return (Array.isArray(rows) ? rows : []).map((r) => ({
      at: String(r.at || ''), tool: String(r.op || ''), mode: r.mode === 'write' ? 'write' : 'read',
      by: r.by || 'unidentified', args: r.args || '', ok: r.ok !== false,
      ...(r.error ? { error: String(r.error) } : {}),
      ...(typeof r.ms === 'number' ? { ms: r.ms } : {}), origin: 'cloud',
    }));
  } catch { return []; }
}

// Mirror Chronos's local client verifier registry to the service-role-only cloud table. The secret
// itself never leaves the issuing machine. This gives the online gateway the same authoritative
// identity, scope, expiry, rotation, and revocation decisions as the local MCP boundary.
export async function syncAccessClient(client, { rest: restFn = rest } = {}) {
  if (!client || !client.id || !client.name || !client.lookup || !client.salt || !client.verifier) throw new Error('complete client verifier record required');
  if (!cloudConfigured()) return { synced: false, reason: 'cloud not configured' };
  const row = {
    id: client.id, name: client.name, scopes: client.scopes || [], lookup: client.lookup,
    salt: client.salt, verifier: client.verifier,
    created_at: client.createdAt, expires_at: client.expiresAt || null, revoked_at: client.revokedAt || null,
    last_used_at: client.lastUsedAt || null,
  };
  await restFn('brain_clients?on_conflict=id', { method: 'POST', body: [row], prefer: UPSERT });
  return { synced: true };
}
