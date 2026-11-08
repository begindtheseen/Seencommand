// Instagram research jobs — the durable, resumable orchestrator over the local Python compiler.
//
// One `research instagram <user>` becomes a durable background job whose truth is a JSON file under
// seenHome/data/instagram-jobs/<id>.json (atomic writes, bounded log). The pipeline runs the tested
// compiler stage-by-stage, then builds DETERMINISTIC evidence bundles from the project's real
// state.sqlite and orchestrates bounded Claude-CLI knowledge extraction with per-batch
// `import-knowledge` validation. HONESTY RULES enforced here:
//   • Anonymous-first: no login is used unless INSTAGRAM_SESSION_USER is configured; if live retrieval
//     is rejected/rate-limited the job stops at status `needs_login` (never pretends it started/finished).
//   • Completion requires: exact selected==covered video-ID coverage from VALIDATED imported knowledge
//     (never Claude's self-report), reconciliation without blocking needs_review, a real final Claude
//     audit that actually wrote reports/claude-final-audit.json (parsed + validated), and successful
//     status + cleanup-preview. Downloading/transcribing alone is NOT complete.
//   • Cancel terminates ONLY this process's own live child (process group); it never kills a persisted
//     PID that may now belong to an unrelated process. A `running` job with no live owned child becomes
//     `interrupted` (resumable) on restart.
//
// Dependency-free (node:child_process / node:fs / node:sqlite via ./db.mjs). Every external boundary is
// injectable (opts.run / opts.runClaude / opts.runAudit / opts.doctor) so tests drive it with FAKE
// python/claude and never touch the network, Instagram, ffmpeg, or a real Claude.

import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { config } from '../config.mjs';
import { dataDir } from '../paths.mjs';
import { normalizeUsername } from './adapter.mjs';
import { buildBundles, refreshBundleCanonical, validatedCoverage, KNOWLEDGE_OUTPUT_JSON_SCHEMA } from './bundles.mjs';
import { resolveProject } from './library.mjs';

const STAGES = ['setup', 'ingest', 'preprocess', 'visuals', 'evidence', 'knowledge', 'reconcile', 'audit', 'cleanup_preview'];
const ACTIVE = new Set(['queued', 'running']);
const GLOBAL_CONCURRENCY = 2;
const LOG_CAP = 200;
// Exhaustive extraction can produce 10–20 records per video. Four videos keeps both the model's
// context and structured output below practical limits while avoiding one slow Claude call per reel.
const KNOWLEDGE_BATCH_SIZE = 4;

const liveChildren = new Map(); // jobId → ChildProcess (this process's OWNED children, for cancel only)

function jobsDir() { const d = join(dataDir(), 'instagram-jobs'); mkdirSync(d, { recursive: true }); return d; }
const jobPath = (id) => join(jobsDir(), `${id}.json`);

function writeJob(job) {
  job.updatedAt = new Date().toISOString();
  if (Array.isArray(job.log) && job.log.length > LOG_CAP) job.log = job.log.slice(-LOG_CAP);
  const tmp = jobPath(job.id) + '.tmp';
  writeFileSync(tmp, JSON.stringify(job, null, 2));
  renameSync(tmp, jobPath(job.id)); // atomic replace
  return job;
}
function readJob(id) {
  if (!/^instagram-[A-Za-z0-9._-]+$/.test(String(id))) return null;
  try { return JSON.parse(readFileSync(jobPath(id), 'utf8')); } catch { return null; }
}
function allJobs() {
  try { return readdirSync(jobsDir()).filter((f) => f.endsWith('.json') && !f.endsWith('.tmp')).map((f) => { try { return JSON.parse(readFileSync(join(jobsDir(), f), 'utf8')); } catch { return null; } }).filter(Boolean); }
  catch { return []; }
}
const pidAlive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
function log(job, msg) { (job.log ||= []).push(`${new Date().toISOString()} ${redact(msg)}`); }
function redact(s) { const h = process.env.HOME; let o = String(s); if (h) o = o.split(h).join('~'); return o.slice(0, 500); }

// Recover jobs left `running` by a previous process. A persisted pid we do NOT own is NEVER signalled
// (it may have been reused by an unrelated process); we only reason about ownership: if this process
// has no live child for the job, it was interrupted (app restart / crash) and is resumable.
// A `queued` job is in the same state: a job is queued only for the instant before its pipeline starts
// in THIS process, so one left over from a previous process would otherwise hold a concurrency slot forever.
// Waiting research (the queue) starts when a job ends, on any Creator Library request (routes.mjs), or here with `drain`.
export function recoverInterrupted({ drain = false } = {}) {
  for (const job of allJobs()) {
    if ((job.status === 'running' || job.status === 'queued') && !liveChildren.has(job.id)) {
      job.status = 'interrupted'; job.pid = null; log(job, `recovered as interrupted (owning process gone while ${job.stage}) — resumable`);
      writeJob(job);
    }
  }
  if (drain) drainQueue().catch(() => {});
}

export function listJobs() {
  return allJobs().sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')))
    .map((j) => ({ id: j.id, username: j.username, project: j.project, status: j.status, stage: j.stage,
      stageProgress: j.stageProgress, coverage: j.coverage, knowledgeCount: j.knowledgeCount,
      requestedLimit: j.requestedLimit, allVideos: j.allVideos, startedAt: j.startedAt, updatedAt: j.updatedAt,
      endedAt: j.endedAt, error: j.error, message: j.message }));
}
export function getJob(id) { return readJob(id); }

