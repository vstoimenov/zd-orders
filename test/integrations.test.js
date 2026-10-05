import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeReq, fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { insertOrder, listOrders, upsertCbOrder } from '../lib/orders-repo.js';
import { getIntegration, saveIntegration, getSecret } from '../lib/integrations-repo.js';
import { mapOrder } from '../lib/convertbuilder.js';
import { signSession } from '../lib/auth.js';
import webhook from '../api/cb/webhook.js';
import integrationsApi from '../api/admin/integrations.js';

process.env.INTEGRATIONS_SECRET = 'test-secret';
process.env.ADMIN_SECRET = 'secret';
process.env.PUBLIC_BASE_URL = 'https://kurier.profitbrand.online';
delete process.env.NEKOREKTEN_API_KEY;

let q;
beforeEach(async () => { q = await makeTestQuery(); setQueryForTests(q); });
const cookie = () => `zdo_admin=${signSession('secret')}`;
const cbOrder = (patch = {}) => ({
  id: 82, invoiceNo: 60, created: Math.floor(Date.now() / 1000), customerName: 'Мария', customerEmail: 'm@x.bg',
  shippingAddress: { phone: '+359888123456', city: 'Плевен', zipCode: '5800', address: 'ЕКОНТ – офис Плевен (5803), ул. Х' },
  total: 16.45, shippingName: 'Доставка до офис на Еконт', paymentMethod: 'cod', status: 'pending',
  items: [{ name: 'Книга', quantity: 1, total: 12.9 }], ...patch,
});
async function withFetch(impl, fn) {
  const real = globalThis.fetch, err = console.error, warn = console.warn;
  globalThis.fetch = impl; console.error = () => {}; console.warn = () => {};
  try { return await fn(); } finally { globalThis.fetch = real; console.error = err; console.warn = warn; }
}

test('integration secrets are stored encrypted and never returned in the config', async () => {
  await saveIntegration(q, 'convertbuilder', { config: { domain: 'adhdbg.eu', active: true }, secret: 'API-KEY' });
  const [row] = await q(`select secret_enc from zd.integrations where provider = 'convertbuilder'`);
  assert.ok(row.secret_enc && !row.secret_enc.includes('API-KEY'));
  assert.equal(await getSecret(q, 'convertbuilder'), 'API-KEY');
  const i = await getIntegration(q, 'convertbuilder');
  assert.deepEqual(i, { provider: 'convertbuilder', config: { domain: 'adhdbg.eu', active: true }, hasSecret: true });
  await saveIntegration(q, 'convertbuilder', { config: { active: false } });
  assert.equal(await getSecret(q, 'convertbuilder'), 'API-KEY', 'saving without a secret keeps the old one');
  assert.deepEqual((await getIntegration(q, 'convertbuilder')).config, { domain: 'adhdbg.eu', active: false });
});

test('upsertCbOrder inserts, then updates status forward without losing widget details', async () => {
  const widget = await insertOrder(q, { cbOrderId: 'adhdbg.eu:82', name: 'Мария', phone: '0888123456', phoneNorm: '+359888123456', email: '',
    deliveryType: 'econt_office', courier: 'econt', officeId: 'econt:5803', officeText: 'ЕКОНТ – офис Плевен (5803), ул. Х', city: 'Плевен', postCode: '5800',
    addressText: '', items: [], total: 16.45, currency: 'EUR', paymentMethod: 'cod', pageUrl: 'https://adhdbg.eu/chekout', ip: '1', userAgent: '' });
  let r = await upsertCbOrder(q, mapOrder(cbOrder(), { store: 'adhdbg.eu' }));
  assert.deepEqual([r.inserted, r.id], [false, widget.id]);
  let [o] = (await listOrders(q)).rows;
  assert.equal(o.officeId, 'econt:5803', 'widget office id kept');
  assert.deepEqual(o.items, [{ name: 'Книга', qty: 1, price: 12.9 }], 'items from ConvertBuilder');
  r = await upsertCbOrder(q, mapOrder(cbOrder({ status: 'completed' }), { store: 'adhdbg.eu' }));
  [o] = (await listOrders(q)).rows;
  assert.equal(o.status, 'delivered');
  r = await upsertCbOrder(q, mapOrder(cbOrder({ id: 83, status: 'pending' }), { store: 'adhdbg.eu' }));
  assert.equal(r.inserted, true);
  assert.equal((await listOrders(q)).total, 2);
});

