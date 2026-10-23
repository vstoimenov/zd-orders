// Fixes from the whole-branch review of the fulfilment integration: races, re-checks, pending cancels, paid rule, buyer page.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeReq, fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { insertOrder, ensureConfirmToken } from '../lib/orders-repo.js';
import { saveIntegration } from '../lib/integrations-repo.js';
import { makeFulfilmentKey, saveFulfilment, pauseFulfilment, deleteFulfilment, fulfilmentStatus, isDue, buildOrderBody, sendEvent, queueFulfilment, queueCancel, retryDue, countDue } from '../lib/fulfilment.js';
import { applyReport } from '../lib/fulfilment-inbound.js';
import { cbConfig, processCbOrder } from '../lib/cb-sync.js';
import { confirmPage } from '../lib/confirm.js';
import { signSession } from '../lib/auth.js';
import { saveSubscription, setPushSenderForTests } from '../lib/push.js';
import ordersAdmin from '../lib/admin/orders.js';

process.env.INTEGRATIONS_SECRET = 'test-secret';
process.env.ADMIN_SECRET = 'secret';
process.env.PUBLIC_BASE_URL = 'https://app.ordyx.eu';
process.env.VAPID_PUBLIC_KEY = 'B'; process.env.VAPID_PRIVATE_KEY = 'p';
delete process.env.NEKOREKTEN_API_KEY;
const SHOP = '00000000-0000-4000-8000-000000000001';
let q, sent;
beforeEach(async () => {
  q = await makeTestQuery(); setQueryForTests(q);
  await q(`update zd.shops set domain = 'a-shop.bg', name = 'Магазин А' where id = $1`, [SHOP]);
  sent = [];
  setPushSenderForTests(async (s, payload) => { sent.push(JSON.parse(payload)); return { statusCode: 201 }; });
  await saveSubscription(q, { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/owner', keys: { p256dh: 'p', auth: 'a' } }, shopId: null });
});

const base = { name: 'Мария Иванова', phone: '0888123456', phoneNorm: '+359888123456', email: '', deliveryType: 'econt_office', courier: 'econt', officeId: 'econt:1127',
  officeText: 'Плевен Център, Плевен (1127)', city: 'Плевен', postCode: '5800', addressText: '', items: [{ name: 'Книга', qty: 1, price: 20 }], total: 22.57, currency: 'EUR', paymentMethod: 'cod',
  pageUrl: '', userAgent: '', ip: '', trafficSource: '', cbCheck: '' };
let seq = 0;
const order = async (patch = {}) => (await insertOrder(q, { ...base, cbOrderId: `t-${++seq}-${Date.now()}`, shopId: SHOP, ...patch })).id;
const setStatus = (id, status) => q(`update zd.orders set status = $2 where id = $1::uuid`, [id, status]);
const row = async (id) => (await q(`select * from zd.orders where id = $1::uuid`, [id]))[0];
function warehouse({ status = 200, hang = false } = {}) {
  const calls = [], pending = [];
  const impl = (url, init) => {
    calls.push({ url: String(url), init });
    if (hang) return new Promise((resolve, reject) => { pending.push(() => resolve({ ok: true, status: 200, json: async () => ({}) })); init.signal?.addEventListener('abort', () => reject(new Error('aborted'))); });
    return Promise.resolve({ ok: status < 300, status, json: async () => ({}) });
  };
  return { calls, impl, release: () => pending.splice(0).forEach((f) => f()) };
}
const events = (w) => w.calls.map((c) => JSON.parse(c.init.body).event);
const connect = async () => { await saveFulfilment(q, SHOP, { url: 'https://sklad.bg/hook' }); return (await makeFulfilmentKey(q, SHOP)).key; };
const quiet = async (fn) => { const err = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = err; } };
async function withFetch(impl, fn) {
  const real = globalThis.fetch, err = console.error, warn = console.warn;
  globalThis.fetch = impl; console.error = () => {}; console.warn = () => {};
  try { return await fn(); } finally { globalThis.fetch = real; console.error = err; console.warn = warn; }
}

test('#1 a cancel coming from the ConvertBuilder sync reaches the warehouse', async () => {
  await connect();
  await saveIntegration(q, 'convertbuilder', { config: { domain: 'a-shop.bg', active: true }, secret: 'cb-key', shopId: SHOP });
  const cfg = await cbConfig(q, SHOP);
  const cbOrder = (status) => ({ id: 82, invoiceNo: 60, created: Math.floor(Date.now() / 1000), customerName: 'Мария', customerEmail: 'm@x.bg',
    shippingAddress: { phone: '+359888123456', city: 'Плевен', zipCode: '5800', address: 'ЕКОНТ – офис Плевен (1127), ул. Х' },
    total: 16.45, shippingName: 'Доставка до офис на Еконт', paymentMethod: 'cod', status, items: [{ name: 'Книга', quantity: 1, total: 12.9 }] });
  const w = warehouse();
  const r = await withFetch(w.impl, () => processCbOrder(q, cfg, cbOrder('pending')));
  await setStatus(r.id, 'confirmed');
  await queueFulfilment(q, r.id, { fetchImpl: w.impl });
  assert.deepEqual(events(w), ['order']);
  await withFetch(w.impl, () => processCbOrder(q, cfg, cbOrder('canceled')));
  assert.equal((await row(r.id)).status, 'cancelled');
  assert.deepEqual(events(w), ['order', 'cancelled']);
});

test('#2 a waiting order that is no longer due is not sent and stops waiting', async () => {
  await connect();
  const id = await order(); await setStatus(id, 'confirmed');
  await q(`update zd.orders set fulfil_notify = 'order' where id = $1::uuid`, [id]);
  await setStatus(id, 'cancelled');
  const w = warehouse();
  assert.deepEqual(await retryDue(q, { fetchImpl: w.impl }), { retried: 0, sent: 0 });
  assert.equal(w.calls.length, 0);
  const shipped = await order(); await setStatus(shipped, 'shipped');
  await q(`update zd.orders set fulfil_notify = 'order', waybill_number = '1' where id = $1::uuid`, [shipped]);
  assert.equal(await sendEvent(q, shipped, 'order', { fetchImpl: w.impl }), true);
  assert.equal(w.calls.length, 0);
  assert.equal((await row(shipped)).fulfil_notify, '');
  assert.equal(await countDue(q, SHOP), 0);
});

test('#3 a cancel during an in-flight send is delivered right after it; two parallel sends make one call', async () => {
  await connect();
  const id = await order(); await setStatus(id, 'confirmed');
  const w = warehouse({ hang: true });
  const inflight = queueFulfilment(q, id, { fetchImpl: w.impl });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(w.calls.length, 1);
  await setStatus(id, 'cancelled');
  await queueCancel(q, id, { fetchImpl: w.impl }); // nothing sent yet: the order is still on its way to the warehouse
  assert.equal(w.calls.length, 1);
  w.release();
  await inflight;
  assert.deepEqual(events(w), ['order', 'cancelled']);
  const other = await order(); await setStatus(other, 'confirmed');
  const w2 = warehouse();
  await Promise.all([queueFulfilment(q, other, { fetchImpl: w2.impl }), queueFulfilment(q, other, { fetchImpl: w2.impl })]);
  assert.equal(w2.calls.length, 1);
});

test('#4 pending cancels are retried for a paused shop, block the delete, and a sent order cannot be deleted from the admin', async () => {
  await connect();
  const id = await order(); await setStatus(id, 'confirmed');
  await q(`update zd.orders set fulfil_sent_at = now(), status = 'cancelled', fulfil_notify = 'cancelled' where id = $1::uuid`, [id]);
  await pauseFulfilment(q, SHOP);
  await assert.rejects(deleteFulfilment(q, SHOP), /чака/);
  const w = warehouse();
  assert.deepEqual(await retryDue(q, { fetchImpl: w.impl }), { retried: 1, sent: 1 });
  assert.deepEqual(events(w), ['cancelled']);
  await deleteFulfilment(q, SHOP);
  await connect();
  const at = await order(); await setStatus(at, 'confirmed');
  await q(`update zd.orders set fulfil_sent_at = now() where id = $1::uuid`, [at]);
  const res = fakeRes();
  await ordersAdmin(fakeReq({ method: 'DELETE', url: '/api/admin/orders', headers: { cookie: `zdo_admin=${signSession('secret')}` }, body: JSON.stringify({ id: at }) }), res);
  assert.equal(res.statusCode, 400); assert.match(json(res).error, /при склада/);
});

test('#5 an empty payment method is cash on delivery: not due without confirmation, and the body says so', async () => {
  assert.equal(isDue({ status: 'new', fulfil_sent_at: null, waybill_number: '', payment_method: '', cb_check: '' }, { enabled: true, sendOn: 'confirmed' }), false);
  assert.equal(isDue({ status: 'new', fulfil_sent_at: null, waybill_number: '', payment_method: 'bank', cb_check: '' }, { enabled: true, sendOn: 'confirmed' }), false);
  await connect();
  const id = await order({ paymentMethod: '' });
  const w = warehouse();
  await queueFulfilment(q, id, { fetchImpl: w.impl });
  assert.equal(w.calls.length, 0);
  assert.deepEqual((await buildOrderBody(q, await row(id))).order.payment, { method: 'cod', cod_amount: 22.57 });
});

test('#7 a shipped report never overwrites an Ordyx waybill, and reserved numbers are refused', async () => {
  await connect();
  const id = await order(); await setStatus(id, 'shipped');
  await q(`update zd.orders set waybill_number = '1055', waybill_courier = 'econt', waybill_created_at = now() where id = $1::uuid`, [id]);
  const r = await applyReport(q, SHOP, { order_id: id, event: 'shipped', waybill: { courier: 'speedy', number: '59' } });
  assert.equal(r.status, 409);
  assert.equal((await row(id)).waybill_number, '1055');
  assert.deepEqual(sent.map((p) => p.title), ['⚠️ Складът изпрати поръчка, която вече има товарителница']);
  const fresh = await order(); await setStatus(fresh, 'confirmed');
  assert.equal((await applyReport(q, SHOP, { order_id: fresh, event: 'shipped', waybill: { courier: 'econt', number: 'creating' } })).status, 400);
});

test('#8 orders open before the shop connected are not sent by themselves — only by „Изпрати неизпратените“', async () => {
  const old = await order(); await setStatus(old, 'confirmed');
  await q(`update zd.orders set created_at = now() - interval '1 hour' where id = $1::uuid`, [old]);
  await new Promise((r) => setTimeout(r, 20));
  await connect();
  const fresh = await order(); await setStatus(fresh, 'confirmed');
  assert.equal(await countDue(q, SHOP), 2);
  const w = warehouse();
  assert.deepEqual(await retryDue(q, { fetchImpl: w.impl }), { retried: 1, sent: 1 });
  assert.equal(JSON.parse(w.calls[0].init.body).order.id, fresh);
  assert.deepEqual(await retryDue(q, { fetchImpl: w.impl, all: true, shopId: SHOP }), { retried: 1, sent: 1 });
  assert.equal(JSON.parse(w.calls[1].init.body).order.id, old);
});

test("#9 the buyer's page shows the warehouse's own tracking link", async () => {
  const id = await order({ deliveryType: 'boxnow_locker', courier: 'boxnow' });
  await q(`update zd.orders set status = 'shipped', waybill_number = 'BN-1', waybill_courier = 'boxnow', waybill_external = true, waybill_track_url = 'https://track.bg/BN-1', waybill_created_at = now() where id = $1::uuid`, [id]);
  const page = await confirmPage(q, await ensureConfirmToken(q, id));
  assert.equal(page.tracking.trackUrl, 'https://track.bg/BN-1');
  assert.equal(page.tracking.number, 'BN-1');
});

test('#10 a rejected order (4xx) does not block the orders behind it, and a hung warehouse respects the budget', async () => {
  await connect();
  await q(`update zd.integrations set config = config || '{"connectedAt":"2020-01-01T00:00:00.000Z"}' where provider = 'fulfilment'`);
  const a = await order(); await setStatus(a, 'confirmed');
  await q(`update zd.orders set created_at = now() - interval '1 minute' where id = $1::uuid`, [a]);
  const b = await order(); await setStatus(b, 'confirmed');
  let n = 0;
  const impl = (url, init) => { n++; return Promise.resolve({ ok: n > 1, status: n > 1 ? 200 : 422, json: async () => ({}) }); };
  assert.deepEqual(await quiet(() => retryDue(q, { fetchImpl: impl })), { retried: 2, sent: 1 });
  assert.match((await fulfilmentStatus(q, SHOP)).lastError || '', /422/);
  const c = await order(); await setStatus(c, 'confirmed');
  const slow = warehouse({ hang: true });
  const t0 = Date.now();
  const r = await quiet(() => retryDue(q, { fetchImpl: slow.impl, budgetMs: 200 }));
  assert.ok(Date.now() - t0 < 1500, 'stopped with the budget');
  assert.equal(r.sent, 0);
});

test('#11 a cancel from the warehouse frees the order for a later re-send; no key is a visible error', async () => {
  await saveFulfilment(q, SHOP, { url: 'https://sklad.bg/hook' });
  const id = await order(); await setStatus(id, 'confirmed');
  const w = warehouse();
  await queueFulfilment(q, id, { fetchImpl: w.impl });
  assert.equal(w.calls.length, 0);
  assert.match((await fulfilmentStatus(q, SHOP)).lastError || '', /ключ/);
  await makeFulfilmentKey(q, SHOP);
  await queueFulfilment(q, id, { fetchImpl: w.impl });
  assert.equal(w.calls.length, 1);
  await applyReport(q, SHOP, { order_id: id, event: 'cancelled' });
  assert.equal((await row(id)).fulfil_sent_at, null);
});
