import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sumOneTime } from './stripe.mjs';

test('one-time revenue counts only paid Checkout payments (no subscriptions, no unpaid sessions)', () => {
  const r = sumOneTime([
    { mode: 'payment', payment_status: 'paid', amount_total: 999 },
    { mode: 'payment', payment_status: 'paid', amount_total: 1999 },
    { mode: 'payment', payment_status: 'unpaid', amount_total: 999 },
    { mode: 'subscription', payment_status: 'paid', amount_total: 999 },
  ]);
  assert.deepEqual(r, { count: 2, total: 29.98 });
  assert.deepEqual(sumOneTime([]), { count: 0, total: 0 });
});
