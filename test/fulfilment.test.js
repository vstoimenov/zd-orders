import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { setQueryForTests } from '../lib/db.js';
import { createHmac } from 'node:crypto';
import { insertOrder } from '../lib/orders-repo.js';
import { makeFulfilmentKey, fulfilmentByKey, fulfilmentSecret, saveFulfilment, pauseFulfilment, deleteFulfilment, fulfilmentStatus, fulfilmentEnabled,
  isDue, buildOrderBody, sendEvent, queueFulfilment, queueCancel, retryDue, countDue } from '../lib/fulfilment.js';

process.env.INTEGRATIONS_SECRET = 'test-secret';
process.env.PUBLIC_BASE_URL = 'https://app.ordyx.eu';
const SHOP = '00000000-0000-4000-8000-000000000001';
let q;
beforeEach(async () => { q = await makeTestQuery(); setQueryForTests(q); });

test('migration 026 adds the fulfilment columns', async () => {
  const [r] = await q(`select fulfil_sent_at, fulfil_notify, waybill_external, waybill_track_url from zd.orders limit 1`);
  assert.equal(r, undefined); // no orders, but the columns exist
});

test('a fulfilment key is made once, found by its id with a timing-safe compare, and replaced by a new one', async () => {
  const { key } = await makeFulfilmentKey(q, SHOP);
  assert.match(key, /^ordyx_ful_[A-Za-z0-9]{10}_[A-Za-z0-9_-]{32}$/);
  assert.equal((await fulfilmentByKey(q, key)).shopId, SHOP);
  assert.equal(await fulfilmentByKey(q, key.slice(0, -1) + (key.endsWith('x') ? 'y' : 'x')), null);
  assert.equal(await fulfilmentByKey(q, 'ordyx_live_abc'), null);
  assert.equal(await fulfilmentSecret(q, SHOP), key);
  const { key: key2 } = await makeFulfilmentKey(q, SHOP);
  assert.equal(await fulfilmentByKey(q, key), null);
  assert.equal((await fulfilmentByKey(q, key2)).shopId, SHOP);
});

test('settings: https only, sendOn defaults to confirmed, saving enables, pausing keeps the key', async () => {
  await assert.rejects(saveFulfilment(q, SHOP, { url: 'http://sklad.bg/hook' }), /https/);
  const st = await saveFulfilment(q, SHOP, { url: 'https://sklad.bg/hook', sendOn: 'weird' });
  assert.equal(st.enabled, true); assert.equal(st.sendOn, 'confirmed'); assert.equal(st.url, 'https://sklad.bg/hook');
  assert.equal(await fulfilmentEnabled(q, SHOP), true);
  const { key } = await makeFulfilmentKey(q, SHOP);
  await pauseFulfilment(q, SHOP);
  assert.equal(await fulfilmentEnabled(q, SHOP), false);
  assert.equal((await fulfilmentByKey(q, key)).enabled, false);
  assert.equal((await fulfilmentStatus(q, SHOP)).hasKey, true);
});

test('deleting is refused while a sent order is still unshipped', async () => {
  await saveFulfilment(q, SHOP, { url: 'https://sklad.bg/hook' });
  await q(`insert into zd.orders (cb_order_id, name, phone, phone_norm, email, delivery_type, courier, office_id, office_text, city, post_code, address_text, items, total, currency, payment_method, page_url, user_agent, ip, shop_id, status, fulfil_sent_at)
    values ('t:1', 'Иван', '0888', '+359888', '', 'econt_office', 'econt', 'econt:1', 'x', 'София', '', '', '[]', 10, 'EUR', 'cod', '', '', '', $1::uuid, 'confirmed', now())`, [SHOP]);
  await assert.rejects(deleteFulfilment(q, SHOP), /1 поръчки са при склада/);
  await q(`update zd.orders set waybill_number = '123', status = 'shipped'`);
  await deleteFulfilment(q, SHOP);
  assert.equal((await fulfilmentStatus(q, SHOP)).hasKey, false);
  assert.equal(await fulfilmentEnabled(q, SHOP), false);
});

/* ---- orders → warehouse ---- */
const base = { name: 'Мария Иванова', phone: '0888123456', phoneNorm: '+359888123456', email: 'm@x.bg', deliveryType: 'econt_office', courier: 'econt', officeId: 'econt:1127',
  officeText: 'Плевен Център, Плевен (1127)', city: 'Плевен', postCode: '5800', addressText: '', items: [{ name: 'Книга', qty: 2, price: 10 }], total: 22.57, currency: 'EUR', paymentMethod: 'cod',
  pageUrl: '', userAgent: '', ip: '', trafficSource: '', cbCheck: '' };
