import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeReq, fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { signSession } from '../lib/auth.js';
import { saveProduct } from '../lib/stock.js';
import { processCbOrder, syncOrders } from '../lib/cb-sync.js';
import { saveIntegration } from '../lib/integrations-repo.js';
import ordersApi from '../api/orders.js';
import router from '../api/admin/[route].js';

const ORIGIN = 'https://adhdbg.eu';
process.env.ALLOWED_ORIGINS = ORIGIN;
process.env.ORDER_TOKEN = 'tok';
process.env.ADMIN_SECRET = 'secret';
process.env.INTEGRATIONS_SECRET = 'test-secret';
delete process.env.NEKOREKTEN_API_KEY;

let q;
beforeEach(async () => { q = await makeTestQuery(); setQueryForTests(q); await saveProduct(q, { name: 'Книга', stock: 10 }, { create: true }); });
const stock = async () => Number((await q(`select stock from zd.product_costs where name = 'Книга'`))[0].stock);
const cookie = { cookie: `zdo_admin=${signSession('secret')}` };
const checkout = (id, qty = 1) => {
  const res = fakeRes();
  return ordersApi(fakeReq({ method: 'POST', url: '/api/orders', headers: { origin: ORIGIN, 'x-forwarded-for': '9.9.9.9' }, body: JSON.stringify({
    token: 'tok', cb_order_id: String(id), name: 'Мария', phone: '0888123456', delivery_type: 'econt_office', office_id: 'econt:1',
    office_text: 'ЕКОНТ – офис (1)', city: 'Х', items: [{ name: 'Книга', qty, price: 18.5 * qty }], total: 22.57 }) }), res).then(() => res);
};
const cbOrder = (id, status = 'pending', qty = 1) => ({ id, created: Math.floor(Date.now() / 1000), customerName: 'Мария',
  shippingAddress: { phone: '+359888123456', address: 'ЕКОНТ – офис (1)' }, total: 22.57, status, items: [{ name: 'Книга', quantity: qty, total: 18.5 * qty }] });

test('a checkout order takes stock right away', async () => {
  assert.equal((await checkout(82, 2)).statusCode, 200);
  assert.equal(await stock(), 8);
});

test('ConvertBuilder webhook and sync take stock once, also when the checkout already reported the order', async () => {
  const cfg = { store: 'adhdbg.eu', currency: 'EUR' };
  await checkout(82);
  await processCbOrder(q, cfg, cbOrder(82));
  await processCbOrder(q, cfg, cbOrder(83, 'pending', 3));
  assert.equal(await stock(), 6);
  await processCbOrder(q, cfg, cbOrder(83, 'canceled', 3));
  assert.equal(await stock(), 9, 'cancelled in ConvertBuilder → stock back');
  await saveIntegration(q, 'convertbuilder', { config: { domain: 'adhdbg.eu', store: 'adhdbg.eu', active: true }, secret: 'API-KEY' });
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ items: [cbOrder(84, 'pending', 2)], totalCount: 1 }) });
  try { await syncOrders(q, {}); } finally { globalThis.fetch = real; }
  assert.equal(await stock(), 7, 'nightly/manual sync takes stock for new orders too');
});

test('status changes and deleting in the admin move stock', async () => {
  await checkout(90, 2);
  const [o] = await q(`select id from zd.orders`);
  const patch = async (status) => { const res = fakeRes(); await router(fakeReq({ method: 'PATCH', url: '/api/admin/orders', headers: cookie, body: JSON.stringify({ id: o.id, status }) }), res); return res; };
  assert.equal((await patch('returned')).statusCode, 200);
  assert.equal(await stock(), 10);
  await patch('shipped');
  assert.equal(await stock(), 8);
  const res = fakeRes();
  await router(fakeReq({ method: 'DELETE', url: '/api/admin/orders', headers: cookie, body: JSON.stringify({ id: o.id }) }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(await stock(), 10);
  const [m] = await q(`select count(*)::int as n from zd.stock_moves where order_id is null and reason <> 'manual'`);
  assert.equal(m.n, 4, 'the history keeps the moves of the deleted order (−2, +2, −2, +2)');
});
