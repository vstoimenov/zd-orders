import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeReq, fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { insertOrder, updateStatus } from '../lib/orders-repo.js';
import { getCosts, saveCosts, addExpense, deleteExpense, getProfit, getProfitAll } from '../lib/costs.js';
import { signSession } from '../lib/auth.js';
import costsApi from '../lib/admin/costs.js';
import { saveIntegration } from '../lib/integrations-repo.js';

let q;
beforeEach(async () => { q = await makeTestQuery(); setQueryForTests(q); process.env.ADMIN_SECRET = 'secret'; process.env.INTEGRATIONS_SECRET = 'test-secret'; });
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
  await saveCosts(q, { products: [{ name: 'Книга', unitCost: 4.2 }], settings: { packaging: 0.5, codFeePct: 1.5, freeShippingEcont: 3.55, freeShippingSpeedy: 2.48, freeShippingBoxnow: 3.1, returnCost: 7 } });
  const c = await getCosts(q);
  assert.deepEqual(c.products, [{ name: 'Книга', unitCost: 4.2, soldQty: 3 }, { name: 'Бонус', unitCost: 0, soldQty: 1 }]);
  assert.deepEqual(c.settings, {
    packaging: 0.5, codFeePct: 1.5, freeShippingEcont: 3.55, freeShippingSpeedy: 2.48, freeShippingBoxnow: 3.1, returnCost: 7,
    vatRegistered: 0, vatRate: 20, costsWithVat: 1, profitTaxPct: 10, // tax defaults until the shop sets them
  });
});

test('saveCosts rejects negative or non-numeric values', async () => {
  await assert.rejects(saveCosts(q, { products: [{ name: 'Книга', unitCost: -1 }], settings: {} }), /invalid/);
  await assert.rejects(saveCosts(q, { products: [], settings: { packaging: 'abc' } }), /invalid/);
  await assert.rejects(saveCosts(q, { products: [], settings: { vatRate: 120 } }), /invalid/);
  await assert.rejects(saveCosts(q, { products: [], settings: { profitTaxPct: -1 } }), /invalid/);
  await assert.rejects(saveCosts(q, { products: [], settings: { vatRegistered: 2 } }), /invalid/);
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
    expenses: 10, otherCosts: 21.83, adSpend: 0, profitBeforeAds: 4.87, profit: 4.87, margin: 0.1258,
    // not registered for VAT: no VAT figures, 10% profit tax on the whole profit
    vatRegistered: false, profitTaxPct: 10, vatOnSales: 0, vatOnCosts: 0, vatDue: 0, adVat: 0, netRevenue: 38.7,
    accountingProfit: 4.87, profitTax: 0.49, netProfit: 4.38, yearRevenue: 42.25, vatThreshold: 51130,
  });
});

/** the fixture of the profit test: 38.70 items, 33.83 costs with VAT, profit 4.87 */
async function profitFixture(settings) {
  await saveCosts(q, { products: [{ name: 'Книга', unitCost: 4 }], settings: { packaging: 0.5, codFeePct: 2, freeShippingEcont: 3.55, freeShippingSpeedy: 2.48, returnCost: 7, ...settings } });
  await add();
  await add({ items: [{ name: 'Книга', qty: 2, price: 25.8 }], total: 25.8, courier: 'speedy' });
  await add({}, 'returned');
  await addExpense(q, { spentOn: today(), name: 'Реклама извън Meta', amount: 10 });
  return getProfit(q, { from: today(), to: today() });
}
const taxes = (p) => ({ vatOnSales: p.vatOnSales, vatOnCosts: p.vatOnCosts, vatDue: p.vatDue, netRevenue: p.netRevenue, accountingProfit: p.accountingProfit, profitTax: p.profitTax, netProfit: p.netProfit });
/** 10 € of Meta spend today on the connected account */
async function adSpend10() {
  await saveIntegration(q, 'meta', { config: { accountId: '123' }, secret: 'T' });
  await q(`insert into zd.ad_spend (platform, account_id, day, spend, currency) values ('meta', '123', $1::date, 10, 'EUR')`, [today()]);
}

