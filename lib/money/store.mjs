// Money & Scale — the owner-entered half of the money picture, kept in ONE data file (data/money.json):
// recurring costs, cash on hand, allocation overrides, channel spend, readiness check-offs. Plus a small
// snapshot history (data/money-history.jsonl) so growth rates are MEASURED by this app over time instead
// of assumed. Nothing here is invented: a cost nobody has entered is `null` ("not entered"), never a guess.
import { readFileSync, writeFileSync, renameSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { dataDir } from '../paths.mjs';
import { ptDate } from '../time-pt.mjs';

export const moneyPath = () => join(dataDir(), 'money.json');
export const historyPath = () => join(dataDir(), 'money-history.jsonl');

export const CATEGORIES = ['infra', 'ai', 'tools', 'ads', 'payroll', 'other'];
// COGS = what it costs to serve the product (gross margin); the rest is operating expense.
export const COGS_CATEGORIES = new Set(['infra', 'ai']);

// The starting cost list. Each entry says where its number came from; `confirmed: false` until the owner
// saves it. A blank (null) monthly means "not entered" and is counted as missing, not as $0.
export const DEFAULT_COSTS = [
  { name: 'Vercel Pro', monthly: 20, category: 'infra', confirmed: false, note: 'List price: Vercel Pro is $20 per member per month. Confirm on your Vercel invoice (extra usage is billed on top).' },
  { name: 'Supabase', monthly: 0, category: 'infra', confirmed: false, note: 'Free plan (measured 2026-10-21: no backups listed, grace-period wording). The brain also holds a "Pro" fact from 2026-10-01 — confirm in Supabase → Billing. Pro is $25/mo.' },
  { name: 'Domain (seenjobs.io)', monthly: null, category: 'infra', confirmed: false, note: 'Enter the yearly renewal divided by 12.' },
  { name: "Seen's own AI calls (product)", monthly: null, category: 'ai', confirmed: false, note: "Model calls made by seenjobs.io itself (résumé tools, tailoring). Seen Command cannot see them — enter last month's provider invoice." },
  { name: 'Resend (email)', monthly: null, category: 'infra', confirmed: false, note: 'Outcome emails. Enter 0 if you are on the free plan.' },
  { name: 'Ads', monthly: null, category: 'ads', confirmed: false, note: 'Monthly ad spend. Enter 0 if none.' },
];

export function defaultMoney() {
  return { version: 1, costs: DEFAULT_COSTS.map((c) => ({ ...c })), cash: null, allocationOverrides: {}, channels: [], readiness: {}, plans: { ...DEFAULT_PLANS }, updatedAt: null };
}
// Which plan each vendor is on. Supabase "free" is the 2026-10-21 measurement (see DEFAULT_COSTS note).
export const DEFAULT_PLANS = { supabase: { plan: 'free', source: 'measured 2026-10-21 (no backups listed, grace-period wording); the brain also holds a 2026-10-01 "Pro" fact' } };
export function setPlan(m, { service, plan } = {}, { now = new Date() } = {}) {
  const s = String(service || '').toLowerCase(); const p = String(plan || '').toLowerCase();
  if (s !== 'supabase') return { ok: false, error: 'only the Supabase plan is tracked (service=supabase)' };
  if (!['free', 'pro', 'team'].includes(p)) return { ok: false, error: 'plan must be free, pro or team' };
  return { ok: true, money: { ...m, plans: { ...(m.plans || {}), supabase: { plan: p, source: `set by the owner ${ptDate(now)}` } } } };
}

export function loadMoney({ path = moneyPath() } = {}) {
  try {
    const j = JSON.parse(readFileSync(path, 'utf8'));
    const d = defaultMoney();
    return { ...d, ...j, costs: Array.isArray(j.costs) ? j.costs : d.costs, channels: Array.isArray(j.channels) ? j.channels : [], allocationOverrides: j.allocationOverrides && typeof j.allocationOverrides === 'object' ? j.allocationOverrides : {}, readiness: j.readiness && typeof j.readiness === 'object' ? j.readiness : {}, plans: { ...d.plans, ...(j.plans && typeof j.plans === 'object' ? j.plans : {}) } };
  } catch { return defaultMoney(); }
}

export function saveMoney(m, { path = moneyPath(), now = new Date() } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const rec = { ...m, updatedAt: now.toISOString() };
  const t = `${path}.tmp`; writeFileSync(t, JSON.stringify(rec, null, 2)); renameSync(t, path);
  return rec;
}

const cleanText = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
// A money amount from the owner: a non-negative finite number (strings like "$1,200.50" accepted), or null.
export function parseAmount(v) {
  if (v === null || v === '' || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0 || n > 1e9) return NaN;
  return Math.round(n * 100) / 100;
}

// Set (add or replace) one recurring cost. Pure: returns { ok, money } or { ok:false, error }.
export function setCost(m, { name, monthly, note, category } = {}, { now = new Date() } = {}) {
  const nm = cleanText(name, 80);
  if (!nm) return { ok: false, error: 'a cost needs a name' };
  const amt = parseAmount(monthly);
  if (Number.isNaN(amt)) return { ok: false, error: `"${monthly}" is not a monthly dollar amount` };
  const list = (m.costs || []).slice();
  const i = list.findIndex((c) => c.name.toLowerCase() === nm.toLowerCase());
  const prev = i >= 0 ? list[i] : null;
  const cat = CATEGORIES.includes(category) ? category : (prev?.category || 'tools');
  const row = { name: prev?.name || nm, monthly: amt, category: cat, confirmed: true, note: note != null ? cleanText(note, 300) : (prev?.note || ''), updatedAt: now.toISOString() };
  if (i >= 0) list[i] = row; else list.push(row);
  return { ok: true, money: { ...m, costs: list }, previous: prev };
}

export function removeCost(m, name) {
  const nm = cleanText(name, 80).toLowerCase();
  const list = (m.costs || []).filter((c) => c.name.toLowerCase() !== nm);
  if (list.length === (m.costs || []).length) return { ok: false, error: `no cost named "${name}"` };
  return { ok: true, money: { ...m, costs: list } };
}

export function setCash(m, { amount, asOf } = {}, { now = new Date() } = {}) {
  const amt = parseAmount(amount);
  if (Number.isNaN(amt)) return { ok: false, error: `"${amount}" is not a dollar amount` };
  return { ok: true, money: { ...m, cash: amt == null ? null : { amount: amt, asOf: asOf ? String(asOf).slice(0, 10) : ptDate(now) } } };
}

// Owner-entered channel numbers (used when the Growth Studio is not on this build).
export function setChannel(m, { name, spend30d, signups30d, paid30d } = {}, { now = new Date() } = {}) {
  const nm = cleanText(name, 60);
  if (!nm) return { ok: false, error: 'a channel needs a name' };
  const spend = parseAmount(spend30d); const su = parseAmount(signups30d); const pd = parseAmount(paid30d);
  if ([spend, su, pd].some(Number.isNaN)) return { ok: false, error: 'spend, signups and paid must be numbers' };
  const list = (m.channels || []).filter((c) => c.name.toLowerCase() !== nm.toLowerCase());
  list.push({ name: nm, spend30d: spend, signups30d: su, paid30d: pd, updatedAt: now.toISOString() });
  return { ok: true, money: { ...m, channels: list } };
}

export function setReadiness(m, { id, done } = {}, { now = new Date() } = {}) {
  const key = cleanText(id, 60);
  if (!key) return { ok: false, error: 'which readiness item?' };
  const r = { ...(m.readiness || {}) };
  if (done == null) delete r[key]; else r[key] = { done: !!done, at: now.toISOString() };
  return { ok: true, money: { ...m, readiness: r } };
}

// ---- snapshot history ------------------------------------------------------------------------------
// One line per reading, at most every `minGapMs` (default 20 min), so the growth rate of users, revenue and
// database size can be measured from this app's own observations. Rows written before 2026-10-27 carry
// `mrr` (the subscription model) instead of `revenue30d`; they are read as they are and never rewritten.
export function readHistory({ path = historyPath(), days = 60, now = new Date() } = {}) {
  let rows = [];
  try { rows = readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }); } catch { /* none yet */ }
  const cut = +now - days * 864e5;
  return rows.filter((r) => Number.isFinite(+new Date(r.at)) && +new Date(r.at) >= cut).sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

export function recordSnapshot(snap, { path = historyPath(), now = new Date(), minGapMs = 20 * 60_000 } = {}) {
  const row = { at: now.toISOString() };
  for (const k of ['users', 'paying', 'revenue30d', 'dbMb']) if (Number.isFinite(snap?.[k])) row[k] = snap[k];
  if (Object.keys(row).length === 1) return null; // nothing measured — never write an empty reading
  const last = readHistory({ path, days: 2, now }).pop();
  if (last && +now - +new Date(last.at) < minGapMs) return null;
  try { mkdirSync(dirname(path), { recursive: true }); appendFileSync(path, `${JSON.stringify(row)}\n`); return row; } catch { return null; }
}
