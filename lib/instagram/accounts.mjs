// One row per researched account for the Creator Library and the Board Room: the counts, the
// keep / prune verdict with its reason, what "unresolved" really is right now (open vs resolved), the
// archive state, and — when an account has evidence but no knowledge — WHY, from its research job.
//
// Pure: everything is passed in (projects from library.listProjects, corpora from
// insights.libraryCorpora, jobs from jobs.listJobs, the prune archive). Tested in accounts.test.mjs.

import { accountVerdict } from './relevance.mjs';
import { resolveAmbiguous } from './resolutions.mjs';

const lc = (s) => String(s || '').toLowerCase();

// Why an account has evidence but 0 knowledge — said in words the owner can act on.
export function knowledgeDiagnosis({ counts = {}, usableEvidence = null, job = null }) {
  const ev = counts.evidence || 0; const kn = counts.knowledge || 0;
  if (kn > 0 || ev === 0) return null;
  if (job && (job.status === 'running' || job.status === 'queued')) return { code: 'in_progress', text: `research is ${job.status} (stage ${job.stage}) — knowledge is extracted after transcripts and OCR` };
  if (usableEvidence === 0) return { code: 'no_usable_evidence', text: `all ${ev} evidence rows are low-quality screen text the extractor ignores (no speech, no caption) — nothing citable to learn from` };
  if (job && job.stage === 'knowledge' && ['failed', 'needs_review', 'needs_setup', 'interrupted', 'cancelled'].includes(job.status)) {
    return { code: 'knowledge_failed', text: `the knowledge stage stopped (${job.status}): ${String(job.error || 'no reason recorded').slice(0, 240)} — "resume instagram ${job.username}" retries it without re-downloading` };
  }
  if (job && ['failed', 'needs_review', 'needs_setup', 'needs_login', 'interrupted', 'cancelled'].includes(job.status)) {
    return { code: 'stopped_before_knowledge', text: `research stopped at ${job.stage} (${job.status})${job.error ? `: ${String(job.error).slice(0, 200)}` : ''} — knowledge was never extracted` };
  }
  if (!job) return { code: 'no_job', text: 'no research job on record for this dataset — "research instagram <user>" extracts its knowledge from the stored evidence' };
  return { code: 'unknown', text: `last job ${job.status} at ${job.stage}; no knowledge was imported` };
}

// Every account, enriched. `corpora` are post-archive / post-resolution; an archived account is listed
// with archived:true (it has no corpus) so the owner can restore it.
export function accountRows({ projects = [], corpora = [], jobs = [], archive = null } = {}) {
  const byProject = new Map(corpora.map((c) => [c.project, c]));
  const allKnowledge = corpora.flatMap((c) => (c.knowledge || []).map((k) => ({ ...k, _project: c.project })));
  return projects.map((p) => {
    const corpus = byProject.get(p.name) || null;
    const user = lc(p.username || p.name.replace(/^instagram-/, ''));
    const job = jobs.find((j) => j.project === p.name || lc(j.username) === user) || null; // listJobs is newest first
    const archived = archive?.accounts?.[p.name] || archive?.purged?.accounts?.[p.name] || null;
    let verdict = corpus ? accountVerdict(corpus) : null;
    // Knowledge that prune archived is out of view, not "never extracted" — say which.
    const archivedRows = Object.keys(archive?.rows?.[p.name] || {}).length + Object.keys(archive?.purged?.rows?.[p.name] || {}).length;
    if (verdict && archivedRows && !(corpus.knowledge || []).length) verdict = { ...verdict, why: verdict.why.replace('no knowledge extracted yet', `no knowledge left in view (${archivedRows} archived row${archivedRows === 1 ? '' : 's'})`) };
    // "Unresolved" = knowledge the extractor marked `ambiguous`. Resolved here: corroborated by another
    // record (any creator), stated in ≥2 videos, or decided by the owner. Open = still one video, no second source.
    let unresolved = archived ? { total: 0, open: 0, resolved: 0 } : { total: p.unresolved || 0, open: p.unresolved || 0, resolved: 0 };
    if (corpus) {
      const amb = (corpus.knowledge || []).filter((k) => lc(k.compilerStatus || k.status) === 'ambiguous');
      const open = amb.filter((k) => !k.resolution || k.resolution.status === 'ambiguous').length;
      unresolved = { total: amb.length, open, resolved: amb.length - open };
    }
    return {
      ...p,
      verdict: archived ? { verdict: 'archived', why: `archived ${archived.purgedAt ? 'and purged ' : ''}— ${archived.why || 'pruned'}` } : verdict,
      archived: !!archived,
      unresolved,
      usableEvidence: corpus ? (corpus.evidence || []).length : null,
      job: job ? { id: job.id, status: job.status, stage: job.stage, error: job.error || null, knowledgeCount: job.knowledgeCount || 0, updatedAt: job.updatedAt || null } : null,
      knowledgeNote: knowledgeDiagnosis({ counts: p.counts, usableEvidence: corpus ? (corpus.evidence || []).length : null, job }),
    };
  });
}

// Re-export for callers that want the raw resolution of one creator's ambiguous rows.
export { resolveAmbiguous };
