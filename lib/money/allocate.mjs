// Profit allocation — where each dollar seenjobs.io brings in should go, by stage.
//
// The method is Profit First (Mike Michalowicz, "Profit First", 2014): revenue − profit = expenses. Profit
// and owner pay are taken FIRST, as fixed percentages, into separate accounts; the business runs on what is
// left, which forces costs to fit. Start the profit share small and raise it every quarter.
// The percentages below are Seen Command's defaults for a bootstrapped software company (not the book's
// tables), shifted by stage: early on almost everything keeps the product alive and funds growth; as monthly revenue
// grows, owner pay and profit rise and operating cost falls as a share. The tax reserve is a placeholder —
// set it to your real rate with a tax professional. The owner can override any stage; overrides persist.
const r2 = (x) => Math.round(x * 100) / 100;

export const BUCKETS = [
  { id: 'profit', label: 'Profit', rule: 'Taken first, every month, into a separate account. A small share kept from day one builds the habit; raise it each quarter (Profit First).' },
  { id: 'owner', label: 'Owner pay', rule: 'You are paid for the work before the business spends on anything optional — but only once revenue exists to pay it.' },
  { id: 'tax', label: 'Tax reserve', rule: 'Set aside before spending so a tax bill is never a surprise. Placeholder rate — confirm yours with a tax professional.' },
  { id: 'operating', label: 'Operating', rule: 'Hosting, database, email, AI, tools. Costs must fit inside this bucket; when they do not, cut or raise prices before dipping into the others.' },
  { id: 'growth', label: 'Growth / ads', rule: 'Experiments that bring users (content, community, ads). Spend only on channels with a measured cost per signup; stop a channel that cannot show one in 30 days.' },
  { id: 'reserve', label: 'Reserve', rule: 'Rainy-day cash toward 3–6 months of operating costs — for a plan upgrade, a spike, or a bad month.' },
];

export const STAGES = [
  { id: 'pre', label: 'Pre-revenue / first dollars (under $1k/mo)', min: 0, max: 1000, pct: { profit: 1, owner: 0, tax: 10, operating: 69, growth: 15, reserve: 5 },
    why: 'Every dollar keeps the product alive and buys learning. Owner pay waits; a 1% profit share starts the habit.' },
  { id: '1k', label: '$1k–$5k/mo', min: 1000, max: 5000, pct: { profit: 5, owner: 10, tax: 15, operating: 45, growth: 20, reserve: 5 },
    why: 'Revenue is real: start paying yourself, fund the channel that works, keep costs under half.' },
  { id: '5k', label: '$5k–$10k/mo', min: 5000, max: 10000, pct: { profit: 5, owner: 25, tax: 15, operating: 30, growth: 20, reserve: 5 },
    why: 'Fixed costs are now a smaller share; owner pay becomes meaningful while growth stays funded.' },
  { id: '10k', label: '$10k+/mo', min: 10000, max: Infinity, pct: { profit: 10, owner: 30, tax: 15, operating: 20, growth: 20, reserve: 5 },
    why: 'A real business: profit is a line item, the owner is paid like an operator, operating cost is held to a fifth.' },
];

export const FRAMEWORKS = [
  { name: 'Profit First', by: 'Mike Michalowicz (2014)', idea: 'Revenue − profit = expenses: take profit and owner pay first, in fixed percentages, and run the business on the rest.' },
  { name: 'Default alive or default dead?', by: 'Paul Graham (essay, 2015)', idea: 'At current growth and costs, does the company reach profitability before the money runs out?' },
];

export function stageFor(monthlyRevenue) {
  const r = Number(monthlyRevenue) || 0;
  return STAGES.find((s) => r >= s.min && r < s.max) || STAGES[0];
}

