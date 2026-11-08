// Fixtures for the brain-graph layout tests and the visual harness. Every graph here has EXACTLY the
// shape brain/lib/unify.mjs buildUnifiedGraph() returns. Nothing here is real data: it is labelled
// synthetic and generated from a fixed seed so tests are reproducible.

import { seededRandom } from './layout.mjs';

const pad = (x) => (x < 10 ? `0${x}` : `${x}`);
// Day `k` days before 2026-10-21 as an ISO day string (UTC math on a calendar day is exact).
function dayBefore(k) {
  const d = new Date(Date.UTC(2026, 9, 21) - k * 86400000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// A small graph with every node kind, one contradiction, one superseded fact, one low-confidence fact
// and one stale fact. `today` is 2026-10-21.
export function smallGraph() {
  const nodes = [
    { id: 'cm:Seen', label: 'Seen', group: 'cmd-entity', type: 'entity', origin: 'command', facts: [], meta: {} },
    { id: 'ch:knowledge/seen.md', label: 'Seen', group: 'knowledge', type: 'note', origin: 'chronos', facts: [], updated: '2026-10-21T15:02' },
    { id: 'ch:knowledge/collectors.md', label: 'Report collectors', group: 'knowledge', type: 'note', origin: 'chronos', facts: [] },
    { id: 'ch:people/brandon.md', label: 'Brandon', group: 'people', type: 'note', origin: 'chronos', facts: [] },
    { id: 'ch:decisions/no-hn.md', label: 'No Hacker News, ever', group: 'decisions', type: 'note', origin: 'chronos', facts: [] },
    { id: 'ch:timeline/2026-10-20.md', label: '2026-10-20', group: 'timeline', type: 'note', origin: 'chronos', facts: [] },
    { id: 'ch:timeline/2026-10-21.md', label: '2026-10-21', group: 'timeline', type: 'note', origin: 'chronos', facts: [] },
    { id: 'cm:growth', label: 'growth', group: 'dept', type: 'dept', origin: 'command', facts: [], meta: { title: 'Growth', charter: 'grow' } },
    { id: 'cm:Draft the Ghost Report', label: 'Draft the Ghost Report', group: 'thread', type: 'thread', origin: 'command', facts: [], meta: { area: 'growth', priority: 1, status: 'open' } },
    { id: 'live:repo:begindtheseen/seen', label: 'Seen repo', group: 'live-entity', type: 'entity', origin: 'live', meta: { kind: 'repo', repo: 'begindtheseen/seen' } },
    { id: 'live:branch:begindtheseen/seen:next-migration', label: '⌥ next-migration', group: 'live-branch', type: 'value', origin: 'live', meta: { kind: 'branch' } },
    { id: 'live:db', label: 'Seen DB (Supabase)', group: 'live-entity', type: 'entity', origin: 'live', meta: { kind: 'supabase' } },
    { id: 'live:db:jobs', label: 'jobs: 12,345', group: 'live-value', type: 'value', origin: 'live' },
  ];
  const links = [
    { source: 'ch:knowledge/seen.md', target: 'ch:knowledge/collectors.md', kind: 'link', origin: 'chronos' },
    { source: 'ch:knowledge/seen.md', target: 'ch:people/brandon.md', kind: 'link', origin: 'chronos' },
    { source: 'ch:decisions/no-hn.md', target: 'ch:knowledge/collectors.md', kind: 'link', origin: 'chronos' },
    { source: 'ch:timeline/2026-10-21.md', target: 'ch:knowledge/seen.md', kind: 'link', origin: 'chronos' },
    { source: 'ch:timeline/2026-10-20.md', target: 'ch:decisions/no-hn.md', kind: 'link', origin: 'chronos' },
    { source: 'cm:growth', target: 'cm:Draft the Ghost Report', kind: 'work', origin: 'command', valid_from: '2026-10-21T13:00' },
    { source: 'cm:Seen', target: 'ch:knowledge/seen.md', kind: 'bridge', origin: 'bridge', label: 'Seen' },
    { source: 'live:repo:begindtheseen/seen', target: 'live:branch:begindtheseen/seen:next-migration', kind: 'fact', origin: 'live', valid_from: '2026-10-21' },
    { source: 'live:db', target: 'live:db:jobs', kind: 'fact', origin: 'live', valid_from: '2026-10-21' },
  ];
  const fact = (subjId, subject, id, predicate, object, extra = {}) => {
    const vid = `ch:fact:knowledge/seen.md:${id}`;
    nodes.push({ id: vid, label: `${predicate} → ${object}`, group: 'value', type: 'value', origin: 'chronos', facts: [] });
    const edge = { source: subjId, target: vid, kind: 'fact', origin: 'chronos', subject, predicate, object,
      valid_from: null, valid_to: null, recorded: null, invalidated: null, confidence: 'high', note: 'knowledge/seen.md', factId: id, provenance: null, ...extra };
    links.push(edge);
    nodes.find((n) => n.id === subjId).facts.push(edge);
  };
  fact('ch:knowledge/seen.md', 'Seen', 'f1', 'users_total', '100', { valid_from: '2026-07-09', valid_to: '2026-10-20', recorded: '2026-07-09', invalidated: '2026-10-20' });
  fact('ch:knowledge/seen.md', 'Seen', 'f2', 'users_total', '120', { valid_from: '2026-10-20', recorded: '2026-10-20' });
  fact('ch:knowledge/seen.md', 'Seen', 'f3', 'plan', 'Free', { valid_from: '2026-10-21', recorded: '2026-10-21', confidence: 'low' });
  fact('ch:knowledge/seen.md', 'Seen', 'f4', 'plan', 'Pro', { valid_from: '2026-10-01', recorded: '2026-10-01' }); // contradicts f3
  fact('ch:knowledge/collectors.md', 'Report collectors', 'f5', 'sources', 'reddit archive', { valid_from: '2026-05-01', recorded: '2026-05-01' }); // stale (>90d)
  const deg = new Map();
  for (const l of links) { deg.set(l.source, (deg.get(l.source) || 0) + 1); deg.set(l.target, (deg.get(l.target) || 0) + 1); }
  for (const n of nodes) n.degree = deg.get(n.id) || 0;
  return {
    nodes, links, dateRange: { from: '2026-05-01', to: '2026-10-21' }, generated: '2026-10-21',
    vaultFound: true, stateFound: true, live: { supabase: true, github: true, nodes: 4 },
    counts: { total: { nodes: nodes.length, links: links.length } }, sources: { statePath: null, vaultPath: null },
  };
}

// A synthetic unified graph with exactly `n` nodes, spread over every cluster, with wiki-links, facts
// (some closed, some contradicting), command threads/depts, live repo nodes and bridges.
export function syntheticGraph(n = 3000, seed = 7) {
  const rnd = seededRandom(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const nodes = [];
  const links = [];
  const add = (node) => { node.facts = node.facts || []; nodes.push(node); return node; };
  const scale = n / 3000;
  const count = (k) => Math.max(1, Math.round(k * scale));

  add({ id: 'cm:Seen', label: 'Seen', group: 'cmd-entity', type: 'entity', origin: 'command', meta: {} });
  const folders = [['knowledge', 420], ['decisions', 120], ['people', 40], ['meta', 30], ['timeline', 220]];
  const notes = [];
  for (const [folder, k] of folders) {
    for (let i = 0; i < count(k); i++) {
      const id = folder === 'timeline' ? `ch:timeline/${dayBefore(i)}.md` : `ch:${folder}/${folder}-${i}.md`;
      const label = folder === 'timeline' ? dayBefore(i) : `${folder} note ${i}`;
      notes.push(add({ id, label, group: folder, type: 'note', origin: 'chronos', updated: `${dayBefore(Math.floor(rnd() * 120))}T${pad(Math.floor(rnd() * 24))}:${pad(Math.floor(rnd() * 60))}` }));
    }
  }
  const themes = ['collector', 'Greenhouse board', 'creator outreach', 'deploy', 'Supabase table', 'pricing tier', 'Seen metric', 'misc'];
  const entities = [];
  for (let i = 0; i < count(360); i++) entities.push(add({ id: `ch:entity:e${i}`, label: `${pick(themes)} ${i}`, group: 'entity', type: 'entity', origin: 'chronos' }));
  const depts = [];
  for (const d of ['growth', 'product', 'reliability', 'revenue', 'data', 'strategy', 'platform']) depts.push(add({ id: `cm:${d}`, label: d, group: 'dept', type: 'dept', origin: 'command', meta: { title: d } }));
  for (let i = 0; i < count(120); i++) {
    const d = pick(depts);
    const t = add({ id: `cm:thread ${i}`, label: `Work thread ${i}`, group: 'thread', type: 'thread', origin: 'command', meta: { area: d.label, priority: 1 + (i % 3), status: 'open' } });
    links.push({ source: d.id, target: t.id, kind: 'work', origin: 'command', valid_from: '2026-10-21T13:00' });
  }
  const repo = add({ id: 'live:repo:begindtheseen/seen', label: 'Seen repo', group: 'live-entity', type: 'entity', origin: 'live', meta: { kind: 'repo' } });
  for (let i = 0; i < count(60); i++) {
    const b = add({ id: `live:branch:seen:b${i}`, label: `⌥ branch-${i}`, group: i % 3 ? 'live-branch' : 'live-pr', type: 'value', origin: 'live', meta: { kind: i % 3 ? 'branch' : 'pr' } });
    links.push({ source: repo.id, target: b.id, kind: 'fact', origin: 'live', valid_from: '2026-10-21' });
  }
  // wiki-links between notes (preferential: low indices are hubs)
  for (let i = 0; i < notes.length; i++) {
    const k = 1 + Math.floor(rnd() * 3);
    for (let j = 0; j < k; j++) {
      const t = notes[Math.floor(Math.pow(rnd(), 2.2) * notes.length)];
      if (t !== notes[i]) links.push({ source: notes[i].id, target: t.id, kind: 'link', origin: 'chronos' });
    }
  }
  // facts until the graph has exactly n nodes
  const subjects = notes.concat(entities);
  let f = 0;
  while (nodes.length < n) {
    const s = f % 9 === 0 ? nodes[0] : subjects[Math.floor(Math.pow(rnd(), 1.6) * subjects.length)];
    const pred = `p${Math.floor(rnd() * 6)}`;
    const from = dayBefore(Math.floor(rnd() * 200));
    const closed = rnd() < 0.2;
    const vid = `ch:fact:${s.id}:${f}`;
    add({ id: vid, label: `${pred} → v${f}`, group: s.origin === 'command' ? 'cmd-value' : 'value', type: 'value', origin: s.origin });
    const edge = { source: s.id, target: vid, kind: 'fact', origin: s.origin, subject: s.label, predicate: pred, object: `v${f}`,
      valid_from: from, valid_to: closed ? dayBefore(Math.floor(rnd() * 30)) : null, recorded: from, invalidated: null,
      confidence: rnd() < 0.1 ? 'low' : 'high', note: null, factId: `f${f}`, provenance: null };
    links.push(edge); s.facts.push(edge); f++;
  }
  // a few bridges (command entity ↔ vault note)
  links.push({ source: 'cm:Seen', target: notes[0].id, kind: 'bridge', origin: 'bridge', label: 'Seen' });
  const deg = new Map();
  for (const l of links) { deg.set(l.source, (deg.get(l.source) || 0) + 1); deg.set(l.target, (deg.get(l.target) || 0) + 1); }
  for (const x of nodes) x.degree = deg.get(x.id) || 0;
  return {
    nodes, links, dateRange: { from: dayBefore(220), to: '2026-10-21' }, generated: '2026-10-21',
    vaultFound: true, stateFound: true, live: null,
    counts: { total: { nodes: nodes.length, links: links.length } }, sources: { statePath: null, vaultPath: null }, synthetic: true,
  };
}
