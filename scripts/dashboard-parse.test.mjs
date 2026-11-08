import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('generated dashboard script parses, including Intelligence Runtime controls', () => {
  const html = readFileSync(join(import.meta.dirname, '..', 'public', 'command-center.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(script, 'dashboard script exists');
  assert.doesNotThrow(() => new Function(script[1]));
  assert.match(html, /data-tab="intelligence"/);
  assert.match(html, /class="intel-cancel"/);
});

// The kick-out regression (2026-08-13): a new board meeting hard-reloaded the page out from under the
// user. The baked page must carry the soft-reload machinery, and neither the 60s runId poll nor the
// chat action path may call location.reload() directly — only softReload() (which preserves tab+draft)
// or the refresh chip are allowed to trigger navigation.
test('dashboard never hard-reloads out from under the user', () => {
  const html = readFileSync(join(import.meta.dirname, '..', 'public', 'command-center.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.match(script, /function softReload\(/);
  assert.match(script, /function uiBusy\(/);
  assert.match(script, /function showRefreshChip\(/);
  assert.match(html, /\.refresh-chip\{/);
  // The only location.reload() left in the whole script is the one INSIDE softReload().
  const reloads = script.match(/location\.reload\(\)/g) || [];
  assert.equal(reloads.length, 1, `expected exactly 1 location.reload (inside softReload), found ${reloads.length}`);
  const softReloadBody = script.match(/function softReload\(\)\{[\s\S]*?location\.reload\(\)/);
  assert.ok(softReloadBody, 'the remaining location.reload lives inside softReload');
  // The poll routes through busy-detection, and chat actions route through the chip — never a reload.
  assert.match(script, /if\(uiBusy\(\)\)showRefreshChip\(\);else softReload\(\)/);
  assert.match(script, /if\(a\.type==='reload'\)\{showRefreshChip\(\);/);
});

// The refresh loop (2026-08-13): the bundled state.json was dated 2026-07-09 while the live runId was
// from today, so the poll's "live !== baked" test answered yes forever and every reload re-served the
// same stale bake — a hard refresh every 60 seconds, permanently. A reload can only help if the page
// comes back newer, so the poll must act at most ONCE per run id.
test('the runId poll refreshes at most once per run, so a stale bake cannot loop', () => {
  const html = readFileSync(join(import.meta.dirname, '..', 'public', 'command-center.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const poll = script.match(/if\(LIVE\)\{setInterval\([\s\S]*?,60000\);\}/);
  assert.ok(poll, 'the 60s runId poll exists');
  assert.match(poll[0], /sc-run-acted/, 'remembers which run it already acted on');
  assert.match(poll[0], /if\(acted===s\.runId\)return/, 'a run already acted on never refreshes again');
  // The guard must be set BEFORE deciding to reload, or a reload races past the write.
  assert.ok(poll[0].indexOf('setItem') < poll[0].indexOf('softReload()'),
    'the run id is recorded before the reload, not after');
});

test('Search is wired: one box, the collectors under Advanced, Home and Notifications screens, no web fonts', () => {
  const html = readFileSync(join(import.meta.dirname, '..', 'public', 'command-center.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  for (const t of ['home', 'search', 'notifications', 'boardroom']) assert.match(html, new RegExp(`data-tab="${t}"`));
  assert.match(html, /id="tab-home"/); assert.match(html, /id="tab-search"/); assert.match(html, /id="tab-notifications"/);
  assert.match(html, /<details class="adv" id="agg-adv">/);
  for (const t of ['overview', 'company_intel', 'indeed', 'company_jobs', 'history', 'health', 'schedules']) assert.match(html, new RegExp(`data-agg-tab="${t}"`));
  assert.match(script, /window\.loadAggregation = function/);
  assert.match(script, /window\.loadHome = function/); assert.match(script, /window\.loadSearch = function/); assert.match(script, /window\.loadNotifications = function/);
  assert.match(script, /if\(name==='aggregation'\)\{name='search'/, 'old links to the Aggregation tab land on Search');
  assert.doesNotMatch(html, /fonts\.googleapis\.com/, 'no render-blocking web fonts');
  assert.match(html, /<section class="tab" id="tab-home">/, 'Home is the landing tab');
});
