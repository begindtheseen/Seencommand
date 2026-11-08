import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import {
  buildModel, computeLayout, searchNodes, changeSet, nodeDetail, parseWhen, formatPacific, baseCluster, CORE_ID, CLUSTERS,
  findContradictions,
} from './layout.mjs';
import { smallGraph, syntheticGraph } from './layout.fixtures.mjs';
import { transformLayoutSource, extractInlined, LAYOUT_PATH, BROWSER_PATH } from './build-brain-graph.mjs';
import { buildUnifiedGraph } from '../unify.mjs';

const laid = (data, opts) => { const m = buildModel(data, opts); computeLayout(m); return m; };
const NOW = Date.parse('2026-10-21T20:00:00Z'); // 1 PM California time

test('layout is deterministic: the same data gives the same picture', () => {
  for (const data of [smallGraph(), syntheticGraph(600)]) {
    const a = laid(data), b = laid(JSON.parse(JSON.stringify(data)));
    assert.deepEqual(a.nodes.map((n) => [n.id, n.x, n.y]), b.nodes.map((n) => [n.id, n.x, n.y]));
    assert.deepEqual(a.layout, b.layout);
  }
});

test('layout is bounded: every node sits inside the disc, the core at the center', () => {
  for (const data of [smallGraph(), syntheticGraph(3000)]) {
    const m = laid(data);
    const { R, r0 } = m.layout;
    const core = m.byId.get(m.coreId);
    assert.equal(core.x, 0); assert.equal(core.y, 0);
    for (const n of m.nodes) {
      assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y), `${n.id} has a finite position`);
      assert.ok(Math.hypot(n.x, n.y) + n.radius <= R + 1e-6, `${n.id} is inside R`);
      if (n !== core) assert.ok(Math.hypot(n.x, n.y) - n.radius >= r0 - 1e-6, `${n.id} keeps clear of the core`);
    }
  }
});

test('clusters are separated: each node lies in its own sector and sectors do not overlap', () => {
  const m = laid(syntheticGraph(3000));
  const { sectors } = m.layout;
  assert.ok(sectors.length >= 8, 'the synthetic graph fills (almost) every cluster');
  const TAU = 2 * Math.PI;
  const rel = (ang, a0) => { let d = (ang - a0) % TAU; if (d < 0) d += TAU; return d; };
  for (let i = 0; i < sectors.length; i++) {
    const s = sectors[i], next = sectors[(i + 1) % sectors.length];
    assert.ok(rel(next.a0, s.a0) >= s.span - 1e-9 || sectors.length === 1, `${s.id} ends before ${next.id} begins`);
  }
  const byId = new Map(sectors.map((s) => [s.id, s]));
  for (const n of m.nodes) {
    if (n.cluster === 'core') continue;
    const s = byId.get(n.cluster);
    const d = rel(Math.atan2(n.y, n.x), s.a0);
    assert.ok(d <= s.span + 1e-6, `${n.id} (${n.cluster}) is inside its sector`);
  }
  // centroids are distinct and each centroid is closest to its own sector's middle direction
  for (const s of sectors) {
    const mid = s.a0 + s.span / 2;
    const best = sectors.reduce((b, t) => {
      const d = Math.hypot(Math.cos(t.a0 + t.span / 2) - Math.cos(Math.atan2(s.cy, s.cx)), Math.sin(t.a0 + t.span / 2) - Math.sin(Math.atan2(s.cy, s.cx)));
      return d < b.d ? { id: t.id, d } : b;
    }, { id: null, d: Infinity });
    assert.equal(best.id, s.id, `${s.id} centroid points at its own sector (mid ${mid.toFixed(2)})`);
  }
});

test('nodes do not overlap once the layout settles', () => {
  const m = laid(syntheticGraph(3000));
  const nodes = m.nodes;
  // grid check (O(n)) — the layout's own settle phase runs until a pass finds no overlap
  const cell = 30, grid = new Map();
  nodes.forEach((n, i) => { const k = `${Math.floor(n.x / cell)},${Math.floor(n.y / cell)}`; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });
  let overlaps = 0;
  nodes.forEach((a, i) => {
    const gx = Math.floor(a.x / cell), gy = Math.floor(a.y / cell);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const j of grid.get(`${gx + dx},${gy + dy}`) || []) {
        if (j <= i) continue;
        const b = nodes[j];
        if (Math.hypot(a.x - b.x, a.y - b.y) < a.radius + b.radius - 0.5) overlaps++;
      }
    }
  });
  assert.ok(overlaps <= nodes.length * 0.002, `overlaps: ${overlaps}`);
});

