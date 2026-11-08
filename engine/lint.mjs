// PHANTOM-REFERENCE LINT — the deterministic half of the competence fix (Brandon, 2026-07-10: "you
// should be able to tell what mistakes it keeps making — every time you find mistakes, prevent them").
// The recurring class in the builder's defective PRs is code that references things that DON'T EXIST:
//   #46  called selfUpdateCheck() — defined nowhere (crashed every board meeting, gate green)
//   #185 used require('moment') in an .mjs file — no require in ESM, and no such dependency
//   #73  read signals that no connector produces
// Tests only catch what they execute; this lint statically checks every ADDED line of the touched
// files and fails the gate with a NAMED phantom — which flows straight back into the coder's retry
// loop as feedback, so the model fixes it instead of shipping it. Set CODER_LINT=0 to disable.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { PHANTOM_CONCEPTS } from './proposal-gate.mjs';

// Identifiers that are legitimately callable without a repo definition site.
const GLOBALS = new Set((
  'require import fetch setTimeout setInterval clearTimeout clearInterval queueMicrotask structuredClone '
  + 'console JSON Math Promise Array Object String Number Boolean Date RegExp Map Set WeakMap WeakSet Symbol BigInt '
  + 'Error TypeError RangeError SyntaxError AggregateError AbortController AbortSignal URL URLSearchParams '
  + 'parseInt parseFloat isNaN isFinite encodeURIComponent decodeURIComponent encodeURI decodeURI btoa atob '
  + 'process Buffer globalThis Intl Proxy Reflect Function Boolean alert prompt confirm '
  + 'if for while switch catch return await async function class new typeof delete void in of else do try throw super this '
  + 'String Number it test describe assert expect'
).split(/\s+/));

const isJsLike = (f) => /\.(mjs|cjs|js|jsx|ts|tsx)$/.test(f);

function git(repoRoot, args) {
  try { return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }); } catch (e) { return e.stdout ? String(e.stdout) : ''; }
}

// The ADDED lines of a touched file (tracked: unstaged diff; untracked/new: the whole file).
export function addedLines(repoRoot, file) {
  let tracked = true;
  try { execFileSync('git', ['ls-files', '--error-unmatch', file], { cwd: repoRoot, stdio: 'ignore' }); } catch { tracked = false; }
  if (!tracked) {
    try { return readFileSync(join(repoRoot, file), 'utf8').split('\n'); } catch { return []; }
  }
  return git(repoRoot, ['diff', '--', file]).split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1));
}

// Does the repo contain a DEFINITION-shaped occurrence of `name`? (function/class/const/let/var
// declaration, object key, import/export binding — anywhere in tracked files or the touched set.)
// Pattern is POSIX-ERE-safe (macOS git grep has no \s or \b) AND valid JS RegExp — [ \t] only.
// A false boundary match just treats a name as defined (lint stays quiet) — the safe direction.
function hasDefinition(repoRoot, name) {
  const pat = `(function|class)[ \t]+${name}|(const|let|var)[ \t]+(\\{[^}]*)?${name}|${name}[ \t]*[:=]|import[^;]*${name}|export[^;]*${name}`;
  const out = git(repoRoot, ['grep', '-l', '-E', '-e', pat, '--', '*.mjs', '*.js', '*.cjs', '*.jsx', '*.ts', '*.tsx']);
  if (out.trim()) return true;
  // untracked files (a NEWFILE this build created) aren't in git grep — scan them via diff-less read
  const untracked = git(repoRoot, ['ls-files', '--others', '--exclude-standard']).split('\n').filter((f) => f && isJsLike(f));
  const re = new RegExp(pat);
  for (const f of untracked) {
    try { if (re.test(readFileSync(join(repoRoot, f), 'utf8'))) return true; } catch { /* skip */ }
  }
  return false;
}

