// What the growth (CMO) and strategy (CSO) departments read at every board meeting: where the plan to
// 1,000 users stands against the REAL numbers, the next dated gate, what to change (with the rule behind
// each), today's 1% item and streak, this week's calendar, and the brand guardrails. Compact on purpose —
// it rides inside the department prompt next to the brain facts (engine/run.mjs memBlock). Never throws;
// any failure returns '' so a meeting is never blocked by the Growth Studio.
// Side effect (deliberate): the meeting's admin-stats summary is recorded as this plan week's snapshot, so
// the weekly check has history even on days nobody opens the Growth tab.
import { getPlan, ensureBaseline, actualsFrom, recordActuals, actualsHistory, checkWeek } from './plan.mjs';
import { todayItem, streak, dailyHistory } from './daily.mjs';
import { calendarWeek } from './calendar.mjs';
import { getBrand } from './brand.mjs';
import { ptToday, dayLabel } from './pt.mjs';

export function growthMeetingBlock(deptId, { admin = null, today = ptToday() } = {}) {
  if (deptId !== 'growth' && deptId !== 'strategy') return '';
  try {
    const actuals = actualsFrom(admin);
    const plan = ensureBaseline(getPlan(), actuals);
    if (actuals) recordActuals(actuals, plan);
    const c = checkWeek({ plan, actuals, history: actualsHistory(), today });
    const t = c.target; const a = c.actuals;
    const nextGate = c.gates.find((g) => g.state === 'upcoming') || null;
    const late = c.gates.filter((g) => g.state === 'missed' || g.state === 'needs-measurement');
    const lines = [`GROWTH STUDIO — the plan to ${plan.goal.toLocaleString('en-US')} users (Growth tab; act: \`node scripts/act.mjs growth\`):`];
    lines.push(`- Week ${c.week} of ${plan.weeks} · phase "${c.phase.name}" — ${c.phase.goal}`);
    lines.push(`- Target this week: ${t.users} users, ${t.paidUsers} paying customers in 30 days ($${t.revenue} one-time revenue). Actual: ${a ? `${a.users ?? '?'} users, ${a.paid ?? '?'} paying, $${a.revenue ?? '?'} in 30 days (${a.prepPurchases ?? '?'} Interview Prep, ${a.passPurchases ?? '?'} Pass; ${a.interviews ?? '?'} tracked applications at an interview)` : 'unknown (admin-stats not connected)'} → ${c.overall.toUpperCase()}.`);
    if (nextGate) lines.push(`- Next gate: ${nextGate.name} (${nextGate.number}) by ${dayLabel(nextGate.date)} — ${nextGate.daysLeft} days. If missed: ${nextGate.ifMissed}`);
    if (late.length) lines.push(`- Gates past due: ${late.map((g) => `${g.id} ${g.name} (${g.state})`).join('; ')}`);
    lines.push(`- What to change: ${c.changes.slice(0, 3).map((x) => `${x.what} [rule: ${x.rule}]`).join(' · ')}`);
    if (deptId === 'growth') {
      const d = todayItem({ day: today, behind: ['behind', 'off-track'].includes(c.overall), activationUnmeasured: !a || a.activation == null });
      const s = streak(dailyHistory(), today);
      lines.push(`- Today's 1% item (${d.laneName}, ~${d.minutes} min): ${d.title} — ${d.status}. Streak ${s.current} day${s.current === 1 ? '' : 's'} (best ${s.best}).`);
      const wk = calendarWeek({ from: today, plan });
      const items = wk.days.flatMap((x) => x.items);
      if (items.length) lines.push(`- Calendar this week: ${items.length} items — ${items.filter((i) => ['posted', 'measured'].includes(i.status)).length} posted, ${items.filter((i) => i.owner === 'brandon' && !['posted', 'measured'].includes(i.status)).length} waiting on Brandon${wk.violations.length ? `; platform-rule problems: ${wk.violations.map((v) => v.problem).join('; ')}` : ''}.`);
      else lines.push('- Calendar: not generated yet — generate it in the Growth tab (`node scripts/act.mjs calendar`).');
    }
    const kit = getBrand().kit;
    lines.push(`- Brand (v${getBrand().version}): "${kit.tagline}" — category: ${kit.category}. Never: ${kit.wordsToAvoid.slice(0, 5).map((w) => w.word).join(', ')}. Money never changes a score; no invented numbers.`);
    lines.push('Propose growth work that serves this plan and NAME the playbook rule it follows (beachhead, dont_scale, activation_first, weekly_retention, founder_content, kill_gates, compounding_seo, promotable, one_percent).');
    return `${lines.join('\n')}\n\n`;
  } catch (e) {
    process.stderr.write(`[growth] meeting block skipped: ${e.message}\n`);
    return '';
  }
}
