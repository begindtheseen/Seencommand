// SeenJobs guidance bridge — provenance + approval-boundary tests over a synthetic temp project.
// No network, no LLM, no real Instagram. Asserts the chain is preserved, a brief stays a DRAFT until
// owner approval, approval never auto-builds, and a brief can never be mislabeled as verified.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'ig-guid-'));
  const root = join(base, 'roots'); mkdirSync(join(root, 'creator', 'knowledge'), { recursive: true });
  process.env.SEEN_HOME = base;                        // guidance briefs persist here
  process.env.VSC_READONLY_ROOTS = root;
  process.env.VSC_DATA_ROOT = join(base, 'jobs');
  const proj = join(root, 'creator');
  writeFileSync(join(proj, 'project.json'), JSON.stringify({ name: 'creator', username: 'creator', source: 'instagram', created_at: '2026-07-31T00:00:00Z' }));
  const db = new DatabaseSync(join(proj, 'state.sqlite'));
  db.exec(`
    CREATE TABLE sources(source_id TEXT PRIMARY KEY, provider TEXT, external_id TEXT, source_url TEXT, media_type TEXT, caption TEXT, published_at TEXT, retrieved_at TEXT, metadata_json TEXT DEFAULT '{}', content_hash TEXT, local_path TEXT, availability TEXT, in_scope INTEGER DEFAULT 1);
    CREATE TABLE evidence(evidence_id TEXT PRIMARY KEY, video_id TEXT, source_url TEXT, published_at TEXT, timestamp_start REAL, timestamp_end REAL, evidence_type TEXT, content TEXT, confidence REAL);
    CREATE TABLE knowledge(knowledge_id TEXT PRIMARY KEY, type TEXT, title TEXT, description TEXT, attribution TEXT, status TEXT, confidence REAL, record_json TEXT);
    CREATE TABLE knowledge_evidence(knowledge_id TEXT, evidence_id TEXT);
    CREATE TABLE rules(rule_id TEXT, version INTEGER, name TEXT, source TEXT, status TEXT, rule_json TEXT);
    CREATE TABLE requirements(requirement_id TEXT PRIMARY KEY, title TEXT, origin TEXT, trace_json TEXT);
    CREATE TABLE stage_runs(run_id INTEGER PRIMARY KEY, stage TEXT, item_id TEXT, version INTEGER, status TEXT, attempts INTEGER, started_at TEXT, finished_at TEXT, error TEXT);
    CREATE VIRTUAL TABLE search_index USING fts5(document_id UNINDEXED, kind UNINDEXED, title, content);
  `);
  db.prepare("INSERT INTO sources(source_id,provider,external_id,source_url,in_scope,retrieved_at) VALUES('s1','test','ext1','http://x/p/ext1',1,'2026-07-31')").run();
  db.prepare("INSERT INTO evidence VALUES('e1','s1','http://x/p/ext1','2026-07-30',2.0,6.0,'spoken','always manage your risk before position size',0.9)").run();
  db.prepare("INSERT INTO knowledge VALUES('k1','principle','Manage risk first','Risk management precedes position sizing','creator','active',0.85,'{}')").run();
  db.prepare("INSERT INTO knowledge VALUES('k2','rule','Post consistently','Consistency compounds trust','creator','active',0.7,'{}')").run();
  db.prepare("INSERT INTO knowledge_evidence VALUES('k1','e1')").run();
  db.close();
  return base;
}
const cleanup = (base) => rmSync(base, { recursive: true, force: true });

test('ask returns bounded, attributed knowledge + exact evidence citations (never a dump)', async () => {
  const base = fixture();
  try {
    const g = await import(`./guidance.mjs?t=${Date.now()}a`);
    const r = await g.ask('creator', 'what does he teach about risk management?');
    assert.equal(r.ok, true);
    assert.ok(r.knowledge.some((k) => k.knowledge_id === 'k1'), 'retrieves the risk principle');
    assert.ok(r.citations.some((c) => c.evidence_id === 'e1' && /risk/.test(c.excerpt)), 'exact evidence citation with excerpt');
    assert.deepEqual(r.attribution, ['@creator']);
    assert.match(r.caveat, /not verified product truth/i);
  } finally { cleanup(base); }
});

