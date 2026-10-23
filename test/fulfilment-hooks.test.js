import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeReq, fakeRes } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { insertOrder, upsertExternalOrder, toOrder, ensureConfirmToken } from '../lib/orders-repo.js';
import { makeFulfilmentKey, saveFulfilment, pauseFulfilment, queueFulfilment } from '../lib/fulfilment.js';
import { answerConfirm } from '../lib/confirm.js';
import { voiceResult } from '../lib/voice-call.js';
import { createWaybill, assignRoute, cancelWaybill, saveEcont, refreshOrderStatus } from '../lib/waybills.js';
import { makeShopKey, resetKeyLimitsForTests } from '../lib/shop-keys.js';
import orders from '../api/orders.js';

process.env.INTEGRATIONS_SECRET = 'test-secret';
process.env.PUBLIC_BASE_URL = 'https://app.ordyx.eu';
process.env.ORDER_TOKEN = 'tok';
process.env.ALLOWED_ORIGINS = 'https://a-shop.bg';
const SHOP = '00000000-0000-4000-8000-000000000001';
let q;
beforeEach(async () => {
  q = await makeTestQuery(); setQueryForTests(q); resetKeyLimitsForTests();
  await q(`update zd.shops set domain = 'a-shop.bg', name = 'Магазин А' where id = $1`, [SHOP]);
  await q(`insert into zd.offices (id, courier, code, name, city) values ('econt:1127', 'econt', '1127', 'Плевен Център', 'Плевен')`);
});

const base = { name: 'Мария Иванова', phone: '0888123456', phoneNorm: '+359888123456', email: 'm@x.bg', deliveryType: 'econt_office', courier: 'econt', officeId: 'econt:1127',
  officeText: 'Плевен Център, Плевен (1127)', city: 'Плевен', postCode: '5800', addressText: '', items: [{ name: 'Книга', qty: 2, price: 10 }], total: 22.57, currency: 'EUR', paymentMethod: 'cod',
  pageUrl: '', userAgent: '', ip: '', trafficSource: '', cbCheck: '' };
let seq = 0;
const order = async (patch = {}) => (await insertOrder(q, { ...base, cbOrderId: `t-${++seq}-${Date.now()}`, shopId: SHOP, ...patch })).id;
const setStatus = (id, status) => q(`update zd.orders set status = $2 where id = $1::uuid`, [id, status]);
function warehouse({ status = 200 } = {}) {
  const calls = [];
  const impl = (url, init) => { calls.push({ url: String(url), init }); return Promise.resolve({ ok: status < 300, status, json: async () => ({}) }); };
  return { calls, impl };
}
const connect = async () => { await saveFulfilment(q, SHOP, { url: 'https://sklad.bg/hook' }); return (await makeFulfilmentKey(q, SHOP)).key; };
async function withFetch(impl, fn) {
  const real = globalThis.fetch, err = console.error;
  globalThis.fetch = impl; console.error = () => {};
  try { return await fn(); } finally { globalThis.fetch = real; console.error = err; }
}
const events = (w) => w.calls.map((c) => JSON.parse(c.init.body).event);

test('the buyer confirming from the link sends the order to the warehouse; refusing a sent order tells the warehouse', async () => {
  await connect();
  const w = warehouse();
  const id = await order();
  const token = await ensureConfirmToken(q, id);
  await withFetch(w.impl, () => answerConfirm(q, token, 'yes'));
  assert.deepEqual(events(w), ['order']);
  await withFetch(w.impl, () => answerConfirm(q, token, 'no'));
  assert.deepEqual(events(w), ['order', 'cancelled']);
});

test('a "yes" from the voice agent sends the order', async () => {
  await connect(); process.env.VOICE_CALL_SECRET = 's';
  const w = warehouse();
  const id = await order();
  const ts = String(Math.floor(Date.now() / 1000)), body = JSON.stringify({ order_id: id, answer: 'yes' });
  const sig = createHmac('sha256', 's').update(`${ts}.${body}`).digest('hex');
  const r = await withFetch(w.impl, () => voiceResult(q, body, { 'x-ordyx-time': ts, 'x-ordyx-signature': sig }));
  assert.equal(r.applied, true);
  assert.deepEqual(events(w), ['order']);
});