test('a widget beacon arriving after the ConvertBuilder copy fills in the office details', async () => {
  await upsertCbOrder(q, mapOrder(cbOrder({ shippingAddress: { phone: '+359888123456', city: 'Варна', zipCode: '9000', address: 'СПИДИ – офис ВАРНА (79)' } }), { store: 'adhdbg.eu' }));
  const r = await insertOrder(q, { cbOrderId: 'adhdbg.eu:82', name: 'Мария', phone: '0888123456', phoneNorm: '+359888123456', email: '',
    deliveryType: 'speedy_office', courier: 'speedy', officeId: 'speedy:79', officeText: 'СПИДИ – офис ВАРНА (79)', city: 'Варна', postCode: '9000',
    addressText: '', items: [], total: 16.45, currency: 'EUR', paymentMethod: 'cod', pageUrl: '', ip: '1', userAgent: '' });
  assert.equal(r.inserted, false);
  assert.equal((await listOrders(q)).rows[0].officeId, 'speedy:79');
});

async function connect() {
  await saveIntegration(q, 'convertbuilder', { config: { domain: 'adhdbg.eu', store: 'adhdbg.eu', active: true, webhookSecret: 'whsec' }, secret: 'API-KEY' });
}
const signed = (body, secret = 'whsec', topic = 'order_created') => fakeReq({ method: 'POST', headers: { 'x-webhook-topic': topic, 'x-webhook-signature': createHmac('sha512', secret).update(body).digest('hex') }, body });

test('the webhook stores signed ConvertBuilder orders and rejects bad signatures', async () => {
  await connect();
  const body = JSON.stringify(cbOrder());
  let res = fakeRes(); await webhook(signed(body, 'wrong'), res);
  assert.equal(res.statusCode, 401);
  res = fakeRes(); await webhook(signed(body), res);
  assert.deepEqual(json(res), { ok: true, inserted: true });
  const [o] = (await listOrders(q)).rows;
  assert.deepEqual([o.cbOrderId, o.deliveryType, o.total], ['adhdbg.eu:82', 'econt_office', 16.45]);
  res = fakeRes(); await webhook(signed(JSON.stringify(cbOrder({ status: 'canceled' })), 'whsec', 'order_updated'), res);
  assert.equal((await listOrders(q)).rows[0].status, 'cancelled');
  res = fakeRes(); await webhook(signed(JSON.stringify({ id: 5 }), 'whsec', 'product_created'), res);
  assert.deepEqual(json(res), { ok: true, ignored: 'product_created' });
});

test('the webhook does nothing while the integration is not connected', async () => {
  const res = fakeRes(); await webhook(signed(JSON.stringify(cbOrder())), res);
  assert.equal(res.statusCode, 404);
});

const cbApi = (orders) => async (url, init = {}) => {
  const u = new URL(url), method = init.method || 'GET', path = u.pathname;
  const ok = (data) => ({ ok: true, status: 200, json: async () => data });
  if (init.headers?.Authorization !== 'Bearer API-KEY') return { ok: false, status: 401, json: async () => ({ message: 'Invalid API key' }) };
  if (method === 'GET' && path === '/api/site/orders') {
    const skip = Number(u.searchParams.get('skip') || 0), limit = Number(u.searchParams.get('limit') || 30);
    return ok({ items: orders.slice(skip, skip + limit), totalCount: orders.length, limit, skip });
  }
  if (method === 'GET' && path === '/api/site/webhooks') return ok({ items: [] });
  if (method === 'POST' && path === '/api/site/webhooks') return ok({ id: 'wh1', ...JSON.parse(init.body) });
  return { ok: false, status: 404, json: async () => ({}) };
};

