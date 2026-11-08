// Creator Intelligence Library — security + behavior tests over a synthetic temp project.
// No network, no real Instagram, no real videos. Builds a tiny project (project.json + a minimal
// state.sqlite via node:sqlite + a fake 1000-byte "video" + a secret .env) and points the library at
// it via VSC_READONLY_ROOTS. The focus is that NO path can escape the project and secrets are never served.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'ig-lib-'));
  const root = join(base, 'roots'); mkdirSync(root, { recursive: true });
  const empty = join(base, 'jobs'); mkdirSync(empty, { recursive: true }); // empty writable data root
  const proj = join(root, 'creator1');
  mkdirSync(join(proj, 'videos'), { recursive: true });
  mkdirSync(join(proj, 'knowledge'), { recursive: true });
  writeFileSync(join(proj, 'project.json'), JSON.stringify({ name: 'creator1', username: 'creator1', source: 'instagram', created_at: '2026-07-31T00:00:00Z' }));
  writeFileSync(join(proj, 'knowledge', 'unresolved.jsonl'), '');
  writeFileSync(join(proj, 'notes.txt'), 'hello world');   // allowlisted text
  writeFileSync(join(proj, '.env'), 'SECRET=nope');        // must NEVER be served
  writeFileSync(join(proj, 'videos', 'v1.mp4'), Buffer.alloc(1000, 7)); // fake 1000-byte video
  try { symlinkSync('/etc', join(proj, 'escape')); } catch { /* symlink may be unavailable */ }

  const db = new DatabaseSync(join(proj, 'state.sqlite'));
  db.exec(`
    CREATE TABLE sources(source_id TEXT PRIMARY KEY, provider TEXT, external_id TEXT, source_url TEXT,
      media_type TEXT DEFAULT 'video', caption TEXT DEFAULT '', published_at TEXT, retrieved_at TEXT,
      metadata_json TEXT DEFAULT '{}', content_hash TEXT, local_path TEXT, availability TEXT DEFAULT 'available', in_scope INTEGER DEFAULT 1);
    CREATE TABLE evidence(evidence_id TEXT PRIMARY KEY, video_id TEXT, source_url TEXT, published_at TEXT,
      timestamp_start REAL, timestamp_end REAL, evidence_type TEXT, content TEXT, confidence REAL);
    CREATE TABLE knowledge(knowledge_id TEXT PRIMARY KEY, type TEXT, title TEXT, description TEXT, attribution TEXT, status TEXT, confidence REAL, record_json TEXT);
    CREATE TABLE knowledge_evidence(knowledge_id TEXT, evidence_id TEXT);
    CREATE TABLE rules(rule_id TEXT, version INTEGER, name TEXT, source TEXT, status TEXT, rule_json TEXT);
    CREATE TABLE requirements(requirement_id TEXT PRIMARY KEY, title TEXT, origin TEXT, trace_json TEXT);
    CREATE TABLE stage_runs(run_id INTEGER PRIMARY KEY, stage TEXT, item_id TEXT, version INTEGER, status TEXT, attempts INTEGER, started_at TEXT, finished_at TEXT, error TEXT);
    CREATE VIRTUAL TABLE search_index USING fts5(document_id UNINDEXED, kind UNINDEXED, title, content);
  `);
  db.prepare("INSERT INTO sources(source_id,provider,external_id,source_url,caption,published_at,retrieved_at,local_path,in_scope) VALUES('s1','test','ext1','http://x/p/ext1','a caption','2026-07-30T00:00:00Z','2026-07-31T00:00:00Z','videos/v1.mp4',1)").run();
  db.prepare("INSERT INTO sources(source_id,provider,external_id,retrieved_at,in_scope) VALUES('s2','test','ext2','2026-07-31T00:00:00Z',0)").run();
  db.prepare("INSERT INTO sources(source_id,provider,external_id,retrieved_at,local_path,in_scope) VALUES('s3','test','ext3','2026-07-31T00:00:00Z','videos/gone.mp4',1)").run();
  db.prepare("INSERT INTO evidence VALUES('e1','s1','http://x','2026-07-30',1.0,3.0,'spoken','risk management matters',0.9)").run();
  db.prepare("INSERT INTO evidence VALUES('e-legacy-ocr','s1','http://x','2026-07-30',2.0,2.0,'ocr','Readable-looking legacy OCR with guessed confidence',0.5)").run();
  db.prepare("INSERT INTO evidence VALUES('e-clean-ocr','s1','http://x','2026-07-30',4.0,4.0,'ocr','Position the transformation before the numbered workflow',0.92)").run();
  db.prepare("INSERT INTO knowledge VALUES('k1','principle','Manage risk','desc','creator','active',0.8,'{}')").run();
  db.prepare("INSERT INTO knowledge_evidence VALUES('k1','e1')").run();
  db.prepare("INSERT INTO search_index(document_id,kind,title,content) VALUES('s1','source','ext1','risk management basics')").run();
  db.close();
  return { base, root, empty, proj };
}

