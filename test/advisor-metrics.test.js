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

test('the margin is the same as „Финанси“ (profit before ads) for the same 30 days', async () => {
  const { getProfit } = await import('../lib/costs.js');
  await saveCosts(q, { products: [{ name: 'Крем', unitCost: 11.4 }, { name: 'Серум', unitCost: 7 }],
    settings: { packaging: 0.8, codFeePct: 1.7, returnCost: 6.5, freeShippingEcont: 4.2 }, shopId: SHOP });
  await order({ daysAgo: 2, total: 40, items: [{ name: 'Крем', qty: 1, price: 35 }] });
  await order({ daysAgo: 3, total: 55, items: [{ name: 'Крем', qty: 1, price: 35 }, { name: 'Серум', qty: 2, price: 20 }] }); // free shipping
  await order({ daysAgo: 4, total: 40, status: 'returned' });
  await order({ daysAgo: 5, total: 40, status: 'cancelled' });
  await order({ daysAgo: 6, total: 26, items: [{ name: 'Непознат', qty: 1, price: 21 }], status: 'delivered' }); // no cost entered
  await order({ daysAgo: 35, total: 40 }); // outside
  const m = await shopMetrics(q, SHOP, DAY);
  const p = await getProfit(q, { from: '2026-10-11', to: '2026-11-09', shopId: SHOP });
  assert.ok(Math.abs(m.contribution30 - p.profitBeforeAds) < 0.02, `${m.contribution30} vs ${p.profitBeforeAds}`);
  assert.equal(m.orders30, 4);
});

test('payback by orders counts a returned order as the loss it is; stock looks only at the 3 best sellers', async () => {
  await connectMeta();
  await saveCosts(q, { products: [{ name: 'Крем', unitCost: 10 }, { name: 'Мостра', unitCost: 1 }], settings: { returnCost: 5 }, shopId: SHOP });
  for (let i = 0; i < 5; i++) await order({ phone: `+35988877710${i}`, daysAgo: 45 });
  await order({ phone: '+359888777100', daysAgo: 40, status: 'returned' });
  for (let d = 31; d <= 60; d++) await spend(d, 5); // 150 €
  const m = await shopMetrics(q, SHOP, DAY);
  assert.equal(m.payback.margin, 5 * 25 - 5);
  for (const [name, price] of [['А', 50], ['Б', 40], ['В', 30]]) await order({ daysAgo: 3, items: [{ name, qty: 1, price }] });
  await saveCosts(q, { products: [{ name: 'Мостра', unitCost: 1 }], shopId: SHOP });
  await q(`update zd.product_costs set stock = 1 where shop_id = $1::uuid and name = 'Мостра'`, [SHOP]);
  await order({ daysAgo: 2, items: [{ name: 'Мостра', qty: 1, price: 2 }] });
  const s = await shopMetrics(q, SHOP, DAY);
  assert.equal(s.stock.find((x) => x.name === 'Мостра'), undefined, 'a small product is not a top seller');
});

/* ---- stage 2 ---- */
const shipAfter = (id, hours) => q(`update zd.orders set waybill_created_at = created_at + make_interval(hours => $2) where id = $1::uuid`, [id, hours]);

test('hours to ship (Ordyx waybills) now and before; slow parcels come back more often', async () => {
  for (let i = 0; i < 20; i++) await shipAfter(await order({ daysAgo: 2 + (i % 25) }), 60); // now: 60 h
  for (let i = 0; i < 20; i++) await shipAfter(await order({ daysAgo: 40 + (i % 60) }), 10); // before: 10 h
  for (let i = 0; i < 10; i++) await shipAfter(await order({ daysAgo: 50, status: i < 3 ? 'returned' : 'delivered' }), 72); // slow: 30% back
  for (let i = 0; i < 10; i++) await shipAfter(await order({ daysAgo: 50, status: i < 1 ? 'returned' : 'delivered' }), 5); // fast: 10% back
  const m = await shopMetrics(q, SHOP, DAY);
  assert.equal(m.ship.n, 20);
  assert.equal(m.ship.median, 60);
  assert.equal(m.ship.base, 10);
  assert.equal(m.ship.slow30, 20);
  assert.equal(m.ship.slowReturnRate, 0.3);
  assert.equal(m.ship.fastReturnRate, 0.1);
});

test('new buyers and their price; second orders within 60 days; refusals at confirmation', async () => {
  await connectMeta();
  for (let i = 0; i < 12; i++) await order({ daysAgo: 3 }); // 12 new buyers this month
  for (let i = 0; i < 20; i++) await order({ daysAgo: 45 }); // 20 new in the 90 days before
  for (let d = 1; d <= 120; d++) await spend(d, 4); // 120 € a month, 360 € before
  // 30 new buyers 60–90 days ago, 6 of them came back within 60 days; 30 new 90–180 days ago, 12 came back
  for (let i = 0; i < 30; i++) { const phone = `+359887000${String(i).padStart(3, '0')}`; await order({ phone, daysAgo: 75 }); if (i < 6) await order({ phone, daysAgo: 40 }); }
  for (let i = 0; i < 30; i++) { const phone = `+359886000${String(i).padStart(3, '0')}`; await order({ phone, daysAgo: 150 }); if (i < 12) await order({ phone, daysAgo: 120 }); }
  for (let i = 0; i < 20; i++) await q(`update zd.orders set confirm_answer = $2, confirm_answered_at = $3::timestamptz where id = $1::uuid`, [await order({ daysAgo: 4 }), i < 5 ? 'no' : 'yes', ago(4)]);
  const m = await shopMetrics(q, SHOP, DAY);
  assert.equal(m.newBuyers.n30, 12 + 20, 'the confirmed ones are new buyers too');
  assert.equal(m.newBuyers.cac, Math.round((120 / 32) * 100) / 100);
  assert.equal(m.repeat60.n, 30);
  assert.equal(m.repeat60.rate, 0.2);
  assert.equal(m.repeat60.base, 0.4);
  assert.equal(m.refusals.answered, 20);
  assert.equal(m.refusals.rate, 0.25);
});

