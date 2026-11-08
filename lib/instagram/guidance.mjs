// SeenJobs guidance / provenance bridge — turn creator evidence into a traceable guidance brief.
//
// Chain preserved end to end:
//   Instagram evidence → canonical creator knowledge → guidance brief → proposed requirement
//   → OWNER APPROVAL → build → test
// Rules: retrieve only the RELEVANT bounded records (never the whole archive into a context); creator
// advice is research/inspiration, not verified product truth; a brief is a DRAFT until the owner
// approves it, and approval never auto-starts a build. Attribution labels are never rewritten after
// adaptation (source_derived vs independent_improvement).
//
// Dependency-free: node:fs only, plus the safe read-only Library adapter for retrieval.

import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '../paths.mjs';
import * as lib from './library.mjs';

const CAVEAT = 'Creator advice is research/inspiration — NOT verified product truth, endorsement, affiliation, or guaranteed expertise. Validate against SeenJobs schema, current behavior, users, legal/defamation posture, security, and the business objective before acting.';

function gdir() { const d = join(dataDir(), 'instagram-guidance'); mkdirSync(d, { recursive: true }); return d; }
const bpath = (id) => join(gdir(), `${id}.json`);
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'x';
const handle = (p) => { const u = lib.getProject(p.name)?.config?.username; return `@${u || p.name.replace(/^instagram-/, '')}`; };

// ask: bounded, attributed context for a question — for Seen Command's reasoning lane, not a dump.
export async function ask(project, question, limit = 8) {
  const p = lib.resolveProject(project);
  if (!p) return { ok: false, code: 404, error: 'unknown project' };
  if (typeof question !== 'string' || !question.trim()) return { ok: false, code: 400, error: 'question required' };
  const rel = lib.relevantRecords(project, question, limit) || { knowledge: [] };
  const citations = [];
  for (const k of rel.knowledge) for (const e of (k.evidence || [])) {
    citations.push({ knowledge_id: k.knowledge_id, evidence_id: e.evidence_id, video_id: e.video_id, source_url: e.source_url, at: `${e.timestamp_start}–${e.timestamp_end}s`, excerpt: String(e.content || '').slice(0, 240) });
  }
  return {
    ok: true, project: p.name, question, attribution: [handle(p)], caveat: CAVEAT,
    knowledge: rel.knowledge.map((k) => ({ knowledge_id: k.knowledge_id, type: k.type, title: k.title, description: k.description, confidence: k.confidence, attribution: k.attribution })),
    citations: citations.slice(0, limit * 3),
    note: rel.knowledge.length ? 'bounded relevant creator records with exact evidence citations' : 'no matching creator knowledge found',
  };
}

// createBrief: persist a DRAFT guidance brief with the full chain. Never builds; never verifies claims.
export async function createBrief(project, { seenObjective, question, knowledgeIds } = {}) {
  const p = lib.resolveProject(project);
  if (!p) return { ok: false, code: 404, error: 'unknown project' };
  if (!seenObjective || typeof seenObjective !== 'string') return { ok: false, code: 400, error: 'seenObjective required' };

  let records = [];
  if (Array.isArray(knowledgeIds) && knowledgeIds.length) records = knowledgeIds.map((id) => lib.getKnowledge(project, id)).filter(Boolean);
  else records = (lib.relevantRecords(project, question || seenObjective, 8).knowledge || []).map((k) => lib.getKnowledge(project, k.knowledge_id)).filter(Boolean);

  // A record the compiler marked contradicted/deprecated is never offered as guidance — it is carried
  // as a CONFLICT so the owner sees it, and it cannot become a requirement.
  const stale = (r) => ['contradicted', 'deprecated'].includes(String(r.status || '').toLowerCase());
  const conflicts = records.filter(stale).map((r) => ({ knowledge_id: r.knowledge_id, title: r.title, status: r.status }));
  records = records.filter((r) => !stale(r));
  const knowledgeIdList = records.map((r) => r.knowledge_id);
  const evidenceIdList = [...new Set(records.flatMap((r) => (r.evidence || []).map((e) => e.evidence_id)))];

  const brief = {
    briefId: `instagram-guidance-${slug(p.name)}-${stamp()}`,
    project: p.name, seenObjective, question: question || null,
    knowledgeIds: knowledgeIdList, evidenceIds: evidenceIdList, creatorAttribution: [handle(p)],
    limitations: ['Accessible archive only — not the creator\'s complete archive', 'ASR/OCR can be imperfect', 'Creator context ≠ SeenJobs context'],
    conflicts,
    seenContext: {},
    transferableGuidance: records.map((r) => ({ knowledge_id: r.knowledge_id, title: r.title, why: r.description, evidenceIds: (r.evidence || []).map((e) => e.evidence_id), label: 'source_derived' })),
    nonTransferableGuidance: [],
    independentImprovements: [], // product decisions added later are labeled independent_improvement
    proposedRequirements: [],     // filled at approval, each origin-labeled + evidence-linked
    successMetrics: [],
    status: 'draft', createdAt: new Date().toISOString(),
    downstream: { task: null, build: null, pr: null, tests: [] },
    caveat: CAVEAT,
  };
  writeBrief(brief);
  return { ok: true, brief };
}

