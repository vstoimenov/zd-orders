import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeReq, fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { insertOrder, listOrders } from '../lib/orders-repo.js';
import { getSecret } from '../lib/integrations-repo.js';
import { signSession } from '../lib/auth.js';
import { saveSpeedy, speedyStatus, createWaybill, cancelWaybill, previewWaybill, waybillDefaults, syncSpeedyStatuses, releaseWaybill } from '../lib/waybills.js';
import waybillsApi from '../lib/admin/waybills.js';
import integrationsApi from '../lib/admin/integrations.js';

process.env.INTEGRATIONS_SECRET = 'test-secret';
process.env.ADMIN_SECRET = 'secret';
const SHOP = '00000000-0000-4000-8000-000000000001';
const cookie = () => `zdo_admin=${signSession('secret')}`;

let q;
beforeEach(async () => {
  q = await makeTestQuery(); setQueryForTests(q);
  await q(`update zd.shops set domain = 'adhdbg.eu' where id = $1`, [SHOP]);
  await q(`insert into zd.offices (id, courier, code, name, city) values ('speedy:12', 'speedy', '12', 'СОФИЯ - ЦЕНТЪР', 'София')`);
});

const reply = (status, body) => ({ ok: status < 300, status, headers: new Map([['content-type', 'application/json']]), json: async () => body });
const CLIENTS = { clients: [{ clientId: 77001, clientName: 'ЕТ Книги', objectName: 'Склад', privatePerson: false, address: { fullAddressString: 'гр. София, ул. Пиротска 5' } }] };
const SERVICES = { services: [{ id: 505, name: 'СТАНДАРТ 24 ЧАСА', cargoType: 'PARCEL' }] };

/** fake Speedy: answers by endpoint, records calls */
function speedyApi(handlers = {}) {
  const calls = [];
  const impl = async (url, init) => {
    const path = new URL(url).pathname.replace('/v1/', '');
    const body = JSON.parse(init.body);
    calls.push({ path, body });
    if (handlers[path]) return handlers[path](body);
    if (path === 'client/contract') return reply(200, CLIENTS);
    if (path === 'services') return reply(200, SERVICES);
    if (path === 'calculate') return reply(200, { calculations: [{ serviceId: 505, price: { total: 6.1, currency: 'EUR' } }] });
    if (path === 'shipment') return reply(200, { id: '61234567890', parcels: [{ seqNo: 1, id: '61234567890' }], price: { total: 6.1, currency: 'EUR' } });
    if (path === 'shipment/cancel') return reply(200, {});
    if (path === 'print') return { ok: true, status: 200, headers: new Map([['content-type', 'application/pdf']]), arrayBuffer: async () => new TextEncoder().encode('%PDF-1.4 speedy').buffer };
    return reply(404, {});
  };
  return { calls, impl };
}
async function withFetch(impl, fn) {
  const real = globalThis.fetch, err = console.error;
  globalThis.fetch = impl; console.error = () => {};
  try { return await fn(); } finally { globalThis.fetch = real; console.error = err; }
}
const body = { username: '999111', password: 'api-pass', senderType: 'office', senderOfficeId: '12', senderClientId: '77001', senderPhone: '0888888888', senderContact: 'Иван Петров', payer: 'receiver', weight: '1', review: 'OPEN', paperSize: 'A6' };
async function connect(patch = {}) { await withFetch(speedyApi().impl, () => saveSpeedy(q, SHOP, { ...body, ...patch })); }
async function addOrder(patch = {}) {
  const r = await insertOrder(q, {
    cbOrderId: `adhdbg.eu:${Math.random()}`, name: 'Мария Иванова', phone: '0888123456', phoneNorm: '+359888123456', email: '',
    deliveryType: 'speedy_office', courier: 'speedy', officeId: 'speedy:66', officeText: 'СПИДИ – офис Плевен', city: 'Плевен', postCode: '5800',
    addressText: '', items: [{ name: 'Книга', qty: 1, price: 20 }], total: 22.57, currency: 'EUR', paymentMethod: 'cod', pageUrl: '', ip: '1', ...patch,
  });
  return r.id;
}
const orderById = async (id) => (await listOrders(q)).rows.find((o) => o.id === id);

test('saveSpeedy checks the contract login, seals the password, keeps the sender', async () => {
  await connect();
  assert.deepEqual(JSON.parse(await getSecret(q, 'speedy', SHOP)), { username: '999111', password: 'api-pass' });
  const s = await speedyStatus(q, SHOP);
  assert.equal(s.connected, true);
  assert.equal(s.profileName, 'ЕТ Книги');
  assert.deepEqual(s.sender, { type: 'office', officeId: 12, text: 'СОФИЯ - ЦЕНТЪР' });
  assert.equal(s.serviceId, 505);
  assert.equal(s.review, 'OPEN');
  assert.equal(s.paperSize, 'A6');
  assert.ok(!JSON.stringify(s).includes('api-pass'));
});

