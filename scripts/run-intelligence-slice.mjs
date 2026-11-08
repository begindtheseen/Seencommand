#!/usr/bin/env node
import { resolve } from 'node:path';
import { runVerticalSlice } from '../intelligence/orchestrator.mjs';
const args = process.argv.slice(2); const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const objective = value('--objective'); const repoRoot = resolve(value('--repo') || new URL('..', import.meta.url).pathname);
if (!objective) { console.error('usage: node scripts/run-intelligence-slice.mjs --objective "small low-risk change" [--repo /path]'); process.exit(1); }
console.log('Running a LOCAL-ONLY slice through the ONE coding pipeline (engine/builder.mjs, dry run): isolated worktree, task contract, full gate, proof, semantic review. Nothing is pushed, merged, installed or deployed.');
try { const workflow = await runVerticalSlice({ objective, repoRoot }); console.log(JSON.stringify(workflow.artifacts.prPackage, null, 2)); }
catch (error) { console.error(`Vertical slice failed honestly: ${error.message}`); process.exit(1); }
