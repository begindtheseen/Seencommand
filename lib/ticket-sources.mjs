// ticket-sources — every way Seen Command fails, turned into brain tickets (brain/lib/tickets.mjs).
//
// Owner, 2026-10-21: "when tasks fail, it doesn't leave it up to me. it creates a trackable ticket for it
// on seen's brain". Two inputs feed this, and both are wired by lib/ticket-wire.mjs at process start:
//   • recordFailure() (lib/failure-loop.mjs) — builds and anything else that queues a failure;
//   • the activity ledger (lib/activity.mjs onActivity) — collector runs (the aggregation manager logs
//     every run's end there), board meetings, self-updates, approvals, PR status checks, the preview
//     verdict (engine/pr-verify.mjs), post-merge proof (engine/completion.mjs), schema drift, and the
//     Board Room assistant failing a turn (engine/agent-chat.mjs logs kind 'assistant').
// Deploy drift and the base-branch health check report from their own CLIs (scripts/deploy-drift.mjs,
// lib/base-health.mjs) through `reportFrom` / `resolveFrom` below.
//
// A later success of the same thing closes its ticket ("resolved by success"). Builds the owner sent to
// the builder from a ticket (id `ticket-<id>`, or a re-run of the failed build) move that ticket instead:
// PR opened → pr_open, failed → back to open for someone else.
//
// A ticket about Seen Command itself (its repo is the tool repo, or the assistant failed) is a "tool"
// ticket and always carries WHAT WOULD HAVE HELPED (helpedFor below) — the owner's rule: Seen Command
// proposes improvements to itself only behind a real failure, and seenjobs.io stays the priority.
//
// Everything external is injected, so tests run on a temp vault with no network. Never throws.

import { reportFailure, resolveBySuccess, updateTicket, listTickets, getTicket } from '../brain/lib/tickets.mjs';

export const BUILDER = 'seen-command-builder';
export const SYSTEM = 'seen-command';
const clip = (v, n) => { const s = String(v == null ? '' : v); return s.length > n ? s.slice(0, n) : s; };

// The two repos Seen Command builds, by the builder's short names.
export function repoFullName(short, config) {
  if (short === 'tool') return config.commandRepo();
  if (short === 'product') return config.githubRepo();
  return short || null;
}
export function builderRepoFor(fullName, config) {
  const r = String(fullName || '').toLowerCase();
  if (r && r === String(config.commandRepo()).toLowerCase()) return 'tool';
  if (r && r === String(config.githubRepo()).toLowerCase()) return 'product';
  return null;
}

// Collector run lines: "<Label> run failed — reason". The pull lines have their own words.
export function collectorThing(ev, run) {
  if (run && run.pipeline) return { thing: run.pipeline, label: run.label || run.pipeline };
  const s = String(ev.summary || '');
  const m = /^(.*?) run (failed|blocked|interrupted|completed|partial|cancelled)\b/.exec(s);
  if (m) return { thing: m[1].trim().toLowerCase(), label: m[1].trim() };
  if (/^employer[- ]board/i.test(s)) return { thing: 'employer-board pull', label: 'Employer-board pull' };
  if (/^company job/i.test(s)) return { thing: 'company job pull', label: 'Company job pull' };
  return null;
}

// What would have helped, per kind: the concrete ability or fix the failing step lacked. Written from the
// failure's own reason so an AI picking it up knows the target, not just the symptom.
export function helpedFor(kind, { reason = '', blocked = false, label = '' } = {}) {
  const why = clip(String(reason || '').replace(/\s+/g, ' ').trim(), 300) || 'the reason it reported';
  if (blocked) return `Only the owner can clear this — retrying will fail the same way: ${why}`;
  switch (kind) {
    case 'build_failed': return `Fix the cause so this build reaches a green test gate (or narrow the task so it can): ${why}`;
    case 'collector_failed': return `The ${label || 'collector'} must finish its run clean — fix what it reported: ${why}`;
    case 'meeting_failed': return `The board meeting must run end to end — fix the step that threw (and let it retry that step alone): ${why}`;
    case 'self_update_failed': return `Seen Command must install merged improvements by itself — fix: ${why}`;
    case 'approval_failed': return `An approved action must execute when approved — fix what made it fail: ${why}`;
    case 'pr_blocked': return `The PR must build and merge cleanly — fix: ${why}`;
    case 'test_red': return `The failing checks must go green without weakening them — fix: ${why}`;
    case 'proof_failed': return `The merged change must be observed working where it shipped — fix what the proof check found: ${why}`;
    case 'assistant_failed': return `The Board Room needs to complete this request — fix the lane or add the missing ability: ${why}`;
    default: return `Fix: ${why}`;
  }
}

