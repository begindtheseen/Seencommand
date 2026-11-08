#!/usr/bin/env node
// retire-chronos — Chronos.app is retired (2026-10-21): every screen it had (Graph, Activity, Overnight,
// Health, Access) and its background work (vault watchers, the 60 s cloud pull) now live in Seen Command's
// Brain tab. This removes the old app from this Mac so two copies never sync the same vault:
//
//   1. quit Chronos if it is running (asked politely first; only the exact "Chronos" process otherwise),
//   2. move /Applications/Chronos.app to the Trash — reversible (Finder → Put Back), never deleted,
//   3. remove a "Chronos" login item, if one was added.
//
// Run by `npm run app:install` (scripts/install-app.mjs), so `npm run update` and the in-app updater do
// it too. Safe to run any number of times; on anything but macOS it does nothing. The brain/ source and
// the brain MCP server are untouched.
import { existsSync, renameSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CHRONOS_APP = '/Applications/Chronos.app';
const BUNDLE_ID = 'com.seen.chronos';

const sleep = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no wait */ } };

// The steps are injectable so the order and the never-delete rule are testable off a Mac.
export function retireChronos({
  platform = process.platform,
  app = CHRONOS_APP,
  home = homedir(),
  exists = existsSync,
  run = (cmd, args) => String(execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 })),
  rename = renameSync,
  mkdir = (p) => mkdirSync(p, { recursive: true }),
  wait = sleep,
  now = () => new Date(),
  log = (m) => console.log(m),
} = {}) {
  const done = { platform, found: false, quit: null, trashed: null, loginItem: null, notes: [] };
  if (platform !== 'darwin') { done.notes.push('not macOS — nothing to retire'); return done; }
  if (!exists(app)) { done.notes.push('Chronos.app is not installed — nothing to retire'); return done; }
  done.found = true;

  // 1) Quit. `is running` never launches the app, unlike a bare `tell application … to quit`.
  const running = () => { try { run('/usr/bin/pgrep', ['-x', 'Chronos']); return true; } catch { return false; } };
  if (running()) {
    try { run('/usr/bin/osascript', ['-e', `if application id "${BUNDLE_ID}" is running then tell application id "${BUNDLE_ID}" to quit`]); } catch { /* fall through to the signal */ }
    for (let i = 0; i < 20 && running(); i++) wait(250);
    if (running()) { try { run('/usr/bin/pkill', ['-x', 'Chronos']); } catch { /* already gone */ } for (let i = 0; i < 12 && running(); i++) wait(250); }
    done.quit = !running();
    if (!done.quit) { done.notes.push('Chronos is still running — quit it (⌘Q), then run `npm run brain:app` again'); log('Chronos is still running; leaving it installed. Quit it and run `npm run brain:app`.'); return done; }
  } else done.quit = true;

  // 2) To the Trash. Finder first (it keeps "Put Back"); a plain move into ~/.Trash otherwise.
  try {
    run('/usr/bin/osascript', ['-e', `tell application "Finder" to delete (POSIX file "${app}" as alias)`]);
    done.trashed = 'finder';
  } catch {
    try {
      const trash = join(home, '.Trash'); mkdir(trash);
      let dest = join(trash, 'Chronos.app');
      if (exists(dest)) dest = join(trash, `Chronos ${now().toISOString().replace(/[:.]/g, '-')}.app`);
      rename(app, dest);
      done.trashed = dest;
    } catch (e) { done.trashed = null; done.notes.push(`could not move it to the Trash (${e.message}) — drag ${app} to the Trash yourself`); }
  }

  // 3) A login item named Chronos, if the owner ever added one (System Events is the only place to look).
  try {
    run('/usr/bin/osascript', ['-e', 'tell application "System Events" to if exists login item "Chronos" then delete login item "Chronos"']);
    done.loginItem = 'checked';
  } catch (e) { done.loginItem = null; done.notes.push(`could not check login items (${String(e.message).split('\n')[0]}) — System Settings → General → Login Items`); }

  log(done.trashed
    ? `Chronos.app retired — moved to the Trash${done.trashed === 'finder' ? ' (Finder → Put Back restores it)' : ` (${done.trashed})`}. Its screens are Seen Command → Brain.`
    : 'Chronos.app could not be moved to the Trash — see the note above.');
  for (const n of done.notes) log(`  · ${n}`);
  return done;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = retireChronos();
  if (!r.found) console.log(`Chronos is retired — the Brain lives in Seen Command (Brain tab). ${r.notes.join('; ')}.`);
}
