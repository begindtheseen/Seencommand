// Build a graph-view model (nodes + links) from the Chronos index, for the temporal network
// visualization (scripts/memory-graph.mjs). Pure and dependency-free.
//
// VENDORED, verbatim, from the `seen` repo (lib/server/memoryGraphView.js) — its source of truth.
// Copied so the packaged Chronos.app is self-contained; re-copy on upstream change, don't hand-edit.
//
// The view has two layers:
//   • Structural — note↔note wiki-links (the stable "cortex", like Obsidian's graph).
//   • Temporal   — each typed fact becomes an edge from its subject to a value node, carrying its
//     validity window so the viewer can scrub time and fade facts in/out at valid_from/valid_to.

function folderGroup(path) {
  if (path.startsWith('timeline/')) return 'timeline';
  if (path.startsWith('decisions/')) return 'decisions';
  if (path.startsWith('people/')) return 'people';
  if (path.startsWith('knowledge/')) return 'knowledge';
  return 'meta';
}

// Resolve a wiki-link target or a fact subject to an existing note id (path), or null.
function makeResolver(entities) {
  return (target) => {
    const q = String(target).toLowerCase();
    for (const e of entities) {
      if (e.path.toLowerCase() === q) return e.path;
      if (String(e.title).toLowerCase() === q) return e.path;
      if (e.path.toLowerCase() === `${q}.md`) return e.path;
      if (e.path.toLowerCase().endsWith(`/${q}.md`)) return e.path;
      if (Array.isArray(e.aliases) && e.aliases.some((a) => String(a).toLowerCase() === q)) return e.path;
      if (Array.isArray(e.aliases) && e.aliases.some((a) => String(a).toLowerCase() === q)) return e.path;
    }
    return null;
  };
}

export function buildGraphView(index, opts = {}) {
  const today = opts.today || '9999-12-31';
  const nodes = new Map();
  const links = [];

  for (const e of index.entities) {
    nodes.set(e.path, { id: e.path, label: String(e.title || e.path), group: folderGroup(e.path), type: 'note', facts: [] });
  }

  const resolve = makeResolver(index.entities);

  // Structural wiki-link edges (deduped, undirected).
  const seen = new Set();
  for (const ed of index.edges) {
    const t = resolve(ed.to);
    if (!t || t === ed.from) continue;
    const key = ed.from < t ? `${ed.from}|${t}` : `${t}|${ed.from}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ source: ed.from, target: t, kind: 'link' });
  }

  // Temporal fact edges: subject → value node.
  let anon = 0;
  for (const f of index.facts) {
    let subjId = resolve(f.subject);
    if (!subjId) {
      subjId = `entity:${String(f.subject).toLowerCase()}`;
      if (!nodes.has(subjId)) nodes.set(subjId, { id: subjId, label: String(f.subject), group: 'entity', type: 'entity', facts: [] });
    }
    const valId = `fact:${f.note || ''}:${f.id || `n${anon++}`}`;
    nodes.set(valId, { id: valId, label: `${f.predicate} → ${f.object}`, group: 'value', type: 'value', facts: [] });
    const edge = {
      source: subjId, target: valId, kind: 'fact',
      subject: String(f.subject), predicate: String(f.predicate), object: String(f.object),
      valid_from: f.valid_from || null, valid_to: f.valid_to || null,
      recorded: f.recorded || null, invalidated: f.invalidated || null,
      confidence: f.confidence || 'medium', note: f.note || null, factId: f.id || null,
    };
    links.push(edge);
    nodes.get(subjId).facts.push(edge);
  }

  const deg = new Map();
  for (const l of links) {
    deg.set(l.source, (deg.get(l.source) || 0) + 1);
    deg.set(l.target, (deg.get(l.target) || 0) + 1);
  }
  const nodeArr = [...nodes.values()].map((n) => ({ ...n, degree: deg.get(n.id) || 0 }));

  let min = null;
  for (const f of index.facts) if (f.valid_from && (!min || f.valid_from < min)) min = f.valid_from;
  for (const e of index.episodes) if (e.date && (!min || e.date < min)) min = e.date;

  return {
    nodes: nodeArr,
    links,
    dateRange: { from: min || today, to: today },
    generated: today,
    counts: {
      notes: index.entities.length,
      facts: index.facts.length,
      links: links.filter((l) => l.kind === 'link').length,
      entities: nodeArr.filter((n) => n.type === 'entity').length,
    },
  };
}
