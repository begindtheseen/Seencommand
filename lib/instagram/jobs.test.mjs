// Instagram research jobs — orchestration tests. NO network, NO Instagram, NO real compiler, NO ffmpeg.
// The doctor is INJECTED (hermetic — CI has no ffmpeg/claude/instaloader). Knowledge coverage is proven
// against a REAL temp state.sqlite: the mock `import-knowledge` inserts knowledge+links into the DB, and
// completion is judged by validatedCoverage() querying that DB — never by Claude's self-report. One
// end-to-end test uses FAKE python + FAKE claude executables (real spawn) and starts WITHOUT pre-created
// bundles, proving the pipeline builds bundles from the DB itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

function env() {
  const base = mkdtempSync(join(tmpdir(), 'ig-jobs-'));
  process.env.SEEN_HOME = base;
  process.env.VSC_DATA_ROOT = join(base, 'projects');
  const tool = join(base, 'tool');
  mkdirSync(join(tool, 'video_software_compiler'), { recursive: true });
  writeFileSync(join(tool, 'pyproject.toml'), '[project]\nname = "video-software-compiler"\n');
  writeFileSync(join(tool, 'video_software_compiler', 'cleanup.py'), 'CONFIRMATION_PHRASE = "DELETE RAW MEDIA creator"\n');
  process.env.VSC_TOOL_DIR = tool;
  process.env.CLAUDE_CLI_PATH = '/bin/echo'; // haveClaude() true; real claude never used (mocked)
  delete process.env.INSTAGRAM_SESSION_USER; // anonymous-first
  return base;
}
const okDoctor = async () => ({ ok: true, missingRequired: [] });
function cleanup(base) { rmSync(base, { recursive: true, force: true }); }

// Create a project dir + a real state.sqlite seeded with in-scope videos (+ optional out-of-scope), each
// with a couple of evidence rows. Simulates the state AFTER the compiler's ingest/preprocess/evidence.
function seedProject(user, { videos = 3, outOfScope = 0 } = {}) {
  const project = `instagram-${user}`;
  const dir = join(process.env.VSC_DATA_ROOT, project);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ name: project, source: 'instagram', username: user }));
  const db = new DatabaseSync(join(dir, 'state.sqlite'));
  db.exec(`CREATE TABLE sources (source_id TEXT PRIMARY KEY, external_id TEXT, source_url TEXT, published_at TEXT, caption TEXT, in_scope INTEGER, local_path TEXT, media_type TEXT, retrieved_at TEXT, availability TEXT, metadata_json TEXT);
           CREATE TABLE evidence (evidence_id TEXT PRIMARY KEY, video_id TEXT, source_url TEXT, published_at TEXT, timestamp_start REAL, timestamp_end REAL, evidence_type TEXT, content TEXT, confidence REAL);
           CREATE TABLE knowledge (knowledge_id TEXT PRIMARY KEY, type TEXT, title TEXT, description TEXT, attribution TEXT, status TEXT, confidence REAL);
           CREATE TABLE knowledge_evidence (knowledge_id TEXT, evidence_id TEXT);`);
  const ins = db.prepare('INSERT INTO sources (source_id,external_id,source_url,published_at,caption,in_scope) VALUES (?,?,?,?,?,?)');
  const inse = db.prepare('INSERT INTO evidence (evidence_id,video_id,source_url,timestamp_start,timestamp_end,evidence_type,content,confidence) VALUES (?,?,?,?,?,?,?,?)');
  const ids = [];
  const mk = (n, scope) => {
    const sid = `instagram-vid${n}`;
    ins.run(sid, `vid${n}`, `https://instagram.com/p/vid${n}`, '2026-01-01', `caption ${n}`, scope);
    inse.run(`ev-${n}-a`, sid, `https://instagram.com/p/vid${n}`, 1.0, 3.0, 'transcript', `evidence a for ${n}`, 1.0);
    inse.run(`ev-${n}-b`, sid, `https://instagram.com/p/vid${n}`, 4.0, 6.0, 'ocr', `evidence b for ${n}`, 0.9);
    if (scope) ids.push(sid);
  };
  for (let i = 1; i <= videos; i++) mk(i, 1);
  for (let i = 1; i <= outOfScope; i++) mk(100 + i, 0);
  db.close();
  return { project, dir, videoIds: ids.sort() };
}

// Open the seeded DB read-write to let the mock import-knowledge insert validated knowledge+links.
function importIntoDb(dir, outPath) {
  const batch = JSON.parse(readFileSync(outPath, 'utf8'));
  const db = new DatabaseSync(join(dir, 'state.sqlite'));
  const k = db.prepare('INSERT INTO knowledge (knowledge_id,type,title,description,attribution,status,confidence) VALUES (?,?,?,?,?,?,?)');
  const ke = db.prepare('INSERT INTO knowledge_evidence (knowledge_id,evidence_id) VALUES (?,?)');
  let n = 0;
  for (const rec of (batch.records || [])) {
    const evIds = [].concat(rec.evidence || []).map((e) => e.evidence_id).filter(Boolean);
    if (!evIds.length) continue; // a record with no validated evidence link is not imported
    const kid = rec.knowledge_id || `k-test-${n++}`;
    k.run(kid, rec.type, rec.title, rec.description, rec.attribution, rec.status, rec.confidence);
    for (const eid of evIds) ke.run(kid, eid);
  }
  db.close();
  return n;
}

