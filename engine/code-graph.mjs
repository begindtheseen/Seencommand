// CODE GRAPH — the module-level structure of a repo: who exports what, who imports it, what tests it.
//
// Context retrieval here was lexical (files whose text matches words in the task), and the wiring
// failures that kept shipping are all STRUCTURAL: a tested helper nothing calls, an integration
// deleted while its helper and the helper's tests stay green, a new module no file imports. Words
// cannot see those. Import/export edges can.
//
// SCOPE, deliberately narrow. semantic-gate.mjs records what happened when a regex tried to decide
// "is this symbol defined?" at EXPRESSION level: 1,216 false positives on 139 real files. This graph
// reads only module-level `import` / `export` statements — a regular, line-anchored grammar — and
// every ambiguity resolves toward "consumed" (a namespace import, a dynamic import, a require, or a
// re-export all count as using everything the module offers). It can miss dead code. It must not
// accuse live code: its findings fail builds.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, normalize, relative } from 'node:path';

const SRC = /\.(mjs|cjs|js|jsx|ts|tsx)$/;
// A .d.ts declares types for a module that lives elsewhere — it is not a module with callers of its own.
export const isSource = (f) => SRC.test(f) && !/\.d\.[cm]?ts$/.test(f);
// evals/ is the pipeline's own scoring harness — like a test, it consumes code without being a product caller.
export const isTest = (f) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f) || /(^|\/)(__tests__|tests?|evals)\//.test(f);
// NOT `memory/`: in the product repo it holds the vault AND real code (memory/mcp/server.mjs), and skipping
// it made that server's imports invisible — measured as a false "nothing calls recordFactCloud".
const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', 'dist', 'out', '.next', 'coverage', 'data', 'public']);

export function listSourceFiles(root, dir = '') {
  const out = [];
  let names = [];
  try { names = readdirSync(join(root, dir)); } catch { return out; }
  for (const name of names) {
    if (SKIP_DIRS.has(name) || name.startsWith('.DS_')) continue;
    const rel = dir ? `${dir}/${name}` : name;
    let st; try { st = statSync(join(root, rel)); } catch { continue; }
    if (st.isDirectory()) out.push(...listSourceFiles(root, rel));
    else if (isSource(rel)) out.push(rel);
  }
  return out;
}

const names = (list) => list.split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
  const m = /^(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?$/.exec(p);
  return m ? { name: m[1], as: m[2] || m[1] } : null;
}).filter(Boolean);

