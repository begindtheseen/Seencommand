// Creator Intelligence Library — a SAFE, read-only view over the compiler's canonical project data.
//
// It is NOT a parallel datastore: structured records come from each project's state.sqlite (read via
// Node's built-in node:sqlite, opened read-only), and files come from strict, project-relative,
// allowlisted reads. The compiler's SQLite + JSONL remain the single truth.
//
// Security invariants (tested in library.test.mjs):
//   • A project is resolved only from a known data root (writable jobs root + registered read-only
//     roots). Project names must match the compiler's own SAFE_NAME.
//   • Every file/media path is resolved project-relative, realpath'd, and REJECTED unless it stays
//     inside the project's realpath — no `..`, no encoded traversal, no symlink escape, no absolute.
//   • Never serve `.env`, SQLite files/journals, sessions, dotfiles, or non-allowlisted MIME types.
//   • Media streams with HTTP byte ranges; whole videos are never buffered into memory.

import { existsSync, readFileSync, readdirSync, statSync, realpathSync, createReadStream } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { config } from '../config.mjs';
import { dataDir } from '../paths.mjs';
import { openProjectDb, sqliteStatus } from './db.mjs';
import { curateEvidence } from './evidence-quality.mjs';

export { sqliteStatus };

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const FILE_TYPES = {
  '.json': 'application/json', '.jsonl': 'application/x-ndjson', '.md': 'text/markdown',
  '.txt': 'text/plain', '.srt': 'text/plain', '.vtt': 'text/vtt', '.csv': 'text/csv',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
};
const MEDIA_TYPES = {
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/mp4', '.webm': 'video/webm',
  '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.aac': 'audio/aac',
};
// Never served, whatever the extension says.
const DENY = new Set(['.env', '.sqlite', '.sqlite-journal', '.sqlite-wal', '.sqlite-shm', '.session', '.key', '.pem']);

// ---- project roots --------------------------------------------------------

// Registered read-only roots (e.g. an existing fixture dataset) live in a DATA file — never .env.
function readonlyRoots() {
  const out = [];
  const envRoots = (process.env.VSC_READONLY_ROOTS || '').split(':').map((s) => s.trim()).filter(Boolean);
  out.push(...envRoots);
  try {
    const reg = join(dataDir(), 'instagram-readonly-roots.json');
    if (existsSync(reg)) {
      const arr = JSON.parse(readFileSync(reg, 'utf8'));
      if (Array.isArray(arr)) out.push(...arr.filter((s) => typeof s === 'string'));
    }
  } catch { /* ignore a malformed registry */ }
  return [...new Set(out)];
}

function roots() {
  const rs = [{ path: resolve(config.vscDataRoot()), readOnly: false }];
  for (const r of readonlyRoots()) { try { rs.push({ path: realpathSync(r), readOnly: true }); } catch { /* gone */ } }
  return rs;
}

// Resolve a project by name across all roots. Returns { name, dir, root, readOnly } or null.
export function resolveProject(name) {
  if (typeof name !== 'string' || !SAFE_NAME.test(name)) return null;
  for (const r of roots()) {
    const dir = join(r.path, name);
    if (existsSync(join(dir, 'project.json'))) {
      let real; try { real = realpathSync(dir); } catch { continue; }
      // The realpath'd project must still live under the realpath'd root (no symlink escape).
      let rootReal; try { rootReal = realpathSync(r.path); } catch { continue; }
      if (real !== rootReal && !real.startsWith(rootReal + '/')) continue;
      return { name, dir: real, root: rootReal, readOnly: r.readOnly };
    }
  }
  return null;
}

// Resolve an Instagram username to an EXISTING project name, tolerating naming variants
// (jobs create `instagram-<user>`; an imported fixture may be `<user>` with `_`→`-`). Null if none.
export function projectForUsername(username) {
  const u = String(username || '').replace(/^@/, '').toLowerCase();
  if (!u) return null;
  for (const cand of [`instagram-${u}`, u, u.replace(/_/g, '-'), `instagram-${u.replace(/_/g, '-')}`]) {
    const p = resolveProject(cand);
    if (p) return p.name;
  }
  return null;
}