// Start (or return the existing active) research job for a creator. Boundaries are injectable for tests.
export async function startJob({ username, limit, allVideos = false } = {}, { run = runStage, runClaude = runClaudeBatch, runAudit = runClaudeAudit, doctor = realDoctor, autostart = true } = {}) {
  const u = normalizeUsername(username);
  if (!u) return { ok: false, code: 400, error: 'invalid Instagram username (letters, numbers, dots, underscores; ≤30)' };
  if (allVideos !== true) allVideos = false; // full archive must be explicit, never inferred
  const reqLimit = allVideos ? null : (Number.isInteger(limit) && limit > 0 ? limit : config.vscDefaultLimit());

  // One active job per creator — a duplicate Start returns the existing job (never downloads twice).
  const existing = allJobs().find((j) => j.username === u && ACTIVE.has(j.status));
  if (existing) return { ok: true, job: existing, deduped: true };
  if (allJobs().filter((j) => ACTIVE.has(j.status)).length >= GLOBAL_CONCURRENCY) {
    return { ok: false, code: 429, error: `busy — ${GLOBAL_CONCURRENCY} research jobs already running; try again shortly` };
  }

  const slug = u.toLowerCase().replace(/[^a-z0-9._-]/g, '');
  const id = `instagram-${slug}-${stamp()}`;
  const job = {
    id, username: u, project: `instagram-${slug}`,
    requestedLimit: reqLimit, allVideos, status: 'queued', stage: 'setup',
    resumeFromStage: null,
    stageProgress: { done: 0, total: allVideos ? null : reqLimit }, startedAt: new Date().toISOString(),
    updatedAt: null, endedAt: null, pid: null, reportPath: null, knowledgeCount: 0,
    coverage: { selected: null, processed: 0, missing: null }, cleanupPreview: null, error: null, message: null, log: [],
  };
  log(job, `queued: newest ${allVideos ? 'ALL' : reqLimit} video(s) for @${u}`);
  writeJob(job);
  if (autostart) runPipeline(job, { run, runClaude, runAudit, doctor }).catch((e) => { const j = readJob(id) || job; j.status = 'failed'; j.error = redact(e.message); writeJob(j); })
    .finally(() => { drainQueue({ run, runClaude, runAudit, doctor }).catch(() => {}); });
  return { ok: true, job };
}

