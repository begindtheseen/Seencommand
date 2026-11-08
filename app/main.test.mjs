// Static guards on the Electron shell (app/main.js).
//
// main.js requires the electron runtime, so it cannot be imported in a plain node:test process. These
// are source-level assertions in the same spirit as scripts/dashboard-parse.test.mjs, and they exist
// because of a specific, repeatedly-reported complaint: "I literally get kicked off of whatever I'm
// doing on seen command and forced back to the chat."
//
// Two causes lived here. ⌘R — the universal reload chord — was bound to "Run new board meeting",
// so a reflexive refresh both spent real model calls and hard-reloaded the window. And every reload
// path called win.reload() directly, which is a hard navigation that lands on the default tab and
// discards a half-typed message instead of going through the page's place-preserving softReload().

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const main = readFileSync(join(import.meta.dirname, 'main.js'), 'utf8');

test('the board meeting is NOT bound to the reload chord', () => {
  const meeting = /\{[^\n]*Run new board meeting[^\n]*\}/.exec(main);
  assert.ok(meeting, 'the board meeting menu item still exists');
  assert.doesNotMatch(meeting[0], /CmdOrCtrl\+R'/, 'a reflexive ⌘R must never spend a board meeting');
  assert.match(meeting[0], /accelerator:\s*'CmdOrCtrl\+Shift\+M'/);
});

test('reloading goes through the page softReload so the tab and draft survive', () => {
  const fn = /function reloadWindow\(\)[\s\S]*?\n\}/.exec(main);
  assert.ok(fn, 'reloadWindow exists');
  assert.match(fn[0], /__softReload/, 'must drive the page place-preserving reload');
  // A hard reload may remain ONLY as the fallback when the page lacks softReload.
  assert.match(fn[0], /if \(!soft[\s\S]*win\.reload\(\)/);
});

test('⌘R is still Reload, and a true hard reload is still reachable', () => {
  assert.match(main, /label: 'Reload', accelerator: 'CmdOrCtrl\+R'/);
  assert.match(main, /role: 'forceReload'/, '⇧⌘R remains the escape hatch');
});
