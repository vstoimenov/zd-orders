import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { makeTestQuery } from './helpers/pglite.js';
import { setQueryForTests } from '../lib/db.js';
import { makeShopKey, noteKeyUse, keyStatus } from '../lib/shop-keys.js';
import { upsertExternalOrder, insertOrder, listOrders } from '../lib/orders-repo.js';
import { notifySite, retryCallbacks } from '../lib/woo-callback.js';
import { answerConfirm, confirmLink } from '../lib/confirm.js';
import { saveEcont, createWaybill } from '../lib/waybills.js';

process.env.INTEGRATIONS_SECRET = 'test-secret';
process.env.PUBLIC_BASE_URL = 'https://app.ordyx.eu';
const SHOP = '00000000-0000-4000-8000-000000000001';
let q, key;
beforeEach(async () => {
  q = await makeTestQuery(); setQueryForTests(q);
  await q(`update zd.shops set domain = 'a-shop.bg', name = 'Магазин А' where id = $1`, [SHOP]);
  await q(`insert into zd.offices (id, courier, code, name, city) values ('econt:1107', 'econt', '1107', 'Офис Младост', 'София'), ('econt:1127', 'econt', '1127', 'Плевен Център', 'Плевен')`);
  ({ key } = await makeShopKey(q, SHOP));
  await noteKeyUse(q, SHOP, { restUrl: 'https://www.a-shop.bg/wp-json/', mode: 'checkout' });
});
const base = { name: 'Мария Иванова', phone: '0888123456', phoneNorm: '+359888123456', email: '', deliveryType: 'econt_office', courier: 'econt', officeId: 'econt:1127',
  officeText: 'Плевен Център, Плевен (1127)', city: 'Плевен', postCode: '5800', addressText: '', items: [{ name: 'Книга', qty: 1, price: 20 }], total: 22.57, currency: 'EUR', paymentMethod: 'cod', shopId: SHOP };
const wooOrder = async (wcId = 17) => (await upsertExternalOrder(q, { ...base, cbOrderId: `a-shop.bg:wc-${wcId}`, source: 'woocommerce' })).id;
const shipped = (id) => q(`update zd.orders set status = 'shipped', waybill_number = '1055278971773', waybill_courier = 'econt', waybill_created_at = now() where id = $1::uuid`, [id]);
/** a fake site: records calls; `hang` never answers until the signal aborts */
function site({ hang = false, status = 200 } = {}) {
  const calls = [];
  const impl = (url, init) => {
    calls.push({ url: String(url), init });
    if (!hang) return Promise.resolve({ ok: status < 300, status, json: async () => ({ ok: true }) });
    return new Promise((_, reject) => { init.signal?.addEventListener('abort', () => reject(new Error('aborted'))); });
  };
  return { calls, impl };
}
async function withFetch(impl, fn) {
  const real = globalThis.fetch, err = console.error;
  globalThis.fetch = impl; console.error = () => {};
  try { return await fn(); } finally { globalThis.fetch = real; console.error = err; }
}