// ---- research queue -------------------------------------------------------
// At most GLOBAL_CONCURRENCY jobs run at once. A research request that arrives while the worker is busy
// (several creators chosen from a discovery, or the Board Room asking for three at once) WAITS here,
// durably (data/instagram-queue.json), and starts as soon as a running job ends — never refused, never
// started twice. Each entry keeps who asked and why.
function queuePath() { return join(dataDir(), 'instagram-queue.json'); }
export function readQueue() { try { const a = JSON.parse(readFileSync(queuePath(), 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; } }
function writeQueue(q) { mkdirSync(dataDir(), { recursive: true }); const tmp = `${queuePath()}.tmp`; writeFileSync(tmp, JSON.stringify(q, null, 2)); renameSync(tmp, queuePath()); }

export async function enqueueResearch({ username, limit, reason = '', source = 'owner' } = {}, deps = {}) {
  const u = normalizeUsername(username);
  if (!u) return { ok: false, code: 400, error: 'invalid Instagram username (letters, numbers, dots, underscores; ≤30)' };
  const lim = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : undefined;
  const q = readQueue();
  const waiting = q.find((x) => x.username.toLowerCase() === u.toLowerCase());
  if (waiting) return { ok: true, queued: true, position: q.indexOf(waiting) + 1, entry: waiting, deduped: true };
  const r = await startJob({ username: u, limit: lim }, deps);
  if (r.ok) return { ok: true, started: !r.deduped, deduped: !!r.deduped, job: r.job };
  if (r.code !== 429) return r;
  const entry = { username: u, limit: lim ?? null, reason: String(reason || '').slice(0, 300), source: String(source || 'owner').slice(0, 40), queuedAt: new Date().toISOString() };
  q.push(entry); writeQueue(q);
  return { ok: true, queued: true, position: q.length, entry };
}

// Start waiting research while there is capacity. Safe to call any time (idempotent, never throws).
export async function drainQueue(deps = {}) {
  const started = [];
  for (let guard = 0; guard < 20; guard++) {
    const q = readQueue();
    if (!q.length || allJobs().filter((j) => ACTIVE.has(j.status)).length >= GLOBAL_CONCURRENCY) break;
    const next = q.shift(); writeQueue(q);
    const r = await startJob({ username: next.username, limit: next.limit ?? undefined }, deps).catch((e) => ({ ok: false, error: e.message }));
    started.push({ username: next.username, ok: !!r.ok, id: r.job?.id || null, error: r.ok ? null : r.error });
    if (!r.ok && r.code === 429) { writeQueue([next, ...readQueue()]); break; }
  }
  return started;
}

export function dequeue(username) {
  const q = readQueue(); const keep = q.filter((x) => x.username.toLowerCase() !== String(username || '').replace(/^@/, '').toLowerCase());
  writeQueue(keep); return { ok: true, removed: q.length - keep.length };
}

// The staged pipeline. Each stage updates + persists durable state; failures stop honestly.
export async function runPipeline(job, { run = runStage, runClaude = runClaudeBatch, runAudit = runClaudeAudit, doctor = realDoctor } = {}) {
  const setStage = (stage, message) => { job.status = 'running'; job.stage = stage; if (message) { job.message = message; log(job, `${stage}: ${message}`); } writeJob(job); };

  // setup — verify required deps before any process starts. doctor is injectable so orchestration tests
  // are hermetic (no machine ffmpeg/ffprobe/claude/instaloader).
  setStage('setup', 'checking local dependencies');
  const d = await doctor();
  if (!d.ok) { job.status = 'needs_setup'; job.error = `missing required tools: ${(d.missingRequired || []).join(', ')}`; job.endedAt = new Date().toISOString(); writeJob(job); return job; }

  const P = { project: job.project };
  const projectDir = join(config.vscDataRoot(), job.project);
  const resumeFromKnowledge = job.resumeFromStage === 'knowledge'
    && existsSync(join(projectDir, 'state.sqlite'));

  if (!resumeFromKnowledge) {
    // create-project (idempotent — reuse if it already exists)
    await run('create-project', { name: job.project, source: 'instagram', username: job.username }, job).catch(() => {});

    // ingest — ANONYMOUS-FIRST. Only pass a session user if one is configured; never a password.
    const sessionUser = config.instagramSessionUser() || undefined;
    const via = sessionUser ? `via the @${sessionUser} session` : 'anonymously (no login)';
    setStage('ingest', job.allVideos ? `ingesting all accessible videos ${via}` : `ingesting newest ${job.requestedLimit} ${via}`);
    const ingestOpts = { ...P, ...(job.allVideos ? { allVideos: true } : { limit: job.requestedLimit }), ...(sessionUser ? { sessionUser } : {}) };
    const ing = await run('ingest', ingestOpts, job);
    if (!ing.ok) {
      if (looksLikeLogin(ing)) {
        job.status = 'needs_login'; job.endedAt = new Date().toISOString();
        job.error = 'Instagram rejected anonymous access (private/rate-limited). Optional: authenticate your own Instagram session in Terminal (instaloader --login <user>) and set INSTAGRAM_SESSION_USER — the app never stores a password.';
        log(job, 'ingest: anonymous access rejected → needs_login'); writeJob(job); return job;
      }
      return fail(job, 'ingest', ing);
    }
    // The database is the source of truth. Some compiler/provider output shapes have omitted or
    // temporarily reported a zero count even though the committed in-scope rows are present.
    const selectedInDb = validatedCoverage(projectDir).selected.length;
    const reportedIngested = numFrom(ing.data, ['ingested', 'in_scope', 'discovered', 'count']) ?? 0;
    const ingested = selectedInDb || reportedIngested;
    job.coverage.selected = ingested; job.stageProgress = { done: ingested, total: job.allVideos ? ingested : job.requestedLimit };
    writeJob(job);

    // preprocess → visuals → evidence prep (compiler populates transcripts/frames/evidence).
    for (const [stage, cmd, opts, msg] of [
      ['preprocess', 'preprocess', P, 'transcribe + probe + frames (local)'],
      ['visuals', 'refresh-visuals', P, 'scene frames + OCR'],
      ['evidence', 'extract-knowledge', P, 'prepare evidence in the project database'],
    ]) {
      setStage(stage, msg);
      const r = await run(cmd, opts, job);
      if (!r.ok) return fail(job, stage, r);
      const failedItems = numFrom(r.data, ['failed']) || 0;
      if (failedItems > 0) {
        return needsReview(job, stage, `${failedItems} in-scope video(s) did not complete ${stage}`, job.coverage);
      }
      if (r.data && r.data.status === 'needs_review') {
        return needsReview(job, stage, `${stage} reported incomplete evidence coverage`, job.coverage);
      }
    }
  } else {
    const existing = validatedCoverage(projectDir);
    job.coverage.selected = existing.selected.length;
    job.stageProgress = { done: 0, total: existing.selected.length };
    log(job, `resume: reusing evidence for ${existing.selected.length} videos — Instagram download skipped`);
    writeJob(job);
  }

  // knowledge — deterministic bundles from the DB → bounded Claude extraction → validated imports.
  setStage('knowledge', 'building evidence bundles + extracting knowledge (local Claude CLI)');
  const kx = await extractKnowledge(job, projectDir, { run, runClaude });
  if (!kx.ok) {
    if (kx.cancelled) { job.pid = null; job.endedAt = job.endedAt || new Date().toISOString(); writeJob(job); return job; }
    if (kx.knowledgeCount != null) job.knowledgeCount = kx.knowledgeCount;
    if (kx.needsClaude) { job.status = 'needs_setup'; job.error = kx.error; job.endedAt = new Date().toISOString(); writeJob(job); return job; }
    if (kx.needsReview) { return needsReview(job, 'knowledge', kx.error, kx.coverage); }
    return fail(job, 'knowledge', kx);
  }
  job.knowledgeCount = kx.knowledgeCount || 0; writeJob(job);
  if ((job.knowledgeCount | 0) < 1) return needsReview(job, 'knowledge', 'no validated knowledge was imported', kx.coverage);

  // reconcile — must not still report blocking conflicts.
  setStage('reconcile', 'reconciling repeated/conflicting/historical knowledge');
  const rec = await run('reconcile', P, job);
  if (!rec.ok) return fail(job, 'reconcile', rec);
  if (reconcileBlocking(rec.data)) return needsReview(job, 'reconcile', 'reconciliation reports blocking conflicts (needs_review)', kx.coverage);

  // audit — coverage must be EXACT (validated covered IDs == in-scope IDs), status must succeed, and a
  // REAL final Claude audit must have actually written reports/claude-final-audit.json.
  setStage('audit', 'final review + coverage audit');
  const st = await run('status', P, job);
  if (!st.ok) return fail(job, 'audit', { error: `status command failed: ${st.error || 'unknown'}` });

  const cov = validatedCoverage(projectDir);
  const selected = new Set(cov.selected);
  const covered = new Set(cov.covered);
  const missing = [...selected].filter((v) => !covered.has(v));
  const unrelated = [...covered].filter((v) => !selected.has(v)); // cannot happen (query filters in-scope) but assert
  job.coverage = { selected: selected.size, processed: covered.size, missing: missing.length };
  if (missing.length > 0 || unrelated.length > 0 || selected.size === 0) {
    return needsReview(job, 'audit', `coverage incomplete: ${covered.size}/${selected.size} in-scope videos have validated knowledge`, job.coverage);
  }

  // Real final Claude audit → reports/claude-final-audit.json (must exist + parse + validate).
  const auditRel = join('reports', 'claude-final-audit.json');
  const auditAbs = join(projectDir, auditRel);
  try { mkdirSync(join(projectDir, 'reports'), { recursive: true }); } catch { /* ignore */ }
  try { rmSync(auditAbs, { force: true }); } catch { /* ignore */ }
  const aud = await runAudit(job, { projectDir, selected: [...selected].sort(), covered: [...covered].sort(), outPath: auditAbs });
  const audit = validateAudit(auditAbs, [...selected].sort());
  if (!aud || !aud.ok || !audit.ok) {
    return needsReview(job, 'audit', `final audit not satisfied: ${(aud && aud.error) || audit.error}`, job.coverage);
  }
  job.reportPath = existsSync(auditAbs) ? auditRel : null; // NEVER assign a path for a file that doesn't exist

  // cleanup preview (safe — no deletion). Must succeed to complete.
  setStage('cleanup_preview', 'previewing raw-media cleanup (no deletion)');
  const cp = await run('cleanup-media', P, job);
  if (!cp.ok) return fail(job, 'cleanup_preview', cp);
  job.cleanupPreview = cp.data || null;

  job.status = 'complete'; job.endedAt = new Date().toISOString(); job.error = null;
  job.resumeFromStage = null;
  job.message = `complete — ${job.coverage.processed}/${job.coverage.selected} videos, ${job.knowledgeCount} validated knowledge records`;
  log(job, job.message); writeJob(job);
  return job;
}

// Build deterministic bundles from the DB, then run bounded Claude extraction with per-batch validated
// import. Coverage is measured from the DB AFTER imports (validatedCoverage), never from Claude output.
//
// One bad batch must not cost the whole creator. It used to: the first batch that Claude failed (or
// whose output import-knowledge rejected because of ONE invalid record) returned immediately, so every
// later batch was never attempted and an account with 1,100 evidence rows ended with 0 knowledge. Now:
//   • import runs with --skip-invalid (valid records land; references are repaired from the DB; each
//     rejected record is reported), • a failed Claude call is retried once, • a failed batch is recorded
//   and the loop moves on, • a login problem stops at once (every batch would fail the same way), and
//   • the outcome is honest: some batches failed → needs_review naming them; all failed → failed.
// A resume re-runs only batches whose videos still lack knowledge.
async function extractKnowledge(job, projectDir, { run = runStage, runClaude = runClaudeBatch } = {}) {
  const built = buildBundles(projectDir, { batchSize: KNOWLEDGE_BATCH_SIZE, username: job.username });
  if (!built.ok) return { ok: false, error: built.error };
  if (!built.batches.length) return { ok: true, knowledgeCount: 0, coverage: { selected: 0, processed: 0, missing: 0 }, note: 'no in-scope evidence to extract' };

  if (!haveClaude()) return { ok: false, needsClaude: true, error: 'local Claude CLI unavailable/logged out — knowledge extraction cannot run (no metered API is used). Run `claude` in Terminal and /login.' };

  const failures = [];
  job.rejectedRecords = 0; job.batchFailures = [];
  for (let i = 0; i < built.batches.length; i++) {
    const b = built.batches[i];
    if (readJob(job.id)?.status === 'cancelled') { job.status = 'cancelled'; return { ok: false, cancelled: true }; }
    // Imports are transactional per batch. On a restart, a batch whose every video already has
    // validated knowledge was completed previously; calling Claude again only wastes time and can
    // create near-duplicates. Skip it and resume at the first genuinely uncovered batch.
    const covered = new Set(validatedCoverage(projectDir).covered);
    if (b.video_ids.length && b.video_ids.every((id) => covered.has(id))) {
      job.stageProgress = { done: i + 1, total: built.batches.length };
      job.message = `knowledge batch ${i + 1}/${built.batches.length} already complete — skipped`;
      log(job, job.message); writeJob(job);
      continue;
    }
    job.stageProgress = { done: i, total: built.batches.length }; job.message = `knowledge batch ${i + 1}/${built.batches.length}`; writeJob(job);
    const refreshed = refreshBundleCanonical(projectDir, b.path);
    if (!refreshed.ok) { failures.push({ batch: b.index, videos: b.video_ids.length, step: 'bundle', error: refreshed.error }); continue; }
    const outPath = join(projectDir, 'claude-bundles', `.out-batch-${b.index}.json`);
    let cx = await runClaude(b.path, outPath, job);
    if (!cx.ok && CLAUDE_LOGIN_RE.test(cx.error || '')) {
      return { ok: false, needsClaude: true, error: `local Claude CLI cannot run (${cx.error}). Run \`claude\` in Terminal and /login, then resume — evidence is kept, nothing is re-downloaded.` };
    }
    if (!cx.ok && readJob(job.id)?.status !== 'cancelled') {
      log(job, `knowledge batch ${b.index}: claude failed (${cx.error}) — retrying once`);
      cx = await runClaude(b.path, outPath, job);
    }
    if (!cx.ok) { failures.push({ batch: b.index, videos: b.video_ids.length, step: 'claude', error: cx.error }); log(job, `knowledge batch ${b.index}: claude failed — continuing with the next batch`); continue; }
    // validates evidence links; imports every valid record; reports rejects (never a silent drop)
    let imp = await run('import-knowledge', { project: job.project, input: outPath, skipInvalid: true }, job);
    // A worker venv older than this app does not know --skip-invalid: fall back to the strict import
    // (all-or-nothing per batch) instead of failing every batch on an unknown option.
    if (!imp.ok && /no such option|unexpected extra argument|unknown option/i.test(`${imp.error || ''}`) && /skip.invalid/i.test(`${imp.error || ''}`)) {
      log(job, 'compiler predates --skip-invalid — strict import for this batch (update the worker with npm run vsc:setup)');
      imp = await run('import-knowledge', { project: job.project, input: outPath }, job);
    }
    if (!imp.ok) { failures.push({ batch: b.index, videos: b.video_ids.length, step: 'import', error: imp.error }); log(job, `knowledge batch ${b.index}: import rejected (${imp.error}) — continuing`); continue; }
    const rejected = Array.isArray(imp.data?.rejected) ? imp.data.rejected : [];
    if (rejected.length) { job.rejectedRecords += rejected.length; log(job, `knowledge batch ${b.index}: ${rejected.length} invalid record(s) skipped (first: ${rejected[0].reason})`); }
    try { rmSync(outPath, { force: true }); } catch { /* ignore */ }
  }

  const cov = validatedCoverage(projectDir);
  const missing = cov.selected.filter((v) => !cov.covered.includes(v)).length;
  const coverage = { selected: cov.selected.length, processed: cov.covered.length, missing };
  job.batchFailures = failures.map((f) => ({ ...f, error: redact(String(f.error || '')).slice(0, 300) }));
  if (failures.length) {
    const first = job.batchFailures[0];
    const what = `${failures.length}/${built.batches.length} knowledge batch(es) failed (first: batch ${first.batch}, ${first.step}: ${first.error})`;
    if (!cov.knowledgeCount) return { ok: false, error: `${what}; no knowledge was imported. Evidence is kept — resume retries the failed batches.`, coverage };
    return { ok: false, needsReview: true, error: `${what}; ${coverage.processed}/${coverage.selected} videos have knowledge. Resume retries only the failed batches.`, coverage, knowledgeCount: cov.knowledgeCount };
  }
  return { ok: true, knowledgeCount: cov.knowledgeCount, coverage };
}
const CLAUDE_LOGIN_RE = /not logged in|please run \/login|\/login|keychain|invalid api key|authentication/i;

// ---- cancel / resume ------------------------------------------------------

export function cancelJob(id) {
  const job = readJob(id); if (!job) return { ok: false, code: 404, error: 'no such job' };
  const child = liveChildren.get(id);
  // Only ever signal a child WE own. A persisted job.pid that we don't own is left untouched — the PID
  // may since have been reused by an unrelated process, and killing it would be dangerous.
  if (child && child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } } }
  liveChildren.delete(id);
  job.status = 'cancelled'; job.pid = null; job.endedAt = new Date().toISOString(); log(job, 'cancelled by owner — completed artifacts preserved, resumable');
  writeJob(job);
  return { ok: true, job };
}

