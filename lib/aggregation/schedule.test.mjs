import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSchedule, validateSchedule, nextSlot, evaluate, GRACE_MS } from './schedule.mjs';

const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0, 0); // local time, like the Mac

test('schedules are disabled by default and validated strictly', () => {
  assert.equal(defaultSchedule().enabled, false);
  assert.equal(validateSchedule({ enabled: true, frequency: 'weekly', time: '07:30', weekday: 5 }).ok, true);
  const bad = validateSchedule({ enabled: 'yes', frequency: 'hourly', time: '25:00', weekday: 9, cron: '* * * * *' });
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, 5);
});

test('next slot: daily and weekly, always strictly in the future', () => {
  const daily = { frequency: 'daily', time: '06:00' };
  assert.deepEqual(nextSlot(daily, at(2026, 10, 20, 5, 0)), at(2026, 10, 20, 6, 0));
  assert.deepEqual(nextSlot(daily, at(2026, 10, 20, 6, 0)), at(2026, 10, 21, 6, 0));
  const weekly = { frequency: 'weekly', time: '09:15', weekday: 1 }; // Monday
  const n = nextSlot(weekly, at(2026, 10, 20, 12, 0)); // a Tuesday
  assert.equal(n.getDay(), 1); assert.equal(n.getHours(), 9); assert.equal(n.getMinutes(), 15);
  assert.ok(n > at(2026, 10, 20, 12, 0));
});

test('a due slot runs once; a slot missed during downtime is skipped, not replayed', () => {
  const s = { ...defaultSchedule(), enabled: true, time: '06:00', nextRunAt: at(2026, 10, 20, 6, 0).toISOString() };
  assert.equal(evaluate(s, at(2026, 10, 20, 5, 59)).action, 'idle');
  const due = evaluate(s, at(2026, 10, 20, 6, 1));
  assert.equal(due.action, 'run');
  assert.equal(new Date(due.schedule.nextRunAt).getTime(), at(2026, 10, 21, 6, 0).getTime());
  assert.equal(evaluate(due.schedule, at(2026, 10, 20, 6, 2)).action, 'idle'); // not twice
  // The app was closed for a week: ONE "missed" record and the next future slot — no backlog of runs.
  const late = evaluate(s, new Date(at(2026, 10, 27, 8, 0).getTime()));
  assert.equal(late.action, 'missed');
  assert.equal(late.schedule.missed.length, 1);
  assert.ok(new Date(late.schedule.nextRunAt) > at(2026, 10, 27, 8, 0));
  assert.ok(GRACE_MS <= 60 * 60 * 1000);
  assert.equal(evaluate({ ...s, enabled: false }, at(2026, 10, 20, 6, 1)).action, 'idle');
});
