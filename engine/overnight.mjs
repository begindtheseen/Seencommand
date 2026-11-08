#!/usr/bin/env node
// The overnight co-CEO loop — what runs unattended overnight.
//
// It does three things, in order, and nothing it can't undo:
//   1) Hold a full board meeting (engine/run.mjs) over live data → proposals, approvals, KPIs.
//   2) AUTO-HANDLE the obviously-safe engineering work: for each open issue on the TOOL repo carrying
//      the safe-to-autobuild label (default "auto-build"), run the test-gated builder — it writes the
//      code, runs the gate, and opens a PR. Only a GREEN gate ever ships. Merging stays a morning
//      click unless OVERNIGHT_AUTOMERGE=1 (tool repo only; the product repo is never touched here).
//   3) Leave a MORNING BRIEFING: what it shipped overnight + the judgment calls parked for a yes/no.
//
// Guardrails (engine/policy.mjs GUARDRAILS): a hard cap on builds per night, and a stop-on-repeated-
// failure rule so a broken task can't burn the whole night. Nothing is fabricated: no labeled issues
// → nothing built, and the briefing says so plainly.
//
// Run: `node engine/overnight.mjs`  ·  scheduled by scripts/schedule-macos.sh (the 6 AM launchd agent).

import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runBoardMeeting } from './run.mjs';
import { runBuild } from './builder.mjs';
import { GUARDRAILS } from './policy.mjs';
import { loadState, saveState } from '../lib/memory.mjs';
import { issuesFor } from '../lib/connectors/github.mjs';
import { recordBoardMeeting, brainVault } from '../lib/brain.mjs';
import { config } from '../lib/config.mjs';
import { dataDir, REPO_ROOT } from '../lib/paths.mjs';

const MAX_CONSECUTIVE_FAILS = 2; // stop condition: "same tool fails N× in a row → stop, don't improvise"

// The safe overnight work queue: tool-repo issues explicitly labeled safe-to-autobuild. A concrete
// issue (title + body) is a real, buildable task — not a vague proposal — so the PRs are real quality.
export function pickAutoQueue(issues, label, cap) {
  return issues
    .filter((i) => (i.labels || []).includes(label))
    .filter((i) => !/^\s*\[building\]/i.test(i.title)) // skip ones already in flight
    .slice(0, cap)
    .map((i) => ({ number: i.number, title: i.title, url: i.url,
      task: `${i.title}${i.body ? `\n\n${i.body}` : ''}`.slice(0, 800) }));
}

