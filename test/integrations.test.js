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

const post = (body) => fakeReq({ method: 'POST', headers: { cookie: cookie() }, body: JSON.stringify(body) });
const recording = (impl) => { const calls = []; const f = async (url, init = {}) => { calls.push({ url: String(url), method: init.method || 'GET', auth: init.headers?.Authorization }); return impl(url, init); }; f.calls = calls; return f; };

test('a manual status change survives re-syncs; only a new ConvertBuilder status moves it', async () => {
  const { updateStatus } = await import('../lib/orders-repo.js');
  const r = await upsertCbOrder(q, mapOrder(cbOrder({ status: 'pending' }), { store: 'adhdbg.eu' }));
  await updateStatus(q, r.id, 'shipped');
  await upsertCbOrder(q, mapOrder(cbOrder({ status: 'pending' }), { store: 'adhdbg.eu' }));
  assert.equal((await listOrders(q)).rows[0].status, 'shipped', 'same CB status again → keep the admin status');
  await upsertCbOrder(q, mapOrder(cbOrder({ status: 'canceled' }), { store: 'adhdbg.eu' }));
  assert.equal((await listOrders(q)).rows[0].status, 'cancelled', 'CB status changed → follow it');
  const r2 = await upsertCbOrder(q, mapOrder(cbOrder({ id: 99, status: 'pending' }), { store: 'adhdbg.eu' }));
  await updateStatus(q, r2.id, 'delivered');
  await upsertCbOrder(q, mapOrder(cbOrder({ id: 99, status: 'shipped' }), { store: 'adhdbg.eu' }));
  assert.equal((await listOrders(q)).rows.find((o) => o.id === r2.id).status, 'delivered', 'never back from delivered to shipped');
});

test('the stored key is never sent to a different domain', async () => {
  await connect();
  const f = recording(cbApi([]));
  const res = fakeRes();
  await withFetch(f, () => integrationsApi(post({ action: 'save_convertbuilder', domain: 'attacker.example', apiKey: '' }), res));
  assert.equal(res.statusCode, 400);
  assert.match(json(res).error, /въведете API ключа отново/);
  assert.equal(f.calls.length, 0);
  assert.equal((await getIntegration(q, 'convertbuilder')).config.domain, 'adhdbg.eu');
});

test('the shop domain must match the one the checkout widget records orders under', async () => {
  await insertOrder(q, { cbOrderId: 'adhdbg.eu:81', name: 'А', phone: '', phoneNorm: '', email: '', deliveryType: 'econt_office', courier: 'econt',
    officeId: 'econt:1', officeText: 'ЕКОНТ – офис', city: 'Х', postCode: '1000', addressText: '', items: [], total: 1, currency: 'EUR', paymentMethod: 'cod', pageUrl: '', ip: '1', userAgent: '' });
  const f = recording(cbApi([]));
  let res = fakeRes();
  await withFetch(f, () => integrationsApi(post({ action: 'save_convertbuilder', domain: 'viktorstoimenov12-70.convertbuilder.com', apiKey: 'API-KEY' }), res));
  assert.equal(res.statusCode, 400);
  assert.match(json(res).error, /adhdbg\.eu/);
  assert.equal(f.calls.length, 0);
  res = fakeRes();
  await withFetch(cbApi([]), () => integrationsApi(post({ action: 'save_convertbuilder', domain: 'www.adhdbg.eu', apiKey: 'API-KEY' }), res));
  assert.equal(res.statusCode, 200);
});

test('nothing is registered at ConvertBuilder while keys cannot be stored', async () => {
  const saved = process.env.INTEGRATIONS_SECRET;
  delete process.env.INTEGRATIONS_SECRET;
  const f = recording(cbApi([]));
  const res = fakeRes();
  try { await withFetch(f, () => integrationsApi(post({ action: 'save_convertbuilder', domain: 'adhdbg.eu', apiKey: 'API-KEY' }), res)); }
  finally { process.env.INTEGRATIONS_SECRET = saved; }
  assert.equal(res.statusCode, 400);
  assert.match(json(res).error, /INTEGRATIONS_SECRET/);
  assert.equal(f.calls.length, 0);
});