let seq = 0;
const order = async (patch = {}) => (await insertOrder(q, { ...base, cbOrderId: `t-${++seq}-${Date.now()}`, shopId: SHOP, ...patch })).id;
const setStatus = (id, status) => q(`update zd.orders set status = $2 where id = $1::uuid`, [id, status]);
function warehouse({ status = 200, hang = false } = {}) {
  const calls = [];
  const impl = (url, init) => {
    calls.push({ url: String(url), init });
    if (hang) return new Promise((_, rej) => init.signal?.addEventListener('abort', () => rej(new Error('aborted'))));
    return Promise.resolve({ ok: status < 300, status, json: async () => ({}) });
  };
  return { calls, impl };
}
const connect = async () => { await saveFulfilment(q, SHOP, { url: 'https://sklad.bg/hook' }); return (await makeFulfilmentKey(q, SHOP)).key; };
const quiet = async (fn) => { const err = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = err; } };

test('isDue: confirmed orders, or new ones when sendOn is new or the order is paid; never sent, cancelled or pending ones', () => {
  const cfg = { enabled: true, sendOn: 'confirmed' };
  const o = { status: 'confirmed', fulfil_sent_at: null, waybill_number: '', payment_method: 'cod', cb_check: '' };
  assert.equal(isDue(o, cfg), true);
  assert.equal(isDue({ ...o, status: 'new' }, cfg), false);
  assert.equal(isDue({ ...o, status: 'new' }, { ...cfg, sendOn: 'new' }), true);
  assert.equal(isDue({ ...o, status: 'new', payment_method: 'card' }, cfg), true);
  assert.equal(isDue({ ...o, fulfil_sent_at: new Date() }, cfg), false);
  assert.equal(isDue({ ...o, waybill_number: '123' }, cfg), false);
  assert.equal(isDue({ ...o, status: 'cancelled' }, cfg), false);
  assert.equal(isDue({ ...o, cb_check: 'pending' }, cfg), false);
  assert.equal(isDue(o, { ...cfg, enabled: false }), false);
});

test('the order body carries customer, office, items with SKU from the inventory, total, payment and the tracking page', async () => {
  await q(`insert into zd.product_costs (name, shop_id, sku) values ('Книга', $1::uuid, 'BK-1')`, [SHOP]);
  const id = await order();
  await q(`update zd.orders set is_duplicate = true where id = $1::uuid`, [id]);
  const [row] = await q(`select * from zd.orders where id = $1::uuid`, [id]);
  const b = await buildOrderBody(q, row);
  assert.equal(b.api, 1); assert.equal(b.event, 'order'); assert.equal(b.duplicate, true);
  assert.equal(b.order.id, id); assert.equal(b.order.number, row.cb_order_id); assert.equal(b.order.status, 'new');
  assert.deepEqual(b.order.customer, { name: 'Мария Иванова', phone: '+359888123456', email: 'm@x.bg' });
  assert.deepEqual(b.order.delivery, { type: 'econt_office', courier: 'econt', office: { id: 'econt:1127', code: '1127', text: 'Плевен Център, Плевен (1127)' }, address: null });
  assert.deepEqual(b.order.items, [{ sku: 'BK-1', name: 'Книга', qty: 2, price: 10 }]);
  assert.equal(b.order.total, 22.57); assert.equal(b.order.currency, 'EUR');
  assert.deepEqual(b.order.payment, { method: 'cod', cod_amount: 22.57 });
  assert.match(b.order.tracking_page, /^https:\/\/app\.ordyx\.eu\/p\/[A-Za-z0-9_-]+$/);
});

test('an address order and an "other" order describe the delivery accordingly', async () => {
  const a = await order({ deliveryType: 'speedy_address', courier: 'speedy', officeId: '', officeText: 'Спиди – адрес: ул. Х 1, Варна', city: 'Варна', postCode: '9000', addressText: 'ул. Х 1', paymentMethod: 'card' });
  const [ra] = await q(`select * from zd.orders where id = $1::uuid`, [a]);
  const ba = await buildOrderBody(q, ra);
  assert.deepEqual(ba.order.delivery, { type: 'speedy_address', courier: 'speedy', office: null, address: { city: 'Варна', post_code: '9000', street: 'ул. Х 1' } });
  assert.deepEqual(ba.order.payment, { method: 'card', cod_amount: 0 });
  assert.equal(ba.duplicate, undefined);
  const o = await order({ deliveryType: 'other', courier: 'other', officeId: '', officeText: 'Лично предаване' });
  const [ro] = await q(`select * from zd.orders where id = $1::uuid`, [o]);
  assert.deepEqual((await buildOrderBody(q, ro)).order.delivery, { type: 'other', courier: 'other', office: null, address: null, text: 'Лично предаване' });
});