test('a paid order from a site goes to the warehouse on arrival; a cancel from the site reaches the warehouse', async () => {
  await connect();
  const w = warehouse();
  const { key } = await makeShopKey(q, SHOP);
  const call = async (body) => {
    const res = fakeRes();
    await orders(fakeReq({ method: 'POST', url: '/api/orders', headers: { authorization: `Bearer ${key}`, 'x-forwarded-for': '5.5.5.5' }, body: JSON.stringify(body) }), res);
    return res;
  };
  const site = { source: 'api', external_id: 'A-1', name: 'Мария Иванова', phone: '0888123456', delivery_type: 'econt_office', office_id: 'econt:1127', office_text: 'Плевен (1127)', city: 'Плевен', post_code: '5800',
    items: [{ name: 'Книга', qty: 1, price: 20 }], total: 20, currency: 'EUR', paid: true, payment_method: 'card' };
  assert.equal((await withFetch(w.impl, () => call(site))).statusCode, 200);
  assert.deepEqual(events(w), ['order']);
  assert.equal((await withFetch(w.impl, () => call({ source: 'api', external_id: 'A-1', status: 'cancelled' }))).statusCode, 200);
  assert.deepEqual(events(w), ['order', 'cancelled']);
});

test('a sent order is frozen: a site re-send with new items is locked out and does not change the order', async () => {
  await connect();
  const w = warehouse();
  const first = await upsertExternalOrder(q, { ...base, cbOrderId: 'a-shop.bg:ext-7', source: 'api', shopId: SHOP, paymentMethod: 'card' });
  await queueFulfilment(q, first.id, { fetchImpl: w.impl });
  assert.equal(w.calls.length, 1);
  const again = await upsertExternalOrder(q, { ...base, cbOrderId: 'a-shop.bg:ext-7', source: 'api', shopId: SHOP, paymentMethod: 'card', items: [{ name: 'Друго', qty: 1, price: 5 }] });
  assert.equal(again.locked, true);
  assert.equal((await q(`select items from zd.orders where id = $1::uuid`, [first.id]))[0].items[0].name, 'Книга');
});

test('no Ordyx waybill for a shop with the warehouse on, nor for a sent order after the integration is paused', async () => {
  await connect();
  await withFetch(() => Promise.resolve({ ok: true, status: 200, json: async () => ({ clientID: 1 }) }), () =>
    saveEcont(q, SHOP, { username: 'u', password: 'p', demo: true, senderType: 'office', senderOfficeCode: '1127', senderPhone: '0888888888', payer: 'sender', weight: '1', description: '', review: false }).catch(() => {}));
  const id = await order(); await setStatus(id, 'confirmed');
  await assert.rejects(createWaybill(q, { orderId: id, scopeShopId: SHOP }), /правят от склада/);
  await assert.rejects(assignRoute(q, { orderId: id, scopeShopId: SHOP, input: { courier: 'econt', officeId: 'econt:1127' } }), /правят от склада/);
  await q(`update zd.orders set fulfil_sent_at = now() where id = $1::uuid`, [id]);
  await pauseFulfilment(q, SHOP);
  await assert.rejects(createWaybill(q, { orderId: id, scopeShopId: SHOP }), /при склада/);
  const free = await order(); await setStatus(free, 'confirmed');
  await assert.rejects(createWaybill(q, { orderId: free, scopeShopId: SHOP }), (e) => !/склада/.test(e.message)); // some other reason (Econt), not the warehouse
});

test('an external waybill cannot be cancelled here, is not refreshed with the courier, and shows its own track link', async () => {
  const id = await order();
  await q(`update zd.orders set status = 'shipped', waybill_number = 'W-1', waybill_courier = 'other', waybill_external = true, waybill_track_url = 'https://track.bg/W-1', waybill_created_at = now() where id = $1::uuid`, [id]);
  await assert.rejects(cancelWaybill(q, { orderId: id, scopeShopId: SHOP }), /от склада/);
  assert.equal(await refreshOrderStatus(q, id), false);
  const [r] = await q(`select * from zd.orders where id = $1::uuid`, [id]);
  const o = toOrder(r);
  assert.equal(o.shipment.external, true); assert.equal(o.shipment.trackUrl, 'https://track.bg/W-1');
  assert.deepEqual(o.fulfilment, { sentAt: null, pending: false });
});
