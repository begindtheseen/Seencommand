// Independent schedules for the two collection pipelines. Pure functions — the manager owns the
// clock and persistence. Rules:
//   • Disabled by default. Only the local operator can enable/change one (never an agent).
//   • daily | weekly at a local wall-clock time (this Mac's timezone, where the collector runs).
//   • A missed slot runs ONCE on wake: if the app was closed or the Mac asleep through a slot (more than
//     GRACE_MS late), the slot is recorded as missed, the manager starts ONE catch-up run, and the next
//     FUTURE slot is scheduled — so a week of downtime fires one run on wake, never a week of runs.
//     (Owner, 2026-10-21: the scheduled searches must still happen when the laptop was closed.)

export const GRACE_MS = 30 * 60 * 1000;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function defaultSchedule() {
  return { enabled: false, frequency: 'daily', time: '06:00', weekday: 1, nextRunAt: null, lastRunAt: null, lastRunId: null, lastOutcome: null, missed: [] };
}

export function validateSchedule(input = {}, prior = defaultSchedule()) {
  const errors = [];
  const out = { ...defaultSchedule(), ...prior };
  if (input.enabled !== undefined) { if (typeof input.enabled !== 'boolean') errors.push('enabled must be true or false'); else out.enabled = input.enabled; }
  if (input.frequency !== undefined) { if (!['daily', 'weekly'].includes(input.frequency)) errors.push('frequency must be daily or weekly'); else out.frequency = input.frequency; }
  if (input.time !== undefined) { if (!TIME_RE.test(String(input.time))) errors.push('time must be HH:MM (24-hour)'); else out.time = String(input.time); }
  if (input.weekday !== undefined) { const w = Number(input.weekday); if (!Number.isInteger(w) || w < 0 || w > 6) errors.push('weekday must be 0 (Sunday) to 6 (Saturday)'); else out.weekday = w; }
  for (const k of Object.keys(input)) if (!['enabled', 'frequency', 'time', 'weekday'].includes(k)) errors.push(`unsupported schedule field: ${k}`);
  return { ok: errors.length === 0, errors, schedule: out };
}

// The first slot strictly after `after` (Date) in local time.
export function nextSlot(sched, after = new Date()) {
  const [h, m] = String(sched.time || '06:00').split(':').map(Number);
  const d = new Date(after.getTime());
  d.setSeconds(0, 0); d.setHours(h, m, 0, 0);
  if (sched.frequency === 'weekly') {
    const delta = (Number(sched.weekday) - d.getDay() + 7) % 7;
    d.setDate(d.getDate() + delta);
    if (d.getTime() <= after.getTime()) d.setDate(d.getDate() + 7);
  } else if (d.getTime() <= after.getTime()) d.setDate(d.getDate() + 1);
  return d;
}

// Decide what one tick does for one schedule: 'idle' | 'run' | 'missed'. Returns the updated schedule.
export function evaluate(sched, now = new Date()) {
  const s = { ...sched };
  if (!s.enabled) return { action: 'idle', schedule: { ...s, nextRunAt: null } };
  if (!s.nextRunAt) return { action: 'idle', schedule: { ...s, nextRunAt: nextSlot(s, now).toISOString() } };
  const due = new Date(s.nextRunAt).getTime();
  if (!Number.isFinite(due)) return { action: 'idle', schedule: { ...s, nextRunAt: nextSlot(s, now).toISOString() } };
  if (now.getTime() < due) return { action: 'idle', schedule: s };
  const next = nextSlot(s, now).toISOString();
  if (now.getTime() - due > GRACE_MS) {
    const missed = [...(s.missed || []), { slot: s.nextRunAt, noticedAt: now.toISOString() }].slice(-20);
    return { action: 'missed', schedule: { ...s, nextRunAt: next, missed } };
  }
  return { action: 'run', schedule: { ...s, nextRunAt: next } };
}
