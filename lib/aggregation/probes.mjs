// Readiness probes shared by both collector adapters. Every probe is NON-DESTRUCTIVE and returns an
// honest tri-state: a verified good state, a verified bad state, or `unknown` with the reason. Nothing
// here ever reports "ready" just because an executable exists, and no probe returns a secret value.
//
// Verified contracts these probes rely on (Seen repo, read 2026-10-19):
//   • api/ingest-local-indeed.js and api/ingest-local-company-intel.js check the Bearer secret FIRST,
//     then reject an empty array with 400 BEFORE touching Supabase. So POST {jobs:[]} / {items:[]}
//     answers "is my token accepted?" without writing anything: 400 = accepted, 401 = rejected (or the
//     Vercel secret is unset — the endpoint does not distinguish), 404 = not deployed.
//   • The company_intel_imports table is created by 20261019160000_company_intel_imports.sql. A
//     PostgREST `select=id&limit=1` read answers whether it exists (PGRST205 / 404 = missing).

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, isAbsolute, resolve, dirname, relative, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { config } from '../config.mjs';
import { redact } from './store.mjs';

// ---- Seen checkout -----------------------------------------------------------------------------
export function resolveSeenRepo(explicit) {
  const dir = String(explicit || '').trim() || config.productRepoDir();
  return resolve(dir);
}

export function probeSeenRepo(dir, requiredFiles = []) {
  if (!dir || !isAbsolute(dir)) return { status: 'missing', detail: 'No Seen repository path is configured.', fix: 'Set the Seenjobs.io checkout path in Aggregation → System Health.' };
  let isDir = false; try { isDir = statSync(dir).isDirectory(); } catch { /* missing */ }
  if (!isDir) return { status: 'missing', detail: `The configured Seen checkout does not exist: ${redact(dir)}`, fix: 'Clone begindtheseen/Seen on this Mac and point Aggregation → System Health at it.' };
  let pkg = null; try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); } catch { /* not a node project */ }
  if (!pkg) return { status: 'missing', detail: `${redact(dir)} has no readable package.json — not the Seen repository.`, fix: 'Point the path at the root of the Seen (seenjobs.io) checkout.' };
  const absent = requiredFiles.filter((f) => !existsSync(join(dir, f)));
  if (absent.length) return { status: 'missing', detail: `This checkout lacks ${absent.join(', ')} — pull the branch that ships the collector.`, fix: 'git pull the Seen checkout (the collectors landed on next-migration on 2026-10-19).' };
  return { status: 'ok', detail: `Seen checkout at ${redact(dir)}`, packageName: pkg.name || null };
}

export function readSource(dir, rel) {
  try { return readFileSync(join(dir, rel), 'utf8'); } catch { return null; }
}

