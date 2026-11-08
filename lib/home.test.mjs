import test from 'node:test';
import assert from 'node:assert/strict';
import { homeSnapshot, seenSection, needsYouItems, changesList, boardSection } from './home.mjs';
import { formatPT, ptDate } from './time-pt.mjs';

test('California time, DST-correct', () => {
  assert.equal(ptDate(new Date('2026-10-21T06:30:00Z')), '2026-10-20');
  assert.equal(formatPT('2026-10-21T13:04:00Z', { now: new Date('2026-10-21T14:00:00Z') }), 'Oct 21, 6:04 AM');
  assert.equal(formatPT('2026-12-01T20:00:00Z', { now: new Date('2026-12-02T00:00:00Z') }), 'Dec 1, 12:00 PM');
  assert.equal(formatPT('nope'), '');
});

const RAW = { jobs: { added_today: 1200, active: 45000, total: 50000, stale_clearable: 2000 }, job_health: { active: 45000 },
  reports: { today: 12, this_week: 90, total: 3000 }, held_reports: { pending: 3 }, companies: { with_scores: 900 }, users: { total: 500, new_today: 1 },
  monetization: { mrr: 0, active_paid: 0 }, errors: { today: 2 }, storage: { db_bytes: 452 * 1048576, max_mb: 470, enabled: true, blocking: false }, data_quality: { degraded: false } };

test('seen section reads the admin snapshot without inventing numbers', () => {
  const s = seenSection(RAW, 'x');
  assert.equal(s.jobs.addedToday, 1200);
  assert.equal(s.storage.mb, 452);
  assert.equal(seenSection({}, 'x').jobs.addedToday, null, 'missing is null, never 0');
});

test('needs-you: pending approvals, storage near the guard, held reports, failed runs in the last day', () => {
  const now = Date.now();
  const items = needsYouItems({ state: { approvals: [{ id: 'a', status: 'pending', title: 'Ship X', risk: 'high' }, { id: 'b', status: 'approved', title: 'Done' }] },
    seen: seenSection(RAW, 'x'), runs: { recent: [{ id: 'r', label: 'Indeed', status: 'failed', endedAt: new Date(now - 3600e3).toISOString() }, { id: 'old', label: 'Indeed', status: 'failed', endedAt: new Date(now - 3 * 86400e3).toISOString() }] }, cloud: { runs: [] } });
  assert.deepEqual(items.map((i) => i.kind), ['approval', 'storage', 'held-reports', 'run']);
  assert.equal(items[0].level, 'error');
});

test('changes: newest first, PT stamps, only meaningful activity', () => {
  const c = changesList({ commits: [{ date: '2026-10-21T10:00:00Z', message: 'fix', repo: 'r', url: 'u', short: 'abc' }],
    deployment: { createdAt: '2026-10-21T11:00:00Z', state: 'READY', url: 'seen.vercel.app' },
    activity: [{ at: '2026-10-21T12:00:00Z', kind: 'aggregation', status: 'completed', summary: 'Indeed run completed' }, { at: '2026-10-21T12:01:00Z', kind: 'aggregation', status: 'running', summary: 'started' }, { at: '2026-10-21T12:02:00Z', kind: 'chat', summary: 'noise' }] });
  assert.deepEqual(c.map((x) => x.kind), ['aggregation', 'deploy', 'commit']);
  assert.equal(c[1].url, 'https://seen.vercel.app');
  assert.match(c[0].when, /AM|PM/);
});

test('board section says how old the last meeting is', () => {
  const b = boardSection({ generatedAt: '2026-07-09T03:35:01Z', debrief: { headline: 'h' }, approvals: [{ id: 'a', status: 'pending', title: 't' }] }, new Date('2026-10-21T00:00:00Z'));
  assert.equal(b.stale, true);
  assert.equal(b.pending, 1);
  assert.equal(boardSection(null).ran, false);
});

test('a section that cannot be read says so; the rest still render', async () => {
  const snap = await homeSnapshot({ adminStats: async () => { throw new Error('admin session expired'); },
    aggregation: { status: async () => ({ pipelines: { indeed: { label: 'Indeed', schedule: { enabled: true, nextRunAt: '2026-10-22T13:00:00Z', frequency: 'daily', time: '06:00' } } } }), listRuns: () => [{ id: 'r1', label: 'Indeed', status: 'running', startedAt: '2026-10-21T13:00:00Z' }] },
    commits: async () => [], deployment: async () => null, cloudRuns: async () => ({ ok: true, ready: true, runs: [] }), state: () => null, activity: () => [], tickets: async () => null });
  assert.equal(snap.seen.error, 'admin session expired');
  assert.equal(snap.runs.active.length, 1);
  assert.equal(snap.runs.schedules[0].label, 'Indeed');
  assert.equal(snap.board.ran, false);
});

test('Needs you shows only the tickets that are Brandon’s move (blocked on him, or a PR ready to merge)', async () => {
  const tickets = { active: 5, unclaimed: 3, needsOwner: [
    { id: 'tkt-aaaaaaaaaa', title: 'Fix search ranking', why: 'merge_ready', prUrl: 'https://github.com/begindtheseen/Seen/pull/9', body: 'PR ready to merge — …' },
    { id: 'tkt-bbbbbbbbbb', title: 'Production is behind next-migration', why: 'blocked', body: 'DRIFTED — production at abc' },
  ] };
  const items = needsYouItems({ state: null, seen: null, runs: null, cloud: null, tickets }).filter((x) => x.kind === 'ticket');
  assert.equal(items.length, 2, 'unclaimed AI work never lands on Home');
  assert.match(items[0].title, /^Ready to merge: Fix search ranking/); assert.match(items[0].body, /pull\/9.*Tickets \(tkt-aaaaaaaaaa\)/);
  assert.match(items[1].title, /^Blocked on you: Production is behind/); assert.equal(items[1].level, 'warning');
  const snap = await homeSnapshot({ adminStats: async () => ({}), aggregation: { status: async () => ({}), listRuns: () => [] },
    commits: async () => [], deployment: async () => null, cloudRuns: async () => ({ runs: [] }), state: () => null, activity: () => [], tickets: async () => tickets });
  assert.equal(snap.needsYou.filter((x) => x.kind === 'ticket').length, 2);
  const broken = await homeSnapshot({ adminStats: async () => ({}), aggregation: { status: async () => ({}), listRuns: () => [] },
    commits: async () => [], deployment: async () => null, cloudRuns: async () => ({ runs: [] }), state: () => null, activity: () => [], tickets: async () => { throw new Error('no vault'); } });
  assert.equal(broken.needsYou.filter((x) => x.kind === 'ticket').length, 0, 'a ticket read failure never breaks Home');
});

test('needs-you: proposals from a days-old meeting collapse into one line, never listed as current decisions', () => {
  const state = { generatedAt: '2026-07-09T03:35:01Z', approvals: [{ id: 'a', status: 'pending', title: 'Ship X' }, { id: 'b', status: 'pending', title: 'Ship Y' }, { id: 'c', status: 'approved', title: 'Done' }] };
  const old = needsYouItems({ state, seen: null, runs: null, cloud: null, now: new Date('2026-10-27T23:00:00Z') });
  assert.deepEqual(old.map((i) => i.kind), ['stale-approvals']);
  assert.equal(old[0].count, 2);
  assert.match(old[0].title, /2 proposals from the Jul 8 meeting \(111 days ago\)/);
  const fresh = needsYouItems({ state, seen: null, runs: null, cloud: null, now: new Date('2026-07-09T12:00:00Z') });
  assert.deepEqual(fresh.map((i) => i.kind), ['approval', 'approval']);
});
