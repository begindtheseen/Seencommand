#!/usr/bin/env node
// Regenerate docs/ACT_PARITY.md (the route → button → act verb table) from lib/act-parity.mjs.
// scripts/act-parity.test.mjs fails when the checked-in file is stale — run this after changing a route.
import { writeFileSync } from 'node:fs';
import { parityDoc } from '../lib/act-parity.mjs';

const out = new URL('../docs/ACT_PARITY.md', import.meta.url);
writeFileSync(out, parityDoc());
console.log(`wrote ${out.pathname}`);