// The files a collector script imports DIRECTLY by relative path ('../lib/reports/archiveSource.js'),
// read from the same checkout: [{ path, source }]. A collector may build its items in a shared module
// (Seen moved the Reddit-archive one into lib/reports/archiveSource.js on 2026-10-21), so checks that
// look for evidence in "the collector" must read these too. One level only, never outside `dir`.
export function readDirectImports(dir, rel) {
  const script = readSource(dir, rel);
  if (!script) return [];
  const root = resolve(dir);
  const specs = [...script.matchAll(/(?:import|export)\s[^'"]*?from\s+['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)].map((m) => m[1] || m[2]);
  const out = [];
  for (const spec of new Set(specs)) {
    const abs = resolve(root, dirname(rel), spec);
    if (!abs.startsWith(root + sep)) continue;
    try { out.push({ path: relative(root, abs), source: readFileSync(abs, 'utf8') }); } catch { /* missing file: nothing to read */ }
  }
  return out;
}

// ---- OpenCLI + Chrome Browser Bridge -----------------------------------------------------------
function run(execFileImpl, bin, args, { timeout = 15000, env } = {}) {
  return new Promise((resolveP) => {
    execFileImpl(bin, args, { timeout, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, env }, (error, stdout, stderr) => {
      resolveP({ error, code: error ? (typeof error.code === 'number' ? error.code : null) : 0, errno: error && typeof error.code === 'string' ? error.code : null,
        killed: !!(error && error.killed), stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// Classify OpenCLI `doctor` output. OpenCLI's exact wording is not a stable contract we have verified,
// so only an explicit positive marker with no negative marker counts as connected; anything else that
// is not explicitly negative stays `unverified` (a run's own errors are the authoritative signal).
export function classifyBridgeOutput(text, exitCode) {
  const t = String(text || '');
  if (/(not|isn'?t|is not)\s+connected|disconnected|no (?:browser )?(?:extension|bridge)|bridge (?:is )?(?:offline|down|unavailable)|extension (?:is )?not (?:installed|connected)|daemon (?:is )?not running|ECONNREFUSED|✗/i.test(t)) return 'disconnected';
  if (/unknown command|unrecognized|no such command|did you mean/i.test(t)) return 'unverified';
  if (exitCode === 0 && /\bconnected\b|\bready\b|✓|\bok\b/i.test(t)) return 'connected';
  return 'unverified';
}

export async function probeOpenCli({ execFileImpl = execFile, env = { ...process.env, PATH: config.toolPath() } } = {}) {
  const v = await run(execFileImpl, 'opencli', ['--version'], { timeout: 10000, env });
  if (v.errno === 'ENOENT') {
    return { installed: false, version: null, bridge: 'unavailable', status: 'missing',
      detail: 'OpenCLI is not installed or not on PATH (checked Homebrew and /usr/local paths too).',
      fix: 'Install OpenCLI on this Mac, then install and connect its Chrome Browser Bridge extension.' };
  }
  if (v.code !== 0) {
    return { installed: true, version: null, bridge: 'unverified', status: 'broken',
      detail: `\`opencli --version\` failed: ${redact((v.stderr || v.stdout || (v.killed ? 'timed out' : 'no output')).trim()).slice(0, 200)}`,
      fix: 'Reinstall OpenCLI; a binary that cannot print its version cannot run a collection.' };
  }
  const version = (v.stdout || v.stderr).trim().split(/\s+/).pop()?.slice(0, 40) || null;
  const d = await run(execFileImpl, 'opencli', ['doctor'], { timeout: 20000, env });
  const out = `${d.stdout}\n${d.stderr}`;
  const bridge = d.killed ? 'unverified' : classifyBridgeOutput(out, d.code);
  const excerpt = redact(out.trim()).split(/\r?\n/).slice(0, 4).join(' · ').slice(0, 240);
  if (bridge === 'connected') return { installed: true, version, bridge, status: 'ok', detail: `OpenCLI ${version || ''} — Browser Bridge reports connected.`.replace('  ', ' ') };
  if (bridge === 'disconnected') {
    return { installed: true, version, bridge, status: 'broken',
      detail: `OpenCLI is installed but the Chrome Browser Bridge is not connected (${excerpt || 'doctor reported a failure'}).`,
      fix: 'Open Chrome with the profile the Browser Bridge extension is installed in, make sure the extension is enabled and connected, then refresh this check.' };
  }
  return { installed: true, version, bridge, status: 'degraded',
    detail: `OpenCLI ${version || ''} is installed, but the Browser Bridge connection could not be confirmed (${d.killed ? '`opencli doctor` timed out' : excerpt || 'no recognizable doctor output'}).`.replace('  ', ' '),
    fix: 'Keep Chrome open with the Browser Bridge extension connected. A run will report a bridge failure explicitly if it is not.' };
}

// ---- remote endpoints --------------------------------------------------------------------------
// Ingest endpoints come only from the local .env (never from the dashboard), so a token can only be
// sent where the operator configured it. Still: https, or plain http to this machine for dev.
export function safeEndpoint(raw, fallback) {
  const value = String(raw || '').trim() || fallback;
  try {
    const u = new URL(value);
    if (u.protocol === 'https:') return u.toString();
    if (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return u.toString();
  } catch { /* fall through */ }
  return null;
}

export async function probeIngestAuth({ url, token, emptyBody, fetchImpl = fetch, timeoutMs = 10000 }) {
  if (!url) return { status: 'invalid', detail: 'The ingest endpoint override is not an https URL.', fix: 'Fix the endpoint override in .env or remove it to use the default endpoint.' };
  if (!String(token || '').trim()) return { status: 'missing', detail: 'The local ingest token is not set in Seen Command.', fix: 'Settings → Aggregation: paste the value of the matching Vercel secret.' };
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { method: 'POST', signal: ctl.signal, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(emptyBody) });
    if (r.status === 400) return { status: 'ok', detail: 'Seen accepted the ingest token (verified with an empty, non-writing request).' };
    if (r.status === 401) return { status: 'unauthorized', detail: 'Seen rejected the ingest token: either the local token does not match the Vercel secret, or the secret is not set in Vercel Production.', fix: 'Compare the token with the Vercel environment variable (Production) and redeploy after changing it.' };
    if (r.status === 404) return { status: 'not_deployed', detail: 'The ingest endpoint returned 404 — this Seen deployment does not include it yet.', fix: 'Deploy the Seen commit that ships this endpoint to production.' };
    return { status: 'unknown', detail: `Unexpected HTTP ${r.status} from the ingest endpoint; token state not verified.` };
  } catch (e) {
    return { status: 'unknown', detail: `Could not reach the ingest endpoint (${e.name === 'AbortError' ? 'timed out' : redact(e.message).slice(0, 120)}); token state not verified.` };
  } finally { clearTimeout(timer); }
}

export async function probeIntelMigration({ supabaseUrl = process.env.SUPABASE_URL, serviceKey = process.env.SUPABASE_SERVICE_KEY, fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const migration = '20261019160000_company_intel_imports.sql';
  if (!supabaseUrl || !serviceKey) {
    return { status: 'unknown', migration, detail: `Not verified: Seen Command has no Supabase credentials, so it cannot check whether ${migration} is applied.`, fix: 'Optional: add SUPABASE_URL + SUPABASE_SERVICE_KEY in Settings to enable this check.' };
  }
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const base = String(supabaseUrl).replace(/\/+$/, '');
    const r = await fetchImpl(`${base}/rest/v1/company_intel_imports?select=id&limit=1`, { signal: ctl.signal, headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
    if (r.ok) return { status: 'ok', migration, detail: 'company_intel_imports exists (read-only check).' };
    const body = await r.text().catch(() => '');
    if (r.status === 404 || /PGRST205|could not find the table|does not exist/i.test(body)) {
      return { status: 'missing', migration, detail: `company_intel_imports does not exist — ${migration} is not applied. Imports would fail at the dedupe registry.`, fix: `Apply supabase/migrations/${migration} to production (owner approval required — Seen Command never applies it).` };
    }
    if (r.status === 401 || r.status === 403) return { status: 'unknown', migration, detail: `Not verified: Supabase refused Seen Command's key (HTTP ${r.status}).`, fix: 'Check the Supabase service key in Settings.' };
    return { status: 'unknown', migration, detail: `Not verified: unexpected HTTP ${r.status} from Supabase.` };
  } catch (e) {
    return { status: 'unknown', migration, detail: `Not verified: Supabase unreachable (${e.name === 'AbortError' ? 'timed out' : redact(e.message).slice(0, 120)}).` };
  } finally { clearTimeout(timer); }
}