test('conversion: orders ÷ visits since tracking began, now and before', async () => {
  const visit = (daysAgo, n) => q(`insert into zd.visits (day, site, visitor, shop_id) select $1::date, 's.bg', 'v' || g || '-' || $1, $2::uuid from generate_series(1, $3) g`, [ago(daysAgo).slice(0, 10), SHOP, n]);
  for (let d = 1; d <= 30; d++) await visit(d, 10); // 300 visits now
  for (let d = 31; d <= 70; d++) await visit(d, 10); // 400 before (tracking began 70 days ago)
  for (let i = 0; i < 3; i++) await order({ daysAgo: 5 }); // 1% now
  for (let i = 0; i < 8; i++) await order({ daysAgo: 40 }); // 2% before
  await order({ daysAgo: 100 }); // before tracking: not counted
  const m = await shopMetrics(q, SHOP, DAY);
  assert.equal(m.conversion.visits30, 300);
  assert.equal(m.conversion.rate, 0.01);
  assert.equal(m.conversion.base, 0.02);
  assert.equal(m.conversion.baseVisitsPerDay, 10);
});

test('the shop profile suggested from days to the second order; history and ConvertBuilder', async () => {
  for (let i = 0; i < 20; i++) { const phone = `+359885000${String(i).padStart(3, '0')}`; await order({ phone, daysAgo: 250 }); await order({ phone, daysAgo: 220 }); }
  let m = await shopMetrics(q, SHOP, DAY);
  assert.equal(m.secondOrderDays, 30);
  assert.equal(m.profileSuggested, 'often');
  assert.equal(m.history.days, 249, 'whole days since the first order (noon 250 days ago)');
  assert.equal(m.history.cb, false);
  q = await makeTestQuery();
  await order({ daysAgo: 10 });
  m = await shopMetrics(q, SHOP, DAY);
  assert.equal(m.profileSuggested, '', 'too little history to suggest');
});

/* ---- stage 3 ---- */
test('the basket: average now and before, units, one-product orders; the free-shipping threshold from the shop’s own orders', async () => {
  for (let i = 0; i < 6; i++) await order({ daysAgo: 3, total: 60, items: [{ name: 'Крем', qty: 2, price: 60 }] }); // free shipping (total = items)
  for (let i = 0; i < 6; i++) await order({ daysAgo: 4, total: 40, items: [{ name: 'Крем', qty: 1, price: 35 }] }); // paid shipping
  for (let i = 0; i < 30; i++) await order({ daysAgo: 60, total: 50 });
  const m = await shopMetrics(q, SHOP, DAY);
  assert.equal(m.basket.n, 12);
  assert.equal(m.basket.aov, 50);
  assert.equal(m.basket.single, 0.5);
  assert.equal(m.basket.units, 1.5);
  assert.equal(m.basket.baseAov, Math.round(((30 * 50) / 30) * 100) / 100);
  assert.equal(m.freeShipping.threshold, 60);
  assert.equal(m.freeShipping.share, 0.5);
});

test('channel of orders (60 days); the funnel of 14–44 days ago with the euros lost', async () => {
  for (let i = 0; i < 70; i++) { const id = await order({ daysAgo: 20 }); await q(`update zd.orders set traffic_source = $2 where id = $1::uuid`, [id, i < 63 ? 'facebook' : 'google']); }
  const c = await shopMetrics(q, SHOP, DAY);
  assert.deepEqual(c.channel, { source: 'facebook', share: 0.9, n: 70 });
  q = await makeTestQuery();
  await order({ daysAgo: 20, status: 'delivered', shippedDaysAgo: 19 });
  await order({ daysAgo: 20, status: 'returned', shippedDaysAgo: 19 });
  await order({ daysAgo: 20, status: 'cancelled' });
  await order({ daysAgo: 5, status: 'delivered' }); // too fresh for the funnel
  const f = (await shopMetrics(q, SHOP, DAY)).funnel;
  assert.equal(f.from, '2026-09-27');
  assert.equal(f.to, '2026-10-26');
  assert.equal(f.orders, 3);
  assert.equal(f.dropped, 1);
  assert.equal(f.shipped, 2);
  assert.equal(f.delivered, 1);
  assert.equal(f.returned, 1);
  assert.equal(f.returnedEur, 40);
  assert.equal(f.returnCostEur, 5);
  assert.equal(f.visits, null, 'no visit tracking: no visits step');
});

test('a connected courier is told apart from none (the advisor words its advice by it)', async () => {
  let m = await shopMetrics(q, SHOP, DAY);
  assert.equal(m.couriers.connected, false);
  await saveIntegration(q, 'econt', { config: { active: true }, secret: 'x', shopId: SHOP });
  m = await shopMetrics(q, SHOP, DAY);
  assert.equal(m.couriers.connected, true);
});
