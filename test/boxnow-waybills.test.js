import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeReq, fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { insertOrder, listOrders } from '../lib/orders-repo.js';
import { getSecret, saveIntegration } from '../lib/integrations-repo.js';
import { signSession } from '../lib/auth.js';
import { clearBoxnowTokens } from '../lib/boxnow-api.js';
import { saveBoxnow, boxnowStatus, createWaybill, cancelWaybill, previewWaybill, waybillDefaults, syncBoxnowStatuses } from '../lib/waybills.js';
import waybillsApi from '../lib/admin/waybills.js';
import integrationsApi from '../lib/admin/integrations.js';

process.env.INTEGRATIONS_SECRET = 'test-secret';
process.env.ADMIN_SECRET = 'secret';
const SHOP = '00000000-0000-4000-8000-000000000001';
const cookie = () => `zdo_admin=${signSession('secret')}`;

let q;
beforeEach(async () => {
  q = await makeTestQuery(); setQueryForTests(q); clearBoxnowTokens();
  await q(`update zd.shops set domain = 'adhdbg.eu' where id = $1`, [SHOP]);
  await q(`insert into zd.offices (id, courier, code, name, city, is_automat) values ('boxnow:1840', 'boxnow', '1840', 'New Avenue, ул. Храбър Попов 14', 'София', true)`);
});

const reply = (status, body, type = 'application/json') => ({
  ok: status < 300, status, headers: new Map([['content-type', type]]),
  json: async () => { if (typeof body === 'string') throw new Error('not json'); return body; },
  arrayBuffer: async () => new TextEncoder().encode(String(body)).buffer,
});

/** fake BOX NOW Partner API: answers by path, records calls */
function boxnowApi(handlers = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const u = new URL(String(url));
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ host: u.origin, path: u.pathname, query: Object.fromEntries(u.searchParams), method: init.method || 'GET', body });
    for (const [k, h] of Object.entries(handlers)) if (u.pathname.includes(k)) return h({ body, query: Object.fromEntries(u.searchParams) });
    if (u.pathname === '/api/v1/auth-sessions') return body?.client_secret === 'sec' ? reply(200, { access_token: 'T', expires_in: 3600 }) : reply(401, { message: 'bad' });
    if (u.pathname === '/api/v1/origins') {
      return reply(200, { data: u.searchParams.get('locationType') === 'any-apm' ? [{ id: 'ANY', type: 'any-apm' }] : [{ id: 'W1', name: 'Склад Плевен', addressLine1: 'ул. Х 1', addressLine2: 'Плевен' }] });
    }
    if (u.pathname === '/api/v1/delivery-requests') return reply(200, { id: 'R1', parcels: [{ id: '2270192741' }] });
    if (u.pathname.endsWith(':cancel')) return reply(200, {});
    if (u.pathname.endsWith('/label.pdf')) return reply(200, '%PDF-1.4 boxnow', 'application/pdf');
    return reply(404, { code: 'X', message: 'not found' });
  };
  return { calls, impl };
}
async function withFetch(impl, fn) {
  const real = globalThis.fetch, err = console.error;
  globalThis.fetch = impl; console.error = () => {};
  try { return await fn(); } finally { globalThis.fetch = real; console.error = err; }
}
const body = { clientId: 'cid', secret: 'sec', demo: false, originType: 'warehouse', originId: 'W1', senderName: 'Профитбранд', senderPhone: '0899111222', senderEmail: 'shop@x.bg', weight: '1' };
async function connect(patch = {}) { await withFetch(boxnowApi().impl, () => saveBoxnow(q, SHOP, { ...body, ...patch })); }
async function addOrder(patch = {}) {
  const r = await insertOrder(q, {
    cbOrderId: `adhdbg.eu:${Math.random()}`, name: 'Мария Иванова', phone: '0888123456', phoneNorm: '+359888123456', email: 'm@x.bg',
    deliveryType: 'boxnow_locker', courier: 'boxnow', officeId: 'boxnow:1840', officeText: 'BOX NOW – автомат New Avenue (1840), ул. Храбър Попов 14', city: 'София', postCode: '1700',
    addressText: '', items: [{ name: 'Книга', qty: 1, price: 20 }], total: 22.57, currency: 'EUR', paymentMethod: 'cod', pageUrl: '', ip: '1', ...patch,
  });
  return r.id;
}
const orderById = async (id) => (await listOrders(q)).rows.find((o) => o.id === id);

