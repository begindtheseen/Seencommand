// Deterministic, bounded knowledge-extraction bundles built from a project's REAL evidence.
//
// The compiler's `extract-knowledge` only writes a status report; it does NOT produce Claude batches.
// This module builds the batches itself, straight from state.sqlite (the single truth): the exact
// in-scope video IDs, their evidence rows (IDs, source URLs, exact timestamps, content, type,
// confidence), transcript text when present, and the existing canonical knowledge needed for
// cross-batch dedup — all under the strict KnowledgeRecord schema Claude must emit. Nothing here treats
// arbitrary README/report files as batches, and nothing invents evidence.
//
// It also owns the truthful coverage query: which in-scope videos actually have validated, imported
// knowledge (a knowledge record linked through an evidence row). Completion is judged against THIS,
// never against Claude's self-report.

import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { openProjectDb } from './db.mjs';
import { curateEvidence } from './evidence-quality.mjs';

const BUNDLE_SCHEMA = 'vsc.knowledge-batch/1';
const KNOWLEDGE_TYPES = ['principle', 'rule', 'workflow', 'formula', 'tool', 'claim', 'example', 'exception', 'warning'];

// The strict record schema echoed into every bundle so the extractor has no ambiguity.
export const KNOWLEDGE_OUTPUT_JSON_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['records'],
  properties: {
    records: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['knowledge_id', 'type', 'title', 'description', 'formal_expression', 'inputs', 'outputs', 'conditions', 'steps', 'exceptions', 'dependencies', 'evidence', 'confidence', 'attribution', 'status'],
      properties: {
        knowledge_id: { type: 'string', minLength: 1 },
        type: { enum: KNOWLEDGE_TYPES },
        title: { type: 'string', minLength: 1 }, description: { type: 'string', minLength: 1 },
        formal_expression: { anyOf: [{ type: 'string' }, { type: 'object' }, { type: 'null' }] },
        inputs: { type: 'array', items: { type: 'string' } }, outputs: { type: 'array', items: { type: 'string' } },
        conditions: { type: 'array', items: { type: 'string' } }, steps: { type: 'array', items: { type: 'string' } },
        exceptions: { type: 'array', items: { type: 'string' } }, dependencies: { type: 'array', items: { type: 'string' } },
        evidence: { type: 'array', minItems: 1, items: {
          type: 'object', additionalProperties: false,
          required: ['evidence_id', 'video_id', 'source_url', 'timestamp_start', 'timestamp_end', 'excerpt'],
          properties: {
            evidence_id: { type: 'string', minLength: 1 }, video_id: { type: 'string', minLength: 1 },
            source_url: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            timestamp_start: { type: 'number', minimum: 0 }, timestamp_end: { type: 'number', minimum: 0 },
            excerpt: { type: 'string' },
          },
        } },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        attribution: { enum: ['creator_explicit', 'creator_demonstrated', 'system_inferred', 'independent_improvement'] },
        status: { enum: ['confirmed', 'probable', 'ambiguous', 'contradicted', 'deprecated'] },
      },
    } },
  },
};

const KNOWLEDGE_RECORD_SCHEMA = {
  json_schema: KNOWLEDGE_OUTPUT_JSON_SCHEMA.properties.records.items,
  rules: [
    'The JSON shape MUST exactly match the schema. The Python importer rejects extra or missing fields.',
    'Copy evidence references from videos[].evidence_refs; never invent an evidence ID, video ID, timestamp, URL, or excerpt.',
    'Use creator_explicit only for direct teaching, creator_demonstrated only for visible behavior, and system_inferred only for clearly labeled inference.',
    'Extract every distinct useful principle, rule, workflow, formula, tool, claim, example, exception, and warning — not one vague summary per video.',
    'Keep promotional/result claims as claim records; never treat a claim as independently verified.',
    'Deduplicate against canonical_knowledge and within this batch. Use a stable knowledge_id beginning with k- and do not overwrite an unrelated record.',
  ],
};