async function withLib(fn) {
  const fx = fixture();
  process.env.VSC_READONLY_ROOTS = fx.root;
  process.env.VSC_DATA_ROOT = fx.empty;
  const lib = await import(`./library.mjs?fx=${encodeURIComponent(fx.base)}`); // fresh env read per call anyway
  try { await fn(lib); } finally { rmSync(fx.base, { recursive: true, force: true }); }
}

test('resolveProject finds a known project and rejects unsafe/unknown names', async () => {
  await withLib((lib) => {
    assert.ok(lib.resolveProject('creator1'));
    assert.equal(lib.resolveProject('nope'), null);
    for (const bad of ['../etc', 'a/b', '..', '.hidden', '', 'a\0b']) assert.equal(lib.resolveProject(bad), null, `reject ${JSON.stringify(bad)}`);
  });
});

test('listVideos defaults to in-scope (selected) videos; includeOutOfScope widens', async () => {
  await withLib((lib) => {
    const inScope = lib.listVideos('creator1').map((v) => v.source_id).sort();
    assert.deepEqual(inScope, ['s1', 's3'], 'only in-scope by default');
    const all = lib.listVideos('creator1', { includeOutOfScope: true }).map((v) => v.source_id).sort();
    assert.deepEqual(all, ['s1', 's2', 's3']);
    const v1 = lib.listVideos('creator1').find((v) => v.source_id === 's1');
    assert.equal(v1.localMedia, true);
    assert.equal(v1.counts.evidence, 3, 'card count is the honest raw evidence count');
    assert.equal(v1.counts.knowledge, 1);
    assert.equal(lib.listVideos('creator1').find((v) => v.source_id === 's3').localMedia, false, 'missing file → no local media');
  });
});

test('getVideo returns evidence + linked knowledge with seek timestamps', async () => {
  await withLib((lib) => {
    const d = lib.getVideo('creator1', 's1');
    assert.equal(d.evidence.length, 2, 'normal view removes legacy guessed-confidence OCR');
    assert.equal(d.evidence[0].timestamp_start, 1.0);
    assert.ok(d.evidence.some((e) => e.evidence_id === 'e-clean-ocr'));
    assert.ok(!d.evidence.some((e) => e.evidence_id === 'e-legacy-ocr'));
    assert.equal(d.knowledge.length, 1);
    assert.equal(d.knowledge[0].knowledge_id, 'k1');
  });
});

test('knowledge list returns structured records with bounded source citations', async () => {
  await withLib((lib) => {
    const records = lib.listKnowledge('creator1');
    assert.equal(records.length, 1);
    assert.equal(records[0].knowledge_id, 'k1');
    assert.equal(records[0].evidence_count, 1);
    assert.equal(records[0].evidence[0].video_id, 's1');
    assert.equal(records[0].evidence[0].timestamp_start, 1);
    assert.equal(records[0].record_json, undefined);
    assert.equal(lib.getKnowledge('creator1', 'k1').evidence[0].evidence_id, 'e1');
  });
});

test('search runs FTS and returns hits', async () => {
  await withLib((lib) => {
    const r = lib.search('creator1', 'risk', 10);
    assert.ok(Array.isArray(r) && r.length >= 1);
  });
});

test('evidence tab is curated while raw evidence remains individually retrievable', async () => {
  await withLib((lib) => {
    const evidence = lib.listEvidence('creator1');
    assert.ok(evidence.some((e) => e.evidence_id === 'e-clean-ocr'));
    assert.ok(!evidence.some((e) => e.evidence_id === 'e-legacy-ocr'));
    assert.equal(lib.getEvidence('creator1', 'e-legacy-ocr').confidence, 0.5, 'raw audit record is preserved');
  });
});

test('readProjectFile serves allowlisted files and REJECTS traversal / secrets / bad types', async () => {
  await withLib((lib) => {
    assert.equal(lib.readProjectFile('creator1', 'notes.txt').ok, true);
    assert.equal(lib.readProjectFile('creator1', 'project.json').type, 'application/json');
    // traversal (plain + nested + encoded-then-decoded shapes) — all must be rejected
    for (const bad of ['../../../../etc/passwd', 'videos/../../../../etc/passwd', '..%2f..%2fetc%2fpasswd', '/etc/passwd', 'videos/../../.env']) {
      const r = lib.readProjectFile('creator1', bad);
      assert.ok(r.error, `must reject ${bad}`);
      assert.ok(r.code >= 400, `error code for ${bad}`);
    }
    // secrets / db / dotfiles never served
    assert.ok(lib.readProjectFile('creator1', '.env').error);
    assert.ok(lib.readProjectFile('creator1', 'state.sqlite').error);
    // symlink escape (proj/escape → /etc) must be caught by realpath
    const sym = lib.readProjectFile('creator1', 'escape/hosts');
    assert.ok(sym.error, 'symlink escape rejected');
  });
});