test('saveBoxnow checks the login at BOX NOW, seals the secret, keeps where parcels start; the checkout switch stays as it was', async () => {
  await saveIntegration(q, 'boxnow', { config: { checkout: true }, shopId: SHOP });
  await connect();
  assert.deepEqual(JSON.parse(await getSecret(q, 'boxnow', SHOP)), { username: 'cid', password: 'sec' });
  const s = await boxnowStatus(q, SHOP);
  assert.equal(s.connected, true);
  assert.deepEqual(s.sender, { type: 'warehouse', text: 'Склад Плевен, ул. Х 1, Плевен' });
  assert.equal(s.checkout, true, 'saving waybill settings never touches the checkout switch');
  assert.ok(!JSON.stringify(s).includes('sec"'));
});

test('saveBoxnow refuses a wrong secret, an unknown warehouse, a missing size for "any locker", a missing phone', async () => {
  await assert.rejects(withFetch(boxnowApi().impl, () => saveBoxnow(q, SHOP, { ...body, secret: 'nope' })), /Client ID или Client Secret/);
  await assert.rejects(withFetch(boxnowApi().impl, () => saveBoxnow(q, SHOP, { ...body, originId: 'W9' })), /склад/);
  await assert.rejects(withFetch(boxnowApi().impl, () => saveBoxnow(q, SHOP, { ...body, originType: 'any-apm', size: '' })), /размер/);
  await assert.rejects(withFetch(boxnowApi().impl, () => saveBoxnow(q, SHOP, { ...body, senderPhone: '' })), /телефон/);
  await withFetch(boxnowApi().impl, () => saveBoxnow(q, SHOP, { ...body, originType: 'any-apm', size: '2' }));
  assert.deepEqual((await boxnowStatus(q, SHOP)).sender, { type: 'any-apm', text: 'Пускате пратките в автомат на BOX NOW' });
});

test('test mode uses only the stage host and the stored secret only for the mode it was saved in', async () => {
  const f = boxnowApi();
  await withFetch(f.impl, () => saveBoxnow(q, SHOP, { ...body, demo: true }));
  assert.ok(f.calls.every((c) => c.host === 'https://api-stage.boxnow.bg'));
  await assert.rejects(withFetch(boxnowApi().impl, () => saveBoxnow(q, SHOP, { ...body, secret: '', demo: false })), /Client Secret/);
});

test('a BOX NOW order: window values, no price preview, the waybill; the order is shipped and prints through Ordyx', async () => {
  await connect();
  const id = await addOrder();
  const d = await waybillDefaults(q, { orderId: id, scopeShopId: SHOP });
  assert.deepEqual([d.connected, d.courier, d.courierName, d.cod, d.weight, d.officeText], [true, 'boxnow', 'BOX NOW', 22.57, 1, 'New Avenue, ул. Храбър Попов 14, София (1840)']);
  const p = await withFetch(boxnowApi().impl, () => previewWaybill(q, { orderId: id, scopeShopId: SHOP, input: {} }));
  assert.equal(p.price, null);
  const f = boxnowApi();
  const w = await withFetch(f.impl, () => createWaybill(q, { orderId: id, scopeShopId: SHOP, input: {} }));
  assert.equal(w.number, '2270192741');
  const req = f.calls.find((c) => c.path === '/api/v1/delivery-requests').body;
  assert.deepEqual([req.destination.locationId, req.origin.locationId, req.paymentMode, req.amountToBeCollected], ['1840', 'W1', 'cod', '22.57']);
  const o = await orderById(id);
  assert.equal(o.status, 'shipped');
  assert.equal(o.shipment.pdf, `/api/admin/waybills?pdf=${id}&shop=${SHOP}`);
  const res = fakeRes();
  await withFetch(boxnowApi().impl, () => waybillsApi(fakeReq({ method: 'GET', url: `/api/admin/waybills?pdf=${id}&shop=${SHOP}`, headers: { cookie: cookie() } }), res));
  assert.equal(res.statusCode, 200);
  assert.equal(Buffer.from(res.body).toString(), '%PDF-1.4 boxnow');
});

