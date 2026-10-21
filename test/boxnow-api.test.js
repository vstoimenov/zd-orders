import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOXNOW_HOSTS, BOXNOW_STAGE_LOCKER, boxnowCall, confirmAnyApm, clearBoxnowTokens, getProfile, buildDelivery, createDelivery, cancelParcel, labelPdf, shipmentStatuses,
} from '../lib/boxnow-api.js';

const live = { username: 'cid', password: 'sec', demo: false };
const stage = { ...live, demo: true };
const reply = (status, body, type = 'application/json') => ({
  ok: status < 300, status, headers: { get: (h) => (h.toLowerCase() === 'content-type' ? type : null) },
  json: async () => { if (typeof body === 'string') throw new Error('not json'); return body; },
  arrayBuffer: async () => new TextEncoder().encode(String(body)).buffer,
});

/** fake BOX NOW: records calls; auth answers a token, other paths by handler */
function boxnow(handlers = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const u = new URL(String(url));
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ host: u.origin, path: u.pathname, query: Object.fromEntries(u.searchParams), method: init.method || 'GET', body, auth: init.headers?.Authorization });
    for (const [k, h] of Object.entries(handlers)) if (u.pathname.includes(k)) return h({ body, query: Object.fromEntries(u.searchParams), calls });
    if (u.pathname === '/api/v1/auth-sessions') return reply(200, { access_token: 'TOKEN', token_type: 'Bearer', expires_in: 3600 });
    return reply(404, { code: 'X', message: 'not found' });
  };
  return { calls, impl };
}
beforeEach(() => clearBoxnowTokens());

const order = {
  id: '6f1c2a9e-0000-4000-8000-000000000abc', cbOrderId: 'adhdbg.eu:77', courier: 'boxnow', deliveryType: 'boxnow_locker', officeId: 'boxnow:1840',
  officeText: 'BOX NOW – автомат New Avenue (1840)', name: 'Мария Иванова', phone: '0888 123 456', email: 'm@x.bg',
  items: [{ name: 'Книга', qty: 1, price: 20 }], total: 22.57, currency: 'EUR', paymentMethod: 'cod',
};
const warehouse = { originType: 'warehouse', originId: 'W1', senderName: 'Профитбранд', senderPhone: '0899111222', senderEmail: 'shop@x.bg', size: 2 };
const anyApm = { ...warehouse, originType: 'any-apm', originId: 'any-apm-id' };

test('test mode talks only to the stage host; the login is a client-credentials token sent as Bearer and reused', async () => {
  assert.deepEqual(BOXNOW_HOSTS, { live: 'https://api-production.boxnow.bg', demo: 'https://api-stage.boxnow.bg' });
  const f = boxnow({ '/api/v1/origins': () => reply(200, { data: [] }) });
  await boxnowCall(stage, { path: '/api/v1/origins' }, f.impl);
  await boxnowCall(stage, { path: '/api/v1/origins' }, f.impl);
  assert.ok(f.calls.every((c) => c.host === 'https://api-stage.boxnow.bg'));
  assert.deepEqual(f.calls[0].body, { grant_type: 'client_credentials', client_id: 'cid', client_secret: 'sec' });
  assert.equal(f.calls.filter((c) => c.path === '/api/v1/auth-sessions').length, 1, 'token reused');
  assert.equal(f.calls[1].auth, 'Bearer TOKEN');
  const g = boxnow({ '/api/v1/origins': () => reply(200, { data: [] }) });
  await boxnowCall(live, { path: '/api/v1/origins' }, g.impl);
  assert.ok(g.calls.every((c) => c.host === 'https://api-production.boxnow.bg'), 'live mode, live host, its own token');
});

test('a wrong Client ID/Secret is a clear message; an expired token is renewed once', async () => {
  const bad = boxnow({ '/api/v1/auth-sessions': () => reply(401, { code: 'X', message: 'Unauthorized' }) });
  await assert.rejects(boxnowCall(live, { path: '/api/v1/origins' }, bad.impl), (e) => /Client ID или Client Secret/.test(e.message) && e.rejected === true);
  let n = 0;
  const f = boxnow({ '/api/v1/origins': () => (++n === 1 ? reply(401, { message: 'expired' }) : reply(200, { data: [] })) });
  assert.deepEqual(await boxnowCall(live, { path: '/api/v1/origins' }, f.impl), { data: [] });
  assert.equal(f.calls.filter((c) => c.path === '/api/v1/auth-sessions').length, 2);
});

test('getProfile lists the shop\'s warehouses and whether it may drop parcels in any locker', async () => {
  const f = boxnow({
    '/api/v1/origins': ({ query }) => reply(200, { data: query.locationType === 'any-apm'
      ? [{ id: 'any-apm-id', type: 'any-apm', name: 'Any APM' }]
      : [{ id: 'W1', type: 'warehouse', name: 'Склад Плевен', addressLine1: 'ул. Х 1', addressLine2: 'Плевен' }] }),
  });
  assert.deepEqual(await getProfile(live, f.impl), { warehouses: [{ id: 'W1', name: 'Склад Плевен', address: 'ул. Х 1, Плевен' }], anyApmId: 'any-apm-id' });
});

