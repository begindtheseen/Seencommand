// Run: node --test lib/growth/plan.test.mjs
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setGrowthDir } from './store.mjs';
import { buildPlan, planTargets, checkWeek, gates, actualsFrom, getPlan, savePlan, ensureBaseline, recordActuals, actualsHistory, planWeek, timeBudget, INTERVIEW_PREP_USD } from './plan.mjs';
import { addDays, ptToday, daysBetween, weekdayIndex, mondayOf, ptInstant, dayLabel } from './pt.mjs';

beforeEach(() => setGrowthDir(mkdtempSync(join(tmpdir(), 'growth-plan-'))));
const plan = (o = {}) => buildPlan({ start: '2026-10-19', baselineUsers: 10, now: new Date('2026-10-21T17:00:00Z'), ...o });
// The connector's revenue shape (lib/connectors/adminStats.mjs revenueFrom): one-time sales in the last 30 days.
const summary = (o = {}) => ({ users: { total: o.users ?? 40, newToday: 1, dau: o.dau ?? 5 },
  revenue: { month: o.revenue ?? 0, payingCustomers: o.paid ?? 0, prepPurchases: o.prep ?? o.paid ?? 0, passPurchases: o.pass ?? 0, interviews: o.interviews ?? 20, offerShown: o.shown ?? null, legacy: { mrr: o.legacyMrr ?? null } }, flywheel: { reportsTotal: 300, shares: 2 }, dataQuality: o.degraded ? { degraded: true } : { degraded: false },
  raw: { users: { new_this_week: 6 }, monetization: { active_paid: 0, mrr: o.legacyMrr ?? 0, pro_users: 1, trialing: 0 }, reports: { this_week: 12 }, applications: { total: 30 }, companies: { with_scores: 900 } } });

test('PT calendar: day math is calendar math, across both DST changes', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01'); // DST ends 2026-11-01
  assert.equal(addDays('2026-11-01', 1), '2026-11-02');
  assert.equal(daysBetween('2026-10-26', '2026-11-02'), 7);
  assert.equal(daysBetween('2026-03-02', '2026-03-09'), 7); // DST starts 2026-03-08
  assert.equal(mondayOf('2026-11-01'), '2026-10-26'); assert.equal(weekdayIndex('2026-10-26'), 0); assert.equal(weekdayIndex('2026-11-01'), 6);
  // 9:00 AM Pacific is 16:00Z under PDT and 17:00Z under PST — both sides of each change.
  assert.equal(ptInstant('2026-10-30', '09:00'), '2026-10-30T16:00:00.000Z');
  assert.equal(ptInstant('2026-11-02', '09:00'), '2026-11-02T17:00:00.000Z');
  assert.equal(ptInstant('2026-11-01', '09:00'), '2026-11-01T17:00:00.000Z'); // the change day itself
  assert.equal(ptInstant('2026-03-06', '09:00'), '2026-03-06T17:00:00.000Z');
  assert.equal(ptInstant('2026-03-09', '09:00'), '2026-03-09T16:00:00.000Z');
  // The California day, not the UTC day: 05:30Z on the 22nd is still the 21st in California.
  assert.equal(ptToday(new Date('2026-10-22T05:30:00Z')), '2026-10-21');
  assert.equal(dayLabel('2026-11-01', { weekday: true }), 'Sun Nov 1');
});

test('targets: compound from the real baseline through the milestones to 1,000; monotonic', () => {
  const t = planTargets(plan());
  assert.equal(t.length, 26);
  assert.equal(t[5].users, 100); assert.equal(t[13].users, 350); assert.equal(t[25].users, 1000);
  for (let i = 1; i < t.length; i++) assert.ok(t[i].users >= t[i - 1].users, `week ${i + 1} not below week ${i}`);
  assert.equal(t[0].weekStart, '2026-10-19'); assert.equal(t[1].weekStart, '2026-10-26'); assert.equal(t[2].weekStart, '2026-11-02');
  // geometric, not linear: the first week adds less than a straight line would
  assert.ok(t[0].users - 10 < (100 - 10) / 6);
  // paid: nothing before day 90, the first dollar at week 13, 2% of the goal at the end
  assert.ok(t.slice(0, 12).every((x) => x.paidUsers === 0));
  assert.equal(t[12].paidUsers, 1); assert.equal(t[25].paidUsers, 20); assert.equal(t[25].revenue, Math.round(20 * INTERVIEW_PREP_USD * 100) / 100); assert.equal(t[25].revenue, 199.8);
  assert.ok(['atomic', 'loop', 'compound'].includes(t[0].phase) && t[0].phase === 'atomic' && t[10].phase === 'loop' && t[20].phase === 'compound');
});

