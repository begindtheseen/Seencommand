// Growth Studio routes. engine/server.mjs dispatches every /api/growth/* request here with ONE line; this
// module brings its own JSON/body/local-only helpers and its dependencies (admin-stats, the model lane,
// the brain writer, notifications), all injectable through createGrowthRoutes() for tests.
//
//   GET  /api/growth/overview                 plan check + today's 1% item + streak + this week's calendar
//   GET  /api/growth/brand | POST {patch,note} the brand kit (each save = a new version + brain pointer)
//   GET  /api/growth/positioning | /rules      competitor map + category | the operator playbook
//   GET  /api/growth/plan | POST {start,weeks} the plan to 1,000 users vs REAL admin-stats numbers
//   GET  /api/growth/calendar?week=&all=1      a week (or every item); POST …/calendar/generate {from,weeks}
//   POST /api/growth/calendar/<id>/status {status} · …/<id>/results {impressions,…}
//   GET  /api/growth/copy/<id> · POST …/<id>/draft · POST …/<id>/approve {variant}
//   GET  /api/growth/daily · POST {status,note,day}
//   GET  /api/growth/assets?week= · /data · /ads · /meeting?dept= · /templates[/<id>]
//   GET  /api/growth/library · POST {name,template,size,png} · GET /api/growth/library/<file>.png
//   GET  /api/growth/fonts/<file>.woff2        the vendored OFL fonts for the ad designer
// Every request must come from this Mac; writes also need a same-origin Origin header (the credentials rule).
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { growthDir, readDoc, writeDoc } from './store.mjs';
import { getBrand, brandHistory, saveBrand, liveProof } from './brand.mjs';
import { positioning } from './positioning.mjs';
import { rulesList } from './rules.mjs';
import { getPlan, savePlan, buildPlan, ensureBaseline, planView, actualsFrom, recordActuals, actualsHistory, checkWeek, planTargets } from './plan.mjs';
import { regenerateCalendar, calendarWeek, getCalendar, findItem, setStatus, recordResults, updateItem } from './calendar.mjs';
import { draftItem, approveCopy, copyState, FORMATS } from './copy.mjs';
import { designMeta, templateSpec } from './design-meta.mjs';
import { todayItem, markDaily, streak, dailyHistory, weeklyReview } from './daily.mjs';
import { shareableAssets, storyAngles } from './assets.mjs';
import { callouts } from './data.mjs';
import { adsPlan } from './ads.mjs';
import { growthMeetingBlock } from './meeting.mjs';
import { ptToday, isDay, mondayOf } from './pt.mjs';

