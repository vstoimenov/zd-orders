// Пътят на растежа through the API: the extra numbers from the database, the owner's answers, „Започвам“ and the end.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { insertOrder, updateStatus } from '../lib/orders-repo.js';
import { signSession } from '../lib/auth.js';
import { pathExtras, getPath, answerPath, startPath, endPath } from '../lib/advisor/path-repo.js';
import router from '../api/admin/[route].js';

process.env.ADMIN_SECRET = 'secret';
process.env.INTEGRATIONS_SECRET = 'test-secret';
const SHOP = '00000000-0000-4000-8000-000000000001';
const owner = `zdo_admin=${signSession('secret')}`;
const DAY = '2026-11-10';
const ago = (n) => new Date(Date.parse(`${DAY}T12:00:00Z`) - n * 864e5).toISOString();
let q, n = 0;
beforeEach(async () => { q = await makeTestQuery(); setQueryForTests(q); n = 0; });

async function order({ daysAgo = 1, phone = null, price = 35, name = 'Крем' } = {}) {
  const p = phone || `+3598881${String(++n).padStart(5, '0')}`;
  const r = await insertOrder(q, {
    cbOrderId: `s.bg:${++n}`, name: 'Мария', phone: p, phoneNorm: p, email: '', deliveryType: 'econt_office', courier: 'econt', officeId: '', officeText: 'ЕКОНТ',
    city: 'Плевен', postCode: '', addressText: '', items: [{ name, qty: 1, price }], total: price + 5, currency: 'EUR', paymentMethod: 'cod', pageUrl: '', ip: '1', shopId: SHOP,
  });
  await updateStatus(q, r.id, 'delivered');
  await q(`update zd.orders set created_at = $2::timestamptz where id = $1::uuid`, [r.id, ago(daysAgo)]);
}
const call = async (method, url, body) => {
  const res = fakeRes();
  await router({ method, url, headers: { cookie: owner }, body: body === undefined ? undefined : JSON.stringify(body), socket: {} }, res);
  return res;
};

test('the extra numbers: lifetime orders, buys a year, retention 90 days, a price raised, idle stock', async () => {
  // 40 buyers a year ago at 30 € who came back within 90 days; today the same product at 35 €
  for (let i = 0; i < 40; i++) { const ph = `+35989900${String(i).padStart(3, '0')}`; await order({ daysAgo: 150, phone: ph, price: 30 }); await order({ daysAgo: 120, phone: ph, price: 30 }); }
  for (let i = 0; i < 10; i++) await order({ daysAgo: 380, price: 30 });
  for (let i = 0; i < 12; i++) await order({ daysAgo: 5, price: 35 });
  await q(`insert into zd.product_costs (shop_id, name, stock, unit_cost) values ($1, 'Шал', 20, 15), ($1, 'Крем', 5, 10)`, [SHOP]);
  const x = await pathExtras(q, SHOP, DAY);
  assert.equal(x.ordersTotal, 102);
  assert.equal(x.retention90, 1);
  assert.equal(x.blockedValue, 300, 'only the scarf did not sell for 60 days');
  assert.equal(x.blockedItems, 1);
  assert.equal(x.completion, null, 'no checkouts recorded');
});

test('answers, „Започвам“ with a measured goal, and the end starts the walk again', async () => {
  for (let i = 0; i < 25; i++) await order({ daysAgo: 1 + i });
  let p = await getPath(q, SHOP, DAY);
  assert.equal(p.ask.key, 'kind');
  assert.equal(p.steps[0].by, 'data');
  p = await answerPath(q, SHOP, { key: 'kind', value: 'consumable' }, DAY);
  assert.equal(p.ask.key, 'capacity');
  await assert.rejects(answerPath(q, SHOP, { key: 'capacity', value: 'maybe' }, DAY), /Невалиден/);
  p = await answerPath(q, SHOP, { key: 'capacity', value: 'no' }, DAY);
  p = await answerPath(q, SHOP, { key: 'standard', value: 'no' }, DAY);
  assert.equal(p.op.key, 'hands');
  assert.equal(p.op.moves.length, 3);
  p = await startPath(q, SHOP, DAY);
  assert.equal(p.active.key, 'hands');
  assert.equal(p.active.until, '2027-01-09');
  assert.equal(p.active.measured, false);
  p = await endPath(q, SHOP, { met: true }, DAY);
  assert.equal(p.active, null);
  assert.equal(p.done[0].name, 'Свободни ръце');
  assert.equal(p.ask.key, 'kind', 'answers are asked again');
});

test('the API: GET ?path=1 and the answer actions, for the chosen shop', async () => {
  for (let i = 0; i < 5; i++) await order({ daysAgo: 1 + i });
  let res = await call('GET', `/api/admin/advisor?shop=${SHOP}&path=1`);
  assert.equal(res.statusCode, 200);
  assert.equal(json(res).op.key, 'first20');
  res = await call('POST', `/api/admin/advisor?shop=${SHOP}`, { action: 'path_start' });
  assert.equal(json(res).active.key, 'first20');
  assert.equal(json(res).active.start, 5);
  assert.equal(json(res).active.goal, 20);
  res = await call('POST', `/api/admin/advisor?shop=${SHOP}`, { action: 'path_answer', key: 'nope', value: 'x' });
  assert.equal(res.statusCode, 400);
});
