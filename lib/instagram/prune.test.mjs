// Prune (reversible archive), purge (typed confirmation, frees disk), and the "unresolved" fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = mkdtempSync(join(tmpdir(), 'ig-prune-'));
process.env.SEEN_HOME = base;
const P = await import('./prune.mjs');
const R = await import('./resolutions.mjs');
const { buildInsights } = await import('./insights.mjs');
const { accountRows, knowledgeDiagnosis } = await import('./accounts.mjs');
const { fixtureCorpora, FIXTURE_NOW } = await import('./insights.fixtures.mjs');
test.after(() => rmSync(base, { recursive: true, force: true }));

const ev = (vid, n = 1) => ({ evidence_id: `${vid}-e${n}`, video_id: vid, source_url: null, timestamp_start: 0, timestamp_end: 2, evidence_type: 'spoken', content: 'x' });
// A motion-design account whose knowledge is editing-software trivia (prune), next to the fixtures.
function motion() {
  const videos = [1, 2, 3].map((i) => ({ id: `m-v${i}`, url: null, publishedAt: '2026-10-01T00:00:00Z', caption: 'After Effects tutorial', likes: null, comments: null }));
  const knowledge = [
    { knowledge_id: 'k-m1', type: 'rule', title: 'Ease your keyframes in the graph editor', description: 'Smoother motion', attribution: 'creator_explicit', status: 'confirmed', record: {}, evidence: [ev('m-v1')] },
    { knowledge_id: 'k-m2', type: 'tool', title: 'Use null objects to rig layers', description: 'Parent layers to a null', attribution: 'creator_explicit', status: 'confirmed', record: {}, evidence: [ev('m-v2')] },
  ];
  return { project: 'instagram-motion', handle: '@motion', videos, evidence: videos.map((v) => ev(v.id)), knowledge };
}

test('prune plan → archive (reversible) → restore; archived data leaves every view', () => {
  const corpora = [...fixtureCorpora(), motion()];
  const lib = buildInsights(corpora, { now: FIXTURE_NOW });
  const plan = P.planPrune(lib, { bytesFor: (p) => (p === 'instagram-motion' ? 5e9 : 1) });
  assert.deepEqual(plan.accounts.map((a) => a.project), ['instagram-motion']);
  assert.match(plan.accounts[0].why, /0 of 2 knowledge records/);
  assert.equal(plan.counts.bytes, 5e9);
  // charlie's cooking tip is an off-purpose ROW on a kept account; motion's rows go with its account.
  assert.deepEqual(plan.rows.map((r) => r.knowledge_id), ['k-c1']);
  assert.equal(plan.rows[0].family, 'an unrelated niche');

  const r = P.applyPrune(plan);
  assert.deepEqual(r.archived, { accounts: 1, rows: 1 });
  const after = P.applyArchive(corpora);
  assert.ok(!after.some((c) => c.project === 'instagram-motion'), 'archived account is gone from the corpora');
  assert.ok(!after.find((c) => c.project === 'instagram-charlie').knowledge.some((k) => k.knowledge_id === 'k-c1'), 'archived row is gone');
  const sum = P.archiveSummary();
  assert.equal(sum.archived.accounts[0].project, 'instagram-motion');
  assert.equal(sum.archived.rows, 1);

  assert.deepEqual(P.restore({ project: 'instagram-motion' }).restored, { accounts: 1, rows: 0 });
  assert.ok(P.applyArchive(corpora).some((c) => c.project === 'instagram-motion'));
  assert.deepEqual(P.restore({ all: true }).restored, { accounts: 0, rows: 1 });
  assert.equal(P.restore({}).ok, false, 'restore says what it needs');
});

test('purge: refused without the exact phrase; deletes writable archived folders, keeps read-only ones archived', () => {
  const lib = buildInsights([...fixtureCorpora(), motion(), { ...motion(), project: 'instagram-fixture', handle: '@fixture' }], { now: FIXTURE_NOW });
  P.applyPrune(P.planPrune(lib));
  const deleted = [];
  const del = (project) => (project === 'instagram-fixture' ? { ok: false, error: 'read-only dataset' } : (deleted.push(project), { ok: true, freedBytes: 7e8 }));
  assert.equal(P.purgeArchived({ confirm: 'yes', deleteProject: del }).ok, false);
  assert.deepEqual(deleted, [], 'nothing deleted without the phrase');
  const r = P.purgeArchived({ confirm: P.PURGE_PHRASE, deleteProject: del });
  assert.deepEqual(r.purged.accounts, ['instagram-motion']);
  assert.equal(r.purged.freedBytes, 7e8);
  assert.equal(r.purged.rows, 1);
  assert.deepEqual(r.keptArchived.map((k) => k.project), ['instagram-fixture']);
  assert.ok(P.isArchivedAccount('instagram-motion'), 'a purged account stays hidden (and is no longer restorable)');
  assert.deepEqual(P.restore({ all: true }).restored, { accounts: 1, rows: 0 }, 'only the still-archived read-only one restores');
  const file = JSON.parse(readFileSync(join(base, 'data', 'instagram-archive.json'), 'utf8'));
  assert.ok(file.purged.accounts['instagram-motion'].purgedAt);
});