test('admin connects ConvertBuilder: test, webhook registration, encrypted key, sync', async () => {
  let res = fakeRes(); await integrationsApi(fakeReq({ url: '/api/admin/integrations' }), res);
  assert.equal(res.statusCode, 401);
  const orders = [cbOrder({ id: 90 }), cbOrder({ id: 91, status: 'completed' })];
  res = fakeRes();
  await withFetch(cbApi(orders), () => integrationsApi(fakeReq({ method: 'POST', headers: { cookie: cookie() },
    body: JSON.stringify({ action: 'save_convertbuilder', domain: 'https://adhdbg.eu/', apiKey: 'API-KEY', active: true }) }), res));
  assert.equal(json(res).ok, true);
  assert.equal(json(res).totalOrders, 2);
  const i = await getIntegration(q, 'convertbuilder');
  assert.deepEqual([i.config.domain, i.config.store, i.config.webhookId, i.config.active, i.hasSecret], ['adhdbg.eu', 'adhdbg.eu', 'wh1', true, true]);
  assert.ok(i.config.webhookSecret && i.config.webhookSecret.length >= 32);
  res = fakeRes();
  await withFetch(cbApi(orders), () => integrationsApi(fakeReq({ method: 'POST', headers: { cookie: cookie() }, body: JSON.stringify({ action: 'sync_convertbuilder', from: '2000-01-01' }) }), res));
  assert.deepEqual(json(res).result, { fetched: 2, inserted: 2, updated: 0 });
  assert.deepEqual((await listOrders(q)).rows.map((o) => o.status).sort(), ['delivered', 'new']);
  res = fakeRes(); await integrationsApi(fakeReq({ url: '/api/admin/integrations', headers: { cookie: cookie() } }), res);
  const st = json(res);
  assert.equal(st.convertbuilder.connected, true);
  assert.equal(st.convertbuilder.domain, 'adhdbg.eu');
  assert.equal(JSON.stringify(st).includes('API-KEY'), false, 'the key never leaves the server');
  assert.equal(JSON.stringify(st).includes(i.config.webhookSecret), false, 'nor the webhook secret');
});

test('a wrong ConvertBuilder key is reported and not saved', async () => {
  const res = fakeRes();
  await withFetch(cbApi([]), () => integrationsApi(fakeReq({ method: 'POST', headers: { cookie: cookie() },
    body: JSON.stringify({ action: 'save_convertbuilder', domain: 'adhdbg.eu', apiKey: 'WRONG', active: true }) }), res));
  assert.equal(res.statusCode, 400);
  assert.match(json(res).error, /Ключът е отхвърлен.*401/);
  assert.equal((await getIntegration(q, 'convertbuilder')).hasSecret, false);
});

test('a mistyped shop domain gets a plain-language error', async () => {
  const res = fakeRes();
  await integrationsApi(fakeReq({ method: 'POST', headers: { cookie: cookie() },
    body: JSON.stringify({ action: 'save_convertbuilder', domain: 'не е домейн', apiKey: 'KEY' }) }), res);
  assert.equal(res.statusCode, 400);
  assert.match(json(res).error, /Невалиден домейн/);
});

test('the nekorekten key can be saved from the admin and is used instead of the env', async () => {
  const { nekorektenKey } = await import('../lib/integrations-repo.js');
  process.env.NEKOREKTEN_API_KEY = 'ENV-KEY';
  assert.equal(await nekorektenKey(q), 'ENV-KEY');
  const res = fakeRes();
  await withFetch(async () => ({ ok: true, status: 200, json: async () => ({ items: { plan: { name: 'Безплатен' }, searchRequests: { used: 1, limit: 30 } } }) }),
    () => integrationsApi(fakeReq({ method: 'POST', headers: { cookie: cookie() }, body: JSON.stringify({ action: 'save_nekorekten', apiKey: 'DB-KEY' }) }), res));
  assert.equal(json(res).ok, true);
  assert.equal(await nekorektenKey(q), 'DB-KEY');
  delete process.env.NEKOREKTEN_API_KEY;
});
