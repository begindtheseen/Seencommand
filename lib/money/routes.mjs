// Money & Scale routes. Reads are open to the app; every WRITE answers this Mac only (the same check the
// credential and assistant routes use, passed in as `localOnly`).
//   GET  /api/money                     the whole picture (ledger, allocation, units, scenarios, scale, inputs); ?refresh=1
//   GET  /api/money/scale               the scale watch + readiness
//   GET  /api/money/costs               the recurring cost list (+ cash, plan)
//   GET  /api/money/allocate            this month's allocation
//   GET  /api/money/units               unit economics + scenarios
//   GET  /api/money/simulation-inputs   simulateNumbers() inputs from live data (?weeks=, ?question=)
//   POST /api/money/costs               { name, monthly, note?, category? } | { name, remove: true }
//   POST /api/money/cash                { amount, asOf? }   (amount null clears it)
//   POST /api/money/allocate            { stage, pcts } | { stage, reset: true }
//   POST /api/money/channels            { name, spend30d, signups30d, paid30d }
//   POST /api/money/readiness           { id, done: true|false|null }
//   POST /api/money/plan                { service: 'supabase', plan: 'free'|'pro'|'team' }
//   POST /api/money/scenario            { levers } → one projection (read-only, nothing saved)
import { loadMoney, saveMoney, setCost, removeCost, setCash, setChannel, setReadiness, setPlan } from './store.mjs';
import { setOverride } from './allocate.mjs';
import { scenario, defaultScenarios } from './units.mjs';
import { getPicture as liveGetPicture, simulationInputs as liveInputs, _resetPictureCache } from './live.mjs';
export { numbersFor, simulationInputs, moneyDeptBlock } from './live.mjs';

export function createMoneyRoutes({ json, readBody, localOnly, getPicture = liveGetPicture, simulationInputs = liveInputs, load = loadMoney, save = saveMoney, invalidate = _resetPictureCache, logActivity = () => {} } = {}) {
  const write = (fn) => async (req, res) => {
    if (!localOnly(req)) { json(res, 403, { error: 'money changes are made from this Mac only' }); return; }
    const b = await readBody(req);
    const r = fn(load(), b || {});
    if (!r.ok) { json(res, 400, r); return; }
    const saved = save(r.money); invalidate();
    logActivity({ kind: 'money', status: 'saved', summary: r.summary || 'money settings changed' });
    json(res, 200, { ok: true, money: { costs: saved.costs, cash: saved.cash, allocationOverrides: saved.allocationOverrides, channels: saved.channels, readiness: saved.readiness, plans: saved.plans }, previous: r.previous || null });
  };
  const POSTS = {
    '/api/money/costs': write((m, b) => (b.remove ? { ...removeCost(m, b.name), summary: `removed cost ${b.name}` } : { ...setCost(m, b), summary: `cost ${b.name} = ${b.monthly}/mo` })),
    '/api/money/cash': write((m, b) => ({ ...setCash(m, b), summary: 'cash on hand updated' })),
    '/api/money/allocate': write((m, b) => ({ ...setOverride(m, String(b.stage || ''), b.reset ? null : b.pcts), summary: `allocation ${b.reset ? 'reset' : 'override'} for ${b.stage}` })),
    '/api/money/channels': write((m, b) => ({ ...setChannel(m, b), summary: `channel ${b.name} updated` })),
    '/api/money/readiness': write((m, b) => ({ ...setReadiness(m, b), summary: `readiness ${b.id} = ${b.done}` })),
    '/api/money/plan': write((m, b) => ({ ...setPlan(m, b), summary: `${b.service} plan = ${b.plan}` })),
  };
  return async function handle(req, res, path, qs) {
    if (path !== '/api/money' && !path.startsWith('/api/money/')) return false;
    try {
      if (req.method === 'POST' && POSTS[path]) { await POSTS[path](req, res); return true; }
      if (req.method === 'POST' && path === '/api/money/scenario') {
        const b = await readBody(req); const p = await getPicture({});
        const base = defaultScenarios(p.ledger).base;
        json(res, 200, { ...scenario(base, b.levers || {}), base, note: 'A projection: changes only the levers given, everything else held at today\'s measured values.' });
        return true;
      }
      if (req.method !== 'GET') { json(res, 405, { error: 'method not allowed' }); return true; }
      const refresh = qs?.get?.('refresh') === '1';
      if (path === '/api/money') { json(res, 200, await getPicture({ refresh })); return true; }
      if (path === '/api/money/scale') { const p = await getPicture({ refresh }); json(res, 200, { at: p.at, atPT: p.atPT, ...p.scale }); return true; }
      if (path === '/api/money/allocate') { const p = await getPicture({ refresh }); json(res, 200, { at: p.at, ...p.allocation }); return true; }
      if (path === '/api/money/units') { const p = await getPicture({ refresh }); json(res, 200, { at: p.at, ...p.units, scenarios: p.scenarios }); return true; }
      if (path === '/api/money/costs') {
        const m = load(); const p = await getPicture({ refresh });
        json(res, 200, { costs: m.costs, cash: m.cash, plans: m.plans, channels: m.channels, totals: p.ledger.costs, trace: p.ledger.trace.costs });
        return true;
      }
      if (path === '/api/money/simulation-inputs') { json(res, 200, await simulationInputs({ weeks: Number(qs?.get?.('weeks')) || 12, question: String(qs?.get?.('question') || '').slice(0, 500) })); return true; }
      json(res, 404, { error: 'no such money route' });
      return true;
    } catch (e) { json(res, 500, { error: e.message }); return true; }
  };
}

// The server's one dispatch line: handleMoney(req, res, path, qs, { json, readBody, localOnly }).
let handler = null;
export function handleMoney(req, res, path, qs, deps) {
  if (path !== '/api/money' && !path.startsWith('/api/money/')) return false;
  if (!handler) handler = createMoneyRoutes(deps);
  return handler(req, res, path, qs);
}
