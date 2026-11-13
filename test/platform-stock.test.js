import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { insertOrder, updateStatus } from '../lib/orders-repo.js';
import { syncOrderStock, saveProduct, adjustStock, listInventory, productHistory, syncPlatformStock, deleteOrderRestoringStock } from '../lib/stock.js';
import { mapProductStock } from '../lib/convertbuilder.js';

const SHOP = '00000000-0000-4000-8000-000000000001';
let q;
beforeEach(async () => { q = await makeTestQuery(); });
const prod = async (name) => (await q(`select * from zd.product_costs where name = $1`, [name]))[0];
let n = 0;
const order = (items) => insertOrder(q, {
  cbOrderId: `adhdbg.eu:p${++n}`, name: 'К', phone: '', phoneNorm: '', email: '', deliveryType: 'econt_office', courier: 'econt',
  officeId: 'econt:1', officeText: 'ЕКОНТ', city: 'Х', postCode: '1000', addressText: '', items, total: 20, currency: 'EUR',
  paymentMethod: 'cod', pageUrl: '', ip: String(n), userAgent: '',
});

test('the platform number is written as it is: by SKU first, else by name (any case); the difference is logged', async () => {
  await saveProduct(q, { name: 'Тениска M', sku: 'T-M', stock: 10 }, { create: true });
  await saveProduct(q, { name: 'Книга', stock: 4 }, { create: true });
  const r = await syncPlatformStock(q, { shopId: SHOP, source: 'woocommerce', items: [
    { sku: 't-m', name: 'Друго име', stock: 7 }, { name: 'КНИГА', stock: '4' },
  ] });
  assert.deepEqual({ updated: r.updated, unchanged: r.unchanged, created: r.created }, { updated: 2, unchanged: 0, created: 0 });
  assert.equal((await prod('Тениска M')).stock, 7);
  assert.equal((await prod('Тениска M')).stock_source, 'woocommerce');
  assert.equal((await prod('Книга')).stock, 4);
  const moves = await productHistory(q, 'Тениска M', { shopId: SHOP });
  assert.equal(moves[0].qty, -3);
  assert.equal(moves[0].reason, 'sync');
  assert.match(moves[0].note, /WooCommerce/);
  assert.equal((await productHistory(q, 'Книга', { shopId: SHOP })).filter((m) => m.reason === 'sync').length, 0, 'no move when the number is the same');
});

test('a product the platform has and Ordyx does not is added; an untracked one starts being tracked', async () => {
  await saveProduct(q, { name: 'Чаша' }, { create: true });
  const r = await syncPlatformStock(q, { shopId: SHOP, source: 'api', items: [{ name: 'Чаша', stock: 3 }, { name: 'Лампа', sku: 'L1', stock: 12 }] });
  assert.equal(r.created, 1);
  assert.equal((await prod('Чаша')).stock, 3);
  assert.ok((await prod('Чаша')).tracked_since);
  const l = await prod('Лампа');
  assert.equal(l.stock, 12); assert.equal(l.sku, 'L1'); assert.equal(l.stock_source, 'api');
  const inv = await listInventory(q, { shopId: SHOP });
  const lamp = inv.products.find((p) => p.name === 'Лампа');
  assert.equal(lamp.stockSource, 'api');
  assert.ok(lamp.stockSyncedAt);
});

test('with create: false an unknown product is only counted; digital products and items without a whole number are skipped', async () => {
  await saveProduct(q, { name: 'Бонус', stock: 0 }, { create: true });
  await q(`update zd.product_costs set digital = true where name = 'Бонус'`);
  const r = await syncPlatformStock(q, { shopId: SHOP, source: 'convertbuilder', create: false, items: [
    { name: 'Непознат', stock: 3 }, { name: 'Бонус', stock: 99 }, { name: 'Без бройка', stock: null }, { name: 'Дроб', stock: 1.5 }, { stock: 4 },
  ] });
  assert.deepEqual({ created: r.created, unknown: r.unknown, skipped: r.skipped, updated: r.updated }, { created: 0, unknown: 1, skipped: 4, updated: 0 });
  assert.equal(await prod('Непознат'), undefined);
  assert.equal((await prod('Бонус')).stock, 0);
});

