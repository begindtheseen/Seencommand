// SIMULATE BEFORE MAJOR DECISIONS (owner, 2026-10-21: "allow this thing to run simulations before making major
// decisions. let it deep think and take its time."). A major decision (an irreversible or high-risk approval,
// pricing, spend, publishing in public, outreach, schema/data changes) is not decided on one pass:
//
//   1. THREE independent deep passes, each blind to the others, so they cannot anchor on each other:
//        operator  — has run many businesses; expected effect on SeenJobs' users, revenue and position
//        pre-mortem — "it is six months later and this went badly: why?"; risks, failure modes, what to watch
//        market     — the job seekers / creators / employers it touches; trust, reaction, second-order effects
//   2. A NUMBERS run when the decision has numbers: 2,000 Monte-Carlo draws over the ranges given
//      (triangular low/likely/high) → p10 / p50 / p90 of users, paying users, revenue and net per month
//      (`mrr` in the output = revenue per month; Seen's sales are one-time, so it is not recurring).
//      Assumptions are printed with the result — a projection, never a promise.
//   3. A CHAIR pass that weighs the three views and the numbers → go / modify / don't, the conditions,
//      what would change the call, and how reversible it is.
//
// Deep = the strongest reasoning lane, long timeouts, room to think (lib/llm.mjs reason with competence
// 'reason'). Never blocks a decision: when the model lanes are down the brief says so and nothing is
// invented. Pure helpers are unit tested; the model is injected.

const clean = (s, n = 4000) => String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim().slice(0, n);

// Which approvals are major. `risk` is the approval's own risk label; kinds/titles that cannot be cheaply undone count too.
const MAJOR_WORDS = /\b(pric(?:e|es|ing)|charg\w*|spend\w*|budget\w*|ads?|paid|publish\w*|post (?:publicly|to)|launch\w*|announc\w*|outreach|email (?:users|list)|migrat\w*|schema|delet\w*|purge\w*|production|prod|contract\w*|partner\w*|hir(?:e|ing)|refund\w*|terms|privacy)\b/i;
export function isMajor(a) {
  if (!a) return false;
  if (/high|irreversible/i.test(String(a.risk || ''))) return true;
  return MAJOR_WORDS.test(`${a.action || ''} ${a.title || ''} ${a.summary || ''}`);
}

// ---- numbers: a seeded RNG (same inputs → same answer), triangular draws, percentiles -------------------
export function rng(seed = 42) { let s = (Number(seed) >>> 0) || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
export function triangular(r, { low, likely, high }) {
  const a = Number(low), c = Number(likely), b = Number(high);
  if (!(a <= c && c <= b)) throw new Error(`range must be low ≤ likely ≤ high (got ${low}, ${likely}, ${high})`);
  if (a === b) return a;
  const u = r(); const f = (c - a) / (b - a);
  return u < f ? a + Math.sqrt(u * (b - a) * (c - a)) : b - Math.sqrt((1 - u) * (b - a) * (b - c));
}
export const pct = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))] : null;

// The growth/revenue model: weekly compounding users, the share of them who buy in a month, price, monthly costs.
// inputs: { users, weeks, weeklyGrowth{low,likely,high} (0.05 = 5%/wk), paidShare{…} (0.02 = 2% buy a month), price{…} ($ per sale),
//           monthlyCost{…} ($), oneTime?{ cost } } — any range may be a plain number (fixed).
export function simulateNumbers(inputs, { runs = 2000, seed = 42 } = {}) {
  const r = rng(seed);
  const range = (v) => (typeof v === 'number' ? { low: v, likely: v, high: v } : v);
  const need = ['users', 'weeks', 'weeklyGrowth', 'paidShare', 'price', 'monthlyCost'];
  const missing = need.filter((k) => inputs?.[k] == null);
  if (missing.length) return { ok: false, error: `missing ${missing.join(', ')}` };
  const out = { users: [], paid: [], mrr: [], net: [] };
  for (let i = 0; i < runs; i++) {
    const g = triangular(r, range(inputs.weeklyGrowth));
    const users = Number(inputs.users) * Math.pow(1 + g, Number(inputs.weeks));
    const paid = users * triangular(r, range(inputs.paidShare));
    const mrr = paid * triangular(r, range(inputs.price));
    const net = mrr - triangular(r, range(inputs.monthlyCost)) - (inputs.oneTime?.cost ? Number(inputs.oneTime.cost) / Math.max(1, Number(inputs.weeks) / 4.345) : 0);
    out.users.push(users); out.paid.push(paid); out.mrr.push(mrr); out.net.push(net);
  }
  const summary = {};
  for (const [k, list] of Object.entries(out)) { const s = list.sort((a, b) => a - b); summary[k] = { p10: round(pct(s, 10)), p50: round(pct(s, 50)), p90: round(pct(s, 90)) }; }
  const s = out.net; // already sorted
  summary.chanceNetPositive = round(s.filter((x) => x > 0).length / s.length, 2);
  return { ok: true, runs, seed, weeks: Number(inputs.weeks), summary, assumptions: inputs };
}
const round = (x, d = 0) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

