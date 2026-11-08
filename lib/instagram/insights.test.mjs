// Creator insight engine — ranking, de-dup, honest strength, and the board-meeting / chat blocks.
// Pure fixtures (insights.fixtures.mjs) plus one real-SQLite pass through library.creatorCorpus().
// No network, no model, no real creator data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildInsights, strengthOf, engagementLift, recencyWeight, creatorEvidenceBlock, creatorContextFrom, insightLine,
  tokens, similarity, STRENGTHS, INSIGHT_TYPES, libraryInsights, creatorKeyPoints, keyPointsText, lastMeetingLine,
} from './insights.mjs';
import { fixtureCorpora, FIXTURE_NOW } from './insights.fixtures.mjs';

const build = (corpora = fixtureCorpora(), opts = {}) => buildInsights(corpora, { now: FIXTURE_NOW, ...opts });
const find = (lib, pred) => lib.insights.find(pred);

test('strength is a pure function of independent support (posts + creators), never model confidence', () => {
  assert.equal(strengthOf({ videos: 1, creators: 1 }), 'anecdotal');
  assert.equal(strengthOf({ videos: 2, creators: 1 }), 'anecdotal');
  assert.equal(strengthOf({ videos: 3, creators: 1 }), 'emerging', 'one creator repeating it is a habit, not a finding');
  assert.equal(strengthOf({ videos: 30, creators: 1 }), 'emerging', 'volume from ONE creator never reaches moderate');
  assert.equal(strengthOf({ videos: 2, creators: 2 }), 'emerging');
  assert.equal(strengthOf({ videos: 3, creators: 2 }), 'moderate');
  assert.equal(strengthOf({ videos: 5, creators: 3 }), 'moderate', 'strong needs ≥6 posts');
  assert.equal(strengthOf({ videos: 6, creators: 3 }), 'strong');

  // Rewriting every knowledge/evidence confidence to ~0 changes nothing about strength or order.
  const low = fixtureCorpora().map((c) => ({ ...c, evidence: c.evidence.map((e) => ({ ...e, confidence: 0.51 })),
    knowledge: c.knowledge.map((k) => ({ ...k, confidence: 0.01 })) }));
  const a = build(); const b = build(low);
  assert.deepEqual(a.insights.map((i) => [i.id, i.strength]), b.insights.map((i) => [i.id, i.strength]));
});

test('every insight is typed, labelled, cited and dated in California time', () => {
  const lib = build();
  assert.ok(lib.insights.length > 0);
  for (const i of lib.insights) {
    assert.ok(INSIGHT_TYPES.includes(i.type), i.type);
    assert.ok(['observed', 'taught'].includes(i.basis));
    assert.ok(STRENGTHS.includes(i.strength));
    assert.ok(i.support.videos >= 1 && i.support.creators >= 1);
    assert.ok(i.citations.length >= 1 && i.citations.length <= 3, `${i.claim} has citations`);
    for (const c of i.citations) assert.match(c.handle, /^@/);
    if (i.recency.last) assert.match(i.recency.lastPT, /^\d{4}-\d{2}-\d{2}$/);
  }
  // A timestamped hook citation renders m:ss.
  const hook = find(lib, (i) => i.type === 'hook' && i.basis === 'observed');
  assert.match(hook.citations[0].at, /^0:0\d/);
  // PT date, not UTC: 2026-10-18T19:00Z is still Oct 18 in California; 2026-10-19T03:00Z would be Oct 18 too.
  const pt = buildInsights([{ project: 'p', handle: '@p', videos: [{ id: 'v', publishedAt: '2026-10-19T03:00:00Z', likes: null }],
    evidence: [{ evidence_id: 'e', video_id: 'v', timestamp_start: 0, timestamp_end: 1, evidence_type: 'spoken', content: 'Why are you getting ghosted?' }], knowledge: [] }], { now: FIXTURE_NOW });
  assert.equal(pt.insights[0].recency.lastPT, '2026-10-18');
});

test('ranking: strength first, then score; aggregation is ACROSS creators', () => {
  const lib = build();
  const order = lib.insights.map((i) => STRENGTHS.indexOf(i.strength));
  for (let k = 1; k < order.length; k++) assert.ok(order[k - 1] >= order[k], 'sorted by strength descending');
  const top = lib.insights[0];
  assert.equal(top.strength, 'strong');
  const qHook = find(lib, (i) => i.type === 'hook' && /question/i.test(i.claim));
  assert.equal(qHook.support.creators, 3, 'the question hook is counted across all three creators');
  assert.equal(qHook.strength, 'strong');
  assert.deepEqual(qHook.support.handles.sort(), ['@alpha', '@bravo', '@charlie']);
});