test('buildDelivery: COD order from a warehouse to the chosen locker, phones in +359 form', () => {
  const r = buildDelivery(order, warehouse, {});
  assert.equal(r.orderNumber, '6f1c2a9e-1', 'the same number on every try, so BOX NOW refuses a second parcel (P410)');
  assert.equal(buildDelivery({ ...order, waybillAttempt: 1 }, warehouse, {}).orderNumber, '6f1c2a9e-2', 'a new number only after a cancelled parcel');
  assert.deepEqual({ ...r, orderNumber: 'N' }, {
    orderNumber: 'N', invoiceValue: '22.57', paymentMode: 'cod', amountToBeCollected: '22.57', allowReturn: false, // BOX NOW's guide: always false
    origin: { locationId: 'W1', contactName: 'Профитбранд', contactNumber: '+359899111222', contactEmail: 'shop@x.bg' },
    destination: { locationId: '1840', contactName: 'Мария Иванова', contactNumber: '+359888123456', contactEmail: 'm@x.bg' },
    items: [{ id: `${r.orderNumber}-1`, name: '1 × Книга', value: '22.57', weight: 1 }],
  });
});

test('buildDelivery: prepaid, any locker as start (size required), typed values win, customer without email gets the shop\'s', () => {
  const r = buildDelivery({ ...order, paymentMethod: 'card', email: '' }, anyApm, { weight: '2,5', size: '3', description: 'Подарък' });
  assert.deepEqual([r.paymentMode, r.amountToBeCollected, r.origin.locationId, r.destination.contactEmail], ['prepaid', '0.00', 'any-apm-id', 'shop@x.bg']);
  assert.deepEqual({ ...r.items[0], id: '' }, { id: '', name: 'Подарък', value: '22.57', weight: 2.5, compartmentSize: 3 });
  assert.equal(buildDelivery(order, anyApm, { cod: '0' }).paymentMode, 'prepaid');
});

test('buildDelivery refuses what BOX NOW would refuse, in Bulgarian', () => {
  assert.throws(() => buildDelivery({ ...order, courier: 'econt' }, warehouse, {}), /не е до автомат на BOX NOW/);
  assert.throws(() => buildDelivery({ ...order, officeId: '' }, warehouse, {}), /не е до автомат на BOX NOW/);
  assert.throws(() => buildDelivery(order, { ...warehouse, originId: '' }, {}), /откъде тръгват пратките/);
  assert.throws(() => buildDelivery(order, { ...anyApm, size: 0 }, {}), /размер/);
  assert.throws(() => buildDelivery(order, warehouse, { cod: '5000' }), /до 4999/);
  assert.throws(() => buildDelivery({ ...order, phone: '12' }, warehouse, {}), /телефон на получателя/);
  assert.throws(() => buildDelivery(order, { ...warehouse, senderPhone: '' }, {}), /телефон на подателя/);
  assert.throws(() => buildDelivery(order, warehouse, { weight: '25' }), /20 кг/);
});

test('createDelivery returns the parcel number; BOX NOW refusals are clear, odd answers stay unknown', async () => {
  const req = buildDelivery(order, warehouse, {});
  let f = boxnow({ '/api/v1/delivery-requests': () => reply(200, { id: 'R1', parcels: [{ id: '2270192741' }] }) });
  assert.deepEqual(await createDelivery(live, req, f.impl), { number: '2270192741', parcels: ['2270192741'], reference: 'R1', price: null, currency: '', pdf: null });
  assert.equal(f.calls.at(-1).method, 'POST');
  f = boxnow({ '/api/v1/delivery-requests': () => reply(200, { referenceNumber: 'R2', parcels: [{ id: '9' }] }) });
  assert.equal((await createDelivery(live, req, f.impl)).reference, 'R2');
  f = boxnow({ '/api/v1/delivery-requests': () => reply(400, { code: 'P411', message: 'not eligible' }) });
  await assert.rejects(createDelivery(live, req, f.impl), (e) => /наложен платеж/.test(e.message) && e.rejected === true);
  f = boxnow({ '/api/v1/delivery-requests': () => reply(422, { code: 'P402', message: 'bad destination' }) });
  await assert.rejects(createDelivery(live, req, f.impl), (e) => /автомат/.test(e.message) && e.rejected === true);
  f = boxnow({ '/api/v1/delivery-requests': () => reply(502, 'Bad gateway') });
  await assert.rejects(createDelivery(live, req, f.impl), (e) => e.rejected === false);
  f = boxnow({ '/api/v1/delivery-requests': () => reply(200, { id: 'R3' }) });
  await assert.rejects(createDelivery(live, req, f.impl), (e) => e.rejected === false, 'no parcel id: may still exist');
});