export async function resumeJob(id, { run = runStage, runClaude = runClaudeBatch, runAudit = runClaudeAudit, doctor = realDoctor } = {}) {
  const job = readJob(id); if (!job) return { ok: false, code: 404, error: 'no such job' };
  if (ACTIVE.has(job.status)) return { ok: true, job, note: 'already active' };
  const priorStage = job.stage;
  const projectDir = join(config.vscDataRoot(), job.project);
  // A retry can fail at setup before reaching knowledge again. Preserve the no-redownload path when
  // the prior run already built a complete bundle set for every current in-scope video, regardless
  // of the transient stage label left by the most recent retry/cancel.
  const reusableEvidence = hasPreparedKnowledgeBundles(projectDir);
  job.resumeFromStage = ['knowledge', 'reconcile', 'audit', 'cleanup_preview'].includes(priorStage) || reusableEvidence
    ? 'knowledge' : null;
  log(job, `resume from stage ${priorStage}${job.resumeFromStage ? ' using existing evidence (no Instagram download)' : ''}`); job.status = 'queued'; job.error = null; job.endedAt = null; writeJob(job);
  runPipeline(job, { run, runClaude, runAudit, doctor }).catch((e) => { const j = readJob(id) || job; j.status = 'failed'; j.error = redact(e.message); writeJob(j); })
    .finally(() => { drainQueue({ run, runClaude, runAudit, doctor }).catch(() => {}); });
  return { ok: true, job };
}

