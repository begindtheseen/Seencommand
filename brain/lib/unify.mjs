// unify — merge the two memory brains into ONE temporal graph the renderer can draw.
//
//   • Chronos (the `seen` vault)  → bi-temporal typed facts + wiki-linked notes. Full validity
//     windows (valid_from/valid_to) + provenance + confidence. Built with the vendored engine.
//   • Command (this repo)         → state.memoryGraph: a flat entity/value/thread/dept graph with
//     no time axis. Its facts are the CURRENT operational truth, so on the time slider they read as
//     "always active" (the engine's factState() already treats a null valid_from that way).
//
// Every node/link is tagged `origin` ('chronos' | 'command' | 'bridge') and ids are namespaced
// ('ch:' / 'cm:') so the two never collide. Where the same subject appears in both brains we add a
// dashed 'bridge' link — the visual unification — without hard-merging (provenance stays intact).

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { buildIndex } from './chronos/memoryGraph.mjs';
import { buildGraphView } from './chronos/memoryGraphView.mjs';

const CH = (id) => `ch:${id}`;
const CM = (id) => `cm:${id}`;
const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

function walkVault(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === '.graph' || name === '.obsidian' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkVault(full, acc);
    else if (name.endsWith('.md')) acc.push(full);
  }
  return acc;
}

// ---- Chronos side ----------------------------------------------------------
// Returns { nodes, links, dateRange, counts } already namespaced + tagged, or null if no vault.
function buildChronos(vaultPath, today) {
  if (!vaultPath || !existsSync(vaultPath)) return null;
  // Every file update gets a MINUTE-precision stamp (mtime): the detail panel shows exactly when a
  // note last changed, not just which day (Brandon: "every file update has a date attached —
  // optimize this to be minute by minute").
  const mtimes = new Map();
  const notes = walkVault(vaultPath).map((f) => {
    const rel = relative(vaultPath, f).replace(/\\/g, '/');
    try { mtimes.set(rel, statSync(f).mtime.toISOString().slice(0, 16)); } catch { /* best effort */ }
    return { path: rel, text: readFileSync(f, 'utf8') };
  });
  const index = buildIndex(notes);
  const view = buildGraphView(index, { today });

  // The view builder intentionally drops the frontmatter `source` provenance; re-attach it from the
  // index (keyed by note + factId) so the detail panel can show where each fact came from.
  const provByKey = new Map(index.facts.map((f) => [`${f.note}:${f.id}`, f.source || null]));

  // Namespace ids in place. node.facts holds the SAME link objects as `links`, so mutating a
  // link's source/target updates both views at once.
  for (const l of view.links) {
    if (l.kind === 'fact') l.provenance = provByKey.get(`${l.note}:${l.factId}`) || null;
    l.source = CH(l.source); l.target = CH(l.target); l.origin = 'chronos';
  }
  for (const n of view.nodes) {
    if (n.type === 'note' && mtimes.has(n.id)) n.updated = mtimes.get(n.id); // pre-namespace id IS the vault path
    n.id = CH(n.id); n.origin = 'chronos';
  }
  return view;
}

