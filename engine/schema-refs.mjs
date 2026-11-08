// SCHEMA REFERENCE CHECK — code must not call database functions no migration defines.
//
// 2026-09-18: the production gateway called rpc/brain_replace_note for two weeks while the migration
// that creates it sat unapplied. Reads worked, every write returned 500, and nothing noticed, because
// a test with a mocked REST layer is green whether or not the function exists. The first half of that
// failure is checkable with no database at all: when a change ADDS a call to an RPC, some migration in
// the repo (or in the product repo, whose database the tool also talks to) must CREATE that function.
// The second half — the migration is merged but not APPLIED — is a completion condition, not a gate
// (see engine/completion.mjs): it cannot be known until the change is live.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { addedLines } from './lint.mjs';
import { isSource, isTest } from './code-graph.mjs';
import { config } from '../lib/config.mjs';

// A DATABASE call, not any URL containing "rpc/": `rpc/<fn>` must open a string literal ('rpc/x' — how this
// codebase's rest() helpers are called) or follow PostgREST's /rest/v1/ prefix, or be a client .rpc('x').
// Measured against production 2026-09-18: the loose form flagged https://www.indeed.com/rpc/jobdescs.
export const RPC_REF = [/(?:['"`]|\/rest\/v1\/)rpc\/([a-z_][a-z0-9_]*)/g, /\.rpc\(\s*['"`]([a-z_][a-z0-9_]*)['"`]/g];
const FN_DEF = /create\s+(?:or\s+replace\s+)?function\s+(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?/gi;

// Every function any migration defines, from the working tree AND from the PR base ref of each repo —
// a shared checkout parked on a feature branch must not hide a migration that main already has.
export function definedFunctions(roots = []) {
  const defined = new Set(); let sawMigrations = false;
  const scan = (sql) => { for (const m of String(sql).matchAll(FN_DEF)) defined.add(m[1].toLowerCase()); };
  for (const { root, ref } of roots) {
    if (!root) continue;
    const dir = join(root, 'supabase', 'migrations');
    if (existsSync(dir)) {
      sawMigrations = true;
      for (const f of readdirSync(dir)) if (f.endsWith('.sql')) { try { scan(readFileSync(join(dir, f), 'utf8')); } catch { /* unreadable → skip */ } }
    }
    if (ref) {
      try {
        const out = execFileSync('git', ['grep', '-h', '-i', '-E', 'create (or replace )?function', ref, '--', 'supabase/migrations'], { cwd: root, encoding: 'utf8', stdio: 'pipe', maxBuffer: 16 * 1024 * 1024 });
        if (out.trim()) { sawMigrations = true; scan(out); }
      } catch { /* no such ref / no matches */ }
    }
  }
  return { defined, sawMigrations };
}

export function schemaFindings({ repoRoot, touched = [], roots = null } = {}) {
  const refs = new Map(); // fn → first file that adds a call to it
  for (const f of touched.filter((p) => isSource(p) && !isTest(p))) {
    for (const line of addedLines(repoRoot, f)) {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
      for (const re of RPC_REF) for (const m of line.matchAll(re)) if (!refs.has(m[1])) refs.set(m[1], f);
    }
  }
  if (!refs.size) return [];
  let productRoot = null; let productRef = null;
  try { productRoot = config.productRepoDir(); productRef = `origin/${config.githubBranch()}`; } catch { /* no product repo configured */ }
  const { defined, sawMigrations } = definedFunctions(roots || [{ root: repoRoot, ref: null }, { root: productRoot, ref: productRef }]);
  const findings = [];
  for (const [fn, file] of refs) {
    if (defined.has(fn.toLowerCase())) continue;
    findings.push({ rule: 'undefined-rpc', file, name: fn,
      reason: sawMigrations
        ? `${file} adds a call to the database function \`${fn}\`, but no migration under supabase/migrations creates it. Code that calls a function the schema does not have passes every mocked test and fails every real request (the 2026-09-18 brain write outage). Use a function that exists, or stop: a schema change is a migration, and it must be written, reviewed and APPLIED before code depends on it.`
        : `${file} adds a call to the database function \`${fn}\`, and no supabase/migrations directory could be found to verify it exists — this check fails closed.` });
  }
  return findings;
}

// Gate-shaped. SCHEMA_CHECK=0 disables.
export function schemaErrors(repoRoot, touched, opts = {}) {
  if (process.env.SCHEMA_CHECK === '0') return [];
  try { return schemaFindings({ repoRoot, touched, ...opts }).map((f) => `SCHEMA ${f.file}: ${f.reason}`); }
  catch (e) { return [`SCHEMA: the schema reference check could not run (${String(e.message).slice(0, 160)}) — it fails closed`]; }
}
