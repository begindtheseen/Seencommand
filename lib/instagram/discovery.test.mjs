// Creator discovery — fake browser (no OpenCLI, no Chrome, no network). Every candidate in these
// fixtures is invented; the point is the rules: parse, rank, explain, never contact, stop on CAPTCHA.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = mkdtempSync(join(tmpdir(), 'ig-disc-'));
process.env.SEEN_HOME = base;
const D = await import('./discovery.mjs');
test.after(() => rmSync(base, { recursive: true, force: true }));

const R = (handle, title, snippet) => ({ url: `https://www.instagram.com/${handle}/`, title, snippet });
const PAGE1 = [
  R('coach.jane', 'Jane | Career Coach (@coach.jane) • Instagram photos and videos', '48.2K Followers, 310 Following - Job search tips, resume reviews, and why recruiters ghost you. New reels weekly.'),
  R('demo.hr', 'Demo HR (@demo.hr) • Instagram', '210K Followers - Former recruiter breaking down hiring data and staffing agency red flags. Weekly news commentary.'),
  R('pasta.daily', 'Pasta Daily (@pasta.daily) • Instagram', '1M Followers - recipes and cooking every day'),
  { url: 'https://www.instagram.com/reel/AbC123/', title: 'Got ghosted after 5 rounds (@layoff.diaries) on Instagram: "day 40 of my job search"', snippet: 'laid off in March, applied to 300 jobs' },
  R('indeed', 'Indeed (@indeed) • Instagram', '900K Followers - jobs'),
  { url: 'https://example.com/blog', title: 'not instagram', snippet: '' },
];

const fakeBrowser = (pages, log = []) => {
  let i = 0;
  return { open: async (u) => { log.push(['open', u]); }, eval: async () => JSON.stringify(pages[Math.min(i++, pages.length - 1)]), close: async () => { log.push(['close']); } };
};
const okProbe = async () => ({ status: 'ok', detail: 'connected' });

test('parsing: handle from profile / reel URLs and titles; followers only when Google printed them', () => {
  assert.equal(D.handleFromResult(PAGE1[0]), 'coach.jane');
  assert.equal(D.handleFromResult(PAGE1[3]), 'layoff.diaries', 'a reel URL has no handle — the title (@x) gives it');
  assert.equal(D.handleFromResult(PAGE1[5]), null);
  assert.equal(D.followersFrom('48.2K Followers, 310 Following'), 48200);
  assert.equal(D.followersFrom('1,204 followers'), 1204);
  assert.equal(D.followersFrom('2M Followers'), 2000000);
  assert.equal(D.followersFrom('no counts here'), null);
  assert.ok(D.discoveryQueries('career coaches for laid off tech workers').every((q) => q.startsWith('site:instagram.com ')));
});

