// Creator DISCOVERY — "who should we research, and who would want to cite Seen's data?"
//
// Given a goal ("career coaches whose audience gets ghosted by staffing agencies"), this searches the
// public web from the owner's own Chrome through OpenCLI (the same Browser Bridge Seen's collectors use)
// and ranks the Instagram creators it finds into two lists, each with its reasons:
//   • LEARN from  — creators whose content craft / reach in the job-search niche is worth studying;
//   • AUDIENCE fit — creators whose audience Seen genuinely serves and who would WANT to cite Seen's
//     data, each matched to the Seen asset and story angle that fits (the Weekly Ghost Report, the
//     Staffing Agency Ghost Index, employer grades, the "been ghosted?" page, listing signals, …).
// A second, offline source always runs: creators that the already-researched creators tag or mention.
//
// It PREPARES only. It never opens instagram.com in the owner's browser (that would use his logged-in
// session — research stays anonymous), never logs in, never messages, follows or posts. Only Google
// result pages are read. A CAPTCHA / "unusual traffic" page STOPS the search for the run — never solved.
// Without OpenCLI it degrades honestly: the mention source plus the exact queries to run by hand.
//
// Every number in a reason is read off the page (a follower count Google printed, a phrase in the
// snippet); nothing is invented. Rankings are rule-based and explained. Tests: discovery.test.mjs.

import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { config } from '../config.mjs';
import { dataDir } from '../paths.mjs';
import { normalizeUsername } from './adapter.mjs';

// ---- Seen's assets: what a creator could cite or point their audience to --------------------------
// Each is a live public page on seenjobs.io (app/<route>/page.tsx in the Seen repo).
export const SEEN_ANGLES = [
  { key: 'ghost_report', asset: 'The Weekly Ghost Report', url: 'https://seenjobs.io/ghost-report',
    re: /\b(data|stats?|statistics|reports?|numbers|surveys?|research|news|commentary|breakdowns?|analysis)\b/,
    story: 'a weekly, sourced ranking of the most-reported ghosters and the companies that actually reply — numbers they can quote on camera' },
  { key: 'agency_index', asset: 'Staffing Agency Ghost Index', url: 'https://seenjobs.io/agencies',
    re: /\b(staffing|recruit(er|ers|ing) agenc(y|ies)|temp agenc(y|ies)|headhunt\w*|third.party recruit\w*|contract roles?|agency recruiters?)\b/,
    story: 'which staffing agencies ghost applicants most, ranked from applicant reports' },
  { key: 'employer_grades', asset: 'Employer grades (ghosting & response rates)', url: 'https://seenjobs.io/companies',
    re: /\b(ghost(ed|ing)|never heard back|no response|hiring process|employers?|companies|red flags?|toxic (job|workplace)s?|interview process)\b/,
    story: "look up any employer's ghosting / response grade before applying" },
  { key: 'been_ghosted', asset: '"Been ghosted? Make it count" report page', url: 'https://seenjobs.io/ghosted',
    re: /\b(ghosted|recruitinghell|rejected|rejection|job hunt(ing)? (is|sucks|struggle)|storytime|horror stor(y|ies)|vent)\b/,
    story: 'an anonymous 2-minute report that turns their audience\'s ghosting story into a data point' },
  { key: 'listing_signals', asset: 'Listing signals (pay shown, apply direct, stale posts)', url: 'https://seenjobs.io/jobs',
    re: /\b(salary|pay (range|transparency)|fake jobs?|ghost jobs?|scam\w*|reposted|job postings?|job boards?|easy apply)\b/,
    story: 'which job posts hide pay or sit open for months (ghost jobs)' },
  { key: 'resume_studio', asset: 'Résumé Studio (free ATS check + tailoring)', url: 'https://seenjobs.io/resume',
    re: /\b(resumes?|résumés?|cv|ats|cover letters?|applicant tracking)\b/,
    story: 'a free ATS check and tailoring tied to real listings' },
  { key: 'tracker', asset: 'Application tracker with check-ins', url: 'https://seenjobs.io/tracker',
    re: /\b(applied to \d+|\d+ applications|tracking (my )?applications|job search (journey|update|diary)|day \d+ of (my )?job)\b/,
    story: 'track every application; Seen tells them who usually ghosts' },
];

