// The LIVE layer for the Chronos graph — the real world, not just the vault. It pulls:
//   • Supabase product data (companies / jobs / company_scores / reports / users…) as headline nodes,
//     plus the top ghosting companies from company_scores (the Ghost Index).
//   • GitHub repo state — branches + open PRs for both repos.
// so the chart reflects reality and Seen Command can pull grounded details from Chronos before it
// builds anything. Fail-soft (no creds → empty layer) and cached, so renders/polls don't hammer APIs.
//
// Returns a graph FRAGMENT ({ nodes, links }) with ids namespaced `live:` and origin `live`, which
// unify.mjs merges into the unified graph. Fact links carry valid_from = today so the time slider
// treats live data as "true now".

const env = (k) => { const v = process.env[k]; return v && v.trim() ? v.trim() : null; };
const supaUrl = () => (env('SUPABASE_URL') || '').replace(/\/+$/, '');
const supaKey = () => env('SUPABASE_SERVICE_KEY') || env('SUPABASE_SERVICE_ROLE_KEY');
const ghToken = () => env('GITHUB_TOKEN') || env('GH_TOKEN');
const productRepo = () => env('SEEN_GITHUB_REPO') || 'begindtheseen/seen';
const commandRepo = () => env('SEEN_COMMAND_GITHUB_REPO') || 'begindtheseen/seen-command';

const LV = (id) => `live:${id}`;
const num = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));

async function fetchT(url, opts = {}, ms = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); } finally { clearTimeout(t); }
}

// ---- Supabase (product DB) -------------------------------------------------
async function supaCount(table) {
  const res = await fetchT(`${supaUrl()}/rest/v1/${table}?select=id`, {
    method: 'HEAD', headers: { apikey: supaKey(), authorization: `Bearer ${supaKey()}`, Prefer: 'count=exact', Range: '0-0' },
  });
  const cr = res.headers.get('content-range'); // "*/N" or "0-0/N"
  return cr && cr.includes('/') ? Number(cr.split('/')[1]) : null;
}
async function supaRows(pathAndQuery) {
  const res = await fetchT(`${supaUrl()}/rest/v1/${pathAndQuery}`, {
    headers: { apikey: supaKey(), authorization: `Bearer ${supaKey()}` },
  });
  if (!res.ok) return [];
  try { return await res.json(); } catch { return []; }
}

// The Ghost Index rows — top ghosting companies with real signal. Shared by the graph layer AND the
// Ghost Report deliverable (Seen Command pulls grounding from the same source Chronos shows).
export async function fetchGhostIndex(limit = 12) {
  if (!supaUrl() || !supaKey()) return [];
  try {
    return await supaRows(`company_scores?select=company_name,ghost_rate,response_rate,report_count,overall_score,avg_wait_days,industry&report_count=gte.2&order=ghost_rate.desc.nullslast&limit=${limit}`);
  } catch { return []; }
}

// Headline product tables to surface as one-glance nodes.
const TABLES = [
  ['companies', 'companies'], ['jobs', 'jobs'], ['company_scores', 'scored companies'],
  ['reports', 'ghost reports'], ['profiles', 'users'], ['applications', 'applications'],
  ['credit_transactions', 'credit txns'],
];

async function supabaseLayer() {
  if (!supaUrl() || !supaKey()) return { nodes: [], links: [], ok: false };
  const nodes = []; const links = [];
  const push = (n) => nodes.push(n);
  const fact = (s, t) => links.push({ source: s, target: t, kind: 'fact', origin: 'live', valid_from: null });

  push({ id: LV('db'), label: 'Seen DB (Supabase)', group: 'live-entity', type: 'entity', origin: 'live', meta: { kind: 'supabase' } });

  // headline counts
  const counts = await Promise.all(TABLES.map(async ([tbl, label]) => {
    try { return [label, await supaCount(tbl)]; } catch { return [label, null]; }
  }));
  for (const [label, c] of counts) {
    if (c == null) continue;
    const id = LV(`db:${label}`);
    push({ id, label: `${label}: ${num(c)}`, group: 'live-value', type: 'value', origin: 'live' });
    fact(LV('db'), id);
  }

  // The Ghost Index — top ghosting companies (grounds the Ghost Report). Needs a real signal, so
  // require a few reports and rank by ghost_rate.
  let top = [];
  try { top = await fetchGhostIndex(8); } catch { top = []; }
  if (Array.isArray(top) && top.length) {
    push({ id: LV('ghost-index'), label: 'Ghost Index (top ghosting)', group: 'live-entity', type: 'entity', origin: 'live', meta: { kind: 'ghost-index', companies: top } });
    for (const c of top) {
      const gr = c.ghost_rate != null ? `${Math.round(c.ghost_rate * (c.ghost_rate <= 1 ? 100 : 1))}%` : '?';
      const id = LV(`ghost:${c.company_name}`);
      push({ id, label: `${c.company_name} · ghost ${gr} (${c.report_count} reports)`, group: 'live-value', type: 'value', origin: 'live', meta: c });
      fact(LV('ghost-index'), id);
    }
  }
  return { nodes, links, ok: true };
}