function knowledgeRecord(v, i = 0, over = {}) {
  return {
    knowledge_id: `k-${v.video_id}-${i}`,
    type: 'claim',
    title: `Useful point from ${v.video_id}`,
    description: 'A concrete, evidence-backed creator teaching.',
    formal_expression: null,
    inputs: [], outputs: [], conditions: [], steps: [], exceptions: [], dependencies: [],
    evidence: v.evidence_refs.map((e) => ({ ...e })),
    confidence: 0.9,
    attribution: 'creator_explicit',
    status: 'confirmed',
    ...over,
  };
}

// Mock compiler runner. import-knowledge inserts into the real DB; others echo success.
function mockRun(dir, over = {}) {
  return async (cmd, opts) => {
    if (over[cmd]) return over[cmd](opts);
    switch (cmd) {
      case 'create-project': case 'ingest': return { ok: true, data: { ingested: 3, in_scope: 3 } };
      case 'preprocess': case 'refresh-visuals': case 'extract-knowledge': return { ok: true, data: {} };
      case 'import-knowledge': { const imported = importIntoDb(dir, opts.input); return { ok: true, data: { imported } }; }
      case 'reconcile': return { ok: true, data: { needs_review: false, blocking_count: 0 } };
      case 'status': return { ok: true, data: { scope: { in_scope: 3 }, counts: { evidence: 6 } } };
      case 'cleanup-media': return opts.confirm ? { ok: true, data: { deleted: true } } : { ok: true, data: { ready: true, file_count: 3, bytes_to_delete: 1000 } };
      default: return { ok: true, data: {} };
    }
  };
}
// Mock claude: cover the given subset of the bundle's videos, citing their REAL evidence_ids. `pick`
// maps the bundle's video list → the (video_id, evidence_ids) records to emit (lets tests force
// partial/duplicate/unrelated coverage).
function mockClaudeWith(pick) {
  return async (bundlePath, outPath) => {
    const b = JSON.parse(readFileSync(bundlePath, "utf8"));
    const records = pick(b);
    writeFileSync(outPath, JSON.stringify({ records }));
    return { ok: true, videoIds: [...new Set(records.flatMap((r) => r.evidence.map((e) => e.video_id)))] };
  };
}
// Full-coverage claude: one record per video citing all its evidence.
const mockClaudeFull = mockClaudeWith((b) => b.videos.map((v, i) => knowledgeRecord(v, i)));
// Audit mock: writes a valid final audit file confirming the selected set.
const mockAudit = async (_job, { selected, outPath }) => { writeFileSync(outPath, JSON.stringify({ coverage_confirmed: true, video_ids: selected, notes: 'ok' })); return { ok: true }; };

async function loadJobs(tag) { return import(`./jobs.mjs?t=${Date.now()}${tag}`); }

test('HAPPY PATH: bundles built from DB → claude → validated import → exact coverage → audit → complete', async () => {
  const base = env(); const { dir, videoIds } = seedProject('creator', { videos: 3 });
  try {
    const jobs = await loadJobs('a');
    const { job } = await jobs.startJob({ username: 'creator', limit: 3 }, { autostart: false });
    const done = await jobs.runPipeline(job, { run: mockRun(dir), runClaude: mockClaudeFull, runAudit: mockAudit, doctor: okDoctor });
    assert.equal(done.status, 'complete', done.error || '');
    assert.deepEqual(done.coverage, { selected: 3, processed: 3, missing: 0 });
    assert.ok(done.knowledgeCount >= 3);
    assert.equal(done.reportPath, 'reports/claude-final-audit.json');
    assert.ok(existsSync(join(dir, 'reports', 'claude-final-audit.json')));
    // bundles were actually created from the DB (not preseeded)
    assert.ok(existsSync(join(dir, 'claude-bundles', 'batch-01.json')));
    assert.equal(videoIds.length, 3); // the seeded in-scope set the coverage was measured against
  } finally { cleanup(base); }
});

test('hermetic: injected doctor removes the machine ffmpeg/claude dependency (CI-safe)', async () => {
  const base = env(); const { dir } = seedProject('creator', { videos: 2 });
  try {
    const jobs = await loadJobs('doc');
    const { job } = await jobs.startJob({ username: 'creator', limit: 2 }, { autostart: false });
    const done = await jobs.runPipeline(job, { run: mockRun(dir), runClaude: mockClaudeFull, runAudit: mockAudit, doctor: okDoctor });
    assert.equal(done.status, 'complete', done.error || '');
  } finally { cleanup(base); }
});

