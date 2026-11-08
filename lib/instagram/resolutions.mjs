// "Unresolved" knowledge — what it is and how it now resolves.
//
// The compiler writes knowledge/unresolved.jsonl = every knowledge record whose status is `ambiguous`
// (tools/video-software-compiler/video_software_compiler/knowledge_io.py, _write_canonical_files). No
// stage ever revisits them: `reconcile` only compares numeric rule thresholds, so an ambiguous record
// stayed "unresolved" forever and the Library showed a permanent warning.
//
// Resolution is an OVERLAY owned by Seen Command (data/instagram-resolutions/<project>.json); the
// compiler's SQLite stays the untouched source of truth. Two ways a record resolves:
//   • auto  — corroborated: the same claim (token similarity, same as the insight engine's merge) is
//             stated in a NON-ambiguous record (this creator or another), or the record itself is backed
//             by ≥2 distinct videos. Corroborated records count as `probable`.
//   • owner — an explicit decision (confirmed / deprecated, or reset to ambiguous) via the route.
// Everything else stays `ambiguous`, with the reason ("one video, no second source").

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '../paths.mjs';
import { tokens, similarity } from './insights.mjs';

const OWNER_STATUSES = new Set(['confirmed', 'probable', 'deprecated', 'ambiguous']);
const dir = () => { const d = join(dataDir(), 'instagram-resolutions'); mkdirSync(d, { recursive: true }); return d; };
const file = (project) => join(dir(), `${String(project).replace(/[^A-Za-z0-9._-]/g, '_')}.json`);

export function readOverrides(project) {
  try { const p = file(project); if (!existsSync(p)) return {}; const j = JSON.parse(readFileSync(p, 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; }
}

export function setOverride(project, knowledgeId, { status, note = '' } = {}) {
  if (typeof knowledgeId !== 'string' || !knowledgeId) return { ok: false, code: 400, error: 'knowledge id required' };
  if (!OWNER_STATUSES.has(status)) return { ok: false, code: 400, error: `status must be one of ${[...OWNER_STATUSES].join(', ')}` };
  const all = readOverrides(project);
  if (status === 'ambiguous') delete all[knowledgeId];
  else all[knowledgeId] = { status, note: String(note || '').slice(0, 300), at: new Date().toISOString(), by: 'owner' };
  const p = file(project); const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(all, null, 2)); renameSync(tmp, p);
  return { ok: true, knowledge_id: knowledgeId, resolution: all[knowledgeId] || null };
}

// Pure: decide every ambiguous record's effective status. `knowledge` rows carry { knowledge_id, title,
// description, status, evidence:[{video_id}] }; `others` = non-ambiguous records from ANY creator
// (cross-creator corroboration). Returns Map knowledge_id → { status, how, reason, corroboratedBy? }.
export function resolveAmbiguous(knowledge = [], { overrides = {}, others = [] } = {}) {
  const out = new Map();
  const firm = [...knowledge, ...others].filter((k) => ['confirmed', 'probable'].includes(String(k.status || '').toLowerCase()))
    .map((k) => ({ k, toks: new Set(tokens(`${k.title || ''} ${k.description || ''}`)) }));
  for (const k of knowledge) {
    const id = k.knowledge_id;
    const o = overrides[id];
    if (o && OWNER_STATUSES.has(o.status)) { out.set(id, { status: o.status, how: 'owner', reason: o.note || 'owner decision', at: o.at }); continue; }
    if (String(k.status || '').toLowerCase() !== 'ambiguous') continue;
    const videos = new Set((k.evidence || []).map((e) => e.video_id).filter(Boolean));
    const mine = new Set(tokens(`${k.title || ''} ${k.description || ''}`));
    const match = firm.find((f) => f.k.knowledge_id !== id && similarity(mine, f.toks) >= 0.55);
    if (match) out.set(id, { status: 'probable', how: 'auto', reason: `corroborated by "${String(match.k.title).slice(0, 90)}"`, corroboratedBy: match.k.knowledge_id });
    else if (videos.size >= 2) out.set(id, { status: 'probable', how: 'auto', reason: `stated in ${videos.size} separate videos` });
    else out.set(id, { status: 'ambiguous', how: 'open', reason: 'one video and no second source yet — confirm or retire it' });
  }
  return out;
}

// Apply resolutions to a corpus's knowledge (returns a new corpus; statuses replaced where resolved).
export function applyResolutions(corpus, resolved) {
  if (!corpus || !resolved?.size) return corpus;
  return { ...corpus, knowledge: (corpus.knowledge || []).map((k) => (resolved.has(k.knowledge_id) ? { ...k, compilerStatus: k.status, status: resolved.get(k.knowledge_id).status, resolution: resolved.get(k.knowledge_id) } : k)) };
}

// The Library's "unresolved" view for one project: each ambiguous record with its resolution state.
export function unresolvedReport(project, knowledge, others = []) {
  const resolved = resolveAmbiguous(knowledge, { overrides: readOverrides(project), others });
  const items = knowledge.filter((k) => String(k.status || '').toLowerCase() === 'ambiguous' || resolved.get(k.knowledge_id)?.how === 'owner')
    .map((k) => ({ knowledge_id: k.knowledge_id, title: k.title, description: k.description, type: k.type, compilerStatus: k.status,
      resolution: resolved.get(k.knowledge_id) || null,
      evidence: (k.evidence || []).slice(0, 3).map((e) => ({ evidence_id: e.evidence_id, video_id: e.video_id, source_url: e.source_url, timestamp_start: e.timestamp_start, timestamp_end: e.timestamp_end, excerpt: String(e.content || e.excerpt || '').slice(0, 200) })) }));
  const open = items.filter((i) => !i.resolution || i.resolution.status === 'ambiguous').length;
  return { project, total: items.length, open, resolved: items.length - open, items };
}
