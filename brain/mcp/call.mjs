#!/usr/bin/env node
// One-shot Brain call from a shell, for AI hosts that have no MCP server configured (for example a
// Codex session that was never given the `brain` MCP). It starts brain/mcp/server.mjs, authenticates
// with the same credential file the MCP setup would use, makes ONE tool call, prints the result and
// exits. Same server, same scopes, same audit trail in Chronos → AI traffic — nothing is bypassed.
//
//   BRAIN_CLIENT=codex node brain/mcp/call.mjs tools
//   BRAIN_CLIENT=codex node brain/mcp/call.mjs brain_overview
//   BRAIN_CLIENT=codex node brain/mcp/call.mjs brain_search_facts '{"query":"Seen"}'
//   echo '{"text":"…","heading":"…"}' | BRAIN_CLIENT=codex node brain/mcp/call.mjs brain_append_timeline -
//
// BRAIN_CLIENT must be the caller's own registered source. The credential is read from
// BRAIN_CLIENT_CREDENTIAL_FILE, or by default from ~/.chronos/credentials/<BRAIN_CLIENT>.token (where
// Chronos → Access "install on this Mac" puts it). It is never accepted as an argument.
// Exit 0 on success, 1 on a tool error or denial, 2 on bad usage.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { credentialPath } from '../lib/access-control.mjs';

const SERVER = new URL('./server.mjs', import.meta.url).pathname;
const [tool, rawArgs] = process.argv.slice(2);

function usage(msg) {
  if (msg) process.stderr.write(`${msg}\n\n`);
  process.stderr.write(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(6, 10)
    .map((l) => l.replace(/^\/\/ ?/, '')).join('\n') + '\n');
  process.exit(2);
}

if (!tool || tool === 'help' || tool === '--help') usage();
const source = String(process.env.BRAIN_CLIENT || '').trim();
if (!source) usage('Set BRAIN_CLIENT to your own registered source (for example BRAIN_CLIENT=codex).');

let args = {};
if (rawArgs !== undefined) {
  const text = rawArgs === '-' ? readFileSync(0, 'utf8') : rawArgs;
  try { args = text.trim() ? JSON.parse(text) : {}; } catch (e) { usage(`Arguments must be one JSON object: ${e.message}`); }
  if (!args || typeof args !== 'object' || Array.isArray(args)) usage('Arguments must be one JSON object.');
}

const env = { ...process.env, BRAIN_CLIENT: source };
if (!env.BRAIN_CLIENT_TOKEN && !env.BRAIN_CLIENT_CREDENTIAL_FILE) env.BRAIN_CLIENT_CREDENTIAL_FILE = credentialPath(source);

const child = spawn(process.execPath, [SERVER], { env, stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '';
child.stderr.on('data', (d) => { stderr += d; });

const pending = new Map();
let buf = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    const waiter = pending.get(msg.id);
    if (waiter) { pending.delete(msg.id); waiter(msg); }
  }
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', (e) => e && reject(e));
  });
}

function finish(code, out, err) {
  if (out) process.stdout.write(out.endsWith('\n') ? out : `${out}\n`);
  if (err) process.stderr.write(err.endsWith('\n') ? err : `${err}\n`);
  child.stdin.end();
  child.kill();
  process.exit(code);
}

child.on('exit', (code) => {
  if (pending.size) finish(1, '', `Brain server exited early (code ${code}). ${stderr.trim()}`);
});

const timer = setTimeout(() => finish(1, '', 'Brain call timed out after 60s.'), 60_000);
timer.unref();

const init = await rpc('initialize', {
  protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'brain-call (shell)', version: '1' },
});
if (init.error) {
  const where = env.BRAIN_CLIENT_TOKEN
    ? 'BRAIN_CLIENT_TOKEN (set in your environment, where it overrides any credential file)'
    : env.BRAIN_CLIENT_CREDENTIAL_FILE;
  finish(1, '', `${init.error.message}\nCheck that Chronos → Access has an active "${source}" client and that `
    + `${where} holds its credential.`);
}
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

if (tool === 'tools') {
  const r = await rpc('tools/list', {});
  if (r.error) finish(1, '', r.error.message);
  finish(0, r.result.tools.map((t) => `${t.name}\n    ${t.description}`).join('\n'));
}

const r = await rpc('tools/call', { name: tool, arguments: args });
if (r.error) finish(1, '', r.error.message);
const text = (r.result?.content || []).map((c) => c.text ?? JSON.stringify(c)).join('\n');
finish(r.result?.isError ? 1 : 0, r.result?.isError ? '' : text, r.result?.isError ? text : '');
