// Brokered GitHub file updates for authenticated AI clients. A model gets no token and no raw API:
// Chronos validates an allowlisted repo/path, creates an isolated codex/* branch, commits one file,
// and opens a draft PR. Protected branches are never updated directly.
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Load the repo's normal .env-backed config when present; packaged Chronos relies on main.js's safe
// env loader instead. Never print or return any of these values.
try { await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib', 'config.mjs')).href); } catch { /* packaged/local env only */ }

const API = 'https://api.github.com';
const MAX_CONTENT_BYTES = 1024 * 1024;
const env = (k) => { const v = process.env[k]; return v && v.trim() ? v.trim() : null; };
const token = () => env('GITHUB_TOKEN') || env('GH_TOKEN');
const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const refPattern = /^[A-Za-z0-9._/-]{1,200}$/;
const secretLiteral = /(-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bghp_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}|\bsk-[A-Za-z0-9]{20,})/;

export function allowedGitHubRepos(source = process.env) {
  return new Set([
    source.CHRONOS_GITHUB_REPOS, source.SEEN_GITHUB_REPO, source.SEEN_COMMAND_GITHUB_REPO,
  ].filter(Boolean).flatMap((v) => String(v).split(',')).map((v) => v.trim().toLowerCase()).filter((v) => repoPattern.test(v)));
}

function safePath(input) {
  const p = String(input || '').replace(/^\/+/, '');
  const parts = p.split('/');
  if (!p || parts.some((x) => !x || x === '.' || x === '..')) throw new Error('safe repository-relative path required');
  const lower = p.toLowerCase();
  if (lower === '.env' || lower.startsWith('.env.') || lower.includes('/.env')
      || lower.startsWith('.github/workflows/') || lower === '.github/codeowners'
      || /(^|\/)(credentials?|secrets?)(\/|\.|$)/.test(lower)
      || /\.(pem|key|p12|pfx|jks)$/.test(lower)) throw new Error('protected or secret-bearing path denied');
  return p;
}

const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');
const slug = (v) => String(v || 'update').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 38) || 'update';

async function request(fetchFn, auth, path, { method = 'GET', body } = {}) {
  const res = await fetchFn(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${auth}`, accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28', 'user-agent': 'chronos-broker',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text(); let parsed = null;
  try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = {}; }
  if (!res.ok) { const e = new Error(`GitHub ${method} ${path} → ${res.status}: ${String(parsed.message || raw).slice(0, 160)}`); e.status = res.status; throw e; }
  return parsed || {};
}

export async function openFileUpdatePR(input = {}, deps = {}) {
  const auth = deps.token || token(); const fetchFn = deps.fetch || globalThis.fetch;
  if (!auth) throw new Error('GitHub broker is not configured');
  const repo = String(input.repo || '').trim(); const base = String(input.base || '').trim();
  const allow = deps.allowedRepos || allowedGitHubRepos();
  if (!repoPattern.test(repo) || !allow.has(repo.toLowerCase())) throw new Error('repository is not allowlisted in Chronos');
  if (!refPattern.test(base) || base.includes('..') || base.startsWith('/') || base.endsWith('/')) throw new Error('valid base branch required');
  const path = safePath(input.path);
  const content = String(input.content ?? '');
  if (Buffer.byteLength(content) > MAX_CONTENT_BYTES) throw new Error(`GitHub file content exceeds ${MAX_CONTENT_BYTES} bytes; use an artifact and a normal build workflow`);
  if (content.includes('\0') || secretLiteral.test(content)) throw new Error('binary or credential-like content denied');
  const title = String(input.title || '').trim().slice(0, 200);
  if (!title) throw new Error('pull request title required');
  const client = slug(input.client || 'ai');
  const head = `codex/chronos-${client}-${slug(title)}-${randomBytes(4).toString('hex')}`;

  const baseRef = await request(fetchFn, auth, `/repos/${repo}/git/ref/heads/${encodeURIComponent(base)}`);
  await request(fetchFn, auth, `/repos/${repo}/git/refs`, { method: 'POST', body: { ref: `refs/heads/${head}`, sha: baseRef.object.sha } });
  let existingSha = null; let existingText = '';
  try {
    const current = await request(fetchFn, auth, `/repos/${repo}/contents/${encPath(path)}?ref=${encodeURIComponent(head)}`);
    existingSha = current.sha || null; existingText = Buffer.from(current.content || '', 'base64').toString('utf8');
  } catch (e) { if (e.status !== 404) throw e; }
  const finalText = input.mode === 'append' ? existingText + content : content;
  await request(fetchFn, auth, `/repos/${repo}/contents/${encPath(path)}`, { method: 'PUT', body: {
    message: `${title} (via Chronos/${client})`, branch: head,
    content: Buffer.from(finalText, 'utf8').toString('base64'), ...(existingSha ? { sha: existingSha } : {}),
  } });
  const pr = await request(fetchFn, auth, `/repos/${repo}/pulls`, { method: 'POST', body: {
    title, head, base, draft: true,
    body: `${String(input.body || '').slice(0, 6000)}\n\nOpened by authenticated Chronos client \`${client}\` through the scoped GitHub broker.`.trim(),
  } });
  return { repo, base, head, path, draft: true, number: pr.number, url: pr.html_url };
}
