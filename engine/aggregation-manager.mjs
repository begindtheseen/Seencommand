// Aggregation manager — the deterministic orchestrator behind the Aggregation Dashboard. It manages
// Seen's three local collectors through separate adapters and never merges their implementations:
//   • company_intel → lib/aggregation/company-intel.mjs → Seen scripts/collect-reddit-company-intel.mjs
//   • indeed        → lib/aggregation/indeed.mjs        → Seen scripts/ingest-indeed-opencli.mjs
//   • career_site   → lib/aggregation/career-site.mjs   → Seen scripts/collect-career-site.mjs
//   • applicant_reports → lib/aggregation/applicant-reports.mjs → Seen scripts/collect-archive-reports.mjs
//     (the free Reddit archive; no browser, so it does not take the Browser Bridge)
//   • web_reports   → lib/aggregation/web-reports.mjs   → Seen scripts/collect-web-reports.mjs (Google in Chrome)
// plus two one-call Seen actions that run server-side (employer boards, and the company-first job pull
// that also starts Indeed + career-site runs for the same companies).
//
// Responsibilities: collector registry + capability discovery, configuration validation, readiness,
// execution (explicit argv, explicit env, no shell), queueing, run-state tracking, bounded + redacted
// history, cancellation of OWNED children only, restart recovery, independent schedules, and the
// Chronos write-back of meaningful outcomes. Agents read through snapshot(); they cannot start runs.
//
// Concurrency: every collector drives the SAME local Chrome Browser Bridge through OpenCLI, and
// concurrent bridge sessions are not verified safe — so they share the `browser-bridge` resource and
// at most one run holds it. A second request queues behind it. One active run per pipeline. A collector
// that declares no resources (applicant_reports) runs alongside them.

import { spawn } from 'node:child_process';
import { join, isAbsolute } from 'node:path';
import { createStore, newRunId, redact, tailLines, PIPELINES, TERMINAL, ACTIVE } from '../lib/aggregation/store.mjs';
import { adapter as companyIntel } from '../lib/aggregation/company-intel.mjs';
import { adapter as indeed, validateCompanyJobs } from '../lib/aggregation/indeed.mjs';
import { adapter as careerSite, cleanStartUrl } from '../lib/aggregation/career-site.mjs';
import { adapter as applicantReports } from '../lib/aggregation/applicant-reports.mjs';
import { adapter as webReports } from '../lib/aggregation/web-reports.mjs';
import { resolveSeenRepo, probeOpenCli, readSource, readDirectImports } from '../lib/aggregation/probes.mjs';
import { validateSchedule, defaultSchedule, evaluate, nextSlot } from '../lib/aggregation/schedule.mjs';
import { factsForRun, scheduleFact, headline } from '../lib/aggregation/memory.mjs';
import { createSearch } from './search.mjs';
import { config as appConfig } from '../lib/config.mjs';

const HEALTH_TTL_MS = 60_000;
// The company catalog reads every open listing in Seen (~2 MB of database egress), so it is cached.
const LIST_TTL_MS = 30 * 60_000;
const MAX_STREAM_BYTES = 2 * 1024 * 1024;
const QUEUE_EXPIRY_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const CONTROL = /[\u0000-\u001f\u007f]/;
export const NETWORK_ENV = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'NODE_USE_ENV_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE'];
// The source a run's listings came from, as the history filter names it.
const SOURCE_OF = { indeed: 'indeed', company_intel: 'reddit', career_site: 'career_site', applicant_reports: 'reddit_archive', web_reports: 'google' };

export const DEFAULT_ADAPTERS = { company_intel: companyIntel, indeed, career_site: careerSite, applicant_reports: applicantReports, web_reports: webReports };
// A collector with a preview/import choice declares `modes`; the others have one mode, `run`.
const modesOf = (a) => a.modes || ['run'];