test('a VAT-registered shop sees the VAT in sales and in costs, the accounting profit and the profit tax', async () => {
  const p = await profitFixture({ vatRegistered: 1, vatRate: 20, costsWithVat: 1, profitTaxPct: 10 });
  assert.equal(p.vatRegistered, true);
  assert.equal(p.profit, 4.87); // the gross profit is unchanged
  // deductible VAT in 23.83 of products, packaging, COD fee, shipping and returns — not in the 10 € one-off expense
  assert.deepEqual(taxes(p), { vatOnSales: 6.45, vatOnCosts: 3.97, vatDue: 2.48, netRevenue: 32.25, accountingProfit: 2.39, profitTax: 0.24, netProfit: 2.15 });
});

test('ad spend is reverse-charged: VAT-neutral when registered, 20% extra cost when not', async () => {
  await adSpend10();
  const reg = await profitFixture({ vatRegistered: 1 });
  assert.equal(reg.adSpend, 10);
  assert.equal(reg.adVat, 0);
  assert.equal(reg.accountingProfit, -7.61); // 4.87 − 10 ads − 2.48 VAT due
  await saveCosts(q, { products: [], settings: { vatRegistered: 0 } });
  const not = await getProfit(q, { from: today(), to: today() });
  assert.equal(not.adVat, 2);
  assert.equal(not.profit, -5.13); // gross figures unchanged
  assert.equal(not.accountingProfit, -7.13); // self-charged VAT on the ads is a real cost
  assert.equal(not.netProfit, -7.13);
});

test('costs without deductible VAT: the whole VAT in sales is due', async () => {
  const p = await profitFixture({ vatRegistered: 1, vatRate: 20, costsWithVat: 0 });
  assert.deepEqual(taxes(p), { vatOnSales: 6.45, vatOnCosts: 0, vatDue: 6.45, netRevenue: 32.25, accountingProfit: -1.58, profitTax: 0, netProfit: -1.58 });
});

test('a VAT rate of 0 and a loss period give zeros, never NaN or a negative tax', async () => {
  const p = await profitFixture({ vatRegistered: 1, vatRate: 0, profitTaxPct: 15 });
  assert.deepEqual(taxes(p), { vatOnSales: 0, vatOnCosts: 0, vatDue: 0, netRevenue: 38.7, accountingProfit: 4.87, profitTax: 0.73, netProfit: 4.14 });
  await saveCosts(q, { products: [{ name: 'Книга', unitCost: 100 }] });
  const loss = await getProfit(q, { from: today(), to: today() });
  assert.ok(loss.accountingProfit < 0);
  assert.equal(loss.profitTax, 0);
  assert.equal(loss.netProfit, loss.accountingProfit);
});

test('yearRevenue counts this calendar year of the shop only, whatever the period', async () => {
  await add({ total: 20 });
  await add({ total: 5 }, 'cancelled');
  await add({ total: 7 }, 'returned');
  await add({ total: 9, currency: 'USD', cbOrderId: 'test:usd' });
  const old = await add({ total: 100 });
  await q(`update zd.orders set created_at = created_at - interval '1 year' where id = $1::uuid`, [old.id]);
  const p = await getProfit(q, { from: '2020-01-01', to: '2020-01-02' });
  assert.equal(p.yearRevenue, 20);
  assert.equal(p.itemsRevenue, 0);
});

test('"all shops" sums the tax figures and has no VAT registration of its own', async () => {
  await profitFixture({ vatRegistered: 1 });
  const all = await getProfitAll(q, { from: today(), to: today() });
  assert.equal(all.vatRegistered, null);
  assert.equal(all.netProfit, 2.15);
  assert.equal(all.vatDue, 2.48);
  assert.equal(all.yearRevenue, 42.25);
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

test('a free-shipping BOX NOW order costs the shop its BOX NOW price', async () => {
  await saveCosts(q, { products: [], settings: { freeShippingBoxnow: 3.1 } });
  await add({ total: 12.9, courier: 'boxnow', deliveryType: 'boxnow_locker', officeId: 'boxnow:1840', officeText: 'BOX NOW – автомат (1840)' });
  assert.equal((await getProfit(q, { from: today(), to: today() })).freeShipping, 3.1);
});
