// lib/ui/brain-client.js — the Brain tab's pure time/origin filter over the /api/brain/graph payload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
function load() {
  const window = {};
  const document = { addEventListener() {}, getElementById() { return null; }, querySelectorAll() { return []; }, hidden: false };
  new Function('window', 'document', 'location', 'localStorage', 'navigator', readFileSync(join(HERE, 'brain-client.js'), 'utf8'))(
    window, document, { protocol: 'file:' }, { getItem() { return null; }, setItem() {} }, {});
  return window;
}
const W = load();
const graphAt = W.__brainGraphAt;

// End of a California day, in ms (what the slider hands the filter).
const endOfPtDay = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); const next = Date.UTC(y, m - 1, d + 1, 7, 0); return next - 1; }; // PDT (Oct)

const G = {
  nodes: [
    { id: 'ch:knowledge/seen.md', label: 'seen', type: 'note', origin: 'chronos' },
    { id: 'ch:entity:Seen', label: 'Seen', type: 'entity', origin: 'chronos' },
    { id: 'ch:fact:a', label: '$0', type: 'value', origin: 'chronos' },
    { id: 'ch:fact:b', label: '$10', type: 'value', origin: 'chronos' },
    { id: 'ch:fact:c', label: '7', type: 'value', origin: 'chronos' },
    { id: 'cm:Seen', label: 'Seen', type: 'entity', origin: 'command' },
    { id: 'cm:users', label: 'users: 7', type: 'value', origin: 'command' },
  ],
  links: [
    { source: 'ch:entity:Seen', target: 'ch:fact:a', kind: 'fact', subject: 'Seen', predicate: 'mrr', object: '$0', valid_from: '2026-10-01', valid_to: '2026-10-20' },
    { source: 'ch:entity:Seen', target: 'ch:fact:b', kind: 'fact', subject: 'Seen', predicate: 'mrr', object: '$10', valid_from: '2026-10-20', valid_to: null },
    { source: 'ch:entity:Seen', target: 'ch:fact:c', kind: 'fact', subject: 'Seen', predicate: 'users', object: '7', valid_from: '2026-10-22T03:00', valid_to: null },
    { source: 'cm:Seen', target: 'cm:users', kind: 'fact', valid_from: null, valid_to: null },
    { source: 'cm:Seen', target: 'ch:entity:Seen', kind: 'bridge' },
    { source: 'ch:knowledge/seen.md', target: 'ch:entity:Seen', kind: 'link' },
  ],
  counts: { total: { nodes: 7, links: 6 } }, dateRange: { from: '2026-10-01', to: '2026-10-22' },
};

test('now, every brain shown: the payload passes through untouched', () => {
  const v = graphAt(G, null, {});
  assert.equal(v.nodes.length, G.nodes.length);
  assert.equal(v.links.length, G.links.length);
  assert.deepEqual(v.factCounts, { active: 3, superseded: 1, future: 0 });
  assert.equal(v.counts, G.counts, 'everything else is the same object');
});

test('as of a past California day: not-yet-known facts drop out, later supersessions are undone', () => {
  const v = graphAt(G, endOfPtDay('2026-10-10'), {});
  const ids = v.nodes.map((n) => n.id);
  assert.ok(ids.includes('ch:fact:a'));
  assert.ok(!ids.includes('ch:fact:b') && !ids.includes('ch:fact:c'), 'values whose fact did not exist yet are pruned');
  assert.ok(ids.includes('ch:knowledge/seen.md'), 'notes stay — the skeleton');
  const a = v.links.find((l) => l.target === 'ch:fact:a');
  assert.equal(a.valid_to, null, 'on Oct 10 $0 was still the answer');
  assert.equal(G.links[0].valid_to, '2026-10-20', 'the original payload is never mutated');
  assert.deepEqual(v.factCounts, { active: 2, superseded: 0, future: 2 });
});

test('a bare day is a California day, a zone-less minute is UTC', () => {
  const oct21 = graphAt(G, endOfPtDay('2026-10-21'), {});
  assert.ok(oct21.nodes.some((n) => n.id === 'ch:fact:c'), '03:00 UTC on the 22nd is 8 PM on the 21st in California');
  const oct20 = graphAt(G, endOfPtDay('2026-10-20'), {});
  assert.ok(!oct20.nodes.some((n) => n.id === 'ch:fact:c'));
  assert.equal(oct20.links.find((l) => l.target === 'ch:fact:a').valid_to, '2026-10-20', 'superseded at midnight Oct 20 — history by the end of that day');
  assert.equal(oct20.factCounts.superseded, 1);
});

test('origins: hiding the board meeting drops its nodes and every link that touched them; bridges toggle alone', () => {
  const v = graphAt(G, null, { command: false });
  assert.ok(!v.nodes.some((n) => n.origin === 'command'));
  assert.ok(!v.links.some((l) => l.kind === 'bridge'));
  const nb = graphAt(G, null, { bridge: false });
  assert.equal(nb.nodes.length, G.nodes.length, 'no node is a bridge');
  assert.equal(nb.links.filter((l) => l.kind === 'bridge').length, 0);
});

test('the Brain tab hooks the dashboard calls are defined', () => {
  for (const k of ['brainTab', 'openBrain', 'refreshBrain', 'prefillBoardRoom']) assert.equal(typeof W[k], 'function', k);
  // window.askBoardRoom is the chat's SEND function (the dashboard owns it); the Brain tab must never replace it.
  assert.equal(W.askBoardRoom, undefined, 'brain-client must not define window.askBoardRoom');
});
