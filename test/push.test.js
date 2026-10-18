import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeReq, fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { insertOrder } from '../lib/orders-repo.js';
import { signSession } from '../lib/auth.js';
import { saveSubscription, removeSubscription, notifyNewOrder, setPushSenderForTests, testPush } from '../lib/push.js';
import { processCbOrder } from '../lib/cb-sync.js';
import pushApi from '../lib/admin/push.js';
import orders from '../api/orders.js';

process.env.ADMIN_SECRET = 'secret';
process.env.VAPID_PUBLIC_KEY = 'BPublicKeyForTests';
process.env.VAPID_PRIVATE_KEY = 'private-key-for-tests';
process.env.ORDER_TOKEN = 'tok';
const SHOP = '00000000-0000-4000-8000-000000000001';
const cookie = () => `zdo_admin=${signSession('secret')}`;

let q, sent, answer;
beforeEach(async () => {
  q = await makeTestQuery(); setQueryForTests(q);
  await q(`update zd.shops set domain = 'adhdbg.eu', name = 'adhd' where id = $1`, [SHOP]);
  sent = []; answer = () => ({ statusCode: 201 });
  setPushSenderForTests(async (sub, payload) => { sent.push({ endpoint: sub.endpoint, keys: sub.keys, payload: JSON.parse(payload) }); const a = answer(sub); if (a.statusCode >= 400) throw Object.assign(new Error('push failed'), a); return a; });
});

const sub = (n = 1, host = 'fcm.googleapis.com') => ({ endpoint: `https://${host}/fcm/send/device-${n}`, keys: { p256dh: `p256-${n}`, auth: `auth-${n}` } });
async function addOrder(patch = {}) {
  const r = await insertOrder(q, {
    cbOrderId: `adhdbg.eu:${Math.random()}`, name: 'Мария Иванова', phone: '0888123456', phoneNorm: '+359888123456', email: '',
    deliveryType: 'econt_office', courier: 'econt', officeId: 'econt:5803', officeText: 'ЕКОНТ – офис Плевен (5803), ул. Х', city: 'Плевен', postCode: '5800',
    addressText: '', items: [{ name: 'Книга', qty: 1, price: 20 }], total: 22.57, currency: 'EUR', paymentMethod: 'cod', pageUrl: '', ip: '1', ...patch,
  });
  return r.id;
}
const post = (body) => fakeReq({ method: 'POST', url: '/api/admin/push', headers: { cookie: cookie() }, body });

test('saveSubscription keeps one row per device, only for known push services', async () => {
  await saveSubscription(q, { subscription: sub(1), shopId: null });
  await saveSubscription(q, { subscription: sub(1), shopId: SHOP }); // the same device again: updated, not doubled
  const rows = await q(`select endpoint, shop_id from zd.push_subscriptions`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].shop_id, SHOP);
  await saveSubscription(q, { subscription: sub(2, 'web.push.apple.com'), shopId: null });
  await assert.rejects(saveSubscription(q, { subscription: sub(3, 'evil.example.com'), shopId: null }), /услуга за известия/);
  await assert.rejects(saveSubscription(q, { subscription: { endpoint: 'http://fcm.googleapis.com/x', keys: { p256dh: 'a', auth: 'b' } }, shopId: null }), /услуга за известия/);
  await assert.rejects(saveSubscription(q, { subscription: { endpoint: sub(4).endpoint, keys: {} }, shopId: null }), /ключ/);
  await removeSubscription(q, sub(1).endpoint);
  assert.equal((await q(`select count(*)::int as n from zd.push_subscriptions`))[0].n, 1);
});

test('a new order notifies the devices of its shop and the "all shops" devices', async () => {
  const [other] = await q(`insert into zd.shops (name, domain) values ('Книги за деца', 'knigi.bg') returning id`);
  await saveSubscription(q, { subscription: sub(1), shopId: SHOP });
  await saveSubscription(q, { subscription: sub(2), shopId: null });
  await saveSubscription(q, { subscription: sub(3), shopId: other.id });
  const id = await addOrder();
  await notifyNewOrder(q, id);
  assert.deepEqual(sent.map((s) => s.endpoint).sort(), [sub(1).endpoint, sub(2).endpoint]);
  const p = sent[0].payload;
  assert.equal(p.title, '🛒 Нова поръчка · adhd');
  assert.equal(p.body, 'Мария Иванова · 22,57 € · ЕКОНТ – офис Плевен (5803)');
  assert.equal(p.url, `/admin/?shop=${SHOP}#orders`);
  assert.equal(p.tag, id);
  assert.deepEqual(sent[0].keys, { p256dh: 'p256-1', auth: 'auth-1' });
});