function hasPreparedKnowledgeBundles(projectDir) {
  if (!existsSync(join(projectDir, 'state.sqlite'))) return false;
  const selected = validatedCoverage(projectDir).selected;
  if (!selected.length) return false;
  const bundleDir = join(projectDir, 'claude-bundles');
  const covered = new Set();
  let files = []; try { files = readdirSync(bundleDir).filter((f) => /^batch-\d+\.json$/.test(f)); } catch { return false; }
  for (const file of files) {
    try {
      const bundle = JSON.parse(readFileSync(join(bundleDir, file), 'utf8'));
      for (const id of (Array.isArray(bundle.video_ids) ? bundle.video_ids : [])) covered.add(String(id));
    } catch { return false; }
  }
  return selected.every((id) => covered.has(id));
}

// ---- cleanup (Phase 5) ----------------------------------------------------

export async function cleanupPreview(id, { run = runStage } = {}) {
  const job = readJob(id); if (!job) return { ok: false, code: 404, error: 'no such job' };
  const r = await run('cleanup-media', { project: job.project }, job); // no --confirm → preview only
  if (!r.ok) return { ok: false, error: r.error };
  const preview = r.data || {};
  const pinned = getPins(job.project);
  const token = planHash(preview, pinned);
  job.cleanupPreview = { ...preview, pinned, pinnedCount: pinned.length, token, previewedAt: new Date().toISOString() }; writeJob(job);
  const note = pinned.length
    ? `${pinned.length} video(s) pinned — the compiler cleanup is all-or-nothing, so raw-media deletion is BLOCKED while pins exist (unpin to proceed, or keep them and skip deletion).`
    : (preview.ready ? 'POST cleanup-confirm with this exact token to delete raw media.' : 'not ready — blockers must clear first.');
  return { ok: true, preview: job.cleanupPreview, confirmInstruction: note };
}

