// The Board Room's search planner (owner, 2026-10-21: "I will only use the chatbot if it works better than I
// can and faster … it can use the search tool like a pro with better search parameters and better filters
// … this includes jobs and reports"). A chat request that IS a search ("aggregate nasa jobs", "find welders
// in Texas", "reports on Home Depot") is first read by the fast parser (engine/search.mjs), then this
// planner asks the model ONCE to turn it into the search an expert recruiter would run:
//
//   company or field?   NASA → an employer (its jobs are on USAJOBS / its careers site), "welder" → a field
//   which titles?       welder → welder, fabricator, pipe welder, MIG welder, structural welder
//   which places?       "in Texas" → Texas; a field defaults to the US + remote
//   careers page?       only when the model is confident of the real https address
//   which methods?      reports-only requests run applicant reports + company intel, never job pulls
//
// Every model answer is CHECKED (lengths, https, known methods for the kind, at most 6 titles / 5 places);
// anything that fails a check falls back to the parser's plan, and a model that is slow or down never
// blocks the search — the parser's plan runs. The reply says what was chosen and why.
import { METHODS, cleanLocations } from './search.mjs';
import { cleanStartUrl } from '../lib/aggregation/career-site.mjs';

const clean = (s, n = 120) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const ok = (s) => /^[\p{L}\p{N}][\p{L}\p{N} .,&'()+#/-]{0,79}$/u.test(s);

export const PLANNER_SYSTEM = `You plan job and applicant-report searches for Seen (seenjobs.io), a US job-search site that grades employers on how they treat applicants.
Turn the owner's request into the search an expert recruiter would run. Answer with ONE JSON object and nothing else:
{"target":"company"|"field","company":"<employer's common name, if target=company>","field":"<main job title or niche, if target=field>","titles":["<related titles to also search, 0-5>"],"locations":["<US places, 0-5>"],"careers_url":"<https careers page, only if you are sure, else empty>","methods":[<subset of the allowed methods, or empty for all>],"why":"<one sentence>"}
Rules:
- target=company when the request names an employer or agency (Acme, NASA, Home Depot, Insight Global); target=field for a job, trade or niche (welder, nurse, tech, warehouse).
- For a company, "titles" are the roles asked for (e.g. technician, service advisor) — none if the request asks for all jobs.
- For a field, "titles" are close synonyms and specialties a recruiter would also search; never unrelated jobs.
- "locations": only places the owner asked for; empty means the default (US + remote for a field, US for a company).
- "methods": if the request is only about applicant reports / reviews / ghosting, use ["applicant_reports","company_intel"]; if only about jobs, leave out those two; otherwise empty.
- Never invent a careers URL. Never add places or roles the owner did not imply.`;

function catalogHint(text, catalog = []) {
  const words = clean(text).toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
  if (!words.length) return '';
  const hits = [];
  for (const c of catalog) {
    const n = String(c?.company || '').toLowerCase();
    if (n && words.some((w) => n.includes(w))) hits.push(`${c.company} (${c.active_listings || 0} open listings)`);
    if (hits.length >= 8) break;
  }
  return hits.length ? `Companies already on Seen that may match: ${hits.join('; ')}.` : 'No company on Seen matches these words yet.';
}

// Check one model answer. Returns { input, why } for searchService().start, or null when it is unusable.
export function checkPlan(raw, parsed = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const target = raw.target === 'company' ? 'company' : raw.target === 'field' ? 'field' : null;
  if (!target) return null;
  const head = clean(target === 'company' ? raw.company : raw.field, 80);
  if (!head || !ok(head)) return null;
  const titles = (Array.isArray(raw.titles) ? raw.titles : []).map((t) => clean(t, 400)).filter((t) => t.length <= 60).filter((t) => t && ok(t) && t.toLowerCase() !== head.toLowerCase()).slice(0, 5);
  const locations = cleanLocations(Array.isArray(raw.locations) ? raw.locations : []);
  let url = parsed.url || null;
  if (!url && target === 'company' && raw.careers_url) url = cleanStartUrl(String(raw.careers_url)) || null;
  const allowed = Object.keys(METHODS).filter((m) => METHODS[m].kinds.includes(target));
  let methods = (Array.isArray(raw.methods) ? raw.methods : []).filter((m) => allowed.includes(m));
  if (Array.isArray(parsed.only) && parsed.only.length) methods = parsed.only.filter((m) => allowed.includes(m)); // the owner's own words win
  // A company search is planned by its name alone (the catalog match in planSearch decides "company"), so
  // roles ride as keywords; a field search's titles become the extra queries.
  const input = { text: head, keywords: titles.join(', '), url, locations, kind: target, methods: methods.length ? methods : null, why: clean(raw.why, 240) || null };
  return { input, target };
}

// Plan one request. `reasonFn` is lib/llm.mjs reason(); `catalog` is Seen's companies. Never throws.
export async function planChatSearch(message, parsed, { catalog = [], reasonFn, timeoutMs = 20000 } = {}) {
  const fallback = { input: { text: parsed.text, keywords: parsed.keywords, url: parsed.url, methods: parsed.only }, planned: false, why: null };
  if (!reasonFn) return fallback;
  const prompt = `Owner's request: "${clean(message, 400)}"\nFast parser read it as: text="${clean(parsed.text)}", keywords="${clean(parsed.keywords)}"${parsed.url ? `, careers page ${parsed.url}` : ''}.\n${catalogHint(parsed.text, catalog)}\nAllowed methods: company → ${Object.keys(METHODS).filter((m) => METHODS[m].kinds.includes('company')).join(', ')}; field → ${Object.keys(METHODS).filter((m) => METHODS[m].kinds.includes('field')).join(', ')}.`;
  let text = '';
  try {
    const r = await Promise.race([reasonFn({ deptId: 'command', system: PLANNER_SYSTEM, prompt, maxTokens: 320, timeoutMs }), new Promise((res) => setTimeout(() => res({ text: '' }), timeoutMs + 2000))]);
    text = String(r?.text || '');
  } catch { return fallback; }
  let raw = null;
  try { const m = text.match(/\{[\s\S]*\}/); raw = m ? JSON.parse(m[0]) : null; } catch { raw = null; }
  const checked = checkPlan(raw, parsed);
  if (!checked) return fallback;
  return { input: checked.input, planned: true, why: checked.input.why, target: checked.target };
}