export function createTicketSources({
  vault,                         // () => vault path | null
  config,                        // lib/config.mjs config
  readBuild = () => null,        // (id) => build record | null
  readRun = () => null,          // (id) => aggregation run record | null
  redact = (s) => String(s ?? ''),
  log = (m) => process.stderr.write(`[tickets] ${m}\n`),
  onWrite = () => {},            // called after any ticket write (the wire schedules a cloud push)
} = {}) {
  const wrote = () => { try { onWrite(); } catch { /* the vault already has it */ } };
  const V = () => { try { return vault(); } catch { return null; } };
  const safe = (fn) => { try { return fn(); } catch (e) { log(e.message); return { ok: false, error: e.message }; } };
  const toolRepo = () => { try { return String(config.commandRepo() || '').toLowerCase(); } catch { return ''; } };
  const report = (f) => { const v = V(); if (!v) return { ok: false, error: 'no brain vault' };
    const tool = !!f.tool || f.kind === 'assistant_failed' || (!!f.repo && String(f.repo).toLowerCase() === toolRepo());
    const helped = f.helped || helpedFor(f.kind, { reason: f.error, blocked: f.blocked, label: f.label });
    const out = safe(() => reportFailure(v, { ...f, tool, helped: redact(helped), error: redact(f.error), log: f.log ? redact(f.log) : null, title: f.title ? redact(f.title) : f.title, by: SYSTEM }));
    if (out && out.ok) wrote(); return out; };
  const resolve = (f) => { const v = V(); if (!v) return { ok: false, error: 'no brain vault' }; const out = safe(() => resolveBySuccess(v, { ...f, by: SYSTEM })); if (out && out.ok && out.action !== 'none') wrote(); return out; };
  const update = (id, patch) => { const v = V(); if (!v) return { ok: false }; const out = safe(() => updateTicket(v, { id, by: BUILDER, ...patch }, { asOwner: true })); if (out && out.ok) wrote(); return out; };

  // The ticket a build is fixing: a `ticket-<id>` build, or a ticket the owner re-kicked a build for.
  function ticketForBuild(buildId) {
    const v = V(); if (!v || !buildId) return null;
    if (String(buildId).startsWith('ticket-')) return safe(() => getTicket(v, String(buildId).slice(7))) || null;
    const hit = safe(() => listTickets(v, { status: 'active', limit: 500 }));
    const row = Array.isArray(hit) ? hit.find((t) => t && t.buildId === buildId) : null;
    return row ? getTicket(v, row.id) : null;
  }
  const runRef = (id, b, at) => `${id}@${(b && (b.startedAt || b.queuedAt)) || at || ''}`;
  const tail = (lines, n = 14) => (Array.isArray(lines) ? lines.slice(-n).join('\n') : lines ? String(lines) : null);

  function fixerFailed(t, why) {
    if (!t || !t.active) return null;
    return update(t.id, { status: 'open', requested: null, note: `The builder's fix attempt did not land: ${clip(redact(why), 400)}. Back to open — any AI can claim it.` });
  }
  function fixerSucceeded(t, b, status) {
    if (!t || !t.active) return null;
    if (b && b.pr) {
      const to = status === 'merged' ? 'merged' : 'pr_open';
      if (t.status === to) return null;
      if (to === 'merged' && t.status !== 'pr_open') update(t.id, { status: 'pr_open', prUrl: b.pr });
      return update(t.id, { status: to, prUrl: b.pr, note: `The builder opened ${b.pr}.` });
    }
    return update(t.id, { note: `The builder finished (${status}) without a PR${b && b.summary ? `: ${clip(b.summary, 200)}` : ''}.` });
  }

  function buildFailed(id, { reason, detail, blocked, at, source, title, key, repo } = {}) {
    const b = readBuild(id) || {};
    if (b.status === 'refused') return { ok: true, action: 'ignored' };
    const fixing = ticketForBuild(id);
    if (String(id).startsWith('ticket-')) return fixerFailed(fixing, reason || b.error || 'build failed');
    const r = report({
      kind: 'build_failed', repo: repoFullName(b.repo || repo, config), thing: b.key || key || id,
      title: `Build failed: ${clip(b.title || title || b.task || id, 120)}`,
      error: reason || b.error || 'build failed', log: detail || b.errorDetail || tail(b.log),
      ref: runRef(id, b, at), blocked: blocked ?? !!b.blocked, source: source || 'engine/build-runner.mjs',
      links: [b.pr, b.issue && b.issue.repo && b.issue.number ? `https://github.com/${b.issue.repo}/issues/${b.issue.number}` : null].filter(Boolean),
    });
    if (fixing && fixing.claimant === BUILDER) fixerFailed(fixing, reason || b.error || 'build failed');
    return r;
  }

  // ---- recordFailure hooks ------------------------------------------------------------------------
  function onFailure(rec) {
    if (!rec || !rec.id) return null;
    if (rec.kind === 'build' || !rec.kind) return buildFailed(rec.id, { reason: rec.reason, detail: rec.detail, blocked: rec.blocked, at: rec.at, source: rec.source, title: rec.title, key: rec.key, repo: rec.repo });
    const kind = { collector: 'collector_failed', deploy: 'deploy_drift', test: 'test_red', data: 'data_quality' }[rec.kind] || (/_/.test(rec.kind) ? rec.kind : 'other');
    return report({ kind, repo: repoFullName(rec.repo, config), thing: rec.key || rec.id, title: rec.title || `${rec.kind} ${rec.id} failed`,
      error: rec.reason, log: rec.detail, ref: `${rec.id}@${rec.at}`, blocked: !!rec.blocked, source: rec.source || 'lib/failure-loop.mjs' });
  }
  function onResolve({ id, how } = {}) {
    if (!id) return null;
    const b = readBuild(id) || {};
    return resolve({ kind: 'build_failed', repo: repoFullName(b.repo, config), thing: b.key || id, ref: id, how: how ? `fixed: ${how}` : null });
  }

  // ---- activity-ledger lines -------------------------------------------------------------------------
  function onActivity(ev) {
    if (!ev || !ev.kind) return null;
    const s = ev.status;
    if (ev.kind === 'failure') return null; // recordFailure's own line — handled by onFailure
    if (ev.kind === 'build') {
      if (['failed', 'preview_failed'].includes(s)) return buildFailed(ev.id, { reason: ev.summary, detail: ev.detail, at: ev.ts });
      if (['pr_ready', 'merged', 'green_dry'].includes(s)) {
        const b = readBuild(ev.id) || {};
        const fixing = ticketForBuild(ev.id);
        if (fixing) return fixerSucceeded(fixing, b, s);
        return resolve({ kind: 'build_failed', repo: repoFullName(b.repo, config), thing: b.key || ev.id, ref: ev.id, how: `the build ${s === 'merged' ? 'merged' : 'succeeded'}${b.pr ? ` — ${b.pr}` : ''}` });
      }
      if (s === 'refused' && String(ev.id || '').startsWith('ticket-')) return fixerFailed(ticketForBuild(ev.id), `the builder refused: ${ev.summary}`);
      return null;
    }
    if (ev.kind === 'pr-status') {
      const b = readBuild(ev.id) || {};
      const linked = ticketForBuild(ev.id);
      const repo = repoFullName(b.repo, config);
      if (s === 'ready') {
        if (linked) update(linked.id, { prState: 'ready' });
        resolve({ kind: 'test_red', repo, thing: `pr:${ev.id}`, ref: ev.id, how: 'the PR checks went green' });
        resolve({ kind: 'pr_blocked', repo, thing: `pr:${ev.id}`, ref: ev.id, how: 'the PR is mergeable again' });
        return { ok: true, action: 'ready' };
      }
      if (['checks_failing', 'conflicting'].includes(s)) {
        if (linked) return update(linked.id, { prState: s, note: clip(ev.summary, 300) });
        return report({ kind: s === 'conflicting' ? 'pr_blocked' : 'test_red', repo, thing: `pr:${ev.id}`,
          title: `${s === 'conflicting' ? 'PR conflicts with its base' : 'PR checks failing'}: ${clip(b.title || ev.id, 110)}`,
          error: ev.summary, log: ev.detail, ref: `${ev.id}@${ev.ts}`, links: b.pr ? [b.pr] : [], source: 'engine/build-runner.mjs (PR status)' });
      }
      return null;
    }
    if (ev.kind === 'aggregation') {
      const run = ev.id ? readRun(ev.id) : null;
      const who = collectorThing(ev, run);
      if (!who) return null;
      if (['failed', 'blocked', 'interrupted'].includes(s)) {
        return report({ kind: 'collector_failed', repo: null, thing: who.thing, label: `${who.label} collector`, title: `${who.label} collector ${s}`,
          error: (run && run.reason) || ev.summary, log: run ? tail(run.stderrTail) || tail(run.stdoutTail) : ev.detail,
          ref: ev.id ? `${ev.id}@${(run && run.startedAt) || ev.ts}` : `${who.thing}@${ev.ts}`, blocked: s === 'blocked', source: 'engine/aggregation-manager.mjs' });
      }
      if (['completed', 'done'].includes(s)) return resolve({ kind: 'collector_failed', repo: null, thing: who.thing, ref: ev.id, how: `${who.label} ran clean${ev.id ? ` (${ev.id})` : ''}` });
      return null;
    }
    if (ev.kind === 'meeting') {
      if (s === 'failed') return report({ kind: 'meeting_failed', repo: config.commandRepo(), thing: 'board meeting', title: 'Board meeting failed', error: ev.detail || ev.summary, ref: `${ev.id}@${ev.ts}`, source: 'engine/run.mjs' });
      if (s === 'completed') return resolve({ kind: 'meeting_failed', repo: config.commandRepo(), thing: 'board meeting', ref: ev.id, how: `board meeting ${ev.id} completed` });
      return null;
    }
    if (ev.kind === 'self-update') {
      if (s === 'failed') return report({ kind: 'self_update_failed', repo: config.commandRepo(), thing: 'self-update', title: 'Seen Command could not update itself', error: ev.detail || ev.summary, ref: `${ev.id || 'self-update'}@${ev.ts}`, source: 'engine/self-update.mjs' });
      if (s === 'updated') return resolve({ kind: 'self_update_failed', repo: config.commandRepo(), thing: 'self-update', ref: ev.id, how: 'the next self-update succeeded' });
      return null;
    }
    if (ev.kind === 'approval' && ev.id) {
      if (s === 'failed') return report({ kind: 'approval_failed', repo: config.commandRepo(), thing: `approval ${ev.id}`, title: clip(ev.summary, 150), error: ev.detail || ev.summary, ref: `${ev.id}@${ev.ts}`, source: 'engine/server.mjs (approvals)' });
      if (s === 'approved') return resolve({ kind: 'approval_failed', repo: config.commandRepo(), thing: `approval ${ev.id}`, ref: ev.id, how: 'the approval went through' });
      return null;
    }
    if (ev.kind === 'verdict' && ev.id) {
      // engine/pr-verify.mjs: the Vercel preview of a builder PR settled. id = "<owner/repo>#<n>".
      const m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(String(ev.id));
      const repo = m ? m[1] : null;
      const thing = `preview ${ev.id}`;
      if (['ERROR', 'FAILED'].includes(String(s).toUpperCase())) {
        return report({ kind: 'pr_blocked', repo, thing, title: `Preview build ${String(s).toUpperCase()} on ${ev.id}`, error: ev.summary || `preview build ${s}`,
          ref: `${ev.id}@${ev.ts}`, links: m ? [`https://github.com/${m[1]}/pull/${m[2]}`] : [], source: 'engine/pr-verify.mjs' });
      }
      if (String(s).toUpperCase() === 'READY') return resolve({ kind: 'pr_blocked', repo, thing, ref: ev.id, how: 'the preview build is READY' });
      return null;
    }
    if (ev.kind === 'proof' && ev.id) {
      // engine/completion.mjs: a merged build's change observed (or not) where it shipped.
      const b = readBuild(ev.id) || {};
      const repo = repoFullName(b.repo, config);
      const thing = `proof ${b.key || ev.id}`;
      if (s === 'failed') return report({ kind: 'proof_failed', repo, thing, title: `Not proven after merge: ${clip(b.title || ev.id, 110)}`, error: ev.summary || 'a proof condition failed',
        ref: `${ev.id}@${ev.ts}`, links: b.pr ? [b.pr] : [], source: 'engine/completion.mjs' });
      if (s === 'proven') return resolve({ kind: 'proof_failed', repo, thing, ref: ev.id, how: 'every proof condition is now observed' });
      return null;
    }
    if (ev.kind === 'assistant') {
      // engine/agent-chat.mjs: a Board Room turn the assistant could not complete (lane down, error, no
      // answer). One ticket per lane+cause; the next clean turn on that lane resolves it.
      const lane = String((ev.id || 'chat')).slice(0, 60);
      if (s === 'failed') return report({ kind: 'assistant_failed', repo: config.commandRepo(), thing: `board room ${lane}`, title: `The Board Room could not answer (${lane})`,
        error: ev.detail || ev.summary || 'the turn failed', log: ev.summary && ev.detail ? `request: ${clip(ev.summary, 300)}` : null, ref: `${lane}@${ev.ts}`,
        blocked: /log ?in|logged out|not installed|credit|billing|quota|api key|unauthor/i.test(String(ev.detail || '')),
        source: 'engine/agent-chat.mjs' });
      if (s === 'answered') return resolve({ kind: 'assistant_failed', repo: config.commandRepo(), thing: `board room ${lane}`, ref: ev.id, how: `the ${lane} lane answered a turn` });
      return null;
    }
    if (ev.kind === 'drift' && s === 'schema') {
      // The live database is missing functions the code calls: a migration only the owner can apply.
      return report({ kind: 'data_quality', repo: config.githubRepo(), thing: 'schema drift', title: 'Live database is behind the code (schema drift)',
        error: ev.summary, log: ev.detail, ref: `drift@${ev.ts}`, blocked: true, source: 'scripts/schema-drift.mjs' });
    }
    return null;
  }

  // Direct reports from CLIs that are not on the activity ledger (deploy drift, base-branch health), and
  // the assistant's own "I could not do this — here is what would have helped" (POST /api/tickets).
  const reportFrom = (f) => report(f);
  const resolveFrom = (f) => resolve(f);

  return { onFailure, onResolve, onActivity, reportFrom, resolveFrom, ticketForBuild };
}

// The builder task for a ticket that has no build of its own to re-run. Plain language, the evidence the
// coder needs, and the rule that it must fix the cause rather than silence the symptom.
export function composeFixTask(t) {
  const ev = t.evidence || {};
  return [
    `Fix the failure tracked by brain ticket ${t.id}: ${t.title}.`,
    `Kind: ${t.kindLabel || t.kind}. It has failed ${t.count || 1} time(s); last seen ${ev.at || t.lastSeen || 'recently'}.`,
    ev.error ? `Latest error: ${clip(ev.error, 1200)}` : '',
    ev.log ? `Log excerpt:\n${clip(ev.log, 1800)}` : '',
    t.plan ? `Plan already written on the ticket:\n${clip(t.plan, 1500)}` : '',
    'Find and fix the root cause in this repository — do not hide the error, skip the check, or weaken a test. Add or extend a test that fails without the fix. Keep the existing tests green.',
  ].filter(Boolean).join('\n\n').slice(0, 6000);
}
