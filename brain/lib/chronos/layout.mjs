// layout — the pure logic behind the brain graph (lib/ui/brain-graph.js): clustering, importance,
// a deterministic bounded layout with a real center of gravity, search ranking, change detection,
// and the per-node detail (current facts, history, contradictions, stale / low-confidence flags).
//
// WHY THIS EXISTS
// The old Chronos map ran an open-ended force simulation from a random-ish spiral, so loosely linked
// nodes drifted off into space, the picture changed every launch, and it never stopped animating.
// This module replaces that with a layout that is a pure function of the data:
//   • a "Seen" core pinned at the origin (the real `Seen` node when the data has one);
//   • one annular SECTOR per cluster (product & metrics, work, decisions, people, collectors, repos,
//     creators, knowledge, timeline), sized by how many nodes it holds;
//   • inside a sector the most important nodes sit nearest the core (radius = importance rank);
//   • a fixed number of relaxation passes: link springs pull related nodes together, grid-based
//     collision keeps them apart, and every pass clamps each node back into its sector and inside
//     the disc of radius R — so nothing can float away, and the result is the same every time.
//
// RULES FOR THIS FILE (it is inlined verbatim into the browser by build-brain-graph.mjs)
//   • No imports, no I/O, no Math.random, no Date.now() inside the layout (pass `now` explicitly).
//   • `export` only at the start of a top-level `function` / `const` declaration — the build step
//     strips exactly that keyword. layout.test.mjs asserts the browser copy matches this file.
//
// INPUT: the unified graph payload of brain/lib/unify.mjs buildUnifiedGraph() — the same object the
// Chronos `graph:request` IPC returns and Seen Command's /api/brain/graph serves:
//   { nodes: [{ id, label, group, type, origin, degree, facts?, meta?, updated? }],
//     links: [{ source, target, kind: 'link'|'fact'|'work'|'bridge', origin, ...fact fields }],
//     dateRange: { from, to }, generated, vaultFound, stateFound, live, counts, sources, error? }
// Fact links carry subject, predicate, object, valid_from, valid_to, recorded, invalidated,
// confidence, note, factId, provenance, superseded_by?. Dates are ISO strings: 'YYYY-MM-DD'
// (a California calendar day), 'YYYY-MM-DDTHH:MM' (UTC minute, from toISOString), or full ISO.

export const LAYOUT_VERSION = 1;

// Clusters, in the order they are laid out clockwise from 12 o'clock. Colors are fixed hues that sit
// well on the graphite theme; the core uses --ink and status colors come from the theme tokens.
export const CLUSTERS = [
  { id: 'product', label: 'Product & metrics', color: '#4f8cff' },
  { id: 'work', label: 'Work & builds', color: '#f2b63c' },
  { id: 'decisions', label: 'Decisions', color: '#8b7cf6' },
  { id: 'people', label: 'People & agents', color: '#f08bb4' },
  { id: 'collectors', label: 'Collectors & sources', color: '#3ec5cf' },
  { id: 'infra', label: 'Repos & infrastructure', color: '#93a4c3' },
  { id: 'creators', label: 'Creators & outreach', color: '#ff9f5a' },
  { id: 'knowledge', label: 'Knowledge', color: '#3ecf8e' },
  { id: 'timeline', label: 'Timeline', color: '#b7a3e6' },
];

const DAY_MS = 86400000;
const PT = 'America/Los_Angeles';

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

// Milliseconds since epoch at 00:00 California time on y-m-d (DST-correct via Intl).
function pacificMidnightMs(y, m, d) {
  const guess = Date.UTC(y, m - 1, d, 8, 0); // PST midnight; corrected below for PDT
  let off = 8;
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: PT, hour: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(guess));
    const h = Number((parts.find((p) => p.type === 'hour') || {}).value);
    if (h === 1) off = 7; // 08:00 UTC is 01:00 PDT → midnight is 07:00 UTC
  } catch { /* no Intl: assume PST */ }
  return Date.UTC(y, m - 1, d, off, 0);
}

// Parse any date string the graph carries into ms, or null. Day strings are cached: thousands of
// facts share a few hundred days, and the Intl offset lookup is the expensive part.
const DAY_CACHE = new Map();
export function parseWhen(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    let ms = DAY_CACHE.get(s);
    if (ms === undefined) { ms = pacificMidnightMs(+m[1], +m[2], +m[3]); if (DAY_CACHE.size < 20000) DAY_CACHE.set(s, ms); }
    return ms;
  }
  m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

