import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeReq, fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { signSession } from '../lib/auth.js';
import { createShop, DEFAULT_SHOP } from '../lib/shops.js';
import { saveIntegration } from '../lib/integrations-repo.js';
import { saveProduct, listInventory } from '../lib/stock.js';
import router from '../api/admin/[route].js';
import ordersApi from '../api/orders.js';
import webhook from '../api/cb/webhook.js';

process.env.ADMIN_SECRET = 'secret';
process.env.ORDER_TOKEN = 'tok';
process.env.INTEGRATIONS_SECRET = 'test-secret';
process.env.ALLOWED_ORIGINS = 'https://adhdbg.eu';
delete process.env.NEKOREKTEN_API_KEY;
let q;
beforeEach(async () => { q = await makeTestQuery(); setQueryForTests(q); });
const admin = { cookie: `zdo_admin=${signSession('secret')}` };
const call = async (opts) => { const res = fakeRes(); await router(fakeReq(opts), res); return res; };
const checkout = async (origin, id) => {
  const res = fakeRes();
  await ordersApi(fakeReq({ method: 'POST', url: '/api/orders', headers: { origin, 'x-forwarded-for': `9.9.9.${id}` }, body: JSON.stringify({
    token: 'tok', cb_order_id: String(id), name: 'Мария', phone: '0888123456', delivery_type: 'econt_office', office_id: 'econt:1',
    office_text: 'ЕКОНТ – офис (1)', city: 'Х', items: [{ name: 'Книга', qty: 1, price: 10 }], total: 12 }) }), res);
  return res;
};

test('admin lists and adds shops; the domain is checked and unique', async () => {
  let res = await call({ method: 'POST', url: '/api/admin/shops', headers: admin, body: JSON.stringify({ name: 'Деца', domain: 'https://www.knigi.bg/' }) });
  assert.equal(json(res).shop.domain, 'knigi.bg');
  res = await call({ method: 'POST', url: '/api/admin/shops', headers: admin, body: JSON.stringify({ name: 'Пак', domain: 'knigi.bg' }) });
  assert.match(json(res).error, /вече има/);
  res = await call({ url: '/api/admin/shops', headers: admin });
  assert.deepEqual(json(res).shops.map((s) => s.domain), ['shop.local', 'knigi.bg']);
  assert.equal((await call({ url: '/api/admin/shops' })).statusCode, 401);
});

test("a new shop's checkout is accepted without touching ALLOWED_ORIGINS, and its orders land in that shop", async () => {
  assert.equal((await checkout('https://www.knigi.bg', 1)).statusCode, 403, 'unknown site');
  const kids = await createShop(q, { name: 'Деца', domain: 'knigi.bg' });
  assert.equal((await checkout('https://www.knigi.bg', 2)).statusCode, 200);
  assert.equal((await checkout('https://adhdbg.eu', 3)).statusCode, 200, 'listed origin still works');
  const rows = await q(`select cb_order_id, shop_id from zd.orders order by cb_order_id`);
  assert.deepEqual(rows.map((r) => [r.cb_order_id, r.shop_id]), [['adhdbg.eu:3', DEFAULT_SHOP], ['knigi.bg:2', kids.id]]);
  let res = await call({ url: `/api/admin/orders?shop=${kids.id}`, headers: admin });
  assert.deepEqual(json(res).orders.map((o) => o.cbOrderId), ['knigi.bg:2']);
  res = await call({ url: '/api/admin/orders?shop=all', headers: admin });
  assert.equal(json(res).total, 2);
});

test("each shop's ConvertBuilder webhook stores orders in that shop and checks that shop's secret", async () => {
  const kids = await createShop(q, { name: 'Деца', domain: 'knigi.bg' });
  await saveIntegration(q, 'convertbuilder', { config: { domain: 'knigi.bg', store: 'knigi.bg', active: true, webhookSecret: 'kids-secret' }, secret: 'K', shopId: kids.id });
  const body = JSON.stringify({ id: 7, created: Math.floor(Date.now() / 1000), customerName: 'Иван', shippingAddress: { address: 'ЕКОНТ – офис' }, total: 20, status: 'pending', items: [] });
  const sign = (secret) => createHmac('sha512', secret).update(body).digest('hex');
  let res = fakeRes();
  await webhook(fakeReq({ method: 'POST', url: `/api/cb/webhook?shop=${kids.id}`, headers: { 'x-webhook-topic': 'order_created', 'x-webhook-signature': sign('other') }, body }), res);
  assert.equal(res.statusCode, 401);
  res = fakeRes();
  await webhook(fakeReq({ method: 'POST', url: `/api/cb/webhook?shop=${kids.id}`, headers: { 'x-webhook-topic': 'order_created', 'x-webhook-signature': sign('kids-secret') }, body }), res);
  assert.equal(res.statusCode, 200);
  const [o] = await q(`select cb_order_id, shop_id from zd.orders`);
  assert.deepEqual([o.cb_order_id, o.shop_id], ['knigi.bg:7', kids.id]);
});

test('products, costs and pages that need a shop are kept apart', async () => {
  const kids = await createShop(q, { name: 'Деца', domain: 'knigi.bg' });
  await saveProduct(q, { name: 'Книга', stock: 5 }, { create: true });
  await saveProduct(q, { name: 'Книга', stock: 50 }, { create: true, shopId: kids.id });
  assert.deepEqual((await listInventory(q, { shopId: kids.id })).products.map((p) => [p.name, p.stock]), [['Книга', 50]]);
  assert.deepEqual((await listInventory(q)).products.map((p) => [p.name, p.stock]), [['Книга', 5]]);
  const res = await call({ url: '/api/admin/inventory?shop=all', headers: admin });
  assert.equal(res.statusCode, 400);
  assert.match(json(res).error, /Изберете магазин/);
});