test('createBrief persists a DRAFT with the full chain + source_derived labels', async () => {
  const base = fixture();
  try {
    const g = await import(`./guidance.mjs?t=${Date.now()}b`);
    const r = await g.createBrief('creator', { seenObjective: 'improve SeenJobs employer onboarding', question: 'risk management' });
    assert.equal(r.ok, true);
    const b = r.brief;
    assert.equal(b.status, 'draft');
    assert.ok(b.knowledgeIds.includes('k1'));
    assert.ok(b.evidenceIds.includes('e1'), 'brief carries evidence links');
    assert.ok(b.transferableGuidance.every((t) => t.label === 'source_derived'));
    assert.equal(b.downstream.build, null, 'no build attached to a draft');
    assert.match(b.caveat, /not verified product truth/i);
    // round-trips
    assert.equal(g.getBrief('creator', b.briefId).briefId, b.briefId);
    assert.equal(g.listBriefs('creator').length, 1);
  } finally { cleanup(base); }
});

test('approveBrief is the owner boundary: files a REAL proposed task, NEVER auto-builds', async () => {
  const base = fixture();
  try {
    const g = await import(`./guidance.mjs?t=${Date.now()}c`);
    const { brief } = await g.createBrief('creator', { seenObjective: 'improve onboarding', question: 'risk' });
    // Inject a fake filer standing in for the GitHub-issue task pipeline; capture what would be filed.
    let filed = null;
    const fileIssue = async (args) => { filed = args; return { number: 321, url: 'https://github.com/x/y/issues/321' }; };
    const a = await g.approveBrief('creator', brief.briefId, { fileIssue });
    assert.equal(a.ok, true);
    assert.equal(a.brief.status, 'approved');
    assert.equal(a.task.number, 321);
    assert.equal(a.brief.downstream.task.number, 321, 'the real task number is recorded on the brief');
    assert.equal(a.brief.downstream.build, null, 'approval does NOT start a build');
    assert.match(a.note, /NO build started automatically/i);
    // the filed task body carries the full provenance chain the builder needs
    assert.match(filed.body, /k1/, 'knowledge id in task body');
    assert.match(filed.body, /e1/, 'evidence id in task body');
    assert.match(filed.body, /@creator/, 'creator attribution in task body');
    assert.match(filed.body, /not verified product truth/i, 'research caveat in task body');
    assert.ok(filed.labels.includes('creator-guidance') && filed.labels.includes('source_derived'), 'origin labels');
    // cannot re-approve; status can never be a bare "verified"
    assert.equal((await g.approveBrief('creator', brief.briefId, { fileIssue })).ok, false);
    assert.ok(!['verified'].includes(a.brief.status));
  } finally { cleanup(base); }
});

test('approveBrief is HONEST when the task cannot be filed: no approval, no build, clear error', async () => {
  const base = fixture();
  try {
    const g = await import(`./guidance.mjs?t=${Date.now()}d`);
    const { brief } = await g.createBrief('creator', { seenObjective: 'improve onboarding', question: 'risk' });
    const fileIssue = async () => { throw new Error('GitHub is not configured (GITHUB_TOKEN)'); };
    const a = await g.approveBrief('creator', brief.briefId, { fileIssue });
    assert.equal(a.ok, false);
    assert.match(a.error, /could not file the proposed task/i);
    assert.equal(g.getBrief('creator', brief.briefId).status, 'draft', 'stays a draft — never a fake approval');
  } finally { cleanup(base); }
});

test('contradicted knowledge is never offered as guidance — a brief carries it as a CONFLICT instead', async () => {
  const base = fixture();
  try {
    const db = new DatabaseSync(join(base, 'roots', 'creator', 'state.sqlite'));
    db.prepare("INSERT INTO knowledge VALUES('k3','rule','Manage risk later','Retracted by the creator','creator','contradicted',0.99,'{}')").run();
    db.prepare("INSERT INTO knowledge_evidence VALUES('k3','e1')").run();
    db.close();
    const g = await import(`./guidance.mjs?t=${Date.now()}e`);
    const asked = await g.ask('creator', 'risk management');
    assert.ok(asked.knowledge.some((k) => k.knowledge_id === 'k1'));
    assert.ok(!asked.knowledge.some((k) => k.knowledge_id === 'k3'), 'retrieval skips contradicted records even at higher confidence');
    const { brief } = await g.createBrief('creator', { seenObjective: 'x', knowledgeIds: ['k1', 'k3'] });
    assert.deepEqual(brief.knowledgeIds, ['k1']);
    assert.deepEqual(brief.conflicts.map((c) => c.knowledge_id), ['k3']);
    assert.ok(!brief.transferableGuidance.some((t) => t.knowledge_id === 'k3'));
  } finally { cleanup(base); }
});