test('a baseline past a milestone drops it; an unknown baseline starts from zero', () => {
  const t = planTargets(plan({ baselineUsers: 200 }));
  assert.ok(t[5].users > 200 && t[5].users < 350); assert.equal(t[13].users, 350); assert.equal(t[25].users, 1000);
  const z = planTargets(buildPlan({ start: '2026-10-19' }));
  assert.equal(z[5].users, 100); assert.ok(z[0].users > 0);
});

test('weekly check: statuses from REAL numbers, each change names its rule; unknown when there are none', () => {
  const p = plan();
  const none = checkWeek({ plan: p, actuals: null, today: '2026-11-04' });
  assert.equal(none.overall, 'unknown'); assert.equal(none.changes[0].rule, 'honest_numbers');
  const degraded = checkWeek({ plan: p, actuals: actualsFrom(summary({ degraded: true })), today: '2026-11-04' });
  assert.equal(degraded.overall, 'unknown'); assert.match(degraded.changes[0].what, /failed queries/);
  const wk3 = checkWeek({ plan: p, actuals: actualsFrom(summary({ users: 12 })), today: '2026-11-04' });
  assert.equal(wk3.week, 3); assert.ok(['behind', 'off-track'].includes(wk3.status.users));
  assert.ok(wk3.changes.some((c) => c.rule === 'dont_scale' && /DMs/.test(c.what)));
  assert.ok(wk3.changes.some((c) => c.rule === 'activation_first'), 'activation is unmeasured → make it measurable');
  assert.ok(wk3.changes.every((c) => c.why && c.rule));
  const ahead = checkWeek({ plan: p, actuals: actualsFrom(summary({ users: 400 })), today: '2026-11-04' });
  assert.equal(ahead.status.users, 'ahead'); assert.ok(ahead.changes.some((c) => c.rule === 'focus_channel'));
  assert.equal(ahead.status.paid, 'not-yet');
  const lateNoMoney = checkWeek({ plan: p, actuals: actualsFrom(summary({ users: 500, paid: 0 })), today: addDays('2026-10-19', 7 * 15) });
  assert.ok(['behind', 'off-track'].includes(lateNoMoney.status.paid)); assert.ok(lateNoMoney.changes.some((c) => /Interview Prep offer/.test(c.what)));
  assert.ok(lateNoMoney.changes.every((c) => !/trial|Sprint|MRR/i.test(c.what)), 'no retired product is ever advised');
  const fewInterviews = checkWeek({ plan: p, actuals: actualsFrom(summary({ users: 500, paid: 0, interviews: 2 })), today: addDays('2026-10-19', 7 * 15) });
  assert.ok(fewInterviews.changes.some((c) => /at an interview/.test(c.what) && /check-ins/.test(c.what)), 'few interviews → the lever is reaching the interview, not the offer');
  // the trend line compares with last week's recorded snapshot
  const hist = { 2: { ...actualsFrom(summary({ users: 20, dau: 8 })), day: '2026-10-28' } };
  const tr = checkWeek({ plan: p, actuals: actualsFrom(summary({ users: 20, dau: 6 })), history: hist, today: '2026-11-04' });
  assert.equal(tr.trend.users, 0); assert.ok(tr.changes.some((c) => c.rule === 'weekly_retention'));
});