export function listBriefs(project) {
  const p = lib.resolveProject(project); if (!p) return [];
  return allBriefs().filter((b) => b.project === p.name).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map((b) => ({ briefId: b.briefId, seenObjective: b.seenObjective, status: b.status, knowledge: b.knowledgeIds.length, evidence: b.evidenceIds.length, createdAt: b.createdAt, downstream: b.downstream }));
}

export function getBrief(project, briefId) {
  const p = lib.resolveProject(project); if (!p) return null;
  const b = readBrief(briefId); return (b && b.project === p.name) ? b : null;
}

// OWNER-ONLY: move a draft into the REAL Seen Command task pipeline. Files a proposed task (a GitHub
// issue — the same substrate the Tasks tab reads and the ▶ Build button acts on) whose body carries the
// compact objective, creator attribution, knowledge + evidence IDs, source links + timestamps, the
// research caveat, and requirement-origin labels. It NEVER starts a build — the owner clicks ▶ Build.
// The filer is injectable for tests; the default files a real GitHub issue.
export async function approveBrief(project, briefId, { proposedRequirement, origin = 'source_derived', fileIssue } = {}) {
  const b = getBrief(project, briefId);
  if (!b) return { ok: false, code: 404, error: 'unknown brief' };
  if (b.status !== 'draft') return { ok: false, code: 409, error: `brief is ${b.status}, not draft` };
  if (!b.knowledgeIds.length) return { ok: false, code: 422, error: 'brief has no creator knowledge linked — nothing to propose (research the creator on this topic first)' };
  if (!['source_derived', 'independent_improvement', 'technical_requirement', 'safety_requirement'].includes(origin)) origin = 'source_derived';

  const req = { requirement_id: `req-${slug(b.seenObjective)}-${stamp()}`, title: proposedRequirement || b.seenObjective, origin, knowledgeIds: b.knowledgeIds, evidenceIds: b.evidenceIds };
  const citations = collectCitations(project, b);
  const title = `[creator-guidance] ${req.title}`.slice(0, 240);
  const body = renderTaskBody(b, req, citations);

  const filer = fileIssue || defaultFileIssue;
  let filed = null, fileError = null;
  try { const r = await filer({ title, body, labels: ['creator-guidance', origin] }); filed = { number: r.number, url: r.url || r.html_url, existing: !!r.existing }; }
  catch (e) { fileError = e && e.message ? e.message : String(e); }

  if (!filed) {
    // HONEST: do not mark approved/pretend a task exists if we couldn't file one.
    b.downstream.task = { requirement_id: req.requirement_id, error: fileError, note: 'could not file a real task — is GitHub configured (GITHUB_TOKEN)? Fix and re-approve.' };
    writeBrief(b);
    return { ok: false, code: 502, error: `approved nothing: could not file the proposed task (${fileError}). No build was started.`, brief: b };
  }

  b.proposedRequirements.push(req);
  b.status = 'approved'; b.approvedAt = new Date().toISOString();
  b.downstream.task = { requirement_id: req.requirement_id, number: filed.number, url: filed.url, existing: filed.existing, filedAt: b.approvedAt, note: 'owner-approved; a real proposed task was filed. Builder receives the compact brief + citations only (never raw media). NO build started — click ▶ Build to proceed.' };
  writeBrief(b);
  return { ok: true, brief: b, task: filed, note: `approved — filed a real proposed task${filed.existing ? ' (matched an existing one)' : ''}. NO build started automatically; click ▶ Build on the Tasks tab to proceed.` };
}