test('a shipped WooCommerce order is announced to the site with a signed body and the tracking page', async () => {
  const id = await wooOrder();
  await shipped(id);
  const f = site();
  assert.equal(await withFetch(f.impl, () => notifySite(q, id, 'shipped')), true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://www.a-shop.bg/wp-json/ordyx/v1/order');
  const { headers, body } = f.calls[0].init;
  const ts = headers['X-Ordyx-Timestamp'];
  assert.ok(Math.abs(Number(ts) - Date.now() / 1000) < 5);
  assert.equal(headers['X-Ordyx-Signature'], createHmac('sha256', key).update(`${ts}.${body}`).digest('hex'));
  const b = JSON.parse(body);
  assert.equal(b.api, 1);
  assert.equal(b.event, 'shipped');
  assert.equal(b.wcId, '17');
  assert.equal(b.number, '1055278971773');
  assert.equal(b.courier, 'econt');
  assert.equal(b.courierName, 'Еконт');
  assert.equal(b.trackUrl, 'https://www.econt.com/services/track-shipment/1055278971773');
  assert.match(b.trackingPage, /^https:\/\/app\.ordyx\.eu\/p\/[A-Za-z0-9_-]{30,}$/);
  const [o] = (await listOrders(q)).rows;
  assert.equal(o.confirmation.sent, true, 'the same token the confirmation uses');
});

test('a site on another host is never called; the error shows in the key status', async () => {
  await noteKeyUse(q, SHOP, { restUrl: 'https://evil.example/wp-json/' });
  const id = await wooOrder();
  await shipped(id);
  const f = site();
  assert.equal(await withFetch(f.impl, () => notifySite(q, id, 'shipped')), false);
  assert.equal(f.calls.length, 0);
  assert.match((await keyStatus(q, SHOP)).lastError, /evil\.example/);
});

test('a hanging site gives up after 5 s and a failing one is noted; neither throws', async () => {
  const id = await wooOrder();
  await shipped(id);
  const t0 = Date.now();
  assert.equal(await withFetch(site({ hang: true }).impl, () => notifySite(q, id, 'shipped')), false);
  assert.ok(Date.now() - t0 < 7000);
  assert.equal(await withFetch(site({ status: 500 }).impl, () => notifySite(q, id, 'shipped')), false);
  assert.match((await keyStatus(q, SHOP)).lastError, /500/);
});

test('orders from the checkout widget or ConvertBuilder never trigger a call', async () => {
  const { id } = await insertOrder(q, { ...base, cbOrderId: 'a-shop.bg:5', pageUrl: '', ip: '1' });
  await shipped(id);
  const f = site();
  assert.equal(await withFetch(f.impl, () => notifySite(q, id, 'shipped')), false);
  assert.equal(f.calls.length, 0);
});

test('creating a live waybill calls the site; a slow site does not fail the waybill', async () => {
  const id = await wooOrder(18);
  const calls = [];
  const impl = async (url, init) => {
    const u = String(url);
    if (u.includes('econt.com')) {
      const path = new URL(u).pathname;
      if (path.includes('getClientProfiles')) return { ok: true, status: 200, json: async () => ({ profiles: [{ client: { name: 'ЕТ Консулт', phones: ['359883525008'] }, addresses: [] }] }) };
      if (path.includes('createLabel')) return { ok: true, status: 200, json: async () => ({ label: { shipmentNumber: '1051604331075', totalPrice: 3.78, currency: 'EUR', receiverDueAmount: 3.78, senderDueAmount: 0, pdfURL: 'https://ee.econt.com/x.pdf' } }) };
      return { ok: false, status: 404, json: async () => ({}) };
    }
    calls.push({ url: u, body: JSON.parse(init.body) });
    return new Promise((_, reject) => { init.signal?.addEventListener('abort', () => reject(new Error('aborted'))); });
  };
  await withFetch(impl, () => saveEcont(q, SHOP, { username: 'u', password: 'p', demo: false, senderType: 'office', senderOfficeCode: '1107', senderPhone: '0888888888', payer: 'sender', weight: '1', description: '', review: false }));
  const t0 = Date.now();
  const r = await withFetch(impl, () => createWaybill(q, { orderId: id, scopeShopId: SHOP, input: { weight: 1 } }));
  assert.equal(r.number, '1051604331075');
  assert.ok(Date.now() - t0 < 8000);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.event, 'shipped');
  assert.equal(calls[0].body.wcId, '18');
});

/* ---- review fixes ---- */
test('a buyer refusing the order on the confirmation page cancels it in WooCommerce too', async () => {
  const id = await wooOrder(21);
  const { link } = await confirmLink(q, { orderId: id, scopeShopId: SHOP });
  const f = site();
  await withFetch(f.impl, () => answerConfirm(q, new URL(link).searchParams.get('t'), 'no'));
  assert.equal(f.calls.length, 1);
  assert.equal(JSON.parse(f.calls[0].init.body).event, 'cancelled');
});

test('a callback the site did not take waits on the order and the nightly job retries it', async () => {
  const id = await wooOrder(22);
  await shipped(id);
  await withFetch(site({ status: 500 }).impl, () => notifySite(q, id, 'shipped'));
  assert.equal((await q(`select site_notify from zd.orders where id = $1::uuid`, [id]))[0].site_notify, 'shipped');
  const f = site();
  const r = await withFetch(f.impl, () => retryCallbacks(q));
  assert.deepEqual(r, { retried: 1, delivered: 1 });
  assert.equal(JSON.parse(f.calls[0].init.body).event, 'shipped');
  assert.equal((await q(`select site_notify from zd.orders where id = $1::uuid`, [id]))[0].site_notify, '');
});

test('a site that redirects is reported, never followed with a changed method', async () => {
  const id = await wooOrder(23);
  await shipped(id);
  const f = site({ status: 301 });
  assert.equal(await withFetch(f.impl, () => notifySite(q, id, 'shipped')), false);
  assert.equal(f.calls[0].init.redirect, 'manual');
  assert.match((await keyStatus(q, SHOP)).lastError, /пренасочва/);
});
