// Money & Scale, wired to live data. gatherMoney() reads every source once (each guarded, each with a
// timeout — one dead source never hides the rest), moneyPicture() turns the readings into the ledger,
// the allocation, unit economics, scenarios, the scale watch and real simulation inputs. The board meeting
// gets compact blocks for the revenue and reliability departments (moneyDeptBlock), built from the live
// bundle the meeting already fetched — no extra network calls.
import * as adminStats from '../connectors/adminStats.mjs';
import * as stripeConn from '../connectors/stripe.mjs';
import { config } from '../config.mjs';
import { usageReport } from '../ai-usage.mjs';
import { currentFacts } from '../brain.mjs';
import { loadMoney, readHistory, recordSnapshot } from './store.mjs';
import { stripeSales } from './sales.mjs';
import { buildLedger, ledgerLine, usd } from './ledger.mjs';
import { allocate } from './allocate.mjs';
import { unitEconomics, defaultScenarios, growthChannels } from './units.mjs';
import { scaleWatch, storageReading } from './scale.mjs';
import { simulationInputsFrom, costFromQuestion, isMoneyQuestion } from './inputs.mjs';

const withTimeout = (p, ms, label) => Promise.race([Promise.resolve().then(p), new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms / 1000}s`)), ms))]);
const guard = async (fn, label, ms = 25_000) => { try { return await withTimeout(fn, ms, label); } catch (e) { return { error: String(e.message || e).slice(0, 200) }; } };

async function probeUrl(url, fetchFn = fetch) {
  try { const r = await fetchFn(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(8000) }); return { ok: r.ok, status: r.status }; }
  catch (e) { return { ok: false, status: e.cause?.code || 'no answer' }; }
}

export function defaultDeps({ now = new Date() } = {}) {
  return {
    admin: () => (adminStats.configured() ? adminStats.summary() : { notConfigured: true }),
    stripeSubs: () => (stripeConn.configured() ? stripeConn.subscriptions() : null),
    sales: () => stripeSales({ now }),
    employer: () => (adminStats.configured() ? adminStats.adminAction({ action: 'list_employer_purchases' }) : null),
    usage: () => usageReport({ now }),
    money: () => loadMoney(),
    history: () => readHistory({ now }),
    facts: () => currentFacts(),
    probes: async () => { const base = config.seenBaseUrl(); const [terms, privacy] = await Promise.all([probeUrl(`${base}/terms`), probeUrl(`${base}/privacy`)]); return { terms, privacy }; },
    growth: () => growthChannels(),
    record: (snap) => recordSnapshot(snap, { now }),
  };
}

export async function gatherMoney({ now = new Date(), deps = {} } = {}) {
  const d = { ...defaultDeps({ now }), ...deps };
  const [admin, stripeSubs, sales, usage, money, history, facts, probes, growth] = await Promise.all([
    guard(d.admin, 'admin-stats'), guard(d.stripeSubs, 'Stripe legacy subscriptions'), guard(d.sales, 'Stripe sales'),
    guard(d.usage, 'AI usage', 5000), guard(d.money, 'money file', 5000), guard(d.history, 'history', 5000), guard(d.facts, 'brain facts', 8000),
    guard(d.probes, 'site probes', 12_000), guard(d.growth, 'Growth Studio', 8000),
  ]);
  // Employer purchases from Seen only when Stripe Checkout cannot be read (else they are already counted).
  const employer = sales?.sessions?.rows ? null : await guard(d.employer, 'employer purchases');
  return { admin, stripeSubs, sales, employer, usage: usage?.error ? null : usage, money: money?.error ? loadMoney() : money, history: Array.isArray(history) ? history : [], facts: Array.isArray(facts) && facts.length ? facts : null, probes: probes?.error ? null : probes, growth: growth?.error ? { available: false, reason: growth.error } : growth, now, record: d.record };
}

export function moneyPicture({ admin = null, stripeSubs = null, sales = null, employer = null, usage = null, money = {}, history = [], facts = null, probes = null, growth = null, now = new Date() } = {}) {
  const ledger = buildLedger({ admin, stripeSubs, sales, employer, usage, money, now });
  const allocation = allocate({ revenue: ledger.revenue.month || 0, overrides: money.allocationOverrides || {}, monthlyCosts: ledger.costs.total });
  const units = unitEconomics({ ledger, channels: money.channels || [], growth });
  const scenarios = defaultScenarios(ledger);
  const scale = scaleWatch({ admin, history, money, sales, facts, probes, now });
  const inputs = simulationInputsFrom({ ledger, weeks: 12 });
  return { at: now.toISOString(), atPT: ledger.atPT, ledger, allocation, units, scenarios, scale, inputs, rule: 'Money never changes a score: employer purchases buy reach or a badge, never a grade.' };
}

export function snapshotOf(picture, admin) {
  const st = storageReading(admin?.raw || admin);
  return { users: picture.ledger.users ?? undefined, paying: picture.ledger.paying ?? undefined, revenue30d: picture.ledger.revenue.month ?? undefined, dbMb: st?.mb ?? undefined };
}

// The cached live picture (the Money tab, act verbs and simulations share it). 60 s unless refreshed.
let cached = null;
export async function getPicture({ refresh = false, maxAgeMs = 60_000, deps = {}, now = new Date() } = {}) {
  if (!refresh && cached && +now - cached.t < maxAgeMs) return cached.p;
  const g = await gatherMoney({ now, deps });
  const p = moneyPicture(g);
  try { g.record?.(snapshotOf(p, g.admin)); } catch { /* history is best effort */ }
  cached = { t: +now, p };
  return p;
}
export const _resetPictureCache = () => { cached = null; };

// Exactly simulateNumbers()'s input shape, from live data, plus `assumptions`.
export async function simulationInputs({ weeks = 12, question = '', deps = {} } = {}) {
  const p = await getPicture({ maxAgeMs: 5 * 60_000, deps });
  return simulationInputsFrom({ ledger: p.ledger, weeks, extra: costFromQuestion(question) });
}

// For lib/simulations.mjs: a money decision with no numbers of its own gets live ones; anything else none.
export async function numbersFor(job, { deps = {} } = {}) {
  if (!job || job.numbers || !isMoneyQuestion(job.question)) return null;
  return simulationInputs({ weeks: 12, question: job.question, deps });
}

// ---- board meeting blocks ---------------------------------------------------------------------------
const pct = (x) => (x == null ? '—' : `${Math.round(x * 1000) / 10}%`);
export function revenueBlock(p) {
  const l = p.ledger; const a = p.allocation; const u = p.units;
  const lines = [`MONEY (live, ${l.atPT} PT — Seen sells one-time products (Interview Prep $9.99, Job Search Pass $19.99; nothing renews). Every number from admin-stats/Stripe/your cost list; projections are labelled):`];
  if (l.unavailable.length) lines.push(`- Unavailable: ${l.unavailable.join('; ')}`);
  lines.push(`- ${ledgerLine(l)}`);
  const f = l.funnel;
  lines.push(f ? `- Funnel (${f.days} days): ${f.interviews ?? '—'} cards at an interview now · ${f.offerShown ?? '—'} saw the Prep offer · ${f.offerClicked ?? '—'} pressed it · take rate ${f.takeRate.rate != null ? pct(f.takeRate.rate) : f.takeRate.formula}${f.implied ? ` · implied ${usd(f.implied.dollars)}/mo at today's rates` : ''} · buyer share ${pct(l.buyerShare)}` : `- Funnel: unknown (Seen's revenue funnel not readable)`);
  lines.push(`- Stage ${a.stage.label}: ${a.headline}${a.check ? ` ${a.check.text}` : ''}${a.next ? ` Next stage at ${usd(a.next.needed + a.revenue)}/mo.` : ''}`);
  lines.push(`- Unit economics: ${usd(u.contribution)} contribution per sale${u.avgSaleObserved ? '' : ` (at the ${usd(u.avgSale)} Interview Prep price — assumed)`} · break-even ${u.breakEven.sales} sales a month${u.breakEven.interviews != null ? ` ≈ ${u.breakEven.interviews.toLocaleString('en-US')} tracked interviews` : ''}`);
  const best = [...p.scenarios.scenarios].filter((s) => s.id !== 'today').sort((x, y) => y.delta - x.delta)[0];
  if (best) lines.push(`- Biggest single lever (projection): ${best.title} → +${usd(best.delta)}/mo (${best.assumes.join('; ')})`);
  lines.push(`- ${p.rule}`);
  return `${lines.join('\n')}\n\n`;
}
export function reliabilityBlock(p) {
  const s = p.scale; const label = { act: 'ACT NOW', soon: 'SOON', unknown: 'UNKNOWN', ok: 'OK' };
  const lines = [`SCALE WATCH (live, ${s.atPT} PT — Supabase plan: ${s.plan}):`];
  for (const i of s.items.filter((x) => x.status === 'act' || x.status === 'soon').slice(0, 6)) lines.push(`- ${label[i.status]}: ${i.title} — ${i.reading}${i.limit ? ` / ${i.limit}` : ''}${i.etaText ? ` · ETA ${i.etaText}` : ''}${i.fixCost ? ` · fix ${i.fixCost}` : ''}. ${i.action || ''}`.trim());
  const ok = s.items.filter((x) => x.status === 'ok').map((x) => x.title); const unk = s.items.filter((x) => x.status === 'unknown').map((x) => x.title);
  if (ok.length) lines.push(`- OK: ${ok.join(', ')}`);
  if (unk.length) lines.push(`- Not readable here: ${unk.join(', ')}`);
  const due = s.readiness.filter((r) => r.due && r.state !== 'done');
  if (due.length) lines.push(`- Readiness ${due.map((r) => `${r.milestone} users: ${r.title} (${r.due})`).join('; ')}`);
  return `${lines.join('\n')}\n\n`;
}

const blockCache = new WeakMap();
// Sync: built from the meeting's own live bundle (admin_stats summary + stripe) + local files.
export function moneyDeptBlock(deptId, live, { now = new Date(), read = { money: loadMoney, usage: () => usageReport({ now }), history: () => readHistory({ now }), facts: currentFacts, record: (snap) => recordSnapshot(snap, { now }) } } = {}) {
  if (deptId !== 'revenue' && deptId !== 'reliability') return '';
  try {
    let p = live && typeof live === 'object' ? blockCache.get(live) : null;
    if (!p) {
      const safe = (fn, dflt) => { try { return fn(); } catch { return dflt; } };
      const stripeSubs = live?.stripe?.subscriptions || null;
      p = moneyPicture({ admin: live?.admin_stats || null, stripeSubs, money: safe(read.money, {}), usage: safe(read.usage, null), history: safe(read.history, []), facts: ((f) => (Array.isArray(f) && f.length ? f : null))(safe(read.facts, null)), now });
      safe(() => read.record?.(snapshotOf(p, live?.admin_stats)), null); // each meeting adds a reading to the growth history
      if (live && typeof live === 'object') blockCache.set(live, p);
    }
    return deptId === 'revenue' ? revenueBlock(p) : reliabilityBlock(p);
  } catch { return ''; }
}