const readJson = (p, fb) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fb; } };

// Pull transcript text for a source_id, if a small transcript artifact exists. Bounded to keep bundles small.
function transcriptText(projectDir, sourceId, cap = 6000) {
  for (const rel of [join('transcripts', `${sourceId}.json`), join('transcripts', `${sourceId}.jsonl`)]) {
    const f = join(projectDir, rel);
    if (!existsSync(f)) continue;
    const j = readJson(f, null);
    if (!j) { try { return String(readFileSync(f, 'utf8')).slice(0, cap); } catch { return null; } }
    // common shapes: {text}, {segments:[{text}]}, {statements:[{content}]}
    if (typeof j.text === 'string') return j.text.slice(0, cap);
    const segs = j.segments || j.statements || [];
    if (Array.isArray(segs) && segs.length) return segs.map((s) => s.text || s.content || '').join(' ').slice(0, cap);
    return JSON.stringify(j).slice(0, cap);
  }
  return null;
}

// In-scope source_ids, deterministically sorted. [] if the db is unavailable.
export function inScopeVideoIds(projectDir) {
  const db = openProjectDb(projectDir); if (!db) return [];
  try { return db.prepare('SELECT source_id FROM sources WHERE in_scope=1 ORDER BY source_id').all().map((r) => r.source_id); }
  catch { return []; } finally { db.close(); }
}

// Truthful coverage: which in-scope videos have ≥1 VALIDATED, imported knowledge record (a knowledge row
// linked through an evidence row). Returns { selected:[ids], covered:[ids], knowledgeCount }.
export function validatedCoverage(projectDir) {
  const db = openProjectDb(projectDir); if (!db) return { selected: [], covered: [], knowledgeCount: 0 };
  try {
    const selected = db.prepare('SELECT source_id FROM sources WHERE in_scope=1 ORDER BY source_id').all().map((r) => r.source_id);
    const inScope = new Set(selected);
    const coveredAll = db.prepare(
      `SELECT DISTINCT e.video_id AS vid
         FROM knowledge_evidence ke
         JOIN evidence e ON e.evidence_id = ke.evidence_id`).all().map((r) => r.vid);
    const covered = [...new Set(coveredAll.filter((v) => inScope.has(v)))].sort(); // dedup + only in-scope; unrelated IDs cannot satisfy coverage
    const knowledgeCount = db.prepare('SELECT COUNT(*) c FROM knowledge').get().c;
    return { selected, covered, knowledgeCount };
  } catch { return { selected: [], covered: [], knowledgeCount: 0 }; } finally { db.close(); }
}