test('knowledge-stage resume reuses existing evidence and skips Instagram/media stages', async () => {
  const base = env(); const { dir } = seedProject('creator', { videos: 2 });
  try {
    const jobs = await loadJobs('resume-knowledge');
    const { job } = await jobs.startJob({ username: 'creator', limit: 2 }, { autostart: false });
    job.resumeFromStage = 'knowledge';
    const calls = [];
    const delegate = mockRun(dir);
    const run = async (command, options) => { calls.push(command); return delegate(command, options); };
    const done = await jobs.runPipeline(job, { run, runClaude: mockClaudeFull, runAudit: mockAudit, doctor: okDoctor });
    assert.equal(done.status, 'complete', done.error || '');
    for (const skipped of ['create-project', 'ingest', 'preprocess', 'refresh-visuals', 'extract-knowledge']) {
      assert.ok(!calls.includes(skipped), `${skipped} must be skipped on a knowledge resume`);
    }
    assert.ok(calls.includes('import-knowledge'));
    assert.ok(done.log.some((line) => /Instagram download skipped/i.test(line)));
  } finally { cleanup(base); }
});

test('resume after a transient setup/cancel keeps the no-redownload path when complete bundles exist', async () => {
  const base = env(); const { dir, videoIds } = seedProject('creator', { videos: 2 });
  try {
    const bundleDir = join(dir, 'claude-bundles'); mkdirSync(bundleDir, { recursive: true });
    writeFileSync(join(bundleDir, 'batch-01.json'), JSON.stringify({ video_ids: videoIds }));
    const jobs = await loadJobs('resume-after-setup');
    const { job } = await jobs.startJob({ username: 'creator', limit: 2 }, { autostart: false });
    jobs.cancelJob(job.id); // stage is still an early stage, as after a setup retry/cancel
    const resumed = await jobs.resumeJob(job.id, { doctor: () => new Promise(() => {}) });
    assert.equal(resumed.job.resumeFromStage, 'knowledge');
    assert.ok(resumed.job.log.some((line) => /no Instagram download/i.test(line)));
  } finally { cleanup(base); }
});

test('knowledge resume skips fully imported batches and continues at the first uncovered video', async () => {
  const base = env(); const { dir } = seedProject('creator', { videos: 5 });
  try {
    const db = new DatabaseSync(join(dir, 'state.sqlite'));
    const k = db.prepare('INSERT INTO knowledge (knowledge_id,type,title,description,attribution,status,confidence) VALUES (?,?,?,?,?,?,?)');
    const ke = db.prepare('INSERT INTO knowledge_evidence (knowledge_id,evidence_id) VALUES (?,?)');
    for (let i = 1; i <= 4; i++) {
      k.run(`k-existing-${i}`, 'claim', `Existing ${i}`, 'already imported', 'creator_explicit', 'confirmed', 0.9);
      ke.run(`k-existing-${i}`, `ev-${i}-a`);
    }
    db.close();
    const jobs = await loadJobs('skip-complete-batch');
    const { job } = await jobs.startJob({ username: 'creator', limit: 5 }, { autostart: false });
    job.resumeFromStage = 'knowledge';
    const seen = [];
    const claude = mockClaudeWith((bundle) => {
      seen.push(bundle.video_ids);
      return bundle.videos.map((video, i) => knowledgeRecord(video, i));
    });
    const done = await jobs.runPipeline(job, { run: mockRun(dir), runClaude: claude, runAudit: mockAudit, doctor: okDoctor });
    assert.equal(done.status, 'complete', done.error || '');
    assert.deepEqual(seen, [['instagram-vid5']], 'the completed four-video batch must not call Claude again');
    assert.ok(done.log.some((line) => /batch 1\/2 already complete — skipped/.test(line)));
    assert.equal(done.coverage.processed, 5);
  } finally { cleanup(base); }
});

test('NEGATIVE — partial coverage → needs_review (not complete)', async () => {
  const base = env(); seedProject('creator', { videos: 3 });
  try {
    const jobs = await loadJobs('b'); const { dir } = { dir: join(process.env.VSC_DATA_ROOT, 'instagram-creator') };
    const claude = mockClaudeWith((b) => b.videos.slice(0, b.videos.length - 1).map((v, i) => knowledgeRecord(v, i)));
    const { job } = await jobs.startJob({ username: 'creator', limit: 3 }, { autostart: false });
    const done = await jobs.runPipeline(job, { run: mockRun(dir), runClaude: claude, runAudit: mockAudit, doctor: okDoctor });
    assert.equal(done.status, 'needs_review');
    assert.ok(done.coverage.missing >= 1);
  } finally { cleanup(base); }
});

test('NEGATIVE — duplicate video IDs cannot satisfy coverage', async () => {
  const base = env(); const { dir } = seedProject('creator', { videos: 3 });
  try {
    const jobs = await loadJobs('c');
    // cover v0 twice + v1; v2 never covered → covered set size 2 ≠ 3
    const claude = mockClaudeWith((b) => { const v0 = b.videos[0], v1 = b.videos[1]; return [v0, v0, v1].map((v, i) => knowledgeRecord(v, i)); });
    const { job } = await jobs.startJob({ username: 'creator', limit: 3 }, { autostart: false });
    const done = await jobs.runPipeline(job, { run: mockRun(dir), runClaude: claude, runAudit: mockAudit, doctor: okDoctor });
    assert.equal(done.status, 'needs_review');
    assert.equal(done.coverage.processed, 2);
  } finally { cleanup(base); }
});

