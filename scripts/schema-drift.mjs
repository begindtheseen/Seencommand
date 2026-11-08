#!/usr/bin/env node
// schema-drift — every database function the tool and product code call must exist in the LIVE database.
// Exit 1 on drift (a merged-but-unapplied migration), 2 when the check could not run. --json for machines.
import { existsSync } from 'node:fs';
import { config } from '../lib/config.mjs';
import { schemaDrift } from '../lib/schema-drift.mjs';
import { logActivity } from '../lib/activity.mjs';

const roots = [config.commandRepoDir(), (() => { try { return config.productRepoDir(); } catch { return null; } })()].filter((r) => r && existsSync(r));
const url = process.env.SUPABASE_URL; const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
try {
  const r = await schemaDrift({ roots, url, key });
  if (process.argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else if (!r.missing.length) console.log(`✓ schema in step — all ${r.checked} database function(s) the code calls exist in the live database (${r.live} served).`);
  else { console.log(`✗ SCHEMA DRIFT — the code calls ${r.missing.length} function(s) the live database does not have:`); for (const m of r.missing) console.log(`  • ${m.fn}  ← ${m.files.slice(0, 3).join(', ')}`); console.log('  A migration was merged but not APPLIED (or never written). Every call to these fails in production right now.'); }
  if (r.missing.length) logActivity({ kind: 'drift', status: 'schema', summary: `schema drift: live database is missing ${r.missing.map((m) => m.fn).join(', ')}`, detail: JSON.stringify(r.missing).slice(0, 600) });
  process.exit(r.missing.length ? 1 : 0);
} catch (e) { console.error(`? schema drift NOT CHECKED — ${e.message}`); process.exit(2); }
