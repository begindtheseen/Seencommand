import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { routePatterns, routeResolves, routeFindings } from './route-refs.mjs';

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'route-refs-'));
  const g = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  execFileSync('git', ['init', '-b', 'main', root], { stdio: 'pipe' });
  g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false');
  for (const [p, body] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), body); }
  g('add', '-A'); g('commit', '-m', 'seed');
  return root;
}
const APP = {
  'app/page.tsx': 'export default function Home() { return null; }\n',
  'app/jobs/page.tsx': 'export default function Jobs() { return null; }\n',
  'app/jobs/[id]/page.tsx': 'export default function Job() { return null; }\n',
  'app/(marketing)/pricing/page.tsx': 'export default function P() { return null; }\n',
  'app/docs/[...slug]/page.tsx': 'export default function D() { return null; }\n',
  'app/api/health/route.ts': 'export function GET() {}\n',
  'api/brain.js': 'export default function handler() {}\n',
  'public/resume.pdf': 'x',
  'app/ghost-report/opengraph-image.tsx': 'export default function OG() {}\n',
  'app/sitemap.ts': 'export default function sitemap() { return []; }\n',
  'components/Nav.tsx': 'export function Nav() { return <a href="/jobs">Jobs</a>; }\n',
};

test('routes resolve through dynamic segments, route groups, catch-alls, api handlers and public files', () => {
  const root = repo(APP); const p = routePatterns(root);
  for (const ok of ['/ghost-report/opengraph-image', '/sitemap.xml', '/', '/jobs', '/jobs/42', '/jobs/42?tab=a#top', '/pricing', '/docs/a/b/c', '/api/health', '/api/brain', '/resume.pdf', '/jobs/']) assert.equal(routeResolves(ok, p, root), true, ok);
  for (const bad of ['/jobs/42/edit', '/employers', '/marketing/pricing', '/api/missing']) assert.equal(routeResolves(bad, p, root), false, bad);
});

test('an ADDED link to a page that does not exist is named; existing links and non-literal ones are left alone', () => {
  const root = repo(APP);
  writeFileSync(join(root, 'components/Nav.tsx'), [
    'export function Nav({ id }) { return (<nav>',
    '  <a href="/jobs">Jobs</a>',
    '  <Link href="/employers/dashboard">Employers</Link>',
    '  <Link href={`/jobs/${id}`}>One</Link>',
    '  <a href="https://example.com/x">out</a><a href="#top">top</a>',
    "  <button onClick={() => router.push('/saved')}>Saved</button>",
    "  <button onClick={() => router.push('/jobs/7')}>Seven</button>",
    '</nav>); }',
  ].join('\n'));
  const f = routeFindings({ repoRoot: root, touched: ['components/Nav.tsx'] });
  assert.deepEqual(f.map((x) => x.name).sort(), ['/employers/dashboard', '/saved']);
  assert.match(f[0].reason, /would ship as a 404/);
});

test('a repo with no file router is simply out of scope', () => {
  const root = repo({ 'lib/a.mjs': 'export const A = 1;\n' });
  writeFileSync(join(root, 'lib/a.mjs'), 'export const A = \'<a href="/anything">x</a>\';\n');
  assert.deepEqual(routeFindings({ repoRoot: root, touched: ['lib/a.mjs'] }), []);
});

test('building the destination in the same change satisfies the link', () => {
  const root = repo(APP);
  writeFileSync(join(root, 'components/Nav.tsx'), 'export function Nav() { return <a href="/saved">Saved</a>; }\n');
  mkdirSync(join(root, 'app/saved'), { recursive: true });
  writeFileSync(join(root, 'app/saved/page.tsx'), 'export default function S() { return null; }\n');
  assert.deepEqual(routeFindings({ repoRoot: root, touched: ['components/Nav.tsx', 'app/saved/page.tsx'] }), []);
});