test('recency: the same support ranks lower when it is old', () => {
  const now = FIXTURE_NOW;
  assert.ok(recencyWeight(new Date(now - 10 * 86400000).toISOString(), now) > recencyWeight(new Date(now - 400 * 86400000).toISOString(), now));
  assert.equal(recencyWeight(new Date(now - 5000 * 86400000).toISOString(), now), 0.25, 'floored, never zero');
  const age = (corpora, days) => corpora.map((c) => ({ ...c, videos: c.videos.map((v) => ({ ...v, publishedAt: new Date(Date.parse(v.publishedAt) - days * 86400000).toISOString() })) }));
  const fresh = find(build(), (i) => /question/i.test(i.claim));
  const stale = find(build(age(fixtureCorpora(), 365)), (i) => /question/i.test(i.claim));
  assert.ok(fresh.score > stale.score);
  assert.equal(fresh.strength, stale.strength, 'age changes rank, never the evidence strength');
});

test('de-dup: carousel children count once; same claim merges across creators; overlapping patterns fold', () => {
  const lib = build();
  assert.equal(lib.totals.posts, 17, '8 + 5 + 4 posts (bravo\'s two carousel videos are ONE post)');
  // Taught: alpha k-a1 "Hook viewers in the first two seconds" + bravo k-b1 "Hook in the first two seconds" → one insight.
  const taught = lib.insights.filter((i) => i.basis === 'taught' && i.type === 'hook');
  assert.equal(taught.length, 1);
  assert.equal(taught[0].merged, 2);
  assert.deepEqual(taught[0].knowledgeIds.sort(), ['k-a1', 'k-b1']);
  assert.equal(taught[0].support.creators, 2);
  // Observed: question + pain-first hooks cover mostly the same posts → one hook line, overlap noted.
  const observedHooks = lib.insights.filter((i) => i.basis === 'observed' && i.type === 'hook' && i.support.creators === 3);
  assert.equal(observedHooks.length, 1);
  assert.ok(observedHooks[0].overlaps.some((o) => /pain/i.test(o.claim)));
  assert.match(insightLine(observedHooks[0]), /usually combined with "Open on the viewer's job-search pain"/);
  // A topic that is the same posts as an audience pain folds into the pain.
  assert.equal(find(lib, (i) => i.claim === 'Topic: Employer ghosting'), undefined);
  assert.ok(find(lib, (i) => /Audience pain: Being ghosted/.test(i.claim)));
  // Token similarity sanity.
  assert.ok(similarity(tokens('Hook viewers in the first two seconds'), tokens('Hook in the first 2 seconds')) >= 0.55);
  assert.ok(similarity(tokens('Post daily for consistency'), tokens('Consistency beats virality')) < 0.55);
});

test('excluded from insights: contradicted, Seen-made, promotional claims, uncited and off-purpose knowledge', () => {
  const lib = build();
  const ids = lib.insights.flatMap((i) => i.knowledgeIds || []);
  assert.ok(!ids.includes('k-a3'), 'contradicted');
  assert.ok(!ids.includes('k-b2'), 'independent_improvement is Seen\'s idea, not the creator\'s');
  assert.ok(!ids.includes('k-a2'), 'a creator\'s own result claim proves nothing');
  assert.ok(!ids.includes('k-c1'), 'cooking advice is off-purpose for Seen');
  const uncited = buildInsights([{ ...fixtureCorpora()[0], knowledge: [{ knowledge_id: 'k-x', type: 'rule', title: 'Hook fast', description: '', attribution: 'creator_explicit', status: 'confirmed', evidence: [] }] }], { now: FIXTURE_NOW });
  assert.ok(!uncited.insights.some((i) => (i.knowledgeIds || []).includes('k-x')));
});

test('engagement lift: per-creator median, enough data or nothing', () => {
  const posts = (likes) => likes.map((l, i) => ({ key: `k${i}`, likes: l, comments: null }));
  const byCreator = new Map([['@a', posts([100, 100, 100, 100, 300, 300])]]);
  const lift = engagementLift(new Set(['k4', 'k5', 'k3']), byCreator);
  assert.ok(lift && lift.ratio > 1 && lift.n === 3 && lift.creators === 1 && lift.metric === 'likes');
  assert.equal(engagementLift(new Set(['k4']), byCreator), null, 'one post inside → nothing to say');
  assert.equal(engagementLift(new Set(['k0', 'k1']), new Map([['@a', posts([1, 2, 3, 4, 5])]])), null, '<6 counted posts → nothing');
  assert.equal(engagementLift(new Set(['k0', 'k1', 'k2']), new Map([['@a', posts([null, null, null, null, null, null])]])), null, 'no counts → nothing');
  // Charlie has no likes: no insight that only Charlie supports may claim an engagement number.
  const lib = build();
  for (const i of lib.insights) if (i.support.handles.length === 1 && i.support.handles[0] === '@charlie') assert.equal(i.engagement, null);
});