function openDb(projectDir) { return openProjectDb(projectDir); }

const readJson = (p, fallback) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; } };
const readJsonl = (p) => { try { return readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };

// ---- reads ----------------------------------------------------------------

// One card per researched account: config + coverage/knowledge/unresolved counts + storage.
export function listProjects() {
  const out = [];
  for (const r of roots()) {
    let entries = []; try { entries = readdirSync(r.path, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || !SAFE_NAME.test(e.name)) continue;
      const dir = join(r.path, e.name);
      if (!existsSync(join(dir, 'project.json'))) continue;
      const cfg = readJson(join(dir, 'project.json'), {});
      let counts = {}, scope = {};
      const db = openDb(dir);
      if (db) {
        try {
          scope = {
            in_scope: db.prepare('SELECT COUNT(*) c FROM sources WHERE in_scope=1').get().c,
            out_of_scope: db.prepare('SELECT COUNT(*) c FROM sources WHERE in_scope=0').get().c,
          };
          counts = {
            videos: scope.in_scope,
            evidence: db.prepare('SELECT COUNT(*) c FROM evidence').get().c,
            knowledge: db.prepare('SELECT COUNT(*) c FROM knowledge').get().c,
            with_local_media: db.prepare("SELECT COUNT(*) c FROM sources WHERE local_path IS NOT NULL AND local_path<>''").get().c,
          };
        } catch { /* partial */ } finally { db.close(); }
      }
      const unresolved = readJsonl(join(dir, 'knowledge', 'unresolved.jsonl')).length;
      out.push({
        name: e.name, username: cfg.username || null, source: cfg.source || null, readOnly: r.readOnly,
        created_at: cfg.created_at || null, completeness_statement: cfg.completeness_statement || null,
        counts, scope, unresolved, storageBytes: dirBytes(dir),
      });
    }
  }
  return out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

// Just the researched project names — no counts, no recursive storage walk (listProjects stats every
// file, which is too slow to run on every chat message). Deduped across roots, sorted.
export function projectNames() {
  const out = new Set();
  for (const r of roots()) {
    let entries = []; try { entries = readdirSync(r.path, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) if (e.isDirectory() && SAFE_NAME.test(e.name) && existsSync(join(r.path, e.name, 'project.json'))) out.add(e.name);
  }
  return [...out].sort();
}

export function getProject(name) {
  const p = resolveProject(name);
  if (!p) return null;
  const cfg = readJson(join(p.dir, 'project.json'), {});
  const db = openDb(p.dir);
  let counts = {}, scope = {}, stages = [];
  if (db) {
    try {
      scope = {
        in_scope: db.prepare('SELECT COUNT(*) c FROM sources WHERE in_scope=1').get().c,
        out_of_scope: db.prepare('SELECT COUNT(*) c FROM sources WHERE in_scope=0').get().c,
      };
      counts = {
        videos: scope.in_scope,
        evidence: db.prepare('SELECT COUNT(*) c FROM evidence').get().c,
        knowledge: db.prepare('SELECT COUNT(*) c FROM knowledge').get().c,
        rules: db.prepare('SELECT COUNT(*) c FROM rules').get().c,
        requirements: db.prepare('SELECT COUNT(*) c FROM requirements').get().c,
      };
      stages = db.prepare('SELECT stage, status, COUNT(*) count FROM stage_runs GROUP BY stage, status').all();
    } catch { /* partial */ } finally { db.close(); }
  }
  const sections = { knowledge: {}, reports: listReports(name) };
  for (const f of ['principles', 'rules', 'workflows', 'tools', 'claims', 'examples', 'unresolved', 'contradictions']) {
    sections.knowledge[f] = readJsonl(join(p.dir, 'knowledge', `${f}.jsonl`)).length;
  }
  return { name: p.name, readOnly: p.readOnly, config: cfg, counts, scope, stages, sections };
}

// Videos gallery: one row per source, with per-video evidence/knowledge counts + local-media flag.
export function listVideos(name, { limit = 200, includeOutOfScope = false } = {}) {
  const p = resolveProject(name);
  if (!p) return null;
  const db = openDb(p.dir);
  if (!db) return [];
  try {
    const where = includeOutOfScope ? '' : 'WHERE in_scope=1'; // gallery defaults to the SELECTED videos
    const rows = db.prepare(
      `SELECT source_id, external_id, source_url, media_type, caption, published_at, retrieved_at,
              local_path, availability, in_scope, metadata_json
       FROM sources ${where} ORDER BY (published_at IS NULL), published_at DESC LIMIT ?`).all(Math.min(Number(limit) || 200, 1000));
    const evCount = db.prepare('SELECT COUNT(*) c FROM evidence WHERE video_id=?');
    const kCount = db.prepare('SELECT COUNT(DISTINCT ke.knowledge_id) c FROM knowledge_evidence ke JOIN evidence e ON e.evidence_id=ke.evidence_id WHERE e.video_id=?');
    return rows.map((v) => {
      const meta = safeJson(v.metadata_json);
      return {
        source_id: v.source_id, external_id: v.external_id, source_url: v.source_url,
        media_type: v.media_type, caption: v.caption, published_at: v.published_at, retrieved_at: v.retrieved_at,
        availability: v.availability, in_scope: !!v.in_scope,
        localMedia: localMediaExists(p.dir, v.local_path),
        thumb: firstFrame(p.dir, v.source_id),
        duration: meta.duration || meta.duration_seconds || null,
        counts: { evidence: evCount.get(v.source_id).c, knowledge: kCount.get(v.source_id).c },
      };
    });
  } catch { return []; } finally { db.close(); }
}

// Full video detail: source row + evidence[] (with seek timestamps) + linked canonical knowledge[].
export function getVideo(name, videoId) {
  const p = resolveProject(name);
  if (!p) return null;
  const db = openDb(p.dir);
  if (!db) return null;
  try {
    const v = db.prepare('SELECT * FROM sources WHERE source_id=?').get(videoId);
    if (!v) return null;
    const evidence = curateEvidence(db.prepare('SELECT evidence_id, video_id, source_url, timestamp_start, timestamp_end, evidence_type, content, confidence FROM evidence WHERE video_id=? ORDER BY timestamp_start').all(videoId), { maxOcrPerVideo: 12 });
    const knowledge = db.prepare(
      `SELECT DISTINCT k.knowledge_id, k.type, k.title, k.description, k.attribution, k.status, k.confidence
       FROM knowledge k JOIN knowledge_evidence ke ON ke.knowledge_id=k.knowledge_id
       JOIN evidence e ON e.evidence_id=ke.evidence_id WHERE e.video_id=?`).all(videoId);
    const meta = safeJson(v.metadata_json);
    return {
      video: { ...v, in_scope: !!v.in_scope, metadata: meta, metadata_json: undefined,
        localMedia: localMediaExists(p.dir, v.local_path) },
      evidence, knowledge,
      artifacts: { // discoverable via /files (allowlisted) — surfaced as project-relative dirs
        transcript: relIfExists(p.dir, join('transcripts', `${videoId}.json`)) || relIfExists(p.dir, join('transcripts', `${videoId}.jsonl`)),
        ocr: relIfExists(p.dir, join('ocr', videoId)),
        frames: relIfExists(p.dir, join('frames', videoId)),
      },
    };
  } catch { return null; } finally { db.close(); }
}

export function search(name, query, limit = 25) {
  const p = resolveProject(name);
  if (!p || typeof query !== 'string' || !query.trim()) return null;
  const db = openDb(p.dir);
  if (!db) return [];
  try {
    return db.prepare(
      `SELECT document_id, kind, title, snippet(search_index, 3, '[', ']', ' … ', 18) snippet, bm25(search_index) score
       FROM search_index WHERE search_index MATCH ? ORDER BY score LIMIT ?`).all(query, Math.min(Number(limit) || 25, 250));
  } catch (e) { return { error: 'search failed (check query syntax)' }; } finally { db.close(); }
}

export function getEvidence(name, evidenceId) {
  const p = resolveProject(name); if (!p) return null;
  const db = openDb(p.dir); if (!db) return null;
  try { return db.prepare('SELECT * FROM evidence WHERE evidence_id=?').get(evidenceId) || null; }
  catch { return null; } finally { db.close(); }
}

// One canonical knowledge record + its supporting evidence (for guidance retrieval / citations).
export function getKnowledge(name, knowledgeId) {
  const p = resolveProject(name); if (!p) return null;
  const db = openDb(p.dir); if (!db) return null;
  try {
    const k = db.prepare('SELECT knowledge_id,type,title,description,attribution,status,confidence,record_json FROM knowledge WHERE knowledge_id=?').get(knowledgeId);
    if (!k) return null;
    const evidence = db.prepare(
      `SELECT e.evidence_id,e.video_id,e.source_url,e.timestamp_start,e.timestamp_end,e.evidence_type,e.content,e.confidence
       FROM evidence e JOIN knowledge_evidence ke ON ke.evidence_id=e.evidence_id WHERE ke.knowledge_id=?`).all(knowledgeId);
    return { ...k, record: safeJson(k.record_json), record_json: undefined, evidence };
  } catch { return null; } finally { db.close(); }
}

// Bounded list of canonical knowledge for the Knowledge tab (with per-record evidence counts).
export function listKnowledge(name, { limit = 300 } = {}) {
  const p = resolveProject(name); if (!p) return null;
  const db = openDb(p.dir); if (!db) return [];
  try {
    const records = db.prepare(
      `SELECT k.knowledge_id, k.type, k.title, k.description, k.attribution, k.status, k.confidence,
              k.record_json,
              (SELECT COUNT(*) FROM knowledge_evidence ke WHERE ke.knowledge_id = k.knowledge_id) AS evidence_count
         FROM knowledge k ORDER BY k.type, k.knowledge_id LIMIT ?`).all(Math.min(Number(limit) || 300, 1000));
    const evFor = db.prepare(
      `SELECT e.evidence_id,e.video_id,e.source_url,e.timestamp_start,e.timestamp_end,e.evidence_type,e.content,e.confidence
         FROM evidence e JOIN knowledge_evidence ke ON ke.evidence_id=e.evidence_id
        WHERE ke.knowledge_id=? ORDER BY e.video_id,e.timestamp_start LIMIT 4`);
    return records.map((record) => ({
      ...record,
      record: safeJson(record.record_json),
      record_json: undefined,
      evidence: evFor.all(record.knowledge_id),
    }));
  } catch { return []; } finally { db.close(); }
}

// Bounded list of evidence for the Evidence tab (content excerpted; ordered by video + timestamp).
export function listEvidence(name, { limit = 400 } = {}) {
  const p = resolveProject(name); if (!p) return null;
  const db = openDb(p.dir); if (!db) return [];
  try {
    const requested = Math.min(Number(limit) || 400, 2000);
    const rawLimit = Math.min(Math.max(requested * 8, 2000), 16000);
    return curateEvidence(db.prepare(
      `SELECT evidence_id, video_id, evidence_type, timestamp_start, timestamp_end, source_url, content, confidence
         FROM evidence ORDER BY video_id, (timestamp_start IS NULL), timestamp_start LIMIT ?`).all(rawLimit), { maxOcrPerVideo: 12 })
      .slice(0, requested).map((e) => ({ ...e, content: String(e.content || '').slice(0, 240) }));
  } catch { return []; } finally { db.close(); }
}

// Retrieve the most relevant canonical knowledge (with a few supporting evidence excerpts) for a
// natural-language question. Bounded on purpose — never returns the whole archive. Text-match over
// title/description (robust, no reliance on FTS id mapping). Ranked by how many question terms a
// record matches, then by how many DISTINCT videos back it — never by the extractor's self-rated
// confidence alone (that number is the model grading itself). Contradicted/deprecated records are
// never offered as guidance.
export function relevantRecords(name, question, limit = 8) {
  const p = resolveProject(name); if (!p) return null;
  const db = openDb(p.dir); if (!db) return { query: '', knowledge: [] };
  const terms = questionTerms(question);
  const cap = Math.min(Number(limit) || 8, 25);
  try {
    const live = "status NOT IN ('contradicted','deprecated')";
    const videosFor = db.prepare('SELECT COUNT(DISTINCT e.video_id) c FROM knowledge_evidence ke JOIN evidence e ON e.evidence_id=ke.evidence_id WHERE ke.knowledge_id=?');
    let ks;
    if (terms.length) {
      const like = terms.map(() => '(title LIKE ? OR description LIKE ?)').join(' OR ');
      const params = terms.flatMap((t) => [`%${t}%`, `%${t}%`]);
      ks = db.prepare(`SELECT knowledge_id,type,title,description,attribution,status,confidence FROM knowledge WHERE ${live} AND (${like}) LIMIT 200`).all(...params);
    } else {
      ks = db.prepare(`SELECT knowledge_id,type,title,description,attribution,status,confidence FROM knowledge WHERE ${live} LIMIT 200`).all();
    }
    const ranked = ks.map((k) => {
      const text = `${k.title || ''} ${k.description || ''}`.toLowerCase();
      return { k, hits: terms.filter((t) => text.includes(t)).length, videos: videosFor.get(k.knowledge_id).c };
    }).sort((a, b) => b.hits - a.hits || b.videos - a.videos || (Number(b.k.confidence) || 0) - (Number(a.k.confidence) || 0)
      || String(a.k.knowledge_id).localeCompare(String(b.k.knowledge_id)))
      .slice(0, cap);
    const evFor = db.prepare(
      `SELECT e.evidence_id,e.video_id,e.source_url,e.timestamp_start,e.timestamp_end,e.evidence_type,e.content,e.confidence
       FROM evidence e JOIN knowledge_evidence ke ON ke.evidence_id=e.evidence_id WHERE ke.knowledge_id=? LIMIT 4`);
    const knowledge = ranked.map(({ k, videos }) => ({ ...k, videoCount: videos, evidence: evFor.all(k.knowledge_id) }));
    return { query: terms.join(' '), knowledge };
  } catch { return { query: terms.join(' '), knowledge: [] }; } finally { db.close(); }
}

// Everything the cross-creator insight engine (insights.mjs) needs from ONE project, in one bounded
// read: the in-scope videos (with the public like/comment counts the ingester stored at retrieval
// time), the curated evidence (speech, captions, quality-filtered OCR), and the canonical knowledge
// with its evidence links. Read-only; null for an unknown project or an unreadable database.
export function creatorCorpus(name, { maxEvidence = 20000, maxKnowledge = 3000 } = {}) {
  const p = resolveProject(name); if (!p) return null;
  const cfg = readJson(join(p.dir, 'project.json'), {});
  const db = openDb(p.dir); if (!db) return null;
  try {
    const videos = db.prepare(
      `SELECT source_id, external_id, source_url, media_type, caption, published_at, metadata_json
         FROM sources WHERE in_scope=1 ORDER BY source_id`).all().map((v) => {
      const meta = safeJson(v.metadata_json);
      const num = (x) => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));
      return {
        id: v.source_id, url: v.source_url || null, publishedAt: v.published_at || null,
        caption: v.caption || '', mediaType: v.media_type || 'video',
        // Carousel children share one post: collapse them to the parent so one post counts once.
        parent: meta.parent_shortcode ? String(meta.parent_shortcode) : null,
        likes: num(meta.likes), comments: num(meta.comments),
      };
    });
    const inScope = new Set(videos.map((v) => v.id));
    const evidence = curateEvidence(db.prepare(
      `SELECT evidence_id, video_id, source_url, timestamp_start, timestamp_end, evidence_type, content, confidence
         FROM evidence ORDER BY video_id, (timestamp_start IS NULL), timestamp_start LIMIT ?`).all(Math.max(1, maxEvidence | 0))
      .filter((e) => inScope.has(e.video_id)), { maxOcrPerVideo: 12 });
    const knowledge = db.prepare(
      'SELECT knowledge_id, type, title, description, attribution, status, confidence, record_json FROM knowledge ORDER BY knowledge_id LIMIT ?')
      .all(Math.max(1, maxKnowledge | 0)).map((k) => ({ ...k, record: safeJson(k.record_json), record_json: undefined, evidence: [] }));
    const byId = new Map(knowledge.map((k) => [k.knowledge_id, k]));
    const links = db.prepare(
      `SELECT ke.knowledge_id, e.evidence_id, e.video_id, e.source_url, e.timestamp_start, e.timestamp_end, e.evidence_type,
              substr(e.content, 1, 400) AS content
         FROM knowledge_evidence ke JOIN evidence e ON e.evidence_id = ke.evidence_id
        ORDER BY ke.knowledge_id, e.video_id, e.timestamp_start`).all();
    for (const l of links) { const k = byId.get(l.knowledge_id); if (k && inScope.has(l.video_id)) k.evidence.push(l); }
    return {
      project: p.name, handle: `@${cfg.username || p.name.replace(/^instagram-/, '')}`,
      videos, evidence, knowledge,
    };
  } catch { return null; } finally { db.close(); }
}

// A cheap change-signature for a project's database (mtime + size), so callers can cache derived
// views and recompute only when the compiler actually wrote something new.
export function projectSignature(name) {
  const p = resolveProject(name); if (!p) return null;
  const sig = (f) => { try { const st = statSync(join(p.dir, f)); return `${st.mtimeMs}:${st.size}`; } catch { return '-'; } };
  return `${p.name}:${sig('state.sqlite')}:${sig('state.sqlite-wal')}`; // WAL-mode writes land in -wal first
}

function questionTerms(question) {
  const words = String(question || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  const stop = new Set(['what', 'does', 'the', 'and', 'for', 'about', 'how', 'why', 'can', 'you', 'your', 'with', 'that', 'this', 'are', 'from', 'his', 'her', 'them', 'they', 'teach', 'teaches', 'say', 'says', 'said', 'use', 'using', 'improve', 'seenjobs']);
  return [...new Set(words.filter((w) => !stop.has(w)))].slice(0, 8);
}

export function unresolved(name) {
  const p = resolveProject(name); if (!p) return null;
  return readJsonl(join(p.dir, 'knowledge', 'unresolved.jsonl'));
}

export function listReports(name) {
  const p = resolveProject(name); if (!p) return [];
  const dir = join(p.dir, 'reports');
  try {
    return readdirSync(dir).filter((f) => !f.startsWith('.') && (f.endsWith('.md') || f.endsWith('.json')))
      .map((f) => ({ file: `reports/${f}`, name: f, bytes: safeSize(join(dir, f)) }));
  } catch { return []; }
}

// ---- safe project-relative file + media access ----------------------------

// Resolve a project-relative path to a real absolute path that is PROVABLY inside the project, or
// throw. This is the single choke point for /files and /media.
export function safeResolve(projectDir, relPath) {
  if (typeof relPath !== 'string' || !relPath || relPath.includes('\0')) throw new Error('bad path');
  const decoded = relPath.replace(/\\/g, '/');
  if (decoded.startsWith('/') || /^[A-Za-z]:/.test(decoded)) throw new Error('absolute path rejected');
  const target = resolve(projectDir, decoded);
  const projReal = realpathSync(projectDir);
  let real; try { real = realpathSync(target); } catch { throw new Error('not found'); }
  if (real !== projReal && !real.startsWith(projReal + '/')) throw new Error('path escapes project');
  return real;
}

export function readProjectFile(name, relPath) {
  const p = resolveProject(name); if (!p) return { error: 'unknown project', code: 404 };
  let real; try { real = safeResolve(p.dir, relPath); } catch (e) { return { error: e.message, code: 400 }; }
  const ext = extname(real).toLowerCase();
  const base = real.split('/').pop();
  if (base.startsWith('.') || DENY.has(ext) || base.includes('.env') || base.startsWith('session-')) return { error: 'file type not served', code: 403 };
  const type = FILE_TYPES[ext];
  if (!type) return { error: 'unsupported file type', code: 415 };
  const st = statSync(real);
  if (!st.isFile() || st.size > 8 * 1024 * 1024) return { error: 'not a servable file (or too large; use /media for video)', code: 413 };
  return { ok: true, path: real, type, bytes: st.size, content: readFileSync(real) };
}

// Resolve a source row's stored local_path (project-RELATIVE for new ingestion, or ABSOLUTE for legacy
// datasets like a registered fixture) to a real path that is PROVABLY inside the project. New code
// writes relative paths; here we also accept an absolute path IFF it realpath-resolves inside the
// project root — foreign absolute paths and symlink escapes stay rejected. Never throws.
//   → { real }   a servable in-project file exists
//   → { gone:true }   path is inside-project but the file is missing (cleaned / re-download needed)
//   → { escape:true } path is foreign/absolute-outside/symlink-escape (reject)
export function resolveLocalMedia(projectDir, local) {
  if (typeof local !== 'string' || !local || local.includes('\0')) return { gone: true };
  const norm = local.replace(/\\/g, '/');
  let projReal; try { projReal = realpathSync(projectDir); } catch { return { escape: true }; }
  if (norm.startsWith('/') || /^[A-Za-z]:/.test(norm)) {
    let real; try { real = realpathSync(norm); }
    catch {
      const abs = resolve(norm);
      return (abs === projReal || abs.startsWith(projReal + '/')) ? { gone: true } : { escape: true };
    }
    return (real === projReal || real.startsWith(projReal + '/')) ? { real } : { escape: true };
  }
  try { return { real: safeResolve(projectDir, norm) }; }
  catch (e) { return e.message === 'not found' ? { gone: true } : { escape: true }; }
}
function localMediaExists(projectDir, local) { return !!resolveLocalMedia(projectDir, local).real; }

// Safe directory listing for the project file explorer. `relPath` is project-relative ('' = root).
// Resolves through the same choke point (no `..`, no absolute, no symlink escape) and NEVER lists or
// exposes secrets: dotfiles, .env, SQLite files/journals, sessions, keys are filtered out entirely.
// Returns { path, parent, dirs[], files[] } — files carry {name, ext, bytes, servable, kind}. Directory
// sizes are omitted (cheap listing, no recursive stat).
export function listDir(name, relPath = '') {
  const p = resolveProject(name); if (!p) return { error: 'unknown project', code: 404 };
  const rel = String(relPath || '').replace(/^\/+/, '').replace(/\/+$/, '');
  let dir;
  if (!rel) { try { dir = realpathSync(p.dir); } catch { return { error: 'not found', code: 404 }; } }
  else { try { dir = safeResolve(p.dir, rel); } catch (e) { return { error: e.message, code: 400 }; } }
  let st; try { st = statSync(dir); } catch { return { error: 'not found', code: 404 }; }
  if (!st.isDirectory()) return { error: 'not a directory', code: 400 };
  let entries = []; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return { error: 'cannot read directory', code: 500 }; }
  const dirs = [], files = [];
  for (const e of entries) {
    const nm = e.name;
    if (isSecretName(nm)) continue; // never surface secrets/dotfiles even by listing
    const childRel = rel ? `${rel}/${nm}` : nm;
    if (e.isDirectory()) { dirs.push({ name: nm, path: childRel }); continue; }
    if (!e.isFile()) continue;
    const ext = extname(nm).toLowerCase();
    if (DENY.has(ext)) continue;
    const servable = !!FILE_TYPES[ext];
    const media = !!MEDIA_TYPES[ext];
    files.push({ name: nm, path: childRel, ext, bytes: safeSize(join(dir, nm)), servable, media,
      kind: servable ? 'file' : (media ? 'media' : 'other') });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  const parent = rel ? rel.split('/').slice(0, -1).join('/') : null;
  return { ok: true, path: rel, parent, dirs, files };
}
function isSecretName(nm) {
  if (!nm || nm.startsWith('.')) return true;                 // dotfiles incl. .env, .DS_Store
  if (nm.startsWith('session-') || nm.includes('.env')) return true;
  const ext = extname(nm).toLowerCase();
  return DENY.has(ext);                                        // .sqlite*, .key, .pem, .session
}

// For byte-range media streaming: validate + return the real path/size/type; the server streams ranges.
export function openMedia(name, videoId) {
  const p = resolveProject(name); if (!p) return { error: 'unknown project', code: 404 };
  const db = openDb(p.dir); if (!db) return { error: 'project db unavailable', code: 503 };
  let local;
  try { const v = db.prepare('SELECT local_path FROM sources WHERE source_id=?').get(videoId); local = v && v.local_path; }
  catch { local = null; } finally { db.close(); }
  if (!local) return { error: 'no local media (raw video not retained)', code: 404 };
  const r = resolveLocalMedia(p.dir, local);
  if (r.escape) return { error: 'path escapes project', code: 400 };
  if (r.gone || !r.real) return { error: 'no local media (raw video not retained; re-download required)', code: 404 };
  const ext = extname(r.real).toLowerCase();
  const type = MEDIA_TYPES[ext];
  if (!type) return { error: 'unsupported media type', code: 415 };
  const st = statSync(r.real);
  if (!st.isFile()) return { error: 'not a file', code: 404 };
  return { ok: true, path: r.real, type, size: st.size, stream: (opts) => createReadStream(r.real, opts) };
}

// ---- small helpers --------------------------------------------------------

// First extracted frame for a video (project-relative), used as the gallery thumbnail. Frames live at
// frames/<source_id>/ or evidence/<source_id>/frames/. Returns a servable relative path or null.
function firstFrame(projectDir, sourceId) {
  for (const rel of [join('frames', sourceId), join('evidence', sourceId, 'frames')]) {
    try {
      const dir = join(projectDir, rel);
      const f = readdirSync(dir).filter((n) => /\.(jpg|jpeg|png|webp)$/i.test(n)).sort()[0];
      if (f) return `${rel}/${f}`;
    } catch { /* none */ }
  }
  return null;
}

function safeJson(s) { try { return JSON.parse(s || '{}') || {}; } catch { return {}; } }
function safeSize(p) { try { return statSync(p).size; } catch { return 0; } }
function relIfExists(projectDir, rel) { return existsSync(join(projectDir, rel)) ? rel : null; }
function dirBytes(dir) {
  let total = 0;
  const walk = (d, depth) => {
    if (depth > 6) return;
    let entries = []; try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(d, e.name);
      try { if (e.isDirectory()) walk(full, depth + 1); else total += statSync(full).size; } catch { /* skip */ }
    }
  };
  walk(dir, 0);
  return total;
}
