import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeReq, fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { insertOrder, listOrders } from '../lib/orders-repo.js';
import { getIntegration, getSecret, saveIntegration } from '../lib/integrations-repo.js';
import { signSession } from '../lib/auth.js';
import { saveEcont, econtStatus, createWaybill, cancelWaybill, previewWaybill, syncEcontStatuses, waybillDefaults } from '../lib/waybills.js';
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
  await q(`insert into zd.offices (id, courier, code, name, city) values ('econt:1107', 'econt', '1107', 'Офис Младост', 'София')`);
});

const PROFILE = { profiles: [{ client: { name: 'ЕТ Консулт', phones: ['359883525008'] }, addresses: [
  { id: 77, city: { name: 'София', postCode: '1000' }, street: 'бул. Гешов', num: '2' },
] }] };
const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });

/** fake Econt: answers by endpoint and records every call */
function econt(handlers = {}) {
  const calls = [];
  const impl = async (url, init) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), path, body, auth: init.headers.Authorization });
    for (const [k, h] of Object.entries(handlers)) if (path.includes(k)) return h(body);
    if (path.includes('getClientProfiles')) return reply(200, PROFILE);
    if (path.includes('createLabel')) {
      return reply(200, { label: { shipmentNumber: body.mode === 'create' ? '1051604331075' : null, totalPrice: 3.78, currency: 'EUR', receiverDueAmount: 3.78, senderDueAmount: 0, pdfURL: 'https://ee.econt.com/x.pdf' } });
    }
    if (path.includes('deleteLabels')) return reply(200, { results: [{ shipmentNum: body.shipmentNumbers[0], error: null }] });
    return reply(404, {});
  };
  return { calls, impl };
}
async function withFetch(impl, fn) {
  const real = globalThis.fetch, err = console.error;
  globalThis.fetch = impl; console.error = () => {};
  try { return await fn(); } finally { globalThis.fetch = real; console.error = err; }
}
async function addOrder(patch = {}) {
  const r = await insertOrder(q, {
    cbOrderId: `adhdbg.eu:${Math.random()}`, name: 'Мария', phone: '0888123456', phoneNorm: '+359888123456', email: '',
    deliveryType: 'econt_office', courier: 'econt', officeId: 'econt:1127', officeText: 'Офис Плевен', city: 'Плевен', postCode: '5800',
    addressText: '', items: [{ name: 'Книга', qty: 1, price: 20 }], total: 22.57, currency: 'EUR', paymentMethod: 'cod', pageUrl: '', ip: '1', ...patch,
  });
  return r.id;
}
const settingsBody = { username: 'shop-user', password: 'pa55', demo: false, senderType: 'office', senderOfficeCode: '1107', senderPhone: '0888888888', payer: 'receiver', weight: '1', description: '', review: false };
async function connect(body = {}) { const f = econt(); await withFetch(f.impl, () => saveEcont(q, SHOP, { ...settingsBody, ...body })); return f; }
const orderById = async (id) => (await listOrders(q)).rows.find((o) => o.id === id);

