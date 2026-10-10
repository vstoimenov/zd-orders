import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { fakeReq, fakeRes, json } from './helpers/http.js';

// the demo must never reach the real database or platform keys, even when they are set
process.env.DATABASE_URL = 'postgres://real-user:real-pass@real-db.invalid:5432/postgres';
process.env.ADMIN_SECRET = 'real-admin-secret';
process.env.NEKOREKTEN_API_KEY = 'real-nk-key';
process.env.META_APP_ID = '1136036008845539';
process.env.META_APP_SECRET = 'real-meta-secret';
process.env.VAPID_PUBLIC_KEY = 'BDemoPublic';
process.env.VAPID_PRIVATE_KEY = 'demo-private';

let demo, push;
const call = async (method, url, body) => {
  const res = fakeRes();
  await demo(fakeReq({ method, url, body: body && JSON.stringify(body) }), res);
  return res;
};
before(async () => {
  ({ default: demo } = await import('../api/demo/[route].js'));
  push = await import('../lib/push.js');
});

test('the demo opens without a password and is full of sample data', async () => {
  const shops = json(await call('GET', '/api/demo/shops'));
  assert.ok(shops.shops.length >= 2, 'several sample shops');
  const first = shops.shops[0].id;
  const orders = json(await call('GET', `/api/demo/orders?shop=${first}`));
  assert.ok(orders.total >= 25, `sample orders: ${orders.total}`);
  const statuses = new Set(orders.orders.map((o) => o.status));
  assert.ok(statuses.size >= 4, 'orders in many statuses');
  const stats = json(await call('GET', `/api/demo/stats?shop=${first}&from=${new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10)}&to=${new Date().toISOString().slice(0, 10)}`));
  assert.ok(stats.cards.orders >= 10);
  assert.ok(stats.cards.visits > 0);
  const integ = json(await call('GET', `/api/demo/integrations?shop=${first}`));
  assert.equal(integ.econtApi.connected, true);
  assert.equal(integ.econtApi.demo, true);
  assert.equal(integ.speedyApi.connected, true);
  assert.equal(integ.convertbuilder.connected, true);
  assert.equal(integ.nekorekten.enabled, false, 'no platform key in the demo');
  assert.equal(integ.meta.oauth, false, 'no Facebook login in the demo');
});

test('the demo never uses the real database, admin secret or platform keys', async () => {
  assert.equal(process.env.DATABASE_URL, undefined);
  assert.notEqual(process.env.ADMIN_SECRET, 'real-admin-secret');
  assert.equal(process.env.NEKOREKTEN_API_KEY, undefined);
  assert.equal(process.env.META_APP_SECRET, undefined);
  const res = await call('GET', '/api/demo/meta?start=1');
  assert.equal(res.statusCode, 404, 'no Facebook login route');
});

test('Econt in the demo works only in test mode', async () => {
  const shops = json(await call('GET', '/api/demo/shops')).shops;
  const res = await call('POST', `/api/demo/integrations?shop=${shops[0].id}`, { action: 'econt_profile', username: 'real-user', password: 'real-pass', demo: false });
  assert.equal(res.statusCode, 400);
  assert.match(json(res).error, /тестов режим/);
});

test('"Симулирай нова поръчка" adds an order and sends the new-order notification', async () => {
  const sent = [];
  push.setPushSenderForTests(async (sub, payload) => { sent.push(JSON.parse(payload)); return { statusCode: 201 }; });
  const shop = json(await call('GET', '/api/demo/shops')).shops[0].id;
  await call('POST', `/api/demo/push?shop=${shop}`, { action: 'subscribe', subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/demo-device', keys: { p256dh: 'p', auth: 'a' } } });
  const before = json(await call('GET', `/api/demo/orders?shop=${shop}`)).total;
  const res = await call('POST', `/api/demo/simulate?shop=${shop}`, {});
  assert.equal(res.statusCode, 200);
  const after = json(await call('GET', `/api/demo/orders?shop=${shop}`));
  assert.equal(after.total, before + 1);
  assert.equal(after.orders[0].status, 'new');
  assert.equal(sent.length, 1);
  assert.match(sent[0].title, /Нова поръчка/);
  assert.match(sent[0].url, /^\/demo\//, 'a tapped notification opens the demo, not the real admin');
  const again = await call('POST', `/api/demo/simulate?shop=${shop}`, {});
  assert.equal(again.statusCode, 429, 'a few seconds between simulated orders');
});

test('the demo login and logout always succeed (there is no password)', async () => {
  assert.equal((await call('POST', '/api/demo/login', { password: '' })).statusCode, 200);
  assert.equal((await call('DELETE', '/api/demo/login')).statusCode, 200);
  assert.equal((await call('GET', '/api/demo/nope')).statusCode, 404);
});

test('outside calls are faked or blocked: nothing real leaves the demo except the Econt test server', async () => {
  const { demoFetch } = await import('../lib/demo/fakes.js');
  const real = [];
  const f = demoFetch(async (url) => { real.push(String(url)); return { ok: true, status: 200, json: async () => ({}) }; });
  await f('https://demo.econt.com/ee/services/X.json', { method: 'POST', body: '{}' });
  assert.deepEqual(real, ['https://demo.econt.com/ee/services/X.json']);
  const live = await f('https://ee.econt.com/services/X.json', { method: 'POST', body: '{}' });
  assert.equal(live.ok, false);
  const sp = await f('https://api.speedy.bg/v1/services', { method: 'POST', body: JSON.stringify({ userName: 'x', password: 'demo' }) });
  assert.ok((await sp.json()).services);
  const other = await f('https://example.com/steal', { method: 'POST', body: '{}' });
  assert.equal(other.ok, false);
  assert.equal(real.length, 1);
});