// ---- GitHub (repo state) ---------------------------------------------------
async function ghGet(pathUrl) {
  const res = await fetchT(`https://api.github.com${pathUrl}`, {
    headers: { authorization: `Bearer ${ghToken()}`, accept: 'application/vnd.github+json', 'user-agent': 'chronos' },
  });
  if (!res.ok) return null;
  try { return await res.json(); } catch { return null; }
}
async function repoLayer(repo, shortName) {
  const nodes = []; const links = [];
  const rid = LV(`repo:${repo}`);
  nodes.push({ id: rid, label: `${shortName} repo`, group: 'live-entity', type: 'entity', origin: 'live', meta: { kind: 'repo', repo } });
  const [branches, prs] = await Promise.all([ghGet(`/repos/${repo}/branches?per_page=30`), ghGet(`/repos/${repo}/pulls?state=open&per_page=20`)]);
  for (const b of (branches || []).slice(0, 24)) {
    const id = LV(`branch:${repo}:${b.name}`);
    nodes.push({ id, label: `⌥ ${b.name}`, group: 'live-branch', type: 'value', origin: 'live', meta: { kind: 'branch', repo, name: b.name } });
    links.push({ source: rid, target: id, kind: 'fact', origin: 'live', valid_from: null });
  }
  for (const p of (prs || [])) {
    const id = LV(`pr:${repo}:${p.number}`);
    nodes.push({ id, label: `PR #${p.number} ${p.title}`.slice(0, 60), group: 'live-pr', type: 'value', origin: 'live', meta: { kind: 'pr', repo, number: p.number, url: p.html_url, draft: p.draft } });
    links.push({ source: rid, target: id, kind: 'fact', origin: 'live', valid_from: null });
  }
  return { nodes, links, count: (branches || []).length + (prs || []).length };
}
async function githubLayer() {
  if (!ghToken()) return { nodes: [], links: [], ok: false };
  const repos = [[commandRepo(), 'Seen Command'], [productRepo(), 'Seen']];
  const parts = await Promise.all(repos.map(([r, s]) => repoLayer(r, s).catch(() => ({ nodes: [], links: [] }))));
  return { nodes: parts.flatMap((p) => p.nodes), links: parts.flatMap((p) => p.links), ok: true };
}

// ---- cache + public API ----------------------------------------------------
let _cache = { at: 0, layer: null };
const TTL_MS = Number(process.env.CHRONOS_LIVE_TTL_MS || 45000);

// buildLiveLayer — the merged Supabase + GitHub fragment (or a small empty fragment). Cached; never throws.
export async function buildLiveLayer({ force = false } = {}) {
  const now = force ? Infinity : Date.now();
  if (!force && _cache.layer && now - _cache.at < TTL_MS) return _cache.layer;
  let supa = { nodes: [], links: [], ok: false }; let gh = { nodes: [], links: [], ok: false };
  try { [supa, gh] = await Promise.all([supabaseLayer(), githubLayer()]); }
  catch { /* fail-soft */ }
  const layer = {
    nodes: [...supa.nodes, ...gh.nodes],
    links: [...supa.links, ...gh.links],
    supabase: supa.ok, github: gh.ok,
  };
  _cache = { at: Date.now(), layer };
  return layer;
}