test('BOX NOW: a clear refusal frees the order; an unclear answer blocks it until someone checks', async () => {
  await connect();
  const a = await addOrder(), b = await addOrder();
  await assert.rejects(withFetch(boxnowApi({ '/delivery-requests': () => reply(400, { code: 'P411', message: 'no cod' }) }).impl,
    () => createWaybill(q, { orderId: a, scopeShopId: SHOP, input: {} })), /наложен платеж/);
  assert.equal((await orderById(a)).waybillState, '', 'free for another try');
  await assert.rejects(withFetch(boxnowApi({ '/delivery-requests': () => reply(502, 'Bad gateway') }).impl,
    () => createWaybill(q, { orderId: b, scopeShopId: SHOP, input: {} })), /Partner Portal/);
  assert.equal((await orderById(b)).waybillState, 'unknown');
});

test('BOX NOW cancel frees the order; the nightly sync moves delivered and notes the day it waits in the locker', async () => {
  await connect();
  const a = await addOrder(), b = await addOrder();
  let n = 0;
  const mk = boxnowApi({ '/delivery-requests': () => reply(200, { id: 'R', parcels: [{ id: ['111', '222'][n++] }] }) });
  await withFetch(mk.impl, () => createWaybill(q, { orderId: a, scopeShopId: SHOP, input: {} }));
  await withFetch(mk.impl, () => createWaybill(q, { orderId: b, scopeShopId: SHOP, input: {} }));
  const tr = boxnowApi({
    '/api/v1/parcels': ({ query }) => reply(200, { data: [query.parcelId === '111'
      ? { id: '111', state: 'delivered', events: [] }
      : { id: '222', state: 'final-destination', events: [{ type: 'final-destination', createTime: '2026-10-19T09:30:00Z' }] }] }),
  });
  assert.deepEqual(await withFetch(tr.impl, () => syncBoxnowStatuses(q, SHOP)), { checked: 2, delivered: 1, returned: 0 });
  assert.equal((await orderById(a)).status, 'delivered');
  const ob = await orderById(b);
  assert.equal(ob.status, 'shipped');
  assert.equal(ob.shipment.atOfficeSince, '2026-10-19T09:30:00.000Z');
  const c = await addOrder();
  await withFetch(boxnowApi({ '/delivery-requests': () => reply(200, { id: 'R', parcels: [{ id: '333' }] }) }).impl, () => createWaybill(q, { orderId: c, scopeShopId: SHOP, input: {} }));
  const cancel = boxnowApi();
  await withFetch(cancel.impl, () => cancelWaybill(q, { orderId: c, scopeShopId: SHOP }));
  assert.equal(cancel.calls.at(-1).path, '/api/v1/parcels/333:cancel');
  const oc = await orderById(c);
  assert.deepEqual([oc.shipment, oc.status], [null, 'new']);
});

test('integrations: BOX NOW waybill settings through the admin, status without the secret; the cron syncs it', async () => {
  let res = fakeRes();
  await withFetch(boxnowApi().impl, () => integrationsApi(fakeReq({ method: 'POST', url: '/api/admin/integrations', headers: { cookie: cookie() }, body: { action: 'boxnow_profile', clientId: 'cid', secret: 'sec' } }), res));
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(json(res).profile, { warehouses: [{ id: 'W1', name: 'Склад Плевен', address: 'ул. Х 1, Плевен' }], anyApmId: 'ANY' });
  res = fakeRes();
  await withFetch(boxnowApi().impl, () => integrationsApi(fakeReq({ method: 'POST', url: '/api/admin/integrations', headers: { cookie: cookie() }, body: { action: 'save_boxnow', ...body } }), res));
  assert.equal(res.statusCode, 200, res.body);
  res = fakeRes();
  await integrationsApi(fakeReq({ url: '/api/admin/integrations', headers: { cookie: cookie() } }), res);
  assert.equal(json(res).boxnowApi.connected, true);
  assert.ok(!res.body.includes('"sec"'));

  process.env.CRON_SECRET = 'cron';
  const id = await addOrder();
  await withFetch(boxnowApi().impl, () => createWaybill(q, { orderId: id, scopeShopId: SHOP, input: {} }));
  const { default: refresh } = await import('../api/cron/refresh.js');
  const tr = boxnowApi({ '/api/v1/parcels': () => reply(200, { data: [{ id: '2270192741', state: 'delivered', events: [] }] }) });
  res = fakeRes();
  await withFetch(async (url, init) => (String(url).startsWith('https://api-production.boxnow.bg/') ? tr.impl(url, init) : reply(500, {})),
    () => refresh(fakeReq({ headers: { authorization: 'Bearer cron' } }), res));
  assert.deepEqual(json(res).boxnowWaybills, { 'adhdbg.eu': { checked: 1, delivered: 1, returned: 0 } });
});