// ---- Command side ----------------------------------------------------------
// Turns state.memoryGraph (+ state.threads/departments for detail) into the unified schema.
function buildCommand(statePath) {
  if (!statePath || !existsSync(statePath)) return null;
  let state;
  try { state = JSON.parse(readFileSync(statePath, 'utf8')); } catch { return null; }
  const g = state.memoryGraph;
  if (!g || !Array.isArray(g.nodes)) return null;

  // The command graph is a SNAPSHOT of the latest board meeting, so its facts/work became true "as of"
  // that run. Anchoring them at that stamp (instead of null = always-on) is what lets the time slider
  // actually scrub the operational layer: before the run the command side isn't there yet.
  // MINUTE precision (slice 0,16 keeps YYYY-MM-DDTHH:MM): two runs on the same day scrub in
  // separately. Day-only fallbacks stay day strings — ISO strings prefix-compare fine either way.
  const commandDate = String(state.generatedAt || state.today || '').slice(0, 16) || null;

  const threadByTitle = new Map((state.threads || []).map((t) => [t.title, t]));
  const deptById = new Map((state.departments || []).map((d) => [d.id, d]));

  const GROUP = { entity: 'cmd-entity', value: 'cmd-value', thread: 'thread', dept: 'dept' };
  const TYPE = { entity: 'entity', value: 'value', thread: 'thread', dept: 'dept' };

  const byOrig = new Map(g.nodes.map((n) => [n.id, n]));
  const nodes = new Map();
  for (const n of g.nodes) {
    const node = {
      id: CM(n.id), label: String(n.label ?? n.id), group: GROUP[n.group] || 'cmd-value',
      type: TYPE[n.group] || 'value', origin: 'command', facts: [], meta: {},
    };
    if (node.type === 'thread') {
      const t = threadByTitle.get(n.label ?? n.id);
      if (t) node.meta = { area: t.area, priority: t.priority, status: t.status, threadId: t.id };
    } else if (node.type === 'dept') {
      const d = deptById.get(n.id);
      if (d) node.meta = { title: d.title, charter: d.charter };
    }
    nodes.set(node.id, node);
  }

  const links = [];
  for (const l of g.links || []) {
    const srcNode = nodes.get(CM(l.source));
    const tgtNode = nodes.get(CM(l.target));
    if (!srcNode || !tgtNode) continue;
    if (l.kind === 'fact') {
      // Command value labels are "predicate: object"; the subject is the source node's label.
      const rawLabel = String((byOrig.get(l.target) || {}).label || tgtNode.label);
      const ci = rawLabel.indexOf(':');
      const predicate = ci >= 0 ? rawLabel.slice(0, ci).trim() : rawLabel;
      const object = ci >= 0 ? rawLabel.slice(ci + 1).trim() : '';
      const edge = {
        source: srcNode.id, target: tgtNode.id, kind: 'fact', origin: 'command',
        subject: srcNode.label, predicate, object,
        valid_from: commandDate, valid_to: null, recorded: commandDate, invalidated: null,
        confidence: null, note: 'data/state.json', factId: null, provenance: 'data/state.json (board meeting)',
      };
      links.push(edge);
      srcNode.facts.push(edge);
    } else {
      // 'work' edge: department → thread. Also anchored at the run date so the whole operational layer
      // (depts, threads, and their links) scrubs in together at the board-meeting date.
      links.push({
        source: srcNode.id, target: tgtNode.id, kind: 'work', origin: 'command',
        valid_from: commandDate, detail: tgtNode.meta || {},
      });
    }
  }
  return {
    nodes: [...nodes.values()],
    links,
    date: commandDate,
    counts: {
      nodes: nodes.size,
      facts: links.filter((l) => l.kind === 'fact').length,
      threads: [...nodes.values()].filter((n) => n.type === 'thread').length,
    },
  };
}

// ---- Bridges ---------------------------------------------------------------
// Same subject in both brains → a dashed same-entity link. Match a command entity's label against
// chronos note titles / entity labels (case-insensitive, exact). Non-destructive; toggleable in UI.
function buildBridges(commandNodes, chronosNodes) {
  const chByLabel = new Map();
  for (const n of chronosNodes) {
    if (n.type === 'note' || n.type === 'entity') {
      const k = norm(n.label);
      if (k && !chByLabel.has(k)) chByLabel.set(k, n.id);
    }
  }
  const bridges = [];
  const seen = new Set();
  for (const n of commandNodes) {
    if (n.type !== 'entity') continue;
    const hit = chByLabel.get(norm(n.label));
    if (hit && !seen.has(n.id)) {
      seen.add(n.id);
      bridges.push({ source: n.id, target: hit, kind: 'bridge', origin: 'bridge', label: n.label });
    }
  }
  return bridges;
}

// The board-meeting snapshot (`origin: 'command'`) and the brain (`origin: 'chronos'`) describe the
// same quantities under the SAME subject+predicate — e.g. both emit `Seen | users_total`. Nothing
// reconciled them, so a snapshot fact stayed open forever and sat next to the brain's newer value as
// if both were true now. That is how Chronos showed "users_total = 5" from a 2026-07-09 snapshot while
// the brain correctly held 7, open since 07-20.
//
// The fix is bi-temporal rather than destructive: the snapshot's claim WAS true until the brain learned
// otherwise, so it gets a `valid_to` at that moment instead of being deleted. History stays intact, the
// time slider shows the old value only in the past where it belongs, and scrubbing to now shows one
// answer. A snapshot NEWER than the brain is left alone — the meeting saw fresher data.
//
// PURE + exported so the precedence rule is testable without a vault or a state file. Mutates the
// passed links in place (they are freshly built by the caller) and returns how many it closed.
export function supersedeStaleSnapshotFacts(links) {
  const dayOf = (v) => String(v || '').slice(0, 10);
  const key = (l) => `${String(l.subject || '').toLowerCase()}|${String(l.predicate || '').toLowerCase()}`;

  // Newest OPEN brain fact per subject+predicate.
  const freshest = new Map();
  for (const l of links) {
    if (l.kind !== 'fact' || l.origin !== 'chronos' || l.valid_to != null) continue;
    const k = key(l);
    const prev = freshest.get(k);
    if (!prev || dayOf(l.valid_from) > dayOf(prev.valid_from)) freshest.set(k, l);
  }

  let closed = 0;
  for (const l of links) {
    if (l.kind !== 'fact' || l.origin !== 'command' || l.valid_to != null) continue;
    const brain = freshest.get(key(l));
    if (!brain) continue;
    if (dayOf(brain.valid_from) <= dayOf(l.valid_from)) continue; // snapshot is as fresh or fresher
    l.valid_to = dayOf(brain.valid_from);
    l.invalidated = dayOf(brain.valid_from);
    l.superseded_by = 'chronos';
    closed++;
  }
  return closed;
}

