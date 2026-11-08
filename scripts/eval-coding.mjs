#!/usr/bin/env node
// eval-coding — score the coding pipeline against its own recorded failures. Deterministic: no model,
// no network. Exit 1 when an active case fails or a pending case has started passing (remove its flag).
import { CASES } from '../engine/evals/cases.mjs';
import { runSuite } from '../engine/evals/harness.mjs';

const only = process.argv.slice(2).find((a) => !a.startsWith('--'));
const suite = await runSuite(only ? CASES.filter((c) => c.id === only) : CASES);
for (const r of suite.results) {
  const mark = r.pending ? (r.pass ? '‼ NOW PASSING' : '… pending  ') : (r.pass ? '✔ pass     ' : '✖ FAIL     ');
  console.log(`${mark} ${r.id.padEnd(28)} ${r.result.status.padEnd(9)} ${r.pending ? `[${r.pending}]` : ''}`);
  if (!r.pass && !r.pending) for (const p of r.problems) console.log(`             ↳ ${p}`);
  if (process.argv.includes('--verbose') && r.result.message) console.log(`             · ${r.result.message.split('\n')[0].slice(0, 200)}`);
}
const stale = suite.pending.filter((r) => r.pass);
console.log(`\n${suite.passed}/${suite.total} active cases pass · ${suite.pending.length} pending${stale.length ? ` · ${stale.length} pending case(s) now pass — remove their flag` : ''}`);
process.exit(suite.passed === suite.total && !stale.length ? 0 : 1);