const FONT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'assets', 'fonts');
const FONTS = new Set(['Syne.woff2', 'InstrumentSans.woff2', 'DMMono-Medium.woff2']);
const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
function readBody(req, limit = 12e6) {
  return new Promise((resolve) => {
    let b = ''; let over = false;
    req.on('data', (c) => { if (over) return; b += c; if (b.length > limit) { over = true; resolve({ __tooLarge: true }); } });
    req.on('end', () => { if (over) return; try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}
export function isLocal(req, { write = false } = {}) {
  const remote = String(req.socket?.remoteAddress || '');
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return false;
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(String(req.headers.host || ''))) return false;
  return !write || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(String(req.headers.origin || ''));
}

// The brain pointer writer (same contract as the server's recordBrainNote: supersede-never-overwrite,
// verified by a read-after-write, reported honestly when there is no vault).
async function brainPointer(fact) {
  const { recordFacts, currentFacts } = await import('../brain.mjs');
  recordFacts([{ ...fact, confidence: 'high', source: 'growth-studio' }]);
  const live = (currentFacts() || []).some((f) => f.subject === fact.subject && f.predicate === fact.predicate && String(f.object) === String(fact.object));
  return live ? { ok: true } : { ok: false, error: 'no vault reachable — the pointer was not recorded (the data file is saved)' };
}

export function createGrowthRoutes(deps = {}) {
  const now = deps.now || (() => new Date());
  const today = () => ptToday(now());
  let statsCache = null;
  const stats = async () => {
    if (deps.stats) return deps.stats();
    if (statsCache && Date.now() - statsCache.t < 60_000) return statsCache.v;
    const conn = await import('../connectors/adminStats.mjs');
    let v = null; if (conn.configured()) { try { v = await conn.summary(); } catch (e) { v = { __error: e.message }; } }
    statsCache = { t: Date.now(), v }; return v;
  };
  const reasonFn = deps.reasonFn !== undefined ? deps.reasonFn : async (o) => (await import('../llm.mjs')).reason(o);
  const recordFact = deps.recordFact || brainPointer;
  const notifyFn = deps.notify || (async (n) => { try { (await import('../notifications.mjs')).notify(n); } catch { /* never breaks a route */ } });
  const data = (opts = {}) => (deps.callouts ? deps.callouts(opts) : callouts(opts));

  // admin-stats → { actuals, error } and the week's snapshot recorded.
  async function live() {
    const s = await stats();
    if (!s) return { actuals: null, error: 'admin-stats is not configured (SEEN_ADMIN_USERNAME / SEEN_ADMIN_PASSWORD)' };
    if (s.__error) return { actuals: null, error: `admin-stats: ${s.__error}` };
    const actuals = actualsFrom(s, now());
    const plan = ensureBaseline(getPlan(now()), actuals);
    recordActuals(actuals, plan);
    return { actuals, plan, stats: s };
  }
  async function planNow() {
    const l = await live(); const plan = l.plan || getPlan(now());
    const check = checkWeek({ plan, actuals: l.actuals, history: actualsHistory(), today: today() });
    if (['behind', 'off-track'].includes(check.overall)) await notifyFn({ kind: 'growth', level: 'warning', title: `Growth plan: ${check.overall} in week ${check.week}`, body: check.changes[0]?.what || '', tab: 'growth', key: `growth-${check.overall}-${check.weekStart}` });
    return { l, plan, check };
  }

  return async function handle(req, res, path, qs) {
    if (!path.startsWith('/api/growth/')) return false;
    const write = req.method !== 'GET' && req.method !== 'HEAD';
    if (!isLocal(req, { write })) { send(res, 403, { error: 'the Growth Studio answers this Mac only' }); return true; }
    const seg = path.slice('/api/growth/'.length).split('/').map(decodeURIComponent);
    try {
      // ---- static: fonts + library images
      if (req.method === 'GET' && seg[0] === 'fonts') {
        if (!FONTS.has(seg[1])) { send(res, 404, { error: 'no such font' }); return true; }
        res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'max-age=86400' }); res.end(readFileSync(join(FONT_DIR, seg[1]))); return true;
      }
      if (seg[0] === 'library') {
        const dir = join(growthDir(), 'library'); mkdirSync(dir, { recursive: true });
        if (req.method === 'GET' && seg[1]) {
          if (!/^[a-z0-9-]+\.png$/.test(seg[1]) || !existsSync(join(dir, seg[1]))) { send(res, 404, { error: 'no such image' }); return true; }
          res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }); res.end(readFileSync(join(dir, seg[1]))); return true;
        }
        const idx = readDoc('library', { items: [] });
        if (req.method === 'GET') { send(res, 200, { items: idx.items.slice().reverse() }); return true; }
        const b = await readBody(req);
        if (b.__tooLarge) { send(res, 413, { error: 'image too large (12 MB max)' }); return true; }
        const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(b.png || ''));
        if (!m) { send(res, 400, { error: 'send { png: "data:image/png;base64,…", name, template, size }' }); return true; }
        const id = `${today()}-${randomBytes(4).toString('hex')}`; const file = `${id}.png`;
        writeFileSync(join(dir, file), Buffer.from(m[1], 'base64'));
        const rec = { id, file, url: `/api/growth/library/${file}`, name: String(b.name || b.template || 'ad').slice(0, 120), template: String(b.template || ''), size: String(b.size || ''), itemId: b.itemId || null, source: String(b.source || '').slice(0, 300), at: now().toISOString() };
        writeDoc('library', { items: [...idx.items, rec].slice(-500) });
        send(res, 200, { ok: true, item: rec }); return true;
      }
      // ---- reads + writes
      if (seg[0] === 'overview' && req.method === 'GET') {
        const { l, plan, check } = await planNow();
        const day = today();
        const item = todayItem({ day, behind: ['behind', 'off-track'].includes(check.overall), activationUnmeasured: !l.actuals || l.actuals.activation == null });
        send(res, 200, { today: day, plan: { start: plan.start, weeks: plan.weeks, goal: plan.goal, baseline: plan.baseline }, check, statsError: l.error || null,
          daily: { item, streak: streak(dailyHistory(), day) }, calendar: calendarWeek({ from: day, plan }), brand: { version: getBrand().version, tagline: getBrand().kit.tagline } });
        return true;
      }
      if (seg[0] === 'brand') {
        if (req.method === 'GET') { const l = await live(); send(res, 200, { ...getBrand(), history: brandHistory().map((v) => ({ v: v.v, at: v.at, by: v.by, note: v.note })), liveProof: liveProof(l.stats && !l.stats.__error ? l.stats : null) }); return true; }
        const b = await readBody(req);
        const r = await saveBrand(b.patch || {}, { note: b.note || '', recordFact, now: now() });
        send(res, r.ok ? 200 : 400, r); return true;
      }
      if (seg[0] === 'positioning' && req.method === 'GET') { send(res, 200, positioning()); return true; }
      if (seg[0] === 'rules' && req.method === 'GET') { send(res, 200, { rules: rulesList() }); return true; }
      if (seg[0] === 'plan') {
        if (req.method === 'GET') { const { l, plan } = await planNow(); send(res, 200, { ...planView({ plan, actuals: l.actuals, history: actualsHistory(), today: today() }), statsError: l.error || null }); return true; }
        const b = await readBody(req);
        if (b.start && !isDay(b.start)) { send(res, 400, { error: 'start must be YYYY-MM-DD' }); return true; }
        const l = await live();
        const plan = savePlan(buildPlan({ start: b.start || today(), weeks: b.weeks, baselineUsers: l.actuals && !l.actuals.degraded ? l.actuals.users : null, now: now() }));
        const brain = await recordFact({ subject: 'growth:plan', predicate: 'current', object: `Plan to ${plan.goal} users: ${plan.weeks} weeks from ${plan.start} (PT), baseline ${plan.baseline.users ?? 'unknown'} users (data/growth/plan.json)` }).catch((e) => ({ ok: false, error: e.message }));
        send(res, 200, { ok: true, plan, targets: planTargets(plan), brain }); return true;
      }
      if (seg[0] === 'calendar') {
        if (req.method === 'GET') {
          if (qs.get('all') === '1') { send(res, 200, getCalendar()); return true; }
          const w = qs.get('week'); send(res, 200, calendarWeek({ from: w && isDay(w) ? w : today() })); return true;
        }
        if (seg[1] === 'generate') {
          const b = await readBody(req); const d = await data();
          const r = regenerateCalendar({ from: b.from && isDay(b.from) ? b.from : today(), weeks: b.weeks || 6, data: d.ok ? d : null, now: now() });
          send(res, 200, { ok: true, kept: r.kept, added: r.added, violations: r.violations, dataError: d.ok ? null : d.error, total: r.items.length }); return true;
        }
        const id = seg[1]; const b = await readBody(req);
        if (seg[2] === 'status') { const r = setStatus(id, b.status); send(res, r.ok ? 200 : 400, r); return true; }
        if (seg[2] === 'results') { const r = recordResults(id, b); send(res, r.ok ? 200 : 400, r); return true; }
        send(res, 404, { error: 'no such calendar route' }); return true;
      }
      if (seg[0] === 'copy') {
        const id = seg[1]; const item = findItem(id);
        if (!item) { send(res, 404, { error: 'no such calendar item — generate the calendar first' }); return true; }
        if (req.method === 'GET') { send(res, 200, { item, draft: copyState().drafts?.[id] || null }); return true; }
        if (seg[2] === 'draft') {
          const b = await readBody(req);
          if (b.format && FORMATS.includes(b.format) && b.format !== item.format) { // e.g. `act ad <item>`: ad copy for any item, stored beside its own drafts
            const r = await draftItem({ ...item, id: `${item.id}:${b.format}`, format: b.format, channel: b.format === 'ad' ? 'ad' : item.channel }, { reasonFn, now: now() });
            send(res, 200, r); return true;
          }
          const r = await draftItem(item, { reasonFn, now: now() });
          if (r.ok && item.status === 'idea') updateItem(id, (x) => ({ status: 'drafted', drafts: (x.drafts || 0) + 1 })); else if (r.ok) updateItem(id, (x) => ({ drafts: (x.drafts || 0) + 1 }));
          send(res, 200, r); return true;
        }
        if (seg[2] === 'approve') {
          const b = await readBody(req); const r = await approveCopy(id, b.variant, { recordFact, now: now() });
          if (r.ok && ['idea', 'drafted'].includes(findItem(id).status)) updateItem(id, () => ({ status: 'approved', approvedVariant: r.variant, statusAt: now().toISOString() }));
          send(res, r.ok ? 200 : 400, r); return true;
        }
        send(res, 404, { error: 'no such copy route' }); return true;
      }
      if (seg[0] === 'daily') {
        const day = today();
        if (req.method === 'GET') {
          const { l, check } = await planNow();
          const item = todayItem({ day, behind: ['behind', 'off-track'].includes(check.overall), activationUnmeasured: !l.actuals || l.actuals.activation == null });
          const hist = actualsHistory(); const wk = check.week;
          send(res, 200, { item, streak: streak(dailyHistory(), day), review: weeklyReview({ weekStart: mondayOf(day), snapshots: [hist[wk - 1] || null, hist[wk] || null] }), recent: Object.entries(dailyHistory()).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 14).map(([d, r]) => ({ day: d, ...r })) });
          return true;
        }
        const b = await readBody(req);
        const d = b.day && isDay(b.day) && b.day <= day ? b.day : day;
        const r = markDaily(d, b.status || 'done', { note: b.note, now: now() });
        if (r.ok && r.item.status === 'done' && [7, 14, 30, 60, 100, 365].includes(r.streak.current)) await notifyFn({ kind: 'growth', level: 'success', title: `${r.streak.current}-day 1% streak`, body: `Seen got a little better ${r.streak.current} days in a row.`, tab: 'growth', key: `growth-streak-${r.streak.current}-${d}` });
        send(res, r.ok ? 200 : 400, r); return true;
      }
      if (seg[0] === 'assets' && req.method === 'GET') {
        const plan = getPlan(now()); const w = Number(qs.get('week')) || Math.max(1, checkWeek({ plan, today: today() }).week); const d = await data();
        send(res, 200, { assets: shareableAssets(), angles: storyAngles(w, d.ok ? d : null), week: w, dataError: d.ok ? null : d.error }); return true;
      }
      if (seg[0] === 'templates' && req.method === 'GET') {
        if (seg[1]) { const t = templateSpec(seg[1]); send(res, t ? 200 : 404, t ? { template: t } : { error: 'no such template' }); return true; }
        send(res, 200, designMeta()); return true;
      }
      if (seg[0] === 'data' && req.method === 'GET') { send(res, 200, await data({ force: qs.get('refresh') === '1' })); return true; }
      if (seg[0] === 'ads' && req.method === 'GET') {
        const { l, check } = await planNow();
        send(res, 200, adsPlan({ actuals: l.actuals, history: actualsHistory(), items: getCalendar().items, check })); return true;
      }
      if (seg[0] === 'meeting' && req.method === 'GET') { const l = await live(); send(res, 200, { dept: qs.get('dept') || 'growth', block: growthMeetingBlock(qs.get('dept') || 'growth', { admin: l.stats && !l.stats.__error ? l.stats : null, today: today() }) }); return true; }
      send(res, 404, { error: 'no such growth route' }); return true;
    } catch (e) { send(res, 500, { error: e.message }); return true; }
  };
}

let singleton = null;
/** The server's dispatch target: `if (await handleGrowth(req, res, path, qs)) return;` */
export function handleGrowth(req, res, path, qs) { return (singleton ||= createGrowthRoutes())(req, res, path, qs); }
