// ONE search (owner, 2026-10-21: "make everything into one search thing with the logic it needs to run all
// kinds of searches, but then in history it still differentiates what kind of search was done … one request
// can be up to all 4 search methods"). The owner types what they want — a company ("acme"), a company and
// roles ("acme technician"), or a field / niche ("welder", "tech") — optionally a page address and keywords.
// This module decides what that is and starts every method that fits, at once:
//
//   company search → career site (Chrome navigator: finds the job list, uses the site's own search + US
//                     filter, pages through everything) · Seen's server pull (job boards, the career site,
//                     Adzuna for that employer) · Indeed (company + keywords, deep pages) · applicant reports
//                     (Reddit archive) · company intelligence (public discussion)
//   field search   → Indeed (the field nationwide + remote, deep pages) · Seen's job sources (Seen's own
//                     search pulls Adzuna/boards for the field into the corpus)
//
// The Chrome collectors share one Browser Bridge, so they run one after another; everything else runs at
// the same time. One search record groups every run it started; History shows each method on its own row.
// When the last step ends, ONE notification summarizes the whole search.
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { dataDir } from '../lib/paths.mjs';
import { cleanStartUrl } from '../lib/aggregation/career-site.mjs';

export const METHODS = {
  career_site: { label: 'Career site (Chrome)', kinds: ['company'] },
  seen_pull: { label: 'Job boards + Seen server', kinds: ['company'] },
  indeed: { label: 'Indeed', kinds: ['company', 'field'] },
  applicant_reports: { label: 'Applicant reports', kinds: ['company'] },
  company_intel: { label: 'Company intelligence', kinds: ['company'] },
  seen_sources: { label: "Seen's job sources", kinds: ['field'] },
};
const TERMINAL = new Set(['completed', 'partial', 'failed', 'blocked', 'cancelled', 'interrupted']);
const clean = (s, n = 160) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const norm = (s) => clean(s).toLowerCase().replace(/[^a-z0-9& ]+/g, ' ').replace(/\b(?:inc|llc|corp|corporation|co|company|ltd|the)\b/g, ' ').replace(/\s+/g, ' ').trim();

// "search acme technician jobs", "find welder", "pull jobs for Acme keyword technician", "collect reports
// for Walmart" → { text, keywords, url, only } — or null when the message is not a search command.
export function parseSearchCommand(message) {
  // Polite openers and "… and import it to seenjobs" endings say nothing about WHAT to search: a search
  // always imports into Seen, so they are dropped before reading the request.
  const m = clean(message, 400)
    .replace(/^(?:hey\s+|ok(?:ay)?\s+)?(?:command[,:]?\s+)?(?:please\s+|can you\s+|could you\s+|would you\s+|i (?:want|need) you to\s+|go\s+(?:and\s+)?)*/i, '')
    .replace(/[.?!]+$/, '')
    .replace(/\s*,?\s*(?:and|then|&)\s+(?:import|send|add|put|save|upload|load|push)\b(?:\s+(?:them|it|it all|those|these|everything|all of (?:it|them)))?(?:\s+(?:to|into|onto|in|on)\s+(?:the\s+)?(?:seen\s*jobs(?:\.io)?|seen(?:\.io)?|the (?:site|website|product)|our site))?\s*$/i, '')
    .replace(/\s+(?:to|into|onto|for|on)\s+(?:seen\s*jobs(?:\.io)?|seen\.io)\s*$/i, '');
  // Strong verbs mean "search" on their own; weak ones (get, import, add, bring in) only with a noun that
  // says jobs or reports, so "add a task" or "get the build status" stay what they were.
  const head = /^(?:search|find|collect|pull|scrape|gather|aggregate|harvest|crawl|fetch|grab|ingest|look for|go find|run a search (?:for|on)|search for)\s+(.+)$/i.exec(m)
    || (/\b(?:jobs?|listings?|openings?|positions?|applicant reports?|reports?)\b/i.test(m) ? /^(?:get(?: me)?|import|add|bring in|load)\s+(.+)$/i.exec(m) : null);
  if (!head) return null;
  let rest = head[1].replace(/[.?!]+$/, '');
  let url = null;
  rest = rest.replace(/\bhttps:\/\/\S+/i, (u) => { url = cleanStartUrl(u); return ' '; });
  let keywords = '';
  rest = rest.replace(/\b(?:keywords?|roles?|titles?)\s*[:=]?\s+(.+)$/i, (_, k) => { keywords = clean(k); return ' '; });
  let only = null;
  if (/\b(?:applicant |company )?reports?\b/i.test(rest) && !/\bjobs?\b/i.test(rest)) only = ['applicant_reports', 'company_intel'];
  rest = rest.replace(/\b(?:jobs?|listings?|openings?|positions?|roles?|reports?|applicant reports?|everything|all)\b/gi, ' ').replace(/^\s*(?:for|on|at|from)\s+/i, '').replace(/\s+(?:for|on|at|from)\s*$/i, '');
  rest = rest.replace(/^\s*(?:for|on|at|from)\s+/i, '');
  const text = clean(rest.replace(/\s+(?:at|for)\s+/gi, ' '));
  if (!text && !url) return null;
  return { text, keywords, url, only };
}

