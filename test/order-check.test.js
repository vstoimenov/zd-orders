import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeReq, fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { listOrders } from '../lib/orders-repo.js';
import { saveIntegration } from '../lib/integrations-repo.js';
import { saveSubscription, setPushSenderForTests } from '../lib/push.js';
import { saveProduct } from '../lib/stock.js';
import { getStats } from '../lib/stats.js';
import { cbConfig, processCbOrder } from '../lib/cb-sync.js';
import { sendOrderConfirmation } from '../lib/whatsapp.js';
import orders from '../api/orders.js';

process.env.INTEGRATIONS_SECRET = 'test-secret';
process.env.ORDER_TOKEN = 'tok';
process.env.META_APP_ID = '1136036008845539';
process.env.META_APP_SECRET = 'app-secret';
process.env.WHATSAPP_CONFIG_ID = '999000111';
process.env.VAPID_PUBLIC_KEY = 'B'; process.env.VAPID_PRIVATE_KEY = 'p';
process.env.PUBLIC_BASE_URL = 'https://kurier.profitbrand.online';
delete process.env.NEKOREKTEN_API_KEY;
const SHOP = '00000000-0000-4000-8000-000000000001';
const ORIGIN = 'https://a-shop.bg';

let q, cbList, cbDown, waSent, pushed;
const ok = (d) => ({ ok: true, status: 200, json: async () => d });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.host === 'a-shop.bg' && u.pathname === '/api/site/orders') {
    if (cbDown) throw new Error('network down');
    return ok({ items: cbList, totalCount: cbList.length });
  }
  if (u.host === 'graph.facebook.com' && u.pathname.endsWith('/messages')) { waSent.push(JSON.parse(init.body).to); return ok({ messages: [{ id: 'wamid.1' }] }); }
  return { ok: false, status: 400, json: async () => ({ error: { message: `unexpected ${u}` } }) };
};

const cbOrder = (patch = {}) => ({
  id: 82, invoiceNo: 60, created: Math.floor(Date.now() / 1000), customerName: 'Мария Иванова', customerEmail: '',
  shippingAddress: { phone: '+359888123456', city: 'Плевен', zipCode: '5800', address: 'ЕКОНТ – офис Плевен (5803)' },
  total: 22.57, shippingName: 'Доставка до офис на Еконт', paymentMethod: 'cod', status: 'pending',
  items: [{ name: 'Книга', quantity: 1, total: 20 }], ...patch,
});
const widget = (patch = {}) => JSON.stringify({
  token: 'tok', cb_order_id: '82', name: 'Мария Иванова', phone: '0888123456', delivery_type: 'econt_office',
  office_id: 'econt:5803', office_text: 'ЕКОНТ – офис Плевен (5803)', city: 'Плевен', items: [{ name: 'Книга', qty: 1, price: 20 }], total: 22.57, ...patch,
});
let ipN = 0;
async function post(patch) {
  const res = fakeRes();
  await orders(fakeReq({ method: 'POST', url: '/api/orders', headers: { origin: ORIGIN, 'x-forwarded-for': `9.9.9.${++ipN}` }, body: widget(patch) }), res);
  assert.equal(res.statusCode, 200, res.body);
  return json(res);
}
const only = async () => { const { rows } = await listOrders(q, { shopId: SHOP }); assert.equal(rows.length, 1); return rows[0]; };
const stock = async () => Number((await q(`select stock from zd.product_costs where name = 'Книга'`))[0].stock);

