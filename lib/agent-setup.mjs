// `npm run agent:setup` as a button-free action: reinstall + re-sign the Cline coding runtime
// (scripts/setup-coding-agent.mjs) in a child process and hand back how it ended and the tail of its
// output. Served by POST /api/agents/setup (local-only) and the Board Room's `act.mjs fix-agents`, so a
// Cline that macOS killed (invalid code signature) is fixed without Brandon opening Terminal.
// One run at a time: a second request while one runs joins it instead of starting another npm install.
import { spawn as nodeSpawn } from 'node:child_process';
import { join } from 'node:path';
import { REPO_ROOT } from './paths.mjs';
import { toolEnv } from './tool-env.mjs';

const TAIL_CHARS = 3000;
let inflight = null;

export function runAgentSetup({ spawnFn = nodeSpawn, timeoutMs = 5 * 60_000, script = join(REPO_ROOT, 'scripts', 'setup-coding-agent.mjs') } = {}) {
  if (inflight) return inflight;
  inflight = new Promise((resolve) => {
    const started = Date.now();
    let out = ''; let done = false;
    const keep = (d) => { out = (out + String(d)).slice(-TAIL_CHARS * 2); };
    let child;
    // toolEnv: a Finder-launched app has a bare PATH, and the script needs npm (and codesign on macOS).
    try { child = spawnFn(process.execPath, [script], { cwd: REPO_ROOT, env: toolEnv(null), stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { resolve({ ok: false, code: null, error: `could not start agent setup: ${e.message}`, tail: '', ms: 0 }); return; }
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve({ ...r, tail: out.slice(-TAIL_CHARS).trim(), ms: Date.now() - started }); };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish({ ok: false, code: null, error: `agent setup did not finish in ${Math.round(timeoutMs / 60_000)} minutes — stopped` }); }, timeoutMs);
    child.stdout?.on('data', keep); child.stderr?.on('data', keep);
    child.on('error', (e) => finish({ ok: false, code: null, error: `agent setup could not start: ${e.code || e.message}` }));
    child.on('close', (code, signal) => finish(code === 0
      ? { ok: true, code: 0 }
      : { ok: false, code, error: `agent setup failed (${signal ? `stopped by ${signal}` : `exit ${code}`}) — see the output tail` }));
  }).finally(() => { inflight = null; });
  return inflight;
}