// Default filer: file a real GitHub issue via the connector (dynamic import keeps guidance decoupled).
async function defaultFileIssue({ title, body, labels }) {
  const gh = await import('../connectors/github.mjs');
  if (!gh.configured || !gh.configured()) throw new Error('GitHub is not configured (GITHUB_TOKEN) — cannot file a task');
  return gh.executeFileIssue({ title, body, labels });
}

// Pull exact citations (source URL + timestamps) for the brief's linked knowledge — for the task body.
function collectCitations(project, b) {
  const out = [];
  for (const kid of b.knowledgeIds.slice(0, 40)) {
    const k = lib.getKnowledge(project, kid); if (!k) continue;
    for (const e of (k.evidence || [])) out.push({ knowledge_id: kid, title: k.title, evidence_id: e.evidence_id, video_id: e.video_id, source_url: e.source_url, at: `${e.timestamp_start}–${e.timestamp_end}s`, excerpt: String(e.content || '').slice(0, 160) });
  }
  return out;
}

function renderTaskBody(b, req, citations) {
  const L = [];
  L.push(`**Objective:** ${b.seenObjective}`);
  L.push('');
  L.push(`**Origin:** \`${req.origin}\` · **Creator:** ${b.creatorAttribution.join(', ')} · **Brief:** \`${b.briefId}\``);
  L.push('');
  L.push('> ⚠️ ' + CAVEAT);
  L.push('');
  if (b.transferableGuidance.length) {
    L.push('**Creator-derived guidance (research, not product truth):**');
    for (const g of b.transferableGuidance.slice(0, 20)) L.push(`- ${g.title}${g.why ? ` — ${g.why}` : ''}  _(\`${g.label}\`, evidence: ${(g.evidenceIds || []).slice(0, 6).join(', ')})_`);
    L.push('');
  }
  L.push(`**Knowledge IDs (${b.knowledgeIds.length}):** ${b.knowledgeIds.slice(0, 60).join(', ')}`);
  L.push(`**Evidence IDs (${b.evidenceIds.length}):** ${b.evidenceIds.slice(0, 80).join(', ')}`);
  L.push('');
  if (citations.length) {
    L.push('**Source citations (video + timestamp):**');
    for (const c of citations.slice(0, 30)) L.push(`- \`${c.evidence_id}\` ${c.source_url || c.video_id} @ ${c.at}: "${c.excerpt}"`);
    L.push('');
  }
  L.push('**Requirement origin labels:** every line above is labeled by origin; `source_derived` = from the creator, `independent_improvement` = a Seen product decision, `technical_requirement`/`safety_requirement` = engineering/safety constraints. Validate against SeenJobs schema, users, legal/defamation posture, and security before building.');
  L.push('');
  L.push('_Filed by the Creator Intelligence guidance bridge on owner approval. No build was started automatically._');
  return L.join('\n');
}

// --- persistence -----------------------------------------------------------
function writeBrief(b) { const tmp = bpath(b.briefId) + '.tmp'; writeFileSync(tmp, JSON.stringify(b, null, 2)); renameSync(tmp, bpath(b.briefId)); }
function readBrief(id) { if (!/^instagram-guidance-[A-Za-z0-9._-]+$/.test(String(id))) return null; try { return JSON.parse(readFileSync(bpath(id), 'utf8')); } catch { return null; } }
function allBriefs() { try { return readdirSync(gdir()).filter((f) => f.endsWith('.json') && !f.endsWith('.tmp')).map((f) => { try { return JSON.parse(readFileSync(join(gdir(), f), 'utf8')); } catch { return null; } }).filter(Boolean); } catch { return []; } }
function stamp() { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${String(d.getMilliseconds()).padStart(3, '0')}`; }