test('the "same phone" duplicate flag stays inside one shop', async () => {
  const kids = await createShop(q, { name: 'Деца', domain: 'knigi.bg' });
  await checkout('https://adhdbg.eu', 11);
  await checkout('https://www.knigi.bg', 12);
  const rows = await q(`select cb_order_id, is_duplicate from zd.orders order by cb_order_id`);
  assert.deepEqual(rows.map((r) => [r.cb_order_id, r.is_duplicate]), [['adhdbg.eu:11', false], ['knigi.bg:12', false]]);
  assert.ok(kids.id);
});

test('writes with an unknown shop are refused instead of landing in the default shop', async () => {
  const unknown = '11111111-1111-4111-8111-111111111111';
  let res = await call({ method: 'POST', url: `/api/admin/costs?shop=${unknown}`, headers: admin, body: JSON.stringify({ spentOn: '2026-10-01', name: 'Х', amount: 5 }) });
  assert.equal(res.statusCode, 400);
  res = await call({ method: 'POST', url: `/api/admin/inventory?shop=${unknown}`, headers: admin, body: JSON.stringify({ action: 'save', create: true, name: 'Х', stock: 1 }) });
  assert.equal(res.statusCode, 400);
  res = await call({ method: 'POST', url: '/api/admin/integrations?shop=', headers: admin, body: JSON.stringify({ action: 'save_shop', name: 'Х' }) });
  assert.equal(res.statusCode, 400, 'empty shop on a write');
  assert.equal((await q(`select count(*)::int as n from zd.expenses`))[0].n, 0);
  res = await call({ url: '/api/admin/costs', headers: admin });
  assert.equal(res.statusCode, 200, 'reading without a shop still opens the default shop');
});

test('an order can only be changed or deleted through its own shop', async () => {
  const kids = await createShop(q, { name: 'Деца', domain: 'knigi.bg' });
  await checkout('https://adhdbg.eu', 21);
  const [o] = await q(`select id from zd.orders`);
  let res = await call({ method: 'PATCH', url: `/api/admin/orders?shop=${kids.id}`, headers: admin, body: JSON.stringify({ id: o.id, status: 'shipped' }) });
  assert.equal(res.statusCode, 404);
  res = await call({ method: 'DELETE', url: `/api/admin/orders?shop=${kids.id}`, headers: admin, body: JSON.stringify({ id: o.id }) });
  assert.equal(res.statusCode, 404);
  res = await call({ method: 'PATCH', url: `/api/admin/orders?shop=${DEFAULT_SHOP}`, headers: admin, body: JSON.stringify({ id: o.id, status: 'shipped' }) });
  assert.equal(res.statusCode, 200);
  res = await call({ method: 'PATCH', url: '/api/admin/orders?shop=all', headers: admin, body: JSON.stringify({ id: o.id, status: 'delivered' }) });
  assert.equal(res.statusCode, 200, '"all shops" can change any order');
});

test('a fresh install asks for the checkout domain first and never adopts the ConvertBuilder API domain', async () => {
  let res = await call({ method: 'POST', url: `/api/admin/integrations?shop=${DEFAULT_SHOP}`, headers: admin, body: JSON.stringify({ action: 'save_convertbuilder', domain: 'xyz.convertbuilder.com', apiKey: 'K' }) });
  assert.equal(res.statusCode, 400);
  assert.match(json(res).error, /домейна на магазина/);
  res = await call({ method: 'POST', url: `/api/admin/integrations?shop=${DEFAULT_SHOP}`, headers: admin, body: JSON.stringify({ action: 'save_shop', name: 'adhd', domain: 'https://adhdbg.eu' }) });
  assert.equal(json(res).shop.domain, 'adhdbg.eu');
  await createShop(q, { name: 'Деца', domain: 'knigi.bg' });
  const [s] = await q(`select domain from zd.shops where id = $1`, [DEFAULT_SHOP]);
  assert.equal(s.domain, 'adhdbg.eu');
  res = await call({ method: 'POST', url: `/api/admin/integrations?shop=${DEFAULT_SHOP}`, headers: admin, body: JSON.stringify({ action: 'save_shop', name: 'adhd', domain: 'other.bg' }) });
  assert.equal(json(res).shop.domain, 'adhdbg.eu', 'a set domain is not changed (orders are keyed by it)');
});

test('the placeholder domain of a fresh install accepts no checkout', async () => {
  const res = await checkout('https://shop.local', 31);
  assert.equal(res.statusCode, 403);
});

test('a client with no shop creates it from the ConvertBuilder shop form: checkout URL in the domain field, all store data kept', async () => {
  const s = await createShop(q, { name: 'Докато спиш', domain: 'https://dokatospish.convertbuilder.com/checkout', url: 'https://dokatospish.convertbuilder.com/',
    email: 'info@example.bg', phone: '+359888123456', currency: 'EUR' }, { byClient: true });
  assert.equal(s.domain, 'dokatospish.convertbuilder.com');
  assert.equal(s.url, 'https://dokatospish.convertbuilder.com/'); assert.equal(s.email, 'info@example.bg'); assert.equal(s.phone, '+359888123456');
  assert.equal(s.approved, false);
});