export function createAggregationManager({
  store = createStore(),
  adapters = DEFAULT_ADAPTERS,
  spawnImpl = spawn,
  env = () => process.env,
  now = () => new Date(),
  execPath = process.execPath,
  recordFacts = null,          // lazily the canonical lib/brain.mjs writer (kept lazy so tests never touch a vault)
  logActivity = null,
  notify = null,               // lib/notifications.mjs notify — every run end tells the owner (Notifications tab + macOS)
  maxAttempts = 2,             // a PARTIAL run is re-run automatically, at most this many runs in total (owner, 2026-10-21)
  onRunEnd = null,             // engine/search.mjs: a run that belongs to a search settles that search
  readinessDeps = {},
  maxRunMs = 4 * 60 * 60 * 1000,
  killGraceMs = 10_000,
  fetchImpl = (...a) => fetch(...a),
} = {}) {
  const live = new Map();          // runId → { child, cancelled, timedOut, timer, killTimer }
  let healthCache = null;          // { at, value }
  let healthInflight = null;
  let tickTimer = null;

  const E = () => env();
  const activity = (ev) => { try { (logActivity || (() => {}))(ev); } catch { /* the ledger is best-effort */ } };
  const tell = (n) => { try { (notify || (() => {}))(n); } catch { /* a notification never fails a run */ } };
  const writeFacts = async (facts) => {
    if (!facts.length) return { written: 0 };
    try {
      const fn = recordFacts || (await import('../lib/brain.mjs')).recordFacts;
      return fn(facts) || { written: 0 };
    } catch (e) { return { written: 0, error: e.message }; }
  };

  // ---- configuration ---------------------------------------------------------------------------
  function repoDir(cfg = readConfigRaw()) { return resolveSeenRepo(cfg.seenRepoDir); }
  function capsFor(pipeline, dir = repoDir()) { const a = adapters[pipeline]; return a.discoverCapabilities(readSource(dir, a.script), readDirectImports(dir, a.script)); }
  function readConfigRaw() {
    const c = store.readConfig() || {};
    return { version: 1, seenRepoDir: c.seenRepoDir || null, pipelines: c.pipelines || {} };
  }
  function getConfig() {
    const raw = readConfigRaw(); const dir = repoDir(raw);
    const pipelines = {};
    for (const p of PIPELINES) {
      const caps = capsFor(p, dir);
      const stored = raw.pipelines[p] || adapters[p].defaults(caps);
      const v = adapters[p].validateConfig(stored, caps);
      pipelines[p] = { config: v.config, valid: v.ok, errors: v.errors, capabilities: caps, estimate: adapters[p].estimateWork(v.config, caps) };
    }
    return { seenRepoDir: raw.seenRepoDir, effectiveSeenRepoDir: redact(dir, E()), defaultSeenRepoDir: redact(appConfig.productRepoDir(), E()), pipelines };
  }
  function putConfig(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, code: 400, error: 'config must be an object' };
    for (const k of Object.keys(input)) if (!['seenRepoDir', 'pipelines'].includes(k)) return { ok: false, code: 400, error: `unknown config field: ${k}` };
    const raw = readConfigRaw(); const next = { ...raw, pipelines: { ...raw.pipelines } };
    if (input.seenRepoDir !== undefined) {
      if (input.seenRepoDir === null || input.seenRepoDir === '') next.seenRepoDir = null;
      else {
        const d = String(input.seenRepoDir);
        if (!isAbsolute(d) || CONTROL.test(d) || d.length > 1024) return { ok: false, code: 400, error: 'the Seen repository path must be an absolute path' };
        next.seenRepoDir = d;
      }
    }
    const errors = {};
    for (const [p, cfg] of Object.entries(input.pipelines || {})) {
      if (!PIPELINES.includes(p)) return { ok: false, code: 400, error: `unknown pipeline: ${p}` };
      const v = adapters[p].validateConfig(cfg, capsFor(p, repoDir(next)));
      if (!v.ok) errors[p] = v.errors; else next.pipelines[p] = v.config;
    }
    if (Object.keys(errors).length) return { ok: false, code: 422, error: 'configuration rejected', errors };
    store.writeConfig(next);
    healthCache = null;
    activity({ kind: 'aggregation', status: 'config', summary: `aggregation configuration saved (${Object.keys(input.pipelines || {}).join(', ') || 'repository path'})` });
    return { ok: true, config: getConfig() };
  }

  // ---- readiness -------------------------------------------------------------------------------
  function modeStatus(checks, mode) {
    const applies = (c) => !c.modes || c.modes.includes(mode);
    const bad = new Set(['missing', 'broken', 'unauthorized', 'not_deployed', 'invalid']);
    if (checks.some((c) => applies(c) && c.blocking && bad.has(c.status))) return 'blocked';
    if (checks.some((c) => applies(c) && !c.informational && ['degraded', 'unknown', 'unverified'].includes(c.status))) return 'degraded';
    return 'ready';
  }
  async function computeHealth() {
    const dir = repoDir();
    const cli = (readinessDeps.probeOpenCli || probeOpenCli)();
    const deps = { ...readinessDeps, probeOpenCli: () => cli };
    const out = { checkedAt: now().toISOString(), seenRepoDir: redact(dir, E()), pipelines: {} };
    for (const p of PIPELINES) {
      let r;
      try { r = await adapters[p].readiness({ repoDir: dir, env: E(), deps }); }
      catch (e) { r = { checks: [{ id: 'readiness', label: 'Readiness check', blocking: true, status: 'broken', detail: `readiness check crashed: ${redact(e.message, E())}` }], caps: { found: false } }; }
      const last = lastTerminal(p);
      if (last && ['blocked', 'failed'].includes(last.status)) {
        const top = (last.diagnostics?.failureCategories || [])[0];
        r.checks.push({ id: 'last-run', label: 'Last run', blocking: false, status: 'degraded',
          detail: `Run ${last.id} (${String(last.endedAt || '').slice(0, 16).replace('T', ' ')} UTC) ended ${last.status}: ${last.reason || top?.label || 'see run detail'}`, fix: top?.fix || null });
      }
      const modes = Object.fromEntries(modesOf(adapters[p]).map((m) => [m, modeStatus(r.checks, m)]));
      const overall = Object.values(modes).includes('ready') ? (Object.values(modes).every((m) => m === 'ready') ? 'ready' : 'degraded')
        : Object.values(modes).every((m) => m === 'blocked') ? 'blocked' : 'degraded';
      out.pipelines[p] = { status: overall, modes, checks: r.checks, endpoint: r.endpoint || null, environment: r.environment || 'local' };
    }
    return out;
  }
  async function health({ refresh = false } = {}) {
    if (!refresh && healthCache && now().getTime() - healthCache.at < HEALTH_TTL_MS) return healthCache.value;
    if (healthInflight) return healthInflight;
    healthInflight = computeHealth().then((value) => { healthCache = { at: now().getTime(), value }; return value; }).finally(() => { healthInflight = null; });
    return healthInflight;
  }

  // ---- runs ------------------------------------------------------------------------------------
  const runs = () => store.allRuns();
  const lastTerminal = (p) => runs().find((r) => r.pipeline === p && TERMINAL.has(r.status) && r.status !== 'cancelled');
  const activeFor = (p) => runs().find((r) => r.pipeline === p && ACTIVE.has(r.status));
  const modeOf = (p, cfg) => (adapters[p].modes ? cfg.mode : 'run');

  async function startRun({ pipeline, overrides = null, trigger = 'manual', confirmLarge = false, owner = 'local-operator', retryOf = null, attempt = 1, searchId = null } = {}) {
    if (!PIPELINES.includes(pipeline)) return { ok: false, code: 400, error: `pipeline must be one of ${PIPELINES.join(', ')}` };
    if (!['manual', 'schedule', 'catchup', 'retry'].includes(trigger)) return { ok: false, code: 400, error: 'invalid trigger' };
    const a = adapters[pipeline];
    const dir = repoDir(); const caps = capsFor(pipeline, dir);
    const saved = readConfigRaw().pipelines[pipeline] || a.defaults(caps);
    const merged = overrides && typeof overrides === 'object' ? { ...saved, ...overrides } : saved;
    const v = a.validateConfig(merged, caps);
    if (!v.ok) return { ok: false, code: 422, error: 'configuration rejected', errors: v.errors };
    const cfg = v.config;
    const existing = activeFor(pipeline);
    if (existing) return { ok: false, code: 409, error: `a ${a.label} run is already ${existing.status}`, run: summarize(existing) };
    const h = await health();
    const ph = h.pipelines[pipeline]; const mode = modeOf(pipeline, cfg);
    if (ph.modes[mode] === 'blocked') {
      const blockers = ph.checks.filter((c) => c.blocking && (!c.modes || c.modes.includes(mode)) && !['ok', 'unknown', 'degraded'].includes(c.status));
      return { ok: false, code: 422, error: `${a.label} is blocked`, blockers: blockers.map((c) => ({ id: c.id, label: c.label, detail: c.detail, fix: c.fix || null })) };
    }
    const estimate = a.estimateWork(cfg, caps);
    if (estimate.large && trigger === 'manual' && confirmLarge !== true) {
      return { ok: false, code: 409, needsConfirmation: true, estimate, error: 'this is a large run — confirm it explicitly' };
    }
    const at = now();
    const run = {
      id: newRunId(pipeline, at), pipeline, label: a.label, trigger, owner, environment: a.environment,
      status: 'queued', createdAt: at.toISOString(), startedAt: null, endedAt: null, durationMs: null,
      config: { ...cfg, presets: undefined }, estimate, mode, readinessAtStart: ph.modes[mode],
      resources: a.resources, metrics: null, diagnostics: null, reason: null, exitCode: null, signal: null,
      stdoutTail: [], stderrTail: [], events: [{ at: at.toISOString(), text: `queued (${trigger}${retryOf ? ` of ${retryOf}, run ${attempt} of ${maxAttempts}` : ''})` }],
      attempt, retryOf, ...(searchId ? { searchId: String(searchId).slice(0, 80) } : {}),
    };
    store.writeRun(run);
    activity({ kind: 'aggregation', id: run.id, status: 'queued', summary: `${a.label} run queued (${trigger}${a.modes ? `, ${cfg.mode}` : ''})` });
    pump();
    return { ok: true, run: summarize(store.readRun(run.id) || run) };
  }

  function busyResources() {
    const busy = new Set();
    for (const r of runs()) if (r.status === 'running') for (const res of r.resources || []) busy.add(res);
    return busy;
  }
  function pump() {
    const queued = runs().filter((r) => r.status === 'queued').sort((x, y) => String(x.createdAt).localeCompare(String(y.createdAt)));
    for (const r of queued) {
      const busy = busyResources();
      if ((r.resources || []).some((res) => busy.has(res))) {
        if (!r.waitingFor) { r.waitingFor = 'browser-bridge'; r.events.push({ at: now().toISOString(), text: 'waiting: another collector is using the Chrome Browser Bridge' }); store.writeRun(r); }
        continue;
      }
      launch(r);
    }
  }

  function childEnv(extra) {
    const e = E(); const base = {};
    for (const k of ['HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'SHELL']) if (e[k]) base[k] = e[k];
    // Network settings only (a proxy, an extra certificate authority) — a Mac on a managed network needs
    // them for the collectors that reach the internet directly (the Reddit archive). No credentials.
    for (const k of NETWORK_ENV) if (e[k]) base[k] = e[k];
    base.PATH = appConfig.toolPath();
    // The packaged app runs this server as an ELECTRON_RUN_AS_NODE child of Electron's embedded Node;
    // the collector needs the same flag to run as plain Node from that binary.
    if (process.versions.electron || e.ELECTRON_RUN_AS_NODE) base.ELECTRON_RUN_AS_NODE = '1';
    return { ...base, ...extra };
  }

  function launch(run) {
    const a = adapters[run.pipeline];
    const dir = repoDir();
    const cmd = a.command(run.config, E());
    const script = join(dir, cmd.script);
    run.status = 'running'; run.startedAt = now().toISOString(); run.waitingFor = null;
    run.events.push({ at: run.startedAt, text: `started ${cmd.script}${cmd.args.length ? ` ${cmd.args.join(' ')}` : ''}` });
    store.writeRun(run);
    activity({ kind: 'aggregation', id: run.id, status: 'running', summary: `${a.label} run started` });
    let child;
    try {
      child = spawnImpl(execPath, [script, ...cmd.args], { cwd: dir, env: childEnv(cmd.env), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { return finalize(run, { code: null, signal: null, stdout: '', stderr: `spawn failed: ${e.message}`, spawnError: true }); }
    const entry = { child, cancelled: false, timedOut: false, stdout: '', stderr: '', lastSave: 0 };
    live.set(run.id, entry);
    run.pid = child.pid || null;
    const cap = (s) => (s.length > MAX_STREAM_BYTES ? s.slice(-MAX_STREAM_BYTES) : s);
    const progress = () => {
      const t = now().getTime(); if (t - entry.lastSave < 2000) return; entry.lastSave = t;
      const r = store.readRun(run.id); if (!r || r.status !== 'running') return;
      r.stdoutTail = tailLines(entry.stdout, { lines: 40, env: E() }); r.stderrTail = tailLines(entry.stderr, { lines: 40, env: E() });
      store.writeRun(r);
    };
    child.stdout?.on('data', (c) => { entry.stdout = cap(entry.stdout + c); progress(); });
    child.stderr?.on('data', (c) => { entry.stderr = cap(entry.stderr + c); progress(); });
    entry.timer = setTimeout(() => { entry.timedOut = true; killGroup(entry); }, maxRunMs);
    entry.timer.unref?.();
    let done = false;
    const end = (code, signal, spawnErr) => {
      if (done) return; done = true;
      clearTimeout(entry.timer); clearTimeout(entry.killTimer); live.delete(run.id);
      finalize(store.readRun(run.id) || run, { code, signal, stdout: entry.stdout, stderr: spawnErr ? `${entry.stderr}\n${spawnErr}` : entry.stderr, cancelled: entry.cancelled, timedOut: entry.timedOut, spawnError: !!spawnErr });
    };
    child.on('error', (e) => end(null, null, `spawn failed: ${e.code || ''} ${e.message}`));
    child.on('close', (code, signal) => end(code, signal));
    return run;
  }

  function killGroup(entry) {
    const pid = entry.child?.pid;
    const sig = (s) => { try { if (pid) process.kill(-pid, s); else entry.child.kill(s); } catch { try { entry.child.kill(s); } catch { /* already gone */ } } };
    sig('SIGTERM');
    entry.killTimer = setTimeout(() => sig('SIGKILL'), killGraceMs);
    entry.killTimer.unref?.();
  }

  function finalize(run, { code, signal, stdout, stderr, cancelled = false, timedOut = false, spawnError = false }) {
    const a = adapters[run.pipeline];
    let out;
    if (spawnError) {
      out = { status: 'failed', reason: `could not start the collector: ${redact(stderr, E()).trim().slice(0, 200)}`, metrics: null,
        diagnostics: { failureCategories: [], fatal: redact(stderr, E()).trim().slice(0, 300) } };
    } else {
      try { out = a.interpret({ code, signal, stdout, stderr, cancelled, timedOut, config: run.config, caps: capsFor(run.pipeline) }); }
      catch (e) { out = { status: 'failed', reason: `could not interpret collector output: ${e.message}`, metrics: null, diagnostics: { failureCategories: [] } }; }
    }
    const ended = now();
    Object.assign(run, {
      status: out.status, reason: out.reason ? redact(out.reason, E()) : null, metrics: out.metrics, diagnostics: JSON.parse(redact(JSON.stringify(out.diagnostics || {}), E())),
      exitCode: code, signal: signal || null, endedAt: ended.toISOString(),
      durationMs: run.startedAt ? ended.getTime() - new Date(run.startedAt).getTime() : null,
      stdoutTail: tailLines(stdout, { env: E() }), stderrTail: tailLines(stderr, { env: E() }), pid: null,
    });
    run.events.push({ at: run.endedAt, text: `${run.status}${run.reason ? ` — ${run.reason}` : ''}` });
    store.writeRun(run);
    activity({ kind: 'aggregation', id: run.id, status: run.status, summary: `${a.label} run ${run.status}${run.reason ? ` — ${run.reason}` : ''}`.slice(0, 200) });
    healthCache = null;
    remember(run).catch(() => {});
    if (run.trigger === 'schedule' || run.trigger === 'catchup') {
      const all = schedulesRaw(); const s = all[run.pipeline];
      if (s && s.lastRunId === run.id) { s.lastOutcome = run.status; store.writeSchedules(all); }
    }
    try { store.prune(); } catch { /* pruning never fails a run */ }
    const selfRetried = typeof a.retriesItself === 'function' && (() => { try { return a.retriesItself(capsFor(run.pipeline)); } catch { return false; } })();
    const willRetry = run.status === 'partial' && !cancelled && !selfRetried && (run.attempt || 1) < maxAttempts && !(run.config && run.config.mode === 'dry_run');
    tell(runNotice(run, a.label, willRetry));
    if (willRetry) setImmediate(() => { retry(run).catch(() => {}); });
    else if (run.searchId && onRunEnd) setImmediate(() => { try { onRunEnd(run); } catch { /* a search summary never fails a run */ } });
    setImmediate(pump);
    return run;
  }

  // "If a search is partially complete it must automatically run it back to get a full search … after 2
  // runs if it's still partially complete it can stop" (owner, 2026-10-21). Same settings, trigger 'retry'.
  async function retry(run) {
    const overrides = { ...(run.config || {}) }; delete overrides.presets;
    const r = await startRun({ pipeline: run.pipeline, overrides, trigger: 'retry', owner: 'auto-retry', retryOf: run.id, attempt: (run.attempt || 1) + 1, searchId: run.searchId || null });
    if (!r.ok) tell({ kind: 'run', level: 'warning', title: `${adapters[run.pipeline].label}: automatic re-run did not start`, body: r.error || 'unknown reason', tab: 'aggregation', ref: run.id });
    return r;
  }

  function runNotice(run, label, willRetry) {
    const level = run.status === 'completed' ? 'success' : run.status === 'partial' ? 'warning' : ['failed', 'blocked', 'interrupted'].includes(run.status) ? 'error' : 'info';
    const verb = { completed: 'finished', partial: 'finished partly', failed: 'failed', blocked: 'was blocked', cancelled: 'was cancelled', interrupted: 'was interrupted' }[run.status] || run.status;
    const of = run.attempt > 1 ? ` (run ${run.attempt} of ${maxAttempts})` : '';
    const what = headline(run);
    const parts = [what && what !== run.status ? what : null, run.status !== 'completed' && run.reason && run.reason !== what ? run.reason : null,
      willRetry ? `Re-running it automatically (run ${(run.attempt || 1) + 1} of ${maxAttempts}).` : run.status === 'partial' && run.attempt >= maxAttempts ? `Still partial after ${maxAttempts} runs — stopped.` : null];
    return { kind: 'run', level, title: `${label} ${verb}${of}`, body: parts.filter(Boolean).join(' · '), tab: 'aggregation', ref: run.id };
  }

  async function remember(run) {
    const st = store.readState(); const mem = st.memory || {};
    const { facts, state } = factsForRun(run, mem[run.pipeline] || {});
    const r = await writeFacts(facts);
    // Only advance the remembered state once the facts landed, so a missing vault is retried later.
    if (facts.length && !(r && r.written >= 0 && !r.error)) return;
    store.writeState({ ...store.readState(), memory: { ...mem, [run.pipeline]: state } });
  }

  function cancelRun(id) {
    const run = store.readRun(id);
    if (!run) return { ok: false, code: 404, error: 'no such run' };
    if (run.status === 'queued') {
      run.status = 'cancelled'; run.endedAt = now().toISOString(); run.reason = 'cancelled before it started';
      run.events.push({ at: run.endedAt, text: 'cancelled while queued' }); store.writeRun(run);
      activity({ kind: 'aggregation', id, status: 'cancelled', summary: `${run.label} run cancelled while queued` });
      setImmediate(pump);
      return { ok: true, run: summarize(run) };
    }
    if (run.status !== 'running') return { ok: false, code: 409, error: `run is already ${run.status}` };
    if (!adapters[run.pipeline].cancellable) return { ok: false, code: 409, error: 'this collector cannot be cancelled safely' };
    const entry = live.get(id);
    // Never signal a pid this process does not own — after a restart it may belong to anything.
    if (!entry) return { ok: false, code: 409, error: 'this run is not owned by the current Seen Command process' };
    entry.cancelled = true;
    run.events.push({ at: now().toISOString(), text: 'cancellation requested' }); store.writeRun(run);
    killGroup(entry);
    return { ok: true, run: summarize(run), note: adapters[run.pipeline].cancelNote };
  }

  // Runs left `running` by a previous process were not adopted (their pipes died with it) → interrupted.
  // Queued runs older than an hour expire instead of starting by surprise long after they were asked for.
  function recover() {
    const t = now();
    for (const r of runs()) {
      if (r.status === 'running' && !live.has(r.id)) {
        Object.assign(r, { status: 'interrupted', endedAt: t.toISOString(), pid: null,
          reason: 'Seen Command stopped while this run was active; the collector was not adopted. Batches already submitted stay stored — start a new run to continue.' });
        r.events.push({ at: r.endedAt, text: 'recovered as interrupted after restart' }); store.writeRun(r);
      } else if (r.status === 'queued' && t.getTime() - new Date(r.createdAt).getTime() > QUEUE_EXPIRY_MS) {
        Object.assign(r, { status: 'cancelled', endedAt: t.toISOString(), reason: 'expired in the queue across a restart (not started late by surprise)' });
        r.events.push({ at: r.endedAt, text: 'expired in queue' }); store.writeRun(r);
      }
    }
  }

  // ---- views -----------------------------------------------------------------------------------
  function summarize(r) {
    if (!r) return null;
    return { id: r.id, pipeline: r.pipeline, label: r.label, trigger: r.trigger, status: r.status, mode: r.mode, environment: r.environment,
      createdAt: r.createdAt, startedAt: r.startedAt, endedAt: r.endedAt, durationMs: r.durationMs, reason: r.reason, waitingFor: r.waitingFor || null,
      metrics: r.metrics, failureCategories: r.diagnostics?.failureCategories || [], source: SOURCE_OF[r.pipeline] || r.pipeline };
  }
  function listRuns({ pipeline, status, since, until, source, limit = 100 } = {}) {
    const lim = Math.min(500, Math.max(1, Number(limit) || 100));
    const s = since ? new Date(since).getTime() : null; const u = until ? new Date(until).getTime() : null;
    return runs().filter((r) => (!pipeline || r.pipeline === pipeline) && (!status || r.status === status)
      && (!source || SOURCE_OF[r.pipeline] === source)
      && (s == null || new Date(r.createdAt).getTime() >= s) && (u == null || new Date(r.createdAt).getTime() <= u))
      .slice(0, lim).map(summarize);
  }
  const getRun = (id) => store.readRun(id);

  function importedWithin(p, ms) {
    const since = now().getTime() - ms;
    const rs = runs().filter((r) => r.pipeline === p && TERMINAL.has(r.status) && new Date(r.endedAt || r.createdAt).getTime() >= since);
    if (p === 'indeed') {
      const vals = rs.map((r) => r.metrics?.written).filter((v) => v != null);
      return { runs: rs.length, value: vals.length ? vals.reduce((x, y) => x + y, 0) : null, unit: 'listing rows written or refreshed', unreported: rs.length - vals.length };
    }
    if (p === 'applicant_reports' || p === 'web_reports') {
      const real = rs.filter((r) => r.metrics && r.metrics.dryRun === false);
      const vals = real.map((r) => r.metrics.newReports).filter((v) => v != null);
      return { runs: rs.length, value: vals.length ? vals.reduce((x, y) => x + y, 0) : null, unit: p === 'web_reports' ? 'new applicant reports from Google' : 'new applicant reports from the Reddit archive', dryRuns: rs.length - real.length, unreported: real.length - vals.length };
    }
    if (p === 'career_site') {
      const real = rs.filter((r) => r.metrics && r.metrics.dryRun !== true);
      const vals = real.map((r) => r.metrics.saved).filter((v) => v != null);
      return { runs: rs.length, value: vals.length ? vals.reduce((x, y) => x + y, 0) : null, unit: 'jobs saved from career sites', unreported: real.length - vals.length };
    }
    const real = rs.filter((r) => r.metrics && r.metrics.dryRun === false);
    const vals = real.map((r) => r.metrics.importedReports).filter((v) => v != null);
    const com = real.map((r) => r.metrics.commentary).filter((v) => v != null);
    return { runs: rs.length, value: vals.length ? vals.reduce((x, y) => x + y, 0) : null, commentary: com.length ? com.reduce((x, y) => x + y, 0) : null,
      unit: 'applicant reports imported (plus commentary excerpts)', dryRuns: rs.length - real.length, unreported: real.length - vals.length };
  }

  async function status() {
    const h = await health();
    const sch = schedulesRaw();
    const pipelines = {};
    for (const p of PIPELINES) {
      const a = adapters[p]; const ph = h.pipelines[p];
      const active = activeFor(p); const last = lastTerminal(p);
      const lastSuccess = runs().find((r) => r.pipeline === p && r.status === 'completed');
      const state = active ? (active.status === 'queued' ? 'queued' : 'running')
        : ph.status === 'blocked' ? 'blocked'
          : last && last.status !== 'interrupted' ? ({ completed: 'completed', partial: 'partial', failed: 'failed', blocked: 'blocked' }[last.status] || 'ready')
            : ph.status === 'ready' ? 'ready' : 'degraded';
      const problems = ph.checks.filter((c) => !c.informational && !['ok'].includes(c.status)).map((c) => ({ id: c.id, label: c.label, status: c.status, detail: c.detail, blocking: !!c.blocking }));
      const actions = ph.checks.filter((c) => c.fix && !['ok'].includes(c.status) && !c.informational).map((c) => c.fix);
      pipelines[p] = {
        id: p, label: a.label, description: a.description, environment: a.environment, executes: a.executes, state, readiness: ph.status, modes: ph.modes,
        activeRun: summarize(active), lastRun: summarize(last), lastSuccess: summarize(lastSuccess),
        recent: importedWithin(p, WEEK_MS), problems, actions: [...new Set(actions)],
        schedule: { enabled: !!sch[p].enabled, nextRunAt: sch[p].enabled ? sch[p].nextRunAt : null, frequency: sch[p].frequency, time: sch[p].time, weekday: sch[p].weekday },
      };
    }
    return { checkedAt: h.checkedAt, pipelines, sharedResource: 'The Chrome collectors (Company Intelligence, Indeed, Career Sites, Google Reports) share the one local Browser Bridge, so they run one at a time; a second run queues. Applicant Reports needs no browser and runs alongside them.' };
  }

  function collectors() {
    const dir = repoDir();
    return PIPELINES.map((p) => { const a = adapters[p]; return { id: p, label: a.label, description: a.description, environment: a.environment, executes: a.executes, script: a.script, resources: a.resources, cancellable: a.cancellable, cancelNote: a.cancelNote, capabilities: capsFor(p, dir) }; });
  }

  // ---- schedules -------------------------------------------------------------------------------
  function schedulesRaw() {
    const s = store.readSchedules() || {};
    const out = {};
    for (const p of PIPELINES) out[p] = { ...defaultSchedule(), ...(s[p] || {}) };
    return out;
  }
  function getSchedules() { return schedulesRaw(); }
  async function putSchedule(pipeline, input = {}) {
    if (!PIPELINES.includes(pipeline)) return { ok: false, code: 400, error: 'unknown pipeline' };
    const all = schedulesRaw();
    const v = validateSchedule(input, all[pipeline]);
    if (!v.ok) return { ok: false, code: 422, error: 'schedule rejected', errors: v.errors };
    const s = v.schedule;
    s.nextRunAt = s.enabled ? nextSlot(s, now()).toISOString() : null;
    const changed = ['enabled', 'frequency', 'time', 'weekday'].some((k) => all[pipeline][k] !== s[k]);
    all[pipeline] = s; store.writeSchedules(all);
    if (changed) {
      activity({ kind: 'aggregation', status: 'schedule', summary: `${adapters[pipeline].label} schedule ${s.enabled ? `enabled (${s.frequency} ${s.time})` : 'disabled'}` });
      await writeFacts([scheduleFact(pipeline, s, now().toISOString().slice(0, 10))]);
    }
    return { ok: true, schedule: s };
  }
  async function tick() {
    const all = schedulesRaw(); let dirty = false; const results = [];
    for (const p of PIPELINES) {
      const { action, schedule } = evaluate(all[p], now());
      if (JSON.stringify(schedule) !== JSON.stringify(all[p])) { all[p] = schedule; dirty = true; }
      if (action === 'missed') {
        activity({ kind: 'aggregation', status: 'missed', summary: `${adapters[p].label}: scheduled slot missed while Seen Command was not running — running it once now` });
      }
      if (action === 'run' || action === 'missed') {
        store.writeSchedules(all); dirty = false;
        const r = await startRun({ pipeline: p, trigger: action === 'missed' ? 'catchup' : 'schedule', owner: 'scheduler' });
        const fresh = schedulesRaw();
        fresh[p] = { ...fresh[p], lastRunAt: now().toISOString(), lastRunId: r.ok ? r.run.id : null, lastOutcome: r.ok ? 'started' : `not started: ${r.error}` };
        store.writeSchedules(fresh); Object.assign(all, fresh);
        if (!r.ok) {
          activity({ kind: 'aggregation', status: 'skipped', summary: `${adapters[p].label}: scheduled run not started — ${r.error}` });
          tell({ kind: 'schedule', level: 'warning', title: `${adapters[p].label}: scheduled run did not start`, body: r.error || '', tab: 'aggregation' });
        }
        results.push({ pipeline: p, action, ok: r.ok, error: r.ok ? null : r.error });
      }
    }
    if (dirty) store.writeSchedules(all);
    return results;
  }

  // ---- lifecycle -------------------------------------------------------------------------------
  function start({ tickMs = 60_000 } = {}) {
    recover();
    pump();
    if (!tickTimer) { tickTimer = setInterval(() => { tick().catch(() => {}); }, tickMs); tickTimer.unref?.(); }
    // A collector must not outlive the app that owns it: a run nobody can see or cancel is worse than
    // an interrupted one (recover() reports it honestly on the next start).
    process.once('exit', () => { for (const e of live.values()) { try { process.kill(-e.child.pid, 'SIGTERM'); } catch { /* gone */ } } });
  }
  function stop() { if (tickTimer) clearInterval(tickTimer); tickTimer = null; }

  async function previewTargets(limit) {
    return adapters.company_intel.previewTargets({ limit, env: E(), caps: capsFor('company_intel'), fetchImpl });
  }

  // Read-only lists the picker tools show (Indeed presets, the company catalog). Cached for 30 minutes:
  // the catalog reads every open listing in Seen (~10s), and the tab re-renders on every poll. A failed
  // fetch is never cached, so the next open retries.
  const lists = new Map();
  async function cachedList(key, load, refresh) {
    const hit = lists.get(key);
    if (!refresh && hit && now().getTime() - hit.at < LIST_TTL_MS) return hit.value;
    if (hit?.inflight) return hit.inflight;
    const inflight = Promise.resolve().then(load).then((value) => { lists.set(key, value?.ok ? { at: now().getTime(), value } : {}); return value; })
      .catch((e) => { lists.delete(key); return { ok: false, error: String(e.message || e).slice(0, 160) }; });
    lists.set(key, { ...(hit || {}), inflight });
    return inflight;
  }
  const indeedPresets = ({ refresh = false } = {}) => cachedList('indeed-presets', () => adapters.indeed.fetchPresets
    ? adapters.indeed.fetchPresets({ env: E(), caps: capsFor('indeed'), fetchImpl }) : { ok: false, error: 'presets unsupported' }, refresh);
  const companyCatalog = ({ refresh = false } = {}) => cachedList('company-catalog', () => adapters.company_intel.fetchCatalog
    ? adapters.company_intel.fetchCatalog({ env: E(), caps: capsFor('company_intel'), fetchImpl }) : { ok: false, error: 'catalog unsupported' }, refresh);

  // Employer-board pull: Seen does the work server-side; this is one HTTP call. One at a time — a second
  // press while one runs gets the same promise. The last result is kept so the tab can show it.
  let boardsPull = null;
  let lastBoards = null;
  async function pullBoards(input = {}) {
    if (boardsPull) return boardsPull;
    if (!adapters.indeed.pullEmployerBoards) return { ok: false, error: 'employer-board pull unsupported' };
    const what = Array.isArray(input.companies) ? `${input.companies.length} chosen companies` : `${input.limit ?? 200} stalest boards`;
    activity({ kind: 'aggregation', status: 'running', summary: `employer-board pull started (${what})` });
    boardsPull = Promise.resolve().then(() => adapters.indeed.pullEmployerBoards(input, { env: E(), caps: capsFor('indeed'), fetchImpl }))
      .then((r) => {
        if (r.ok) lastBoards = r;
        activity({ kind: 'aggregation', status: r.ok ? 'done' : 'failed', summary: r.ok
          ? `employer boards: ${r.synced}/${r.boards} boards answered, ${r.saved} US/remote listings saved (${r.droppedOutsideMarket} outside the US skipped)`
          : `employer-board pull failed: ${r.error}` });
        return r;
      })
      .catch((e) => ({ ok: false, error: String(e.message || e).slice(0, 160) }))
      .finally(() => { boardsPull = null; });
    return boardsPull;
  }
  const boardsStatus = () => ({ running: !!boardsPull, last: lastBoards });
  // Seen's server-side company pull on its own (boards, career site, Adzuna for that employer) — the search uses it.
  const pullCompanyJobsDirect = (input) => (adapters.indeed.pullCompanyJobs
    ? adapters.indeed.pullCompanyJobs(input, { env: E(), caps: capsFor('indeed'), fetchImpl }) : Promise.resolve({ ok: false, error: 'company job pull unsupported' }));

  // Company-first job pull ("search Acme → try every source"): for 1–10 named companies,
  //   1. Indeed — a local Indeed run searching each name (starts now, or queues for the Browser Bridge);
  //   2. Seen, server-side — job boards (found + registered when Seen has none), the company's own career
  //      site, and Adzuna filtered to that employer (one HTTP call, up to ~4.5 minutes);
  //   3. Chrome — a career-site run for every site Seen's server could not read (queues behind Indeed).
  // Each step reports what actually happened; a step that cannot start says why. One pull at a time.
  let companyPull = null;   // the in-flight pull's live state
  let lastCompany = null;   // the last finished pull
  const runRef = (r) => (r.ok ? { ok: true, id: r.run.id, status: r.run.status } : { ok: false, error: r.error, blockers: (r.blockers || []).map((b) => b.label) });
  async function companyJobs(input = {}) {
    if (companyPull) return { ok: false, code: 409, error: 'a company job pull is already running', state: companyPull };
    if (!adapters.indeed.pullCompanyJobs) return { ok: false, code: 400, error: 'company job pull unsupported' };
    const v = validateCompanyJobs(input);
    if (!v.ok) return { ok: false, code: 400, error: v.error };
    const { companies, site_limit: siteLimit, websites } = v.body;
    // A website given as a full page address (https://www.example.com/careers/search/?site=US) is where
    // Chrome starts for that company; Seen's server only needs the host.
    const startUrls = {};
    for (const [name, raw] of Object.entries(input.websites && typeof input.websites === 'object' ? input.websites : {})) {
      const co = companies.find((c) => c.toLowerCase() === String(name).trim().toLowerCase());
      const url = co ? cleanStartUrl(raw) : null;
      if (url && new URL(url).pathname.length > 1) startUrls[co] = url;
    }
    const useIndeed = input.indeed !== false; const useBrowser = input.browser !== false;
    const state = { running: true, startedAt: now().toISOString(), endedAt: null,
      request: { companies, siteLimit, websites: websites || {}, startUrls, indeed: useIndeed, browser: useBrowser },
      indeedRun: null, seen: null, careerRun: null, error: null };
    companyPull = state;
    activity({ kind: 'aggregation', status: 'running', summary: `company job pull started for ${companies.join(', ')}`.slice(0, 200) });
    try {
      if (useIndeed) {
        const caps = capsFor('indeed');
        state.indeedRun = runRef(await startRun({ pipeline: 'indeed', trigger: 'manual', owner: 'company-jobs', confirmLarge: true,
          overrides: { searches: companies.map((c) => ({ query: c, location: 'United States' })), resultsPerSearch: Math.min(25, caps.resultsPerSearchMax || 25), maxPages: 1, maxSearches: null } }));
      }
    } catch (e) { state.indeedRun = { ok: false, error: String(e.message || e).slice(0, 160) }; }
    Promise.resolve()
      .then(() => adapters.indeed.pullCompanyJobs({ companies, siteLimit, websites }, { env: E(), caps: capsFor('indeed'), fetchImpl }))
      .then(async (seen) => {
        state.seen = seen;
        if (!useBrowser) return;
        if (!seen.ok) { state.careerRun = { ok: false, error: 'not started: Seen’s pull failed, so it is not known which career sites need Chrome' }; return; }
        // Chrome reads every site Seen's server could not read, starting at the page the operator gave;
        // a page the operator gave is also read when the server got nothing for that company.
        const targets = new Map();
        for (const x of seen.needsBrowser) targets.set(x.company.toLowerCase(), { company: x.company, url: startUrls[x.company] || x.url });
        for (const [co, url] of Object.entries(startUrls)) {
          const r = seen.results.find((x) => String(x.company || '').toLowerCase() === co.toLowerCase());
          if (!targets.has(co.toLowerCase()) && !(r && ((r.boards && r.boards.saved) || (r.careerSite && r.careerSite.status === 'ok')))) targets.set(co.toLowerCase(), { company: co, url });
        }
        if (!targets.size) { state.careerRun = { ok: true, skipped: true, note: 'no career site needed Chrome' }; return; }
        const list = [...targets.values()];
        state.careerRun = { ...runRef(await startRun({ pipeline: 'career_site', trigger: 'manual', owner: 'company-jobs', confirmLarge: true,
          overrides: { targets: list } })), targets: list };
      })
      .catch((e) => { state.error = String(e.message || e).slice(0, 160); })
      .finally(() => {
        state.running = false; state.endedAt = now().toISOString();
        lastCompany = state; companyPull = null;
        const s = state.seen;
        activity({ kind: 'aggregation', status: s && s.ok ? 'done' : 'failed', summary: (s && s.ok
          ? `company jobs: Seen saved ${s.saved} listings for ${companies.length} compan${companies.length === 1 ? 'y' : 'ies'}; Indeed run ${state.indeedRun?.ok ? 'started' : 'not started'}; ${s.needsBrowser.length} career site(s) for Chrome`
          : `company job pull failed: ${(s && s.error) || state.error || 'unknown error'}`).slice(0, 200) });
      });
    return { ok: true, state };
  }
  const companyJobsStatus = () => ({ running: !!companyPull, last: companyPull || lastCompany });

  // Read-only view for the Board Room / agents. No method here mutates anything.
  async function snapshot() {
    const st = await status();
    return { ...st, runs: listRuns({ limit: 200 }) };
  }

  return { getConfig, putConfig, health, status, collectors, startRun, cancelRun, listRuns, getRun, getSchedules, putSchedule, tick, recover, pump, start, stop, previewTargets, indeedPresets, companyCatalog, pullBoards, boardsStatus, pullCompanyJobsDirect, companyJobs, companyJobsStatus, snapshot, _live: live };
}

// The one search box (engine/search.mjs) over this manager.
let searchSingleton = null;
export function searchService() {
  if (!searchSingleton) {
    searchSingleton = createSearch({ manager: aggregationManager(), notify: (n) => import('../lib/notifications.mjs').then((m) => m.notify(n)).catch(() => {}),
      remember: (e) => import('../lib/brain.mjs').then((m) => m.recordDevLog(e)).catch(() => {}) });
  }
  return searchSingleton;
}

let singleton = null;
export function aggregationManager() {
  if (!singleton) {
    singleton = createAggregationManager({
      logActivity: (ev) => import('../lib/activity.mjs').then((m) => m.logActivity(ev)).catch(() => {}),
      notify: (n) => import('../lib/notifications.mjs').then((m) => m.notify(n)).catch(() => {}),
      onRunEnd: (run) => import('./search.mjs').then((m) => searchService().onRunEnd(run)).catch(() => {}),
    });
  }
  return singleton;
}
