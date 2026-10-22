import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeReq, fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { makeShopKey, keyStatus, resetKeyLimitsForTests } from '../lib/shop-keys.js';
import { insertOrder, listOrders } from '../lib/orders-repo.js';
import { saveSubscription, setPushSenderForTests } from '../lib/push.js';
import orders from '../api/orders.js';

process.env.INTEGRATIONS_SECRET = 'test-secret';
process.env.ORDER_TOKEN = 'tok';
process.env.ALLOWED_ORIGINS = 'https://a-shop.bg';
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

const SITE = JSON.stringify({ restUrl: 'https://a-shop.bg/wp-json/', mode: 'checkout', version: '1.0.0' });
const order = (patch = {}) => ({
  source: 'woocommerce', external_id: 17, name: 'Мария Иванова', phone: '0888123456', email: 'm@x.bg', delivery_type: 'econt_office',
  office_id: 'econt:1127', office_text: 'ЕКОНТ – офис Плевен (1127)', city: 'Плевен', post_code: '5800',
  items: [{ name: 'Тениска — M, черна', qty: 2, price: 15, sku: 'T-M-B' }], total: 34.4, currency: 'EUR', paid: false, ...patch,
});
async function call(key, { method = 'POST', body, site = SITE } = {}) {
  const res = fakeRes();
  const headers = { authorization: `Bearer ${key}`, 'x-forwarded-for': '5.5.5.5', ...(site ? { 'x-ordyx-site': site } : {}) };
  await orders(fakeReq({ method, url: '/api/orders', headers, body: body === undefined ? undefined : JSON.stringify(body) }), res);
  return res;
}
const rows = () => q(`select * from zd.orders order by created_at`);