test('saveSpeedy refuses a bad login, an unknown office and a company without a contact person', async () => {
  const bad = speedyApi({ 'client/contract': () => reply(200, { error: { message: 'bg.error.invalid.credentials (EE1)', code: 1 } }) });
  await assert.rejects(withFetch(bad.impl, () => saveSpeedy(q, SHOP, body)), /грешен API потребител или парола/);
  await assert.rejects(withFetch(speedyApi().impl, () => saveSpeedy(q, SHOP, { ...body, senderOfficeId: '999' })), /офис на Спиди/);
  await assert.rejects(withFetch(speedyApi().impl, () => saveSpeedy(q, SHOP, { ...body, senderContact: '' })), /лице за контакт/);
  assert.equal((await speedyStatus(q, SHOP)).configured, false);
});

test('a Speedy office order: price, then the waybill; the order is shipped and links to print and tracking', async () => {
  await connect();
  const id = await addOrder();
  const d = await waybillDefaults(q, { orderId: id, scopeShopId: SHOP });
  assert.deepEqual(d, {
    connected: true, courier: 'speedy', courierName: 'Спиди', demo: false, officeText: 'СПИДИ – офис Плевен', sender: 'СОФИЯ - ЦЕНТЪР',
    cod: 22.57, weight: 1, packCount: 1, description: '1 × Книга', payer: 'receiver', review: true,
  });
  const p = await withFetch(speedyApi().impl, () => previewWaybill(q, { orderId: id, scopeShopId: SHOP, input: {} }));
  assert.deepEqual(p, { price: 6.1, currency: 'EUR', receiverDue: 6.1, senderDue: 0, demo: false });
  const f = speedyApi();
  const w = await withFetch(f.impl, () => createWaybill(q, { orderId: id, scopeShopId: SHOP, input: { weight: 2, review: true } }));
  assert.equal(w.number, '61234567890');
  const sent = f.calls.find((c) => c.path === 'shipment').body;
  assert.equal(sent.userName, '999111');
  assert.equal(sent.recipient.pickupOfficeId, 66);
  assert.equal(sent.content.totalWeight, 2);
  assert.deepEqual(sent.service.additionalServices.obpd, { option: 'OPEN', returnShipmentServiceId: 505, returnShipmentPayer: 'SENDER' });
  const o = await orderById(id);
  assert.equal(o.status, 'shipped');
  assert.equal(o.shipment.courier, 'speedy');
  assert.equal(o.shipment.trackUrl, 'https://www.speedy.bg/bg/track-shipment?shipmentNumber=61234567890');
  assert.equal(o.shipment.pdf, `/api/admin/waybills?pdf=${id}&shop=${SHOP}`);
  assert.equal(w.pdf, o.shipment.pdf);
});

test('a Speedy address order goes to the address with the city and post code', async () => {
  await connect({ senderType: 'client' });
  const id = await addOrder({ deliveryType: 'speedy_address', officeId: '', officeText: 'СПИДИ – адрес: ул. Роза 5', city: 'Варна', postCode: '9000', addressText: 'ул. Роза 5' });
  const f = speedyApi();
  await withFetch(f.impl, () => createWaybill(q, { orderId: id, scopeShopId: SHOP, input: {} }));
  const sent = f.calls.find((c) => c.path === 'shipment').body;
  assert.deepEqual(sent.recipient.address, { countryId: 100, siteName: 'Варна', postCode: '9000', addressNote: 'ул. Роза 5' });
  assert.equal(sent.sender.dropoffOfficeId, undefined, 'picked up from the contract address');
  assert.equal(sent.sender.clientId, 77001);
  assert.equal((await waybillDefaults(q, { orderId: id, scopeShopId: SHOP })).officeText !== undefined, true);
});