test('gates: dated, upcoming → missed after the date, hit when measured; unmeasurable ones say what is needed', () => {
  const p = plan();
  const before = gates({ plan: p, actuals: actualsFrom(summary({ users: 40 })), today: '2026-11-04' });
  const u100 = before.find((g) => g.id === 'users-atomic');
  assert.equal(u100.date, '2026-11-29'); assert.equal(u100.state, 'upcoming'); assert.ok(u100.daysLeft > 0);
  const after = gates({ plan: p, actuals: actualsFrom(summary({ users: 40 })), today: '2026-12-01' });
  assert.equal(after.find((g) => g.id === 'users-atomic').state, 'missed');
  assert.equal(gates({ plan: p, actuals: actualsFrom(summary({ users: 120 })), today: '2026-12-01' }).find((g) => g.id === 'users-atomic').state, 'hit');
  const g6 = gates({ plan: p, actuals: actualsFrom(summary({ users: 40, revenue: 9.99, paid: 1 })), today: '2026-11-04' }).find((g) => g.id === 'G6');
  assert.equal(g6.state, 'hit'); assert.equal(g6.date, addDays('2026-10-19', 90));
  const g1 = gates({ plan: p, actuals: null, today: addDays('2026-10-19', 91) }).find((g) => g.id === 'G1');
  assert.equal(g1.state, 'needs-measurement'); assert.match(g1.note, /KPI pack/);
  // G3/G4 ask the one-time model's questions (the trial is retired)
  const at = (o) => gates({ plan: p, actuals: actualsFrom(summary(o)), today: '2026-11-04' });
  assert.equal(at({ shown: 10, prep: 3 }).find((g) => g.id === 'G3').state, 'upcoming', 'too few offers seen to judge');
  assert.equal(at({ shown: 30, prep: 4 }).find((g) => g.id === 'G3').state, 'hit');
  assert.equal(at({ prep: 3, pass: 2 }).find((g) => g.id === 'G4').state, 'hit');
  assert.equal(at({ prep: 3, pass: 1 }).find((g) => g.id === 'G4').state, 'upcoming');
  assert.ok(gates({ plan: p, actuals: null, today: '2026-11-04' }).every((g) => !/trial/i.test(g.name + g.number)));
});

test('the plan persists on first use; the baseline is set once from the first real numbers', () => {
  const p = getPlan(); assert.equal(getPlan().start, p.start); assert.equal(p.baseline.users, null);
  const a = actualsFrom(summary({ users: 33 }));
  const withBase = ensureBaseline(p, a); assert.equal(withBase.baseline.users, 33);
  assert.equal(ensureBaseline(withBase, actualsFrom(summary({ users: 90 }))).baseline.users, 33);
  assert.equal(ensureBaseline(savePlan(buildPlan({ start: '2026-10-19' })), actualsFrom(summary({ degraded: true }))).baseline.users, null);
  const w = recordActuals({ ...a, day: '2026-11-04' }, plan()); assert.equal(w.week, 3); assert.equal(actualsHistory()[3].users, 33);
  assert.equal(planWeek(plan(), '2026-10-18'), 0); assert.equal(planWeek(plan(), '2026-10-25'), 1);
});

test('actuals come only from admin-stats fields; activation is never estimated', () => {
  const a = actualsFrom(summary({ users: 41, paid: 2, revenue: 29.98, prep: 1, pass: 1 }));
  assert.equal(a.users, 41); assert.equal(a.paid, 2); assert.equal(a.revenue, 29.98); assert.equal(a.prepPurchases, 1); assert.equal(a.passPurchases, 1);
  const unknown = actualsFrom({ ...summary(), revenue: { month: null, payingCustomers: null } });
  assert.equal(unknown.revenue, null); assert.equal(unknown.paid, null, 'unknown revenue stays unknown, never $0'); assert.equal(a.newThisWeek, 6); assert.equal(a.reportsWeek, 12);
  assert.equal(a.activation, null); assert.equal(actualsFrom(null), null);
});

test('the owner\'s weekly time stays inside the playbook\'s 5–8 hours in every phase', () => {
  for (const ph of ['atomic', 'loop', 'compound']) { const b = timeBudget(ph); assert.ok(b.totalHours >= 5 && b.totalHours <= 8, `${ph}: ${b.totalHours} h`); assert.ok(b.rows.every((r) => r.rule)); }
});