test('3,000 nodes are modelled and laid out in under 1.5 s', () => {
  const data = syntheticGraph(3000);
  const t0 = performance.now();
  const m = buildModel(data);
  computeLayout(m);
  const ms = performance.now() - t0;
  assert.equal(m.nodes.length, 3000);
  assert.ok(ms < 1500, `took ${Math.round(ms)} ms`);
});

test('the real "Seen" node is the core; without one a labelled anchor stands in', () => {
  const m = buildModel(smallGraph());
  assert.equal(m.coreId, 'ch:knowledge/seen.md', 'the best-connected Seen node wins');
  const g = smallGraph();
  g.nodes = g.nodes.filter((n) => n.label !== 'Seen');
  g.links = g.links.filter((l) => !/seen\.md|cm:Seen/.test(`${l.source} ${l.target}`));
  const m2 = buildModel(g);
  assert.equal(m2.coreId, CORE_ID);
  assert.equal(m2.byId.get(CORE_ID).virtual, true);
  computeLayout(m2);
});

test('clusters: types map to the right sector, values follow their subject', () => {
  assert.equal(baseCluster({ type: 'thread', group: 'thread' }), 'work');
  assert.equal(baseCluster({ type: 'note', group: 'people' }), 'people');
  assert.equal(baseCluster({ type: 'note', group: 'decisions' }), 'decisions');
  assert.equal(baseCluster({ type: 'note', group: 'timeline' }), 'timeline');
  assert.equal(baseCluster({ type: 'value', group: 'live-branch', meta: { kind: 'branch' } }), 'infra');
  assert.equal(baseCluster({ type: 'entity', group: 'cmd-entity', label: 'RESEND_KEY' }), 'infra');
  assert.equal(baseCluster({ type: 'note', group: 'knowledge', origin: 'chronos', id: 'ch:knowledge/collectors.md', label: 'Report collectors' }), 'collectors');
  assert.equal(baseCluster({ type: 'note', group: 'knowledge', label: 'Some idea' }), 'knowledge');
  const m = buildModel(smallGraph());
  assert.equal(m.byId.get('ch:fact:knowledge/seen.md:f5').cluster, 'collectors', 'a value sits with its subject');
  assert.equal(m.byId.get('ch:fact:knowledge/seen.md:f1').cluster, 'product', "the core's own facts are product metrics");
  for (const n of m.nodes) assert.ok(n.cluster === 'core' || CLUSTERS.some((c) => c.id === n.cluster), `${n.id} has a known cluster`);
});

test('importance: degree, recency and fact count make a node heavier', () => {
  const m = buildModel(syntheticGraph(1200));
  const core = m.byId.get(m.coreId);
  assert.equal(core.importance, 1);
  const notes = m.nodes.filter((n) => n.type === 'note');
  const hub = notes.reduce((a, b) => (b.degree > a.degree ? b : a));
  const leaf = notes.filter((n) => n.degree === 1 && n.factCount === 0).sort((a, b) => (a.lastChange || 0) - (b.lastChange || 0))[0];
  assert.ok(hub.importance > leaf.importance, 'a hub outweighs a single-link note');
  assert.ok(hub.radius > leaf.radius, 'and is drawn bigger');
  // recency alone: two otherwise identical entities
  const g = { nodes: [
    { id: 'a', label: 'Seen', type: 'entity', group: 'cmd-entity', origin: 'command' },
    { id: 'old', label: 'old', type: 'entity', group: 'entity', origin: 'chronos' },
    { id: 'new', label: 'new', type: 'entity', group: 'entity', origin: 'chronos' },
    { id: 'v1', label: 'p → 1', type: 'value', group: 'value' }, { id: 'v2', label: 'p → 2', type: 'value', group: 'value' },
  ], links: [
    { source: 'old', target: 'v1', kind: 'fact', subject: 'old', predicate: 'p', object: '1', valid_from: '2025-01-01' },
    { source: 'new', target: 'v2', kind: 'fact', subject: 'new', predicate: 'p', object: '2', valid_from: '2026-10-20' },
  ], dateRange: { from: '2025-01-01', to: '2026-10-21' } };
  const m2 = buildModel(g);
  assert.ok(m2.byId.get('new').importance > m2.byId.get('old').importance, 'recent beats old');
});

