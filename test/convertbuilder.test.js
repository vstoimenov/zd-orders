import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { normalizeDomain, mapOrder, verifySignature, fetchOrders, ensureWebhook, testConnection } from '../lib/convertbuilder.js';
import { seal, open } from '../lib/secretbox.js';

process.env.INTEGRATIONS_SECRET = 'test-secret';

const cbOrder = (patch = {}) => ({
  id: 82, invoiceNo: 60, created: 1791200000, customerName: 'Мария Иванова', customerEmail: 'm@x.bg',
  shippingAddress: { name: 'Мария Иванова', phone: '+359888123456', country: 'BG', city: 'Плевен', zipCode: '5800', address: 'ЕКОНТ – офис Плевен (5803), ул. Кара Колю 5А' },
  subTotal: 12.9, total: 16.45, shippingName: 'Доставка до офис на Еконт', shippingAmount: 3.55, paid: false, paymentMethod: 'cod', status: 'pending',
  items: [{ id: 1, name: 'Книга', quantity: 1, total: 12.9 }, { id: 2, name: 'Бонус', quantity: 1, total: 0 }], ...patch,
});

test('seal/open round-trips secrets and detects tampering', () => {
  const t = seal('my-api-key');
  assert.notEqual(t, 'my-api-key');
  assert.equal(open(t), 'my-api-key');
  assert.throws(() => open(t.slice(0, -4) + 'AAAA'));
});

test('normalizeDomain accepts a URL or host and rejects junk', () => {
  assert.equal(normalizeDomain('http://AdhdBG.eu/'), 'adhdbg.eu');
  assert.equal(normalizeDomain('https://www.adhdbg.eu/chekout?x=1'), 'www.adhdbg.eu');
  assert.equal(normalizeDomain('viktorstoimenov12-81.convertbuilder.com'), 'viktorstoimenov12-81.convertbuilder.com');
  assert.throws(() => normalizeDomain('not a domain'), /invalid domain/);
  assert.throws(() => normalizeDomain('localhost'), /invalid domain/);
});

test('mapOrder turns a ConvertBuilder order into our order', () => {
  const o = mapOrder(cbOrder(), { store: 'adhdbg.eu', currency: 'EUR' });
  assert.deepEqual(o, {
    cbOrderId: 'adhdbg.eu:82', invoiceNo: '60', name: 'Мария Иванова', phone: '+359888123456', phoneNorm: '+359888123456', email: 'm@x.bg',
    deliveryType: 'econt_office', courier: 'econt', officeId: '', officeText: 'ЕКОНТ – офис Плевен (5803), ул. Кара Колю 5А',
    city: 'Плевен', postCode: '5800', addressText: '', items: [{ name: 'Книга', qty: 1, price: 12.9 }, { name: 'Бонус', qty: 1, price: 0 }],
    total: 16.45, currency: 'EUR', paymentMethod: 'cod', pageUrl: '', createdAt: new Date(1791200000 * 1000).toISOString(),
    cbStatus: 'pending', insertStatus: 'new', updateStatus: null,
  });
});

test('mapOrder infers delivery and status from ConvertBuilder fields', () => {
  const m = (patch) => mapOrder(cbOrder(patch), { store: 's', currency: 'EUR' });
  assert.deepEqual([m({ shippingAddress: { address: 'СПИДИ – адрес: ул. Роза 5' } }).deliveryType, m({ shippingAddress: { address: 'СПИДИ – офис ВАРНА (79)' } }).deliveryType], ['speedy_address', 'speedy_office']);
  assert.equal(m({ shippingAddress: { address: 'ул. Роза 5' }, shippingName: 'До адрес speedy' }).deliveryType, 'speedy_address');
  assert.deepEqual([m({ shippingAddress: { address: '' }, shippingName: '' }).deliveryType, m({ shippingAddress: { address: '' }, shippingName: '' }).courier], ['other', 'other']);
  assert.deepEqual([m({ shippingAddress: { address: 'BOX NOW – автомат New Avenue (1840), ул. Х' } }).deliveryType, m({ shippingAddress: { address: 'BOX NOW – автомат New Avenue (1840)' } }).courier], ['boxnow_locker', 'boxnow']);
  assert.equal(m({ shippingAddress: { address: 'ж.к. Младост' }, shippingName: 'Автомат BOX NOW' }).deliveryType, 'boxnow_locker');
  assert.equal(m({ shippingAddress: { address: 'до box now автомата' }, shippingName: 'Офис Еконт' }).deliveryType, 'econt_office', 'the shipping method decides, not what the customer typed');
  assert.equal(m({ status: 'shipped' }).updateStatus, 'shipped');
  assert.equal(m({ status: 'completed' }).updateStatus, 'delivered');
  assert.equal(m({ status: 'canceled' }).updateStatus, 'cancelled');
  assert.equal(m({ status: 'archived' }).updateStatus, null);
  assert.equal(m({ status: 'archived' }).insertStatus, 'cancelled');
  assert.equal(m({ status: 'pending' }).updateStatus, null);
});