test('a device the push service no longer knows is removed; other failures never break anything', async () => {
  await saveSubscription(q, { subscription: sub(1), shopId: null });
  await saveSubscription(q, { subscription: sub(2), shopId: null });
  answer = (s) => (s.endpoint.endsWith('device-1') ? { statusCode: 410 } : { statusCode: 500 });
  const id = await addOrder();
  const err = console.error; console.error = () => {};
  try { await notifyNewOrder(q, id); } finally { console.error = err; }
  const rows = await q(`select endpoint, failures from zd.push_subscriptions`);
  assert.deepEqual(rows.map((r) => r.endpoint), [sub(2).endpoint]);
  assert.equal(rows[0].failures, 1);
});

test('without push keys nothing is sent and nothing fails', async () => {
  const pub = process.env.VAPID_PUBLIC_KEY; delete process.env.VAPID_PUBLIC_KEY;
  try {
    await saveSubscription(q, { subscription: sub(1), shopId: null });
    await notifyNewOrder(q, await addOrder());
    assert.equal(sent.length, 0);
  } finally { process.env.VAPID_PUBLIC_KEY = pub; }
});

test('a checkout order and a ConvertBuilder order notify once; an update does not', async () => {
  await saveSubscription(q, { subscription: sub(1), shopId: null });
  process.env.ALLOWED_ORIGINS = 'https://adhdbg.eu';
  const res = fakeRes();
  await orders(fakeReq({ method: 'POST', url: '/api/orders', headers: { origin: 'https://adhdbg.eu', 'x-forwarded-for': '9.9.9.9' },
    body: JSON.stringify({ token: 'tok', cb_order_id: '90', name: 'Иван Петров', phone: '0888123456', delivery_type: 'econt_office', office_id: 'econt:5803', office_text: 'ЕКОНТ – офис Плевен (5803)', city: 'Плевен', items: [], total: 10 }) }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(sent.length, 1);
  assert.match(sent[0].payload.body, /^Иван Петров · 10,00 €/);
  const cfg = { store: 'adhdbg.eu', currency: 'EUR', shopId: SHOP };
  const cb = { id: 90, invoiceNo: 1, created: Math.floor(Date.now() / 1000), customerName: 'Иван Петров', customerEmail: '', shippingAddress: { phone: '0888123456', city: 'Плевен', address: 'x' }, total: 10, shippingName: 'Еконт', paymentMethod: 'cod', status: 'pending', items: [] };
  await processCbOrder(q, cfg, cb); // the same order from ConvertBuilder: an update
  assert.equal(sent.length, 1);
  await processCbOrder(q, cfg, { ...cb, id: 91, customerName: 'Нова Клиентка' }); // a new one from ConvertBuilder
  assert.equal(sent.length, 2);
  assert.match(sent[1].payload.body, /^Нова Клиентка/);
});

test('admin route: key, subscribe for the chosen shop or all, test, unsubscribe; needs login', async () => {
  let res = fakeRes();
  await pushApi(fakeReq({ url: '/api/admin/push' }), res);
  assert.equal(res.statusCode, 401);
  res = fakeRes();
  await pushApi(fakeReq({ url: '/api/admin/push', headers: { cookie: cookie() } }), res);
  assert.deepEqual(json(res), { enabled: true, publicKey: 'BPublicKeyForTests', template: DEFAULT_PUSH });
  res = fakeRes();
  await pushApi(fakeReq({ method: 'POST', url: '/api/admin/push?shop=all', headers: { cookie: cookie() }, body: { action: 'subscribe', subscription: sub(1) } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal((await q(`select shop_id from zd.push_subscriptions`))[0].shop_id, null, 'all shops');
  res = fakeRes();
  await pushApi(post({ action: 'subscribe', subscription: sub(2) }), res);
  assert.equal((await q(`select shop_id from zd.push_subscriptions where endpoint = $1`, [sub(2).endpoint]))[0].shop_id, SHOP);
  res = fakeRes();
  await pushApi(post({ action: 'test', endpoint: sub(2).endpoint }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(sent.at(-1).endpoint, sub(2).endpoint);
  assert.match(sent.at(-1).payload.title, /Пробно/);
  res = fakeRes();
  await pushApi(post({ action: 'test', endpoint: 'https://fcm.googleapis.com/unknown' }), res);
  assert.equal(res.statusCode, 400);
  res = fakeRes();
  await pushApi(post({ action: 'status', endpoint: sub(2).endpoint }), res);
  assert.deepEqual(json(res), { ok: true, subscribed: true, shopId: SHOP });
  res = fakeRes();
  await pushApi(post({ action: 'unsubscribe', endpoint: sub(2).endpoint }), res);
  assert.equal(res.statusCode, 200);
  assert.equal((await q(`select count(*)::int as n from zd.push_subscriptions`))[0].n, 1);
});

test('old orders found by a sync never notify (only orders from the last hours do)', async () => {
  await saveSubscription(q, { subscription: sub(1), shopId: null });
  const id = await addOrder();
  await q(`update zd.orders set created_at = now() - interval '3 days' where id = $1`, [id]);
  await notifyNewOrder(q, id);
  assert.equal(sent.length, 0);
});

test('a failing test notification is reported, not "done"', async () => {
  await saveSubscription(q, { subscription: sub(1), shopId: null });
  answer = () => ({ statusCode: 403 });
  const err = console.error; console.error = () => {};
  try { await assert.rejects(testPush(q, sub(1).endpoint), /не стигна/); } finally { console.error = err; }
});

test('a device that keeps failing (e.g. an old key) is dropped after 5 failures', async () => {
  await saveSubscription(q, { subscription: sub(1), shopId: null });
  answer = () => ({ statusCode: 403 });
  const err = console.error; console.error = () => {};
  try { for (let i = 0; i < 5; i++) await notifyNewOrder(q, await addOrder()); } finally { console.error = err; }
  assert.equal((await q(`select count(*)::int as n from zd.push_subscriptions`))[0].n, 0);
});

test('a push service that never answers does not hold the order longer than the limit', async () => {
  await saveSubscription(q, { subscription: sub(1), shopId: null });
  setPushSenderForTests(() => new Promise(() => {}));
  const err = console.error; console.error = () => {};
  const t = Date.now();
  try { await notifyNewOrder(q, await addOrder(), { maxWaitMs: 200 }); } finally { console.error = err; }
  assert.ok(Date.now() - t < 1500);
});

test('"all shops" devices open the orders without switching the shop; a shop device opens its shop', async () => {
  await saveSubscription(q, { subscription: sub(1), shopId: null });
  await saveSubscription(q, { subscription: sub(2), shopId: SHOP });
  await notifyNewOrder(q, await addOrder());
  const byEndpoint = Object.fromEntries(sent.map((s) => [s.endpoint, s.payload.url]));
  assert.equal(byEndpoint[sub(1).endpoint], '/admin/#orders');
  assert.equal(byEndpoint[sub(2).endpoint], `/admin/?shop=${SHOP}#orders`);
});

test('subscribing needs a real shop or "all"; an unknown shop is refused', async () => {
  const res = fakeRes();
  await pushApi(fakeReq({ method: 'POST', url: '/api/admin/push?shop=nonsense', headers: { cookie: cookie() }, body: { action: 'subscribe', subscription: sub(1) } }), res);
  assert.equal(res.statusCode, 400);
});

test('a ConvertBuilder sync of old orders sends nothing', async () => {
  await saveSubscription(q, { subscription: sub(1), shopId: null });
  const { upsertCbOrder } = await import('../lib/orders-repo.js');
  const { mapOrder } = await import('../lib/convertbuilder.js');
  const old = { id: 7, invoiceNo: 1, created: Math.floor(Date.now() / 1000) - 5 * 86400, customerName: 'Стара Поръчка', customerEmail: '', shippingAddress: { phone: '0888123456', city: 'Плевен', address: 'x' }, total: 10, shippingName: 'Еконт', paymentMethod: 'cod', status: 'pending', items: [] };
  const r = await upsertCbOrder(q, { ...mapOrder(old, { store: 'adhdbg.eu', currency: 'EUR' }), shopId: SHOP });
  assert.equal(r.inserted, true);
  await notifyNewOrder(q, r.id);
  assert.equal(sent.length, 0);
});

test('a checkout without any shipping method alerts the shop once every few hours', async () => {
  const { default: visit } = await import('../api/visit.js');
  process.env.ALLOWED_ORIGINS = 'https://adhdbg.eu';
  await saveSubscription(q, { subscription: sub(1), shopId: null });
  const call = async () => { const res = fakeRes(); await visit(fakeReq({ method: 'POST', url: '/api/visit', headers: { origin: 'https://adhdbg.eu', 'user-agent': 'Mozilla/5.0 (iPhone)' }, body: JSON.stringify({ e: 'no_shipping', p: '/store/checkout' }) }), res); return res; };
  assert.equal((await call()).statusCode, 204);
  await call();
  assert.equal(sent.length, 1, 'once, not on every visit');
  assert.match(sent[0].payload.title, /доставка/i);
  assert.match(sent[0].payload.body, /adhdbg\.eu/);
  assert.equal((await q(`select count(*)::int as n from zd.visits`))[0].n, 0, 'the alert is not a visit');
});

/* ---- the shop's own new-order notification text ---- */
import { getPushTemplate, setPushTemplate, DEFAULT_PUSH } from '../lib/push.js';

test('the shop writes its own notification with variables; another shop keeps the default', async () => {
  const [other] = await q(`insert into zd.shops (name, domain) values ('Книги', 'knigi.bg') returning id`);
  await saveSubscription(q, { subscription: sub(1), shopId: null });
  await setPushTemplate(q, SHOP, { title: 'Нова: {сума}', body: '{име} — {продукти} ({брой} бр.) · {телефон} · {доставка}' });
  await notifyNewOrder(q, await addOrder({ items: [{ name: 'Книга', qty: 2, price: 20 }, { name: 'Тетрадка', qty: 1, price: 2 }] }));
  assert.equal(sent[0].payload.title, 'Нова: 22,57 €');
  assert.equal(sent[0].payload.body, 'Мария — Книга, Тетрадка (3 бр.) · +359888123456 · ЕКОНТ – офис Плевен (5803)');
  await notifyNewOrder(q, await addOrder({ shopId: other.id }));
  assert.equal(sent[1].payload.title, '🛒 Нова поръчка · Книги');
});

test('a private text with no personal details; empty parts are dropped', async () => {
  await saveSubscription(q, { subscription: sub(1), shopId: null });
  await setPushTemplate(q, SHOP, { title: '🛒 Нова поръчка в {магазин}', body: '{телефон} · {доставка}' });
  await notifyNewOrder(q, await addOrder({ phoneNorm: '', officeText: '' }));
  assert.equal(sent[0].payload.title, '🛒 Нова поръчка в adhd');
  assert.equal(sent[0].payload.body, '');
});

test('notification text: defaults when empty, limits, one shop only', async () => {
  assert.deepEqual(await getPushTemplate(q, SHOP), DEFAULT_PUSH);
  await setPushTemplate(q, SHOP, { title: '', body: '' });
  assert.deepEqual(await getPushTemplate(q, SHOP), DEFAULT_PUSH);
  await assert.rejects(setPushTemplate(q, SHOP, { title: 'я'.repeat(81), body: '' }), /80/);
  await assert.rejects(setPushTemplate(q, SHOP, { title: 'x', body: 'я'.repeat(201) }), /200/);
  await assert.rejects(setPushTemplate(q, null, { title: 'x' }), /Изберете магазин/);
});

test('admin route: read and save the text for a shop, send it as a test to this device', async () => {
  await saveSubscription(q, { subscription: sub(5), shopId: SHOP });
  const get = fakeRes(); await pushApi(fakeReq({ url: `/api/admin/push?shop=${SHOP}`, headers: { cookie: cookie() } }), get);
  assert.deepEqual(json(get).template, DEFAULT_PUSH);
  const save = fakeRes(); await pushApi(fakeReq({ method: 'POST', url: `/api/admin/push?shop=${SHOP}`, headers: { cookie: cookie() }, body: JSON.stringify({ action: 'template', title: 'Поръчка {сума}', body: '{пълно_име}' }) }), save);
  assert.equal(save.statusCode, 200);
  const all = fakeRes(); await pushApi(fakeReq({ method: 'POST', url: '/api/admin/push?shop=all', headers: { cookie: cookie() }, body: JSON.stringify({ action: 'template', title: 'x', body: '' }) }), all);
  assert.equal(all.statusCode, 400);
  const t = fakeRes(); await pushApi(fakeReq({ method: 'POST', url: `/api/admin/push?shop=${SHOP}`, headers: { cookie: cookie() }, body: JSON.stringify({ action: 'template_test', endpoint: sub(5).endpoint }) }), t);
  assert.equal(t.statusCode, 200);
  assert.equal(sent.at(-1).payload.title, 'Поръчка 24,90 €');
  assert.equal(sent.at(-1).payload.body, 'Мария Примерова');
});