test('switching the integration off removes our webhook', async () => {
  const hooks = [{ id: 'wh0', target: 'https://kurier.profitbrand.online/api/cb/webhook' }, { id: 'other', target: 'https://else.example/hook' }];
  const base = cbApi([]);
  const f = recording(async (url, init = {}) => {
    const path = new URL(url).pathname;
    if ((init.method || 'GET') === 'GET' && path === '/api/site/webhooks') return { ok: true, status: 200, json: async () => ({ items: hooks }) };
    if (init.method === 'DELETE') return { ok: true, status: 200, json: async () => ({}) };
    return base(url, init);
  });
  await saveIntegration(q, 'convertbuilder', { config: { domain: 'adhdbg.eu', store: 'adhdbg.eu', active: true, webhookSecret: 'whsec', webhookId: 'wh0' }, secret: 'API-KEY' });
  const res = fakeRes();
  await withFetch(f, () => integrationsApi(post({ action: 'save_convertbuilder', domain: 'adhdbg.eu', apiKey: '', active: false }), res));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(f.calls.filter((c) => c.method === 'DELETE').map((c) => new URL(c.url).pathname), ['/api/site/webhooks/wh0']);
  const i = await getIntegration(q, 'convertbuilder');
  assert.deepEqual([i.config.active, i.config.webhookId, i.config.webhookSecret], [false, null, null]);
});

test('config writes merge in the database, so a finishing sync cannot restore an old webhook secret', async () => {
  await saveIntegration(q, 'convertbuilder', { config: { domain: 'adhdbg.eu', webhookSecret: 'old' }, secret: 'API-KEY' });
  // admin re-save and a finishing sync at the same moment: neither may drop the other's fields
  await Promise.all([
    saveIntegration(q, 'convertbuilder', { config: { webhookSecret: 'new' } }),
    saveIntegration(q, 'convertbuilder', { config: { lastSyncAt: 'now' } }),
  ]);
  assert.deepEqual((await getIntegration(q, 'convertbuilder')).config, { domain: 'adhdbg.eu', webhookSecret: 'new', lastSyncAt: 'now' });
});

test('sync rejects impossible dates and stores errors in Bulgarian', async () => {
  const { syncOrders } = await import('../lib/cb-sync.js');
  await connect();
  await assert.rejects(syncOrders(q, { from: '2026-13-45' }), /Невалидна дата/);
  await withFetch(async () => ({ ok: false, status: 500, json: async () => ({}) }), () => assert.rejects(syncOrders(q, { from: '2026-10-01' })));
  assert.match((await getIntegration(q, 'convertbuilder')).config.lastError, /временно не отговаря/);
});

test('sync day boundaries follow Sofia summer and winter time', async () => {
  const { dayRange } = await import('../lib/cb-sync.js');
  assert.equal(dayRange('2026-10-05', false), Date.parse('2026-10-05T00:00:00+03:00') / 1000);
  assert.equal(dayRange('2026-11-05', true), Date.parse('2026-11-05T23:59:59+02:00') / 1000);
});

test('the nightly cron still catches up ConvertBuilder orders when Econt is down', async () => {
  const { default: refresh } = await import('../api/cron/refresh.js');
  process.env.CRON_SECRET = 'cron';
  await connect();
  const cb = cbApi([cbOrder({ id: 120 })]);
  const res = fakeRes();
  await withFetch(async (url, init) => (String(url).includes('/api/site/') ? cb(url, init) : { ok: false, status: 503, json: async () => ({}) }),
    () => refresh(fakeReq({ headers: { authorization: 'Bearer cron' } }), res));
  assert.equal(res.statusCode, 500, 'the Econt failure is still reported');
  assert.deepEqual(json(res).convertbuilder, { fetched: 1, inserted: 1, updated: 0 });
  assert.equal((await listOrders(q)).rows[0].cbOrderId, 'adhdbg.eu:120');
});