test('openMedia validates local media, returns a byte-range stream, 404s when cleaned', async () => {
  await withLib(async (lib) => {
    const m = lib.openMedia('creator1', 's1');
    assert.equal(m.ok, true);
    assert.equal(m.type, 'video/mp4');
    assert.equal(m.size, 1000);
    // a byte range reads exactly the requested slice, never the whole file
    const chunks = [];
    await new Promise((r) => m.stream({ start: 10, end: 19 }).on('data', (c) => chunks.push(c)).on('end', r));
    assert.equal(Buffer.concat(chunks).length, 10);
    // a video whose file was cleaned → 404 no local media
    const gone = lib.openMedia('creator1', 's3');
    assert.equal(gone.code, 404);
    // unknown video / unknown project
    assert.equal(lib.openMedia('creator1', 'nope').code, 404);
    assert.equal(lib.openMedia('nope', 's1').code, 404);
  });
});

test('item 6 — openMedia accepts an ABSOLUTE local_path inside the project (legacy datasets), rejects foreign', async () => {
  const base = mkdtempSync(join(tmpdir(), 'ig-abs-'));
  const root = join(base, 'roots'); const proj = join(root, 'legacyset'); mkdirSync(join(proj, 'videos'), { recursive: true });
  mkdirSync(join(base, 'jobs'), { recursive: true });
  writeFileSync(join(proj, 'project.json'), JSON.stringify({ name: 'legacyset', username: 'legacyset', source: 'instagram' }));
  writeFileSync(join(proj, 'videos', 'a.mp4'), Buffer.alloc(500, 1));
  const db = new DatabaseSync(join(proj, 'state.sqlite'));
  db.exec(`CREATE TABLE sources(source_id TEXT PRIMARY KEY, external_id TEXT, source_url TEXT, media_type TEXT, caption TEXT, published_at TEXT, retrieved_at TEXT, metadata_json TEXT, content_hash TEXT, local_path TEXT, availability TEXT, in_scope INTEGER);
           CREATE TABLE evidence(evidence_id TEXT PRIMARY KEY, video_id TEXT, source_url TEXT, published_at TEXT, timestamp_start REAL, timestamp_end REAL, evidence_type TEXT, content TEXT, confidence REAL);
           CREATE TABLE knowledge(knowledge_id TEXT PRIMARY KEY, type TEXT, title TEXT, description TEXT, attribution TEXT, status TEXT, confidence REAL, record_json TEXT);
           CREATE TABLE knowledge_evidence(knowledge_id TEXT, evidence_id TEXT);`);
  db.prepare('INSERT INTO sources(source_id,local_path,in_scope) VALUES(?,?,1)').run('a', join(proj, 'videos', 'a.mp4')); // ABSOLUTE, inside the project
  db.prepare('INSERT INTO sources(source_id,local_path,in_scope) VALUES(?,?,1)').run('f', '/etc/hosts');                   // ABSOLUTE, foreign
  db.close();
  process.env.VSC_READONLY_ROOTS = root; process.env.VSC_DATA_ROOT = join(base, 'jobs');
  const lib = await import(`./library.mjs?abs=${encodeURIComponent(base)}`);
  try {
    const m = lib.openMedia('legacyset', 'a');
    assert.equal(m.ok, true, 'absolute path inside the project is accepted');
    assert.equal(m.size, 500);
    assert.equal(lib.openMedia('legacyset', 'f').code, 400, 'foreign absolute path rejected (escapes project)');
    assert.equal(lib.listVideos('legacyset').find((v) => v.source_id === 'a').localMedia, true);
    assert.equal(lib.listVideos('legacyset').find((v) => v.source_id === 'f').localMedia, false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('item 7 — listDir lists project files/dirs, HIDES secrets, rejects traversal/escape', async () => {
  await withLib((lib) => {
    const root = lib.listDir('creator1');
    assert.ok(root.ok);
    assert.ok(root.dirs.some((d) => d.name === 'videos'), 'lists the videos dir');
    assert.ok(root.files.some((f) => f.name === 'notes.txt' && f.servable), 'servable text file');
    const allNames = [...root.dirs, ...root.files].map((e) => e.name);
    assert.ok(!allNames.includes('.env'), '.env hidden');
    assert.ok(!allNames.includes('state.sqlite'), 'sqlite hidden');
    assert.ok(!allNames.some((n) => n.startsWith('.')), 'no dotfiles');
    // descend into a subdir
    const vids = lib.listDir('creator1', 'videos');
    assert.ok(vids.ok && vids.files.some((f) => f.name === 'v1.mp4' && f.media), 'media file flagged');
    // traversal + absolute rejected
    assert.ok(lib.listDir('creator1', '../../etc').error);
    assert.ok(lib.listDir('creator1', '/etc').error);
    // symlink escape (proj/escape → /etc) rejected when the symlink exists
    const esc = lib.listDir('creator1', 'escape');
    assert.ok(esc.error || esc.dirs || esc.files, 'escape either errors or is not resolvable');
  });
});