test('Speedy: a clear refusal frees the order, an unclear answer blocks it until released', async () => {
  await connect();
  const id = await addOrder();
  const refused = speedyApi({ shipment: () => reply(200, { error: { message: 'Невалиден офис', code: 180 } }) });
  await assert.rejects(withFetch(refused.impl, () => createWaybill(q, { orderId: id, scopeShopId: SHOP, input: {} })), /Невалиден офис/);
  assert.equal((await orderById(id)).waybillState, '');
  const lost = speedyApi({ shipment: () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(withFetch(lost.impl, () => createWaybill(q, { orderId: id, scopeShopId: SHOP, input: {} })), /проверете в MySpeedy/);
  assert.equal((await orderById(id)).waybillState, 'unknown');
  await releaseWaybill(q, { orderId: id, scopeShopId: SHOP });
  assert.equal((await orderById(id)).waybillState, '');
});

test('Speedy cancel, PDF through the admin, nightly statuses', async () => {
  await connect();
  const a = await addOrder(), b = await addOrder();
  let n = 0;
  const mk = speedyApi({ shipment: () => reply(200, { id: ['111', '222'][n++], price: { total: 6, currency: 'EUR' } }) });
  await withFetch(mk.impl, () => createWaybill(q, { orderId: a, scopeShopId: SHOP, input: {} }));
  await withFetch(mk.impl, () => createWaybill(q, { orderId: b, scopeShopId: SHOP, input: {} }));

  const res = fakeRes();
  const pr = speedyApi();
  await withFetch(pr.impl, () => waybillsApi(fakeReq({ method: 'GET', url: `/api/admin/waybills?pdf=${a}&shop=${SHOP}`, headers: { cookie: cookie() } }), res));
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/pdf');
  assert.match(res.headers['content-disposition'], /tovaritelnica-111\.pdf/);
  assert.equal(Buffer.from(res.body).toString(), '%PDF-1.4 speedy');
  assert.equal(pr.calls[0].body.paperSize, 'A6');

  const tr = speedyApi({ track: (bd) => reply(200, { parcels: bd.parcels.map((p) => ({ parcelId: p.id, operations: [{ operationCode: p.id === '111' ? -14 : 123, description: p.id === '111' ? 'Доставена' : 'Отказана от получател' }] })) }) });
  assert.deepEqual(await withFetch(tr.impl, () => syncSpeedyStatuses(q, SHOP)), { checked: 2, delivered: 1, returned: 1 });
  assert.equal((await orderById(a)).status, 'delivered');
  assert.equal((await orderById(b)).status, 'returned');

  const c = await addOrder();
  await withFetch(speedyApi({ shipment: () => reply(200, { id: '333', price: { total: 6, currency: 'EUR' } }) }).impl, () => createWaybill(q, { orderId: c, scopeShopId: SHOP, input: {} }));
  const cancel = speedyApi();
  await withFetch(cancel.impl, () => cancelWaybill(q, { orderId: c, scopeShopId: SHOP }));
  assert.equal(cancel.calls[0].path, 'shipment/cancel');
  assert.equal(cancel.calls[0].body.shipmentId, '333');
  const o = await orderById(c);
  assert.equal(o.shipment, null);
  assert.equal(o.status, 'new');
});

test('the PDF route stays within the shop and needs a login', async () => {
  await connect();
  const id = await addOrder();
  await withFetch(speedyApi().impl, () => createWaybill(q, { orderId: id, scopeShopId: SHOP, input: {} }));
  let res = fakeRes();
  await waybillsApi(fakeReq({ method: 'GET', url: `/api/admin/waybills?pdf=${id}` }), res);
  assert.equal(res.statusCode, 401);
  const [other] = await q(`insert into zd.shops (name, domain) values ('Друг', 'other.bg') returning id`);
  res = fakeRes();
  await waybillsApi(fakeReq({ method: 'GET', url: `/api/admin/waybills?pdf=${id}&shop=${other.id}`, headers: { cookie: cookie() } }), res);
  assert.equal(res.statusCode, 400);
  assert.match(json(res).error, /Няма такава поръчка/);
});

test('integrations: Speedy settings through the admin, status without the password', async () => {
  let res = fakeRes();
  await withFetch(speedyApi().impl, () => integrationsApi(fakeReq({ method: 'POST', url: '/api/admin/integrations', headers: { cookie: cookie() }, body: { action: 'speedy_profile', username: '999111', password: 'api-pass' } }), res));
  assert.equal(res.statusCode, 200);
  assert.equal(json(res).profile.clients[0].id, 77001);
  res = fakeRes();
  await withFetch(speedyApi().impl, () => integrationsApi(fakeReq({ method: 'POST', url: '/api/admin/integrations', headers: { cookie: cookie() }, body: { action: 'save_speedy', ...body } }), res));
  assert.equal(res.statusCode, 200);
  res = fakeRes();
  await integrationsApi(fakeReq({ url: '/api/admin/integrations', headers: { cookie: cookie() } }), res);
  assert.equal(json(res).speedyApi.connected, true);
  assert.ok(!res.body.includes('api-pass'));
});

test('the nightly cron also syncs Speedy statuses', async () => {
  process.env.CRON_SECRET = 'cron';
  await connect();
  const id = await addOrder();
  await withFetch(speedyApi().impl, () => createWaybill(q, { orderId: id, scopeShopId: SHOP, input: {} }));
  const { default: refresh } = await import('../api/cron/refresh.js');
  const tr = speedyApi({ track: (bd) => reply(200, { parcels: bd.parcels.map((p) => ({ parcelId: p.id, operations: [{ operationCode: -14, description: 'Доставена' }] })) }) });
  const res = fakeRes();
  await withFetch(async (url, init) => (String(url).startsWith('https://api.speedy.bg/') ? tr.impl(url, init) : reply(500, {})),
    () => refresh(fakeReq({ headers: { authorization: 'Bearer cron' } }), res));
  assert.deepEqual(json(res).speedyWaybills, { 'adhdbg.eu': { checked: 1, delivered: 1, returned: 0 } });
  assert.equal((await orderById(id)).status, 'delivered');
});

test('a shipment with several parcels prints a label for each', async () => {
  await connect();
  const id = await addOrder();
  await withFetch(speedyApi({ shipment: () => reply(200, { id: '61', parcels: [{ seqNo: 1, id: '61' }, { seqNo: 2, id: '62' }], price: { total: 6, currency: 'EUR' } }) }).impl,
    () => createWaybill(q, { orderId: id, scopeShopId: SHOP, input: { packCount: 2 } }));
  const pr = speedyApi();
  const res = fakeRes();
  await withFetch(pr.impl, () => waybillsApi(fakeReq({ method: 'GET', url: `/api/admin/waybills?pdf=${id}&shop=${SHOP}`, headers: { cookie: cookie() } }), res));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(pr.calls[0].body.parcels, [{ parcel: { id: '61' } }, { parcel: { id: '62' } }]);
});

test('sending from the contract address orders a courier; if that fails the waybill stays and the admin is told', async () => {
  await connect({ senderType: 'client' });
  const a = await addOrder();
  const f = speedyApi({ pickup: () => reply(200, { orders: [{ id: 1 }] }) });
  const w = await withFetch(f.impl, () => createWaybill(q, { orderId: a, scopeShopId: SHOP, input: {} }));
  assert.equal(w.pickup, 'ordered');
  assert.deepEqual(f.calls.find((c) => c.path === 'pickup').body.explicitShipmentIdList, ['61234567890']);
  const b = await addOrder();
  const bad = speedyApi({ pickup: () => reply(200, { error: { message: 'Няма възможност за вземане днес' } }), shipment: () => reply(200, { id: '999', price: { total: 6, currency: 'EUR' } }) });
  const w2 = await withFetch(bad.impl, () => createWaybill(q, { orderId: b, scopeShopId: SHOP, input: {} }));
  assert.equal(w2.number, '999');
  assert.match(w2.pickupError, /MySpeedy/);
  assert.equal((await orderById(b)).shipment.number, '999');
  // from an office: no courier is ordered
  await connect({ senderType: 'office' });
  const c = await addOrder();
  const off = speedyApi();
  await withFetch(off.impl, () => createWaybill(q, { orderId: c, scopeShopId: SHOP, input: {} }));
  assert.equal(off.calls.some((x) => x.path === 'pickup'), false);
});

test('a private-person contract saves no contact person', async () => {
  const person = speedyApi({ 'client/contract': () => reply(200, { clients: [{ clientId: 5, clientName: 'Иван Иванов', privatePerson: true }] }) });
  await withFetch(person.impl, () => saveSpeedy(q, SHOP, { ...body, senderClientId: '5', senderContact: 'Някой' }));
  assert.equal((await speedyStatus(q, SHOP)).senderContact, '');
});

test('a Speedy cancel that times out keeps the waybill on the order', async () => {
  await connect();
  const id = await addOrder();
  await withFetch(speedyApi().impl, () => createWaybill(q, { orderId: id, scopeShopId: SHOP, input: {} }));
  const lost = speedyApi({ 'shipment/cancel': () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(withFetch(lost.impl, () => cancelWaybill(q, { orderId: id, scopeShopId: SHOP })), /Няма връзка със Спиди/);
  assert.equal((await orderById(id)).shipment.number, '61234567890');
});

test('the PDF needs Speedy to be connected', async () => {
  await connect();
  const id = await addOrder();
  await withFetch(speedyApi().impl, () => createWaybill(q, { orderId: id, scopeShopId: SHOP, input: {} }));
  await withFetch(speedyApi().impl, () => saveSpeedy(q, SHOP, { active: false }));
  const res = fakeRes();
  await waybillsApi(fakeReq({ method: 'GET', url: `/api/admin/waybills?pdf=${id}&shop=${SHOP}`, headers: { cookie: cookie() } }), res);
  assert.equal(res.statusCode, 400);
  assert.match(json(res).error, /свържете Спиди/);
});

test('a waybill without a price from Speedy is stored without one', async () => {
  await connect();
  const id = await addOrder();
  await withFetch(speedyApi({ shipment: () => reply(200, { id: '77' }) }).impl, () => createWaybill(q, { orderId: id, scopeShopId: SHOP, input: {} }));
  assert.equal((await orderById(id)).shipment.price, null);
});