const JOB_AUDIENCE = /\b(job (search|seekers?|hunt\w*|tips|offers?)|career (coach\w*|advice|tips|change|growth)|recruit(er|ers|ing)|hiring (manager|tips)|interview (tips|prep|coach)|resumes?|résumés?|linkedin|laid off|layoffs?|unemploy\w*|ghost(ed|ing)|staffing|new grads?|entry.level|recruitinghell|corporate|9.?to.?5|salary negotiation|get hired)\b/;
const CRAFT = /\b(content creator|creator|reels?|viral|hooks?|storytell\w*|educator|ugc|podcast|newsletter|skits?|comedy|memes?|series|weekly videos?|new videos?)\b/;
const CITES_DATA = /\b(data|stats?|statistics|report|numbers|research|survey|news|commentary|breakdown|study|analysis)\b/;
// Platform / company accounts are not creators.
const NOT_CREATORS = new Set(['indeed', 'linkedin', 'glassdoor', 'ziprecruiter', 'monster', 'handshake', 'careerbuilder', 'instagram', 'meta', 'seenjobs', 'seen.jobs', 'google', 'microsoft', 'amazon', 'forbes', 'cnbc', 'businessinsider', 'wsj', 'nytimes']);
const RESERVED_PATHS = new Set(['p', 'reel', 'reels', 'explore', 'stories', 'tv', 'accounts', 'about', 'developer', 'legal', 'directory', 'web', 'tags', 'locations', 'popular']);

// ---- queries -----------------------------------------------------------------------------------
// Google, restricted to instagram.com. The goal's own words lead; fixed niche queries fill the two lists.
export function discoveryQueries(goal, { max = 6 } = {}) {
  const g = String(goal || '').replace(/["\n\r]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  const qs = [];
  if (g) qs.push(`site:instagram.com ${g}`);
  qs.push('site:instagram.com career coach "job search" tips reels');
  qs.push('site:instagram.com recruiter "ghosted" job seekers');
  qs.push('site:instagram.com "staffing agency" OR "recruiting agency" job seekers');
  qs.push('site:instagram.com "laid off" "job search" creator');
  if (g) qs.push(`site:instagram.com ${g} hooks reels`);
  qs.push('site:instagram.com "hiring manager" interview tips creator');
  return [...new Set(qs)].slice(0, Math.max(1, Math.min(10, max)));
}
export const googleUrl = (q) => `https://www.google.com/search?${new URLSearchParams({ q, hl: 'en', num: '20' })}`;

// In-page (serialized into Chrome by OpenCLI eval): result links + their snippet text, or {blocked}.
export function googleResultsWithSnippets() {
  const text = (document.body && document.body.innerText) || '';
  if (/\/sorry\//.test(location.pathname) || /unusual traffic|not a robot|recaptcha/i.test(text.slice(0, 4000))
    || document.querySelector('form#captcha-form, #recaptcha, iframe[src*="recaptcha"]')) return JSON.stringify({ blocked: true, url: location.href });
  const root = document.querySelector('#search') || document.querySelector('#rso') || document.body;
  const out = []; const seen = new Set();
  for (const h3 of root.querySelectorAll('a h3')) {
    const a = h3.closest('a'); if (!a) continue;
    let url = a.href;
    try { const u = new URL(url); if (/^(?:www\.)?google\./.test(u.hostname) && u.pathname === '/url') url = u.searchParams.get('q') || u.searchParams.get('url') || url; } catch (e) { continue; }
    if (!/^https?:/.test(url) || seen.has(url)) continue;
    seen.add(url);
    const box = a.closest('div.g, div.MjjYud, div[data-hveid], div[data-sokoban-container]') || a.parentElement;
    const title = String(h3.innerText || '').trim();
    let snippet = String((box && box.innerText) || '').replace(/\s+/g, ' ').trim();
    if (title && snippet.startsWith(title)) snippet = snippet.slice(title.length).trim();
    out.push({ url, title: title.slice(0, 200), snippet: snippet.slice(0, 500) });
  }
  return JSON.stringify({ blocked: false, results: out.slice(0, 30) });
}
export const GOOGLE_JS = `(${googleResultsWithSnippets.toString()})()`;

// ---- parsing -----------------------------------------------------------------------------------
export function handleFromResult({ url, title = '' } = {}) {
  let u; try { u = new URL(url); } catch { return null; }
  if (!/(^|\.)instagram\.com$/i.test(u.hostname)) return null;
  const seg = u.pathname.split('/').filter(Boolean);
  let h = seg[0] && !RESERVED_PATHS.has(seg[0].toLowerCase()) ? seg[0] : null;
  if (!h) { const m = /\(@([A-Za-z0-9._]{1,30})\)/.exec(title) || /@([A-Za-z0-9._]{2,30})\b/.exec(title); h = m ? m[1] : null; }
  const clean = normalizeUsername(h || '');
  return clean ? clean.toLowerCase() : null;
}
// "12.5K Followers" / "1,204 followers" / "2M Followers" → a number, only when Google printed it.
export function followersFrom(text) {
  const m = /([\d][\d.,]*)\s*([KkMm])?\s+followers\b/i.exec(String(text || ''));
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, '')); if (!Number.isFinite(n)) return null;
  const mult = /k/i.test(m[2] || '') ? 1e3 : /m/i.test(m[2] || '') ? 1e6 : 1;
  return Math.round(n * mult);
}
const nameFrom = (title) => String(title || '').replace(/\s*[•|·-]\s*Instagram.*$/i, '').replace(/\s*\(@[^)]*\)\s*/, ' ').replace(/\s+on Instagram:.*$/i, '').trim().slice(0, 80) || null;
const words = (re, t) => [...new Set((String(t || '').toLowerCase().match(new RegExp(re.source, 'gi')) || []).map((w) => w.toLowerCase()))].slice(0, 4);

