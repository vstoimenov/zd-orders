import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeReq, fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { insertOrder } from '../lib/orders-repo.js';
import { makeFulfilmentKey, saveFulfilment, pauseFulfilment, fulfilmentStatus } from '../lib/fulfilment.js';
import { applyReport } from '../lib/fulfilment-inbound.js';
import { resetKeyLimitsForTests } from '../lib/shop-keys.js';
import { saveSubscription, setPushSenderForTests } from '../lib/push.js';
import handler from '../api/fulfilment.js';

process.env.INTEGRATIONS_SECRET = 'test-secret';
process.env.PUBLIC_BASE_URL = 'https://app.ordyx.eu';
process.env.VAPID_PUBLIC_KEY = 'B'; process.env.VAPID_PRIVATE_KEY = 'p';
const SHOP = '00000000-0000-4000-8000-000000000001';
const SHOP_B = '00000000-0000-4000-8000-0000000000b2';
let q, sent;
beforeEach(async () => {
  q = await makeTestQuery(); setQueryForTests(q); resetKeyLimitsForTests();
  await q(`update zd.shops set domain = 'a-shop.bg', name = 'Магазин А' where id = $1`, [SHOP]);
  await q(`insert into zd.shops (id, name, domain, approved) values ($1, 'Магазин Б', 'b-shop.bg', true)`, [SHOP_B]);
  sent = [];
  setPushSenderForTests(async (s, payload) => { sent.push(JSON.parse(payload)); return { statusCode: 201 }; });
  await saveSubscription(q, { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/owner', keys: { p256dh: 'p', auth: 'a' } }, shopId: null });
});

const base = { name: 'Мария Иванова', phone: '0888123456', phoneNorm: '+359888123456', email: '', deliveryType: 'econt_office', courier: 'econt', officeId: 'econt:1127',
  officeText: 'Плевен Център, Плевен (1127)', city: 'Плевен', postCode: '5800', addressText: '', items: [{ name: 'Книга', qty: 1, price: 20 }], total: 22.57, currency: 'EUR', paymentMethod: 'cod',
  pageUrl: '', userAgent: '', ip: '', trafficSource: '', cbCheck: '' };
let seq = 0;
const order = async (patch = {}, shopId = SHOP) => (await insertOrder(q, { ...base, cbOrderId: `t-${++seq}-${Date.now()}`, shopId, ...patch })).id;
const setStatus = (id, status) => q(`update zd.orders set status = $2 where id = $1::uuid`, [id, status]);
const row = async (id) => (await q(`select * from zd.orders where id = $1::uuid`, [id]))[0];
const connect = async () => { await saveFulfilment(q, SHOP, { url: 'https://sklad.bg/hook' }); return (await makeFulfilmentKey(q, SHOP)).key; };
const shipped = (order_id, waybill = { courier: 'speedy', number: '5900', track_url: 'https://speedy.bg/t/5900' }) => ({ order_id, event: 'shipped', waybill });
const titles = () => sent.map((p) => p.title);

test('shipped records the warehouse waybill, moves the order to shipped and tells the shop', async () => {
  await connect();
  const id = await order(); await setStatus(id, 'confirmed');
  const r = await applyReport(q, SHOP, shipped(id));
  assert.deepEqual(r, { status: 200, body: { ok: true, status: 'shipped' } });
  const o = await row(id);
  assert.equal(o.status, 'shipped'); assert.equal(o.waybill_number, '5900'); assert.equal(o.waybill_courier, 'speedy');
  assert.equal(o.waybill_external, true); assert.equal(o.waybill_track_url, 'https://speedy.bg/t/5900');
  assert.equal(o.waybill_status, 'Изпратена от склада'); assert.equal(o.waybill_demo, false); assert.ok(o.waybill_created_at);
  assert.ok((await fulfilmentStatus(q, SHOP)).lastReceivedAt);
  assert.deepEqual(titles(), ['📦 Складът изпрати поръчката']);
});

test('shipped twice updates the number without a second push; a bad number, courier or http url is refused', async () => {
  await connect();
  const id = await order(); await setStatus(id, 'confirmed');
  await applyReport(q, SHOP, shipped(id));
  const r = await applyReport(q, SHOP, shipped(id, { courier: 'econt', number: '1055', track_url: 'http://plain.bg/x' }));
  assert.equal(r.status, 200);
  const o = await row(id);
  assert.equal(o.waybill_number, '1055'); assert.equal(o.waybill_courier, 'econt'); assert.equal(o.waybill_track_url, '');
  assert.equal(sent.length, 1);
  assert.equal((await applyReport(q, SHOP, shipped(id, { courier: 'econt', number: '' }))).status, 400);
  assert.equal((await applyReport(q, SHOP, shipped(id, { courier: 'econt', number: 'x'.repeat(41) }))).status, 400);
  assert.equal((await applyReport(q, SHOP, shipped(id, { courier: 'dhl', number: '1' }))).status, 400);
  assert.equal((await applyReport(q, SHOP, { order_id: id, event: 'shipped' })).status, 400);
});

test('shipped for a cancelled order is recorded and flagged, the order stays cancelled', async () => {
  await connect();
  const id = await order(); await setStatus(id, 'cancelled');
  const r = await applyReport(q, SHOP, shipped(id));
  assert.equal(r.status, 200); assert.equal(r.body.status, 'cancelled'); assert.ok(r.body.warning);
  const o = await row(id);
  assert.equal(o.status, 'cancelled'); assert.equal(o.waybill_number, '5900'); assert.equal(o.external_status, 'shipped_after_cancel');
  assert.deepEqual(titles(), ['⚠️ Складът изпрати отказана поръчка']);
});

test('delivered and returned only move a shipped order', async () => {
  await connect();
  const id = await order(); await setStatus(id, 'confirmed');
  assert.deepEqual((await applyReport(q, SHOP, { order_id: id, event: 'delivered' })).body, { ok: true, applied: false });
  await applyReport(q, SHOP, shipped(id));
  assert.deepEqual((await applyReport(q, SHOP, { order_id: id, event: 'delivered' })).body, { ok: true, status: 'delivered' });
  let o = await row(id);
  assert.equal(o.status, 'delivered'); assert.equal(o.waybill_status, 'Доставена');
  const back = await order(); await setStatus(back, 'confirmed');
  await applyReport(q, SHOP, shipped(back, { courier: 'other', number: 'R-1' }));
  assert.deepEqual((await applyReport(q, SHOP, { order_id: back, event: 'returned' })).body, { ok: true, status: 'returned' });
  o = await row(back);
  assert.equal(o.status, 'returned'); assert.equal(o.waybill_status, 'Върната');
});

test('cancelled from the warehouse cancels an open order and clears the waiting mark; not a shipped one', async () => {
  await connect();
  const id = await order(); await setStatus(id, 'confirmed');
  await q(`update zd.orders set fulfil_sent_at = now(), fulfil_notify = 'order' where id = $1::uuid`, [id]);
  assert.deepEqual((await applyReport(q, SHOP, { order_id: id, event: 'cancelled' })).body, { ok: true, status: 'cancelled' });
  const o = await row(id);
  assert.equal(o.status, 'cancelled'); assert.equal(o.fulfil_notify, '');
  assert.deepEqual(titles(), ['❌ Складът отказа поръчката']);
  const s = await order(); await setStatus(s, 'confirmed');
  await applyReport(q, SHOP, shipped(s));
  assert.deepEqual((await applyReport(q, SHOP, { order_id: s, event: 'cancelled' })).body, { ok: true, applied: false });
  assert.equal((await row(s)).status, 'shipped');
});

test('an order of another shop, a bad id or an unknown event is refused', async () => {
  await connect();
  const other = await order({}, SHOP_B); await setStatus(other, 'confirmed');
  assert.deepEqual(await applyReport(q, SHOP, shipped(other)), { status: 404, body: { error: 'Няма такава поръчка' } });
  assert.equal((await applyReport(q, SHOP, shipped('nope'))).status, 404);
  const id = await order();
  assert.deepEqual(await applyReport(q, SHOP, { order_id: id, event: 'teleported' }), { status: 400, body: { error: 'Непознато събитие' } });
});

test('the handler: bad key 401, GET ping, a paused integration still accepts reports', async () => {
  const key = await connect();
  const call = async ({ method = 'POST', auth = `Bearer ${key}`, body } = {}) => {
    const res = fakeRes();
    await handler(fakeReq({ method, url: '/api/fulfilment', headers: { authorization: auth }, body: body === undefined ? undefined : JSON.stringify(body) }), res);
    return res;
  };
  assert.equal((await call({ auth: 'Bearer ordyx_ful_0000000000_' + 'a'.repeat(32) })).statusCode, 401);
  assert.equal((await call({ auth: '' })).statusCode, 401);
  const ping = await call({ method: 'GET' });
  assert.equal(ping.statusCode, 200); assert.deepEqual(json(ping), { ok: true, shop: 'Магазин А' });
  assert.equal((await call({ method: 'PUT' })).statusCode, 405);
  const id = await order(); await setStatus(id, 'confirmed');
  await pauseFulfilment(q, SHOP);
  const r = await call({ body: shipped(id) });
  assert.equal(r.statusCode, 200); assert.equal(json(r).status, 'shipped');
  assert.equal((await call({ body: { order_id: id, event: 'cancelled' } })).statusCode, 200);
});
