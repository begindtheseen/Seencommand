// Run: node --test lib/growth/calendar.test.mjs
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setGrowthDir } from './store.mjs';
import { buildPlan, savePlan } from './plan.mjs';
import { generateCalendar, regenerateCalendar, checkRules, getCalendar, setStatus, recordResults, findItem, calendarWeek, STATUSES } from './calendar.mjs';
import { todayItem, markDaily, streak, pickItem, laneFor, weeklyReview, CATALOG } from './daily.mjs';
import { ptInstant, addDays, mondayOf } from './pt.mjs';

let plan;
beforeEach(() => { setGrowthDir(mkdtempSync(join(tmpdir(), 'growth-cal-'))); plan = savePlan(buildPlan({ start: '2026-10-19', baselineUsers: 10 })); });
const DATA = { agencies: [{ name: 'Acme Staffing', line: 'Acme Staffing: 60% ghost rate across 20 applicant reports', sourceLine: 'seenjobs.io · 20 applicant reports, trust-weighted · moderate confidence · as of 2026-10-21 PT', url: 'https://seenjobs.io/agencies', reports: 20, ghostPct: 60, responsePct: 40, confidence: 'Moderate confidence' }], mostResponsive: [], mostGhosting: [] };

test('generates 4–6 weeks of dated Pacific items; times stay 9 AM PT across the November DST change', () => {
  const items = generateCalendar({ plan, from: '2026-10-21', weeks: 6, data: DATA });
  const days = [...new Set(items.map((i) => i.date))].sort();
  assert.equal(days[0] >= '2026-10-19', true); assert.ok(days[days.length - 1] <= '2026-11-29');
  assert.equal(generateCalendar({ plan, from: '2026-10-21', weeks: 2 }).reduce((s, i) => Math.max(s, i.week), 0), 4, 'clamped to at least 4 weeks');
  const before = items.find((i) => i.date === '2026-10-27' && i.time === '09:00'); const after = items.find((i) => i.date === '2026-11-03' && i.time === '09:00');
  assert.equal(before.at, ptInstant('2026-10-27', '09:00')); assert.equal(before.at, '2026-10-27T16:00:00.000Z');
  assert.equal(after.at, '2026-11-03T17:00:00.000Z');
  for (const i of items) { assert.ok(STATUSES.includes(i.status)); assert.ok(i.channel && i.format && i.pillar && i.hook && i.goal && i.ruleInfo?.name, i.id); assert.ok(['brandon', 'app'].includes(i.owner)); }
  // the Ghost Report starts in week 3 (playbook); weeks 1–2 are value-first + hand-recruiting
  assert.ok(!items.some((i) => i.week < 3 && i.format === 'reddit-post')); assert.ok(items.some((i) => i.week >= 3 && i.format === 'reddit-post'));
  assert.ok(items.some((i) => i.week < 3 && i.channel === 'dm'));
  // a data-backed angle carries its evidence; nothing claims a number without one
  assert.ok(items.some((i) => i.evidence && i.evidence.reports === 20));
});

test('platform rules: a generated calendar is clean; two link posts to one subreddit in a week is not', () => {
  const items = generateCalendar({ plan, from: '2026-10-21', weeks: 6, data: DATA });
  assert.deepEqual(checkRules(items), []);
  const r = items.filter((i) => i.channel === 'reddit' && i.link)[0];
  const extra = { ...r, id: 'dup', date: addDays(r.date, 1), at: ptInstant(addDays(r.date, 1), '09:00') };
  assert.ok(checkRules([...items, extra]).some((v) => /link posts to r\/recruitinghell/.test(v.problem)));
  const cross = { ...r, id: 'x2', subreddit: 'r/jobs' };
  assert.ok(checkRules([...items, cross]).some((v) => /subreddits on/.test(v.problem)));
  assert.ok(r.platformRules.some((x) => /founder/i.test(x)) && r.subredditNote);
});

test('regenerate keeps what Brandon committed to or posted, and never doubles a slot', () => {
  const first = regenerateCalendar({ plan, from: '2026-10-21', weeks: 6, data: DATA });
  const [a, b, c] = first.items.filter((i) => i.date >= '2026-10-26');
  assert.equal(setStatus(a.id, 'approved').ok, true); assert.equal(setStatus(b.id, 'posted').ok, true);
  assert.equal(recordResults(b.id, { impressions: 1200, sessions: 40, notes: 'good thread' }).ok, true);
  setStatus(c.id, 'drafted');
  const again = regenerateCalendar({ plan, from: '2026-10-21', weeks: 6, data: null });
  assert.equal(again.items.filter((i) => i.id === a.id).length, 1); assert.equal(findItem(a.id).status, 'approved');
  assert.equal(findItem(b.id).status, 'measured'); assert.equal(findItem(b.id).results.sessions, 40); assert.equal(findItem(b.id).hook, b.hook);
  assert.equal(findItem(c.id).status, 'idea', 'a mere draft is regenerated');
  assert.ok(again.kept >= 2); assert.equal(new Set(again.items.map((i) => i.id)).size, again.items.length);
});