test('search ranks exact > prefix > word > substring > fact, and the hub wins ties', () => {
  const m = buildModel(smallGraph());
  const ids = (q) => searchNodes(m, q).map((r) => r.node.id);
  assert.equal(ids('seen')[0], m.coreId, 'exact label; the heavier Seen (the core) first');
  assert.ok(ids('seen').includes('cm:Seen'));
  assert.equal(ids('report')[0], 'ch:knowledge/collectors.md', 'prefix');
  assert.equal(ids('collectors')[0], 'ch:knowledge/collectors.md', 'word inside a label');
  assert.equal(ids('hacker')[0], 'ch:decisions/no-hn.md');
  assert.ok(ids('reddit archive').includes('ch:knowledge/collectors.md'), 'fact objects are searchable');
  assert.deepEqual(ids(''), []);
  assert.deepEqual(ids('zzzz-no-such-thing'), []);
  const r = searchNodes(m, 'users_total');
  assert.ok(r.length && r[0].node.type === 'value', 'value labels match too');
});

test('change detection: started, superseded and edited inside the window', () => {
  const m = buildModel(smallGraph(), { now: NOW });
  const day = changeSet(m, NOW, 86400000);
  assert.ok(day.get('ch:fact:knowledge/seen.md:f3').added >= 1, 'a fact valid from today glows');
  assert.ok(day.get('ch:knowledge/seen.md').edited, 'the note edited this morning glows');
  assert.ok(!day.has('ch:fact:knowledge/seen.md:f1'), 'closed yesterday (California) is outside 24h');
  const week = changeSet(m, NOW, 7 * 86400000);
  assert.ok(week.get('ch:fact:knowledge/seen.md:f1').superseded >= 1, 'the superseded value shows in 7 days');
  assert.ok(week.get('ch:fact:knowledge/seen.md:f2').added >= 1);
  assert.ok(!week.has('ch:fact:knowledge/collectors.md:f5'), 'a May fact is not a recent change');
});

test('node detail: current facts, history, contradictions, stale and low-confidence flags', () => {
  const m = buildModel(smallGraph(), { now: NOW });
  const d = nodeDetail(m, 'ch:knowledge/seen.md', NOW);
  assert.deepEqual(d.current.map((f) => f.factId).sort(), ['f2', 'f3', 'f4']);
  assert.deepEqual(d.history.map((f) => f.factId), ['f1']);
  assert.equal(d.contradictions.length, 1, 'plan Free vs Pro, counted once');
  assert.equal(d.contradictions[0].predicate, 'plan');
  assert.deepEqual(d.lowConfidence.map((f) => f.factId), ['f3']);
  assert.ok(d.neighbors.some((x) => x.node.id === 'ch:people/brandon.md'));
  const c = nodeDetail(m, 'ch:knowledge/collectors.md', NOW);
  assert.deepEqual(c.stale.map((f) => f.factId), ['f5'], 'an open fact with no news for 90+ days is stale');
  assert.equal(nodeDetail(m, 'nope', NOW), null);
});

test('dates: California days and minutes, shown in California time', () => {
  assert.equal(parseWhen('2026-07-01'), Date.UTC(2026, 6, 1, 7), 'PDT midnight');
  assert.equal(parseWhen('2026-12-01'), Date.UTC(2026, 11, 1, 8), 'PST midnight');
  assert.equal(parseWhen('2026-10-21T15:02'), Date.UTC(2026, 9, 21, 15, 2), 'minute stamps are UTC');
  assert.equal(parseWhen(null), null);
  assert.equal(formatPacific('2026-10-21'), 'Oct 21, 2026', 'a day stays that day');
  assert.equal(formatPacific('2026-10-21T15:02'), 'Oct 21, 2026, 8:02 AM PT');
  assert.equal(formatPacific('2026-10-22T03:30'), 'Oct 21, 2026, 8:30 PM PT', 'UTC after midnight is still the 21st in California');
});

