// One owner per window.* name. The Brain tab once assigned window.askBoardRoom (its "prefill the box"
// helper) over the chat's SEND function, and every chat message silently went back into the box
// (2026-10-21, #233). All UI files are inlined into ONE page, so a name assigned in two files is a bug.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const files = [join(ROOT, 'scripts', 'build-dashboard.mjs'),
  ...readdirSync(join(ROOT, 'lib', 'ui')).filter((f) => f.endsWith('.js')).map((f) => join(ROOT, 'lib', 'ui', f))];

test('no window.* name is assigned by two different UI files', () => {
  const owners = new Map();
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\bwindow\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)) {
      const set = owners.get(m[1]) || new Set(); set.add(f.slice(ROOT.length + 1)); owners.set(m[1], set);
    }
  }
  const clashes = [...owners].filter(([, s]) => s.size > 1).map(([n, s]) => `${n}: ${[...s].join(', ')}`);
  assert.deepEqual(clashes, [], `window names assigned in more than one file:\n${clashes.join('\n')}`);
});

test('window.askBoardRoom (the chat send) is defined only by the dashboard', () => {
  for (const f of files) {
    if (f.endsWith('build-dashboard.mjs')) continue;
    assert.doesNotMatch(readFileSync(f, 'utf8'), /window\.askBoardRoom\s*=(?!=)/, f);
  }
});