// Bare package name from an import/require specifier ('moment', '@scope/pkg'); null for relative/node:.
export function packageOf(spec) {
  if (!spec || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) return null;
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

const NODE_BUILTINS = new Set(('assert buffer child_process cluster crypto dns events fs http https net os path '
  + 'querystring readline stream string_decoder timers tls url util v8 vm worker_threads zlib test').split(' '));

// ---- secret motion (the PR #190 class) -------------------------------------------------------------
// #190 shipped `process.env.NEXT_PUBLIC_SUPABASE_SERVICE_KEY` — a SERVICE key behind Next's
// client-inline prefix. Unset it's a silent no-op; the day someone "fixes" the broken feature by
// setting it, every browser gets the service key. These are cheap, near-zero-false-positive checks.
const PUBLIC_SECRET_NAME = /NEXT_PUBLIC_[A-Z0-9_]*(SERVICE|SECRET|PRIVATE|ADMIN)[A-Z0-9_]*/;
const SECRET_ENV_READ = /process\.env\.([A-Z0-9_]*(SERVICE_KEY|SERVICE_ROLE|SECRET|PRIVATE_KEY)[A-Z0-9_]*)/;
const CRED_LITERAL = /['"`](sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{60,})/;
const CLIENT_DIR = /^(components|hooks|lib\/hooks)\//; // unambiguously client-side by this product's conventions

// ---- unwired new modules (the PR #189/#190 class) --------------------------------------------------
// Two sibling tasks each shipped a whole realtime implementation that NOTHING imports — dead code at
// file scale, gate-green because dead code breaks nothing. A NEW library module must arrive with a
// caller in the same change. scripts/, tests, and framework-routed files are legitimately standalone.
export function unwiredNewModules(repoRoot, touched) {
  const errors = [];
  for (const f of touched.filter(isJsLike)) {
    if (/(^|\/)(scripts|api|pages|app)\//.test(f) || /\.test\./.test(f) || /(page|route|layout|middleware)\.[jt]sx?$/.test(f)) continue;
    if (!/^(lib|components|hooks|engine|brain\/lib)\//.test(f)) continue;
    let tracked = true;
    try { execFileSync('git', ['ls-files', '--error-unmatch', f], { cwd: repoRoot, stdio: 'ignore' }); } catch { tracked = false; }
    if (tracked) continue; // only NEW files — rewiring existing ones is the reviewer's judgment
    const base = (f.split('/').pop() || '').replace(/\.(mjs|cjs|js|jsx|ts|tsx)$/, '');
    if (base.length < 4) continue; // too generic to grep for honestly
    const hits = git(repoRoot, ['grep', '-l', '-F', '-e', base, '--', '*.mjs', '*.js', '*.cjs', '*.jsx', '*.ts', '*.tsx'])
      .split('\n').filter((x) => x && x !== f);
    const untracked = git(repoRoot, ['ls-files', '--others', '--exclude-standard']).split('\n')
      .filter((x) => x && x !== f && isJsLike(x));
    for (const u of untracked) { try { if (readFileSync(join(repoRoot, u), 'utf8').includes(base)) hits.push(u); } catch { /* skip */ } }
    if (!hits.length) {
      errors.push(`LINT ${f}: NEW module that nothing imports — wire it into a caller in this same change or don't ship it (PRs #189/#190 shipped two dead realtime layers this way)`);
    }
  }
  return errors;
}

// ---- phantom CONCEPT (the #81 class) ---------------------------------------------------------------
// The other checks catch phantom CODE (undefined calls, phantom named imports). This catches a phantom
// CONCEPT in the diff itself: a fabricated system entity that does not exist — "the Chronos SDK". After
// issue #81 was CLOSED, a build ran on it anyway and the coder fabricated lib/chronos/client.mjs + an
// import to make the premise "resolve"; the gate went green (the import resolved, nothing tested it)
// and only the probabilistic reviewer caught it. This makes the catch deterministic. Every touched
// PATH and every ADDED line — comments INCLUDED, since a phantom concept in a comment is still
// fabrication bait — is tested against the shared PHANTOM_CONCEPTS registry (proposal-gate.mjs; its
// tests expect lower-case, so we lower first). A hit reds the gate with the concept id + why, phrased
// so the coder's retry loop self-corrects. One error per concept per file (PATH tested first) — a file
// that trips a concept many ways is still one problem.
export function phantomConcepts(repoRoot, touched) {
  const errors = [];
  for (const f of touched) {
    const flagged = new Set();
    const path = String(f).toLowerCase();
    for (const c of PHANTOM_CONCEPTS) {
      try { if (c.test(path)) { flagged.add(c.id); errors.push(`LINT ${f}: the file PATH names '${c.id}' — this concept does not exist in this system; do not fabricate it — solve the task without it or fail honestly. ${c.why}`); } } catch { /* a broken concept test never breaks the lint */ }
    }
    for (const raw of addedLines(repoRoot, f)) {
      const line = String(raw).toLowerCase();
      for (const c of PHANTOM_CONCEPTS) {
        if (flagged.has(c.id)) continue; // already reported for this file (via path or an earlier line)
        try { if (c.test(line)) { flagged.add(c.id); errors.push(`LINT ${f}: names '${c.id}' — this concept does not exist in this system; do not fabricate it — solve the task without it or fail honestly. ${c.why}\n  + ${String(raw).trim().slice(0, 160)}`); } } catch { /* skip */ }
      }
    }
  }
  return errors;
}

// ---- phantom named-import check (the #78 class) -------------------------------------------------
// `import { readBrainFacts, optimizedReadBrainFacts } from '../lib/brain.mjs'` where the module does
// NOT export optimizedReadBrainFacts is a HARD ESM load-time crash (SyntaxError: does not provide an
// export named 'X'). node --check can't see it (single-file syntax only) and the test gate is blind
// when nothing imports the file — so a gate-green PR ships a module that throws the instant it loads.
// This resolves the relative target and verifies every named binding is actually exported.

// The names a module EXPORTS. Returns a Set, or null when it CANNOT be determined with confidence
// (a `export * from …` wildcard makes the surface unknowable here) — null means "stay quiet", the
// same precision-first stance as hasDefinition: never flag unless we're sure.
export function exportedNames(src) {
  const text = String(src);
  if (/^[ \t]*export[ \t]+\*(?![ \t]+as[ \t])/m.test(text)) return null; // `export * from` — names unknowable
  const names = new Set();
  if (/^[ \t]*export[ \t]+default\b/m.test(text)) names.add('default');
  for (const m of text.matchAll(/^[ \t]*export[ \t]+(?:async[ \t]+)?function[ \t]*\*?[ \t]*([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of text.matchAll(/^[ \t]*export[ \t]+class[ \t]+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of text.matchAll(/^[ \t]*export[ \t]+(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of text.matchAll(/^[ \t]*export[ \t]+\*[ \t]+as[ \t]+([A-Za-z_$][\w$]*)[ \t]+from/gm)) names.add(m[1]);
  // destructured: export const { a, b } = … / export const [a, b] = …
  for (const m of text.matchAll(/^[ \t]*export[ \t]+(?:const|let|var)[ \t]*[[{]([^\]}]*)[\]}]/gm)) {
    for (const part of m[1].split(',')) {
      const id = part.replace(/^[ \t.]+/, '').split(':').pop().split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(id)) names.add(id);
    }
  }
  // export { a, b as c } (with or without a `from` re-export) — the EXPORTED name is the alias.
  for (const m of text.matchAll(/export[ \t]*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const seg = part.trim(); if (!seg) continue;
      const as = seg.match(/\bas[ \t]+([A-Za-z_$][\w$]*)/);
      const name = as ? as[1] : seg.split(/\s+/)[0];
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return names;
}

// Parse a single-line NAMED import from a RELATIVE module. Returns { spec, names } (names = the
// EXPORTED identifiers, before any `as` alias) or null. Only relative specifiers are our concern:
// package exports aren't statically resolvable here (and undeclared packages are check #2's job).
export function relativeNamedImport(line) {
  const m = line.match(/^[ \t]*import[ \t]+(?:[A-Za-z_$][\w$]*[ \t]*,[ \t]*)?\{([^}]*)\}[ \t]*from[ \t]*['"](\.[^'"]+)['"]/);
  if (!m) return null;
  const names = m[1].split(',').map((s) => {
    const seg = s.trim(); if (!seg) return null;
    return seg.split(/[ \t]+as[ \t]+/)[0].trim();
  }).filter((n) => n && /^[A-Za-z_$][\w$]*$/.test(n));
  return names.length ? { spec: m[2], names } : null;
}

// Resolve a relative import specifier from an importing file to a real module file on disk, trying
// the common source extensions and index files when the spec is extensionless. null if unresolved
// (then we stay quiet — an unresolved path is out of this check's scope).
function resolveRelative(repoRoot, importerFile, spec) {
  const direct = join(dirname(join(repoRoot, importerFile)), spec);
  const cands = [direct];
  if (!/\.\w+$/.test(spec)) {
    for (const e of ['.mjs', '.js', '.cjs', '.ts', '.tsx', '.jsx']) cands.push(direct + e);
    for (const e of ['.mjs', '.js', '.cjs', '.ts', '.tsx', '.jsx']) cands.push(join(direct, 'index' + e));
  }
  for (const c of cands) { try { if (statSync(c).isFile()) return c; } catch { /* next */ } }
  return null;
}

// Lint the touched files' ADDED lines. Returns error strings (empty = clean).
export function lintDiff(repoRoot, touched) {
  if (process.env.CODER_LINT === '0') return [];
  const errors = [];
  let deps = null; // lazy: the target repo's declared dependencies
  const depsOf = () => {
    if (deps) return deps;
    deps = new Set();
    try {
      const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
      for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        for (const d of Object.keys(pkg[k] || {})) deps.add(d);
      }
    } catch { /* no package.json = no bare imports allowed anyway */ }
    return deps;
  };

  const known = new Set(); // names already verified defined — one grep per unique name per run
  for (const f of touched.filter(isJsLike)) {
    const added = addedLines(repoRoot, f);
    const phantoms = new Set();

    // 5) an ADDED line that duplicates its neighbor verbatim — a copy-paste no-op is not a change
    //    (#66 shipped a duplicated alias check as "conflict resolution"). Non-trivial lines only.
    const addedTrim = new Set(added.map((l) => l.trim()).filter((l) => l.length >= 20 && !/^[/*{}]/.test(l)));
    if (addedTrim.size) {
      let cur = []; try { cur = readFileSync(join(repoRoot, f), 'utf8').split('\n'); } catch { /* unreadable */ }
      for (let i = 1; i < cur.length; i++) {
        const a = cur[i - 1].trim();
        if (a && a === cur[i].trim() && addedTrim.has(a)) {
          errors.push(`LINT ${f}: line ${i + 1} duplicates the line directly above it verbatim — remove the copy (PR #66's class):\n  + ${a.slice(0, 160)}`);
          break;
        }
      }
    }

    for (const raw of added) {
      const line = raw.trim();
      if (!line || line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;

      // 4) secrets moving toward the client (#190's loaded gun) + credential literals anywhere.
      const pub = line.match(PUBLIC_SECRET_NAME);
      if (pub) {
        errors.push(`LINT ${f}: '${pub[0]}' — NEXT_PUBLIC_ names are inlined into the CLIENT bundle; a service/secret key must never wear that prefix (PR #190 shipped this):\n  + ${line.slice(0, 160)}`);
        continue;
      }
      if (CRED_LITERAL.test(line)) {
        errors.push(`LINT ${f}: hardcoded credential-shaped literal — secrets live in env/config, never in source:\n  + ${line.slice(0, 120)}`);
        continue;
      }
      const sec = CLIENT_DIR.test(f) && line.match(SECRET_ENV_READ);
      if (sec && !/NEXT_PUBLIC_/.test(sec[1])) {
        errors.push(`LINT ${f}: reads server secret ${sec[1]} in a client-side path — move it behind an API route or a lib/server module:\n  + ${line.slice(0, 160)}`);
        continue;
      }

      // 1) require() inside ESM — crashes the moment it runs (#185).
      if (/\.mjs$/.test(f) && /\brequire\s*\(/.test(line)) {
        errors.push(`LINT ${f}: require() in an ES module — use import (this exact bug shipped as PR #185 and crashes on run):\n  + ${line.slice(0, 160)}`);
        continue;
      }
      // 2) imports/requires of packages the target repo does not declare.
      const spec = (line.match(/from\s+['"]([^'"]+)['"]/) || line.match(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/) || [])[1];
      if (spec) {
        const pkgName = packageOf(spec);
        if (pkgName && !NODE_BUILTINS.has(pkgName) && !depsOf().has(pkgName)) {
          errors.push(`LINT ${f}: imports '${pkgName}' which is NOT in this repo's package.json — the module will not resolve:\n  + ${line.slice(0, 160)}`);
        }
      }
      // 2.5) named imports of bindings a RELATIVE module does not export — a hard load-time crash
      //      the tests never see (#78: `import { optimizedReadBrainFacts } from '../lib/brain.mjs'`).
      const imp = relativeNamedImport(line);
      if (imp) {
        const modPath = resolveRelative(repoRoot, f, imp.spec);
        if (modPath) {
          let exports = null;
          try { exports = exportedNames(readFileSync(modPath, 'utf8')); } catch { exports = null; }
          if (exports) { // null = inconclusive (export * / unreadable) → stay quiet
            for (const name of imp.names) {
              if (exports.has(name)) continue;
              const avail = [...exports].filter((n) => n !== 'default').sort().slice(0, 12).join(', ');
              errors.push(`LINT ${f}: imports { ${name} } from '${imp.spec}' but that module does NOT export ${name} — this crashes at load (SyntaxError: does not provide an export named '${name}'). That module's exports are: ${avail || '(none)'}.`);
            }
          }
        }
      }
      // 3) bare function CALLS with no definition anywhere in the repo (#46's class).
      //    Method calls (obj.foo(...)) are skipped — too dynamic to judge statically.
      for (const m of line.matchAll(/(^|[^\w.$])([a-zA-Z_$][\w$]{2,})\s*\(/g)) {
        const name = m[2];
        if (GLOBALS.has(name) || phantoms.has(name) || known.has(name)) continue;
        if (hasDefinition(repoRoot, name)) { known.add(name); continue; }
        {
          phantoms.add(name);
          errors.push(`LINT ${f}: calls ${name}() but ${name} is defined NOWHERE in this repo — remove the call or define it (this exact bug shipped as PR #46 and crashed at runtime):\n  + ${line.slice(0, 160)}`);
        }
      }
    }
  }
  errors.push(...unwiredNewModules(repoRoot, touched));
  errors.push(...phantomConcepts(repoRoot, touched)); // a fabricated concept in the diff (the #81 class)
  return errors;
}
