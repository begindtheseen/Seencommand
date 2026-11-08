// HTTP routes for the Aggregation Dashboard — /api/aggregation/*. engine/server.mjs forwards here.
//
// Security model (the server binds 127.0.0.1 only; these checks are defense in depth):
//   • EVERY request must come from loopback with a localhost Host header (blocks DNS rebinding).
//   • EVERY mutation must also carry the local app's own Origin (blocks cross-site form posts) — the
//     same gate Settings/credentials use.
//   • No route accepts an executable, a script path, a shell string or an arbitrary env var: a run is
//     { pipeline, overrides } validated by that pipeline's adapter, and the manager builds the argv.
//   • Responses never carry a secret: tokens are reported as configured/not, and every log tail is
//     redacted before it is persisted.
//
//   GET  /api/aggregation/status                 overview of both pipelines (cached readiness)
//   GET  /api/aggregation/health[?refresh=1]     all readiness checks
//   GET  /api/aggregation/collectors             registry + capabilities discovered from the CLIs
//   GET  /api/aggregation/config                 saved configuration (validated)
//   PUT  /api/aggregation/config                 { seenRepoDir?, pipelines?: { indeed?, company_intel?, career_site?, applicant_reports?, web_reports? } }
//   GET  /api/aggregation/runs?pipeline&status&since&until&source&limit
//   POST /api/aggregation/runs                   { pipeline, overrides?, confirmLarge? }
//   GET  /api/aggregation/runs/:id
//   POST /api/aggregation/runs/:id/cancel
//   GET  /api/aggregation/schedules
//   POST /api/aggregation/schedules/tick         run any due (or missed-while-asleep) schedule now — the app calls it on wake
//   PUT  /api/aggregation/schedules/:pipeline    { enabled?, frequency?, time?, weekday? }
//   POST /api/aggregation/company-intel/targets  { limit } — read-only preview of Seen's target list
//   GET  /api/aggregation/company-intel/catalog[?refresh=1]  every company Seen knows, with counts
//   GET  /api/aggregation/indeed/presets[?refresh=1]         Seen's niche / maintenance / demand presets
//   GET  /api/aggregation/boards                 { running, last } — the last employer-board pull
//   POST /api/aggregation/boards/pull            { companies?: string[≤50] } | { limit?: 1–400 }
//   GET  /api/aggregation/company-jobs           { running, last } — the current or last company job pull
//   POST /api/aggregation/company-jobs           { companies: string[1–10], websites?, siteLimit?, indeed?, browser? }

import { aggregationManager } from '../../engine/aggregation-manager.mjs';
import { PIPELINES, RUN_STATUSES, isRunId } from './store.mjs';

const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
function readBody(req, max = 256 * 1024) {
  return new Promise((resolve) => {
    let b = ''; let over = false;
    req.on('data', (c) => { if (over) return; b += c; if (b.length > max) { over = true; resolve({ __tooLarge: true }); req.destroy(); } });
    req.on('end', () => { if (over) return; if (!b) return resolve({}); try { resolve(JSON.parse(b)); } catch { resolve({ __invalid: true }); } });
    req.on('error', () => resolve({ __invalid: true }));
  });
}

const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
export function localRead(req) {
  if (!LOOPBACK.includes(String(req.socket?.remoteAddress || ''))) return false;
  return /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(String(req.headers.host || ''));
}
export function localWrite(req) {
  return localRead(req) && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(String(req.headers.origin || ''));
}

