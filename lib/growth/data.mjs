// Real numbers for content: Seen's public leaderboard (the same rows /agencies and /companies read —
// only companies that pass the grade gate, ≥5 first-party reports) turned into citable callouts, each with
// its sample size, confidence label and the page to link. Cached for an hour in data/growth/data-cache.json.
// When Seen cannot be reached, callouts are [] and every consumer says "no data" — nothing is filled in.
import { config } from '../config.mjs';
import { readDoc, writeDoc } from './store.mjs';
import { ptToday } from './pt.mjs';

// The staffing agencies the Ghost Index tracks (seen repo lib/agencies.ts names + aliases).
export const AGENCIES = {
  'robert half': 'Robert Half', 'robert half international': 'Robert Half', 'kelly services': 'Kelly Services', randstad: 'Randstad', 'randstad usa': 'Randstad',
  manpowergroup: 'ManpowerGroup', manpower: 'ManpowerGroup', adecco: 'Adecco', aerotek: 'Aerotek', 'insight global': 'Insight Global', teksystems: 'TEKsystems',
  'tek systems': 'TEKsystems', 'apex systems': 'Apex Systems', 'express employment professionals': 'Express Employment Professionals', 'express employment': 'Express Employment Professionals',
  peopleready: 'PeopleReady', 'people ready': 'PeopleReady', staffmark: 'Staffmark', spherion: 'Spherion', kforce: 'Kforce', 'aston carter': 'Aston Carter',
  'beacon hill staffing': 'Beacon Hill Staffing', collabera: 'Collabera', cybercoders: 'CyberCoders', 'the judge group': 'The Judge Group', 'judge group': 'The Judge Group',
  'motion recruitment': 'Motion Recruitment', hays: 'Hays', 'michael page': 'Michael Page', 'addison group': 'Addison Group', 'lasalle network': 'LaSalle Network',
  'volt workforce solutions': 'Volt Workforce Solutions', 'integrity staffing solutions': 'Integrity Staffing Solutions', 'integrity staffing': 'Integrity Staffing Solutions',
};

/** Seen's one slug scheme (seen CLAUDE.md "Company slugs"). */
export const companySlug = (name) => encodeURIComponent(String(name).toLowerCase().replace(/\s+/g, '-'));
export const companyUrl = (base, name) => `${base}/company/${companySlug(name)}`;
const titleCase = (s) => String(s).replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\bAnd\b/g, 'and');
export const displayName = (name) => AGENCIES[String(name).toLowerCase()] || titleCase(name);

/** SEEN_STRATEGY.md company confidence model. */
export function confidenceLabel(n) {
  const x = Number(n) || 0;
  if (x < 5) return 'Not enough data';
  if (x < 20) return 'Low confidence';
  if (x < 100) return 'Moderate confidence';
  if (x < 1000) return 'Good confidence';
  return 'High confidence';
}

/** A leaderboard row → a callout, or null if it lacks what a public number needs. */
export function calloutFrom(row, { base = config.seenBaseUrl(), asOf = ptToday() } = {}) {
  const s = row?.score || {}; const n = Number(s.first_party_report_count) || 0;
  if (!row?.name || n < 5 || !Number.isFinite(s.ghost_rate) || !Number.isFinite(s.response_rate)) return null;
  const name = displayName(row.name); const isAgency = !!AGENCIES[String(row.name).toLowerCase()];
  const ghostPct = Math.round(s.ghost_rate * 100); const responsePct = Math.round(s.response_rate * 100);
  return { name, isAgency, reports: n, ghostPct, responsePct, score: Number.isFinite(s.overall_score) ? s.overall_score : null, confidence: confidenceLabel(n),
    url: isAgency ? `${base}/agencies` : companyUrl(base, row.name), pageUrl: companyUrl(base, row.name),
    line: `${name}: ${ghostPct}% ghost rate across ${n} applicant reports`, sourceLine: `seenjobs.io · ${n} applicant reports, trust-weighted · ${confidenceLabel(n).toLowerCase()} · as of ${asOf} PT`, asOf };
}

const TTL_MS = 60 * 60 * 1000;
/** The leaderboard rows, cached for an hour. `fetchImpl` is injectable for tests. Never throws. */
export async function leaderboard({ fetchImpl = fetch, now = Date.now(), force = false } = {}) {
  const cache = readDoc('data-cache', {});
  if (!force && cache.at && now - cache.at < TTL_MS && Array.isArray(cache.rows)) return { ok: true, rows: cache.rows, at: cache.at, cached: true };
  try {
    const r = await fetchImpl(`${config.seenBaseUrl()}/api/reports`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'leaderboard' }), signal: AbortSignal.timeout(20_000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !Array.isArray(j.companies)) throw new Error(`leaderboard → HTTP ${r.status}`);
    writeDoc('data-cache', { at: now, rows: j.companies });
    return { ok: true, rows: j.companies, at: now, cached: false };
  } catch (e) {
    if (Array.isArray(cache.rows)) return { ok: true, rows: cache.rows, at: cache.at, cached: true, stale: true, error: e.message };
    return { ok: false, rows: [], error: e.message };
  }
}

/** Citable callouts: agencies (most reports first) and the most-reported companies. */
export async function callouts(opts = {}) {
  const lb = await leaderboard(opts);
  const asOf = ptToday(new Date(lb.at || Date.now()));
  const all = lb.rows.map((r) => calloutFrom(r, { asOf })).filter(Boolean);
  const agencies = all.filter((c) => c.isAgency).sort((a, b) => b.reports - a.reports);
  const companies = all.filter((c) => !c.isAgency).sort((a, b) => b.reports - a.reports);
  return { ok: lb.ok, error: lb.error || null, stale: !!lb.stale, asOf, agencies, companies,
    mostResponsive: [...companies].filter((c) => c.reports >= 20).sort((a, b) => b.responsePct - a.responsePct).slice(0, 5),
    mostGhosting: [...all].filter((c) => c.reports >= 5).sort((a, b) => b.ghostPct - a.ghostPct).slice(0, 5) };
}