test('orders do not take from stock that comes from the platform (it already took them); deleting gives nothing back', async () => {
  await saveProduct(q, { name: 'Книга', stock: 10 }, { create: true });
  await syncPlatformStock(q, { shopId: SHOP, source: 'woocommerce', items: [{ name: 'Книга', stock: 9 }] });
  const o = await order([{ name: 'Книга', qty: 2, price: 10 }]);
  await syncOrderStock(q, o.id);
  assert.equal((await prod('Книга')).stock, 9);
  await updateStatus(q, o.id, 'cancelled'); await syncOrderStock(q, o.id);
  assert.equal((await prod('Книга')).stock, 9);
  await deleteOrderRestoringStock(q, o.id);
  assert.equal((await prod('Книга')).stock, 9);
});

test('an order that took stock before the sync: deleting it later does not add to the platform number', async () => {
  await saveProduct(q, { name: 'Книга', stock: 10 }, { create: true });
  const o = await order([{ name: 'Книга', qty: 2, price: 10 }]);
  await syncOrderStock(q, o.id);
  await syncPlatformStock(q, { shopId: SHOP, source: 'woocommerce', items: [{ name: 'Книга', stock: 5 }] });
  await deleteOrderRestoringStock(q, o.id);
  assert.equal((await prod('Книга')).stock, 5);
});

test('emptying the stock field stops tracking and the platform link; a manual correction still works', async () => {
  await syncPlatformStock(q, { shopId: SHOP, source: 'woocommerce', items: [{ name: 'Книга', stock: 5 }] });
  await adjustStock(q, { name: 'Книга', delta: 2, reason: 'Доставка', shopId: SHOP });
  assert.equal((await prod('Книга')).stock, 7);
  await saveProduct(q, { name: 'Книга', stock: '', stockWas: 7 }, { shopId: SHOP });
  const p = await prod('Книга');
  assert.equal(p.stock, null); assert.equal(p.stock_source, null);
});

test('too many items in one call are refused; other shops are not touched', async () => {
  await assert.rejects(syncPlatformStock(q, { shopId: SHOP, source: 'api', items: Array.from({ length: 2001 }, (_, i) => ({ name: `P${i}`, stock: 1 })) }), /2000/);
  await assert.rejects(syncPlatformStock(q, { shopId: SHOP, source: 'api', items: 'x' }), /items/);
  const B = '00000000-0000-4000-8000-0000000000b2';
  await q(`insert into zd.shops (id, name, domain, approved) values ($1, 'Б', 'b.bg', true)`, [B]);
  await saveProduct(q, { name: 'Книга', stock: 1 }, { create: true, shopId: B });
  await syncPlatformStock(q, { shopId: SHOP, source: 'api', items: [{ name: 'Книга', stock: 8 }] });
  assert.equal(Number((await q(`select stock from zd.product_costs where shop_id = $1 and name = 'Книга'`, [B]))[0].stock), 1);
});

test('ConvertBuilder products: simple and variant stock read from the usual field names; untracked ones left out', () => {
  const items = mapProductStock([
    { name: 'Книга', sku: 'B1', stock: 5 },
    { title: 'Чаша', quantity: '3' },
    { name: 'Без следене', inventory: null, trackInventory: false },
    { name: 'Без следене 2', stock: 9, trackInventory: false },
    { name: 'Тениска', variants: [{ name: 'M', sku: 'T-M', inventoryQuantity: 2 }, { options: ['L', 'черна'], quantity: 0 }] },
    { name: 'Склад', inventory: { quantity: 7 } },
  ]);
  assert.deepEqual(items, [
    { name: 'Книга', sku: 'B1', stock: 5, variant: false },
    { name: 'Чаша', sku: '', stock: 3, variant: false },
    { name: 'Тениска - M', sku: 'T-M', stock: 2, variant: true },
    { name: 'Тениска - L, черна', sku: '', stock: 0, variant: true },
    { name: 'Склад', sku: '', stock: 7, variant: false },
  ]);
});