// ---- ranking -----------------------------------------------------------------------------------
// Merge results per handle, then score each list from the text Google showed. Pure.
export function rankCandidates(results = [], { exclude = new Set(), mentions = new Map() } = {}) {
  const by = new Map();
  for (const r of results) {
    const h = handleFromResult(r);
    if (!h || exclude.has(h) || NOT_CREATORS.has(h)) continue;
    const c = by.get(h) || { handle: h, name: null, url: `https://www.instagram.com/${h}/`, followers: null, texts: [], queries: new Set(), sources: new Set() };
    c.name ||= nameFrom(r.title);
    c.followers ??= followersFrom(`${r.title} ${r.snippet}`);
    c.texts.push(`${r.title} ${r.snippet}`); c.queries.add(r.query || ''); c.sources.add('google');
    by.set(h, c);
  }
  for (const [h, m] of mentions) {
    if (exclude.has(h) || NOT_CREATORS.has(h)) continue;
    const c = by.get(h) || { handle: h, name: null, url: `https://www.instagram.com/${h}/`, followers: null, texts: [], queries: new Set(), sources: new Set() };
    c.texts.push(m.excerpts.join(' ')); c.sources.add('mentioned'); c.mentionedBy = m.by; c.mentionCount = m.count;
    by.set(h, c);
  }
  const out = [];
  for (const c of by.values()) {
    const t = c.texts.join(' ').toLowerCase();
    const job = words(JOB_AUDIENCE, t); const craft = words(CRAFT, t); const data = words(CITES_DATA, t);
    // The angle that fits best = the one with the most distinct matching phrases (ties: list order).
    const angles = SEEN_ANGLES.map((a, i) => ({ a, i, n: words(a.re, t).length })).filter((x) => x.n).sort((x, y) => y.n - x.n || x.i - y.i).map((x) => x.a);
    const reach = c.followers ? Math.min(1, Math.log10(Math.max(10, c.followers)) / 6) : 0; // 1M → 1.0
    const seenIn = [...c.queries].filter(Boolean).length;
    const reasons = [];
    if (job.length) reasons.push(`talks to job seekers ("${job.join('", "')}")`);
    if (craft.length) reasons.push(`content craft signals ("${craft.join('", "')}")`);
    if (data.length) reasons.push(`already discusses data / news ("${data.join('", "')}")`);
    if (c.followers) reasons.push(`${c.followers.toLocaleString('en-US')} followers (as shown by Google)`);
    if (seenIn > 1) reasons.push(`appeared in ${seenIn} different searches`);
    if (c.mentionedBy?.length) reasons.push(`mentioned by researched creator${c.mentionedBy.length === 1 ? '' : 's'} ${c.mentionedBy.map((x) => `@${x}`).join(', ')} (${c.mentionCount}×)`);
    const learn = Number(((craft.length ? 0.35 : 0) + (job.length ? 0.3 : 0) + 0.25 * reach + Math.min(0.1, 0.05 * seenIn) + (c.mentionedBy?.length ? 0.1 : 0)).toFixed(3));
    const audience = Number(((job.length ? 0.45 : 0) + (angles.length ? 0.2 : 0) + (data.length ? 0.15 : 0) + 0.15 * reach + Math.min(0.05, 0.025 * seenIn)).toFixed(3));
    const angle = angles[0] ? { key: angles[0].key, asset: angles[0].asset, url: angles[0].url, story: angles[0].story, also: angles.slice(1, 3).map((a) => a.asset) } : null;
    out.push({ handle: c.handle, name: c.name, url: c.url, followers: c.followers, sources: [...c.sources],
      reasons, scores: { learn, audience }, angle,
      pitch: angle && job.length ? `Their audience is job seekers; ${angle.asset} (${angle.url}) gives them ${angle.story}.` : null,
      snippet: c.texts[0] ? c.texts[0].slice(0, 220) : null });
  }
  const pick = (key, min, filter) => out.filter(filter).filter((c) => c.scores[key] >= min).sort((a, b) => b.scores[key] - a.scores[key] || (b.followers || 0) - (a.followers || 0) || a.handle.localeCompare(b.handle));
  // A creator with no job-seeker signal is never put in the audience list; a learn pick needs craft or niche.
  const learn = pick('learn', 0.35, (c) => /talks to job seekers|content craft|mentioned by/.test(c.reasons.join(' '))).slice(0, 15);
  const audience = pick('audience', 0.45, (c) => /talks to job seekers/.test(c.reasons.join(' '))).slice(0, 15);
  const rest = out.filter((c) => !learn.includes(c) && !audience.includes(c)).map((c) => ({ handle: c.handle, why: c.reasons.length ? `weak fit: ${c.reasons.join('; ')}` : 'no job-seeker or content signal in what Google showed' }));
  return { learn, audience, skipped: rest.slice(0, 30) };
}

