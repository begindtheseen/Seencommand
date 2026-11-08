import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retireChronos } from './retire-chronos.mjs';

// A fake Mac: which commands ran, what is "running", what exists.
function mac({ installed = true, running = false, quits = true, finder = true, trashHas = [] } = {}) {
  const calls = []; const moved = []; let up = running;
  const files = new Set([...(installed ? ['/Applications/Chronos.app'] : []), ...trashHas]);
  const run = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === '/usr/bin/pgrep') { if (up) return '123\n'; const e = new Error('no process'); e.status = 1; throw e; }
    if (cmd === '/usr/bin/osascript' && /to quit/.test(args.join(' '))) { if (quits) up = false; return ''; }
    if (cmd === '/usr/bin/pkill') { return ''; }
    if (cmd === '/usr/bin/osascript' && /Finder/.test(args.join(' '))) { if (!finder) throw new Error('not authorized'); files.delete('/Applications/Chronos.app'); return ''; }
    if (cmd === '/usr/bin/osascript' && /System Events/.test(args.join(' '))) return '';
    throw new Error(`unexpected ${cmd}`);
  };
  const opts = { platform: 'darwin', home: '/Users/b', exists: (p) => files.has(p), run, rename: (a, b) => { moved.push([a, b]); files.delete(a); files.add(b); }, mkdir: () => {}, wait: () => {}, now: () => new Date('2026-10-21T20:00:00Z'), log: () => {} };
  return { opts, calls, moved, files };
}

test('nothing to do off a Mac, or when Chronos is not installed', () => {
  assert.equal(retireChronos({ platform: 'linux', log: () => {} }).found, false);
  const m = mac({ installed: false });
  const r = retireChronos(m.opts);
  assert.equal(r.found, false);
  assert.deepEqual(m.calls, [], 'not even a login-item check when there is nothing to retire');
});

test('running: asks it to quit (without launching it), then Finder moves it to the Trash, then the login item', () => {
  const m = mac({ running: true });
  const r = retireChronos(m.opts);
  assert.equal(r.quit, true); assert.equal(r.trashed, 'finder'); assert.equal(r.loginItem, 'checked');
  const quit = m.calls.find((c) => /to quit/.test(c));
  assert.match(quit, /is running then/, 'never a bare tell-to-quit, which would launch a closed app');
  assert.ok(!m.calls.some((c) => /pkill/.test(c)), 'a polite quit was enough');
  assert.ok(m.calls.findIndex((c) => /to quit/.test(c)) < m.calls.findIndex((c) => /Finder/.test(c)), 'quit before moving');
  assert.ok(!m.calls.some((c) => /\brm\b|rm -rf/.test(c)), 'never deleted');
});

test('Finder refused: a plain move into ~/.Trash, never over an earlier copy', () => {
  const m = mac({ finder: false, trashHas: ['/Users/b/.Trash/Chronos.app'] });
  const r = retireChronos(m.opts);
  assert.equal(m.moved.length, 1);
  assert.equal(m.moved[0][0], '/Applications/Chronos.app');
  assert.match(m.moved[0][1], /^\/Users\/b\/\.Trash\/Chronos 2026-10-21T20-00-00-000Z\.app$/);
  assert.equal(r.trashed, m.moved[0][1]);
  assert.ok(m.files.has('/Users/b/.Trash/Chronos.app'), 'the earlier Trash copy is kept');
});

test('it will not quit: only the exact "Chronos" process is signalled, and the app is left installed', () => {
  const m = mac({ running: true, quits: false });
  const r = retireChronos(m.opts);
  assert.ok(m.calls.includes('/usr/bin/pkill -x Chronos'));
  assert.equal(r.quit, false); assert.equal(r.trashed, null);
  assert.ok(m.files.has('/Applications/Chronos.app'), 'never moved while it is still running');
});
