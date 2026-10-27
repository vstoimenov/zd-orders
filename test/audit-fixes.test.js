// Fixes from the pre-launch audit (2026-10-27): what many new self-registered clients would hit.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { signSession } from '../lib/auth.js';
import { createClient, acceptInvite, clientSession } from '../lib/users.js';
import { saveSubscription, setPushSenderForTests } from '../lib/push.js';
import { insertOrder } from '../lib/orders-repo.js';
import router from '../api/admin/[route].js';
import { resetLoginLimitForTests } from '../lib/admin/login.js';

process.env.ADMIN_SECRET = 'secret';
process.env.INTEGRATIONS_SECRET = 'test-secret';
process.env.VAPID_PUBLIC_KEY = 'B'; process.env.VAPID_PRIVATE_KEY = 'p';
const owner = `zdo_admin=${signSession('secret')}`;
let q, client, clientId, pushed;
beforeEach(async () => {
  q = await makeTestQuery(); setQueryForTests(q); resetLoginLimitForTests();
  const c = await createClient(q, { email: 'c@x.bg', name: 'Кирил' });
  await acceptInvite(q, c.token, 'client-pass-1');
  const [u] = await q(`select id, session_version from zd.users where email = 'c@x.bg'`);
  clientId = u.id; client = `zdo_admin=${clientSession('secret', u)}`;
  pushed = [];
  setPushSenderForTests(async (s, payload) => { pushed.push(JSON.parse(payload)); return { statusCode: 201 }; });
  await saveSubscription(q, { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/owner', keys: { p256dh: 'p', auth: 'a' } }, shopId: null });
});
const call = async (cookie, method, url, body) => { const res = fakeRes(); await router({ method, url, headers: { cookie }, body: body && JSON.stringify(body), socket: {} }, res); return res; };
const addShop = async (domain) => json(await call(client, 'POST', '/api/admin/shops', { name: 'Негов', domain })).shop;

test("saving a client's shops in „Клиенти“ keeps the shops the client added; the list names them", async () => {
  const shop = await addShop('negov.bg');
  assert.equal((await call(owner, 'POST', '/api/admin/users', { action: 'update', id: clientId, name: 'Кирил', shopIds: [] })).statusCode, 200);
  assert.deepEqual((await q(`select shop_id from zd.user_shops where user_id = $1::uuid`, [clientId])).map((r) => r.shop_id), [shop.id]);
  const row = json(await call(owner, 'GET', '/api/admin/users')).users.find((u) => u.id === clientId);
  assert.deepEqual(row.shops.map((s) => [s.name, s.domain, s.approved]), [['Негов', 'negov.bg', false]]);
});

test('the owner hears at once that a client shop waits for approval', async () => {
  await addShop('negov.bg');
  assert.ok(pushed.some((p) => /одобрение/.test(p.title) && /negov\.bg/.test(p.body)), JSON.stringify(pushed));
});

test('the owner can refuse an unapproved shop without orders: it is gone and its domain is free again', async () => {
  const shop = await addShop('typo-domian.bg');
  const r = await call(owner, 'POST', '/api/admin/users', { action: 'reject_shop', shopId: shop.id });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal((await q(`select 1 from zd.shops where id = $1::uuid`, [shop.id])).length, 0);
  assert.equal((await addShop('typo-domian.bg')).domain, 'typo-domian.bg', 'the domain can be taken again');
});

test('an approved shop or one with orders is never refused (deleted)', async () => {
  const a = await addShop('a-shop.bg');
  await call(owner, 'POST', '/api/admin/users', { action: 'approve_shop', shopId: a.id });
  assert.equal((await call(owner, 'POST', '/api/admin/users', { action: 'reject_shop', shopId: a.id })).statusCode, 400);
  const b = await addShop('b-shop.bg');
  await insertOrder(q, { cbOrderId: 'b-shop.bg:1', name: 'М', phone: '0888123456', phoneNorm: '+359888123456', email: '', deliveryType: 'econt_office', courier: 'econt',
    officeId: '', officeText: 'x', city: 'София', postCode: '', addressText: '', items: [{ name: 'К', qty: 1, price: 1 }], total: 1, currency: 'EUR', paymentMethod: 'cod', pageUrl: '', shopId: b.id });
  assert.equal((await call(owner, 'POST', '/api/admin/users', { action: 'reject_shop', shopId: b.id })).statusCode, 400);
  assert.equal((await call(client, 'POST', '/api/admin/users', { action: 'reject_shop', shopId: b.id })).statusCode, 403);
});

const login = async (body, ip = '9.9.9.9') => { const res = fakeRes(); await router({ method: 'POST', url: '/api/admin/login', headers: { 'x-forwarded-for': ip }, body: JSON.stringify(body), socket: { remoteAddress: ip } }, res); return res; };

test('while an account is locked no guess is checked: the right password gets the same answer as a wrong one (no oracle)', async () => {
  for (let i = 0; i < 11; i++) await login({ email: 'c@x.bg', password: 'wrong-pass' }, `10.0.0.${i}`);
  const right = await login({ email: 'c@x.bg', password: 'client-pass-1' }, '10.0.1.1');
  const wrong = await login({ email: 'c@x.bg', password: 'still-wrong' }, '10.0.1.2');
  assert.equal(right.statusCode, 401);
  assert.equal(json(right).error, json(wrong).error);
  assert.match(json(right).error, /15 минути/, 'everyone is told how long the pause is');
});

test('the owner password cannot be guessed at full speed from one address', async () => {
  process.env.ADMIN_PASSWORD = 'owner-real-pass';
  let last;
  for (let i = 0; i < 21; i++) last = await login({ password: `guess-${i}` }, '7.7.7.7');
  assert.equal(last.statusCode, 429);
  assert.equal((await login({ password: 'owner-real-pass' }, '7.7.7.8')).statusCode, 200, 'another address still logs in');
});

test("clients' typos on a shared Wi-Fi do not block the owner's login from that address", async () => {
  process.env.ADMIN_PASSWORD = 'owner-real-pass';
  for (let i = 0; i < 20; i++) await login({ email: `nobody${i}@x.bg`, password: 'typo-pass' }, '6.6.6.6');
  assert.equal((await login({ password: 'owner-real-pass' }, '6.6.6.6')).statusCode, 200);
});

test('a session used in its last 3 days gets a fresh week; a fresh one is left alone (the phone app asked for the password every week)', async () => {
  const me = async (cookie) => { const res = fakeRes(); await router({ method: 'GET', url: '/api/admin/me', headers: { cookie }, socket: {} }, res); return res; };
  const [u] = await q(`select id, session_version from zd.users where email = 'c@x.bg'`);
  const old = Math.floor(Date.now() / 1000) - 5 * 86400;
  const renewed = await me(`zdo_admin=${clientSession('secret', u, old)}`);
  assert.equal(renewed.statusCode, 200);
  const cookie = renewed.headers['set-cookie'];
  assert.ok(cookie && /zdo_admin=c\./.test(cookie) && /Max-Age=604800/.test(cookie), String(cookie));
  const exp = Number(cookie.split('=')[1].split(';')[0].split('.')[3]);
  assert.ok(exp - Math.floor(Date.now() / 1000) > 6 * 86400);
  assert.equal((await me(client)).headers['set-cookie'], undefined);
  const ownerOld = await me(`zdo_admin=${signSession('secret', old)}`);
  assert.equal(ownerOld.headers['set-cookie'], undefined, 'the owner token has no version to revoke it: it is not renewed');
});

test("the owner's phone is not notified about orders in a client's own shop; the client's phone is", async () => {
  const { notifyNewOrder, notifyShop } = await import('../lib/push.js');
  const shop = await addShop('negov.bg');
  await saveSubscription(q, { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/client', keys: { p256dh: 'p', auth: 'a' } }, shopId: shop.id, userId: clientId });
  const { id } = await insertOrder(q, { cbOrderId: 'negov.bg:1', name: 'М', phone: '0888123456', phoneNorm: '+359888123456', email: '', deliveryType: 'econt_office', courier: 'econt',
    officeId: '', officeText: 'x', city: 'София', postCode: '', addressText: '', items: [{ name: 'К', qty: 1, price: 1 }], total: 1, currency: 'EUR', paymentMethod: 'cod', pageUrl: '', shopId: shop.id });
  const endpoints = [];
  setPushSenderForTests(async (s) => { endpoints.push(s.endpoint); return { statusCode: 201 }; });
  await notifyNewOrder(q, id);
  await notifyShop(q, shop.id, { title: 't', body: 'b' });
  assert.ok(endpoints.length >= 2 && endpoints.every((e) => e.endsWith('/client')), JSON.stringify(endpoints));
});

test('two shops with one domain at the same moment: one is made, the other hears „вече има“, never „server“', async () => {
  const [a, b] = await Promise.all([1, 2].map(() => call(owner, 'POST', '/api/admin/shops', { name: 'Дубъл', domain: 'same-moment.bg' })));
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 400], a.body + ' | ' + b.body);
  assert.match(json(a.statusCode === 400 ? a : b).error, /вече има/);
});

test('refusing a shop that may not be refused leaves its settings in place', async () => {
  const shop = await addShop('keep-me.bg');
  await q(`insert into zd.integrations (provider, shop_id, config) values ('econt', $1::uuid, '{"sender":"x"}')`, [shop.id]);
  await call(owner, 'POST', '/api/admin/users', { action: 'approve_shop', shopId: shop.id });
  assert.equal((await call(owner, 'POST', '/api/admin/users', { action: 'reject_shop', shopId: shop.id })).statusCode, 400);
  assert.equal((await q(`select 1 from zd.integrations where shop_id = $1::uuid`, [shop.id])).length, 1);
});