// @handles the researched creators tag / mention in captions and on-screen text (offline source).
export function mentionsFromCorpora(corpora = [], { exclude = new Set() } = {}) {
  const m = new Map();
  for (const c of corpora) {
    const own = String(c.handle || '').replace(/^@/, '').toLowerCase();
    const texts = [...(c.videos || []).map((v) => v.caption || ''), ...(c.evidence || []).filter((e) => ['caption', 'ocr'].includes(String(e.evidence_type || '').toLowerCase())).map((e) => e.content || '')];
    for (const t of texts) {
      for (const hit of String(t).matchAll(/(?:^|[\s(])@([A-Za-z0-9._]{2,30})\b/g)) {
        const h = normalizeUsername(hit[1].replace(/\.+$/, ''))?.toLowerCase();
        if (!h || h === own || exclude.has(h)) continue;
        const e = m.get(h) || { by: [], count: 0, excerpts: [] };
        if (!e.by.includes(own)) e.by.push(own);
        e.count++; if (e.excerpts.length < 3) e.excerpts.push(String(t).slice(0, 200));
        m.set(h, e);
      }
    }
  }
  return m;
}

// ---- OpenCLI (the owner's Chrome) ---------------------------------------------------------------
function opencliRun(args, { timeout = 90000 } = {}) {
  return new Promise((resolveP, reject) => {
    execFile('opencli', args, { env: { ...process.env, PATH: config.toolPath() }, timeout, maxBuffer: 20 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const tail = [stderr, stdout].map((t) => String(t || '').trim()).filter(Boolean).join(' | ').replace(/\s+/g, ' ').slice(0, 240);
        return reject(new Error(`${error.killed ? 'timed out' : String(error.message || error).split('\n')[0].slice(0, 160)}${tail ? ` — ${tail}` : ''}`));
      }
      let parsed; try { parsed = JSON.parse(stdout); } catch { return resolveP(String(stdout || '')); }
      if (parsed && parsed.ok === false) return reject(new Error(parsed?.error?.message || 'OpenCLI command failed'));
      resolveP(parsed && typeof parsed === 'object' && Object.prototype.hasOwnProperty.call(parsed, 'ok') ? parsed.data : parsed);
    });
  });
}
// OpenCLI 2.x takes the session as a flag; 1.8 as a positional. Try the flag, fall back once on a usage
// error judged from OpenCLI's ANSWER (the echoed command always contains "session"). Same rule as Seen's
// lib/server/opencliBrowser.js.
const USAGE_ERROR = /positional|unknown (?:option|command|argument)|usage:|missing required|too many arguments|unexpected argument/i;
export function openCliBrowser({ run = opencliRun, session = 'seen-creator-discovery' } = {}) {
  let form = null;
  const argsFor = (f, cmd, rest) => (f === 'positional' ? ['browser', session, cmd, ...rest] : ['browser', cmd, ...rest, '--session', session]);
  async function call(cmd, ...rest) {
    if (form) return run(argsFor(form, cmd, rest));
    try { const v = await run(argsFor('flag', cmd, rest)); form = 'flag'; return v; }
    catch (e) {
      const msg = String(e?.message || e); const answer = msg.includes(' — ') ? msg.slice(msg.indexOf(' — ') + 3) : msg;
      if (!USAGE_ERROR.test(answer)) throw e;
      const v = await run(argsFor('positional', cmd, rest)); form = 'positional'; return v;
    }
  }
  return { open: (url) => call('open', url), eval: (js) => call('eval', js), close: () => call('close') };
}
const parseEval = (v) => { if (v && typeof v === 'object' && !Array.isArray(v)) { if (typeof v.result === 'string') v = v.result; else return v; } try { return JSON.parse(String(v)); } catch { return null; } };

