// brain-sync must not reference a node builtin it never bound.
//
// This is a real regression, shipped to main in #194: the deploy-drift invocation was changed to
// `fileURLToPath(new URL(...))` but the binding was never added, so the hourly sync would have died
// with a ReferenceError the moment it reached that line.
//
// Nothing caught it. `node --check` passes, because an undefined identifier in ESM is a RUNTIME
// error, not a parse error. The full gate passed too, because no test executes this script — it
// makes network calls and spawns a child, so it is not imported anywhere.
//
// This file scans for the narrow, checkable property instead: every node-builtin helper the script
// CALLS must also be BOUND in it, whether by a top-level import or by the destructured dynamic
// import this file uses inside functions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./brain-sync.mjs', import.meta.url), 'utf8');

// Helpers this script pulls from node builtins. Each must be bound wherever it is used.
const HELPERS = ['fileURLToPath', 'execFileSync'];

const isBound = (name) => new RegExp(
  String.raw`(?:import\s*\{[^}]*\b${name}\b[^}]*\}|const\s*\{[^}]*\b${name}\b[^}]*\}\s*=\s*await\s+import)`,
).test(src);

const isCalled = (name) => new RegExp(String.raw`(?<![\w.])${name}\s*\(`).test(src);

for (const name of HELPERS) {
  test(`${name} is bound wherever brain-sync calls it`, () => {
    if (!isCalled(name)) return; // not used any more is fine
    assert.ok(isBound(name),
      `brain-sync calls ${name}() but never imports or destructures it — a ReferenceError at run time`);
  });
}

test('the deploy-drift child is spawned with a DECODED path', () => {
  // deploy-drift's CLI guard compares argv[1] against its own fileURLToPath'd path, and both files
  // ship inside "/Applications/Seen Command.app". Passing new URL(...).pathname hands over a
  // percent-encoded space, the guard fails to match, and the hourly monitor silently never runs.
  assert.match(src, /fileURLToPath\(new URL\('\.\/deploy-drift\.mjs', import\.meta\.url\)\)/,
    'must pass a decoded path to the deploy-drift child');
  assert.ok(!/'\.\/deploy-drift\.mjs', import\.meta\.url\)\.pathname/.test(src),
    'must not hand the child a percent-encoded .pathname');
});