test('NEGATIVE — an unrelated/out-of-scope video ID cannot satisfy coverage', async () => {
  const base = env(); const { dir } = seedProject('creator', { videos: 3, outOfScope: 1 });
  try {
    const jobs = await loadJobs('d');
    // cover v0,v1 + the OUT-OF-SCOPE video (instagram-vid101) which must NOT count toward in-scope coverage
    const claude = mockClaudeWith((b) => {
      const recs = b.videos.slice(0, 2).map((v, i) => knowledgeRecord(v, i));
      recs.push(knowledgeRecord({ video_id: 'instagram-vid101', evidence_refs: [{
        evidence_id: 'ev-101-a', video_id: 'instagram-vid101', source_url: 'https://instagram.com/p/vid101',
        timestamp_start: 1, timestamp_end: 3, excerpt: 'out of scope',
      }] }, 2));
      return recs;
    });
    const { job } = await jobs.startJob({ username: 'creator', limit: 3 }, { autostart: false });
    const done = await jobs.runPipeline(job, { run: mockRun(dir), runClaude: claude, runAudit: mockAudit, doctor: okDoctor });
    assert.equal(done.status, 'needs_review');
    assert.equal(done.coverage.processed, 2); // only in-scope covered counts
  } finally { cleanup(base); }
});

test('NEGATIVE — zero validated knowledge → needs_review', async () => {
  const base = env(); const { dir } = seedProject('creator', { videos: 2 });
  try {
    const jobs = await loadJobs('e');
    const claude = mockClaudeWith(() => []); // no records
    const { job } = await jobs.startJob({ username: 'creator', limit: 2 }, { autostart: false });
    const done = await jobs.runPipeline(job, { run: mockRun(dir), runClaude: claude, runAudit: mockAudit, doctor: okDoctor });
    assert.equal(done.status, 'needs_review');
    assert.match(done.error, /no validated knowledge/i);
  } finally { cleanup(base); }
});

test('NEGATIVE — reconciliation needs_review blocks completion', async () => {
  const base = env(); const { dir } = seedProject('creator', { videos: 2 });
  try {
    const jobs = await loadJobs('f');
    const run = mockRun(dir, { reconcile: async () => ({ ok: true, data: { needs_review: true } }) });
    const { job } = await jobs.startJob({ username: 'creator', limit: 2 }, { autostart: false });
    const done = await jobs.runPipeline(job, { run, runClaude: mockClaudeFull, runAudit: mockAudit, doctor: okDoctor });
    assert.equal(done.status, 'needs_review');
    assert.match(done.error, /reconcil/i);
  } finally { cleanup(base); }
});

test('NEGATIVE — incomplete preprocessing evidence blocks Claude extraction', async () => {
  const base = env(); const { dir } = seedProject('creator', { videos: 2 });
  try {
    const jobs = await loadJobs('preprocess-incomplete');
    const run = mockRun(dir, { preprocess: async () => ({ ok: true, data: { complete: 1, failed: 1 } }) });
    const { job } = await jobs.startJob({ username: 'creator', limit: 2 }, { autostart: false });
    const done = await jobs.runPipeline(job, { run, runClaude: mockClaudeFull, runAudit: mockAudit, doctor: okDoctor });
    assert.equal(done.status, 'needs_review');
    assert.equal(done.stage, 'preprocess');
    assert.match(done.error, /1 in-scope video/i);
  } finally { cleanup(base); }
});

test('NEGATIVE — status command failure fails the audit (no false complete)', async () => {
  const base = env(); const { dir } = seedProject('creator', { videos: 2 });
  try {
    const jobs = await loadJobs('g');
    const run = mockRun(dir, { status: async () => ({ ok: false, error: 'status boom' }) });
    const { job } = await jobs.startJob({ username: 'creator', limit: 2 }, { autostart: false });
    const done = await jobs.runPipeline(job, { run, runClaude: mockClaudeFull, runAudit: mockAudit, doctor: okDoctor });
    assert.equal(done.status, 'failed');
    assert.match(done.error, /status/i);
  } finally { cleanup(base); }
});

test('NEGATIVE — missing final audit file → needs_review; reportPath stays null', async () => {
  const base = env(); const { dir } = seedProject('creator', { videos: 2 });
  try {
    const jobs = await loadJobs('h');
    const noAudit = async () => ({ ok: true }); // claims ok but writes nothing
    const { job } = await jobs.startJob({ username: 'creator', limit: 2 }, { autostart: false });
    const done = await jobs.runPipeline(job, { run: mockRun(dir), runClaude: mockClaudeFull, runAudit: noAudit, doctor: okDoctor });
    assert.equal(done.status, 'needs_review');
    assert.match(done.error, /audit/i);
    assert.equal(done.reportPath, null);
  } finally { cleanup(base); }
});