// ---- the run -----------------------------------------------------------------------------------
function dir() { const d = join(dataDir(), 'instagram-discovery'); mkdirSync(d, { recursive: true }); return d; }
const fileFor = (id) => join(dir(), `${id}.json`);
function save(d) { d.updatedAt = new Date().toISOString(); const tmp = `${fileFor(d.id)}.tmp`; writeFileSync(tmp, JSON.stringify(d, null, 2)); renameSync(tmp, fileFor(d.id)); return d; }
export function getDiscovery(id) { if (!/^disc-[a-z0-9-]{6,60}$/.test(String(id))) return null; try { return JSON.parse(readFileSync(fileFor(id), 'utf8')); } catch { return null; } }
export function listDiscoveries(limit = 10) {
  try { return readdirSync(dir()).filter((f) => /^disc-.*\.json$/.test(f)).map((f) => { try { return JSON.parse(readFileSync(join(dir(), f), 'utf8')); } catch { return null; } }).filter(Boolean)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, limit)
    .map((d) => ({ id: d.id, goal: d.goal, status: d.status, startedAt: d.startedAt, learn: d.learn?.length || 0, audience: d.audience?.length || 0, stoppedBy: d.stoppedBy || null })); }
  catch { return []; }
}

// Run one discovery. Everything external is injectable: `browser` ({open,eval,close}), `probe`
// (OpenCLI availability), `corpora` + `exclude` (the researched / archived handles), `sleep`.
// Create the record (so a caller gets the id at once), then executeDiscovery fills it.
export function createDiscovery({ goal, maxQueries = 6 } = {}) {
  const g = String(goal || '').trim().slice(0, 200);
  if (!g) return { ok: false, code: 400, error: 'say what to look for, e.g. discover career coaches whose audience gets ghosted by recruiters' };
  const id = `disc-${createHash('sha1').update(`${g}|${Date.now()}|${Math.random()}`).digest('hex').slice(0, 10)}`;
  return { ok: true, discovery: save({ id, goal: g, status: 'running', startedAt: new Date().toISOString(), queries: discoveryQueries(g, { max: maxQueries }),
    steps: [], learn: [], audience: [], skipped: [], stoppedBy: null, opencli: null, queued: [],
    rules: 'Prepares only: reads Google result pages in your Chrome (never instagram.com, never a login, never a DM or post). A CAPTCHA stops the search; it is never solved.' }) };
}

export async function runDiscovery({ goal, maxQueries = 6, gapMs = 6000 } = {}, deps = {}) {
  const c = createDiscovery({ goal, maxQueries });
  if (!c.ok) return c;
  return executeDiscovery(c.discovery, { gapMs }, deps);
}