test('saveEcont checks the profile, seals the password and never shows it', async () => {
  const f = await connect();
  assert.equal(f.calls[0].auth, `Basic ${Buffer.from('shop-user:pa55').toString('base64')}`);
  assert.match(f.calls[0].url, /^https:\/\/ee\.econt\.com\//, 'live host');
  const [row] = await q(`select config::text as c, secret_enc from zd.integrations where provider = 'econt'`);
  assert.ok(!row.c.includes('pa55') && !row.secret_enc.includes('pa55'));
  assert.deepEqual(JSON.parse(await getSecret(q, 'econt', SHOP)), { username: 'shop-user', password: 'pa55' });
  const s = await econtStatus(q, SHOP);
  assert.equal(s.connected, true);
  assert.equal(s.profileName, 'ЕТ Консулт');
  assert.equal(s.username, 'shop-user');
  assert.deepEqual(s.sender, { type: 'office', officeCode: '1107', addressId: '', text: 'Офис Младост, София' });
  assert.ok(!JSON.stringify(s).includes('pa55'));
});

test('saveEcont: address sender from the profile, the stored password is reused for the same user, a new user needs one', async () => {
  await connect();
  const f = econt();
  await withFetch(f.impl, () => saveEcont(q, SHOP, { ...settingsBody, password: '', senderType: 'address', senderAddressId: '77' }));
  assert.equal(f.calls[0].auth, `Basic ${Buffer.from('shop-user:pa55').toString('base64')}`);
  const s = await econtStatus(q, SHOP);
  assert.equal(s.sender.text, 'София 1000, бул. Гешов 2');
  assert.equal((await getIntegration(q, 'econt', SHOP)).config.sender.address.street, 'бул. Гешов');
  await assert.rejects(withFetch(f.impl, () => saveEcont(q, SHOP, { ...settingsBody, username: 'other', password: '' })), /паролата/);
  await assert.rejects(withFetch(f.impl, () => saveEcont(q, SHOP, { ...settingsBody, senderType: 'address', senderAddressId: '999' })), /адрес/);
  await assert.rejects(withFetch(f.impl, () => saveEcont(q, SHOP, { ...settingsBody, senderOfficeCode: '9999' })), /офис/);
});

test('saveEcont: a wrong password is Econt\'s message and nothing is stored', async () => {
  const f = econt({ getClientProfiles: () => reply(517, { message: 'Невалидно потребителско име и/или парола.', innerErrors: [] }) });
  await assert.rejects(withFetch(f.impl, () => saveEcont(q, SHOP, settingsBody)), /Невалидно потребителско име/);
  assert.equal((await getIntegration(q, 'econt', SHOP)).hasSecret, false);
});

test('test mode talks to demo.econt.com and accepts its office codes', async () => {
  const f = await connect({ demo: true, senderOfficeCode: '1234' });
  assert.match(f.calls[0].url, /^https:\/\/demo\.econt\.com\/ee\//);
  assert.equal((await econtStatus(q, SHOP)).demo, true);
});

test('createWaybill makes the waybill, stores it on the order and marks it shipped', async () => {
  await connect();
  const id = await addOrder();
  const f = econt();
  const w = await withFetch(f.impl, () => createWaybill(q, { orderId: id, scopeShopId: SHOP, input: { weight: '1.5' } }));
  assert.equal(w.number, '1051604331075');
  const create = f.calls.find((c) => c.path.includes('createLabel'));
  assert.equal(create.body.mode, 'create');
  assert.equal(create.body.label.receiverOfficeCode, '1127');
  assert.equal(create.body.label.weight, 1.5);
  assert.deepEqual(create.body.label.services, { cdAmount: 22.57, cdType: 'get', cdCurrency: 'EUR' });
  const o = await orderById(id);
  assert.equal(o.status, 'shipped');
  assert.deepEqual(o.shipment, {
    number: '1051604331075', courier: 'econt', pdf: 'https://ee.econt.com/x.pdf', price: 3.78, currency: 'EUR', demo: false,
    status: '', createdAt: o.shipment.createdAt, trackUrl: 'https://www.econt.com/services/track-shipment/1051604331075',
  });
  await assert.rejects(withFetch(f.impl, () => createWaybill(q, { orderId: id, scopeShopId: SHOP, input: {} })), /вече има товарителница/);
  assert.equal(f.calls.filter((c) => c.path.includes('createLabel')).length, 1, 'never a second waybill');
});

test('createWaybill: an Econt error leaves the order free to try again', async () => {
  await connect();
  const id = await addOrder();
  const bad = econt({ createLabel: () => reply(517, { message: 'Невалиден офис', innerErrors: [] }) });
  await assert.rejects(withFetch(bad.impl, () => createWaybill(q, { orderId: id, scopeShopId: SHOP, input: {} })), /Невалиден офис/);
  const o = await orderById(id);
  assert.equal(o.shipment, null);
  assert.equal(o.status, 'new');
  const good = econt();
  assert.equal((await withFetch(good.impl, () => createWaybill(q, { orderId: id, scopeShopId: SHOP, input: {} }))).number, '1051604331075');
});

test('createWaybill: two clicks at once make only one waybill', async () => {
  await connect();
  const id = await addOrder();
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = econt({ createLabel: async () => { await gate; return reply(200, { label: { shipmentNumber: '1', totalPrice: 1, currency: 'EUR', pdfURL: 'x' } }); } });
  await withFetch(slow.impl, async () => {
    const first = createWaybill(q, { orderId: id, scopeShopId: SHOP, input: {} });
    await new Promise((r) => setTimeout(r, 20));
    await assert.rejects(createWaybill(q, { orderId: id, scopeShopId: SHOP, input: {} }), /вече се създава/);
    release();
    await first;
  });
  assert.equal(slow.calls.filter((c) => c.path.includes('createLabel')).length, 1);
});

test('createWaybill refuses without Econt settings, for another shop, and for cancelled orders', async () => {
  const id = await addOrder();
  await assert.rejects(createWaybill(q, { orderId: id, scopeShopId: SHOP, input: {} }), /свържете Еконт/);
  await connect();
  const [other] = await q(`insert into zd.shops (name, domain) values ('Друг', 'other.bg') returning id`);
  await assert.rejects(createWaybill(q, { orderId: id, scopeShopId: other.id, input: {} }), /Няма такава поръчка/);
  await q(`update zd.orders set status = 'cancelled' where id = $1`, [id]);
  await assert.rejects(withFetch(econt().impl, () => createWaybill(q, { orderId: id, scopeShopId: null, input: {} })), /отказана/);
});

test('previewWaybill only calculates the price', async () => {
  await connect({ payer: 'sender' });
  const id = await addOrder();
  const f = econt();
  const p = await withFetch(f.impl, () => previewWaybill(q, { orderId: id, scopeShopId: SHOP, input: {} }));
  assert.deepEqual(p, { price: 3.78, currency: 'EUR', receiverDue: 3.78, senderDue: 0, demo: false });
  assert.equal(f.calls[0].body.mode, 'calculate');
  assert.equal(f.calls[0].body.label.paymentReceiverMethod, undefined, 'sender pays');
  assert.equal((await orderById(id)).shipment, null);
});

test('waybillDefaults fills the window from the order and the settings', async () => {
  const id = await addOrder();
  assert.equal((await waybillDefaults(q, { orderId: id, scopeShopId: SHOP })).connected, false);
  await connect({ weight: '0,5', review: true });
  assert.deepEqual(await waybillDefaults(q, { orderId: id, scopeShopId: SHOP }), {
    connected: true, demo: false, officeText: 'Офис Плевен', sender: 'Офис Младост, София',
    cod: 22.57, weight: 0.5, packCount: 1, description: '1 × Книга', payer: 'receiver', review: true,
  });
});

test('cancelWaybill deletes it at Econt and frees the order', async () => {
  await connect();
  const id = await addOrder();
  await withFetch(econt().impl, () => createWaybill(q, { orderId: id, scopeShopId: SHOP, input: {} }));
  const f = econt();
  await withFetch(f.impl, () => cancelWaybill(q, { orderId: id, scopeShopId: SHOP }));
  assert.deepEqual(f.calls[0].body, { shipmentNumbers: ['1051604331075'] });
  const o = await orderById(id);
  assert.equal(o.shipment, null);
  assert.equal(o.status, 'confirmed');
  await withFetch(econt().impl, () => createWaybill(q, { orderId: id, scopeShopId: SHOP, input: {} }));
  const refused = econt({ deleteLabels: () => reply(200, { results: [{ shipmentNum: '1051604331075', error: { message: 'Пратката вече е изпратена' } }] }) });
  await assert.rejects(withFetch(refused.impl, () => cancelWaybill(q, { orderId: id, scopeShopId: SHOP })), /вече е изпратена/);
  assert.equal((await orderById(id)).shipment.number, '1051604331075', 'kept when Econt refuses');
});

test('syncEcontStatuses moves shipped orders to delivered or returned and keeps Econt\'s text', async () => {
  await connect();
  const a = await addOrder(), b = await addOrder(), c = await addOrder();
  let n = 0;
  const numbers = ['111', '222', '333'];
  const mk = econt({ createLabel: () => reply(200, { label: { shipmentNumber: numbers[n++], totalPrice: 1, currency: 'EUR', pdfURL: 'x' } }) });
  for (const id of [a, b, c]) await withFetch(mk.impl, () => createWaybill(q, { orderId: id, scopeShopId: SHOP, input: {} }));
  const f = econt({ getShipmentStatuses: (body) => reply(200, { shipmentStatuses: body.shipmentNumbers.map((num) => ({ status: {
    shipmentNumber: num, deliveryTime: num === '111' ? 5 : null, shortDeliveryStatus: { 111: 'Доставена', 222: 'Върната', 333: 'В офис' }[num],
    trackingEvents: num === '222' ? [{ destinationType: 'returned_to_sender' }] : [],
  } })) }) });
  const r = await withFetch(f.impl, () => syncEcontStatuses(q, SHOP));
  assert.deepEqual(r, { checked: 3, delivered: 1, returned: 1 });
  assert.equal((await orderById(a)).status, 'delivered');
  assert.equal((await orderById(b)).status, 'returned');
  const still = await orderById(c);
  assert.equal(still.status, 'shipped');
  assert.equal(still.shipment.status, 'В офис');
  assert.ok((await econtStatus(q, SHOP)).lastSyncAt);
});

test('syncEcontStatuses skips test waybills when the shop is live', async () => {
  await connect({ demo: true, senderOfficeCode: '1107' });
  const id = await addOrder();
  await withFetch(econt().impl, () => createWaybill(q, { orderId: id, scopeShopId: SHOP, input: {} }));
  assert.equal((await orderById(id)).shipment.demo, true);
  await connect({ demo: false });
  const f = econt({ getShipmentStatuses: () => { throw new Error('must not be called'); } });
  assert.deepEqual(await withFetch(f.impl, () => syncEcontStatuses(q, SHOP)), { checked: 0, delivered: 0, returned: 0 });
});

test('cancelling a test waybill frees the order even when the demo server refuses', async () => {
  await connect({ demo: true });
  const id = await addOrder();
  await withFetch(econt().impl, () => createWaybill(q, { orderId: id, scopeShopId: SHOP, input: {} }));
  const refused = econt({ deleteLabels: () => reply(517, { message: 'грешка', innerErrors: [] }) });
  await withFetch(refused.impl, () => cancelWaybill(q, { orderId: id, scopeShopId: SHOP }));
  assert.equal((await orderById(id)).shipment, null);
});

test('admin route: needs login, works through the order\'s shop, Bulgarian errors as 400', async () => {
  let res = fakeRes();
  await waybillsApi(fakeReq({ method: 'POST', url: '/api/admin/waybills', body: { action: 'create' } }), res);
  assert.equal(res.statusCode, 401);
  await connect();
  const id = await addOrder();
  res = fakeRes();
  await withFetch(econt().impl, () => waybillsApi(fakeReq({ method: 'POST', url: '/api/admin/waybills?shop=all', headers: { cookie: cookie() }, body: { action: 'create', id, weight: 1 } }), res));
  assert.equal(res.statusCode, 200);
  assert.equal(json(res).number, '1051604331075');
  res = fakeRes();
  await waybillsApi(fakeReq({ method: 'POST', url: '/api/admin/waybills', headers: { cookie: cookie() }, body: { action: 'create', id } }), res);
  assert.equal(res.statusCode, 400);
  assert.match(json(res).error, /вече има товарителница/);
  res = fakeRes();
  await waybillsApi(fakeReq({ method: 'POST', url: '/api/admin/waybills', headers: { cookie: cookie() }, body: { action: 'nope', id } }), res);
  assert.equal(res.statusCode, 400);
});

test('integrations: econt settings through the admin, status shows them without the password', async () => {
  let res = fakeRes();
  await withFetch(econt().impl, () => integrationsApi(fakeReq({ method: 'POST', url: '/api/admin/integrations', headers: { cookie: cookie() }, body: { action: 'econt_profile', username: 'shop-user', password: 'pa55' } }), res));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(json(res).profile, { name: 'ЕТ Консулт', phones: ['359883525008'], addresses: [{ id: '77', text: 'София 1000, бул. Гешов 2' }] });
  res = fakeRes();
  await withFetch(econt().impl, () => integrationsApi(fakeReq({ method: 'POST', url: '/api/admin/integrations', headers: { cookie: cookie() }, body: { action: 'save_econt', ...settingsBody } }), res));
  assert.equal(res.statusCode, 200);
  res = fakeRes();
  await integrationsApi(fakeReq({ url: '/api/admin/integrations', headers: { cookie: cookie() } }), res);
  const s = json(res);
  assert.equal(s.econtApi.connected, true);
  assert.equal(s.econt.offices, 1, 'office counts stay');
  assert.ok(!res.body.includes('pa55'));
});

test('saveEcont can switch off without asking Econt', async () => {
  await connect();
  const f = econt({ getClientProfiles: () => { throw new Error('must not be called'); } });
  await withFetch(f.impl, () => saveEcont(q, SHOP, { ...settingsBody, password: '', active: false }));
  assert.equal((await econtStatus(q, SHOP)).connected, false);
  const id = await addOrder();
  await assert.rejects(createWaybill(q, { orderId: id, scopeShopId: SHOP, input: {} }), /свържете Еконт/);
  await saveIntegration(q, 'econt', { config: { active: true }, shopId: SHOP });
});

test('the nightly cron syncs Econt statuses of every connected shop', async () => {
  process.env.CRON_SECRET = 'cron';
  await connect();
  const id = await addOrder();
  await withFetch(econt().impl, () => createWaybill(q, { orderId: id, scopeShopId: SHOP, input: {} }));
  const { default: refresh } = await import('../api/cron/refresh.js');
  const f = econt({
    getShipmentStatuses: (body) => reply(200, { shipmentStatuses: body.shipmentNumbers.map((num) => ({ status: { shipmentNumber: num, deliveryTime: 5, trackingEvents: [], shortDeliveryStatus: 'Доставена' } })) }),
  });
  const res = fakeRes();
  // the courier catalogue calls fail here: the Econt waybill sync must still run
  await withFetch(async (url, init) => (String(url).includes('NomenclaturesService') || !String(url).includes('econt') ? reply(500, {}) : f.impl(url, init)),
    () => refresh(fakeReq({ headers: { authorization: 'Bearer cron' } }), res));
  assert.deepEqual(json(res).econtWaybills, { 'adhdbg.eu': { checked: 1, delivered: 1, returned: 0 } });
  assert.equal((await orderById(id)).status, 'delivered');
});