// ---- "16 unresolved" that never resolves ---------------------------------------------------------
// Root cause: the compiler writes every `ambiguous` record to knowledge/unresolved.jsonl
// (knowledge_io.py _write_canonical_files) and the Library counted that file; no stage ever changes a
// record's status afterwards (reconcile only compares numeric rule thresholds), so the count was permanent.
test('unresolved: corroborated or ≥2 videos → probable; owner decides the rest; open says why', () => {
  const amb = (id, title, videos) => ({ knowledge_id: id, title, description: '', status: 'ambiguous', evidence: videos.map((v) => ({ video_id: v })) });
  const mine = [
    amb('k1', 'Hook viewers within the first two seconds', ['v1']),          // corroborated by another creator
    amb('k2', 'Reply to every comment in the first hour', ['v1', 'v2']),    // two separate videos
    amb('k3', 'Film outside for better retention', ['v3']),                 // still open
    amb('k4', 'Never post on Sundays', ['v4']),                             // owner retires it
    { knowledge_id: 'k5', title: 'Use captions', status: 'confirmed', evidence: [{ video_id: 'v5' }] },
  ];
  const others = [{ knowledge_id: 'o1', title: 'Hook viewers in the first two seconds', description: '', status: 'confirmed', evidence: [] }];
  assert.ok(R.setOverride('instagram-x', 'k4', { status: 'deprecated', note: 'not true for us' }).ok);
  assert.equal(R.setOverride('instagram-x', 'k4', { status: 'maybe' }).ok, false);
  const rep = R.unresolvedReport('instagram-x', mine, others);
  const by = Object.fromEntries(rep.items.map((i) => [i.knowledge_id, i.resolution]));
  assert.equal(by.k1.status, 'probable'); assert.match(by.k1.reason, /corroborated/);
  assert.equal(by.k2.status, 'probable'); assert.match(by.k2.reason, /2 separate videos/);
  assert.equal(by.k3.status, 'ambiguous'); assert.match(by.k3.reason, /one video and no second source/);
  assert.equal(by.k4.status, 'deprecated'); assert.equal(by.k4.how, 'owner');
  assert.deepEqual([rep.total, rep.open, rep.resolved], [4, 1, 3]);

  // The account row shows OPEN vs resolved (not the raw file length) once resolutions are applied.
  const corpus = R.applyResolutions({ project: 'instagram-x', handle: '@x', videos: [], evidence: [], knowledge: mine }, R.resolveAmbiguous(mine, { overrides: R.readOverrides('instagram-x'), others }));
  const [row] = accountRows({ projects: [{ name: 'instagram-x', username: 'x', counts: { evidence: 5, knowledge: 5 }, unresolved: 4 }], corpora: [corpus], jobs: [] });
  assert.deepEqual(row.unresolved, { total: 4, open: 1, resolved: 3 });
  // Back to ambiguous = the owner override is removed.
  assert.equal(R.setOverride('instagram-x', 'k4', { status: 'ambiguous' }).resolution, null);
});

// ---- "43 videos · 1,105 evidence · 0 knowledge" says why ------------------------------------------
test('an account with evidence but 0 knowledge is explained from its job, never left blank', () => {
  const counts = { evidence: 1105, knowledge: 0 };
  assert.match(knowledgeDiagnosis({ counts, job: { status: 'failed', stage: 'knowledge', username: 'creator.b', error: 'claude batch 1 failed: overloaded' } }).text,
    /knowledge stage stopped \(failed\): claude batch 1 failed: overloaded — "resume instagram creator.b" retries it without re-downloading/);
  assert.match(knowledgeDiagnosis({ counts, usableEvidence: 0, job: { status: 'complete', stage: 'cleanup_preview' } }).text, /low-quality screen text/);
  assert.match(knowledgeDiagnosis({ counts, job: { status: 'running', stage: 'knowledge' } }).text, /research is running/);
  assert.match(knowledgeDiagnosis({ counts, job: null }).text, /no research job on record/);
  assert.equal(knowledgeDiagnosis({ counts: { evidence: 10, knowledge: 3 } }), null);
  const [row] = accountRows({ projects: [{ name: 'instagram-creator.b', username: 'creator.b', counts }], corpora: [], jobs: [{ id: 'j', project: 'instagram-creator.b', username: 'creator.b', status: 'needs_review', stage: 'knowledge', error: '9/11 knowledge batch(es) failed' }] });
  assert.equal(row.knowledgeNote.code, 'knowledge_failed');
  assert.equal(row.job.status, 'needs_review');
});