test('a status set in the admin is kept when ConvertBuilder first reports the order', async () => {
  const { updateStatus } = await import('../lib/orders-repo.js');
  const w = await insertOrder(q, { cbOrderId: 'adhdbg.eu:82', name: 'Мария', phone: '0888123456', phoneNorm: '+359888123456', email: '',
    deliveryType: 'econt_office', courier: 'econt', officeId: 'econt:5803', officeText: 'ЕКОНТ – офис', city: 'Плевен', postCode: '5800',
    addressText: '', items: [], total: 16.45, currency: 'EUR', paymentMethod: 'cod', pageUrl: '', ip: '1', userAgent: '' });
  await updateStatus(q, w.id, 'returned');
  await upsertCbOrder(q, mapOrder(cbOrder({ status: 'completed' }), { store: 'adhdbg.eu' }));
  assert.equal((await listOrders(q)).rows[0].status, 'returned', 'first sighting does not override a handled order');
  const fresh = await insertOrder(q, { cbOrderId: 'adhdbg.eu:83', name: 'Б', phone: '', phoneNorm: '', email: '', deliveryType: 'econt_office', courier: 'econt',
    officeId: 'econt:1', officeText: 'ЕКОНТ – офис', city: 'Х', postCode: '1000', addressText: '', items: [], total: 1, currency: 'EUR', paymentMethod: 'cod', pageUrl: '', ip: '2', userAgent: '' });
  await upsertCbOrder(q, mapOrder(cbOrder({ id: 83, status: 'shipped' }), { store: 'adhdbg.eu' }));
  assert.equal((await listOrders(q)).rows.find((o) => o.id === fresh.id).status, 'shipped', 'a new order follows ConvertBuilder');
});

test('a returned order is never moved automatically', async () => {
  const { updateStatus } = await import('../lib/orders-repo.js');
  const r = await upsertCbOrder(q, mapOrder(cbOrder({ status: 'shipped' }), { store: 'adhdbg.eu' }));
  await updateStatus(q, r.id, 'returned');
  await upsertCbOrder(q, mapOrder(cbOrder({ status: 'completed' }), { store: 'adhdbg.eu' }));
  assert.equal((await listOrders(q)).rows[0].status, 'returned');
});

test('the integration can be switched off even with a revoked key', async () => {
  await saveIntegration(q, 'convertbuilder', { config: { domain: 'adhdbg.eu', store: 'adhdbg.eu', active: true, webhookSecret: 'whsec', webhookId: 'wh0' }, secret: 'REVOKED' });
  const res = fakeRes();
  await withFetch(cbApi([]), () => integrationsApi(post({ action: 'save_convertbuilder', domain: 'adhdbg.eu', apiKey: '', active: false }), res));
  assert.equal(res.statusCode, 200);
  const i = await getIntegration(q, 'convertbuilder');
  assert.deepEqual([i.config.active, i.config.webhookId], [false, null]);
});

test('a failed webhook registration does not leave a stale "registered" mark', async () => {
  await saveIntegration(q, 'convertbuilder', { config: { domain: 'adhdbg.eu', store: 'adhdbg.eu', active: true, webhookSecret: 'whsec', webhookId: 'wh0' }, secret: 'API-KEY' });
  const base = cbApi([]);
  const res = fakeRes();
  await withFetch(async (url, init = {}) => (init.method === 'POST' ? { ok: false, status: 500, json: async () => ({}) } : base(url, init)),
    () => integrationsApi(post({ action: 'save_convertbuilder', domain: 'adhdbg.eu', apiKey: '' }), res));
  assert.equal(res.statusCode, 400);
  assert.equal((await getIntegration(q, 'convertbuilder')).config.webhookId, null);
});

test('a redirecting domain (www → bare) is reported instead of a misleading key error', async () => {
  const { cbRequest } = await import('../lib/convertbuilder.js');
  const fetchImpl = async () => ({ ok: false, status: 301, headers: new Headers({ location: 'https://adhdbg.eu/api/site/orders?limit=1' }), json: async () => ({}) });
  await assert.rejects(cbRequest({ domain: 'www.adhdbg.eu', apiKey: 'K' }, '/orders?limit=1', { fetchImpl }), /въведете adhdbg\.eu/);
});