test('meeting block: present + bounded + only strength ≥ moderate for growth; absent when it should be', () => {
  const lib = build();
  const g = creatorEvidenceBlock(lib, 'growth');
  assert.ok(g.text.startsWith('CREATOR EVIDENCE'), g.text);
  assert.ok(g.text.length <= 1500, `bounded (${g.text.length})`);
  assert.match(g.text, /\d+ creators? \/ \d+ videos?/);
  assert.ok(g.used.length >= 2);
  for (const i of g.used) assert.ok(['moderate', 'strong'].includes(i.strength), `${i.claim} is ${i.strength}`);
  assert.doesNotMatch(g.text, /anecdotal|emerging/);
  // At most two per type, so one type cannot crowd the block.
  const perType = {}; for (const i of g.used) perType[i.type] = (perType[i.type] || 0) + 1;
  for (const n of Object.values(perType)) assert.ok(n <= 2);
  // Tight budget still yields a valid (smaller) block, never an overflow.
  const tight = creatorEvidenceBlock(lib, 'growth', { maxChars: 600 });
  assert.ok(tight.text.length <= 600 && tight.used.length >= 1);

  assert.deepEqual(creatorEvidenceBlock(lib, 'reliability'), { text: '', used: [] }, 'a dept with no use for it gets nothing');
  assert.deepEqual(creatorEvidenceBlock(null, 'growth'), { text: '', used: [] });
  assert.deepEqual(creatorEvidenceBlock(buildInsights([]), 'growth'), { text: '', used: [] }, 'empty library → absent');
  const solo = buildInsights([fixtureCorpora()[0]], { now: FIXTURE_NOW }); // one creator → nothing reaches moderate
  assert.equal(solo.insights.some((i) => i.type !== 'cadence' && ['moderate', 'strong'].includes(i.strength)), false);
  assert.ok(!/\[(hook|format|topic|audience pain|tactic|job-seeker advice) ·/.test(creatorEvidenceBlock(solo, 'growth').text));
});

test('chat context: answers content questions with citations, stays silent otherwise', () => {
  const lib = build();
  const ctx = creatorContextFrom(lib, 'what hooks work for job-seeker content?');
  assert.match(ctx, /^CREATOR LIBRARY EVIDENCE/);
  assert.match(ctx, /\[hook · observed · strong\]/);
  assert.match(ctx, /@alpha 0:00–0:02 https:\/\/example\.invalid\/alpha\/p\/1/);
  assert.ok(ctx.length <= 2400);
  assert.doesNotMatch(ctx, /anecdotal/);
  assert.equal(creatorContextFrom(lib, 'what is our MRR?'), '', 'unrelated questions pay nothing');
  assert.equal(creatorContextFrom(buildInsights([]), 'what hooks work?'), '', 'empty library → nothing');
});

// ---- the real path: SQLite project → library.creatorCorpus → libraryInsights ------------------------

function writeProject(root, c) {
  const dir = join(root, c.project);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ name: c.project, username: c.handle.slice(1), source: 'instagram', created_at: '2026-10-01T00:00:00Z' }));
  return import('node:sqlite').then(({ DatabaseSync }) => {
    const db = new DatabaseSync(join(dir, 'state.sqlite'));
    db.exec(`CREATE TABLE sources(source_id TEXT PRIMARY KEY, provider TEXT, external_id TEXT, source_url TEXT, media_type TEXT, caption TEXT DEFAULT '', published_at TEXT, retrieved_at TEXT, metadata_json TEXT DEFAULT '{}', content_hash TEXT, local_path TEXT, availability TEXT, in_scope INTEGER DEFAULT 1);
      CREATE TABLE evidence(evidence_id TEXT PRIMARY KEY, video_id TEXT, source_url TEXT, published_at TEXT, timestamp_start REAL, timestamp_end REAL, evidence_type TEXT, content TEXT, confidence REAL);
      CREATE TABLE knowledge(knowledge_id TEXT PRIMARY KEY, type TEXT, title TEXT, description TEXT, attribution TEXT, status TEXT, confidence REAL, record_json TEXT);
      CREATE TABLE knowledge_evidence(knowledge_id TEXT, evidence_id TEXT, PRIMARY KEY(knowledge_id, evidence_id));`);
    const sv = db.prepare('INSERT INTO sources(source_id,provider,external_id,source_url,media_type,caption,published_at,retrieved_at,metadata_json,in_scope) VALUES(?,?,?,?,?,?,?,?,?,1)');
    for (const v of c.videos) sv.run(v.id, 'instaloader', v.id, v.url, 'video', v.caption, v.publishedAt, '2026-10-21T00:00:00Z', JSON.stringify({ likes: v.likes, comments: v.comments, ...(v.parent ? { parent_shortcode: v.parent } : {}) }));
    db.prepare("INSERT INTO sources(source_id,provider,external_id,retrieved_at,in_scope) VALUES('out-of-scope','instaloader','oos','2026-10-21',0)").run();
    const se = db.prepare('INSERT OR IGNORE INTO evidence VALUES(?,?,?,?,?,?,?,?,?)');
    for (const e of [...c.evidence, ...c.knowledge.flatMap((k) => k.evidence)]) se.run(e.evidence_id, e.video_id, e.source_url, null, e.timestamp_start, e.timestamp_end, e.evidence_type, e.content, 0.9);
    const sk = db.prepare('INSERT INTO knowledge VALUES(?,?,?,?,?,?,?,?)'); const sl = db.prepare('INSERT OR IGNORE INTO knowledge_evidence VALUES(?,?)');
    for (const k of c.knowledge) { sk.run(k.knowledge_id, k.type, k.title, k.description, k.attribution, k.status, k.confidence, '{}'); for (const e of k.evidence) sl.run(k.knowledge_id, e.evidence_id); }
    db.close();
  });
}

