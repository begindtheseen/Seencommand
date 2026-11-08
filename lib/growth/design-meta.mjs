// The ad designer's template + size list for the server (routes, act verbs, the ads matrix), read from the
// ONE browser module (lib/ui/growth-design.js) in a sandbox — so the template list is never duplicated.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

export const DESIGN_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'growth-design.js');
let cached = null;
/** The browser module evaluated in an empty context (no DOM): { GrowthDesign } for tests and metadata. */
export function loadDesign() {
  if (cached) return cached;
  const ctx = vm.createContext({});
  vm.runInContext(readFileSync(DESIGN_FILE, 'utf8'), ctx, { filename: 'growth-design.js' });
  cached = ctx.GrowthDesign;
  return cached;
}
// JSON round-trip: values made inside the sandbox belong to another realm (their arrays fail deepEqual).
const plain = (v) => JSON.parse(JSON.stringify(v));
export function designMeta() { return plain(loadDesign().meta()); }
export function templateSpec(id) {
  const d = loadDesign(); const t = d.TEMPLATES[id]; if (!t) return null;
  return plain({ id, name: t.name, what: t.what, fields: t.fields, sample: t.sample, sizes: Object.entries(d.SIZES).map(([k, v]) => ({ id: k, ...v })), render: 'Growth tab → Ad designer (Canvas, exports PNG)' });
}
