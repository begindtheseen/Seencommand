#!/usr/bin/env node
// install-app — copy the built Chronos.app into /Applications so it opens from Spotlight/Finder.
// Run after `npm run app:package` (or via `npm run app:install`, which does both). Pure Node, no deps.

import { existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve dist/ relative to THIS file (brain/scripts/…), not cwd — so it works whether run via
// `npm run app:install` (cwd = brain/) or directly as `node brain/scripts/install-app.mjs`.
const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', 'dist');
const APP_NAME = 'Chronos.app';
const DEST = join('/Applications', APP_NAME);

function findApp(dir) {
  if (!existsSync(dir)) return null;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (name === APP_NAME) return full;
    if (statSync(full).isDirectory()) { const hit = findApp(full); if (hit) return hit; }
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
  // ditto, NOT fs.cpSync — cpSync rewrites the Electron framework's relative symlinks to absolute
  // paths into dist/, which crashes the unsigned app on launch (icudtl.dat not found). ditto copies
  // the bundle verbatim. Same fix applied to Seen Command's installer.
  execFileSync('/usr/bin/ditto', [built, DEST]);
  // Deep ad-hoc re-sign the freshly-installed bundle. electron-builder can't Developer-ID sign (no
  // cert), so it leaves the stock Electron binary with its linker-signed CDHash — and Apple has REVOKED
  // that exact hash, so Gatekeeper hard-blocks the app ("… can't be opened / contains malware",
  // notarization revoked) even with no quarantine. A fresh ad-hoc signature over the real contents
  // gives every nested binary a new CDHash that isn't on the revocation list — the verdict flips from
  // "revoked" (blocked) to "rejected" (unnotarized, which launches fine unquarantined). Non-fatal.
  try { execFileSync('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', DEST]); } catch { /* nothing to clear */ }
  try {
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--identifier', 'com.seen.chronos', DEST]);
    console.log('Re-signed ad-hoc (fresh CDHash) — clears the revoked-Electron Gatekeeper block.');
  } catch (e) {
    console.error(`Ad-hoc re-sign failed (${e.message}). Fix manually:\n  codesign --force --deep --sign - --identifier com.seen.chronos "${DEST}"`);
  }
  console.log(`Installed ${built}\n       → ${DEST}`);
  console.log('Open it from Spotlight or Finder → Applications: "Chronos".');
  console.log('First launch will ask you to pick your seen-command repo folder (remembered after that).');
} catch (e) {
  console.error(`Copy to /Applications failed: ${e.message}`);
  console.error(`You can drag it manually: ${built}  →  /Applications`);
  process.exit(1);
}