test('NEGATIVE — malformed final audit JSON → needs_review', async () => {
  const base = env(); const { dir } = seedProject('creator', { videos: 2 });
  try {
    const jobs = await loadJobs('i');
    const badAudit = async (_j, { outPath }) => { writeFileSync(outPath, '{not json'); return { ok: true }; };
    const { job } = await jobs.startJob({ username: 'creator', limit: 2 }, { autostart: false });
    const done = await jobs.runPipeline(job, { run: mockRun(dir), runClaude: mockClaudeFull, runAudit: badAudit, doctor: okDoctor });
    assert.equal(done.status, 'needs_review');
    assert.match(done.error, /audit/i);
  } finally { cleanup(base); }
});

test('NEGATIVE — audit video_ids not matching the selected set → needs_review (same count, wrong IDs)', async () => {
  const base = env(); const { dir } = seedProject('creator', { videos: 2 });
  try {
    const jobs = await loadJobs('j');
    const wrongAudit = async (_j, { selected, outPath }) => { writeFileSync(outPath, JSON.stringify({ coverage_confirmed: true, video_ids: selected.map((s) => s + '-x') })); return { ok: true }; };
    const { job } = await jobs.startJob({ username: 'creator', limit: 2 }, { autostart: false });
    const done = await jobs.runPipeline(job, { run: mockRun(dir), runClaude: mockClaudeFull, runAudit: wrongAudit, doctor: okDoctor });
    assert.equal(done.status, 'needs_review');
  } finally { cleanup(base); }
});

test('anonymous rejection stops honestly at needs_login', async () => {
  const base = env(); const { dir } = seedProject('creator', { videos: 2 });
  try {
    const jobs = await loadJobs('k');
    const run = mockRun(dir, { ingest: async () => ({ ok: false, error: '401 login required (private or rate-limited)' }) });
    const { job } = await jobs.startJob({ username: 'creator', limit: 2 }, { autostart: false });
    const done = await jobs.runPipeline(job, { run, runClaude: mockClaudeFull, runAudit: mockAudit, doctor: okDoctor });
    assert.equal(done.status, 'needs_login');
    assert.match(done.error, /research-only account|authenticate|separate/i);
  } finally { cleanup(base); }
});

test('duplicate start returns the existing active job; bad username rejected before anything spawns', async () => {
  const base = env();
  try {
    const jobs = await loadJobs('l');
    assert.equal((await jobs.startJob({ username: 'bad name!' }, { autostart: false })).ok, false);
    const a = await jobs.startJob({ username: 'creatorx' }, { autostart: false });
    const b = await jobs.startJob({ username: 'creatorx' }, { autostart: false });
    assert.equal(b.deduped, true); assert.equal(a.job.id, b.job.id);
    assert.equal(a.job.allVideos, false); assert.ok(a.job.requestedLimit > 0);
  } finally { cleanup(base); }
});

test('cancel marks cancelled + resumable; recoverInterrupted revives a dead running job WITHOUT signalling a foreign pid', async () => {
  const base = env();
  try {
    const jobs = await loadJobs('m');
    const { job } = await jobs.startJob({ username: 'creator', limit: 3 }, { autostart: false });
    assert.equal(jobs.cancelJob(job.id).job.status, 'cancelled');
    const revived = await jobs.startJob({ username: 'other', limit: 3 }, { autostart: false });
    const r = jobs.getJob(revived.job.id); r.status = 'running'; r.pid = 999999; // not our live child
    const fs = await import('node:fs'); fs.writeFileSync(join(base, 'data', 'instagram-jobs', `${r.id}.json`), JSON.stringify(r));
    jobs.recoverInterrupted();
    assert.equal(jobs.getJob(r.id).status, 'interrupted'); // no process.kill on the foreign pid
  } finally { cleanup(base); }
});

test('cleanup requires a matching job-bound token; pins are folded into the token', async () => {
  const base = env(); const { dir } = seedProject('creator', { videos: 3 });
  try {
    const jobs = await loadJobs('n');
    const { job } = await jobs.startJob({ username: 'creator', limit: 3 }, { autostart: false });
    await jobs.runPipeline(job, { run: mockRun(dir), runClaude: mockClaudeFull, runAudit: mockAudit, doctor: okDoctor });
    const prev = await jobs.cleanupPreview(job.id, { run: mockRun(dir) });
    assert.ok(prev.preview.token);
    assert.equal((await jobs.cleanupConfirm(job.id, { token: 'wrong' }, { run: mockRun(dir) })).ok, false);
    // pinning changes the token (proves pins are in the hash)
    jobs.setPins(job.project, { pin: ['instagram-vid1'] });
    const prev2 = await jobs.cleanupPreview(job.id, { run: mockRun(dir) });
    assert.notEqual(prev2.preview.token, prev.preview.token);
    const blocked = await jobs.cleanupConfirm(job.id, { token: prev2.preview.token }, { run: mockRun(dir) });
    assert.equal(blocked.ok, false); assert.match(blocked.error, /pins exist/i);
    jobs.setPins(job.project, { unpin: ['instagram-vid1'] });
    const prev3 = await jobs.cleanupPreview(job.id, { run: mockRun(dir) });
    const good = await jobs.cleanupConfirm(job.id, { token: prev3.preview.token }, { run: mockRun(dir) });
    assert.equal(good.deleted, true);
  } finally { cleanup(base); }
});