test('verifySignature checks the HMAC-SHA512 of the raw body', () => {
  const raw = '{"id":82}';
  const sig = createHmac('sha512', 'whsec').update(raw).digest('hex');
  assert.equal(verifySignature(raw, 'whsec', sig), true);
  assert.equal(verifySignature(raw + ' ', 'whsec', sig), false);
  assert.equal(verifySignature(raw, 'whsec', ''), false);
});

function fakeCb(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', auth: init.headers?.Authorization, ua: init.headers?.['User-Agent'], body: init.body });
    const key = `${init.method || 'GET'} ${new URL(url).pathname}`;
    const r = routes[key];
    if (!r) return { ok: false, status: 404, json: async () => ({ success: false, message: 'Not found' }) };
    const data = typeof r === 'function' ? r(new URL(url), init) : r;
    return { ok: data.__status ? data.__status < 400 : true, status: data.__status || 200, json: async () => data };
  };
  return { fetchImpl, calls };
}
const cfg = { domain: 'adhdbg.eu', apiKey: 'KEY' };

test('testConnection authenticates with a Bearer key and a User-Agent', async () => {
  const { fetchImpl, calls } = fakeCb({ 'GET /api/site/orders': { items: [cbOrder()], totalCount: 82, limit: 1, skip: 0 } });
  assert.deepEqual(await testConnection(cfg, fetchImpl), { totalOrders: 82, latestOrderId: 82, latestInvoiceNo: 60 });
  assert.equal(calls[0].url, 'https://adhdbg.eu/api/site/orders?limit=1');
  assert.equal(calls[0].auth, 'Bearer KEY');
  assert.match(calls[0].ua, /Ordyx/);
  const bad = fakeCb({ 'GET /api/site/orders': { __status: 401, success: false, message: 'Invalid API key' } });
  await assert.rejects(testConnection(cfg, bad.fetchImpl), /HTTP 401: Invalid API key/);
});

test('fetchOrders pages through orders in the date range', async () => {
  const all = Array.from({ length: 120 }, (_, i) => cbOrder({ id: i + 1 }));
  const { fetchImpl, calls } = fakeCb({ 'GET /api/site/orders': (u) => {
    const skip = Number(u.searchParams.get('skip')), limit = Number(u.searchParams.get('limit'));
    return { items: all.slice(skip, skip + limit), totalCount: all.length, limit, skip };
  } });
  const got = await fetchOrders(cfg, { since: 1791000000, until: 1791300000 }, fetchImpl);
  assert.equal(got.length, 120);
  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /created_at_min=1791000000/);
  assert.match(calls[0].url, /created_at_max=1791300000/);
});

test('ensureWebhook replaces an existing webhook for our target and creates a signed one', async () => {
  const target = 'https://kurier.profitbrand.online/api/cb/webhook';
  const { fetchImpl, calls } = fakeCb({
    'GET /api/site/webhooks': { items: [{ id: 'old', target, events: ['order_created'] }, { id: 'other', target: 'https://x.test', events: [] }] },
    'DELETE /api/site/webhooks/old': { success: true },
    'POST /api/site/webhooks': { id: 'new1', target, events: ['order_created', 'order_updated'] },
  });
  assert.deepEqual(await ensureWebhook(cfg, target, 'whsec', fetchImpl), { id: 'new1' });
  assert.deepEqual(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`), ['GET /api/site/webhooks', 'DELETE /api/site/webhooks/old', 'POST /api/site/webhooks']);
  assert.deepEqual(JSON.parse(calls[2].body), { target, secret: 'whsec', events: ['order_created', 'order_updated'] });
});

test('an Econt address order from the checkout is an Econt address, by our text or by the method name', () => {
  const base = { id: 9, customerName: 'М', items: [], status: 'pending' };
  const a = mapOrder({ ...base, shippingAddress: { address: 'ЕКОНТ – адрес: ул. Х 1', city: 'Плевен', zipCode: '5800', phone: '0888123456' } }, { store: 's.bg' });
  assert.equal(a.deliveryType, 'econt_address'); assert.equal(a.courier, 'econt'); assert.equal(a.addressText, 'ул. Х 1');
  const b = mapOrder({ ...base, shippingName: 'ЕКОНТ до адрес', shippingAddress: { address: 'ул. Y 2', city: 'Варна', phone: '0888123456' } }, { store: 's.bg' });
  assert.equal(b.deliveryType, 'econt_address'); assert.equal(b.addressText, 'ул. Y 2');
  assert.equal(mapOrder({ ...base, shippingName: 'ЕКОНТ Офис', shippingAddress: { address: 'ЕКОНТ – офис Плевен (1)' } }, { store: 's.bg' }).deliveryType, 'econt_office');
});