// ---- Public API ------------------------------------------------------------
// `live` is an optional pre-fetched fragment ({ nodes, links, supabase, github }) from lib/live.mjs —
// the real world (Supabase product data + GitHub repo state) merged onto the graph. It's fetched in
// main.js (async) and passed in here so this stays synchronous.
export function buildUnifiedGraph({ statePath, vaultPath, today, live = null }) {
  const day = today || new Date().toISOString().slice(0, 10);
  const chronos = buildChronos(vaultPath, day);
  const command = buildCommand(statePath);

  const nodes = [];
  const links = [];
  if (chronos) { nodes.push(...chronos.nodes); links.push(...chronos.links); }
  if (command) { nodes.push(...command.nodes); links.push(...command.links); }

  let bridges = [];
  if (chronos && command) {
    bridges = buildBridges(command.nodes, chronos.nodes);
    links.push(...bridges);
  }

  // Live layer — Supabase + GitHub, tagged origin 'live'. Anchor its facts at today so the time slider
  // treats them as "true now" (they fade out as you scrub into the past, like the command snapshot).
  let liveCount = 0;
  if (live && Array.isArray(live.nodes)) {
    for (const n of live.nodes) nodes.push(n);
    for (const l of live.links) { if (l.kind === 'fact' && !l.valid_from) l.valid_from = day; links.push(l); }
    liveCount = live.nodes.length;
  }

  // Reconcile the two layers before anything measures the graph: where the brain holds a newer value
  // for the same subject+predicate, the snapshot's fact is closed at that date instead of staying open
  // alongside it. Runs after the live layer so a live fact is never retro-closed by it.
  const supersededSnapshotFacts = supersedeStaleSnapshotFacts(links);

  // Degree across the combined graph (for label priority / sizing).
  const deg = new Map();
  for (const l of links) {
    deg.set(l.source, (deg.get(l.source) || 0) + 1);
    deg.set(l.target, (deg.get(l.target) || 0) + 1);
  }
  for (const n of nodes) n.degree = deg.get(n.id) || 0;

  // Span from the earliest known fact to the latest of {chronos end, command run date, today} so the
  // slider's full travel covers every layer — including the operational command snapshot.
  const dr = chronos ? { ...chronos.dateRange } : { from: day, to: day };
  const cmdDate = command && command.date;
  if (cmdDate && cmdDate > dr.to) dr.to = cmdDate;
  if (cmdDate && cmdDate < dr.from) dr.from = cmdDate;
  if (day > dr.to) dr.to = day;
  // The slider's right edge reaches the present MINUTE (only in live mode — a `today` override is
  // the deterministic path tests use, and must stay reproducible).
  if (!today) { const nowMinute = new Date().toISOString().slice(0, 16); if (nowMinute > dr.to) dr.to = nowMinute; }
  const dateRange = dr;

  return {
    nodes,
    links,
    dateRange,
    generated: day,
    vaultFound: !!chronos,
    stateFound: !!command,
    live: live ? { supabase: !!live.supabase, github: !!live.github, nodes: liveCount } : null,
    counts: {
      command: command ? command.counts : { nodes: 0, facts: 0, threads: 0 },
      chronos: chronos ? chronos.counts : { notes: 0, facts: 0, links: 0, entities: 0 },
      live: liveCount,
      bridges: bridges.length,
      supersededSnapshotFacts,
      total: { nodes: nodes.length, links: links.length },
    },
    sources: { statePath: statePath || null, vaultPath: vaultPath || null },
  };
}
