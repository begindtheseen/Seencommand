// ROUTE REFERENCE CHECK — a link must lead somewhere.
//
// The builder shipped navigation pointing at pages that did not exist (the "broken navigation
// destinations" class): the link compiles, the suite is green, the user gets a 404. For a file-routed
// app the set of real destinations is simply the set of page files, so when a change ADDS an internal
// link, the route it names must resolve to one. Applies only to repos that have a file router (app/ or
// pages/); dynamic segments, route groups, catch-alls and public files are honoured, and anything
// not a literal internal path (external URLs, anchors, template strings with expressions) is ignored.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { addedLines } from './lint.mjs';
import { isSource, isTest } from './code-graph.mjs';

const PAGE = /^(page|route)\.[cm]?[jt]sx?$/;
// Next.js metadata conventions are served as routes too: app/x/opengraph-image.tsx → /x/opengraph-image,
// app/sitemap.ts → /sitemap.xml. (Measured: a real link to /ghost-report/opengraph-image was flagged.)
const META_SEGMENT = /^(opengraph-image|twitter-image|icon|apple-icon)\d*\.(?:[cm]?[jt]sx?|png|jpe?g|gif|svg|ico)$/;
const META_FILE = { sitemap: '/sitemap.xml', robots: '/robots.txt', manifest: '/manifest.webmanifest' };
const PAGES_FILE = /\.[cm]?[jt]sx?$/;

function walk(root, dir, out = []) {
  let names = []; try { names = readdirSync(join(root, dir)); } catch { return out; }
  for (const n of names) {
    if (n === 'node_modules' || n.startsWith('.')) continue;
    const rel = `${dir}/${n}`;
    let st; try { st = statSync(join(root, rel)); } catch { continue; }
    if (st.isDirectory()) walk(root, rel, out); else out.push(rel);
  }
  return out;
}

// Every route pattern the repo serves, as arrays of segments ('[id]' → {dyn}, '[...x]' → {rest}).
export function routePatterns(root) {
  const patterns = [];
  const seg = (s) => (/^\[\[?\.\.\./.test(s) ? { rest: true } : /^\[.+\]$/.test(s) ? { dyn: true } : s);
  for (const base of ['app', 'src/app']) {
    if (!existsSync(join(root, base))) continue;
    for (const f of walk(root, base)) {
      const parts = f.slice(base.length + 1).split('/');
      const file = parts.pop();
      const dirs = parts.filter((p) => !/^\(.*\)$/.test(p) && !p.startsWith('@')).map(seg);
      const meta = META_SEGMENT.exec(file);
      const named = META_FILE[file.replace(/\.[cm]?[jt]sx?$/, '')];
      if (PAGE.test(file)) patterns.push(dirs);
      else if (meta) patterns.push([...dirs, file.replace(/\.[^.]+$/, '')]);
      else if (named && !dirs.length) patterns.push(named.split('/').filter(Boolean));
    }
  }
  for (const base of ['pages', 'src/pages', 'api']) {
    if (!existsSync(join(root, base))) continue;
    for (const f of walk(root, base)) {
      if (!PAGES_FILE.test(f) || isTest(f)) continue;
      const rel = (base === 'api' ? f : f.slice(base.length + 1)).replace(PAGES_FILE, '');
      const parts = rel.split('/').filter(Boolean);
      if (parts[parts.length - 1] === 'index') parts.pop();
      if (parts.some((p) => p.startsWith('_'))) continue; // _app, _document
      patterns.push(parts.map(seg));
    }
  }
  return patterns;
}

export function routeResolves(path, patterns, root) {
  const clean = path.split(/[?#]/)[0].replace(/\/+$/, '') || '/';
  if (root && existsSync(join(root, 'public', clean))) return true; // a static file
  const want = clean.split('/').filter(Boolean);
  return patterns.some((p) => {
    for (let i = 0; i < p.length; i++) {
      if (p[i].rest) return true;
      if (i >= want.length) return false;
      if (!p[i].dyn && p[i] !== want[i]) return false;
    }
    return p.length === want.length;
  });
}

const LINK = [
  /\bhref\s*=\s*\{?\s*["'`](\/[^"'`${}\s]*)["'`]/g,
  /\b(?:router|navigation)\.(?:push|replace|prefetch)\(\s*["'`](\/[^"'`${}\s]*)["'`]/g,
  /\b(?:redirect|permanentRedirect)\(\s*["'`](\/[^"'`${}\s]*)["'`]/g,
];

export function routeFindings({ repoRoot, touched = [] } = {}) {
  const patterns = routePatterns(repoRoot);
  if (!patterns.length) return []; // no file router in this repo — nothing to resolve against
  const findings = []; const seen = new Set();
  for (const f of touched.filter((p) => isSource(p) && !isTest(p))) {
    for (const line of addedLines(repoRoot, f)) {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
      for (const re of LINK) for (const m of line.matchAll(re)) {
        const to = m[1];
        if (to.startsWith('//') || seen.has(`${f}→${to}`) || routeResolves(to, patterns, repoRoot)) continue;
        seen.add(`${f}→${to}`);
        findings.push({ rule: 'dead-route', file: f, name: to,
          reason: `${f} adds a link to \`${to}\`, but no page or route file serves that path — it would ship as a 404. Link to a route that exists, or build the destination page in this same change.` });
      }
    }
  }
  return findings;
}

// Gate-shaped. ROUTE_CHECK=0 disables.
export function routeErrors(repoRoot, touched) {
  if (process.env.ROUTE_CHECK === '0') return [];
  try { return routeFindings({ repoRoot, touched }).map((f) => `ROUTES ${f.file}: ${f.reason}`); }
  catch (e) { return [`ROUTES: the route reference check could not run (${String(e.message).slice(0, 160)}) — it fails closed`]; }
}
