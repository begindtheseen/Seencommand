// SCHEMA DRIFT — does the LIVE database have every function the code calls?
//
// 2026-09-18: the production gateway called rpc/brain_replace_note for two weeks while the migration
// creating it sat unapplied. Reads worked, so every read-only health check stayed green; every write
// returned 500. engine/schema-refs.mjs now stops code that calls a function NO MIGRATION DEFINES — but a
// migration that is merged and never APPLIED passes that check by construction. Only the live database
// can answer this one. PostgREST publishes what it serves: the OpenAPI document at /rest/v1/ lists every
// callable function as a /rpc/<name> path. So: every rpc the code calls must appear there.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listSourceFiles, isTest } from '../engine/code-graph.mjs';
import { RPC_REF } from '../engine/schema-refs.mjs'; // ONE definition of "a database call" for the static gate and this live check


// Every database function the code under `root` calls → the files that call it. Tests and comments are
// not callers; a mocked test is exactly how a missing function stays invisible.
export function rpcRefsInRepo(root, { files = null, read = null } = {}) {
  const refs = new Map();
  for (const f of files || listSourceFiles(root)) {
    if (isTest(f)) continue;
    let text = ''; try { text = read ? read(f) : readFileSync(join(root, f), 'utf8'); } catch { continue; }
    for (const line of String(text).split('\n')) {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
      for (const re of RPC_REF) for (const m of line.matchAll(re)) { if (!refs.has(m[1])) refs.set(m[1], []); if (!refs.get(m[1]).includes(f)) refs.get(m[1]).push(f); }
    }
  }
  return refs;
}

// The functions the live database actually serves. Throws when it cannot be asked — "could not check"
// must never read as "nothing is missing".
export async function liveRpcs({ url, key, fetchFn = fetch } = {}) {
  if (!url || !key) throw new Error('no Supabase URL / service key configured — the live schema cannot be read');
  const res = await fetchFn(`${String(url).replace(/\/+$/, '')}/rest/v1/`, { headers: { apikey: key, authorization: `Bearer ${key}`, accept: 'application/openapi+json' } });
  if (!res.ok) throw new Error(`the live schema could not be read (HTTP ${res.status})`);
  const spec = await res.json();
  const paths = Object.keys((spec && spec.paths) || {});
  if (!paths.length) throw new Error('the live schema document lists no paths at all — refusing to conclude that every function is missing');
  return new Set(paths.filter((p) => p.startsWith('/rpc/')).map((p) => p.slice(5)));
}

// { checked, missing: [{ fn, files }], live } — `missing` is the outage list.
export async function schemaDrift({ roots = [], url, key, fetchFn = fetch, refs = null } = {}) {
  const all = refs || new Map();
  if (!refs) for (const root of roots) for (const [fn, files] of rpcRefsInRepo(root)) all.set(fn, [...(all.get(fn) || []), ...files.map((f) => `${root.split('/').pop()}/${f}`)]);
  const live = await liveRpcs({ url, key, fetchFn });
  const missing = [...all].filter(([fn]) => !live.has(fn)).map(([fn, files]) => ({ fn, files }));
  return { checked: all.size, live: live.size, missing };
}
