// Aggregation store — the durable, structured run history + configuration for the Aggregation
// Dashboard. This is the PRIMARY record of every collection run; Chronos only receives meaningful
// conclusions (see lib/aggregation/memory.mjs), never per-run rows or collected records.
//
// Layout (all under the writable runtime home, so the packaged .app never writes into its bundle):
//   <SEEN_HOME>/data/aggregation/config.json        pipeline configuration + presets + repo path
//   <SEEN_HOME>/data/aggregation/schedules.json     independent schedules (disabled by default)
//   <SEEN_HOME>/data/aggregation/state.json         small operational state (last recorded health …)
//   <SEEN_HOME>/data/aggregation/runs/<id>.json     one file per run, atomic writes, bounded tails
//
// Every write is temp-file + rename (atomic). Log tails are bounded and redacted before they land.

import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { dataDir } from '../paths.mjs';

export const PIPELINES = ['company_intel', 'indeed', 'career_site', 'applicant_reports', 'web_reports'];
export const RUN_STATUSES = ['queued', 'running', 'completed', 'partial', 'failed', 'blocked', 'cancelled', 'interrupted'];
export const TERMINAL = new Set(['completed', 'partial', 'failed', 'blocked', 'cancelled', 'interrupted']);
export const ACTIVE = new Set(['queued', 'running']);

const TAIL_LINES = 200;
const LINE_CHARS = 500;
const RUNS_KEPT_PER_PIPELINE = 500;

export function aggregationDir(base = dataDir()) {
  const d = join(base, 'aggregation');
  mkdirSync(join(d, 'runs'), { recursive: true });
  return d;
}

function atomicWriteJson(file, value) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return value;
}
function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

// ---- secret redaction --------------------------------------------------------------------------
// Anything token-shaped, any Bearer header, and the literal values of the ingest tokens are removed
// before text reaches a run file, an API response, the activity ledger, or Chronos.
const SECRETISH = /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[abprs]-[A-Za-z0-9-]{8,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,})/g;
export const SECRET_ENV_KEYS = ['SEEN_LOCAL_INGEST_TOKEN', 'SEEN_COMPANY_INTEL_INGEST_TOKEN', 'SUPABASE_SERVICE_KEY'];

export function redact(text, env = process.env) {
  let out = String(text ?? '');
  for (const key of SECRET_ENV_KEYS) {
    const v = String(env[key] || '').trim();
    if (v.length >= 6) out = out.split(v).join('[redacted]');
  }
  out = out.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]').replace(SECRETISH, '[redacted]');
  const home = env.HOME;
  if (home && home.length > 1) out = out.split(home).join('~');
  return out;
}

// Bounded, redacted tail of a process stream.
export function tailLines(text, { lines = TAIL_LINES, chars = LINE_CHARS, env } = {}) {
  return redact(String(text || ''), env).split(/\r?\n/).filter((l) => l.trim() !== '').slice(-lines).map((l) => l.slice(0, chars));
}

// ---- run ids -----------------------------------------------------------------------------------
// Built from PIPELINES so a new collector's ids are valid (a hand-kept list rejected applicant_reports).
const RUN_ID_RE = new RegExp(`^agg-(${PIPELINES.join('|')})-\\d{8}T\\d{6}Z-[a-f0-9]{6}$`);
export const isRunId = (id) => RUN_ID_RE.test(String(id || ''));
export function newRunId(pipeline, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `agg-${pipeline}-${stamp}-${randomBytes(3).toString('hex')}`;
}

// ---- the store ---------------------------------------------------------------------------------
export function createStore({ base } = {}) {
  const dir = () => aggregationDir(base || dataDir());
  const runsDir = () => join(dir(), 'runs');
  const runPath = (id) => join(runsDir(), `${id}.json`);

  const store = {
    dir,
    readConfig: () => readJson(join(dir(), 'config.json'), null),
    writeConfig: (cfg) => atomicWriteJson(join(dir(), 'config.json'), cfg),
    readSchedules: () => readJson(join(dir(), 'schedules.json'), null),
    writeSchedules: (s) => atomicWriteJson(join(dir(), 'schedules.json'), s),
    readState: () => readJson(join(dir(), 'state.json'), {}),
    writeState: (s) => atomicWriteJson(join(dir(), 'state.json'), s),

    writeRun(run) {
      if (!isRunId(run.id)) throw new Error(`invalid run id: ${run.id}`);
      run.updatedAt = new Date().toISOString();
      for (const k of ['stdoutTail', 'stderrTail', 'events']) {
        if (Array.isArray(run[k]) && run[k].length > TAIL_LINES) run[k] = run[k].slice(-TAIL_LINES);
      }
      return atomicWriteJson(runPath(run.id), run);
    },
    readRun(id) { return isRunId(id) ? readJson(runPath(id), null) : null; },
    allRuns() {
      let files = [];
      try { files = readdirSync(runsDir()).filter((f) => f.endsWith('.json')); } catch { return []; }
      return files.map((f) => readJson(join(runsDir(), f), null)).filter((r) => r && isRunId(r.id))
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    },
    // Keep history bounded: the newest RUNS_KEPT_PER_PIPELINE terminal runs per pipeline survive.
    prune(keep = RUNS_KEPT_PER_PIPELINE) {
      const byPipe = {};
      for (const r of store.allRuns()) (byPipe[r.pipeline] ||= []).push(r);
      let removed = 0;
      for (const list of Object.values(byPipe)) {
        for (const r of list.filter((x) => TERMINAL.has(x.status)).slice(keep)) {
          try { rmSync(runPath(r.id)); removed++; } catch { /* already gone */ }
        }
      }
      return removed;
    },
  };
  return store;
}