test('deleteProject removes a writable folder only with exact confirmation, and clears jobs + pins', async () => {
  const base = env(); const { dir } = seedProject('creator', { videos: 2 });
  try {
    const jobs = await loadJobs('del');
    assert.ok(existsSync(dir));
    assert.equal(jobs.deleteProject('instagram-creator', { confirm: 'nope' }).ok, false, 'wrong confirmation rejected');
    assert.ok(existsSync(dir), 'nothing deleted on a bad confirmation');
    jobs.setPins('instagram-creator', { pin: ['x'] });
    const r = jobs.deleteProject('instagram-creator', { confirm: 'instagram-creator' });
    assert.equal(r.ok, true); assert.equal(r.deleted, true); assert.ok(r.freedBytes > 0);
    assert.ok(!existsSync(dir), 'folder removed');
    assert.deepEqual(jobs.getPins('instagram-creator'), [], 'pins cleared');
    assert.equal(jobs.deleteProject('instagram-creator', { confirm: 'instagram-creator' }).ok, false, 'already gone → 404');
  } finally { cleanup(base); }
});

test('deleteProject REFUSES a read-only / registered dataset (never deletes the fixture)', async () => {
  const base = env();
  try {
    const ro = join(base, 'ro'); mkdirSync(join(ro, 'instagram-fixture'), { recursive: true });
    writeFileSync(join(ro, 'instagram-fixture', 'project.json'), JSON.stringify({ name: 'instagram-fixture', username: 'fixture', source: 'instagram' }));
    process.env.VSC_READONLY_ROOTS = ro;
    const jobs = await loadJobs('delro');
    const r = jobs.deleteProject('instagram-fixture', { confirm: 'instagram-fixture' });
    assert.equal(r.ok, false); assert.match(r.error, /read-only/i);
    assert.ok(existsSync(join(ro, 'instagram-fixture')), 'read-only dataset untouched');
  } finally { delete process.env.VSC_READONLY_ROOTS; cleanup(base); }
});