export async function runOvernight({ dryRun = false } = {}) {
  const startedAt = new Date().toISOString();
  const label = config.overnightLabel();
  const cap = Math.min(config.overnightMaxBuilds(), GUARDRAILS.maxTasksPerNight);
  const autoMerge = config.overnightAutoMerge();
  const toolRepo = config.commandRepo();
  const log = (m) => console.log(`[overnight] ${m}`);

  // 1) Board meeting — the same live run the morning would do, so the briefing sits on real data.
  log('holding the board meeting…');
  const meeting = await runBoardMeeting();
  const state = loadState() || {};

  // 2) Auto-handle the safe queue.
  let queue = [];
  try { queue = pickAutoQueue(await issuesFor(toolRepo), label, cap); }
  catch (e) { log(`could not read the work queue: ${e.message}`); }
  log(`safe auto-build queue: ${queue.length} issue(s) labeled "${label}" (cap ${cap})`);

  const shipped = []; const failed = [];
  let consecutiveFails = 0; let stopped = null;
  for (const item of queue) {
    if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) { stopped = `stopped after ${consecutiveFails} consecutive build failures`; log(stopped); break; }
    log(`building #${item.number}: ${item.title}`);
    try {
      const r = await runBuild({ task: item.task, repo: 'tool', autoMerge, dryRun, onEvent: (m) => log(m) });
      shipped.push({ issue: item.number, issueUrl: item.url, title: item.title,
        pr: r.pr || null, prNumber: r.number || null, merged: !!r.merged, dryRun: !!r.dryRun,
        summary: r.summary || null, engine: r.engine || null });
      consecutiveFails = 0;
      log(`#${item.number} → ${r.dryRun ? 'green (dry run)' : (r.merged ? 'merged' : `PR ${r.pr}`)}`);
    } catch (e) {
      failed.push({ issue: item.number, title: item.title, error: e.message });
      consecutiveFails++;
      log(`#${item.number} FAILED: ${e.message}`);
    }
  }

  // 3) The judgment calls the loop deliberately did NOT touch — parked for Brandon's yes/no.
  const parked = (state.approvals || [])
    .filter((a) => a.status === 'pending')
    .map((a) => ({ id: a.id, title: a.title, dept: a.dept, agent: a.agent, risk: a.risk,
      summary: a.summary, build: a.build || null,
      why: a.build === 'product' ? 'product PR — merging deploys prod, so this stays your call'
        : a.build ? 'engineering — approve to build' : 'outbound/irreversible — needs your yes/no' }));

  const briefing = {
    ranAt: startedAt, finishedAt: new Date().toISOString(),
    runId: meeting.runId, focus: state.debrief?.focus?.title || null,
    kpis: state.debrief?.kpis || [],
    shipped, failed, parked, stopped,
    queueLabel: label, autoMerge,
    headline: shipped.length
      ? `Overnight: shipped ${shipped.length} test-gated ${shipped.length === 1 ? 'change' : 'changes'}${autoMerge ? '' : ' (PRs ready for your merge)'}; ${parked.length} judgment call${parked.length === 1 ? '' : 's'} parked.`
      : `Overnight: no safe auto-build queue (label "${label}") — nothing shipped. ${parked.length} judgment call${parked.length === 1 ? '' : 's'} awaiting your yes/no.`,
    guardrails: { cap, maxConsecutiveFails: MAX_CONSECUTIVE_FAILS, budgetCapUsd: GUARDRAILS.budgetCapUsd },
  };

  // Surface it: bake into state (the dashboard renders debrief.overnight), write a readable brief,
  // and log the night to the shared brain. Then rebuild the dashboard so a cold morning open shows it.
  state.debrief = state.debrief || {};
  state.debrief.overnight = briefing;
  saveState(state);
  try { writeFileSync(join(dataDir(), 'morning-brief.md'), renderMarkdown(briefing)); } catch { /* ignore */ }
  try { recordBoardMeeting(brainVault(), { runId: meeting.runId, date: startedAt.slice(0, 10),
    autoExecuted: shipped.length, parked: parked.length, openItems: (state.threads || []).length,
    focus: `overnight — ${briefing.headline}` }); } catch (e) { log(`brain log skipped: ${e.message}`); }
  if (!dryRun) { try { execFileSync(process.execPath, [join(REPO_ROOT, 'scripts', 'build-dashboard.mjs')], { cwd: REPO_ROOT, env: process.env, stdio: 'ignore' }); } catch { /* ignore */ } }

  log(briefing.headline);
  return briefing;
}

function renderMarkdown(b) {
  const lines = [`# Morning briefing — ${b.ranAt.slice(0, 10)}`, '', `_${b.headline}_`, ''];
  if (b.shipped.length) {
    lines.push('## Shipped overnight (test-gated)');
    for (const s of b.shipped) lines.push(`- #${s.issue} ${s.title} → ${s.merged ? 'merged' : (s.pr || 'built')}${s.summary ? ` — ${s.summary}` : ''}`);
    lines.push('');
  }
  if (b.failed.length) {
    lines.push('## Attempted but not shipped (gate stayed red — nothing merged)');
    for (const f of b.failed) lines.push(`- #${f.issue} ${f.title} — ${f.error}`);
    lines.push('');
  }
  if (b.parked.length) {
    lines.push('## Awaiting your yes / no');
    for (const p of b.parked) lines.push(`- **${p.title}** (${p.dept}, ${p.risk} risk) — ${p.why}`);
    lines.push('');
  }
  if (b.stopped) lines.push(`> ⚠ ${b.stopped}`);
  return lines.join('\n');
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  runOvernight({ dryRun: process.argv.includes('--dry-run') })
    .then(() => process.exit(0))
    .catch((err) => { console.error('overnight loop failed:', err); process.exit(1); });
}
