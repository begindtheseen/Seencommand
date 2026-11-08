// Shared fixtures for the creator-insight tests: three synthetic creators in the exact shape
// library.creatorCorpus() returns. No real creator, video, or URL — every value is invented for tests.

const NOW = Date.parse('2026-10-21T19:00:00Z');
export const FIXTURE_NOW = NOW;
const day = (n) => new Date(NOW - n * 86400000).toISOString();

function vid(project, i, { daysAgo, likes, caption = '', parent = null }) {
  return { id: `${project}-v${i}`, url: `https://example.invalid/${project}/p/${i}`, publishedAt: day(daysAgo), caption, mediaType: 'video', parent, likes, comments: likes == null ? null : Math.round(likes / 20) };
}
function ev(project, i, n, type, start, end, content) {
  return { evidence_id: `${project}-e${i}-${n}`, video_id: `${project}-v${i}`, source_url: `https://example.invalid/${project}/p/${i}`, timestamp_start: start, timestamp_end: end, evidence_type: type, content, confidence: 0.9 };
}

// alpha: 8 posts, 4 open with a pain-first question; those 4 have ~2x likes.
function alpha() {
  const p = 'alpha';
  const videos = [], evidence = [];
  for (let i = 1; i <= 8; i++) {
    const hooky = i <= 4;
    videos.push(vid(p, i, { daysAgo: i * 3, likes: hooky ? 2000 + i : 1000 + i, caption: hooky ? 'Comment GHOST below and I will send the template' : 'Part ' + i + ' of my interview series' }));
    evidence.push(ev(p, i, 1, 'spoken', 0.0, 2.1, hooky ? 'Why are you still getting ghosted after every interview?' : 'Today we talk about interviews.'));
    evidence.push(ev(p, i, 2, 'spoken', 2.2, 9.0, hooky ? 'I applied to 300 jobs and heard nothing back, radio silence.' : 'Here is how to prepare your answers step by step.'));
  }
  const knowledge = [
    { knowledge_id: 'k-a1', type: 'principle', title: 'Hook viewers in the first two seconds', description: 'Lead with the problem before any intro.', attribution: 'creator_explicit', status: 'confirmed', confidence: 0.9, record: {},
      evidence: [{ ...ev(p, 1, 1, 'spoken', 0.0, 2.1, 'Why are you still getting ghosted after every interview?') }, { ...ev(p, 2, 1, 'spoken', 0.0, 2.1, 'Why are you still getting ghosted?') }] },
    { knowledge_id: 'k-a2', type: 'claim', title: 'My template gets you hired in 7 days', description: 'Promotional result claim.', attribution: 'creator_explicit', status: 'confirmed', confidence: 0.95, record: {},
      evidence: [ev(p, 3, 2, 'spoken', 2.2, 9.0, 'template'), ev(p, 4, 2, 'spoken', 2.2, 9.0, 'template'), ev(p, 5, 2, 'spoken', 2.2, 9.0, 'template')] },
    { knowledge_id: 'k-a3', type: 'rule', title: 'Hook viewers within the first seconds', description: 'Retracted.', attribution: 'creator_explicit', status: 'contradicted', confidence: 0.9, record: {},
      evidence: [ev(p, 6, 1, 'spoken', 0, 2, 'x'), ev(p, 7, 1, 'spoken', 0, 2, 'x'), ev(p, 8, 1, 'spoken', 0, 2, 'x')] },
  ];
  return { project: 'instagram-alpha', handle: '@alpha', videos, evidence, knowledge };
}

// bravo: 5 posts; 3 pain-first question hooks; also teaches the same hook rule in different words.
// Two carousel children of ONE post (parent 'BRAVO5') must count once.
function bravo() {
  const p = 'bravo';
  const videos = [], evidence = [];
  for (let i = 1; i <= 4; i++) {
    videos.push(vid(p, i, { daysAgo: 2 + i * 4, likes: 500 }));
    evidence.push(ev(p, i, 1, 'spoken', 0.2, 1.8, i <= 3 ? 'Did a recruiter ghost you again?' : 'Let me tell you a true story.'));
  }
  videos.push(vid(p, 5, { daysAgo: 30, likes: 400, parent: 'BRAVO5' }));
  videos.push(vid(p, 6, { daysAgo: 30, likes: 400, parent: 'BRAVO5' }));
  evidence.push(ev(p, 5, 1, 'spoken', 0.1, 1.5, 'Why does nobody reply to applications?'));
  evidence.push(ev(p, 6, 1, 'spoken', 0.1, 1.5, 'Why does nobody reply to applications?'));
  const knowledge = [
    { knowledge_id: 'k-b1', type: 'rule', title: 'Hook in the first two seconds', description: 'Open on the problem, not an intro.', attribution: 'creator_explicit', status: 'probable', confidence: 0.4, record: {},
      evidence: [ev(p, 1, 1, 'spoken', 0.2, 1.8, 'Did a recruiter ghost you again?')] },
    { knowledge_id: 'k-b2', type: 'principle', title: 'Seen should add a feature', description: 'not from the creator', attribution: 'independent_improvement', status: 'confirmed', confidence: 1, record: {},
      evidence: [ev(p, 2, 1, 'spoken', 0.2, 1.8, 'x')] },
  ];
  return { project: 'instagram-bravo', handle: '@bravo', videos, evidence, knowledge };
}

