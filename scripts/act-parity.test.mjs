// Chat ↔ button parity (owner, 2026-10-21: "this chat bot should be able to do everything"). Anything
// Brandon can do with a button in Seen Command, the Board Room chat must be able to do with one
// `node scripts/act.mjs <verb>` — and the chat prompt must say so. No network, no app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { ROUTES, uiWriteCalls, matches, isWrite, parityDoc, pathPattern } from '../lib/act-parity.mjs';
import { ACT_VERBS } from '../lib/act-catalog.mjs';
import { _internals } from '../engine/agent-chat.mjs';

const REPO = new URL('..', import.meta.url).pathname;
const read = (p) => readFileSync(`${REPO}${p}`, 'utf8');
const UI_FILES = ['scripts/build-dashboard.mjs', ...readdirSync(`${REPO}lib/ui`).filter((f) => f.endsWith('.js')).map((f) => `lib/ui/${f}`), 'lib/aggregation/dashboard-client.js'];
const VERBS = (() => { try { execFileSync(process.execPath, [`${REPO}scripts/act.mjs`], { encoding: 'utf8' }); } catch (e) { return JSON.parse(e.stdout).verbs; } return []; })();

// The ONLY write routes a button may use without an act verb. Each is deliberate (owner rules):
const UI_ONLY = {
  'POST /api/chat': 'the chat itself — calling it from the chat would recurse',
  'POST /api/chat/stream': 'the chat itself — calling it from the chat would recurse',
  'POST /api/growth/library': 'uploads the PNG the browser rendered in the ad designer; the chat has no image',
  'POST /api/brain/access/issue': 'its answer is a brand-new credential secret — never through the chat',
  'POST /api/brain/access/rotate': 'its answer is a replacement credential secret — never through the chat',
  'POST /api/brain/access/copy-once': 'puts a credential secret on the clipboard — never through the chat',
};

test('every write call the UI makes is a known route (a new button cannot skip the parity table)', () => {
  const calls = uiWriteCalls(Object.fromEntries(UI_FILES.map((f) => [f, read(f)])));
  assert.ok(calls.length > 60, `found ${calls.length} UI write calls — the extractor is reading the UI`);
  const unresolved = calls.filter((c) => !c.pattern);
  assert.deepEqual(unresolved, [], 'a UI write call whose path the parity reader cannot resolve (teach lib/act-parity.mjs its helper)');
  const unknown = calls.filter((c) => !ROUTES.some((r) => matches(r, c.method, c.pattern)));
  assert.deepEqual(unknown.map((c) => `${c.method} ${c.pattern} (${c.file})`), [], 'UI write calls with no row in lib/act-parity.mjs ROUTES');
});

test('every UI write route has an act verb, except the commented UI-only list', () => {
  const missing = ROUTES.filter((r) => isWrite(r.m) && r.ui && !r.verbs.length && !UI_ONLY[`${r.m} ${r.path}`]);
  assert.deepEqual(missing.map((r) => `${r.m} ${r.path}`), [], 'a button the chat cannot press');
  const allowed = ROUTES.filter((r) => r.allow).map((r) => `${r.m} ${r.path}`).sort();
  assert.deepEqual(allowed, Object.keys(UI_ONLY).sort(), 'UI-only routes must be listed (with the reason) in this test too');
  for (const r of ROUTES.filter((x) => x.allow)) assert.equal(r.verbs.length, 0, `${r.path} is UI-only but names a verb`);
});

test('every verb the table names exists in act.mjs, and the catalog lists exactly the verbs act.mjs has', () => {
  assert.ok(VERBS.length > 100, `act.mjs answered with ${VERBS.length} verbs`);
  const named = [...new Set(ROUTES.flatMap((r) => r.verbs))];
  assert.deepEqual(named.filter((v) => !VERBS.includes(v)), [], 'a table row names a verb act.mjs does not have');
  const cat = ACT_VERBS.map((v) => v.name);
  assert.equal(new Set(cat).size, cat.length, 'a verb is in the catalog twice');
  assert.deepEqual(VERBS.filter((v) => !cat.includes(v)), [], 'act.mjs verbs missing from lib/act-catalog.mjs');
  assert.deepEqual(cat.filter((v) => !VERBS.includes(v)), [], 'catalog verbs act.mjs does not have');
});

test('the chat prompt names every verb and treats Brandon asking as the approval', () => {
  const p = _internals.appendSystemPrompt('');
  const missing = VERBS.filter((v) => !p.includes(`\`${v}\``) && !p.includes(`\`${v} `)); // the whole verb, not a prefix of another
  assert.deepEqual(missing, [], 'verbs the chat is never told about');
  assert.match(p, /Brandon asking IS the approval/);
  assert.match(p, /Never answer "I can't" when a verb exists/);
  assert.match(p, /file `ticket-new` with what would have helped/);
  assert.match(p, /`approve`\/`deny` \(he names or clearly means that approval\)/);
  assert.match(p, /never open or reveal a credential VALUE/);
});

test('the chat stays on named verbs: no new shell rule beyond act.mjs + ops.mjs', () => {
  const tools = _internals.allowedTools().filter((t) => /^Bash\(node /.test(t));
  assert.deepEqual(tools.sort(), ['Bash(node scripts/act.mjs:*)', 'Bash(node scripts/ops.mjs:*)']);
});

test('docs/ACT_PARITY.md is generated from the table and current (node scripts/act-parity-doc.mjs)', () => {
  assert.equal(read('docs/ACT_PARITY.md'), parityDoc());
});

test('every new server route the table adds is really served by engine/server.mjs', () => {
  const server = read('engine/server.mjs');
  for (const path of ['/api/tasks/new', '/api/agents/setup']) assert.ok(server.includes(`path === '${path}'`), path);
});

test('pathPattern turns a UI path expression into a route pattern', () => {
  assert.equal(pathPattern("'/api/tickets/' + encodeURIComponent(t.id) + '/' + verb"), '/api/tickets/:p/:p');
  assert.equal(pathPattern("igP()+'/unresolved/'+encodeURIComponent(b.dataset.k)"), '/api/instagram/projects/:p/unresolved/:p');
  assert.equal(pathPattern("'/api/jobs?' + qsOf(next)"), '/api/jobs');
  assert.equal(pathPattern("base + '/merge'"), '/api/prs/:p/:p/:p/merge');
});