// Decide what a search is. `catalog` = Seen's companies ([{ company, active_listings }]); the longest
// company name that STARTS the text wins, and the rest of the text becomes keywords ("acme technician").
// Where to look: up to 5 places ("United States", "Remote", "Texas", "Austin, TX"). Default: the US
// for a company; the US + remote for a field.
export function cleanLocations(list) {
  if (!Array.isArray(list)) return null;
  const out = [...new Set(list.map((x) => clean(x, 60)).filter((x) => x.length >= 2))].slice(0, 5);
  return out.length ? out : null;
}
// `kind` (from the Board Room planner) says what the text is when Seen's catalog cannot: an employer not on
// Seen yet ("NASA") is still a company search.
export function planSearch({ text = '', keywords = '', url = null, website = '', locations = null, kind: forceKind = null } = {}, catalog = [], { only = null } = {}) {
  const t = clean(text, 200); const kw0 = clean(keywords, 300);
  const startUrl = url ? cleanStartUrl(url) : null;
  let company = null; let rest = t;
  const tn = norm(t);
  if (tn) {
    let best = null;
    for (const c of catalog || []) {
      const name = String(c?.company || ''); const cn = norm(name);
      if (!cn || cn.length < 2) continue;
      if (tn === cn || tn.startsWith(`${cn} `)) { if (!best || cn.length > best.cn.length || (cn.length === best.cn.length && (c.active_listings || 0) > (best.c.active_listings || 0))) best = { c, cn, name }; }
    }
    if (best) {
      company = best.name;
      const words = t.split(/\s+/); const take = best.cn.split(' ').length;
      rest = words.slice(take).join(' ');
    }
  }
  if (!company && startUrl) { company = t || new URL(startUrl).hostname.replace(/^(?:www|careers|jobs)\./, '').split('.')[0]; rest = ''; }
  if (!company && forceKind === 'company' && t) { company = t; rest = ''; }
  const kw = clean([rest, kw0].filter(Boolean).join(', '), 300);
  const kind = company ? 'company' : 'field';
  // A field search runs every title it was given: "welder" + "fabricator, pipe welder" = 3 searches each.
  const field = kind === 'field' ? clean(t || kw0.split(/\s*,\s*/)[0], 120) : null;
  const seenT = new Set();
  const titles = kind === 'field' ? [field, ...kw0.split(/\s*,\s*/)].map((x) => clean(x, 80)).filter((x) => x && !seenT.has(x.toLowerCase()) && seenT.add(x.toLowerCase())).slice(0, 6) : [];
  let methods = Object.keys(METHODS).filter((m) => METHODS[m].kinds.includes(kind));
  if (Array.isArray(only) && only.length) methods = methods.filter((m) => only.includes(m));
  const where = cleanLocations(locations) || (kind === 'company' ? ['United States'] : ['United States', 'Remote']);
  return { kind, company, keywords: kind === 'company' ? kw : '', field, titles, locations: where, url: startUrl, website: clean(website, 200) || null, methods };
}