// Build deterministic bundles under <projectDir>/claude-bundles/. Overwrites any prior batch files so a
// resume rebuilds from current evidence. Returns { ok, batches:[{path,index,video_ids,evidence_ids}],
// selectedVideoIds, videoCount, evidenceCount } or { ok:false, error }.
export function buildBundles(projectDir, { batchSize = 8, canonicalLimit = 200, username = null } = {}) {
  const db = openProjectDb(projectDir);
  if (!db) return { ok: false, error: 'project db unavailable (node:sqlite missing or no state.sqlite)' };
  try {
    const sources = db.prepare(
      'SELECT source_id, external_id, source_url, published_at, caption FROM sources WHERE in_scope=1 ORDER BY source_id').all();
    const selectedVideoIds = sources.map((s) => s.source_id);
    const evStmt = db.prepare(
      `SELECT evidence_id, evidence_type, timestamp_start, timestamp_end, source_url, content, confidence
         FROM evidence WHERE video_id = ? ORDER BY (timestamp_start IS NULL), timestamp_start, evidence_id`);
    const canonical = (() => {
      try {
        return db.prepare('SELECT knowledge_id, type, title, description FROM knowledge ORDER BY knowledge_id LIMIT ?')
          .all(Math.max(0, canonicalLimit | 0));
      } catch { return []; }
    })();

    const videos = sources.map((s) => {
      const evidence = curateEvidence(evStmt.all(s.source_id).map((e) => ({
        video_id: s.source_id,
        evidence_id: e.evidence_id, evidence_type: e.evidence_type,
        timestamp_start: e.timestamp_start, timestamp_end: e.timestamp_end,
        source_url: e.source_url, content: e.content, confidence: e.confidence,
      })), { maxOcrPerVideo: 12 });
      const evidence_refs = evidence.map((e) => ({
        evidence_id: e.evidence_id, video_id: s.source_id, source_url: e.source_url,
        timestamp_start: e.timestamp_start, timestamp_end: e.timestamp_end,
        excerpt: e.content,
      }));
      return {
        video_id: s.source_id, external_id: s.external_id, source_url: s.source_url,
        published_at: s.published_at, caption: s.caption || null, transcript: transcriptText(projectDir, s.source_id),
        evidence, evidence_refs,
      };
    });

    const bundleDir = join(projectDir, 'claude-bundles');
    mkdirSync(bundleDir, { recursive: true });
    // Clear stale top-level batch files (never touch subdirs like the compiler's timestamped exports).
    for (const f of safeReaddir(bundleDir)) { if (/^batch-\d+\.json$/.test(f) || /^\.out-batch-\d+\.json$/.test(f)) { try { rmSync(join(bundleDir, f), { force: true }); } catch { /* ignore */ } } }

    const size = Math.max(1, batchSize | 0);
    const batches = [];
    let evidenceCount = 0;
    const chunks = Math.max(1, Math.ceil(videos.length / size));
    for (let i = 0; i < videos.length; i += size) {
      const slice = videos.slice(i, i + size);
      const index = batches.length + 1;
      const evIds = slice.flatMap((v) => v.evidence.map((e) => e.evidence_id));
      evidenceCount += evIds.length;
      const bundle = {
        schema: BUNDLE_SCHEMA,
        project: pathBase(projectDir),
        creator: username ? `@${username}` : null,
        batch: { index, of: chunks },
        video_ids: slice.map((v) => v.video_id),
        evidence_ids: evIds,
        knowledge_record_schema: KNOWLEDGE_RECORD_SCHEMA,
        canonical_knowledge: canonical,
        videos: slice,
        output_contract: { shape: { records: ['KnowledgeRecord'] }, note: 'Return only this JSON object as structured output.' },
      };
      const p = join(bundleDir, `batch-${String(index).padStart(2, '0')}.json`);
      writeFileSync(p, JSON.stringify(bundle, null, 2));
      batches.push({ path: p, index, video_ids: bundle.video_ids, evidence_ids: evIds });
    }
    return { ok: true, batches, selectedVideoIds, videoCount: videos.length, evidenceCount };
  } catch (e) {
    return { ok: false, error: `bundle build failed: ${e.message}` };
  } finally { db.close(); }
}

// Rewrite a batch immediately before it is sent to Claude so batch 2 sees knowledge imported from
// batch 1. This prevents cross-batch duplicates; the original implementation froze canonical state
// before any imports happened.
export function refreshBundleCanonical(projectDir, bundlePath, canonicalLimit = 1000) {
  const db = openProjectDb(projectDir); if (!db) return { ok: false, error: 'project db unavailable' };
  try {
    const canonical = db.prepare(
      'SELECT knowledge_id, type, title, description, attribution, status FROM knowledge ORDER BY knowledge_id LIMIT ?')
      .all(Math.max(0, canonicalLimit | 0));
    const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
    bundle.canonical_knowledge = canonical;
    const tmp = `${bundlePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(bundle, null, 2)); renameSync(tmp, bundlePath);
    return { ok: true, count: canonical.length };
  } catch (e) { return { ok: false, error: `canonical refresh failed: ${e.message}` }; }
  finally { db.close(); }
}

function safeReaddir(d) { try { return readdirSync(d); } catch { return []; } }
function pathBase(p) { const parts = String(p).split('/').filter(Boolean); return parts[parts.length - 1] || p; }
