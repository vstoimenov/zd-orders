import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { insertOrder, updateStatus } from '../lib/orders-repo.js';
import { saveIntegration } from '../lib/integrations-repo.js';
import { saveCosts } from '../lib/costs.js';
import { shopMetrics } from '../lib/advisor/metrics.js';

process.env.INTEGRATIONS_SECRET = 'test-secret';
const SHOP = '00000000-0000-4000-8000-000000000001';
const DAY = '2026-11-10';
const ago = (n) => new Date(Date.parse(`${DAY}T12:00:00Z`) - n * 864e5).toISOString();
let q, n = 0;
beforeEach(async () => { q = await makeTestQuery(); n = 0; });

async function order({ phone = `+3598880${String(++n).padStart(5, '0')}`, total = 40, items = [{ name: 'Крем', qty: 1, price: 35 }], status = 'new', daysAgo = 1, shippedDaysAgo = null, nk = '', answer = null } = {}) {
  const r = await insertOrder(q, {
    cbOrderId: `s.bg:${n}-${Math.random()}`, name: 'Мария', phone, phoneNorm: phone, email: '', deliveryType: 'econt_office', courier: 'econt', officeId: '', officeText: 'ЕКОНТ',
    city: 'Плевен', postCode: '', addressText: '', items, total, currency: 'EUR', paymentMethod: 'cod', pageUrl: '', ip: '1', shopId: SHOP,
  });
  if (status !== 'new') await updateStatus(q, r.id, status);
  await q(`update zd.orders set created_at = $2::timestamptz, waybill_created_at = $3::timestamptz, nk_status = coalesce(nullif($4, ''), nk_status), confirm_answer = coalesce($5, confirm_answer) where id = $1::uuid`,
    [r.id, ago(daysAgo), shippedDaysAgo == null ? null : ago(shippedDaysAgo), nk, answer]);
  return r.id;
}
const connectMeta = () => saveIntegration(q, 'meta', { config: { accountId: '123', active: true, currency: 'EUR' }, secret: 'tok', shopId: SHOP });
const spend = (daysAgo, value) => q(`insert into zd.ad_spend (shop_id, platform, account_id, day, spend, currency) values ($1::uuid, 'meta', '123', $2::date, $3, 'EUR')`,
  [SHOP, ago(daysAgo).slice(0, 10), value]);

test('the 30 days: orders, revenue, margin like „Финанси“; unknown stays null without Meta and costs', async () => {
  await order({ daysAgo: 2 }); await order({ daysAgo: 5, status: 'cancelled' }); await order({ daysAgo: 40 }); await order({ daysAgo: 0 });
  let m = await shopMetrics(q, SHOP, DAY);
  assert.equal(m.orders30, 1, 'only whole days before today, cancelled left out');
  assert.equal(m.revenue30, 40);
  assert.equal(m.meta, false);
  assert.equal(m.marginKnown, false);
  assert.equal(m.marginPerOrder, null);
  assert.equal(m.payback, null);
  assert.equal(m.roas7, null);
  await saveCosts(q, { products: [{ name: 'Крем', unitCost: 10 }], settings: { packaging: 1, codFeePct: 2, returnCost: 7 }, shopId: SHOP });
  m = await shopMetrics(q, SHOP, DAY);
  assert.equal(m.contribution30, 35 - 10 - 1 - 0.8);
  assert.equal(m.marginPerOrder, 23.2);
  assert.equal(m.returnCost, 7);
  assert.equal(m.breakEvenRoas, Math.round((40 / 23.2) * 100) / 100);
});

test('payback: new buyers of 30–60 days ago, their first 30 days, the spend of those days', async () => {
  await connectMeta();
  await saveCosts(q, { products: [{ name: 'Крем', unitCost: 10 }], shopId: SHOP });
  for (let i = 0; i < 6; i++) {
    const phone = `+35988877700${i}`;
    await order({ phone, daysAgo: 45 });
    await order({ phone, daysAgo: 35 }); // within the first 30 days: counted
    await order({ phone, daysAgo: 2 }); // later: not counted
  }
  await order({ phone: '+359888999999', daysAgo: 70 }); await order({ phone: '+359888999999', daysAgo: 40 }); // an old buyer: not new
  for (let d = 31; d <= 60; d++) await spend(d, 10); // 300 €
  const m = await shopMetrics(q, SHOP, DAY);
  assert.equal(m.meta, true);
  assert.equal(m.payback.newBuyers, 6);
  assert.equal(m.payback.spend, 300);
  assert.equal(m.payback.margin, 6 * 2 * 25);
  assert.equal(m.payback.value, 1);
  assert.equal(m.payback.byDelivery, false, 'no courier statuses: by orders not returned');
});

test('returns by the week a parcel left, only parcels sent 21+ days ago; couriers report → status tracked', async () => {
  for (let i = 0; i < 10; i++) await order({ daysAgo: 30, shippedDaysAgo: 29, status: i < 3 ? 'returned' : 'delivered' }); // recent cohort: 30%
  for (let i = 0; i < 10; i++) await order({ daysAgo: 80, shippedDaysAgo: 79, status: i < 1 ? 'returned' : 'delivered' }); // base: 10%
  await order({ daysAgo: 10, shippedDaysAgo: 9, status: 'returned' }); // too fresh for the rate
  const m = await shopMetrics(q, SHOP, DAY);
  assert.equal(m.returns.shipped, 10);
  assert.equal(m.returns.rate, 0.3);
  assert.equal(m.returns.base, 0.1);
  assert.equal(m.returns.baseShipped, 10);
  assert.equal(m.statusTracked, true);
  assert.equal(m.returnCost, 5, 'the default when the shop set none');
});

test('risky parcels without the customer’s yes; stock days of top products; sleeping buyers; open carts', async () => {
  await order({ daysAgo: 3, shippedDaysAgo: 2, nk: 'flagged' });
  await order({ daysAgo: 3, shippedDaysAgo: 2, nk: 'flagged', answer: 'yes' });
  await order({ daysAgo: 3, nk: 'flagged' }); // not sent yet
  await saveCosts(q, { products: [{ name: 'Крем', unitCost: 10 }], shopId: SHOP });
  await q(`update zd.product_costs set stock = 7 where shop_id = $1::uuid`, [SHOP]);
  for (let i = 0; i < 14; i++) await order({ daysAgo: i + 1 }); // 1 a day for 14 days
  await order({ phone: '+359888100100', daysAgo: 200 }); await order({ phone: '+359888100101', daysAgo: 200, status: 'returned' });
  await q(`insert into zd.abandoned_carts (shop_id, phone_norm, name, items, total, currency, created_at, updated_at) values ($1::uuid, '+359888555555', 'Ива', '[]', 30, 'EUR', $2, $2)`, [SHOP, ago(3)]);
  const m = await shopMetrics(q, SHOP, DAY);
  assert.equal(m.risky.count, 1);
  assert.equal(m.stock[0].name, 'Крем');
  assert.equal(m.stock[0].daysLeft, Math.round((7 / (17 / 14)) * 100) / 100);
  assert.equal(m.customers.sleeping, 1, 'a buyer who only returned is not a sleeping customer');
  assert.equal(m.carts.open, 1);
});