// Parse one module's import/export surface. Statement-anchored (`^\s*import|export`) so string and
// comment contents elsewhere in the file are never read as code.
export function parseModule(text) {
  const src = String(text ?? '');
  const imports = []; const exports = new Set(); const reexports = []; const kinds = {};
  const add = (spec, o) => imports.push({ spec, names: [], all: false, ...o });

  // The clause may span lines but never a quote or a semicolon — otherwise a side-effect import on the
  // line above (`import './x.mjs';`) gets swallowed into the next statement's clause.
  for (const m of src.matchAll(/^[ \t]*import\s+(?:type\s+)?([^'";]*?)\s+from\s+['"]([^'"]+)['"]/gm)) {
    const clause = m[1]; const spec = m[2];
    if (/\*\s+as\s+[\w$]+/.test(clause)) { add(spec, { all: true }); continue; }
    const braces = /\{([\s\S]*?)\}/.exec(clause);
    const named = braces ? names(braces[1]).map((n) => n.name) : [];
    const def = clause.replace(/\{[\s\S]*?\}/, '').replace(/,/g, '').trim();
    add(spec, { names: [...named, ...(def ? ['default'] : [])] });
  }
  for (const m of src.matchAll(/^[ \t]*import\s+['"]([^'"]+)['"]/gm)) add(m[1], { sideEffect: true });
  // Dynamic import / require: the consumer may touch anything the module offers.
  for (const m of src.matchAll(/\bimport\s*\(\s*['"`]([^'"`$]+)['"`]\s*\)/g)) add(m[1], { all: true });
  for (const m of src.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) add(m[1], { all: true });

  // `kinds` records which exports are CALLABLE (a function, a class, or a const bound to a function):
  // "nothing calls it" is a behaviour gap for those, and merely tidy-minded for an exported constant.
  for (const m of src.matchAll(/^[ \t]*export\s+(async\s+)?(function\*?|class|const|let|var)\s+([\w$]+)([^\n]*)/gm)) {
    exports.add(m[3]);
    const fnConst = /^\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[\w$]+\s*=>)/.test(m[4]);
    kinds[m[3]] = /^function|^class/.test(m[2]) || fnConst ? 'callable' : 'value';
  }
  for (const m of src.matchAll(/^[ \t]*export\s+(?:const|let|var)\s+\{([^}]*)\}/gm)) for (const n of names(m[1])) exports.add(n.as);
  for (const m of src.matchAll(/^[ \t]*export\s+default\b/gm)) { void m; exports.add('default'); }
  for (const m of src.matchAll(/^[ \t]*export\s+(?:type\s+)?\{([\s\S]*?)\}(?:\s+from\s+['"]([^'"]+)['"])?/gm)) {
    const list = names(m[1]);
    for (const n of list) exports.add(n.as);
    if (m[2]) { reexports.push({ spec: m[2], names: list.map((n) => n.name), all: false }); add(m[2], { names: list.map((n) => n.name) }); }
  }
  for (const m of src.matchAll(/^[ \t]*export\s+\*\s+(?:as\s+[\w$]+\s+)?from\s+['"]([^'"]+)['"]/gm)) { reexports.push({ spec: m[1], names: [], all: true }); add(m[1], { all: true }); }
  if (/^[ \t]*module\.exports\b|^[ \t]*exports\.[\w$]+\s*=/m.test(src)) exports.add('*cjs*');
  return { imports, exports: [...exports], reexports, kinds };
}

const EXTS = ['', '.mjs', '.js', '.ts', '.tsx', '.jsx', '.cjs'];
// Resolve an import specifier to a repo-relative file in `known`, or null (a package / unresolvable).
export function resolveSpec(fromFile, spec, known) {
  let base = null;
  if (spec.startsWith('.')) base = normalize(join(dirname(fromFile), spec));
  else if (spec.startsWith('@/')) base = spec.slice(2);          // the product repo's tsconfig alias
  else if (spec.startsWith('~/')) base = spec.slice(2);
  else return null;
  base = base.replace(/\\/g, '/');
  const roots = spec.startsWith('.') ? [base] : [base, `src/${base}`];
  for (const r of roots) {
    for (const e of EXTS) if (known.has(r + e)) return r + e;
    // TS sources import './x.js' and mean './x.ts'
    const bare = r.replace(/\.(mjs|js|cjs)$/, '');
    if (bare !== r) for (const e of EXTS.slice(1)) if (known.has(bare + e)) return bare + e;
    for (const e of EXTS.slice(1)) if (known.has(`${r}/index${e}`)) return `${r}/index${e}`;
  }
  return null;
}

// Build the graph. `read(path)` returns a file's text; pass `overrides` (path → text|null) to model a
// different state of the same tree — null deletes the file — without touching the disk.
export function buildGraph({ root, files = null, read = null, overrides = null } = {}) {
  const list = new Set(files || listSourceFiles(root));
  if (overrides) for (const [p, t] of Object.entries(overrides)) { if (t === null) list.delete(p); else if (isSource(p)) list.add(p); }
  const reader = (p) => {
    if (overrides && Object.prototype.hasOwnProperty.call(overrides, p)) return overrides[p];
    if (read) return read(p);
    try { return readFileSync(join(root, p), 'utf8'); } catch { return ''; }
  };
  const modules = new Map();
  for (const p of list) {
    const text = reader(p) || '';
    modules.set(p, { path: p, text, ...parseModule(text), edges: [] });
  }
  for (const mod of modules.values()) {
    for (const imp of mod.imports) {
      const to = resolveSpec(mod.path, imp.spec, list);
      if (to) mod.edges.push({ to, names: imp.names, all: imp.all, sideEffect: !!imp.sideEffect });
    }
  }
  return { root, modules };
}

// Who consumes `name` from `path`? Follows re-export barrels. `{ tests: false }` drops test consumers.
export function consumersOf(graph, path, name, { tests = true, seen = new Set() } = {}) {
  const key = `${path}#${name}`;
  if (seen.has(key)) return [];
  seen.add(key);
  const out = new Set();
  for (const mod of graph.modules.values()) {
    if (mod.path === path) continue;
    for (const e of mod.edges) {
      if (e.to !== path) continue;
      if (!(e.all || e.names.includes(name))) continue;
      const via = mod.reexports.find((r) => resolveSpec(mod.path, r.spec, new Set(graph.modules.keys())) === path && (r.all || r.names.includes(name)));
      if (via) { for (const c of consumersOf(graph, mod.path, name, { tests, seen })) out.add(c); continue; }
      if (tests || !isTest(mod.path)) out.add(mod.path);
    }
  }
  return [...out];
}

// Is `name` used inside its own module beyond the statement that exports it? An export that other
// code in the same file relies on is wired by construction (and is how test seams are exported).
export function usedInternally(text, name) {
  if (name === 'default' || name === '*cjs*') return true;
  // Not part of a longer identifier, and not a member access (`x.name`) — but a SPREAD (`...name(`,
  // `{ ...name }`) is a real use: only a single dot, not three, makes it a property.
  const re = new RegExp(`(?<![\\w$])(?<!(?:^|[^.])\\.)${name.replace(/\$/g, '\\$')}(?![\\w$])`, 'g');
  let n = 0;
  for (const line of String(text).split('\n')) {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    n += (line.match(re) || []).length;
  }
  return n > 1; // one occurrence is the declaration itself
}

// Files that are entrypoints by CONVENTION: something outside the import graph runs them (a CLI, a
// framework router, a serverless platform, Electron). Their exports need no importer.
export function isEntrypoint(path) {
  return /(^|\/)scripts\//.test(path)
    || /^(api|pages)\//.test(path) || /^app\/.*\/?(page|route|layout|loading|error|not-found|template|default|middleware)\.[jt]sx?$/.test(path)
    || /(^|\/)(middleware|instrumentation|next\.config|tailwind\.config|postcss\.config)\.[cm]?[jt]s$/.test(path)
    || /(^|\/)(main|preload|server|index|cli)\.[cm]?js$/.test(path);
}

// The structural neighbourhood of a file — what a coder must see to change it safely.
export function neighbourhood(graph, path) {
  const mod = graph.modules.get(path);
  if (!mod) return null;
  const importers = [...graph.modules.values()].filter((m) => m.edges.some((e) => e.to === path)).map((m) => m.path);
  return {
    path, exports: mod.exports,
    imports: [...new Set(mod.edges.map((e) => e.to))],
    consumers: importers.filter((p) => !isTest(p)),
    tests: importers.filter(isTest),
  };
}

export const relFrom = (root, abs) => relative(root, abs).replace(/\\/g, '/');
export const fileExists = (root, p) => existsSync(join(root, p));

// ---- blankLiterals: a real (small) lexer, because regex cannot lex JavaScript ------------------------
// Returns `text` with the CONTENTS of comments, strings, template-literal text and regex literals
// replaced by spaces — same length, same line breaks, so offsets and line numbers still line up. Code
// inside a template's ${ … } is kept (and scanned recursively). This exists because a regex attempt at
// the same job mis-paired backticks, swallowed whole functions, and turned 5 false positives into 17.
const REGEX_MAY_FOLLOW = /(?:^|[(,=:[!&|?{};+\-*%<>~^])$|(?:\breturn|\btypeof|\bcase|\bin|\bof|\bdelete|\bvoid|\bthrow|\bnew|\belse|\bdo)$/;
export function blankLiterals(text) {
  const src = String(text ?? ''); const out = src.split('');
  const blank = (from, to) => { for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' '; };
  let i = 0;
  const scanCode = (stopAtBrace) => {
    let depth = 0;
    while (i < src.length) {
      const c = src[i]; const d = src[i + 1];
      if (c === '/' && d === '/') { const e = src.indexOf('\n', i); const end = e < 0 ? src.length : e; blank(i, end); i = end; continue; }
      if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? src.length : e + 2; blank(i, end); i = end; continue; }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
        blank(i + 1, j); i = Math.min(j + 1, src.length); continue;
      }
      if (c === '`') {
        let j = i + 1; let from = j;
        while (j < src.length && src[j] !== '`') {
          if (src[j] === '\\') { j += 2; continue; }
          if (src[j] === '$' && src[j + 1] === '{') { blank(from, j); i = j + 2; scanCode(true); j = i; from = j; continue; }
          j++;
        }
        blank(from, j); i = Math.min(j + 1, src.length); continue;
      }
      if (c === '/') {
        const before = src.slice(Math.max(0, i - 12), i).replace(/\s+$/, '');
        if (REGEX_MAY_FOLLOW.test(before)) {
          let j = i + 1; let inClass = false;
          while (j < src.length && src[j] !== '\n') {
            if (src[j] === '\\') { j += 2; continue; }
            if (src[j] === '[') inClass = true; else if (src[j] === ']') inClass = false;
            else if (src[j] === '/' && !inClass) break;
            j++;
          }
          if (src[j] === '/') { blank(i + 1, j); i = j + 1; continue; }
        }
      }
      if (stopAtBrace) { if (c === '{') depth++; else if (c === '}') { if (depth === 0) { i++; return; } depth--; } }
      i++;
    }
  };
  scanCode(false);
  return out.join('');
}