export async function handleAggregation(req, res, { manager = aggregationManager() } = {}) {
  const url = new URL(req.url, 'http://local');
  const parts = url.pathname.split('/').filter(Boolean).slice(2); // after api/aggregation
  const m = req.method;
  if (!localRead(req)) return send(res, 403, { error: 'the aggregation API is available only to the local Seen Command app' });
  const isWrite = m !== 'GET';
  if (isWrite && !localWrite(req)) return send(res, 403, { error: 'aggregation changes are allowed only from the local Seen Command app' });
  const body = isWrite ? await readBody(req) : {};
  if (body.__tooLarge) return send(res, 413, { error: 'request body too large' });
  if (body.__invalid) return send(res, 400, { error: 'request body must be JSON' });
  const reply = (r, okCode = 200) => send(res, r.ok === false ? (r.code || 400) : okCode, r);

  try {
    if (m === 'GET' && parts[0] === 'status' && parts.length === 1) return send(res, 200, await manager.status());
    if (m === 'GET' && parts[0] === 'health' && parts.length === 1) return send(res, 200, await manager.health({ refresh: url.searchParams.get('refresh') === '1' }));
    if (m === 'GET' && parts[0] === 'collectors' && parts.length === 1) return send(res, 200, { collectors: manager.collectors() });
    if (parts[0] === 'config' && parts.length === 1) {
      if (m === 'GET') return send(res, 200, manager.getConfig());
      if (m === 'PUT') return reply(manager.putConfig(body));
    }
    if (parts[0] === 'runs') {
      if (parts.length === 1 && m === 'GET') {
        const q = Object.fromEntries(url.searchParams);
        if (q.pipeline && !PIPELINES.includes(q.pipeline)) return send(res, 400, { error: 'unknown pipeline' });
        if (q.status && !RUN_STATUSES.includes(q.status)) return send(res, 400, { error: 'unknown status' });
        if (q.source && !['indeed', 'reddit', 'career_site', 'reddit_archive', 'google'].includes(q.source)) return send(res, 400, { error: 'unknown source' });
        for (const k of ['since', 'until']) if (q[k] && !Number.isFinite(new Date(q[k]).getTime())) return send(res, 400, { error: `${k} must be a date` });
        return send(res, 200, { runs: manager.listRuns(q) });
      }
      if (parts.length === 1 && m === 'POST') {
        for (const k of Object.keys(body)) if (!['pipeline', 'overrides', 'confirmLarge'].includes(k)) return send(res, 400, { error: `unknown field: ${k}` });
        if (body.overrides !== undefined && (typeof body.overrides !== 'object' || body.overrides === null || Array.isArray(body.overrides))) return send(res, 400, { error: 'overrides must be an object' });
        return reply(await manager.startRun({ pipeline: body.pipeline, overrides: body.overrides || null, confirmLarge: body.confirmLarge === true, trigger: 'manual', owner: 'local-operator' }), 202);
      }
      const id = parts[1];
      if (!isRunId(id)) return send(res, 400, { error: 'bad run id' });
      if (parts.length === 2 && m === 'GET') { const r = manager.getRun(id); return r ? send(res, 200, r) : send(res, 404, { error: 'no such run' }); }
      if (parts.length === 3 && parts[2] === 'cancel' && m === 'POST') return reply(manager.cancelRun(id));
    }
    if (parts[0] === 'schedules') {
      if (parts.length === 1 && m === 'GET') return send(res, 200, { schedules: manager.getSchedules() });
      if (parts.length === 2 && parts[1] === 'tick' && m === 'POST') return send(res, 200, { ok: true, results: await manager.tick() });
      if (parts.length === 2 && m === 'PUT') return reply(await manager.putSchedule(parts[1], body));
    }
    const refresh = url.searchParams.get('refresh') === '1';
    // Seen unreachable / not yet deployed is an upstream problem (502), not a bad request.
    if (m === 'GET' && parts[0] === 'company-intel' && parts[1] === 'catalog' && parts.length === 2) { const r = await manager.companyCatalog({ refresh }); return send(res, r.ok ? 200 : 502, r); }
    if (m === 'GET' && parts[0] === 'indeed' && parts[1] === 'presets' && parts.length === 2) { const r = await manager.indeedPresets({ refresh }); return send(res, r.ok ? 200 : 502, r); }
    if (parts[0] === 'boards') {
      if (m === 'GET' && parts.length === 1) return send(res, 200, manager.boardsStatus());
      if (m === 'POST' && parts[1] === 'pull' && parts.length === 2) {
        for (const k of Object.keys(body)) if (!['companies', 'limit'].includes(k)) return send(res, 400, { error: `unknown field: ${k}` });
        const r = await manager.pullBoards(body);
        return send(res, r.ok ? 200 : (r.code || 502), r);
      }
    }
    if (parts[0] === 'company-jobs' && parts.length === 1) {
      if (m === 'GET') return send(res, 200, manager.companyJobsStatus());
      if (m === 'POST') {
        for (const k of Object.keys(body)) if (!['companies', 'websites', 'siteLimit', 'indeed', 'browser'].includes(k)) return send(res, 400, { error: `unknown field: ${k}` });
        for (const k of ['indeed', 'browser']) if (body[k] !== undefined && typeof body[k] !== 'boolean') return send(res, 400, { error: `${k} must be true or false` });
        return reply(await manager.companyJobs(body), 202);
      }
    }
    if (m === 'POST' && parts[0] === 'company-intel' && parts[1] === 'targets' && parts.length === 2) {
      const limit = Number(body.limit ?? 10);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) return send(res, 400, { error: 'limit must be 1–100' });
      return reply(await manager.previewTargets(limit));
    }
    return send(res, 404, { error: 'unknown aggregation route' });
  } catch (e) {
    return send(res, 500, { error: `aggregation error: ${String(e.message || e).slice(0, 200)}` });
  }
}
