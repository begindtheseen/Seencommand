// Stripe connector — optional direct read of revenue, a cross-check on Seen's revenue funnel for the Revenue
// dept. Seen sells ONE-TIME products since 2026-10-25 (Interview Prep, Job Search Pass, employer SKUs; all
// Stripe Checkout mode 'payment'), so the main read is paid one-time Checkout Sessions in the last 30 days.
// Active subscriptions are only the legacy ones started before the change.
// Read-only; any charge/refund/dunning action is gated and executed elsewhere on approval.

import { config } from '../config.mjs';

async function stripeGet(path) {
  const key = config.stripeKey();
  if (!key) throw new Error('Stripe not configured (set STRIPE_SECRET_KEY)');
  const res = await fetch(`https://api.stripe.com/v1${path}`, { headers: { authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`Stripe ${path} → ${res.status}`);
  return res.json();
}

// Paid one-time Checkout Sessions created in the last `days` days (up to 300). Pure summing is exported for tests.
export function sumOneTime(sessions) {
  const paid = (sessions || []).filter((x) => x && x.mode === 'payment' && x.payment_status === 'paid');
  return { count: paid.length, total: Math.round(paid.reduce((a, x) => a + (x.amount_total || 0), 0)) / 100 };
}
export async function oneTimePayments(days = 30, nowMs = Date.now()) {
  const since = Math.floor((nowMs - days * 864e5) / 1000);
  const all = []; let after = null;
  for (let i = 0; i < 3; i++) {
    const j = await stripeGet(`/checkout/sessions?limit=100&created[gte]=${since}${after ? `&starting_after=${encodeURIComponent(after)}` : ''}`);
    all.push(...(j.data || []));
    if (!j.has_more || !j.data?.length) break;
    after = j.data[j.data.length - 1].id;
  }
  return { days, ...sumOneTime(all) };
}

// Legacy: active subscriptions started before 2026-10-25 + a rough MRR (sum of active recurring amounts, normalized to monthly).
export async function subscriptions() {
  const data = await stripeGet('/subscriptions?status=active&limit=100&expand[]=data.items.data.price');
  const subs = data.data || [];
  let mrrCents = 0;
  for (const s of subs) {
    for (const it of s.items?.data || []) {
      const price = it.price;
      if (!price?.recurring) continue;
      const amount = (price.unit_amount || 0) * (it.quantity || 1);
      const interval = price.recurring.interval;
      mrrCents += interval === 'year' ? amount / 12 : interval === 'week' ? amount * 4.33 : amount;
    }
  }
  return { activeCount: subs.length, mrr: Math.round(mrrCents / 100) };
}

export async function snapshot() {
  try {
    const [oneTime, subs] = await Promise.all([oneTimePayments(), subscriptions().catch(() => null)]);
    return { oneTime, subscriptions: subs };
  } catch (e) { return { error: e.message }; }
}

export const configured = () => !!config.stripeKey();