// A date for people: always California time. A bare day stays that day (it already IS a California
// day); anything with a time is converted.
export function formatPacific(v, withTime = true) {
  if (v == null || v === '') return '—';
  const s = String(v);
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (day) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[+day[2] - 1]} ${+day[3]}, ${day[1]}`;
  }
  const ms = parseWhen(v);
  if (ms == null) return s;
  const o = { timeZone: PT, month: 'short', day: 'numeric', year: 'numeric' };
  if (withTime) { o.hour = 'numeric'; o.minute = '2-digit'; }
  try { return new Date(ms).toLocaleString('en-US', o) + (withTime ? ' PT' : ''); } catch { return s; }
}

// ---------------------------------------------------------------------------
// Small deterministic helpers
// ---------------------------------------------------------------------------

// FNV-1a 32-bit hash → a stable seed from strings.
export function hashString(s) {
  let h = 0x811c9dc5;
  const str = String(s);
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

// mulberry32 — seeded PRNG in [0,1).
export function seededRandom(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
const maxOf = (a, b) => (a == null ? b : b == null ? a : Math.max(a, b));

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

const KEYWORDS = [
  ['people', /\b(brandon|claude|codex|founder|owner|person|people|team|hire|contractor)\b/i],
  ['collectors', /(collector|harvest|ingest|scrap|crawl|archive|adzuna|greenhouse|\blever\b|ashby|workday|smartrecruiters|indeed|reddit|arctic shift|job board|career[- ]site|\bfeed\b|\bsource\b|\bsources\b|backfill)/i],
  ['creators', /(creator|influencer|tiktok|youtube|newsletter|podcast|outreach|\bpost\b|\bdms?\b|content engine|ghost report|r\/)/i],
  ['infra', /(\brepo\b|branch|\bpr\b|pull request|deploy|production|\bprod\b|database|supabase|vercel|github|\bapi\b|test suite|data model|migration|schema|\bci\b|server|chronos|seen command|mcp|cron|backup|_key\b)/i],
  ['product', /(\bseen\b|\bmrr\b|revenue|pricing|price|\btier\b|credit|\bsku\b|users?\b|signup|paid|subscription|stripe|trial|employer|flywheel|operation|engine|metric|kpi|score|company|companies|jobs?\b|reports?\b|ghost|email)/i],
];
const ENV_VAR = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/; // RESEND_KEY, OWNER_EMAIL → configuration (infra)

function keywordCluster(label, path) {
  if (ENV_VAR.test(String(label).trim())) return 'infra';
  const text = `${label} ${path}`.trim();
  for (const [id, re] of KEYWORDS) if (re.test(text)) return id;
  return null;
}

// The cluster a node belongs to, from its own fields only (values and leftovers are resolved by
// buildModel from their neighbors).
export function baseCluster(n) {
  const g = n.group, t = n.type, kind = n.meta && n.meta.kind;
  if (t === 'thread' || t === 'dept' || g === 'thread' || g === 'dept') return 'work';
  if (g === 'people') return 'people';
  if (g === 'decisions') return 'decisions';
  if (g === 'timeline') return 'timeline';
  if (g === 'live-branch' || g === 'live-pr' || kind === 'repo' || kind === 'branch' || kind === 'pr') return 'infra';
  if (g === 'live-entity' || g === 'live-value') return 'product'; // Supabase product data + Ghost Index
  if (t === 'value' || g === 'value' || g === 'cmd-value') return null; // inherits its subject's
  const path = n.origin === 'chronos' ? String(n.id).replace(/^ch:/, '') : '';
  const kw = keywordCluster(n.label || '', path);
  if (kw) return kw;
  if (t === 'note') return 'knowledge';
  return null; // an entity with no signal → majority of its neighbors, else knowledge
}

// ---------------------------------------------------------------------------
// Model: nodes + links + facts, with cluster, importance, change times and radius
// ---------------------------------------------------------------------------

// The core is the best-connected node labelled "Seen" (ties: an entity, then the smaller id).
function pickCore(nodes, rawLinks) {
  const deg = new Map();
  for (const l of rawLinks) {
    if (!l) continue;
    deg.set(String(l.source), (deg.get(String(l.source)) || 0) + 1);
    deg.set(String(l.target), (deg.get(String(l.target)) || 0) + 1);
  }
  let best = null;
  for (const n of nodes) {
    if (norm(n.label) !== 'seen') continue;
    const score = (deg.get(n.id) || 0) + (n.type === 'entity' ? 0.5 : 0);
    if (!best || score > best.score || (score === best.score && String(n.id) < String(best.n.id))) best = { n, score };
  }
  return best ? best.n.id : null;
}

export const CORE_ID = '__seen_core__';

// buildModel(data, { now }) → a model the layout, renderer and panel all share.
// `now` is only used for change flags; importance uses the data's own newest date so the layout is a
// pure function of the data.
export function buildModel(data, opts = {}) {
  const rawNodes = Array.isArray(data && data.nodes) ? data.nodes : [];
  const rawLinks = Array.isArray(data && data.links) ? data.links : [];
  const nodes = [];
  const byId = new Map();
  for (const rn of rawNodes) {
    if (!rn || rn.id == null || byId.has(String(rn.id))) continue;
    const n = {
      id: String(rn.id), label: String(rn.label == null ? rn.id : rn.label), type: rn.type || 'note',
      group: rn.group || '', origin: rn.origin || '', meta: rn.meta || null, raw: rn, cluster: null, degree: 0,
      facts: [], incoming: [], factCount: 0, lastChange: null, importance: 0, radius: 3,
      closed: false, virtual: false, x: 0, y: 0,
    };
    nodes.push(n); byId.set(n.id, n);
  }
  let coreId = pickCore(nodes, rawLinks);
  if (!coreId) {
    const core = { id: CORE_ID, label: 'Seen', type: 'core', group: 'core', origin: '', raw: null, cluster: 'core', degree: 0,
      facts: [], incoming: [], factCount: 0, lastChange: null, importance: 1, radius: 16, closed: false, virtual: true, x: 0, y: 0 };
    nodes.unshift(core); byId.set(CORE_ID, core); coreId = CORE_ID;
  }

  const links = [];
  const adj = new Map(nodes.map((n) => [n.id, []]));
  for (const rl of rawLinks) {
    if (!rl) continue;
    const s = byId.get(String(rl.source)), t = byId.get(String(rl.target));
    if (!s || !t || s === t) continue;
    const l = { s: s.id, t: t.id, kind: rl.kind || 'link', raw: rl, closed: false };
    if (l.kind === 'fact') {
      l.closed = rl.valid_to != null && rl.valid_to !== '';
      s.facts.push(rl); t.incoming.push(rl);
      if (t.type === 'value' && l.closed) t.closed = true;
    }
    links.push(l);
    adj.get(s.id).push(t.id); adj.get(t.id).push(s.id);
    s.degree++; t.degree++;
  }

  // Change times. A fact "changes" when it starts (valid_from), is recorded, or is closed.
  for (const n of nodes) {
    let last = n.raw ? parseWhen(n.raw.updated) : null;
    for (const f of n.facts.concat(n.incoming)) {
      last = maxOf(last, parseWhen(f.valid_from));
      last = maxOf(last, parseWhen(f.recorded));
      last = maxOf(last, parseWhen(f.recorded_at));
      last = maxOf(last, parseWhen(f.valid_to));
      last = maxOf(last, parseWhen(f.invalidated));
    }
    if (n.type === 'note' && n.group === 'timeline') {
      const d = /(\d{4}-\d{2}-\d{2})/.exec(n.id);
      if (d) last = maxOf(last, parseWhen(d[1]));
    }
    n.lastChange = last;
    n.factCount = n.facts.length;
  }

  // Clusters: own signal → subject (values) → neighbor majority → knowledge.
  const core = byId.get(coreId);
  core.cluster = 'core';
  for (const n of nodes) if (n !== core) n.cluster = baseCluster(n);
  for (const n of nodes) {
    if (n.cluster || n === core) continue;
    if (n.type === 'value' || n.group === 'value' || n.group === 'cmd-value') {
      const subj = n.incoming.length ? byId.get(String(n.incoming[0].source)) : null;
      if (subj && subj === core) n.cluster = 'product';
      else if (subj && subj.cluster) n.cluster = subj.cluster;
    }
  }
  for (let pass = 0; pass < 2; pass++) {
    for (const n of nodes) {
      if (n.cluster) continue;
      const votes = new Map();
      for (const id of adj.get(n.id)) {
        const c = byId.get(id).cluster;
        if (c && c !== 'core') votes.set(c, (votes.get(c) || 0) + 1);
      }
      let best = null;
      for (const c of CLUSTERS) { const v = votes.get(c.id) || 0; if (v && (!best || v > best.v)) best = { id: c.id, v }; }
      if (best) n.cluster = best.id;
      else if (pass === 1) n.cluster = adj.get(n.id).includes(coreId) ? 'product' : 'knowledge';
    }
  }
  // Values whose subject was resolved only in the vote pass.
  for (const n of nodes) {
    if (n.type !== 'value' || !n.incoming.length) continue;
    const subj = byId.get(String(n.incoming[0].source));
    if (subj && subj !== core && subj.cluster) n.cluster = subj.cluster;
  }

  // Importance = degree + recency + fact count, each normalised to [0,1].
  let refMs = parseWhen(data && data.dateRange && data.dateRange.to) || parseWhen(data && data.generated);
  for (const n of nodes) refMs = maxOf(refMs, n.lastChange);
  let maxDeg = 1, maxFc = 1;
  for (const n of nodes) { if (n.degree > maxDeg) maxDeg = n.degree; if (n.factCount > maxFc) maxFc = n.factCount; }
  const ld = Math.log2(1 + maxDeg), lf = Math.log2(1 + maxFc);
  for (const n of nodes) {
    if (n === core) { n.importance = 1; n.radius = 16; continue; }
    const deg = Math.log2(1 + n.degree) / ld;
    const rec = n.lastChange != null && refMs != null ? Math.exp(-Math.max(0, refMs - n.lastChange) / (30 * DAY_MS)) : 0;
    const fc = Math.log2(1 + n.factCount) / lf;
    let imp = 0.5 * deg + 0.3 * rec + 0.2 * fc;
    if (n.type === 'value') imp *= 0.45; // a fact value is a leaf; its subject carries the weight
    if (n.closed) imp *= 0.6;
    n.importance = Math.max(0, Math.min(1, imp));
    n.radius = Math.round((2.6 + 9 * Math.pow(n.importance, 0.85)) * 100) / 100;
  }

  const contradictions = findContradictions(rawLinks.filter((l) => l && l.kind === 'fact'));
  const contraByNode = new Map();
  for (const c of contradictions) {
    const ids = new Set([String(c.a.source), String(c.a.target), String(c.b.source), String(c.b.target)]);
    for (const id of ids) {
      if (!byId.has(id)) continue;
      if (!contraByNode.has(id)) contraByNode.set(id, []);
      contraByNode.get(id).push(c);
    }
  }

  return { nodes, links, byId, adj, coreId, refMs, contradictions, contraByNode, now: opts.now == null ? null : opts.now };
}

// Same subject+predicate, overlapping valid windows, different object (the vault's hygiene rule).
// A contradiction = two facts that are BOTH still believed (no valid_to, not invalidated) about the same
// subject + predicate and say different things. A closed reading is history, not a conflict: comparing
// every past "active_jobs" count with today's board-meeting snapshot made the map report 282 when the
// Keeper (Health) found 0. A rewording ("live" vs "live (noreply@ verified)") is not a disagreement.
const sameClaim = (a, b) => norm(a).replace(/\s*\(.*\)\s*$/, '') === norm(b).replace(/\s*\(.*\)\s*$/, '');
export function findContradictions(factLinks) {
  const groups = new Map();
  for (const f of factLinks) {
    if (f.predicate == null || f.subject == null) continue;
    if (f.valid_to || f.invalidated) continue;
    const key = `${norm(f.subject)}|${norm(f.predicate)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  const out = [];
  for (const g of groups.values()) {
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        const x = g[i], y = g[j];
        if (sameClaim(x.object, y.object)) continue;
        const xs = parseWhen(x.valid_from) == null ? -Infinity : parseWhen(x.valid_from);
        const ys = parseWhen(y.valid_from) == null ? -Infinity : parseWhen(y.valid_from);
        const xe = parseWhen(x.valid_to) == null ? Infinity : parseWhen(x.valid_to);
        const ye = parseWhen(y.valid_to) == null ? Infinity : parseWhen(y.valid_to);
        if (xs < ye && ys < xe) out.push({ a: x, b: y, subject: String(x.subject), predicate: String(x.predicate) });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function angleIn(a, a0, span) {
  let d = (a - a0) % (2 * Math.PI);
  if (d < 0) d += 2 * Math.PI;
  return d; // in [0, 2π): inside the sector iff d <= span
}

// computeLayout(model, opts) → { R, r0, sectors, iterations } and sets x/y on every model node.
// Deterministic for a given model; bounded: every node satisfies |p| + radius <= R.
export function computeLayout(model, opts = {}) {
  const nodes = model.nodes;
  const N = nodes.length;
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const core = model.byId.get(model.coreId);
  const coreR = core.radius;

  const ci = index.get(core.id);
  const X = new Float64Array(N), Y = new Float64Array(N), Rad = new Float64Array(N);
  const target = new Float64Array(N); // preferred radius (importance rank)
  const sec = new Array(N);
  nodes.forEach((n, i) => { Rad[i] = n.radius; });

  // A LEAF hangs off exactly one other node (not the core): a fact value on its subject, or any
  // single-link node on a same-cluster neighbor (a thread on its department, a note linked once).
  // Leaves orbit their parent; every other node gets a slot of its own. A parent's FOOTPRINT is its
  // own area plus its leaves', so a hub with fifty facts is given the room fifty facts need.
  const subjOf = new Int32Array(N).fill(-1);
  const foot = new Float64Array(N);
  nodes.forEach((n, i) => { const d = 2 * Rad[i] + 5; foot[i] = d * d; });
  nodes.forEach((n, i) => {
    if (n === core || n.type !== 'value' || !n.incoming.length || n.degree > 2) return;
    const p = index.get(String(n.incoming[0].source));
    if (p === undefined || p === ci) return;
    subjOf[i] = p; foot[p] += foot[i];
  });
  nodes.forEach((n, i) => {
    if (n === core || subjOf[i] !== -1 || n.degree !== 1) return;
    const nb = model.adj.get(n.id);
    const p = nb && nb.length === 1 ? index.get(nb[0]) : undefined;
    if (p === undefined || p === ci || subjOf[p] !== -1 || nodes[p].degree < 2 || nodes[p].cluster !== n.cluster) return;
    subjOf[i] = p; foot[p] += foot[i];
  });

  // Sector sizes: proportional to the area each cluster needs, with a floor so a tiny cluster reads.
  const counts = new Map(CLUSTERS.map((c) => [c.id, 0]));
  const area = new Map(CLUSTERS.map((c) => [c.id, 0]));
  let areaNeed = 0;
  nodes.forEach((n, i) => {
    if (i === ci) return;
    counts.set(n.cluster, (counts.get(n.cluster) || 0) + 1);
    if (subjOf[i] === -1) { area.set(n.cluster, (area.get(n.cluster) || 0) + foot[i]); areaNeed += foot[i]; }
  });
  const present = CLUSTERS.filter((c) => counts.get(c.id) > 0);
  const floorA = Math.max(400, areaNeed * 0.035);
  const weights = present.map((c) => Math.max(area.get(c.id), floorA));
  const wSum = weights.reduce((x, y) => x + y, 0) || 1;
  const r0 = Math.max(coreR + 34, 70);
  const PACK = 0.42; // share of the disc actually covered by nodes once relaxed
  const R = Math.round(Math.max(r0 + 120, Math.sqrt(r0 * r0 + (wSum / PACK) / Math.PI)));
  const gapA = present.length > 1 ? Math.min(0.06, 0.6 / present.length) : 0;
  const sectors = [];
  let a = -Math.PI / 2;
  present.forEach((c, i) => {
    const span = (2 * Math.PI * weights[i]) / wSum;
    sectors.push({ id: c.id, label: c.label, color: c.color, a0: a + gapA / 2, span: Math.max(0.02, span - gapA), count: counts.get(c.id) });
    a += span;
  });
  const sectorOf = new Map(sectors.map((x) => [x.id, x]));
  nodes.forEach((n, i) => { sec[i] = sectorOf.get(n.cluster) || null; });

  // Seeds: per cluster, slot nodes by importance on an area-uniform spiral weighted by footprint
  // (important → nearest the core); leaves start on a sunflower around their subject.
  const byCluster = new Map();
  nodes.forEach((n, i) => {
    if (i === ci || subjOf[i] !== -1) return;
    if (!byCluster.has(n.cluster)) byCluster.set(n.cluster, []);
    byCluster.get(n.cluster).push(i);
  });
  const GOLD = 0.6180339887498949;
  for (const [cid, idxs] of byCluster) {
    const s = sectorOf.get(cid);
    idxs.sort((p, q) => (nodes[q].importance - nodes[p].importance) || (nodes[p].id < nodes[q].id ? -1 : 1));
    let total = 0;
    for (const i of idxs) total += foot[i];
    const rIn = r0 + 14, rOut = R - 14;
    let cum = 0;
    idxs.forEach((i, k) => {
      const t = (cum + foot[i] / 2) / total;
      cum += foot[i];
      const r = Math.sqrt(rIn * rIn + t * (rOut * rOut - rIn * rIn));
      const f = ((k * GOLD) % 1 + (hashString(nodes[i].id) % 1000) / 50000) % 1;
      const ang = s.a0 + s.span * (0.06 + 0.88 * f);
      X[i] = Math.cos(ang) * r; Y[i] = Math.sin(ang) * r; target[i] = r;
    });
  }
  const ringCount = new Int32Array(N);
  nodes.forEach((n, i) => {
    const p = subjOf[i];
    if (p === -1) return;
    const k = ringCount[p]++;
    const ang = k * 2.399963 + (hashString(n.id) % 628) / 100;
    const rr = Rad[p] + Rad[i] + 6 + 5.2 * Math.sqrt(k);
    X[i] = X[p] + Math.cos(ang) * rr; Y[i] = Y[p] + Math.sin(ang) * rr;
    target[i] = Math.hypot(X[i], Y[i]);
  });
  X[ci] = 0; Y[ci] = 0;

  // Links as index pairs with per-kind spring settings.
  const L = model.links.length;
  const LA = new Int32Array(L), LB = new Int32Array(L), LRest = new Float64Array(L), LK = new Float64Array(L);
  const deg = new Float64Array(N);
  const leafRank = new Int32Array(N); // how many leaf values each subject has placed so far
  model.links.forEach((l, j) => {
    const p = index.get(l.s), q = index.get(l.t);
    LA[j] = p; LB[j] = q; deg[p]++; deg[q]++;
    const same = nodes[p].cluster === nodes[q].cluster;
    const parent = subjOf[q] === p ? p : subjOf[p] === q ? q : -1;
    if (parent !== -1) {
      // Leaves fill a small sunflower disc around their parent instead of piling onto one ring.
      const k = leafRank[parent]++;
      LRest[j] = Rad[p] + Rad[q] + 6 + 5.2 * Math.sqrt(k);
      LK[j] = 0.4;
    } else {
      LRest[j] = Rad[p] + Rad[q] + 26;
      LK[j] = p === ci || q === ci ? 0 : same ? 0.06 : 0.01;
    }
  });

  // Relaxation. Iterations shrink with size so 3,000 nodes stay well under the budget.
  const work = N + L;
  const iterations = opts.iterations || Math.max(60, Math.min(260, Math.round(260 * 1500 / Math.max(1500, work))));
  // The core never collides: every other node is clamped outside r0 > core radius, so it is left out
  // of the grid (which keeps the cells small).
  let maxRad = 0;
  for (let i = 0; i < N; i++) if (i !== ci && Rad[i] > maxRad) maxRad = Rad[i];
  const PAD = 2;
  const cell = 2 * maxRad + PAD * 2;
  const gridW = Math.ceil((2 * R) / cell) + 1;
  const head = new Int32Array(gridW * gridW);
  const nextIdx = new Int32Array(N);
  const cellOf = new Int32Array(N);
  const moved = new Uint8Array(N).fill(1);

  const clamp = (i) => {
    if (i === ci) { X[i] = 0; Y[i] = 0; return; }
    let r = Math.hypot(X[i], Y[i]);
    let ang = Math.atan2(Y[i], X[i]);
    const rMin = r0 + Rad[i], rMax = R - Rad[i] - 1;
    if (r < rMin) r = rMin;
    if (r > rMax) r = rMax;
    const s = sec[i];
    if (s) {
      const pad = Math.min(s.span / 2, (Rad[i] + 1) / Math.max(r, 1));
      const d = angleIn(ang, s.a0, s.span);
      if (d < pad || d > s.span - pad) {
        // outside (or on the edge of) its wedge → nearest inside edge
        const toStart = d < pad ? pad - d : 2 * Math.PI - d + pad;
        const toEnd = d > s.span - pad ? d - (s.span - pad) : Infinity;
        ang = toStart <= toEnd ? s.a0 + pad : s.a0 + s.span - pad;
      }
    }
    X[i] = Math.cos(ang) * r; Y[i] = Math.sin(ang) * r;
  };
  for (let i = 0; i < N; i++) clamp(i);

  // Radial preference: a node keeps (roughly) the ring its importance earned, so springs mostly move
  // it ALONG the ring toward what it is linked to instead of collapsing everything onto the hubs.
  const radialK = opts.radial == null ? 0.25 : opts.radial;
  // The last passes are collision-only, so whatever the springs left overlapping is pushed apart.
  // They stop as soon as a pass finds no overlap (capped, so the cost stays bounded).
  const settle = opts.settlePasses == null ? 400 : opts.settlePasses;
  let settled = 0;
  for (let it = 0; it < iterations + settle; it++) {
    let overlaps = 0;
    const alpha = it < iterations ? 1 - it / iterations : 0;
    if (alpha > 0) {
      // springs
      for (let j = 0; j < L; j++) {
        const k = LK[j]; if (!k) continue;
        const p = LA[j], q = LB[j];
        let dx = X[q] - X[p], dy = Y[q] - Y[p];
        const d = Math.hypot(dx, dy) || 0.01;
        const f = ((d - LRest[j]) / d) * k * alpha;
        dx *= f; dy *= f;
        const bp = deg[q] / (deg[p] + deg[q]);
        if (p !== ci) { X[p] += dx * bp; Y[p] += dy * bp; }
        if (q !== ci) { X[q] -= dx * (1 - bp); Y[q] -= dy * (1 - bp); }
      }
      // radial preference — fades out with alpha
      for (let i = 0; i < N; i++) {
        if (i === ci || !target[i]) continue;
        const r = Math.hypot(X[i], Y[i]) || 1;
        const f = 1 + ((target[i] - r) / r) * (subjOf[i] === -1 ? radialK : 0.03) * alpha;
        X[i] *= f; Y[i] *= f;
      }
      moved.fill(1);
    }
    // collision on a uniform grid
    head.fill(-1);
    for (let i = 0; i < N; i++) {
      if (i === ci) continue;
      const gx = Math.min(gridW - 1, Math.max(0, Math.floor((X[i] + R) / cell)));
      const gy = Math.min(gridW - 1, Math.max(0, Math.floor((Y[i] + R) / cell)));
      const c = gy * gridW + gx;
      cellOf[i] = c; nextIdx[i] = head[c]; head[c] = i;
    }
    const push0 = alpha > 0 ? 0.6 : 0.9;
    for (let i = 0; i < N; i++) {
      if (i === ci) continue;
      const gx = cellOf[i] % gridW, gy = (cellOf[i] - gx) / gridW;
      for (let oy = -1; oy <= 1; oy++) {
        const yy = gy + oy; if (yy < 0 || yy >= gridW) continue;
        for (let ox = -1; ox <= 1; ox++) {
          const xx = gx + ox; if (xx < 0 || xx >= gridW) continue;
          for (let j = head[yy * gridW + xx]; j !== -1; j = nextIdx[j]) {
            if (j <= i) continue;
            let dx = X[j] - X[i], dy = Y[j] - Y[i];
            const min = Rad[i] + Rad[j] + PAD;
            const d2 = dx * dx + dy * dy;
            if (d2 >= min * min) continue;
            const touch = Rad[i] + Rad[j];
            if (d2 < touch * touch) overlaps++;
            let d = Math.sqrt(d2);
            if (d < 1e-6) { const h = ((hashString(nodes[i].id) ^ hashString(nodes[j].id)) % 628) / 100; dx = Math.cos(h); dy = Math.sin(h); d = 1; }
            const push = ((min - d) / d) * push0 * 0.5;
            dx *= push; dy *= push;
            X[i] -= dx; Y[i] -= dy; X[j] += dx; Y[j] += dy;
            moved[i] = 1; moved[j] = 1;
          }
        }
      }
    }
    for (let i = 0; i < N; i++) if (moved[i]) { clamp(i); moved[i] = 0; }
    if (it >= iterations) { settled++; if (!overlaps) break; }
  }

  for (let i = 0; i < N; i++) {
    nodes[i].x = Math.round(X[i] * 100) / 100;
    nodes[i].y = Math.round(Y[i] * 100) / 100;
  }
  // Rounding can nudge a node a hair past a bound; re-check with the rounded values.
  for (const n of nodes) {
    if (n === core) continue;
    const r = Math.hypot(n.x, n.y);
    const max = R - n.radius;
    if (r > max) { const f = (max - 0.01) / r; n.x = Math.floor(n.x * f * 100) / 100; n.y = Math.floor(n.y * f * 100) / 100; }
  }
  // Label anchor per sector (outside the disc) and the sector centroid of its nodes.
  for (const s of sectors) {
    const mid = s.a0 + s.span / 2;
    s.labelX = Math.cos(mid) * (R + 22); s.labelY = Math.sin(mid) * (R + 22);
    let sx = 0, sy = 0, c = 0;
    for (const n of nodes) if (n.cluster === s.id) { sx += n.x; sy += n.y; c++; }
    s.cx = c ? sx / c : 0; s.cy = c ? sy / c : 0;
  }
  model.layout = { R, r0, sectors, iterations, settlePasses: settled };
  return model.layout;
}

// ---------------------------------------------------------------------------
// Change detection
// ---------------------------------------------------------------------------

// changeSet(model, nowMs, windowMs) → Map id → { added, superseded, edited, last }.
// added      = a fact started (valid_from) or was recorded in the window;
// superseded = a fact was closed (valid_to / invalidated) in the window;
// edited     = the node itself (a vault note) was updated in the window.
export function changeSet(model, nowMs, windowMs) {
  const from = nowMs - windowMs;
  const inWin = (ms) => ms != null && ms >= from && ms <= nowMs + 60000;
  const out = new Map();
  const mark = (id, key, ms) => {
    let e = out.get(id);
    if (!e) { e = { added: 0, superseded: 0, edited: false, last: null }; out.set(id, e); }
    if (key === 'edited') e.edited = true; else e[key]++;
    e.last = maxOf(e.last, ms);
  };
  for (const l of model.links) {
    if (l.kind !== 'fact') continue;
    const f = l.raw;
    const start = maxOf(parseWhen(f.valid_from), maxOf(parseWhen(f.recorded), parseWhen(f.recorded_at)));
    const end = maxOf(parseWhen(f.valid_to), parseWhen(f.invalidated));
    if (inWin(start)) { mark(l.s, 'added', start); mark(l.t, 'added', start); }
    if (inWin(end)) { mark(l.s, 'superseded', end); mark(l.t, 'superseded', end); }
  }
  for (const n of model.nodes) {
    const u = n.raw ? parseWhen(n.raw.updated) : null;
    if (inWin(u)) mark(n.id, 'edited', u);
    else if (n.type === 'note' && n.group === 'timeline' && inWin(n.lastChange)) mark(n.id, 'edited', n.lastChange);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

// searchNodes(model, query, limit) → [{ node, score }] best first. Label matches beat fact matches;
// importance breaks ties so the hub wins over a same-named leaf.
export function searchNodes(model, query, limit = 8) {
  const q = norm(query);
  if (!q) return [];
  const toks = q.split(/\s+/).filter(Boolean);
  const out = [];
  for (const n of model.nodes) {
    const label = norm(n.label);
    let s = 0;
    if (label === q) s = 100;
    else if (label.startsWith(q)) s = 80;
    else if (new RegExp(`(^|[^a-z0-9])${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(label)) s = 62;
    else if (label.includes(q)) s = 45;
    else if (toks.length > 1 && toks.every((t) => label.includes(t))) s = 40;
    else {
      const id = norm(n.id);
      if (n.type !== 'value' && id.includes(q)) s = 22; // a note's path; a value's id is noise
      else {
        for (const f of n.facts) {
          const hay = `${norm(f.predicate)} ${norm(f.object)}`;
          if (toks.every((t) => hay.includes(t))) { s = 18; break; }
        }
      }
    }
    if (!s) continue;
    if (n.type === 'value') s -= 8;
    out.push({ node: n, score: s + n.importance * 10 });
  }
  out.sort((a, b) => (b.score - a.score) || (a.node.label.length - b.node.label.length) || (a.node.id < b.node.id ? -1 : 1));
  return out.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Node detail (what the side panel shows)
// ---------------------------------------------------------------------------

export const STALE_DAYS = 90;

// nodeDetail(model, id, nowMs) → { node, current, history, incoming, contradictions, stale, lowConfidence, neighbors }.
export function nodeDetail(model, id, nowMs) {
  const n = model.byId.get(String(id));
  if (!n) return null;
  const isOpen = (f) => {
    const end = parseWhen(f.valid_to);
    return end == null || (nowMs != null && end > nowMs);
  };
  const byStart = (a, b) => (parseWhen(b.valid_from) || 0) - (parseWhen(a.valid_from) || 0);
  const current = n.facts.filter(isOpen).sort(byStart);
  const history = n.facts.filter((f) => !isOpen(f)).sort((a, b) => (parseWhen(b.valid_to) || 0) - (parseWhen(a.valid_to) || 0));
  const staleCut = nowMs == null ? null : nowMs - STALE_DAYS * DAY_MS;
  const stale = current.filter((f) => {
    const t = maxOf(parseWhen(f.valid_from), parseWhen(f.recorded));
    return staleCut != null && t != null && t < staleCut;
  });
  const lowConfidence = n.facts.concat(n.incoming).filter((f) => norm(f.confidence) === 'low');
  const contradictions = model.contraByNode.get(n.id) || [];
  const neighbors = [];
  const seen = new Set();
  for (const nid of model.adj.get(n.id) || []) {
    if (seen.has(nid)) continue; seen.add(nid);
    const m = model.byId.get(nid);
    const l = model.links.find((x) => (x.s === n.id && x.t === nid) || (x.t === n.id && x.s === nid));
    neighbors.push({ node: m, kind: l ? l.kind : 'link' });
  }
  neighbors.sort((a, b) => (b.node.importance - a.node.importance) || (a.node.label < b.node.label ? -1 : 1));
  return { node: n, current, history, incoming: n.incoming.slice(), contradictions, stale, lowConfidence, neighbors };
}