// charlie: 4 posts; 2 pain-first question hooks; off-purpose knowledge (cooking) is dropped.
function charlie() {
  const p = 'charlie';
  const videos = [], evidence = [];
  for (let i = 1; i <= 4; i++) {
    videos.push(vid(p, i, { daysAgo: 10 + i * 7, likes: null }));
    evidence.push(ev(p, i, 1, 'spoken', 0.0, 2.5, i <= 2 ? 'Are staffing agencies ghosting you?' : 'Three things I learned this week.'));
  }
  const knowledge = [
    { knowledge_id: 'k-c1', type: 'principle', title: 'Salt pasta water generously', description: 'A cooking tip.', attribution: 'creator_explicit', status: 'confirmed', confidence: 0.9, record: {},
      evidence: [ev(p, 1, 1, 'spoken', 0, 2, 'salt')] },
  ];
  return { project: 'instagram-charlie', handle: '@charlie', videos, evidence, knowledge };
}

export function fixtureCorpora() { return [alpha(), bravo(), charlie()]; }

// Write one fixture corpus as a real compiler project (project.json + state.sqlite) under `root`.
export async function writeFixtureProject(root, c, { unresolved = [] } = {}) {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const dir = join(root, c.project);
  mkdirSync(join(dir, 'knowledge'), { recursive: true });
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ name: c.project, username: c.handle.slice(1), source: 'instagram', created_at: '2026-10-01T00:00:00Z' }));
  writeFileSync(join(dir, 'knowledge', 'unresolved.jsonl'), unresolved.map((k) => JSON.stringify(k)).join('\n') + (unresolved.length ? '\n' : ''));
  const db = new DatabaseSync(join(dir, 'state.sqlite'));
  db.exec(`CREATE TABLE sources(source_id TEXT PRIMARY KEY, provider TEXT, external_id TEXT, source_url TEXT, media_type TEXT, caption TEXT DEFAULT '', published_at TEXT, retrieved_at TEXT, metadata_json TEXT DEFAULT '{}', content_hash TEXT, local_path TEXT, availability TEXT, in_scope INTEGER DEFAULT 1);
    CREATE TABLE evidence(evidence_id TEXT PRIMARY KEY, video_id TEXT, source_url TEXT, published_at TEXT, timestamp_start REAL, timestamp_end REAL, evidence_type TEXT, content TEXT, confidence REAL);
    CREATE TABLE knowledge(knowledge_id TEXT PRIMARY KEY, type TEXT, title TEXT, description TEXT, attribution TEXT, status TEXT, confidence REAL, record_json TEXT);
    CREATE TABLE knowledge_evidence(knowledge_id TEXT, evidence_id TEXT, PRIMARY KEY(knowledge_id, evidence_id));
    CREATE TABLE rules(rule_id TEXT); CREATE TABLE requirements(requirement_id TEXT); CREATE TABLE stage_runs(stage TEXT, status TEXT);`);
  const sv = db.prepare('INSERT INTO sources(source_id,provider,external_id,source_url,media_type,caption,published_at,retrieved_at,metadata_json,in_scope) VALUES(?,?,?,?,?,?,?,?,?,1)');
  for (const v of c.videos) sv.run(v.id, 'instaloader', v.id, v.url, 'video', v.caption, v.publishedAt, '2026-10-21T00:00:00Z', JSON.stringify({ likes: v.likes, comments: v.comments, ...(v.parent ? { parent_shortcode: v.parent } : {}) }));
  const se = db.prepare('INSERT OR IGNORE INTO evidence VALUES(?,?,?,?,?,?,?,?,?)');
  for (const e of [...c.evidence, ...c.knowledge.flatMap((k) => k.evidence)]) se.run(e.evidence_id, e.video_id, e.source_url, null, e.timestamp_start, e.timestamp_end, e.evidence_type, e.content, 0.9);
  const sk = db.prepare('INSERT INTO knowledge VALUES(?,?,?,?,?,?,?,?)'); const sl = db.prepare('INSERT OR IGNORE INTO knowledge_evidence VALUES(?,?)');
  for (const k of c.knowledge) { sk.run(k.knowledge_id, k.type, k.title, k.description, k.attribution, k.status, k.confidence ?? 0.8, '{}'); for (const e of k.evidence) sl.run(k.knowledge_id, e.evidence_id); }
  db.close();
  return dir;
}

// A motion-design account: videos about editing software, knowledge that is all software trivia, plus
// one ambiguous record — the shape the relevance gate must prune.
export function motionCorpus() {
  const p = 'motion';
  const videos = [1, 2, 3].map((i) => ({ id: `${p}-v${i}`, url: `https://example.invalid/${p}/p/${i}`, publishedAt: new Date(NOW - i * 5 * 86400000).toISOString(), caption: 'After Effects tutorial', mediaType: 'video', parent: null, likes: 100, comments: 5 }));
  const ev = (i) => ({ evidence_id: `${p}-e${i}`, video_id: `${p}-v${i}`, source_url: `https://example.invalid/${p}/p/${i}`, timestamp_start: 0, timestamp_end: 2, evidence_type: 'spoken', content: 'open the graph editor and ease the keyframes' });
  const knowledge = [
    { knowledge_id: 'k-m1', type: 'rule', title: 'Ease your keyframes in the graph editor', description: 'Smoother motion', attribution: 'creator_explicit', status: 'confirmed', record: {}, evidence: [ev(1)] },
    { knowledge_id: 'k-m2', type: 'tool', title: 'Use null objects to rig layers', description: 'Parent layers to a null', attribution: 'creator_explicit', status: 'ambiguous', record: {}, evidence: [ev(2)] },
  ];
  return { project: 'instagram-motion', handle: '@motion', videos, evidence: videos.map((_, i) => ev(i + 1)), knowledge };
}
