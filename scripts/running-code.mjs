#!/usr/bin/env node
// running-code — print which code origin/main, the shared checkout and the installed apps each hold.
// Exit 1 when they disagree, so it can gate a "done" claim. --json for machines.
import { runningCode } from '../lib/running-code.mjs';
const r = runningCode();
if (process.argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); process.exit(r.inSync ? 0 : 1); }
const s = (x) => (x ? String(x).slice(0, 8) : 'unknown');
console.log(`origin/main        ${s(r.originMain)}`);
console.log(`shared checkout    ${s(r.checkout.head)} on ${r.checkout.branch}${r.checkout.behind ? ` (${r.checkout.behind} behind)` : ''}${r.checkout.dirty.length ? ` · ${r.checkout.dirty.length} dirty` : ''}`);
for (const [k, label] of [['seenCommand', 'Seen Command.app  ']]) {
  const a = r.apps[k];
  console.log(`${label} ${a ? `${s(a.sha)}${a.behind ? ` (${a.behind} behind)` : ''}${a.builtAt ? ` · built ${a.builtAt.slice(0, 16).replace('T', ' ')}` : ''}` : 'no build stamp'}`);
}
console.log(r.inSync ? '\n✓ in sync — what was merged is what is running.' : `\n✗ NOT in sync:\n${r.problems.map((p) => `  • ${p}`).join('\n')}`);
process.exit(r.inSync ? 0 : 1);