export function createSearch({ manager, dir = () => join(dataDir(), 'aggregation'), now = () => new Date(), notify = () => {}, fetchImpl = fetch, env = () => process.env, seenBase = () => 'https://seenjobs.io', remember = null } = {}) {
  const file = () => { const d = dir(); mkdirSync(d, { recursive: true }); return join(d, 'searches.json'); };
  const read = () => { try { const v = JSON.parse(readFileSync(file(), 'utf8')); return Array.isArray(v) ? v : []; } catch { return []; } };
  const write = (list) => { const f = file(); const tmp = `${f}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`; writeFileSync(tmp, JSON.stringify(list.slice(0, 300)), { mode: 0o600 }); renameSync(tmp, f); };
  const save = (rec) => { const list = read().filter((x) => x.id !== rec.id); write([rec, ...list]); return rec; };
  const patchStep = (id, method, patch) => { const list = read(); const rec = list.find((x) => x.id === id); if (!rec) return null; const st = rec.steps.find((s) => s.method === method); if (st) Object.assign(st, patch); write(list); return rec; };

  function labelOf(rec) {
    if (rec.kind === 'preset') return rec.label;
    if (rec.kind === 'company') return `${rec.company}${rec.keywords ? ` · ${rec.keywords}` : ''}`;
    const more = (rec.titles || []).length > 1 ? ` + ${rec.titles.length - 1} related title${rec.titles.length > 2 ? 's' : ''}` : '';
    return `${rec.field}${more}`;
  }

  async function start(input = {}, { origin = 'search box' } = {}) {
    if (input.preset) return startPreset(String(input.preset).slice(0, 120), { origin });
    const text = clean(input.text, 200); const url = input.url ? cleanStartUrl(input.url) : null;
    if (!text && !url) return { ok: false, code: 400, error: 'type a company, a field, or a job title' };
    if (input.url && !url) return { ok: false, code: 400, error: 'the page address must start with https://' };
    let catalog = [];
    try { const c = await manager.companyCatalog(); catalog = c?.ok ? c.companies || [] : []; } catch { /* plan as a field search */ }
    const plan = planSearch({ text, keywords: input.keywords, url, website: input.website, locations: input.locations, kind: input.kind === 'company' ? 'company' : null }, catalog, { only: input.methods || input.only || null });
    if (!plan.methods.length) return { ok: false, code: 400, error: 'none of the chosen methods fit this search' };
    const at = now();
    const rec = { id: `search-${at.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomBytes(2).toString('hex')}`, at: at.toISOString(), origin,
      input: { text, keywords: clean(input.keywords, 300), url }, kind: plan.kind, company: plan.company, keywords: plan.keywords, field: plan.field, titles: plan.titles, locations: plan.locations,
      ...(input.why ? { why: clean(input.why, 300) } : {}),
      status: 'running', steps: plan.methods.map((m) => ({ method: m, label: METHODS[m].label, status: 'starting', runId: null, result: null, error: null })), endedAt: null, notified: false };
    rec.label = labelOf(rec);
    save(rec);
    const kws = plan.keywords ? plan.keywords.split(/\s*,\s*/).filter(Boolean) : [];
    const runStep = async (method, startFn) => {
      try { const r = await startFn(); if (r && r.ok === false) patchStep(rec.id, method, { status: 'not started', error: r.error || 'not started', blockers: r.blockers || null }); else if (r && r.run) patchStep(rec.id, method, { status: r.run.status, runId: r.run.id }); }
      catch (e) { patchStep(rec.id, method, { status: 'not started', error: String(e.message || e).slice(0, 200) }); }
    };
    const startRun = (pipeline, overrides) => manager.startRun({ pipeline, overrides, trigger: 'manual', owner: 'search', confirmLarge: true, searchId: rec.id });
    const caps = (p) => { try { return (manager.collectors().find((c) => c.id === p) || {}).capabilities || {}; } catch { return {}; } };
    const steps = [];
    for (const m of plan.methods) {
      if (m === 'career_site') steps.push(runStep(m, () => startRun('career_site', { targets: [{ company: plan.company, ...(plan.url ? { url: plan.url } : {}), ...(plan.keywords ? { keywords: plan.keywords } : {}), ...(plan.website ? { website: plan.website } : {}) }], maxJobs: caps('career_site').maxJobsMax || 5000 })));
      if (m === 'indeed') {
        const ic = caps('indeed');
        const queries = plan.kind === 'company' ? (kws.length ? kws.map((k) => `${k} ${plan.company}`) : [plan.company]) : plan.titles;
        const locations = plan.locations;
        const searches = queries.flatMap((q) => locations.map((location) => ({ query: q, location })));
        steps.push(runStep(m, () => startRun('indeed', { searches, resultsPerSearch: ic.resultsPerSearchMax || 25, maxPages: Math.min(ic.maxPagesMax || 1, 10), maxSearches: null })));
      }
      if (m === 'applicant_reports') steps.push(runStep(m, () => startRun('applicant_reports', { mode: 'import', companies: [plan.company], goal: 0, minutesPerCompany: 30 })));
      if (m === 'company_intel') steps.push(runStep(m, () => startRun('company_intel', { mode: 'import', companies: [plan.company], companyLimit: 1 })));
      if (m === 'seen_pull') steps.push((async () => {
        patchStep(rec.id, m, { status: 'running' });
        try {
          const r = await manager.pullCompanyJobsDirect({ companies: [plan.company], ...(plan.website ? { websites: { [plan.company]: plan.website } } : {}) });
          const sum = r?.ok ? r : null;
          patchStep(rec.id, m, { status: r?.ok ? 'completed' : 'failed', error: r?.ok ? null : (r?.error || 'failed'), result: sum ? { saved: sum.saved ?? sum.totals?.saved ?? null, boards: sum.boardsFound ?? null, needsBrowser: (sum.needsBrowser || []).length } : null });
        } catch (e) { patchStep(rec.id, m, { status: 'failed', error: String(e.message || e).slice(0, 200) }); }
        settle(rec.id);
      })());
      if (m === 'seen_sources') steps.push((async () => {
        patchStep(rec.id, m, { status: 'running' });
        try {
          // One Seen search per title (Seen pulls the field into its corpus as it answers).
          let matched = 0; let okCount = 0; let lastErr = null;
          for (const q of plan.titles) {
            const r = await fetchImpl(`${seenBase()}/api/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: q, location: '' }), signal: AbortSignal.timeout(60000) });
            const b = await r.json().catch(() => ({}));
            if (r.ok) { okCount++; matched += Array.isArray(b.jobs) ? b.jobs.length : Array.isArray(b.results) ? b.results.length : 0; } else lastErr = b.error || `HTTP ${r.status}`;
          }
          patchStep(rec.id, m, { status: okCount === plan.titles.length ? 'completed' : okCount ? 'partial' : 'failed', error: okCount ? null : lastErr, result: okCount ? { matched, note: 'Seen keeps pulling new listings for this field in the background' } : null });
        } catch (e) { patchStep(rec.id, m, { status: 'failed', error: String(e.message || e).slice(0, 200) }); }
        settle(rec.id);
      })());
    }
    await Promise.all(steps.map((p) => Promise.race([p, new Promise((r) => setTimeout(r, 5000))]))); // collectors are queued by now
    settle(rec.id);
    return { ok: true, search: get(rec.id) };
  }

  // Live state: each run step reads its run; the search ends when every step has.
  function get(id) {
    const rec = read().find((x) => x.id === id); if (!rec) return null;
    for (const s of rec.steps) {
      if (!s.runId) continue;
      const run = manager.getRun(s.runId);
      if (run) { s.status = run.status; s.result = run.metrics || null; s.reason = run.reason || null; s.attempt = run.attempt || 1; s.endedAt = run.endedAt || null; }
    }
    const done = rec.steps.every((s) => TERMINAL.has(s.status) || s.status === 'not started');
    if (done && rec.status === 'running') rec.status = rec.steps.some((s) => s.status === 'completed' || s.status === 'partial') ? (rec.steps.every((s) => s.status === 'completed') ? 'completed' : 'partial') : 'failed';
    return rec;
  }
  function list({ limit = 50 } = {}) { return read().slice(0, limit).map((r) => get(r.id) || r); }

  function stepLine(s) {
    const r = s.result || {};
    const n = r.saved ?? r.written ?? r.newReports ?? r.importedReports ?? r.matched ?? null;
    const what = s.method === 'applicant_reports' || s.method === 'company_intel' ? 'reports' : 'jobs';
    return `${s.label}: ${s.status === 'not started' ? `not started (${s.error})` : `${s.status}${n != null ? `, ${n} ${what}` : ''}`}`;
  }
  // Called when any run ends (and after the HTTP steps): one notification when the whole search is done.
  function settle(id) {
    const rec = get(id); if (!rec || rec.status === 'running' || rec.notified) return rec;
    const list = read(); const stored = list.find((x) => x.id === id);
    Object.assign(stored, { status: rec.status, steps: rec.steps, endedAt: now().toISOString(), notified: true }); write(list);
    // The brain gets the outcome too (one timeline entry per search, on the California day), so the next
    // board meeting and any Claude session can see what was collected without reading this app's files.
    try { if (remember) remember({ date: new Date(now()).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }), heading: `Search: ${rec.label} (${rec.kind}) — ${rec.status}`, text: `${rec.steps.map(stepLine).join('\n')}\nStarted from the ${rec.origin}. search-id ${rec.id}`, key: `search-id ${rec.id}` }); } catch { /* the brain is best-effort */ }
    try { notify({ kind: 'search', level: rec.status === 'completed' ? 'success' : rec.status === 'partial' ? 'warning' : 'error', title: `Search “${rec.label}” ${rec.status === 'completed' ? 'finished' : rec.status === 'partial' ? 'finished partly' : 'failed'}`, body: rec.steps.map(stepLine).join(' · '), tab: 'search', ref: id }); } catch { /* never fails a search */ }
    return stored;
  }
  function onRunEnd(run) { if (run && run.searchId) settle(run.searchId); }
  // ---- presets (owner, 2026-10-21: "do not sacrifice the search presets") ----------------------------
  // Every preset set the Indeed tab offered (this week's maintenance, what people searched on Seen, thin
  // coverage, each niche, the owner's saved sets) plus the everyday quick starts, as one-tap searches that
  // get the same record, history row and notification as a typed search.
  async function presets() {
    const out = [];
    let p = null; try { p = await manager.indeedPresets(); } catch { /* listed as unavailable */ }
    const jobs = (key, group, title, sub, searches) => (searches || []).length ? out.push({ key, group, title, sub, kind: 'jobs', count: searches.length, searches }) : null;
    if (p && p.ok) {
      jobs('maintenance', 'This week', 'This week’s maintenance', `${p.maintenance.searches.length} searches · every niche${p.maintenance.week ? ` · week ${p.maintenance.week}` : ''}`, p.maintenance.searches);
      jobs('demand', 'From Seen', 'What people searched on Seen', `${(p.demand.searches || []).length} searches people ran 2+ times`, p.demand.searches);
      jobs('thin', 'From Seen', 'Thin coverage', `${(p.thin.searches || []).length} searches that found under ${p.thin.belowResults || 10} results`, p.thin.searches);
      for (const n of p.niches || []) jobs(`niche:${n.id}`, 'Niches', n.label, `${n.searches.length} searches`, n.searches);
    }
    try { for (const sv of manager.getConfig().pipelines.indeed.config.presets || []) jobs(`saved:${sv.name}`, 'Your sets', sv.name, `${sv.searches.length} searches · saved by you`, sv.searches); } catch { /* none saved */ }
    out.push({ key: 'reports:thinnest', group: 'Quick starts', title: 'Fill the 25 thinnest companies to 10 reports', sub: 'free Reddit archive · no Chrome', kind: 'reports' });
    out.push({ key: 'boards:stalest', group: 'Quick starts', title: 'Pull 200 employer job boards now', sub: 'Greenhouse · Lever · Ashby · …', kind: 'boards' });
    return { ok: true, presetsError: p && !p.ok ? p.error : null, presets: out };
  }
  async function startPreset(key, { origin }) {
    const list = (await presets()).presets; const pr = list.find((x) => x.key === key);
    if (!pr) return { ok: false, code: 404, error: 'that preset is not available right now' };
    const at = now();
    const steps = pr.kind === 'jobs' ? [{ method: 'indeed', label: 'Indeed' }, { method: 'seen_sources', label: "Seen's job sources" }]
      : pr.kind === 'reports' ? [{ method: 'applicant_reports', label: 'Applicant reports' }] : [{ method: 'boards', label: 'Employer job boards' }];
    const rec = { id: `search-${at.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomBytes(2).toString('hex')}`, at: at.toISOString(), origin, input: { preset: key }, kind: 'preset', preset: key,
      label: pr.title, status: 'running', steps: steps.map((x) => ({ ...x, status: 'starting', runId: null, result: null, error: null })), endedAt: null, notified: false };
    save(rec);
    const startRun = (pipeline, overrides) => manager.startRun({ pipeline, overrides, trigger: 'manual', owner: 'search', confirmLarge: true, searchId: rec.id });
    const put = (m, r) => { if (r && r.ok === false) patchStep(rec.id, m, { status: 'not started', error: r.error || 'not started' }); else if (r && r.run) patchStep(rec.id, m, { status: r.run.status, runId: r.run.id }); };
    try {
      if (pr.kind === 'jobs') {
        const ic = (manager.collectors().find((c) => c.id === 'indeed') || {}).capabilities || {};
        put('indeed', await startRun('indeed', { searches: pr.searches.map((x) => ({ query: x.query, location: x.location || 'Remote' })), resultsPerSearch: ic.resultsPerSearchMax || 25, maxPages: Math.min(ic.maxPagesMax || 1, 3), maxSearches: null }));
        // Seen's own sources for every distinct query in the set (bounded; Seen keeps pulling in the background).
        patchStep(rec.id, 'seen_sources', { status: 'running' });
        const queries = [...new Set(pr.searches.map((x) => String(x.query || '').trim().toLowerCase()).filter(Boolean))].slice(0, 40);
        let matched = 0, failed = 0;
        for (const q of queries) {
          try { const r = await fetchImpl(`${seenBase()}/api/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: q, location: '' }), signal: AbortSignal.timeout(60000) });
            const b = await r.json().catch(() => ({})); if (!r.ok) failed++; else matched += Array.isArray(b.jobs) ? b.jobs.length : 0; } catch { failed++; }
        }
        patchStep(rec.id, 'seen_sources', { status: failed === queries.length && queries.length ? 'failed' : failed ? 'partial' : 'completed', result: { matched, queries: queries.length }, error: failed ? `${failed} of ${queries.length} searches failed` : null });
      } else if (pr.kind === 'reports') put('applicant_reports', await startRun('applicant_reports', { mode: 'import', companies: [], fillBelow: 10, companyLimit: 25, goal: 10 }));
      else {
        patchStep(rec.id, 'boards', { status: 'running' });
        const r = await manager.pullBoards({ limit: 200 });
        patchStep(rec.id, 'boards', { status: r && r.ok ? 'completed' : 'failed', error: r && r.ok ? null : (r && r.error) || 'failed', result: r && r.ok ? { saved: r.saved, boards: r.boards } : null });
      }
    } catch (e) { patchStep(rec.id, steps[0].method, { status: 'not started', error: String(e.message || e).slice(0, 200) }); }
    settle(rec.id);
    return { ok: true, search: get(rec.id) };
  }

  // What the box would do with this text (the live preview under the search field). Uses the cached catalog.
  async function preview(input = {}) {
    let catalog = [];
    try { const c = await manager.companyCatalog(); catalog = c?.ok ? c.companies || [] : []; } catch { /* field */ }
    const plan = planSearch({ text: input.text, keywords: input.keywords, url: input.url }, catalog);
    return { ...plan, labels: plan.methods.map((m) => METHODS[m].label), catalogReady: catalog.length > 0 };
  }
  // Seen's companies (for the Board Room planner's "is this already on Seen?" hint). [] when unreadable.
  async function catalog() { try { const c = await manager.companyCatalog(); return c?.ok ? c.companies || [] : []; } catch { return []; } }
  return { start, get, list, settle, onRunEnd, preview, presets, catalog, planSearch: (i, c) => planSearch(i, c) };
}
