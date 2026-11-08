import { test } from 'node:test';
import assert from 'node:assert/strict';

// Smoke: every engine/lib module must LOAD — catches runtime-only reference errors (like a helper
// using existsSync without importing it) that node --check and unit tests on other files miss.
const MODULES = [
  '../lib/config.mjs', '../lib/llm.mjs', '../lib/router.mjs', '../lib/builds.mjs', '../lib/text.mjs',
  '../lib/brain.mjs', '../lib/activity.mjs', '../lib/connectors/github.mjs', '../lib/connectors/index.mjs',
  '../brain/lib/git-episodes.mjs',
  './policy.mjs', './builder.mjs', './coder.mjs', './deliver.mjs', './overnight.mjs', './self-update.mjs', './pr-rescue.mjs', './reconcile.mjs', './pr-flags.mjs', './pr-verify.mjs', './lint.mjs', './reviewer.mjs', './bus.mjs', './proposal-gate.mjs',
  // The ENTRY POINTS. Both guard their side effects (run's board meeting, server's listen) behind an
  // import.meta main-check, so importing them is safe — and it's the ONLY coverage server.mjs has
  // (nothing else imports it). This is the load backstop for the #78 class: a phantom named import in
  // server.mjs is a load-time SyntaxError the deterministic lint now names AND this smoke test trips.
  './run.mjs', './server.mjs',
];
for (const m of MODULES) {
  test(`module loads: ${m}`, async () => { assert.ok(await import(m)); });
}
