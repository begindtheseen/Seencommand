#!/usr/bin/env node
// ops CLI — the Board Room agent's deterministic tool surface, read-only by design (see lib/ops.mjs).
// Both chat lanes are allow-listed to run exactly `node scripts/ops.mjs …`, so every ability here is
// something the chatbot can pull WITHOUT extra prompting or model-driven exploration:
//   state | snapshot | search <q> | query --target … | credentials | drift | logs | diagnose [--fix]
// Output is pretty JSON on stdout. Unknown commands print usage and exit 2 (a wrong invocation must
// never be mistaken for an empty result).

import { fetchAllState, opsSnapshot, searchAll, credentialAudit, driftCheck, runQuery, exportLogs, diagnose, opsFailures } from '../lib/ops.mjs';

export const USAGE = {
  usage: 'node scripts/ops.mjs <command> [args]',
  commands: {
    state: 'every connector live in one call (github/admin/supabase/vercel/stripe + AI lanes)',
    snapshot: 'deterministic full-platform dump: focus, approvals, tasks, builds, brain, health, repos, activity',
    'search <query>': 'code (git grep, both repos) + brain facts in one step, with file:line references',
    'query --target <facts|db|activity|builds|state>': 'read-only query; facts: --subject --predicate --contains; db: --table --select --filter --order; activity: --days --kind; state: --path; all: --limit',
    credentials: 'which connectors are missing VALID tokens (status only — never values)',
    drift: 'is what is merged what is deployed (live probe + last recorded brain verdict)',
    logs: 'export a debugging bundle (CI runs + failed-run log, Vercel deploys, builds, activity, health) under data/exports',
    'diagnose [--fix]': 'full health map; --fix also runs safe remediation (git fetch + ahead/behind report, no working-tree changes)',
    'failures [--days N]': 'the patch queue — every failure that has not been resolved, split into blocked-on-owner vs actionable',
  },
};

// argv → { cmd, words, flags } — flags are --key value pairs (or boolean --flags); words are bare args.
export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const flags = {};
  const words = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; }
      else flags[key] = true;
    } else words.push(a);
  }
  return { cmd: cmd || 'help', words, flags };
}

async function main() {
  const { cmd, words, flags } = parseArgs(process.argv.slice(2));
  let out;
  if (cmd === 'state') out = await fetchAllState();
  else if (cmd === 'snapshot') out = await opsSnapshot();
  else if (cmd === 'search') out = searchAll({ query: words.join(' '), limit: Number(flags.limit) || 20 });
  else if (cmd === 'query') out = await runQuery({ target: flags.target, ...flags });
  else if (cmd === 'credentials') out = await credentialAudit();
  else if (cmd === 'drift') out = await driftCheck();
  else if (cmd === 'logs') out = await exportLogs();
  else if (cmd === 'diagnose') out = await diagnose({ fix: !!flags.fix });
  else if (cmd === 'failures') out = await opsFailures({ days: Number(flags.days) || 14 });
  else if (cmd === 'help') out = USAGE;
  else {
    process.stderr.write(`unknown command "${cmd}"\n${JSON.stringify(USAGE, null, 2)}\n`);
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

// Import-safe: tests import parseArgs/USAGE without triggering a run.
if (process.argv[1] && /ops\.mjs$/.test(process.argv[1])) {
  main().catch((e) => { process.stderr.write(`ops failed: ${e.message}\n`); process.exit(1); });
}