test('works on the exact payload buildUnifiedGraph returns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'layout-'));
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    generatedAt: '2026-10-21T13:00:00.000Z',
    threads: [{ id: 't1', title: 'Ship it', area: 'product', priority: 1, status: 'open' }],
    departments: [{ id: 'product', title: 'Product', charter: 'build' }],
    memoryGraph: {
      nodes: [{ id: 'Seen', label: 'Seen', group: 'entity' }, { id: 'mrr', label: 'mrr: $0', group: 'value' },
        { id: 'product', label: 'product', group: 'dept' }, { id: 'Ship it', label: 'Ship it', group: 'thread' }],
      links: [{ source: 'Seen', target: 'mrr', kind: 'fact' }, { source: 'product', target: 'Ship it', kind: 'work' }],
    },
  }));
  const g = buildUnifiedGraph({ statePath: join(dir, 'state.json'), vaultPath: null, today: '2026-10-21' });
  const m = buildModel(JSON.parse(JSON.stringify(g)), { now: NOW }); // over the wire it is JSON
  computeLayout(m);
  assert.equal(m.coreId, 'cm:Seen');
  assert.equal(m.byId.get('cm:Ship it').cluster, 'work');
  assert.equal(m.byId.get('cm:mrr').cluster, 'product', "the core's facts are product metrics");
  const empty = buildModel({ nodes: [], links: [] });
  const L = computeLayout(empty);
  assert.equal(empty.nodes.length, 1, 'an empty graph still has its anchor');
  assert.ok(L.R > 0);
});

test('the browser copy in lib/ui/brain-graph.js is exactly layout.mjs and computes the same layout', () => {
  const browser = readFileSync(BROWSER_PATH, 'utf8');
  const inlined = extractInlined(browser);
  assert.ok(inlined, 'brain-graph.js has its BEGIN/END layout markers');
  assert.equal(inlined, transformLayoutSource(readFileSync(LAYOUT_PATH, 'utf8')),
    'stale copy — run: node brain/lib/chronos/build-brain-graph.mjs');
  const api = vm.runInNewContext(`${inlined}\n;({ buildModel, computeLayout, searchNodes });`, { Intl, Date, Math, Map, Set, Number, String, Array, Object, Float64Array, Int32Array, Uint8Array, JSON });
  const data = syntheticGraph(400);
  const a = buildModel(data); computeLayout(a);
  const b = api.buildModel(JSON.parse(JSON.stringify(data))); api.computeLayout(b);
  const plain = (v) => JSON.parse(JSON.stringify(v)); // the vm's arrays belong to another realm
  assert.deepEqual(plain(b.nodes.map((n) => [n.id, n.x, n.y, n.cluster])), a.nodes.map((n) => [n.id, n.x, n.y, n.cluster]));
  assert.deepEqual(plain(api.searchNodes(b, 'knowledge note 1').map((r) => r.node.id)), searchNodes(a, 'knowledge note 1').map((r) => r.node.id));
});

test('contradictions: only two CURRENT facts that disagree — closed history and rewordings are not conflicts', () => {
  const f = (object, valid_from, valid_to = null, extra = {}) => ({ kind: 'fact', subject: 'Seen', predicate: 'active_jobs', object, valid_from, valid_to, source: 'a', target: 'b', ...extra });
  // past readings closed by later ones vs. a long-lived board snapshot: history, not conflict
  assert.equal(findContradictions([f('1000', '2026-07-09', '2026-07-10'), f('2000', '2026-07-09', '2026-10-21'), f('30000', '2026-10-21')]).length, 0);
  assert.equal(findContradictions([f('1000', '2026-07-09', null, { invalidated: '2026-07-10' }), f('2000', '2026-07-09')]).length, 0);
  // a rewording of the same claim
  assert.equal(findContradictions([f('live', '2026-07-05', null, { predicate: 'status' }), f('live (noreply@seenjobs.io verified)', '2026-07-09', null, { predicate: 'status' })]).length, 0);
  // two current facts that really disagree
  const c = findContradictions([f('Free', '2026-10-21', null, { predicate: 'plan' }), f('Pro', '2026-10-01', null, { predicate: 'plan' })]);
  assert.equal(c.length, 1); assert.equal(c[0].predicate, 'plan');
});