// Delete raw media ONLY with a fresh, job-bound confirmation whose token still matches an unchanged
// plan INCLUDING pin state. If the plan or pins changed since preview, invalidate and require a new one.
export async function cleanupConfirm(id, { token } = {}, { run = runStage } = {}) {
  const job = readJob(id); if (!job) return { ok: false, code: 404, error: 'no such job' };
  if (!job.cleanupPreview || !job.cleanupPreview.token) return { ok: false, code: 409, error: 'no active cleanup preview — run cleanup-preview first' };
  if (token !== job.cleanupPreview.token) return { ok: false, code: 409, error: 'confirmation token mismatch — the plan changed; re-run cleanup-preview' };
  const pinsNow = getPins(job.project);
  if (pinsNow.length) return { ok: false, code: 409, error: 'retention pins exist — the compiler cleanup deletes ALL raw media and cannot selectively keep pinned videos. Unpin all to delete, or keep the pins and skip deletion.' };
  // Re-preview to confirm the plan (file count/bytes/plan + pins) is unchanged before deleting.
  const fresh = await run('cleanup-media', { project: job.project }, job);
  if (!fresh.ok) return { ok: false, error: fresh.error };
  if (planHash(fresh.data || {}, pinsNow) !== job.cleanupPreview.token) { job.cleanupPreview = null; writeJob(job); return { ok: false, code: 409, error: 'plan changed since preview — invalidated; re-preview' }; }
  const { CLEANUP_PHRASE } = phrase();
  const del = await run('cleanup-media', { project: job.project, confirm: CLEANUP_PHRASE }, job);
  if (!del.ok) return { ok: false, error: del.error };
  job.cleanupPreview = { ...job.cleanupPreview, executedAt: new Date().toISOString(), token: null };
  log(job, 'raw media deleted (owner-confirmed); evidence/knowledge/frames/transcripts preserved'); writeJob(job);
  return { ok: true, deleted: true };
}

// ---- retention pins (Phase 5) ---------------------------------------------
function pinsPath(project) { const d = join(dataDir(), 'instagram-pins'); mkdirSync(d, { recursive: true }); return join(d, `${String(project).replace(/[^A-Za-z0-9._-]/g, '_')}.json`); }
export function getPins(project) { try { const a = JSON.parse(readFileSync(pinsPath(project), 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; } }
export function setPins(project, { pin = [], unpin = [] } = {}) {
  const set = new Set(getPins(project));
  for (const v of [].concat(pin || [])) if (typeof v === 'string' && v) set.add(v);
  for (const v of [].concat(unpin || [])) set.delete(v);
  const arr = [...set].sort();
  const tmp = pinsPath(project) + '.tmp'; writeFileSync(tmp, JSON.stringify(arr, null, 2)); renameSync(tmp, pinsPath(project));
  return { ok: true, pinned: arr };
}

// ---- delete a whole researched folder (owner action, confirmation required) -----------------------
// Removes an ENTIRE creator project (videos, evidence, knowledge, everything) from the writable data
// root. Guardrails: refuses read-only/registered datasets (e.g. a registered fixture dataset), refuses
// anything outside the writable VSC_DATA_ROOT, and requires the caller to type the exact project name
// as confirmation. Also cancels any active job and clears the project's jobs + pins.
export function deleteProject(project, { confirm } = {}) {
  const p = resolveProject(project);
  if (!p) return { ok: false, code: 404, error: 'unknown project' };
  if (p.readOnly) return { ok: false, code: 403, error: 'this creator dataset is read-only (a registered fixture / external root) — Seen Command will not delete it' };
  // Belt-and-suspenders: the real dir MUST live under the writable data root.
  let rootReal; try { rootReal = realpathSync(config.vscDataRoot()); } catch { rootReal = null; }
  if (!rootReal || (p.dir !== rootReal && !p.dir.startsWith(rootReal + '/'))) return { ok: false, code: 403, error: 'refusing to delete a project outside the writable data root' };
  if (confirm !== p.name && confirm !== project) return { ok: false, code: 400, error: `type the exact project name to confirm deletion: ${p.name}` };

  const freedBytes = dirBytes(p.dir);
  // Cancel + remove any jobs for this project (kill only children WE own — never a foreign pid).
  for (const j of allJobs().filter((x) => x.project === p.name)) {
    const child = liveChildren.get(j.id);
    if (child && child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } } }
    liveChildren.delete(j.id);
    try { rmSync(jobPath(j.id), { force: true }); } catch { /* ignore */ }
  }
  try { rmSync(pinsPath(p.name), { force: true }); } catch { /* ignore */ }
  rmSync(p.dir, { recursive: true, force: true });
  return { ok: true, deleted: true, project: p.name, freedBytes };
}

function dirBytes(dir) {
  let total = 0;
  const walk = (d, depth) => {
    if (depth > 8) return;
    let entries = []; try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) { const full = join(d, e.name); try { if (e.isDirectory()) walk(full, depth + 1); else total += statSync(full).size; } catch { /* skip */ } }
  };
  walk(dir, 0); return total;
}

// ---- stage runner (spawn; pid-tracked; cancellable) -----------------------