// ---- END-TO-END with FAKE executables (real spawn), NO preseeded bundles --------------------------
const py3 = (() => { try { execFileSync('/usr/bin/env', ['python3', '--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('END-TO-END fake executables: pipeline builds bundles from DB, runs fake claude, imports, audits, completes', { skip: py3 ? false : 'python3 not available' }, async () => {
  const base = env();
  const { dir, videoIds } = seedProject('creator', { videos: 3 }); // simulate post-ingest DB (no bundles yet)
  const tool = join(base, 'toolbin'); mkdirSync(tool, { recursive: true });
  // Fake python: compiler stages echo ok; import-knowledge inserts knowledge+links via python stdlib sqlite3.
  const py = join(tool, 'fakepy.sh');
  writeFileSync(py, `#!/bin/bash
cmd="$3"
db="${join(dir, 'state.sqlite')}"
inp=""
while [ "$#" -gt 0 ]; do case "$1" in --input) shift; inp="$1";; esac; shift; done
case "$cmd" in
  import-knowledge) python3 - "$db" "$inp" <<'PY'
import json,sqlite3,sys
db,inp=sys.argv[1],sys.argv[2]
b=json.load(open(inp)); con=sqlite3.connect(db); c=con.cursor(); n=0
for r in b.get("records",[]):
    ev=[e.get("evidence_id") for e in (r.get("evidence") or []) if e.get("evidence_id")]
    if not ev: continue
    kid=r["knowledge_id"]; n+=1
    c.execute("INSERT INTO knowledge (knowledge_id,type,title,description,attribution,status,confidence) VALUES (?,?,?,?,?,?,?)",(kid,r["type"],r["title"],r["description"],r["attribution"],r["status"],r["confidence"]))
    for e in ev: c.execute("INSERT INTO knowledge_evidence (knowledge_id,evidence_id) VALUES (?,?)",(kid,e))
con.commit(); print(json.dumps({"imported":n}))
PY
    ;;
  cleanup-media) if [[ "$*" == *"--confirm"* ]]; then echo '{"deleted":true}'; else echo '{"ready":true,"file_count":3,"bytes_to_delete":1000}'; fi;;
  reconcile) echo '{"needs_review":false,"blocking_count":0}';;
  status) echo '{"scope":{"in_scope":3},"counts":{"evidence":6}}';;
  *) echo '{"ok":true}';;
esac`);
  chmodSync(py, 0o755);
  // Fake claude: reads the bundle path and emits the same structured-output envelope as Claude CLI.
  const claude = join(tool, 'fakeclaude.sh');
  writeFileSync(claude, `#!/bin/bash
if [ -z "$USER" ]; then
  echo 'USER missing: Claude cannot resolve its macOS Keychain login' >&2
  exit 42
fi
if [ -n "$ANTHROPIC_API_KEY" ]; then
  echo 'app Anthropic key leaked into Claude extraction child' >&2
  exit 43
fi
prompt="$2"
bundle=$(printf '%s' "$prompt" | sed -n 's/.*bundle at \\([^ ]*\\.json\\).*/\\1/p')
if printf '%s' "$prompt" | grep -q 'coverage audit'; then
  ids=$(printf '%s' "$prompt" | sed -n 's/.*Selected in-scope video_ids: \\(\\[[^]]*\\]\\).*/\\1/p')
  printf '{"structured_output":{"coverage_confirmed":true,"video_ids":%s,"notes":"ok"}}' "$ids"
else
  python3 - "$bundle" <<'PY'
import json,sys
b=json.load(open(sys.argv[1])); recs=[]
for i,v in enumerate(b["videos"]):
    recs.append({"knowledge_id":"k-%s-%d"%(v["video_id"],i),"type":"claim","title":"Useful point","description":"Evidence-backed creator teaching","formal_expression":None,"inputs":[],"outputs":[],"conditions":[],"steps":[],"exceptions":[],"dependencies":[],"evidence":v["evidence_refs"],"confidence":0.9,"attribution":"creator_explicit","status":"confirmed"})
print(json.dumps({"structured_output":{"records":recs}}))
PY
fi`);
  chmodSync(claude, 0o755);
  process.env.VSC_PYTHON = py; process.env.CLAUDE_CLI_PATH = claude;
  const priorAnthropicKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'seen-board-key-must-not-reach-claude-code';
  // The fake claude refuses to run without USER (the real CLI needs it for its Keychain login). A Mac
  // shell always has USER; some CI sandboxes do not — give the test one so it checks the forwarding.
  const priorUser = process.env.USER;
  if (!process.env.USER) process.env.USER = 'seen-test';
  try {
    assert.ok(!existsSync(join(dir, 'claude-bundles', 'batch-01.json')), 'precondition: no preseeded bundles');
    const jobs = await loadJobs('e2e');
    const { job } = await jobs.startJob({ username: 'creator', limit: 3 }, { autostart: false });
    const done = await jobs.runPipeline(job, { doctor: okDoctor }); // REAL runStage/runClaude/runAudit → fake executables
    assert.equal(done.status, 'complete', `expected complete, got ${done.status}: ${done.error || ''}`);
    assert.equal(done.coverage.missing, 0);
    assert.equal(done.coverage.selected, 3);
    assert.ok(existsSync(join(dir, 'claude-bundles', 'batch-01.json')), 'bundles were built from the DB');
    assert.ok(existsSync(join(dir, 'reports', 'claude-final-audit.json')), 'final audit written');
    assert.deepEqual(videoIds.length, 3);
  } finally {
    if (priorAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = priorAnthropicKey;
    if (priorUser === undefined) delete process.env.USER; else process.env.USER = priorUser;
    cleanup(base);
  }
});

// ---- the "evidence but 0 knowledge" class (e.g. dozens of videos, 1,000+ evidence, 0 knowledge) ----
// Before: the FIRST batch that Claude failed, or whose output import-knowledge rejected, ended the job
// on the spot, so every later batch was never attempted.

test('REGRESSION — a failing first batch no longer costs the whole creator: later batches still import', async () => {
  const base = env(); const { dir } = seedProject('creator', { videos: 9 }); // 3 batches of ≤4
  try {
    const jobs = await loadJobs('batch-fail-continue');
    let calls = 0;
    const full = mockClaudeWith((b) => b.videos.map((v, i) => knowledgeRecord(v, i)));
    const claude = async (bp, op, j) => { calls++; return calls <= 2 ? { ok: false, error: 'claude exit 1: overloaded' } : full(bp, op, j); };
    const { job } = await jobs.startJob({ username: 'creator', limit: 9 }, { autostart: false });
    const done = await jobs.runPipeline(job, { run: mockRun(dir), runClaude: claude, runAudit: mockAudit, doctor: okDoctor });
    assert.equal(calls, 4, 'batch 1 tried twice (one retry), then batches 2 and 3 once each');
    assert.equal(done.status, 'needs_review', 'partial → honest needs_review, never complete');
    assert.ok(done.knowledgeCount > 0, 'knowledge from batches 2 and 3 is kept');
    assert.match(done.error, /1\/3 knowledge batch\(es\) failed \(first: batch 1, claude/);
    assert.equal(done.coverage.processed, 5);
    assert.deepEqual(done.batchFailures.map((f) => f.batch), [1]);
  } finally { cleanup(base); }
});

test('REGRESSION — an import rejection is recorded and the next batch still runs; imports use --skip-invalid', async () => {
  const base = env(); const { dir } = seedProject('creator', { videos: 8 }); // 2 batches
  try {
    const jobs = await loadJobs('import-reject-continue');
    let n = 0; const flags = [];
    const run = mockRun(dir, { 'import-knowledge': (opts) => { flags.push(opts.skipInvalid); n++; if (n === 1) return { ok: false, error: 'No valid knowledge records in batch (3 rejected)' };
      return { ok: true, data: { imported: importIntoDb(dir, opts.input), rejected: [{ knowledge_id: 'k-x', reason: 'unknown evidence_id' }] } }; } });
    const { job } = await jobs.startJob({ username: 'creator', limit: 8 }, { autostart: false });
    const done = await jobs.runPipeline(job, { run, runClaude: mockClaudeFull, runAudit: mockAudit, doctor: okDoctor });
    assert.deepEqual(flags, [true, true]);
    assert.equal(done.status, 'needs_review');
    assert.equal(done.coverage.processed, 4);
    assert.equal(done.rejectedRecords, 1, 'skipped invalid records are counted, never silently dropped');
    assert.ok(done.log.some((l) => /1 invalid record\(s\) skipped/.test(l)));
  } finally { cleanup(base); }
});

test('REGRESSION — every batch failing is a clear failure; a Claude login problem stops at once', async () => {
  const base = env(); const { dir } = seedProject('creator', { videos: 8 });
  try {
    const jobs = await loadJobs('all-fail');
    const { job } = await jobs.startJob({ username: 'creator', limit: 8 }, { autostart: false });
    const done = await jobs.runPipeline(job, { run: mockRun(dir), runClaude: async () => ({ ok: false, error: 'claude timed out after 25 min' }), runAudit: mockAudit, doctor: okDoctor });
    assert.equal(done.status, 'failed');
    assert.match(done.error, /2\/2 knowledge batch\(es\) failed.*no knowledge was imported/);

    const { dir: dir2 } = seedProject('creator2', { videos: 8 });
    const jobs2 = await loadJobs('login-fail');
    const { job: j2 } = await jobs2.startJob({ username: 'creator2', limit: 8 }, { autostart: false });
    let calls = 0;
    const done2 = await jobs2.runPipeline(j2, { run: mockRun(dir2), runClaude: async () => { calls++; return { ok: false, error: 'Not logged in · Please run /login' }; }, runAudit: mockAudit, doctor: okDoctor });
    assert.equal(calls, 1, 'no point retrying 2 batches that all need the same login');
    assert.equal(done2.status, 'needs_setup');
    assert.match(done2.error, /\/login/);
  } finally { cleanup(base); }
});

// ---- research queue: a busy worker never refuses a request, and never starts it twice ------------
test('queue: busy → waits durably; starts when a slot frees; a repeat request is deduped', async () => {
  const base = env();
  try {
    const jobs = await loadJobs('queue');
    const quiet = { autostart: false };
    const a = await jobs.startJob({ username: 'one', limit: 2 }, quiet);
    await jobs.startJob({ username: 'two', limit: 2 }, quiet); // 2 active = GLOBAL_CONCURRENCY
    const q = await jobs.enqueueResearch({ username: '@three', limit: 5, reason: 'discovery disc-x (audience)', source: 'discovery' }, quiet);
    assert.equal(q.ok, true); assert.equal(q.queued, true); assert.equal(q.position, 1);
    const again = await jobs.enqueueResearch({ username: 'three' }, quiet);
    assert.equal(again.deduped, true, 'already waiting → not added twice');
    assert.deepEqual(jobs.readQueue().map((x) => [x.username, x.limit, x.source]), [['three', 5, 'discovery']]);
    assert.deepEqual(await jobs.drainQueue(quiet), [], 'still busy → nothing starts');
    jobs.cancelJob(a.job.id); // a slot frees
    const started = await jobs.drainQueue(quiet);
    assert.deepEqual(started.map((s) => [s.username, s.ok]), [['three', true]]);
    assert.equal(jobs.readQueue().length, 0);
    assert.equal(jobs.listJobs().find((j) => j.username === 'three').requestedLimit, 5, 'the queued limit is kept');
    assert.equal((await jobs.enqueueResearch({ username: 'bad name!' }, quiet)).code, 400);
    // A job left `queued` by a previous process is recovered, so it cannot hold a slot forever.
    jobs.recoverInterrupted();
    assert.ok(jobs.listJobs().every((j) => j.status !== 'queued'));
  } finally { cleanup(base); }
});

test('an older worker without --skip-invalid falls back to the strict import instead of failing every batch', async () => {
  const base = env(); const { dir } = seedProject('creator', { videos: 3 });
  try {
    const jobs = await loadJobs('old-worker');
    const seen = [];
    const run = mockRun(dir, { 'import-knowledge': (opts) => { seen.push(!!opts.skipInvalid); if (opts.skipInvalid) return { ok: false, error: "Usage: python -m video_software_compiler import-knowledge [OPTIONS]\nTry '--help' for help.\nError: No such option: --skip-invalid" };
      return { ok: true, data: { imported: importIntoDb(dir, opts.input) } }; } });
    const { job } = await jobs.startJob({ username: 'creator', limit: 3 }, { autostart: false });
    const done = await jobs.runPipeline(job, { run, runClaude: mockClaudeFull, runAudit: mockAudit, doctor: okDoctor });
    assert.equal(done.status, 'complete', done.error || '');
    assert.deepEqual(seen, [true, false]);
    assert.ok(done.log.some((l) => /predates --skip-invalid/.test(l)));
  } finally { cleanup(base); }
});
