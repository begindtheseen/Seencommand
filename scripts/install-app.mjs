#!/usr/bin/env node
// install-app — copy the built "Seen Command.app" into /Applications so it opens from Spotlight /
// Finder with a double-click. Run after `npm run app:package`, or via `npm run app:install` (both).
// Pure Node, no deps. Resolves dist/ relative to THIS file, so cwd doesn't matter.

import { existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { retireChronos } from './retire-chronos.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', 'dist');
const APP_NAME = 'Seen Command.app';
const DEST = join('/Applications', APP_NAME);

function findApp(dir) {
  if (!existsSync(dir)) return null;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (name === APP_NAME) return full;
    try { if (statSync(full).isDirectory()) { const hit = findApp(full); if (hit) return hit; } } catch { /* skip */ }
  }
  return null;
}

const built = findApp(DIST);
if (!built) {
  console.error(`Could not find ${APP_NAME} under ${DIST}. Run \`npm run app:package\` first.`);
  process.exit(1);
}

try {
  if (existsSync(DEST)) rmSync(DEST, { recursive: true, force: true });
  // Use ditto, NOT fs.cpSync: cpSync resolves relative symlinks to absolute paths, which rewrites
  // the Electron framework's internal symlinks (Versions/Current, Electron Framework, Resources…) to
  // point back into dist/. An unsigned .app whose framework escapes its own bundle fails ICU init and
  // crashes on launch. ditto copies bundles verbatim (symlinks, perms, resource forks) — the correct
  // macOS way to move an .app.
  execFileSync('/usr/bin/ditto', [built, DEST]);
  // Deep ad-hoc re-sign the freshly-installed bundle. electron-builder can't Developer-ID sign (no
  // cert), so the bundle still carries the stock Electron binary's linker signature, which does not
  // match this locally built app and makes Gatekeeper refuse to open it. Ad-hoc signing the real
  // contents gives the bundle a signature that matches what is actually on disk, so it runs as an
  // ordinary unnotarized local build on the machine that built it (standard for personal, unsigned
  // Electron builds). Non-fatal.
  try { execFileSync('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', DEST]); } catch { /* nothing to clear */ }
  try {
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--identifier', 'com.seen.command', DEST]);
    console.log('Re-signed ad-hoc (fresh CDHash) — clears the revoked-Electron Gatekeeper block.');
  } catch (e) {
    console.error(`Ad-hoc re-sign failed (${e.message}). Fix manually:\n  codesign --force --deep --sign - --identifier com.seen.command "${DEST}"`);
  }
  console.log(`Installed ${built}\n       → ${DEST}`);
  console.log('Open it from Spotlight or Finder → Applications: "Seen Command". It runs fully live.');
  // Chronos is retired: its screens are Seen Command → Brain. Never fails the install.
  try { retireChronos(); } catch (e) { console.error(`Chronos retirement skipped: ${e.message}`); }
} catch (e) {
  console.error(`Copy to /Applications failed: ${e.message}`);
  console.error(`Drag it manually: ${built}  →  /Applications`);
  process.exit(1);
}