test('sendEvent posts a signed body to the warehouse and marks the order sent', async () => {
  const key = await connect();
  const id = await order(); await setStatus(id, 'confirmed');
  const w = warehouse();
  assert.equal(await sendEvent(q, id, 'order', { fetchImpl: w.impl }), true);
  assert.equal(w.calls[0].url, 'https://sklad.bg/hook');
  const { headers, body, redirect } = w.calls[0].init;
  assert.equal(redirect, 'manual');
  assert.equal(headers['X-Ordyx-Signature'], createHmac('sha256', key).update(`${headers['X-Ordyx-Timestamp']}.${body}`).digest('hex'));
  assert.equal(JSON.parse(body).order.status, 'confirmed');
  const [r] = await q(`select fulfil_sent_at, fulfil_notify from zd.orders where id = $1::uuid`, [id]);
  assert.ok(r.fulfil_sent_at); assert.equal(r.fulfil_notify, '');
  assert.ok((await fulfilmentStatus(q, SHOP)).lastSentAt);
});

test('a failing warehouse (500, redirect, hang) leaves the order waiting with a readable error', async () => {
  await connect();
  const id = await order(); await setStatus(id, 'confirmed');
  for (const [w, msg] of [[warehouse({ status: 500 }), /складът отговори 500/], [warehouse({ status: 302 }), /пренасочва/], [warehouse({ hang: true }), /не отговаря/]]) {
    assert.equal(await quiet(() => sendEvent(q, id, 'order', { fetchImpl: w.impl, timeoutMs: 50 })), false);
    assert.match((await fulfilmentStatus(q, SHOP)).lastError, msg);
  }
  const [r] = await q(`select fulfil_sent_at, fulfil_notify from zd.orders where id = $1::uuid`, [id]);
  assert.equal(r.fulfil_sent_at, null); assert.equal(r.fulfil_notify, 'order');
});

test('queueFulfilment sends a due order at once and ignores one that is not due; a paid order is due without confirmation', async () => {
  await connect();
  const w = warehouse();
  const fresh = await order();
  await queueFulfilment(q, fresh, { fetchImpl: w.impl });
  assert.equal(w.calls.length, 0);
  await setStatus(fresh, 'confirmed');
  await queueFulfilment(q, fresh, { fetchImpl: w.impl });
  assert.equal(w.calls.length, 1);
  const paid = await order({ paymentMethod: 'card' });
  await queueFulfilment(q, paid, { fetchImpl: w.impl });
  assert.equal(w.calls.length, 2);
  await queueFulfilment(q, paid, { fetchImpl: w.impl }); // already sent
  assert.equal(w.calls.length, 2);
});

test('queueCancel tells the warehouse about a sent order and clears the sent mark; a never-sent order is just forgotten', async () => {
  await connect();
  const w = warehouse();
  const id = await order(); await setStatus(id, 'confirmed');
  await queueFulfilment(q, id, { fetchImpl: w.impl });
  await setStatus(id, 'cancelled');
  await queueCancel(q, id, { fetchImpl: w.impl });
  assert.equal(w.calls.length, 2);
  const [{ cb_order_id }] = await q(`select cb_order_id from zd.orders where id = $1::uuid`, [id]);
  assert.deepEqual(JSON.parse(w.calls[1].init.body), { api: 1, event: 'cancelled', order: { id, number: cb_order_id } });
  const [r] = await q(`select fulfil_sent_at, fulfil_notify from zd.orders where id = $1::uuid`, [id]);
  assert.equal(r.fulfil_sent_at, null); assert.equal(r.fulfil_notify, '');
  const never = await order(); await setStatus(never, 'cancelled');
  await queueCancel(q, never, { fetchImpl: w.impl });
  assert.equal(w.calls.length, 2);
});

test('retryDue sends due and waiting orders oldest first within its budget, skips a shop after one failure, and countDue agrees', async () => {
  await connect();
  const a = await order(); await setStatus(a, 'confirmed');
  const b = await order(); await setStatus(b, 'confirmed');
  await q(`update zd.orders set fulfil_notify = 'order', created_at = now() - interval '1 day' where id = $1::uuid`, [a]);
  assert.equal(await countDue(q, SHOP), 2);
  const bad = warehouse({ status: 500 });
  assert.deepEqual(await quiet(() => retryDue(q, { fetchImpl: bad.impl })), { retried: 1, sent: 0 });
  const good = warehouse();
  assert.deepEqual(await retryDue(q, { fetchImpl: good.impl }), { retried: 2, sent: 2 });
  assert.equal(JSON.parse(good.calls[0].init.body).order.id, a);
  assert.equal(await countDue(q, SHOP), 0);
  const c = await order(); await setStatus(c, 'confirmed');
  assert.deepEqual(await retryDue(q, { fetchImpl: good.impl, budgetMs: -1 }), { retried: 0, sent: 0 });
  assert.deepEqual(await retryDue(q, { fetchImpl: good.impl, max: 1 }), { retried: 1, sent: 1 });
});