function runStage(subcommand, opts, job) {
  return new Promise((resolve) => {
    const py = config.vscPython();
    if (!existsSync(py)) { resolve({ ok: false, error: 'compiler python missing', code: 'NO_PYTHON' }); return; }
    const args = ['-m', 'video_software_compiler', subcommand, ...flat(opts)];
    const env = { PATH: config.toolPath(), HOME: process.env.HOME || '', LANG: process.env.LANG || 'en_US.UTF-8', VSC_DATA_ROOT: config.vscDataRoot() };
    const child = spawn(py, args, { cwd: config.vscToolDir(), env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (job) { job.pid = child.pid; liveChildren.set(job.id, child); }
    let out = '', err = '', size = 0;
    child.stdout.on('data', (c) => { size += c.length; if (size < 4e6) out += c; });
    child.stderr.on('data', (c) => { if (err.length < 4000) err += c; });
    child.on('error', (e) => { if (job) { liveChildren.delete(job.id); job.pid = null; } resolve({ ok: false, error: redact(e.message), code: 'SPAWN' }); });
    child.on('close', (code) => {
      if (job) { liveChildren.delete(job.id); job.pid = null; }
      let data = null; try { data = JSON.parse(out); } catch { /* text */ }
      // The compiler prints error text to stdout (Rich); fall back to it so the real reason surfaces
      // (and looksLikeLogin can classify auth failures) instead of a bare "exit N".
      resolve(code === 0 ? { ok: true, data, raw: out } : { ok: false, code, error: redact(err || out || `exit ${code}`), data, raw: out });
    });
  });
}

// ---- Claude CLI runners ---------------------------------------------------

// Real doctor (default). Injectable so tests never depend on machine ffmpeg/claude/instaloader.
async function realDoctor() { const { doctor } = await import('./adapter.mjs'); return doctor(); }

// True only if the local Claude CLI is actually invocable. ESM-safe (no require()): a bare `claude`
// name is looked up on PATH via execFileSync; an explicit path is checked on disk.
function haveClaude() {
  const c = config.claudeCliPath();
  if (c.includes('/')) return existsSync(c);
  try { execFileSync('/usr/bin/which', [c], { stdio: 'ignore', env: { ...process.env, PATH: config.toolPath() } }); return true; }
  catch { return false; }
}

// Run one bounded Claude-CLI extraction batch from the CORRECT working directory (the compiler tool dir,
// where the video-to-software-compiler skill lives). Writes a strict JSON batch to outPath.
function runClaudeBatch(bundlePath, outPath, job) {
  const prompt = `Read the evidence bundle at ${bundlePath} and extract the creator's complete useful intelligence. `
    + `Follow the video-to-software-compiler skill and the exact KnowledgeRecord schema in the bundle. `
    + `Extract every distinct principle, rule, workflow, formula, tool, claim, example, exception, and warning—not a vague transcript summary. `
    + `Copy evidence objects from videos[].evidence_refs exactly; never invent IDs, video IDs, URLs, excerpts, or timestamps. `
    + `Separate direct teaching, demonstrated behavior, claims, and system inference with the allowed attribution enum. `
    + `Keep promotions/results as unverified claims. Deduplicate against canonical_knowledge and within the batch. `
    + `This research serves SeenJobs (seenjobs.io), which grades employers on how they treat job applicants. Be complete, but give the most care to what such a brand can use: `
    + `how videos open (the first seconds), formats and structure, posting cadence, calls to action, the audience's job-search pains in their own words, trust and credibility, monetization, and product ideas. `
    + `Software-shortcut and gear trivia only when the creator actually teaches it. `
    + `Return only the structured JSON requested by the schema.`;
  return runClaude({ prompt, schema: KNOWLEDGE_OUTPUT_JSON_SCHEMA, outPath, job, addDir: dirname(bundlePath),
    onOut: () => { try { return collectVideoIds(JSON.parse(readFileSync(outPath, 'utf8'))); } catch { return []; } } });
}

// Run the REAL final audit: Claude reviews coverage and writes reports/claude-final-audit.json.
function runClaudeAudit(job, { selected, covered, outPath } = {}) {
  const prompt = `Final coverage audit for project ${job.project}. Selected in-scope video_ids: ${JSON.stringify(selected)}. `
    + `Video_ids with validated imported knowledge: ${JSON.stringify(covered)}. Confirm every selected video is covered by validated evidence-linked knowledge and there are no unrelated or duplicate IDs. `
    + `Return only the requested structured JSON.`;
  const schema = { type: 'object', additionalProperties: false,
    required: ['coverage_confirmed', 'video_ids', 'notes'], properties: {
      coverage_confirmed: { type: 'boolean' }, video_ids: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' },
    } };
  return runClaude({ prompt, schema, outPath, job });
}

// Shared spawn for the Claude CLI. cwd = the compiler tool dir so the skill is on hand. Resolves
// { ok, videoIds? } only when the process exits 0 AND outPath was actually written.
function runClaude({ prompt, schema, outPath, job, addDir = null, onOut = null, timeoutMs = Number(process.env.VSC_CLAUDE_TIMEOUT_MS) || 25 * 60 * 1000 }) {
  return new Promise((resolveRaw) => {
    // A hung CLI used to hold a job in "running" forever. Bound every call; on timeout kill our own
    // process group and report it, so the batch is retried / recorded instead of stalling the job.
    let settled = false; let timer = null;
    const resolve = (v) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); resolveRaw(v); };
    const claude = config.claudeCliPath();
    // Keep the child environment deliberately small, but preserve the local identity variables
    // Claude Code needs to resolve its macOS Keychain login. HOME alone is not sufficient: without
    // USER the CLI reports "Not logged in" even when `claude auth status` is healthy in Terminal.
    // Do NOT forward the app's ANTHROPIC_API_KEY (or other Claude auth overrides). Seen Command can
    // load a key for its board models, but Claude Code must use the owner's separate claude.ai CLI
    // login; forwarding the app key takes precedence and disables that working subscription login.
    const env = {
      PATH: config.toolPath(),
      HOME: process.env.HOME || '',
      USER: process.env.USER || '',
      LOGNAME: process.env.LOGNAME || process.env.USER || '',
      TMPDIR: process.env.TMPDIR || '/tmp',
      LANG: process.env.LANG || 'en_US.UTF-8',
    };
    let cwd; try { cwd = existsSync(config.vscToolDir()) ? config.vscToolDir() : process.cwd(); } catch { cwd = process.cwd(); }
    const args = ['-p', prompt, '--output-format', 'json', '--json-schema', JSON.stringify(schema),
      '--permission-mode', 'dontAsk', '--no-session-persistence', '--effort', 'high'];
    if (addDir) args.push('--add-dir', addDir, '--tools', 'Read'); else args.push('--tools', '');
    const child = spawn(claude, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (job) liveChildren.set(job.id, child);
    timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
      resolve({ ok: false, error: `claude timed out after ${Math.round(timeoutMs / 60000)} min` });
    }, timeoutMs);
    if (timer.unref) timer.unref();
    let out = '', err = '', size = 0;
    child.stdout.on('data', (c) => { size += c.length; if (size <= 8 * 1024 * 1024) out += c; });
    child.stderr.on('data', (c) => { if (err.length < 2000) err += c; });
    child.on('error', (e) => { if (job) liveChildren.delete(job.id); resolve({ ok: false, error: redact(e.message) }); });
    child.on('close', (code) => {
      if (job) liveChildren.delete(job.id);
      if (code !== 0) return resolve({ ok: false, error: redact(err || out || `claude exit ${code}`) });
      if (size > 8 * 1024 * 1024) return resolve({ ok: false, error: 'claude structured output exceeded 8 MB' });
      let envelope, payload;
      try {
        envelope = JSON.parse(out); payload = envelope.structured_output ?? JSON.parse(envelope.result);
      } catch (e) { return resolve({ ok: false, error: `claude returned malformed structured output: ${redact(e.message)}` }); }
      try {
        const tmp = `${outPath}.tmp`; writeFileSync(tmp, JSON.stringify(payload, null, 2)); renameSync(tmp, outPath);
      } catch (e) { return resolve({ ok: false, error: `could not persist claude output: ${redact(e.message)}` }); }
      resolve({ ok: true, videoIds: onOut ? onOut() : undefined });
    });
  });
}

