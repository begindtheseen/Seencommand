// No source file may contain a NUL byte.
//
// A NUL landed in brain/lib/cloud.mjs on 2026-08-13 — a key-separator template written as a raw
// control character rather than an escape. The functional bug it caused was found by a unit test in
// minutes. The tooling damage was far worse and completely silent: grep and ripgrep classify a file
// containing NUL as BINARY and report no matches in it, so `grep -c export cloud.mjs` answered
// "nothing" about a file with twenty exports. Every codebase search — mine, any future session's,
// any editor's — quietly stopped seeing that file, with no error to explain why.
//
// One byte, and a core capability degrades to a confident wrong answer. This is the cheapest possible
// tripwire for it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

test('no tracked source file contains a NUL byte (it makes grep treat the file as binary)', () => {
  let listed;
  try {
    listed = execFileSync('git', ['-C', REPO, 'ls-files', '-z', '*.mjs', '*.js', '*.json', '*.md', '*.html', '*.yml'],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch {
    return; // not a git checkout (a packaged bundle, a tarball) — nothing to audit
  }
  const files = listed.split('\0').filter(Boolean)
    .filter((f) => !f.startsWith('brain/dist/')); // built app bundles are not sources we author

  const offenders = [];
  for (const rel of files) {
    let buf;
    try { buf = readFileSync(join(REPO, rel)); } catch { continue; } // deleted-but-tracked
    const at = buf.indexOf(0);
    if (at !== -1) offenders.push(`${rel} (first NUL at byte ${at})`);
  }
  assert.deepEqual(offenders, [],
    `NUL bytes found — grep/ripgrep will silently skip these files:\n  ${offenders.join('\n  ')}\n`
    + 'Write the character as an escape (\\u0000) or, better, use a printable separator.');
});
