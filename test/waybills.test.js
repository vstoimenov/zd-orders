import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeReq, fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { insertOrder, listOrders } from '../lib/orders-repo.js';
import { getIntegration, getSecret, saveIntegration } from '../lib/integrations-repo.js';
import { signSession } from '../lib/auth.js';
import { saveEcont, econtStatus, createWaybill, cancelWaybill, previewWaybill, syncEcontStatuses, waybillDefaults, releaseWaybill, econtProfile, assignRoute } from '../lib/waybills.js';
import ordersApi from '../lib/admin/orders.js';
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
    status: '', parcels: [], createdAt: o.shipment.createdAt, trackUrl: 'https://www.econt.com/services/track-shipment/1051604331075', atOfficeSince: null, atOfficeDay: null, external: false,
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
    connected: true, courier: 'econt', courierName: 'Еконт', demo: false, officeText: 'Офис Плевен', sender: 'Офис Младост, София',
    cod: 20, weight: 0.5, packCount: 1, description: '1 × Книга', payer: 'receiver', review: true, shippingInOrder: 2.57, codTotal: 22.57, codItems: 20, // the customer pays the courier: cash on delivery = the items
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
  assert.equal(o.status, 'new', 'back to the status it had before the waybill');
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
  assert.deepEqual(json(res).profile, { clientId: '', profiles: [{ id: '', name: 'ЕТ Консулт', company: false }], payOptions: [], name: 'ЕТ Консулт', company: false, phones: ['359883525008'], addresses: [{ id: '77', text: 'София 1000, бул. Гешов 2' }] });
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

test('saveEcont keeps the authorised person and whether the profile is a company', async () => {
  const f = econt({ getClientProfiles: () => reply(200, { profiles: [{ ...PROFILE.profiles[0], client: { ...PROFILE.profiles[0].client, juridicalEntity: true } }] }) });
  await assert.rejects(withFetch(f.impl, () => saveEcont(q, SHOP, settingsBody)), /упълномощено лице/);
  await withFetch(f.impl, () => saveEcont(q, SHOP, { ...settingsBody, senderAgent: 'Иван Кирязов' }));
  const s = await econtStatus(q, SHOP);
  assert.equal(s.senderAgent, 'Иван Кирязов');
  assert.equal(s.profileCompany, true);
});