// ---- helpers --------------------------------------------------------------

function flat(opts = {}) {
  const a = [];
  for (const [k, v] of Object.entries(opts)) {
    if (v === undefined || v === null || v === false) continue;
    const flag = '--' + k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
    if (v === true) a.push(flag); else a.push(flag, String(v));
  }
  return a;
}
function fail(job, stage, r) { job.status = (r.code && String(r.code).includes('retry')) ? 'interrupted' : 'failed'; job.stage = stage; job.error = r.error || `stage ${stage} failed`; job.endedAt = new Date().toISOString(); log(job, `${stage}: ${job.error}`); writeJob(job); return job; }
function needsReview(job, stage, why, coverage) { job.status = 'needs_review'; job.stage = stage; job.error = why; if (coverage) job.coverage = coverage; job.endedAt = new Date().toISOString(); log(job, `${stage}: needs_review — ${why}`); writeJob(job); return job; }
function looksLikeLogin(r) { const s = `${r.error || ''} ${JSON.stringify(r.data || {})}`.toLowerCase(); return /login|log in|authenticat|401|403|forbidden|private|rate.?limit|checkpoint|challenge|not logged/.test(s); }
function reconcileBlocking(data) { if (!data || typeof data !== 'object') return false; if (data.status === 'needs_review' || data.needs_review === true || data.blocking === true) return true; const n = data.blocking_count ?? data.conflicts_blocking ?? (Array.isArray(data.blocking_conflicts) ? data.blocking_conflicts.length : 0); return (n | 0) > 0; }
function validateAudit(auditAbs, selectedSorted) {
  if (!existsSync(auditAbs)) return { ok: false, error: 'reports/claude-final-audit.json was not written' };
  let a; try { a = JSON.parse(readFileSync(auditAbs, 'utf8')); } catch (e) { return { ok: false, error: `audit is malformed JSON: ${e.message}` }; }
  if (!a || typeof a !== 'object') return { ok: false, error: 'audit is not a JSON object' };
  if (a.coverage_confirmed !== true) return { ok: false, error: 'audit did not confirm coverage' };
  const ids = Array.isArray(a.video_ids) ? [...new Set(a.video_ids.map(String))].sort() : null;
  if (!ids || ids.length !== selectedSorted.length || ids.some((v, i) => v !== selectedSorted[i])) return { ok: false, error: 'audit video_ids do not match the selected in-scope set' };
  return { ok: true };
}
function numFrom(obj, paths) { if (!obj) return null; for (const p of paths) { const v = p.split('.').reduce((o, k) => (o == null ? o : o[k]), obj); if (typeof v === 'number') return v; } return null; }
function stamp() { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; }
// Plan hash folds in pin state, so changing pins invalidates a prior confirmation token.
function planHash(preview, pins = []) {
  const key = JSON.stringify({ n: preview.file_count, b: preview.bytes_to_delete, ready: preview.ready, pins: [...pins].sort() });
  let h = 0; for (let i = 0; i < key.length; i++) { h = (h * 31 + key.charCodeAt(i)) | 0; }
  return `cleanup-${(h >>> 0).toString(16)}`;
}
function phrase() { try { const txt = readFileSync(join(config.vscToolDir(), 'video_software_compiler', 'cleanup.py'), 'utf8'); const m = /CONFIRMATION_PHRASE\s*=\s*["'](.+?)["']/.exec(txt); if (m) return { CLEANUP_PHRASE: m[1] }; } catch { /* fall through */ } return { CLEANUP_PHRASE: 'DELETE RAW MEDIA' }; }
function collectVideoIds(obj, acc = new Set()) {
  if (!obj || typeof obj !== 'object') return [...acc];
  for (const [k, v] of Object.entries(obj)) {
    if ((k === 'video_id' || k === 'video_ids') && v) [].concat(v).forEach((x) => acc.add(String(x)));
    else if (typeof v === 'object') collectVideoIds(v, acc);
  }
  return [...acc];
}