// Validate an owner override for a stage: every bucket a whole/decimal percent 0–100, summing to 100.
export function validateOverride(pcts) {
  if (!pcts || typeof pcts !== 'object') return 'give a percentage for each bucket';
  const ids = BUCKETS.map((b) => b.id);
  const unknown = Object.keys(pcts).filter((k) => !ids.includes(k));
  if (unknown.length) return `unknown bucket${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`;
  const vals = ids.map((k) => Number(pcts[k] ?? 0));
  if (vals.some((v) => !Number.isFinite(v) || v < 0 || v > 100)) return 'each percentage must be between 0 and 100';
  const sum = vals.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 100) > 0.5) return `the percentages add up to ${r2(sum)}%, not 100%`;
  return null;
}

export function setOverride(money, stageId, pcts) {
  if (!STAGES.some((s) => s.id === stageId)) return { ok: false, error: `no stage "${stageId}" (${STAGES.map((s) => s.id).join(', ')})` };
  const o = { ...(money.allocationOverrides || {}) };
  if (pcts == null) { delete o[stageId]; return { ok: true, money: { ...money, allocationOverrides: o } }; }
  const err = validateOverride(pcts); if (err) return { ok: false, error: err };
  o[stageId] = Object.fromEntries(BUCKETS.map((b) => [b.id, Number(pcts[b.id] ?? 0)]));
  return { ok: true, money: { ...money, allocationOverrides: o } };
}

// Split this month's actual revenue. Amounts are rounded to cents and always add up to the revenue
// (any rounding remainder lands in Operating). Then the reality check: does Operating cover the costs?
export function allocate({ revenue = 0, overrides = {}, monthlyCosts = null } = {}) {
  const rev = Math.max(0, Number(revenue) || 0);
  const stage = stageFor(rev);
  const ov = overrides?.[stage.id];
  const pct = ov && !validateOverride(ov) ? ov : stage.pct;
  const buckets = BUCKETS.map((b) => ({ id: b.id, label: b.label, rule: b.rule, pct: Number(pct[b.id] || 0), default: stage.pct[b.id], amount: r2((rev * Number(pct[b.id] || 0)) / 100) }));
  const diff = r2(rev - buckets.reduce((n, b) => n + b.amount, 0));
  if (diff) { const op = buckets.find((b) => b.id === 'operating'); op.amount = r2(op.amount + diff); }
  const lines = rev > 0 ? buckets.filter((b) => b.amount > 0).map((b) => `$${b.amount.toFixed(2)} to ${b.label.toLowerCase()} (${b.pct}%)`) : [];
  let check = null;
  const op = buckets.find((b) => b.id === 'operating');
  if (monthlyCosts != null) {
    const gap = r2(op.amount - Number(monthlyCosts));
    check = gap >= 0
      ? { state: 'ok', text: `Operating ($${op.amount.toFixed(2)}) covers the known monthly costs ($${Number(monthlyCosts).toFixed(2)}) with $${gap.toFixed(2)} to spare.` }
      : { state: rev > 0 ? 'short' : 'pre', gap: -gap, text: rev > 0 ? `Operating ($${op.amount.toFixed(2)}) is $${(-gap).toFixed(2)} short of the known monthly costs ($${Number(monthlyCosts).toFixed(2)}) — cut costs or raise revenue before taking from the other buckets.` : `No revenue yet: the known costs ($${Number(monthlyCosts).toFixed(2)}/mo) come out of your own pocket. Keep them as small as possible until the first dollars arrive.` };
  }
  const idx = STAGES.indexOf(stage); const next = STAGES[idx + 1] || null;
  return {
    revenue: r2(rev), stage: { id: stage.id, label: stage.label, why: stage.why }, overridden: !!(ov && !validateOverride(ov)),
    buckets, lines, headline: rev > 0 ? `This month: ${lines.join(', ')}.` : 'This month: no revenue to allocate yet.',
    check, next: next ? { id: next.id, label: next.label, needed: r2(next.min - rev) } : null, frameworks: FRAMEWORKS,
  };
}