test('ranking: two explained lists, each audience pick matched to a real Seen asset; brands, off-niche and researched handles excluded', async () => {
  const log = [];
  const r = await D.runDiscovery({ goal: 'career coaches whose audience gets ghosted', maxQueries: 2, gapMs: 0 },
    { probe: okProbe, browser: fakeBrowser([{ blocked: false, results: PAGE1 }, { blocked: false, results: [PAGE1[1]] }], log), exclude: new Set(['coach.jane']), sleep: async () => {} });
  assert.ok(r.ok);
  const d = r.discovery;
  assert.equal(d.status, 'done');
  const handles = [...d.learn, ...d.audience].map((c) => c.handle);
  assert.ok(!handles.includes('coach.jane'), 'already researched → excluded');
  assert.ok(!handles.includes('indeed'), 'platform accounts are not creators');
  assert.ok(!d.audience.some((c) => c.handle === 'pasta.daily'), 'no job-seeker signal → never an audience pick');
  const hr = d.audience.find((c) => c.handle === 'demo.hr');
  assert.ok(hr, 'the ex-recruiter data account is an audience fit');
  assert.equal(hr.followers, 210000);
  assert.match(hr.reasons.join(' | '), /talks to job seekers/);
  assert.match(hr.reasons.join(' | '), /appeared in 2 different searches/);
  assert.match(hr.reasons.join(' | '), /210,000 followers \(as shown by Google\)/);
  assert.ok(hr.angle && /^https:\/\/seenjobs\.io\//.test(hr.angle.url), 'matched to a real Seen page');
  assert.ok(['ghost_report', 'agency_index', 'employer_grades'].includes(hr.angle.key));
  assert.ok(d.audience.some((c) => c.handle === 'layoff.diaries'));
  assert.deepEqual(log.filter((x) => x[0] === 'open').map((x) => new URL(x[1]).hostname), ['www.google.com', 'www.google.com'], 'only Google result pages are opened — never instagram.com');
  assert.deepEqual(log.at(-1), ['close']);
});

test('a CAPTCHA stops the search at once and is never solved', async () => {
  const log = [];
  const r = await D.runDiscovery({ goal: 'recruiters', maxQueries: 4, gapMs: 0 }, { probe: okProbe, browser: fakeBrowser([{ blocked: true, url: 'https://www.google.com/sorry/index' }], log), sleep: async () => {} });
  assert.equal(r.discovery.status, 'stopped');
  assert.equal(r.discovery.stoppedBy, 'google_blocked');
  assert.equal(log.filter((x) => x[0] === 'open').length, 1, 'no further searches after the CAPTCHA');
});

test('without OpenCLI it degrades honestly: mentions from researched creators + the queries to run by hand', async () => {
  const corpora = [{ project: 'instagram-a', handle: '@a', videos: [{ id: 'v1', caption: 'collab with @ghosted.again — staffing agency story' }],
    evidence: [{ video_id: 'v1', evidence_type: 'ocr', content: 'follow @ghosted.again for job search tips' }], knowledge: [] }];
  const r = await D.runDiscovery({ goal: 'job seekers', gapMs: 0 }, { probe: async () => ({ status: 'missing', detail: 'OpenCLI is not installed', fix: 'Install OpenCLI' }), corpora });
  const d = r.discovery;
  assert.equal(d.stoppedBy, 'opencli_unavailable');
  assert.match(d.steps[0].detail, /OpenCLI is not installed — Install OpenCLI/);
  const g = [...d.learn, ...d.audience].find((c) => c.handle === 'ghosted.again');
  assert.ok(g, 'found offline through mentions');
  assert.match(g.reasons.join(' '), /mentioned by researched creator @a \(2×\)/);
  assert.ok(d.queries.length >= 3, 'the queries are kept so they can be run by hand');
});

test('queue research for chosen handles only — through the queue, never contacting anyone', async () => {
  const r = await D.runDiscovery({ goal: 'ghosting', maxQueries: 1, gapMs: 0 }, { probe: okProbe, browser: fakeBrowser([{ blocked: false, results: PAGE1 }]), sleep: async () => {} });
  const calls = [];
  const enqueue = async (x) => { calls.push(x); return { ok: true, queued: true, position: calls.length }; };
  const q = await D.queueFromDiscovery(r.discovery.id, ['@demo.hr', 'someone.else'], { enqueue });
  assert.equal(q.ok, true);
  assert.deepEqual(calls.map((c) => c.username), ['demo.hr']);
  assert.match(calls[0].reason, new RegExp(`^discovery ${r.discovery.id} \\((learn|audience)\\): `));
  assert.equal(q.results.find((x) => x.handle === 'someone.else').ok, false);
  assert.equal(D.getDiscovery(r.discovery.id).queued.length, 2, 'every request is recorded on the discovery');
  assert.equal((await D.queueFromDiscovery(r.discovery.id, [], { enqueue })).ok, false);
  assert.equal(D.getDiscovery('../../etc'), null, 'ids are validated');
});