test('status walks forward; back only by resetting; measured needs results; results are validated numbers', () => {
  const [it] = regenerateCalendar({ plan, from: '2026-10-21', weeks: 4 }).items;
  assert.equal(setStatus(it.id, 'measured').ok, false);
  assert.equal(setStatus(it.id, 'scheduled').ok, true);
  assert.match(setStatus(it.id, 'drafted').error, /cannot move back/);
  assert.equal(setStatus(it.id, 'idea').ok, true);
  assert.match(recordResults(it.id, { sessions: 3 }).error, /posted first/);
  setStatus(it.id, 'posted');
  assert.match(recordResults(it.id, { sessions: -1 }).error, /≥ 0/); assert.match(recordResults(it.id, {}).error, /at least one/);
  assert.equal(recordResults(it.id, { views: '2500' }).item.results.views, 2500);
  assert.equal(setStatus('nope', 'posted').ok, false); assert.equal(setStatus(it.id, 'viral').ok, false);
});

test('the week view has 7 Pacific days with the 1% lane', () => {
  regenerateCalendar({ plan, from: '2026-10-21', weeks: 4 });
  const w = calendarWeek({ from: '2026-11-01', plan });
  assert.equal(w.weekStart, '2026-10-26'); assert.equal(w.days.length, 7); assert.equal(w.days[6].date, '2026-11-01');
  assert.ok(w.days.every((d) => d.daily && d.daily.lane)); assert.ok(w.days.some((d) => d.items.length));
  assert.equal(getCalendar().items.length > 20, true);
});

test('1% a day: one item per day, stable within the day, sized for weekends, steered by the plan', () => {
  const mon = '2026-10-26';
  assert.equal(laneFor(mon), 'data'); assert.equal(laneFor('2026-10-27'), 'content'); assert.equal(laneFor('2026-10-27', { behind: true }), 'distribution');
  const a = todayItem({ day: mon }); const b = todayItem({ day: mon }); assert.equal(a.id, b.id); assert.equal(a.lane, 'data');
  assert.ok(a.rule.name && a.laneRule.name && a.minutes > 0);
  const sat = pickItem('2026-10-31', {}); assert.ok(sat.minutes <= 20, 'weekend items are small');
  assert.equal(pickItem('2026-10-29', { activationUnmeasured: true }).id, 'activation-metric');
  const days = { '2026-10-22': { itemId: 'activation-metric', status: 'done' } };
  assert.notEqual(pickItem('2026-10-29', { days, activationUnmeasured: true }).id, 'activation-metric');
  // no repeat within 14 days while the lane has another item
  const d2 = { '2026-10-20': { itemId: pickItem('2026-10-27', {}).id, status: 'done' } };
  assert.notEqual(pickItem('2026-10-27', { days: d2 }).id, d2['2026-10-20'].itemId);
  assert.ok(CATALOG.every((c) => c.title && c.detail && c.moves && ['app', 'brandon', 'agent'].includes(c.who)));
});

test('streaks: consecutive done days, alive until the day ends, broken by a skip; best is kept', () => {
  const D = (list) => Object.fromEntries(list.map(([d, s]) => [d, { itemId: 'dm-5', status: s }]));
  assert.deepEqual(streak(D([['2026-10-19', 'done'], ['2026-10-20', 'done'], ['2026-10-21', 'done']]), '2026-10-21').current, 3);
  const open = streak(D([['2026-10-19', 'done'], ['2026-10-20', 'done'], ['2026-10-21', 'open']]), '2026-10-21');
  assert.equal(open.current, 2); assert.equal(open.alive, true);
  const skipped = streak(D([['2026-10-19', 'done'], ['2026-10-20', 'done'], ['2026-10-21', 'skipped']]), '2026-10-21');
  assert.equal(skipped.current, 2); assert.equal(skipped.alive, false);
  assert.equal(streak(D([['2026-10-19', 'done'], ['2026-10-21', 'done']]), '2026-10-22').current, 1);
  const best = streak(D([['2026-10-01', 'done'], ['2026-10-02', 'done'], ['2026-10-03', 'done'], ['2026-10-04', 'done'], ['2026-10-21', 'done']]), '2026-10-21');
  assert.equal(best.current, 1); assert.equal(best.best, 4);
  // a streak across the DST change counts calendar days
  assert.equal(streak(D([['2026-10-31', 'done'], ['2026-11-01', 'done'], ['2026-11-02', 'done']]), '2026-11-02').current, 3);
  assert.equal(streak({}, '2026-10-21').alive, false);
  const m = markDaily('2026-10-21', 'done', { note: 'sent 5 DMs' }); assert.equal(m.ok, true); assert.equal(m.streak.current, 1); assert.equal(m.item.note, 'sent 5 DMs');
  assert.equal(markDaily('2026-10-21', 'meh').ok, false);
});

test('weekly review: what was done by lane, and how the real snapshots moved (or that they are unknown)', () => {
  const days = { '2026-10-26': { itemId: 'held-queue', lane: 'data', title: 'Clear 10 held reports', status: 'done' }, '2026-10-27': { itemId: 'clip-script', lane: 'content', title: 'One clip', status: 'done' }, '2026-10-28': { itemId: 'compare-pair', lane: 'seo', title: 'x', status: 'skipped' } };
  const r = weeklyReview({ weekStart: '2026-10-26', days, snapshots: [{ users: 40, dau: 5, reportsTotal: 300, shares: 1, paid: 0 }, { users: 52, dau: 7, reportsTotal: 318, shares: 1, paid: 0 }] });
  assert.equal(r.done, 2); assert.deepEqual(r.byLane.data, ['Clear 10 held reports']); assert.equal(r.metrics.users, 12); assert.match(r.lines[1], /users \+12/);
  assert.match(weeklyReview({ weekStart: '2026-10-26', days, snapshots: [null, null] }).lines[1], /unknown/);
  assert.match(weeklyReview({ weekStart: mondayOf('2026-12-01'), days: {} }).lines[0], /No 1% items/);
});