test('a site sends its stock with its key: written for its own shop; a bad list is refused', async () => {
  const { setQueryForTests } = await import('../lib/db.js');
  const { makeShopKey, resetKeyLimitsForTests } = await import('../lib/shop-keys.js');
  const { fakeReq, fakeRes, json } = await import('./helpers/http.js');
  const orders = (await import('../api/orders.js')).default;
  process.env.INTEGRATIONS_SECRET = 'test-secret';
  setQueryForTests(q); resetKeyLimitsForTests();
  await q(`update zd.shops set domain = 'a-shop.bg' where id = $1`, [SHOP]);
  const { key } = await makeShopKey(q, SHOP);
  const call = async (body) => {
    const res = fakeRes();
    await orders(fakeReq({ method: 'POST', url: '/api/orders', headers: { authorization: `Bearer ${key}` }, body: JSON.stringify(body) }), res);
    return res;
  };
  const ok = await call({ type: 'stock', source: 'woocommerce', items: [{ name: 'Тениска — M, черна', sku: 'T-M-B', stock: 6 }] });
  assert.equal(ok.statusCode, 200);
  assert.equal(json(ok).created, 1);
  const p = await prod('Тениска — M, черна');
  assert.equal(p.stock, 6); assert.equal(p.stock_source, 'woocommerce');
  assert.equal((await call({ type: 'stock', items: 'x' })).statusCode, 400);
  const many = await call({ type: 'stock', items: Array.from({ length: 2001 }, (_, i) => ({ name: `P${i}`, stock: 1 })) });
  assert.equal(many.statusCode, 400);
  assert.match(json(many).error, /2000/);
});

test('ConvertBuilder: stock pulled from its products; a site without a products list says so', async () => {
  const { saveIntegration } = await import('../lib/integrations-repo.js');
  const { pullCbStock, pullCbStockSoon } = await import('../lib/cb-sync.js');
  process.env.INTEGRATIONS_SECRET = 'test-secret';
  await saveIntegration(q, 'convertbuilder', { config: { domain: 'adhdbg.eu', store: 'adhdbg.eu' }, secret: 'k', shopId: SHOP });
  await saveProduct(q, { name: 'Тениска - M', stock: 1 }, { create: true });
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return new Response(JSON.stringify({ items: [{ name: 'Книга', stock: 4 }, { name: 'Тениска', variants: [{ name: 'M', stock: 3 }, { name: 'XL', stock: 9 }] }], totalCount: 2 }), { status: 200 });
  };
  const r = await pullCbStock(q, SHOP, { fetchImpl });
  assert.equal(r.available, true);
  assert.match(calls[0], /^https:\/\/adhdbg\.eu\/api\/site\/products\?limit=50&skip=0$/);
  assert.equal((await prod('Книга')).stock, 4);
  assert.equal((await prod('Тениска - M')).stock, 3);
  assert.equal(await prod('Тениска - XL'), undefined, 'a variant Ordyx does not know is not added');
  assert.equal(r.unknown, 1);
  const none = await pullCbStock(q, SHOP, { fetchImpl: async () => new Response('{"message":"Not found"}', { status: 404 }) });
  assert.deepEqual(none, { available: false });
  const cfg = (await q(`select config from zd.integrations where provider = 'convertbuilder'`))[0].config;
  assert.equal((typeof cfg === 'string' ? JSON.parse(cfg) : cfg).stockApi, false);
  await pullCbStockSoon(q, SHOP); // stockApi false: nothing asked, nothing thrown
});