test('real SQLite: creatorCorpus + libraryInsights reproduce the fixture result across projects', async () => {
  const base = mkdtempSync(join(tmpdir(), 'ig-insights-'));
  const root = join(base, 'roots'); mkdirSync(root, { recursive: true });
  mkdirSync(join(base, 'jobs'), { recursive: true });
  process.env.SEEN_HOME = base; process.env.VSC_READONLY_ROOTS = root; process.env.VSC_DATA_ROOT = join(base, 'jobs');
  try {
    for (const c of fixtureCorpora()) await writeProject(root, c);
    const lib = await import('./library.mjs');
    assert.deepEqual(lib.projectNames(), ['instagram-alpha', 'instagram-bravo', 'instagram-charlie']);
    const corpus = lib.creatorCorpus('instagram-bravo');
    assert.equal(corpus.handle, '@bravo');
    assert.equal(corpus.videos.length, 6, 'in-scope rows only');
    assert.equal(corpus.videos.filter((v) => v.parent === 'BRAVO5').length, 2, 'carousel parent read from metadata_json');
    assert.equal(lib.creatorCorpus('nope'), null);

    const live = await libraryInsights({ now: FIXTURE_NOW, lib });
    const expected = build();
    assert.deepEqual(live.insights.map((i) => [i.id, i.strength, i.support.videos]), expected.insights.map((i) => [i.id, i.strength, i.support.videos]));
    const one = await libraryInsights({ now: FIXTURE_NOW, lib, project: 'instagram-alpha' });
    assert.deepEqual(one.creators.map((c) => c.handle), ['@alpha']);

    // The HTTP route the Creator Library tab reads, and the chat digest, use the same engine.
    const { handleInstagram, handleInstagramChat } = await import('./routes.mjs');
    const res = { statusCode: 0, body: null, writeHead(c) { this.statusCode = c; }, end(s) { this.body = s ? JSON.parse(s) : null; } };
    await handleInstagram({ method: 'GET', url: '/api/instagram/insights', on() {} }, res, '');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.totals.creators, 3);
    assert.ok(res.body.insights.length > 0 && res.body.insights[0].citations.length > 0);
    assert.equal(res.body.lastMeeting, null, 'no board meeting has run in this temp home');
    const r404 = { ...res, statusCode: 0, body: null };
    await handleInstagram({ method: 'GET', url: '/api/instagram/insights?project=ghost', on() {} }, r404, '');
    assert.equal(r404.statusCode, 404);
    const digest = await handleInstagramChat('key points for @alpha');
    assert.match(digest.reply, /What @alpha's videos show/);
    // One creator's key points come from the CROSS-creator result: a point other creators back says so
    // and may rate higher; a point only @alpha makes says "only this creator so far" and stays ≤ emerging.
    assert.match(digest.reply, /· (strong|moderate)\] .*also @bravo/);
    for (const line of digest.reply.split('\n').filter((l) => /only this creator so far/.test(l))) assert.doesNotMatch(line, /· strong\]|· moderate\]/, line);
    assert.match(digest.reply, /KEEP — /, 'the account verdict and its reason are in the digest');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