test('"Провери връзката": the key answers with its shop and remembers the site', async () => {
  const { key } = await makeShopKey(q, SHOP);
  assert.match(key, /^ordyx_live_[A-Za-z0-9]{10}_[A-Za-z0-9_-]{32}$/);
  const res = await call(key, { method: 'GET' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(json(res), { ok: true, shop: { name: 'Магазин А', domain: 'a-shop.bg' } });
  const st = await keyStatus(q, SHOP);
  assert.equal(st.hasKey, true);
  assert.equal(st.restUrl, 'https://a-shop.bg/wp-json/');
  assert.equal(st.mode, 'checkout');
  assert.equal(st.pluginVersion, '1.0.0');
  assert.ok(!JSON.stringify(st).includes(key.split('_').at(-1)));
});

test('an order with the key lands in that shop as a WooCommerce order', async () => {
  const { key } = await makeShopKey(q, SHOP);
  const res = await call(key, { body: order() });
  assert.equal(res.statusCode, 200);
  assert.equal(json(res).inserted, true);
  const [o] = await rows();
  assert.equal(o.shop_id, SHOP);
  assert.equal(o.cb_order_id, 'a-shop.bg:wc-17');
  assert.equal(o.source, 'woocommerce');
  assert.equal(o.payment_method, 'cod');
  assert.equal(o.office_id, 'econt:1127');
  assert.ok((await keyStatus(q, SHOP)).lastOrderAt);
});

test('a renewed key refuses the old one; an unknown key is refused', async () => {
  const { key: old } = await makeShopKey(q, SHOP);
  const { key } = await makeShopKey(q, SHOP);
  assert.equal((await call(old, { body: order() })).statusCode, 401);
  assert.equal((await call('ordyx_live_AAAAAAAAAA_' + 'x'.repeat(32), { body: order() })).statusCode, 401);
  assert.equal((await call(key, { body: order() })).statusCode, 200);
});

test('a key writes only into its own shop', async () => {
  const { key } = await makeShopKey(q, SHOP_B);
  await call(key, { body: order({ shop_id: SHOP, domain: 'a-shop.bg' }) });
  const [o] = await rows();
  assert.equal(o.shop_id, SHOP_B);
  assert.equal(o.cb_order_id, 'b-shop.bg:wc-17');
});

test('a shop that waits for approval takes no orders', async () => {
  await q(`update zd.shops set approved = false where id = $1`, [SHOP_B]);
  const { key } = await makeShopKey(q, SHOP_B);
  const res = await call(key, { body: order() });
  assert.equal(res.statusCode, 403);
  assert.match(json(res).error, /одобрение/);
});

test('sending the same order again updates it — never a second order; once it has a waybill nothing changes', async () => {
  const { key } = await makeShopKey(q, SHOP);
  await call(key, { body: order() });
  const again = await call(key, { body: order({ items: [{ name: 'Тениска — L', qty: 1, price: 15 }], total: 19.4 }) });
  assert.equal(json(again).inserted, false);
  let all = await rows();
  assert.equal(all.length, 1);
  assert.equal(Number(all[0].total), 19.4);
  await q(`update zd.orders set waybill_number = '1055', status = 'shipped'`);
  const locked = await call(key, { body: order({ total: 99 }) });
  assert.equal(json(locked).locked, true);
  all = await rows();
  assert.equal(Number(all[0].total), 19.4);
});

test('parallel sends of one order make one order', async () => {
  const { key } = await makeShopKey(q, SHOP);
  await Promise.all([call(key, { body: order() }), call(key, { body: order() }), call(key, { body: order() })]);
  assert.equal((await rows()).length, 1);
});

test('a paid order has no cash on delivery', async () => {
  const { key } = await makeShopKey(q, SHOP);
  await call(key, { body: order({ paid: true }) });
  assert.equal((await rows())[0].payment_method, 'card');
});

test('cancelled in WooCommerce: cancelled in Ordyx before a waybill; after one the shop is told', async () => {
  const { key } = await makeShopKey(q, SHOP);
  await call(key, { body: order() });
  const res = await call(key, { body: { source: 'woocommerce', external_id: 17, status: 'cancelled' } });
  assert.equal(res.statusCode, 200);
  assert.equal((await rows())[0].status, 'cancelled');
  await call(key, { body: order({ external_id: 18 }) });
  await q(`update zd.orders set waybill_number = '1056', status = 'shipped' where cb_order_id = 'a-shop.bg:wc-18'`);
  sent.length = 0;
  await call(key, { body: { source: 'woocommerce', external_id: 18, status: 'cancelled' } });
  const [o] = await q(`select status, external_status from zd.orders where cb_order_id = 'a-shop.bg:wc-18'`);
  assert.equal(o.status, 'shipped');
  assert.equal(o.external_status, 'cancelled');
  assert.ok(sent.some((p) => /отказана в WooCommerce/.test(p.title)));
});

test('Econt to an address needs the city and address; an order with an unknown courier needs neither', async () => {
  const { key } = await makeShopKey(q, SHOP);
  const bad = await call(key, { body: order({ external_id: 30, delivery_type: 'econt_address', office_id: '', office_text: '', city: '', address_text: '' }) });
  assert.equal(bad.statusCode, 400);
  const good = await call(key, { body: order({ external_id: 31, delivery_type: 'econt_address', office_id: '', office_text: '', city: 'Варна', post_code: '9000', address_text: 'ул. Тайна 5' }) });
  assert.equal(good.statusCode, 200);
  const other = await call(key, { body: order({ external_id: 32, delivery_type: 'other', office_id: '', office_text: 'Flat rate', city: '', address_text: '' }) });
  assert.equal(other.statusCode, 200);
  const types = (await rows()).map((r) => [r.delivery_type, r.courier]);
  assert.deepEqual(types, [['econt_address', 'econt'], ['other', 'other']]);
});

test('a key may send at most 600 requests an hour', async () => {
  const { key } = await makeShopKey(q, SHOP);
  let last;
  for (let i = 0; i < 601; i++) last = await call(key, { method: 'GET', site: null });
  assert.equal(last.statusCode, 429);
});

/* ---- review fixes ---- */
test('a cash-on-delivery order stays cash on delivery when re-sent after the shop marked it paid', async () => {
  const { key } = await makeShopKey(q, SHOP);
  await call(key, { body: order({ payment_method: 'cod', paid: false }) });
  await call(key, { body: order({ payment_method: 'cod', paid: true }) }); // WooCommerce: processing → is_paid() true
  assert.equal((await rows())[0].payment_method, 'cod');
  await call(key, { body: order({ payment_method: 'card', paid: true }) });
  assert.equal((await rows())[0].payment_method, 'cod', 'never cod → card on an update');
  await call(key, { body: order({ external_id: 18, payment_method: 'card', paid: true }) });
  assert.equal((await rows())[1].payment_method, 'card');
});

test('the public widget path cannot take a WooCommerce or API id', async () => {
  const res = fakeRes();
  await orders(fakeReq({ method: 'POST', url: '/api/orders', headers: { origin: 'https://a-shop.bg', 'x-forwarded-for': '7.7.7.7' },
    body: JSON.stringify({ token: 'tok', cb_order_id: 'wc-50', name: 'X', phone: '0888123456', delivery_type: 'econt_office', office_text: 'офис', items: [], total: 1 }) }), res);
  assert.equal(res.statusCode, 400);
  assert.equal((await rows()).length, 0);
});

test('a keyed send onto an order of another source is refused with 409, not silently locked', async () => {
  await insertOrder(q, { cbOrderId: 'a-shop.bg:wc-7', name: 'Друг', phone: '0888123456', phoneNorm: '+359888123456', email: '', deliveryType: 'econt_office', courier: 'econt',
    officeId: '', officeText: 'офис', city: '', postCode: '', addressText: '', items: [], total: 1, currency: 'EUR', paymentMethod: 'cod', pageUrl: '', ip: '1', shopId: SHOP });
  const { key } = await makeShopKey(q, SHOP);
  const res = await call(key, { body: order({ external_id: 7 }) });
  assert.equal(res.statusCode, 409);
});

test('a re-send keeps the courier and office the shop chose in Ordyx for an order that came without one', async () => {
  const { key } = await makeShopKey(q, SHOP);
  await call(key, { body: order({ external_id: 40, delivery_type: 'other', office_id: '', office_text: 'Flat rate', city: 'София', address_text: '' }) });
  await q(`update zd.orders set delivery_type = 'econt_office', courier = 'econt', office_id = 'econt:1107', office_text = 'Офис Младост, София (1107)' where cb_order_id = 'a-shop.bg:wc-40'`);
  await call(key, { body: order({ external_id: 40, delivery_type: 'other', office_id: '', office_text: 'Flat rate', city: 'София', address_text: '', total: 40 }) });
  const [o] = await rows();
  assert.equal(o.delivery_type, 'econt_office');
  assert.equal(o.office_id, 'econt:1107');
  assert.equal(Number(o.total), 40);
});

test('"cancelled in WooCommerce after shipping" shows on the order for the admin', async () => {
  const { key } = await makeShopKey(q, SHOP);
  await call(key, { body: order() });
  await q(`update zd.orders set waybill_number = '1056', status = 'shipped'`);
  await call(key, { body: { source: 'woocommerce', external_id: 17, status: 'cancelled' } });
  assert.equal((await listOrders(q)).rows[0].externalStatus, 'cancelled');
  sent.length = 0;
  await call(key, { body: { source: 'woocommerce', external_id: 17, status: 'cancelled' } });
  assert.equal(sent.length, 0, 'told once');
});
