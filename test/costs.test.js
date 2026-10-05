import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeReq, fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { insertOrder, updateStatus } from '../lib/orders-repo.js';
import { getCosts, saveCosts, addExpense, deleteExpense, getProfit } from '../lib/costs.js';
import { signSession } from '../lib/auth.js';
import costsApi from '../api/admin/costs.js';

let q;
beforeEach(async () => { q = await makeTestQuery(); setQueryForTests(q); process.env.ADMIN_SECRET = 'secret'; });
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Sofia' });
const cookie = () => `zdo_admin=${signSession('secret')}`;
let n = 0;
async function add(patch = {}, status = 'new') {
  n++;
  const r = await insertOrder(q, {
    cbOrderId: `s:${n}`, name: 'К', phone: '0888', phoneNorm: `+3598880${String(n).padStart(5, '0')}`, email: '', deliveryType: 'econt_office',
    courier: 'econt', officeId: '', officeText: 'x', city: 'x', postCode: '', addressText: '',
    items: [{ name: 'Книга', qty: 1, price: 12.9 }, { name: 'Бонус', qty: 1, price: 0 }], total: 16.45, currency: 'EUR',
    paymentMethod: 'cod', pageUrl: '', ip: String(n), userAgent: '', ...patch,
  });
  if (status !== 'new') await updateStatus(q, r.id, status);
  return r;
}

test('getCosts lists every sold product with its saved unit cost', async () => {
  await add();
  await add({ items: [{ name: 'Книга', qty: 2, price: 25.8 }] });
  await saveCosts(q, { products: [{ name: 'Книга', unitCost: 4.2 }], settings: { packaging: 0.5, codFeePct: 1.5, freeShippingEcont: 3.55, freeShippingSpeedy: 2.48, returnCost: 7 } });
  const c = await getCosts(q);
  assert.deepEqual(c.products, [{ name: 'Книга', unitCost: 4.2, soldQty: 3 }, { name: 'Бонус', unitCost: 0, soldQty: 1 }]);
  assert.deepEqual(c.settings, { packaging: 0.5, codFeePct: 1.5, freeShippingEcont: 3.55, freeShippingSpeedy: 2.48, returnCost: 7 });
});

test('saveCosts rejects negative or non-numeric values', async () => {
  await assert.rejects(saveCosts(q, { products: [{ name: 'Книга', unitCost: -1 }], settings: {} }), /invalid/);
  await assert.rejects(saveCosts(q, { products: [], settings: { packaging: 'abc' } }), /invalid/);
});

test('expenses are added, listed newest first and deleted', async () => {
  const a = await addExpense(q, { spentOn: '2026-10-01', name: 'ConvertBuilder', amount: 49 });
  await addExpense(q, { spentOn: '2026-10-03', name: 'Дизайн', amount: 20 });
  assert.deepEqual((await getCosts(q)).expenses.map((e) => e.name), ['Дизайн', 'ConvertBuilder']);
  assert.equal(await deleteExpense(q, a.id), true);
  assert.equal((await getCosts(q)).expenses.length, 1);
  await assert.rejects(addExpense(q, { spentOn: 'вчера', name: 'x', amount: 1 }), /invalid/);
});

test('getProfit applies product costs, packaging, COD fee, free shipping, returns and expenses', async () => {
  await saveCosts(q, { products: [{ name: 'Книга', unitCost: 4 }], settings: { packaging: 0.5, codFeePct: 2, freeShippingEcont: 3.55, freeShippingSpeedy: 2.48, returnCost: 7 } });
  await add();                                                                                  // customer pays shipping: 12.90 items, 16.45 total
  await add({ items: [{ name: 'Книга', qty: 2, price: 25.8 }], total: 25.8, courier: 'speedy' });  // free shipping (total = items) → shop pays Speedy 2.48
  await add({}, 'returned');                                                                    // return: −7, packaging only
  await add({}, 'cancelled');                                                                   // ignored
  await add({ currency: 'USD', cbOrderId: 'test:1' });                                          // other currency → ignored
  await addExpense(q, { spentOn: today(), name: 'Реклама извън Meta', amount: 10 });
  const p = await getProfit(q, { from: today(), to: today() });
  assert.deepEqual(p, {
    currency: 'EUR', itemsRevenue: 38.7, productCost: 12, packaging: 1.5, codFee: 0.85, freeShipping: 2.48, returns: 7,
    expenses: 10, otherCosts: 21.83, profit: 4.87, margin: 0.1258,
  });
});

test('the costs API needs the admin cookie and round-trip', async () => {
  let res = fakeRes(); await costsApi(fakeReq({ url: '/api/admin/costs' }), res);
  assert.equal(res.statusCode, 401);
  res = fakeRes();
  await costsApi(fakeReq({ method: 'PUT', headers: { cookie: cookie() }, body: JSON.stringify({ products: [{ name: 'Книга', unitCost: 4 }], settings: { packaging: 1 } }) }), res);
  assert.deepEqual(json(res), { ok: true });
  res = fakeRes(); await costsApi(fakeReq({ url: '/api/admin/costs', headers: { cookie: cookie() } }), res);
  assert.equal(json(res).settings.packaging, 1);
  res = fakeRes();
  await costsApi(fakeReq({ method: 'POST', headers: { cookie: cookie() }, body: JSON.stringify({ spentOn: today(), name: 'Хостинг', amount: 5 }) }), res);
  const { id } = json(res);
  res = fakeRes(); await costsApi(fakeReq({ method: 'DELETE', headers: { cookie: cookie() }, body: JSON.stringify({ id }) }), res);
  assert.deepEqual(json(res), { ok: true });
  res = fakeRes(); await costsApi(fakeReq({ method: 'PUT', headers: { cookie: cookie() }, body: JSON.stringify({ products: [{ name: 'Книга', unitCost: -5 }] }) }), res);
  assert.equal(res.statusCode, 400);
});
