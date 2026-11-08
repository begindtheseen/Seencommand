#!/usr/bin/env node
// activity — the CLI digest of Seen Command's activity ledger. `node scripts/activity.mjs [days|--json]`
// prints a compact table of what the app DID (board meetings, approvals, builds, deliveries,
// self-updates, deployability verdicts), oldest→newest, default the last 2 day-files. Dependency-free.
// This is what a Claude session runs (or reads data/activity/*.jsonl directly) when Brandon says
// "review seen command updates".

import { readActivity } from '../lib/activity.mjs';

const args = process.argv.slice(2);
let days = 2;
let jsonOutput = false;

if (args.includes('--json')) {
  jsonOutput = true;
  days = Math.max(1, Number(args[args.indexOf('--json') + 1]) || 2);
} else {
  days = Math.max(1, Number(process.argv[2]) || 2);
}

const events = readActivity({ days });

if (!events.length) {
  if (jsonOutput) {
    console.log('[]');
  } else {
    console.log(`No activity in the last ${days} day-file(s). Ledger: data/activity/*.jsonl (empty or not created yet).`);
  }
  process.exit(0);
}

// "YYYY-MM-DD HH:MM:SS" in UTC, matching the ledger's own timezone (the ts is ISO/UTC).
const utc = (ts) => { const d = new Date(ts); return Number.isNaN(d.getTime()) ? clip(ts, 19) : d.toISOString().slice(0, 19).replace('T', ' '); };
const clip = (v, n) => { const s = v == null ? '' : String(v); return s.length > n ? s.slice(0, n) : s; };
const pad = (v, n) => clip(v, n).padEnd(n);

// --json prints ONLY the JSON array — no banner, no dividers — so `JSON.parse` of the whole
// stdout succeeds (the task's Done-means; the builder's first draft printed the banner first).
if (jsonOutput) {
  console.log(JSON.stringify(events));
} else {
  console.log(`Seen Command activity — last ${days} day-file(s), ${events.length} event(s), oldest→newest (UTC):\n`);
  console.log(`${pad('TIME (UTC)', 19)}  ${pad('KIND', 11)}  ${pad('ID', 22)}  ${pad('STATUS', 14)}  SUMMARY`);
  console.log('-'.repeat(96));
  for (const e of events) {
    console.log(`${pad(utc(e.ts), 19)}  ${pad(e.kind, 11)}  ${pad(e.id || '—', 22)}  ${pad(e.status || '—', 14)}  ${e.summary || ''}`);
  }
}
