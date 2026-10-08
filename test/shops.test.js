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