// ---- "No key points distilled yet" for accounts with hundreds of knowledge rows -----------------
// Root cause (main, lib/instagram/synthesis.mjs): key points came from ONE model call capped at 900
// tokens with fallback '' (:182); a missing lane or a truncated JSON reply produced [] and that EMPTY
// result was written to disk under the knowledge hash (:190), so the tab stayed empty until the knowledge
// itself changed. Its "validated" filter (:27) also never matched the compiler's statuses. Key points are
// now counted from the knowledge itself — no model, nothing to cache empty.
test('REGRESSION — key points exist for an account with hundreds of knowledge rows, with no model at all', () => {
  const vids = Array.from({ length: 40 }, (_, i) => ({ id: `big-v${i}`, url: `https://example.invalid/big/${i}`, publishedAt: new Date(FIXTURE_NOW - i * 86400000).toISOString(), caption: 'job search tips', likes: null, comments: null }));
  const ev = (i, n) => ({ evidence_id: `big-e${i}-${n}`, video_id: `big-v${i}`, source_url: `https://example.invalid/big/${i}`, timestamp_start: n * 3, timestamp_end: n * 3 + 2, evidence_type: 'spoken', content: 'If you got ghosted after the interview, follow up once.' });
  const topics = ['Follow up once after an interview ghosting', 'Put salary range questions early with recruiters', 'Hook with the rejection email on screen', 'Post every weekday to build an audience'];
  const knowledge = Array.from({ length: 300 }, (_, i) => ({ knowledge_id: `k-big-${i}`, type: 'rule', title: `${topics[i % 4]} (${i})`, description: 'creator advice', attribution: 'creator_explicit', status: 'confirmed', record: {}, evidence: [ev(i % 40, 1), ev((i + 7) % 40, 1)] }));
  const corpus = { project: 'instagram-big', handle: '@big', videos: vids, evidence: vids.map((_, i) => ev(i, 1)), knowledge };
  const kp = creatorKeyPoints(buildInsights([corpus], { now: FIXTURE_NOW }), 'instagram-big');
  assert.ok(kp.keyPoints.length >= 4, `got ${kp.keyPoints.length}`);
  assert.ok(kp.keyPoints.some((i) => i.basis === 'taught' && i.merged > 1), 'repeated advice is merged, not listed 300 times');
  for (const i of kp.keyPoints) assert.ok(i.own, `${i.claim} cites @big's own video`);
  assert.match(keyPointsText(kp), /^@big: 40 videos · 300 knowledge records · KEEP/);

  // All off-purpose: no points, and the reply SAYS so with the reason families instead of "nothing yet".
  const off = { ...corpus, project: 'instagram-off', handle: '@off', videos: vids.map((v) => ({ ...v, caption: 'motion design' })), evidence: [],
    knowledge: knowledge.slice(0, 20).map((k, i) => ({ ...k, knowledge_id: `k-off-${i}`, title: `Ease keyframes in the graph editor (${i})`, description: 'After Effects' })) };
  const kp2 = creatorKeyPoints(buildInsights([off], { now: FIXTURE_NOW }), 'instagram-off');
  assert.equal(kp2.keyPoints.length, 0);
  assert.equal(kp2.pruned.total, 20);
  assert.match(keyPointsText(kp2), /Dropped as off-purpose: 20 record\(s\) \(20 editing-software \/ gear trivia\)/);
  assert.match(keyPointsText(kp2), /PRUNE — /);
});

test('chat context names what the last board meeting used, so the chat can say so', () => {
  const lib = build();
  const used = lib.insights.filter((i) => i.strength === 'strong').slice(0, 1);
  const lastMeeting = { runId: 'run-7', at: '2026-10-21T16:00:00Z', byDept: { growth: used.map((i) => ({ id: i.id, claim: i.claim, strength: i.strength, support: { creators: i.support.creators, videos: i.support.videos } })) },
    cited: [{ dept: 'growth', title: 'Ship a ghosting hook reel', insightIds: [used[0].id] }] };
  const ctx = creatorContextFrom(lib, 'what hooks work?', { lastMeeting });
  assert.match(ctx, /LAST BOARD MEETING \(Oct 21, 9:00 AM PT, run run-7\) used these Creator Library lines — growth: "/);
  assert.match(ctx, /1 proposal\(s\) cited one: "Ship a ghosting hook reel" \(growth\)/);
  assert.equal(lastMeetingLine(null), '');
});
