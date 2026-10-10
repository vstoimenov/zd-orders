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
process.env.ZD_APP_PASSWORD = 'real-db-role-password';
process.env.VERCEL_OIDC_TOKEN = 'real-oidc';

let demo, push;
const econtCalls = [];
// Econt's test server is the only real outside call of the demo: the tests answer for it
globalThis.fetch = async (url, init) => { econtCalls.push({ url: String(url), auth: init?.headers?.Authorization }); return { ok: true, status: 200, json: async () => ({ profiles: [{ client: { name: 'ЕТ КОНСУЛТ', phones: [] }, addresses: [] }] }) }; };

/** a visitor: keeps the demo cookie it was given, like a browser */
function visitor() {
  let cookie = '';
  return async (method, url, body) => {
    const res = fakeRes();
    await demo(fakeReq({ method, url, body: body && JSON.stringify(body), headers: cookie ? { cookie } : {} }), res);
    const set = res.headers['set-cookie'];
    if (set) cookie = String(set).split(';')[0];
    return res;
  };
}
let call;
before(async () => {
  call = visitor();
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
  assert.equal(process.env.ZD_APP_PASSWORD, undefined, 'only allowed variables stay');
  assert.equal(process.env.VERCEL_OIDC_TOKEN, undefined);
  assert.notEqual(process.env.VAPID_PRIVATE_KEY, 'demo-private', 'its own push keys');
  assert.notEqual(process.env.ADMIN_SECRET, 'real-admin-secret');
  assert.equal(process.env.NEKOREKTEN_API_KEY, undefined);
  assert.equal(process.env.META_APP_SECRET, undefined);
  const res = await call('GET', '/api/demo/meta?start=1');
  assert.equal(res.statusCode, 404, 'no Facebook login route');
});

test('Econt in the demo always uses its public test account on the test server, whatever a visitor types', async () => {
  const shops = json(await call('GET', '/api/demo/shops')).shops;
  econtCalls.length = 0;
  for (const demoFlag of [false, 0, '', null]) {
    const res = await call('POST', `/api/demo/integrations?shop=${shops[0].id}`, { action: 'econt_profile', username: 'real-user', password: 'real-pass', demo: demoFlag });
    assert.equal(res.statusCode, 200);
  }
  assert.ok(econtCalls.length >= 4);
  for (const c of econtCalls) {
    assert.match(c.url, /^https:\/\/demo\.econt\.com\//);
    assert.equal(c.auth, `Basic ${Buffer.from('iasp-dev:1Asp-dev').toString('base64')}`, 'the typed login never leaves the demo');
  }
});

test('every visitor gets their own demo: changes and notifications stay with them', async () => {
  const a = visitor(), b = visitor();
  const shopA = json(await a('GET', '/api/demo/shops')).shops[0].id;
  const shopB = json(await b('GET', '/api/demo/shops')).shops[0].id;
  const sent = [];
  push.setPushSenderForTests(async (sub, payload) => { sent.push(sub.endpoint); return { statusCode: 201 }; });
  await b('POST', `/api/demo/push?shop=${shopB}`, { action: 'subscribe', subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/visitor-b', keys: { p256dh: 'p', auth: 'a' } } });
  await a('POST', `/api/demo/integrations?shop=${shopA}`, { action: 'save_shop', name: 'ХАКНАТО', url: '', email: '', phone: '', currency: 'EUR' });
  const before = json(await b('GET', `/api/demo/orders?shop=${shopB}`)).total;
  await new Promise((r) => setTimeout(r, 10));
  assert.equal((await a('POST', `/api/demo/simulate?shop=${shopA}`, {})).statusCode, 200);
  assert.equal(json(await b('GET', `/api/demo/orders?shop=${shopB}`)).total, before, 'B does not see A\'s order');
  assert.equal(json(await b('GET', '/api/demo/shops')).shops[0].name, 'Демо магазин', 'B does not see A\'s rename');
  assert.deepEqual(sent, [], 'A\'s order never notifies B');
});

test('a demo has limits: too many shops are refused', async () => {
  const v = visitor();
  let last;
  for (let i = 0; i < 8; i++) last = await v('POST', '/api/demo/shops', { name: `Магазин ${i}`, domain: `m${i}-demo.bg` });
  assert.equal(last.statusCode, 429);
  assert.match(json(last).error, /лимит/);
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