export async function executeDiscovery(d, { gapMs = 6000 } = {}, deps = {}) {
  try { return await executeInner(d, { gapMs }, deps); }
  catch (e) { d.status = 'failed'; d.error = String(e.message || e).slice(0, 300); save(d); return { ok: false, error: d.error, discovery: d }; }
}

async function executeInner(d, { gapMs }, deps) {
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const exclude = deps.exclude || new Set();
  const mentions = mentionsFromCorpora(deps.corpora || [], { exclude });
  const results = [];
  let probe = { status: 'missing', detail: 'OpenCLI probe not run' };
  try { probe = deps.probe ? await deps.probe() : await (await import('../aggregation/probes.mjs')).probeOpenCli(); } catch (e) { probe = { status: 'broken', detail: e.message }; }
  d.opencli = { status: probe.status, detail: probe.detail || null, fix: probe.fix || null };
  if (probe.status === 'missing' || probe.status === 'broken') {
    d.stoppedBy = 'opencli_unavailable';
    d.steps.push({ step: 'web search', status: 'skipped', detail: `${probe.detail || 'OpenCLI unavailable'} — ${String(probe.fix || 'install OpenCLI and connect its Chrome Browser Bridge').replace(/\.+$/, '')}. Run the queries below by hand, or reconnect and discover again.` });
  } else {
    const browser = deps.browser || openCliBrowser();
    try {
      for (const [i, q] of d.queries.entries()) {
        if (i) await sleep(gapMs);
        try {
          await browser.open(googleUrl(q));
          const res = parseEval(await browser.eval(GOOGLE_JS));
          if (!res) { d.steps.push({ query: q, status: 'error', detail: 'the page could not be read' }); continue; }
          if (res.blocked) { d.stoppedBy = 'google_blocked'; d.steps.push({ query: q, status: 'blocked', detail: 'Google showed its "unusual traffic" check — search stopped (never solved). Try again later.' }); break; }
          const rs = (res.results || []).filter((r) => handleFromResult(r));
          results.push(...rs.map((r) => ({ ...r, query: q })));
          d.steps.push({ query: q, status: 'ok', results: (res.results || []).length, instagram: rs.length });
        } catch (e) {
          d.steps.push({ query: q, status: 'error', detail: String(e.message || e).slice(0, 240) });
          if (/bridge|not connected|ECONNREFUSED|extension/i.test(String(e.message))) { d.stoppedBy = 'bridge_down'; break; }
        }
        save(d);
      }
    } finally { try { await browser.close(); } catch { /* already closed */ } }
  }
  const ranked = rankCandidates(results, { exclude, mentions });
  Object.assign(d, ranked, { status: d.stoppedBy ? 'stopped' : 'done', endedAt: new Date().toISOString(),
    totals: { results: results.length, learn: ranked.learn.length, audience: ranked.audience.length, mentioned: mentions.size } });
  save(d);
  return { ok: true, discovery: d };
}

// Queue research for chosen handles from a discovery (through the research queue; capacity-limited).
export async function queueFromDiscovery(id, handles = [], { enqueue } = {}) {
  const d = getDiscovery(id); if (!d) return { ok: false, code: 404, error: 'no such discovery' };
  const all = [...(d.learn || []), ...(d.audience || [])];
  const wanted = [...new Set((Array.isArray(handles) ? handles : [handles]).map((h) => String(h || '').replace(/^@/, '').toLowerCase()).filter(Boolean))];
  if (!wanted.length) return { ok: false, code: 400, error: 'name the handles to research (from this discovery\'s lists)' };
  const out = [];
  for (const h of wanted.slice(0, 10)) {
    const c = all.find((x) => x.handle === h);
    if (!c) { out.push({ handle: h, ok: false, error: 'not in this discovery — use research <user> for anyone else' }); continue; }
    const list = (d.learn || []).some((x) => x.handle === h) ? 'learn' : 'audience';
    const r = await enqueue({ username: h, reason: `discovery ${id} (${list}): ${c.reasons.slice(0, 2).join('; ')}`, source: 'discovery' });
    out.push({ handle: h, ok: !!r.ok, started: !!r.started, queued: !!r.queued, position: r.position || null, job: r.job?.id || null, error: r.ok ? null : r.error });
  }
  d.queued = [...(d.queued || []), ...out.map((x) => ({ ...x, at: new Date().toISOString() }))];
  save(d);
  return { ok: true, results: out };
}

