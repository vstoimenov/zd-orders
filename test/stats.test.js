import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeReq, fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { insertOrder, updateStatus, saveNekorekten } from '../lib/orders-repo.js';
import { getStats } from '../lib/stats.js';
import { signSession } from '../lib/auth.js';
import statsApi from '../lib/admin/stats.js';

let q;
beforeEach(async () => { q = await makeTestQuery(); setQueryForTests(q); });

const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Sofia' });
let n = 0;
async function add(patch = {}, status = 'new') {
  n++;
  const r = await insertOrder(q, {
    cbOrderId: `live.bg:${n}`, name: `Клиент ${n}`, phone: '0888', phoneNorm: `+35988800${String(n).padStart(4, '0')}`, email: '',
    deliveryType: 'econt_office', courier: 'econt', officeId: '', officeText: 'ЕКОНТ – офис X (1)', city: 'X', postCode: '', addressText: '',
    items: [{ name: 'Книга', qty: 1, price: 18.5 }], total: 22.57, currency: 'EUR', paymentMethod: 'cod', pageUrl: '', ip: String(n), userAgent: '', ...patch,
  });
  if (status !== 'new') await updateStatus(q, r.id, status);
  return r;
}

test('getStats sums revenue per currency without cancelled orders and computes AOV', async () => {
  await add();
  await add({ total: 41.07, items: [{ name: 'Книга', qty: 2, price: 37 }] }, 'delivered');
  await add({ total: 10 }, 'cancelled');
  await add({ cbOrderId: 'test.com:1', currency: 'USD', total: 16.45, items: [{ name: 'Book', qty: 1, price: 12.9 }] });
  const s = await getStats(q, { from: today(), to: today() });
  assert.equal(s.cards.orders, 4);
  assert.deepEqual(s.cards.revenue, [{ currency: 'EUR', amount: 63.64 }, { currency: 'USD', amount: 16.45 }]);
  assert.deepEqual(s.cards.delivered, [{ currency: 'EUR', amount: 41.07 }]);
  assert.deepEqual(s.cards.aov, [{ currency: 'EUR', amount: 31.82 }, { currency: 'USD', amount: 16.45 }]);
  assert.deepEqual(s.stores, ['live.bg', 'test.com']);
});

test('getStats filters by store and period', async () => {
  await add();
  await add({ cbOrderId: 'test.com:1', currency: 'USD', total: 16.45 });
  const s = await getStats(q, { from: today(), to: today(), store: 'test.com' });
  assert.equal(s.cards.orders, 1);
  assert.deepEqual(s.cards.revenue, [{ currency: 'USD', amount: 16.45 }]);
  const empty = await getStats(q, { from: '2000-01-01', to: '2000-01-02' });
  assert.equal(empty.cards.orders, 0);
  assert.deepEqual(empty.cards.revenue, []);
  assert.equal(empty.cards.returnRate, null);
  assert.equal(empty.cards.nkFlaggedPct, null);
});

test('getStats computes return rate, nekorekten share and breakdowns', async () => {
  await add({}, 'shipped');
  await add({}, 'delivered');
  await add({ deliveryType: 'speedy_office', courier: 'speedy' }, 'returned');
  const flagged = await add({ deliveryType: 'speedy_address', courier: 'speedy' });
  await saveNekorekten(q, flagged.id, { status: 'flagged', count: 1, reportIds: ['9'] });
  const s = await getStats(q, { from: today(), to: today() });
  assert.equal(s.cards.returnRate, 1 / 3);
  assert.equal(s.cards.nkFlagged, 1);
  assert.equal(s.cards.nkFlaggedPct, 0.25);
  const byDelivery = Object.fromEntries(s.byDelivery.map((d) => [d.deliveryType, d.orders]));
  assert.deepEqual(byDelivery, { econt_office: 2, speedy_office: 1, speedy_address: 1 });
  const byStatus = Object.fromEntries(s.byStatus.map((d) => [d.status, d.orders]));
  assert.deepEqual(byStatus, { shipped: 1, delivered: 1, returned: 1, new: 1 });
  assert.equal(s.daily.length, 1);
  assert.equal(s.daily[0].day, today());
  assert.equal(s.daily[0].orders, 4);
});

test('getStats ranks top products from order items and lists recent orders', async () => {
  await add({ items: [{ name: 'Книга', qty: 1, price: 18.5 }, { name: 'Аудио', qty: 1, price: 3 }] });
  await add({ items: [{ name: 'Книга', qty: 2, price: 37 }] });
  await add({ items: [{ name: 'Гривна', qty: 1, price: 6.65 }] }, 'cancelled');
  const s = await getStats(q, { from: today(), to: today() });
  assert.deepEqual(s.topProducts, [{ name: 'Книга', qty: 3, revenue: 55.5 }, { name: 'Аудио', qty: 1, revenue: 3 }]);
  assert.equal(s.recent.length, 3);
  assert.ok(s.recent[0].createdAt >= s.recent[2].createdAt);
});

test('GET /api/admin/stats needs the admin cookie and defaults to the last 7 days', async () => {
  process.env.ADMIN_SECRET = 'secret';
  await add();
  let res = fakeRes(); await statsApi(fakeReq({ url: '/api/admin/stats' }), res);
  assert.equal(res.statusCode, 401);
  res = fakeRes();
  await statsApi(fakeReq({ url: '/api/admin/stats', headers: { cookie: `zdo_admin=${signSession('secret')}` } }), res);
  const body = json(res);
  assert.equal(body.period.to, today());
  assert.equal(body.cards.orders, 1);
  assert.equal(body.profit.currency, 'EUR');
  assert.equal(body.profit.itemsRevenue, 18.5);
});

test('GET /api/admin/stats rejects impossible dates instead of failing', async () => {
  process.env.ADMIN_SECRET = 'secret';
  const res = fakeRes();
  await statsApi(fakeReq({ url: '/api/admin/stats?from=2026-13-45&to=2026-10-05', headers: { cookie: `zdo_admin=${signSession('secret')}` } }), res);
  assert.equal(res.statusCode, 200);
  assert.notEqual(json(res).period.from, '2026-13-45');
});