// ---- the deep passes --------------------------------------------------------------------------------
export const PERSPECTIVES = {
  operator: 'You have built and run many companies. Judge this decision for SeenJobs (seenjobs.io — grades employers on how they treat applicants; early stage, organic growth, trust is the asset). What is the expected effect on users, revenue and market position over 90 days? What would a great operator do instead or in addition?',
  premortem: 'Run a pre-mortem. It is six months from now and this decision went badly for SeenJobs. Write the most likely reasons it failed, the early warning signs to watch in the first two weeks, and how to make it safer or reversible.',
  market: 'Speak for the people this touches — job seekers, creators who might share Seen, employers being graded. How do they react? What does it do to trust in SeenJobs? Any second-order effects (platform rules, reputation, legal/defamation posture, competitors)?',
};
const PASS_FORMAT = 'Answer with ONE JSON object: {"verdict":"go"|"modify"|"dont","expected_effect":"<2 sentences>","risks":["…"],"assumptions":["…"],"watch":["signals to watch"],"confidence":"low"|"medium"|"high"}. Be concrete to SeenJobs; no generic advice; never invent numbers — if a number is needed and not given, say it is unknown.';

export function parsePass(text) {
  try { const m = String(text || '').match(/\{[\s\S]*\}/); const j = m ? JSON.parse(m[0]) : null; if (!j || !/^(go|modify|dont)$/.test(j.verdict)) return null;
    const list = (v) => (Array.isArray(v) ? v.map((x) => clean(x, 300)).filter(Boolean).slice(0, 6) : []);
    return { verdict: j.verdict, expected_effect: clean(j.expected_effect, 600), risks: list(j.risks), assumptions: list(j.assumptions), watch: list(j.watch), confidence: /^(low|medium|high)$/.test(j.confidence) ? j.confidence : 'low' };
  } catch { return null; }
}

// Tally three verdicts: unanimous → that; any "dont" with high confidence → don't unless the operator is high-confidence go; else modify.
export function tally(passes) {
  const got = Object.values(passes).filter(Boolean);
  if (!got.length) return null;
  const v = got.map((p) => p.verdict);
  if (v.every((x) => x === v[0])) return v[0];
  if (got.some((p) => p.verdict === 'dont' && p.confidence === 'high') && !(passes.operator?.verdict === 'go' && passes.operator.confidence === 'high')) return 'dont';
  return 'modify';
}

export async function simulateDecision({ question, context = '', numbers = null, reasonFn, timeoutMs = 120_000 } = {}) {
  const q = clean(question, 1500);
  if (!q) return { ok: false, error: 'what decision should I simulate?' };
  const startedAt = new Date().toISOString();
  const sim = numbers ? simulateNumbers(numbers) : null;
  const facts = `${context ? `WHAT WE KNOW:\n${clean(context, 6000)}\n\n` : ''}${sim?.ok ? `NUMBERS RUN (2,000 draws; projection with these assumptions: ${JSON.stringify(sim.assumptions)}): ${JSON.stringify(sim.summary)}\n\n` : ''}`;
  const passes = {};
  // Blind and in parallel: no pass sees another.
  await Promise.all(Object.entries(PERSPECTIVES).map(async ([k, persona]) => {
    try {
      const r = await reasonFn({ deptId: 'strategy', competence: 'reason', system: `${persona}\n\n${PASS_FORMAT}`, prompt: `${facts}DECISION: ${q}`, maxTokens: 900, timeoutMs });
      passes[k] = parsePass(r?.text);
    } catch { passes[k] = null; }
  }));
  const verdict = tally(passes);
  let chair = null;
  if (verdict) {
    try {
      const r = await reasonFn({ deptId: 'strategy', competence: 'reason', system: 'You chair SeenJobs\' board. Weigh the three independent views and the numbers. Write, in plain words, max 8 short lines: the call (go / modify / don\'t) and why; the conditions or changes that make it safe; what would change the call; how reversible it is and how to undo it. No preamble, no invented numbers.', prompt: `${facts}DECISION: ${q}\n\nOPERATOR: ${JSON.stringify(passes.operator)}\nPRE-MORTEM: ${JSON.stringify(passes.premortem)}\nMARKET: ${JSON.stringify(passes.market)}\nTALLY: ${verdict}`, maxTokens: 700, timeoutMs, fallback: '' });
      chair = clean(r?.text, 2500) || null;
    } catch { chair = null; }
  }
  const ran = Object.values(passes).filter(Boolean).length;
  return { ok: ran > 0, question: q, verdict, passes, chair, numbers: sim, startedAt, endedAt: new Date().toISOString(), note: ran < 3 ? `${3 - ran} of 3 deep passes could not run (no model lane answered) — treat this as incomplete.` : null };
}

// Plain-language brief of a result (chat, the approval card, the room).
export function simulationBrief(s) {
  if (!s?.ok) return `Simulation could not run${s?.error ? `: ${s.error}` : ' — no model lane answered, so nothing was concluded.'}`;
  const call = { go: 'GO', modify: 'GO, WITH CHANGES', dont: "DON'T" }[s.verdict] || 'UNDECIDED';
  const lines = [`**Simulated: ${s.question}** → **${call}**`];
  if (s.chair) lines.push(s.chair);
  for (const [k, label] of [['operator', 'Operator'], ['premortem', 'Pre-mortem'], ['market', 'Market']]) {
    const p = s.passes?.[k]; if (!p) { lines.push(`- ${label}: did not run`); continue; }
    lines.push(`- ${label} (${p.verdict}, ${p.confidence} confidence): ${p.expected_effect}${p.risks.length ? ` Risks: ${p.risks.slice(0, 3).join('; ')}.` : ''}`);
  }
  if (s.numbers?.ok) { const n = s.numbers.summary; lines.push(`- Numbers over ${s.numbers.weeks} weeks (projection): users ${n.users.p10}–${n.users.p50}–${n.users.p90}, revenue/month $${n.mrr.p10}–$${n.mrr.p50}–$${n.mrr.p90} (p10–p50–p90), chance net-positive ${Math.round(n.chanceNetPositive * 100)}%.`); }
  if (s.note) lines.push(`_${s.note}_`);
  return lines.join('\n');
}