beforeEach(async () => {
  q = await makeTestQuery(); setQueryForTests(q);
  await q(`update zd.shops set domain = 'a-shop.bg', name = 'Магазин А' where id = $1`, [SHOP]);
  await saveIntegration(q, 'convertbuilder', { config: { domain: 'a-shop.bg', store: 'a-shop.bg', currency: 'EUR', active: true }, secret: 'K', shopId: SHOP });
  await saveIntegration(q, 'whatsapp', {
    config: { wabaId: '102290129340398', phoneNumberId: '106540352242922', templateStatus: 'APPROVED', autoConfirm: true, active: true },
    secret: JSON.stringify({ token: 'T', pin: '123456' }), shopId: SHOP,
  });
  await saveProduct(q, { name: 'Книга', stock: 10 }, { create: true, shopId: SHOP });
  await q(`update zd.product_costs set tracked_since = now() - interval '1 day'`);
  cbList = []; cbDown = false; waSent = []; pushed = [];
  setPushSenderForTests(async (s, payload) => { pushed.push(JSON.parse(payload)); return { statusCode: 201 }; });
  await saveSubscription(q, { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/owner', keys: { p256dh: 'p', auth: 'a' } }, shopId: null });
});

test('an order ConvertBuilder knows goes through as before: message, notification, stock', async () => {
  cbList = [cbOrder()];
  await post();
  const o = await only();
  assert.equal(o.cbCheck, 'ok');
  assert.deepEqual(waSent, ['359888123456']);
  assert.equal(pushed.length, 1);
  assert.equal(await stock(), 9);
});

test('an order ConvertBuilder does not know is kept aside: no message, no notification, no stock, not in the figures', async () => {
  cbList = [cbOrder({ id: 81 }), cbOrder({ shippingAddress: { phone: '+359877000000' } })]; // other number / same number, other phone
  await post();
  const o = await only();
  assert.equal(o.cbCheck, 'pending');
  assert.deepEqual(waSent, []);
  assert.equal(pushed.length, 0);
  assert.equal(await stock(), 10);
  const today = new Date().toISOString().slice(0, 10);
  const s = await getStats(q, { from: today, to: today, shopId: SHOP });
  assert.equal(s.cards.orders, 0);
});

test('when ConvertBuilder cannot be asked, the order waits for its webhook instead of acting', async () => {
  cbDown = true;
  const err = console.error, warn = console.warn; console.error = () => {}; console.warn = () => {};
  try { await post(); } finally { console.error = err; console.warn = warn; }
  assert.equal((await only()).cbCheck, 'pending');
  assert.deepEqual(waSent, []);
});

test('the signed ConvertBuilder webhook later brings it: it becomes a normal order and the automatic steps run once', async () => {
  await post();
  assert.equal((await only()).cbCheck, 'pending');
  const cfg = await cbConfig(q, SHOP);
  await processCbOrder(q, cfg, cbOrder());
  assert.equal((await only()).cbCheck, 'ok');
  assert.deepEqual(waSent, ['359888123456']);
  assert.equal(pushed.length, 1);
  assert.equal(await stock(), 9);
  await processCbOrder(q, cfg, cbOrder()); // order_updated later
  assert.equal(waSent.length, 1);
  assert.equal(pushed.length, 1);
});

test('ConvertBuilder first, then the widget adds the office: verified, automatic steps once', async () => {
  const cfg = await cbConfig(q, SHOP);
  await processCbOrder(q, cfg, cbOrder());
  await post();
  const o = await only();
  assert.equal(o.cbCheck, 'ok');
  assert.equal(o.officeId, 'econt:5803');
  assert.equal(waSent.length, 1);
  assert.equal(pushed.length, 1);
});

test('the shop can still send the confirmation by hand for an order kept aside', async () => {
  await post();
  const o = await only();
  assert.deepEqual(await sendOrderConfirmation(q, o.id, { force: true }), { sent: true });
  assert.deepEqual(waSent, ['359888123456']);
});

/* ---- shops without a ConvertBuilder connection: automatic messages within limits ---- */
async function unconnected() { await q(`delete from zd.integrations where provider = 'convertbuilder'`); }

test('without ConvertBuilder the order is taken and confirmed automatically, as before', async () => {
  await unconnected();
  await post();
  const o = await only();
  assert.equal(o.cbCheck, '');
  assert.deepEqual(waSent, ['359888123456']);
  assert.equal(pushed.length, 1);
  assert.equal(await stock(), 9);
});

test('without ConvertBuilder no automatic message goes to a number outside Bulgarian mobiles', async () => {
  await unconnected();
  await post({ phone: '+44 7700 900123' });
  assert.deepEqual(waSent, []);
});

test('without ConvertBuilder one number gets at most one automatic message a day', async () => {
  await unconnected();
  await post({ cb_order_id: '90' });
  await post({ cb_order_id: '91' });
  assert.deepEqual(waSent, ['359888123456']);
});

test('without ConvertBuilder a shop sends at most 30 automatic messages an hour', async () => {
  await unconnected();
  for (let i = 0; i < 30; i++) {
    await q(`insert into zd.orders (cb_order_id, name, phone, phone_norm, delivery_type, courier, items, total, currency, shop_id, wa_auto_at)
             values ($1, 'Х', '0888', $2, 'econt_office', 'econt', '[]', 1, 'EUR', $3::uuid, now() - interval '10 minutes')`, [`a-shop.bg:x${i}`, `+3598870000${String(i).padStart(2, '0')}`, SHOP]);
  }
  await post({ cb_order_id: '95' });
  assert.deepEqual(waSent, []);
});

/* ---- review fixes ---- */
import { insertOrder, upsertCbOrder, pendingNekorekten } from '../lib/orders-repo.js';
import { mapOrder } from '../lib/convertbuilder.js';
import { syncOrders, confirmKeptAside } from '../lib/cb-sync.js';
import { recipients } from '../lib/campaigns.js';

test('a forged order that took the next number with another phone is replaced by the real ConvertBuilder order', async () => {
  await post({ phone: '0877555666', name: 'Измамник', office_text: 'СПИДИ – офис Чужд (1)', office_id: 'speedy:1', delivery_type: 'speedy_office' }); // kept aside
  await processCbOrder(q, await cbConfig(q, SHOP), cbOrder()); // the real customer's order with the same number
  const o = await only();
  assert.equal(o.cbCheck, 'ok');
  assert.equal(o.phoneNorm, '+359888123456');
  assert.equal(o.name, 'Мария Иванова');
  assert.notEqual(o.officeId, 'speedy:1');
  assert.deepEqual(waSent, ['359888123456'], 'the real customer, never the forged phone');
});

test('webhook and widget at the same moment: the real order is started exactly once', async () => {
  const cfg = await cbConfig(q, SHOP);
  // the webhook found nothing to confirm, then the widget's row landed, then the webhook's upsert ran
  await insertOrder(q, { ...widgetOrder(), cbCheck: 'pending' });
  const o = { ...mapOrder(cbOrder(), { store: 'a-shop.bg', currency: 'EUR' }), shopId: SHOP };
  const r = await upsertCbOrder(q, o);
  assert.equal(r.inserted, false);
  // whoever confirms first starts it; the other one finds nothing to confirm
  assert.equal(await confirmKeptAside(q, 'a-shop.bg:82', SHOP, '+359888123456'), true);
  assert.equal(await confirmKeptAside(q, 'a-shop.bg:82', SHOP, '+359888123456'), false);
  assert.equal((await only()).cbCheck, 'ok');
  void cfg;
});

test('the ConvertBuilder upsert leaves a kept-aside order for the confirming step (never silently verified)', async () => {
  await insertOrder(q, { ...widgetOrder(), cbCheck: 'pending' });
  await upsertCbOrder(q, { ...mapOrder(cbOrder(), { store: 'a-shop.bg', currency: 'EUR' }), shopId: SHOP });
  assert.equal((await only()).cbCheck, 'pending');
});

test('orders kept aside are not checked on nekorekten and not in campaigns', async () => {
  await post();
  assert.deepEqual(await pendingNekorekten(q, 10), []);
  assert.deepEqual(await recipients(q, SHOP, { statuses: ['new'] }), []);
});

test('nobody can change the office of a real order by sending its number without its phone', async () => {
  await processCbOrder(q, await cbConfig(q, SHOP), cbOrder());
  await post({ phone: '0877555666', office_id: 'speedy:1', office_text: 'СПИДИ – офис Чужд (1)', delivery_type: 'speedy_office' });
  const o = await only();
  assert.equal(o.officeId, '');
  assert.equal(o.phoneNorm, '+359888123456');
});

test('the nightly sync confirming a kept-aside order starts it fully', async () => {
  await post();
  cbList = [cbOrder()];
  await syncOrders(q, { shopId: SHOP });
  assert.equal((await only()).cbCheck, 'ok');
  assert.deepEqual(waSent, ['359888123456']);
  assert.equal(await stock(), 9);
});

function widgetOrder() {
  return {
    cbOrderId: 'a-shop.bg:82', name: 'Мария Иванова', phone: '0888123456', phoneNorm: '+359888123456', email: '', deliveryType: 'econt_office', courier: 'econt',
    officeId: 'econt:5803', officeText: 'ЕКОНТ – офис Плевен (5803)', city: 'Плевен', postCode: '5800', addressText: '', items: [{ name: 'Книга', qty: 1, price: 20 }],
    total: 22.57, currency: 'EUR', paymentMethod: 'cod', pageUrl: '', ip: '1', shopId: SHOP,
  };
}