test('cancel and label PDF use the parcel id', async () => {
  const f = boxnow({
    ':cancel': () => reply(200, {}),
    '/label.pdf': () => reply(200, '%PDF-1.4 x', 'application/pdf'),
  });
  await cancelParcel(live, '2270192741', f.impl);
  assert.deepEqual([f.calls.at(-1).method, f.calls.at(-1).path], ['POST', '/api/v1/parcels/2270192741:cancel']);
  const pdf = await labelPdf(live, '2270192741', f.impl);
  assert.equal(Buffer.from(pdf).toString().slice(0, 8), '%PDF-1.4');
  assert.equal(f.calls.at(-1).path, '/api/v1/parcels/2270192741/label.pdf');
  const g = boxnow({ ':cancel': () => reply(400, { code: 'P420', message: 'not ready' }) });
  await assert.rejects(cancelParcel(live, '1', g.impl), /не може да се анулира/);
});

test('statuses: delivered, returned, waiting in the locker since the first arrival; COD parcels are found too', async () => {
  const parcel = (id, state, events) => ({ data: [{ id, state, events }] });
  const f = boxnow({
    '/api/v1/parcels': ({ query }) => {
      if (query.parcelId === '1') return reply(200, parcel('1', 'delivered', [{ type: 'delivered', createTime: '2026-10-20T10:00:00Z' }]));
      if (query.parcelId === '2') return reply(200, parcel('2', 'returned', []));
      if (query.parcelId === '3') return reply(200, parcel('3', 'final-destination', [{ type: 'in-transit', createTime: '2026-10-18T08:00:00Z' }, { type: 'final-destination', createTime: '2026-10-19T09:30:00Z' }]));
      if (query.parcelId === '4') return reply(200, query.paymentMode === 'cod' ? parcel('4', 'in-transit', []) : { data: [] });
      return reply(200, { data: [] });
    },
  });
  const st = await shipmentStatuses(live, ['1', '2', '3', '4', '5'], f.impl);
  assert.deepEqual(st, [
    { number: '1', status: 'delivered', text: 'Доставена', atOffice: null },
    { number: '2', status: 'returned', text: 'Върната на подателя', atOffice: null },
    { number: '3', status: null, text: 'В автомата, чака получателя', atOffice: '2026-10-19T09:30:00.000Z' },
    { number: '4', status: null, text: 'На път', atOffice: null },
  ]);
});

test('test mode sends the parcel to BOX NOW\'s test locker (stage knows no real lockers)', () => {
  assert.equal(BOXNOW_STAGE_LOCKER, '5365');
  assert.equal(buildDelivery(order, { ...warehouse, demo: true }, {}).destination.locationId, '5365');
  assert.equal(buildDelivery(order, { ...warehouse, demo: false }, {}).destination.locationId, '1840');
});

test('statuses ask for cash-on-delivery parcels first, skip a parcel BOX NOW fails on, stop on a wrong login', async () => {
  const f = boxnow({
    '/api/v1/parcels': ({ query }) => {
      if (query.parcelId === '1') return reply(500, 'oops');
      if (query.parcelId === '2') return reply(200, query.paymentMode === 'cod' ? { data: [{ id: '2', state: 'delivered', events: [] }] } : { data: [] });
      return reply(200, { data: [] });
    },
  });
  assert.deepEqual(await shipmentStatuses(live, ['1', '2'], f.impl), [{ number: '2', status: 'delivered', text: 'Доставена', atOffice: null }]);
  const asked = f.calls.filter((c) => c.path === '/api/v1/parcels' && c.query.parcelId === '2');
  assert.deepEqual(asked.map((c) => c.query.paymentMode), ['cod'], 'one call for a COD parcel');
  clearBoxnowTokens();
  const bad = boxnow({ '/api/v1/auth-sessions': () => reply(401, { message: 'bad' }) });
  await assert.rejects(shipmentStatuses(live, ['1'], bad.impl), /Client ID или Client Secret/);
});

test('a disabled BOX NOW account says so at login', async () => {
  const f = boxnow({ '/api/v1/auth-sessions': () => reply(403, { code: 'X403', message: 'Account disabled' }) });
  await assert.rejects(boxnowCall(live, { path: '/api/v1/origins' }, f.impl), /спрян/);
});

test('after the shop drops a parcel in a locker it tells BOX NOW (the profile needs the confirmation)', async () => {
  const f = boxnow({ ':confirm-anyapm-delivery': () => reply(200, {}) });
  await confirmAnyApm(live, '4182565522', f.impl);
  assert.deepEqual([f.calls.at(-1).method, f.calls.at(-1).path], ['POST', '/api/v1/parcels/4182565522:confirm-anyapm-delivery']);
  const g = boxnow({ ':confirm-anyapm-delivery': () => reply(400, { code: 'P430', message: 'already' }) });
  await assert.rejects(confirmAnyApm(live, '1', g.impl), /още не е в автомата|вече е потвърдена/);
});