test('an unclear Econt answer blocks the order until someone checks e-Econt and releases it', async () => {
  await connect();
  const id = await addOrder();
  const lost = econt({ createLabel: () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(withFetch(lost.impl, () => createWaybill(q, { orderId: id, scopeShopId: SHOP, input: {} })), /проверете в e-Econt/);
  let o = await orderById(id);
  assert.equal(o.shipment, null);
  assert.equal(o.waybillState, 'unknown');
  const f = econt();
  await assert.rejects(withFetch(f.impl, () => createWaybill(q, { orderId: id, scopeShopId: SHOP, input: {} })), /проверете в e-Econt/);
  assert.equal(f.calls.length, 0, 'no second waybill while unclear');
  await releaseWaybill(q, { orderId: id, scopeShopId: SHOP });
  o = await orderById(id);
  assert.equal(o.waybillState, '');
  assert.equal((await withFetch(f.impl, () => createWaybill(q, { orderId: id, scopeShopId: SHOP, input: {} }))).number, '1051604331075');
});

test('a claim being created is never taken over automatically; an old one can only be released by hand', async () => {
  await connect();
  const id = await addOrder();
  await q(`update zd.orders set waybill_number = 'creating', waybill_created_at = now() where id = $1`, [id]);
  await assert.rejects(releaseWaybill(q, { orderId: id, scopeShopId: SHOP }), /още се създава/);
  assert.equal((await orderById(id)).waybillState, 'creating');
  await q(`update zd.orders set waybill_created_at = now() - interval '10 minutes' where id = $1`, [id]);
  assert.equal((await orderById(id)).waybillState, 'unknown');
  const f = econt();
  await assert.rejects(withFetch(f.impl, () => createWaybill(q, { orderId: id, scopeShopId: SHOP, input: {} })), /проверете в e-Econt/);
  assert.equal(f.calls.length, 0);
  await releaseWaybill(q, { orderId: id, scopeShopId: SHOP });
  assert.equal((await orderById(id)).waybillState, '');
});

test('when saving the created waybill fails, its number is still kept on the order', async () => {
  await connect();
  const id = await addOrder();
  const real = q;
  let failed = false;
  const flaky = async (text, params) => {
    if (!failed && /waybill_prev_status = status/.test(text)) { failed = true; throw new Error('connection reset'); }
    return real(text, params);
  };
  await assert.rejects(withFetch(econt().impl, () => createWaybill(flaky, { orderId: id, scopeShopId: SHOP, input: {} })), /1051604331075/);
  const o = await orderById(id);
  assert.equal(o.shipment.number, '1051604331075', 'never free for a second waybill');
});

test('test mode: the waybill is recorded but the order status and stock stay as they are', async () => {
  await connect({ demo: true });
  const id = await addOrder();
  await withFetch(econt().impl, () => createWaybill(q, { orderId: id, scopeShopId: SHOP, input: {} }));
  let o = await orderById(id);
  assert.equal(o.shipment.demo, true);
  assert.equal(o.status, 'new');
  await withFetch(econt().impl, () => cancelWaybill(q, { orderId: id, scopeShopId: SHOP }));
  o = await orderById(id);
  assert.equal(o.shipment, null);
  assert.equal(o.status, 'new');
});

test('a shop in test mode never syncs statuses', async () => {
  await connect({ demo: true });
  const f = econt({ getShipmentStatuses: () => { throw new Error('must not be called'); } });
  assert.deepEqual(await withFetch(f.impl, () => syncEcontStatuses(q, SHOP)), { checked: 0, delivered: 0, returned: 0 });
});

test('create refuses when the window was opened in another mode (real vs test)', async () => {
  await connect();
  const id = await addOrder();
  const f = econt();
  await assert.rejects(withFetch(f.impl, () => createWaybill(q, { orderId: id, scopeShopId: SHOP, input: { expectDemo: true } })), /режимът/i);
  assert.equal(f.calls.length, 0);
  assert.equal((await withFetch(f.impl, () => createWaybill(q, { orderId: id, scopeShopId: SHOP, input: { expectDemo: false } }))).number, '1051604331075');
});

test('a real waybill is cancelled only in real mode; a test one is just removed in real mode', async () => {
  await connect();
  const live = await addOrder();
  await withFetch(econt().impl, () => createWaybill(q, { orderId: live, scopeShopId: SHOP, input: {} }));
  await connect({ demo: true });
  const test = await addOrder();
  await withFetch(econt().impl, () => createWaybill(q, { orderId: test, scopeShopId: SHOP, input: {} }));
  await assert.rejects(withFetch(econt().impl, () => cancelWaybill(q, { orderId: live, scopeShopId: SHOP })), /реален режим/);
  await connect({ demo: false });
  const f = econt();
  await withFetch(f.impl, () => cancelWaybill(q, { orderId: test, scopeShopId: SHOP }));
  assert.equal(f.calls.length, 0, 'the live login never goes to the demo server');
  assert.equal((await orderById(test)).shipment, null);
});

test('waybills only for orders still to be sent; cancelling restores the status the order had', async () => {
  await connect();
  const done = await addOrder();
  await q(`update zd.orders set status = 'delivered' where id = $1`, [done]);
  await assert.rejects(withFetch(econt().impl, () => createWaybill(q, { orderId: done, scopeShopId: SHOP, input: {} })), /доставена/);
  const sent = await addOrder();
  await q(`update zd.orders set status = 'shipped' where id = $1`, [sent]);
  await withFetch(econt().impl, () => createWaybill(q, { orderId: sent, scopeShopId: SHOP, input: {} }));
  await withFetch(econt().impl, () => cancelWaybill(q, { orderId: sent, scopeShopId: SHOP }));
  assert.equal((await orderById(sent)).status, 'shipped');
});

test('the stored password is reused only in the mode it was saved for', async () => {
  await connect();
  await assert.rejects(withFetch(econt().impl, () => econtProfile(q, SHOP, { username: 'shop-user', password: '', demo: true })), /паролата/);
});

test('admin route: a shop never reaches another shop\'s order', async () => {
  await connect();
  const id = await addOrder();
  await withFetch(econt().impl, () => createWaybill(q, { orderId: id, scopeShopId: SHOP, input: {} }));
  const [other] = await q(`insert into zd.shops (name, domain) values ('Друг', 'other.bg') returning id`);
  for (const action of ['defaults', 'preview', 'cancel', 'release']) {
    const res = fakeRes();
    await withFetch(econt().impl, () => waybillsApi(fakeReq({ method: 'POST', url: `/api/admin/waybills?shop=${other.id}`, headers: { cookie: cookie() }, body: { action, id } }), res));
    assert.equal(res.statusCode, 400, action);
    assert.match(json(res).error, /Няма такава поръчка/, action);
  }
  assert.equal((await orderById(id)).shipment.number, '1051604331075');
});

test('an order with a real waybill cannot be deleted before the waybill is cancelled', async () => {
  await connect();
  const id = await addOrder();
  await withFetch(econt().impl, () => createWaybill(q, { orderId: id, scopeShopId: SHOP, input: {} }));
  const res = fakeRes();
  await ordersApi(fakeReq({ method: 'DELETE', url: '/api/admin/orders', headers: { cookie: cookie() }, body: { id } }), res);
  assert.equal(res.statusCode, 400);
  assert.match(json(res).error, /товарителница/);
  assert.ok(await orderById(id));
});

/* ---- parcels waiting at the receiver's office ---- */
import { atOfficeCounts } from '../lib/orders-repo.js';
async function shippedAt(numbers) {
  await connect();
  const ids = [];
  let n = 0;
  const mk = econt({ createLabel: () => reply(200, { label: { shipmentNumber: numbers[n++], totalPrice: 1, currency: 'EUR', pdfURL: 'x' } }) });
  for (let i = 0; i < numbers.length; i++) { const id = await addOrder(); ids.push(id); await withFetch(mk.impl, () => createWaybill(q, { orderId: id, scopeShopId: SHOP, input: {} })); }
  return ids;
}
const atOfficeReply = (since) => econt({ getShipmentStatuses: (body) => reply(200, { shipmentStatuses: body.shipmentNumbers.map((num) => ({ status: {
  shipmentNumber: num, receiverOfficeCode: '5803', shortDeliveryStatus: 'В офис',
  trackingEvents: since[num] ? [{ destinationType: 'office', officeCode: '5803', time: since[num] }] : [{ destinationType: 'courier', officeCode: '1107', time: new Date().toISOString() }],
} })) }) });
const daysAgo = (d) => new Date(Date.now() - d * 86400e3).toISOString();

test('the nightly check records since when a parcel waits at the office; from the 4th day it is due', async () => {
  const [a, b, c] = await shippedAt(['501', '502', '503']);
  await withFetch(atOfficeReply({ 501: daysAgo(3), 502: daysAgo(1) }).impl, () => syncEcontStatuses(q, SHOP));
  const oa = await orderById(a);
  assert.equal(oa.shipment.atOfficeSince.slice(0, 10), daysAgo(3).slice(0, 10));
  assert.equal(oa.shipment.atOfficeDay, 4);
  assert.equal((await orderById(b)).shipment.atOfficeDay, 2);
  assert.equal((await orderById(c)).shipment.atOfficeSince, null, 'still on its way');
  assert.deepEqual(await atOfficeCounts(q, { shopId: SHOP }), { waiting: 2, due: 1 });
  const { rows } = await listOrders(q, { status: 'at_office', shopId: SHOP });
  assert.deepEqual(rows.map((o) => o.id).sort(), [a, b].sort());
});

test('the arrival day is kept from the first check; a collected parcel leaves the list', async () => {
  const [a] = await shippedAt(['601']);
  await withFetch(atOfficeReply({ 601: daysAgo(2) }).impl, () => syncEcontStatuses(q, SHOP));
  await withFetch(atOfficeReply({ 601: daysAgo(0) }).impl, () => syncEcontStatuses(q, SHOP)); // Econt shows a later office event
  assert.equal((await orderById(a)).shipment.atOfficeDay, 3);
  const collected = econt({ getShipmentStatuses: (body) => reply(200, { shipmentStatuses: body.shipmentNumbers.map((num) => ({ status: { shipmentNumber: num, deliveryTime: 5, receiverOfficeCode: '5803', shortDeliveryStatus: 'Доставена', trackingEvents: [] } })) }) });
  await withFetch(collected.impl, () => syncEcontStatuses(q, SHOP));
  assert.deepEqual(await atOfficeCounts(q, { shopId: SHOP }), { waiting: 0, due: 0 });
});

test('the orders page tells how many parcels wait at the office and how many are due', async () => {
  await shippedAt(['701']);
  await withFetch(atOfficeReply({ 701: daysAgo(5) }).impl, () => syncEcontStatuses(q, SHOP));
  const res = fakeRes();
  await ordersApi(fakeReq({ url: `/api/admin/orders?shop=${SHOP}`, headers: { cookie: cookie() } }), res);
  assert.deepEqual(json(res).atOffice, { waiting: 1, due: 1 });
});

const TWO = { profiles: [
  { client: { id: 501, name: 'Профитбранд ЕООД', juridicalEntity: true, phones: ['359883000001'] }, addresses: [{ id: 11, city: { name: 'Плевен', postCode: '5800' }, street: 'жк. Кайлъка', num: '345' }] },
  { client: { id: 502, name: 'Виктор Стоименов', juridicalEntity: false, phones: ['359883000002'] }, addresses: [{ id: 22, city: { name: 'София', postCode: '1000' }, street: 'ул. Шипка', num: '5' }] },
] };

test('one e-Econt login with a company and a personal profile: the admin sees both and loads the one chosen', async () => {
  const f = econt({ getClientProfiles: () => reply(200, TWO) });
  const first = await withFetch(f.impl, () => econtProfile(q, SHOP, settingsBody));
  assert.deepEqual(first.profiles, [{ id: '501', name: 'Профитбранд ЕООД', company: true }, { id: '502', name: 'Виктор Стоименов', company: false }]);
  assert.equal(first.clientId, '501');
  const p = await withFetch(f.impl, () => econtProfile(q, SHOP, { ...settingsBody, clientId: '502' }));
  assert.deepEqual([p.clientId, p.name, p.company, p.phones[0], p.addresses[0].id], ['502', 'Виктор Стоименов', false, '359883000002', '22']);
  await assert.rejects(withFetch(f.impl, () => econtProfile(q, SHOP, { ...settingsBody, clientId: '999' })), /Изберете профил/);
});

test('waybills go out from the chosen profile (the personal one), not just the first Econt returns', async () => {
  const f = econt({ getClientProfiles: () => reply(200, TWO) });
  await withFetch(f.impl, () => saveEcont(q, SHOP, { ...settingsBody, clientId: '502' }));
  const s = await econtStatus(q, SHOP);
  assert.deepEqual([s.clientId, s.profileName, s.profileCompany], ['502', 'Виктор Стоименов', false]);
  const id = await addOrder();
  const g = econt();
  await withFetch(g.impl, () => createWaybill(q, { orderId: id, scopeShopId: SHOP, input: {} }));
  const create = g.calls.find((c) => c.path.includes('createLabel'));
  assert.deepEqual(create.body.label.senderClient, { id: 502, name: 'Виктор Стоименов', phones: ['0888888888'] });
  await withFetch(f.impl, () => saveEcont(q, SHOP, { ...settingsBody, password: '', weight: '2' })); // a later save that does not pick again
  assert.equal((await econtStatus(q, SHOP)).clientId, '502', 'the chosen profile stays');
});

test('the sender pays the courier unless the shop chose otherwise; the window warns when the order already includes shipping', async () => {
  await saveIntegration(q, 'econt', { config: { username: 'u', demo: false, sender: { type: 'office', officeCode: '1107', text: 'Офис' }, senderPhone: '0888888888', active: true }, secret: JSON.stringify({ username: 'u', password: 'p' }), shopId: SHOP });
  assert.equal((await econtStatus(q, SHOP)).payer, 'sender', 'never set = the shop pays (the customer paid shipping in the order)');
  const id = await addOrder(); // items 20, total 22.57: shipping is inside the order
  const d = await waybillDefaults(q, { orderId: id, scopeShopId: SHOP });
  assert.deepEqual([d.payer, d.shippingInOrder], ['sender', 2.57]);
  assert.equal(d.cod, 22.57, 'the shop pays the courier: cash on delivery = the whole order');
  await connect({ payer: 'receiver' });
  const d2 = await waybillDefaults(q, { orderId: id, scopeShopId: SHOP });
  assert.deepEqual([d2.payer, d2.shippingInOrder, d2.cod, d2.codItems, d2.codTotal], ['receiver', 2.57, 20, 20, 22.57], 'the customer pays the courier at the office: cash on delivery = the items only, never shipping twice');
  const flat = await addOrder({ total: 20 });
  assert.equal((await waybillDefaults(q, { orderId: flat, scopeShopId: SHOP })).shippingInOrder, 0);
});

test('the shop picks how Econt pays out the cash on delivery (a template from its e-Econt profile)', async () => {
  const withPay = { profiles: [{ ...PROFILE.profiles[0], cdPayOptions: [{ num: 'CD41012', method: 'bank', IBAN: 'BG18RZBB91550123456789', bankCurrency: 'EUR' }, { num: 'CD41027', method: 'office', officeCode: '1032' }] }] };
  const f = econt({ getClientProfiles: () => reply(200, withPay) });
  assert.deepEqual((await withFetch(f.impl, () => econtProfile(q, SHOP, settingsBody))).payOptions.map((o) => o.num), ['CD41012', 'CD41027']);
  await withFetch(f.impl, () => saveEcont(q, SHOP, { ...settingsBody, cdPayOptionNum: 'CD41012' }));
  assert.deepEqual((await econtStatus(q, SHOP)).cdPayOption, { num: 'CD41012', text: 'По банка · IBAN …6789 (EUR)' });
  await withFetch(f.impl, () => saveEcont(q, SHOP, { ...settingsBody, password: '', weight: '2' })); // a later save without choosing again
  assert.equal((await econtStatus(q, SHOP)).cdPayOption.num, 'CD41012', 'the choice stays');
  await assert.rejects(withFetch(f.impl, () => saveEcont(q, SHOP, { ...settingsBody, cdPayOptionNum: 'CD99999' })), /изплащане/);
  await withFetch(f.impl, () => saveEcont(q, SHOP, { ...settingsBody, cdPayOptionNum: '' }));
  assert.equal((await econtStatus(q, SHOP)).cdPayOption, null, 'back to e-Econt\'s default');
});

test('an Econt-to-address order gets a label with the receiver address and the window shows the address', async () => {
  const f = await connect();
  const id = await addOrder({ deliveryType: 'econt_address', officeId: '', officeText: '', city: 'Варна', postCode: '9000', addressText: 'ул. Тайна 5' });
  const d = await waybillDefaults(q, { orderId: id, scopeShopId: SHOP });
  assert.equal(d.officeText, 'ул. Тайна 5, Варна');
  await withFetch(f.impl, () => previewWaybill(q, { orderId: id, scopeShopId: SHOP, input: { weight: 1 } }));
  const label = f.calls.at(-1).body.label;
  assert.deepEqual(label.receiverAddress, { city: { country: { code3: 'BGR' }, name: 'Варна', postCode: '9000' }, other: 'ул. Тайна 5' });
  assert.equal(label.receiverOfficeCode, undefined);
});

test('an order that came without a courier: the shop picks the courier and office (or address) before the waybill', async () => {
  await connect();
  const id = await addOrder({ deliveryType: 'other', courier: 'other', officeId: '', officeText: 'Flat rate', city: 'София', postCode: '', addressText: '' });
  const d0 = await waybillDefaults(q, { orderId: id, scopeShopId: SHOP });
  assert.equal(d0.needsRoute, true);
  assert.deepEqual(d0.couriers, [{ key: 'econt', name: 'Еконт', address: true }]); // only the connected couriers
  await assert.rejects(assignRoute(q, { orderId: id, scopeShopId: SHOP, input: {} }), /Изберете куриер/);
  await assert.rejects(assignRoute(q, { orderId: id, scopeShopId: SHOP, input: { courier: 'econt', officeId: 'econt:9999' } }), /офис/i);
  const o = await assignRoute(q, { orderId: id, scopeShopId: SHOP, input: { courier: 'econt', officeId: 'econt:1107' } });
  assert.equal(o.deliveryType, 'econt_office');
  assert.equal(o.officeId, 'econt:1107');
  assert.equal(o.officeText, 'Офис Младост, София (1107)');
  const d = await waybillDefaults(q, { orderId: id, scopeShopId: SHOP });
  assert.equal(d.connected, true);
  assert.equal(d.officeText, 'Офис Младост, София (1107)');
  const addr = await addOrder({ deliveryType: 'other', courier: 'other', officeId: '', officeText: 'Local pickup', city: '', addressText: '' });
  const a = await assignRoute(q, { orderId: addr, scopeShopId: SHOP, input: { courier: 'econt', city: 'Варна', postCode: '9000', addressText: 'ул. Тайна 5' } });
  assert.equal(a.deliveryType, 'econt_address');
  assert.equal(a.city, 'Варна');
  await q(`update zd.orders set waybill_number = '1055' where id = $1::uuid`, [addr]);
  await assert.rejects(assignRoute(q, { orderId: addr, scopeShopId: SHOP, input: { courier: 'econt', officeId: 'econt:1107' } }), /товарителница/);
});
