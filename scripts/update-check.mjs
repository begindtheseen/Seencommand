#!/usr/bin/env node
// The in-app updater's check, run as its own process (lib/updater.mjs checkInChild) so its synchronous `git`
// work never blocks the server. Prints ONE JSON line: { report, commits }.
import { runningCode } from '../lib/running-code.mjs';
import { commitsBetween } from '../lib/updater.mjs';

const repoDir = process.argv[2];
let report;
try { report = runningCode({ repoDir, fetch: true }); } catch (e) { report = { originMain: null, apps: {}, problems: [e.message] }; }
const commits = report.originMain ? commitsBetween(report.apps?.seenCommand?.sha || null, report.originMain, { repoDir }) : [];
process.stdout.write(`${JSON.stringify({ report, commits })}\n`);
