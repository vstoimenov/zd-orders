import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { insertOrder } from '../lib/orders-repo.js';
import { signSession } from '../lib/auth.js';
import { createClient, acceptInvite, clientSession } from '../lib/users.js';
import { saveSubscription, setPushSenderForTests } from '../lib/push.js';
import router from '../api/admin/[route].js';

process.env.ADMIN_SECRET = 'secret';
process.env.VAPID_PUBLIC_KEY = 'B'; process.env.VAPID_PRIVATE_KEY = 'p';
const SECRET = 'voice-secret';
const SHOP = '00000000-0000-4000-8000-000000000001';
const owner = `zdo_admin=${signSession('secret')}`;
const realFetch = globalThis.fetch;
let q, orderId, sent, calls;

const call = async ({ url = `/api/admin/voice?shop=${SHOP}`, cookie = owner, headers = {}, body }) => {
  const res = fakeRes();
  await router({ method: 'POST', url, headers: { ...(cookie ? { cookie } : {}), ...headers }, body, socket: {} }, res);
  return res;
};
const signed = (payload, { secret = SECRET, ts = String(Math.floor(Date.now() / 1000)) } = {}) => {
  const body = JSON.stringify(payload);
  return { body, cookie: null, headers: { 'x-ordyx-time': ts, 'x-ordyx-signature': createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex') } };
};
const statusOf = async (id) => (await q(`select status, confirm_answer from zd.orders where id = $1::uuid`, [id]))[0];

beforeEach(async () => {
  q = await makeTestQuery(); setQueryForTests(q);
  process.env.VOICE_CALL_URL = 'https://voice.example/ordyx/call';
  process.env.VOICE_CALL_SECRET = SECRET;
  orderId = (await insertOrder(q, {
    cbOrderId: 'a-shop.bg:7', name: 'Мария Иванова', phone: '0888 123 456', phoneNorm: '+359888123456', email: '', deliveryType: 'econt_office', courier: 'econt',
    officeId: 'econt:1', officeText: 'ЕКОНТ – офис Плевен (5803)', city: 'Плевен', postCode: '5800', addressText: '', items: [{ name: 'Книга', qty: 2, price: 20 }],
    total: 22.57, currency: 'EUR', paymentMethod: 'cod', pageUrl: '', ip: '1', shopId: SHOP,
  })).id;
  calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ ok: true, room: 'ordyx-1' }), { status: 200 }); };
  sent = [];
  setPushSenderForTests(async (s, payload) => { sent.push(JSON.parse(payload)); return { statusCode: 201 }; });
  await saveSubscription(q, { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/owner', keys: { p256dh: 'p', auth: 'a' } }, shopId: null });
});
afterEach(() => { globalThis.fetch = realFetch; });

test('📞 sends only what the agent says, signed — no keys of the agent\'s server here', async () => {
  const res = await call({ body: JSON.stringify({ action: 'call', id: orderId }) });
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://voice.example/ordyx/call');
  const sentBody = JSON.parse(calls[0].init.body);
  assert.deepEqual(sentBody, { order_id: orderId, customer_name: 'Мария Иванова', phone: '+359888123456', items: [{ name: 'Книга', qty: 2 }], total: 22.57, currency: 'EUR' });
  const h = calls[0].init.headers;
  assert.equal(h['X-Ordyx-Signature'], createHmac('sha256', SECRET).update(`${h['X-Ordyx-Time']}.${calls[0].init.body}`).digest('hex'));
});

test('📞 needs a login, the setting, an open order — and only within the admin\'s shops', async () => {
  assert.equal((await call({ cookie: null, body: JSON.stringify({ action: 'call', id: orderId }) })).statusCode, 401);
  const other = await q(`insert into zd.shops (name, domain) values ('Б', 'b.bg') returning id`);
  const c = await createClient(q, { email: 'c@x.bg', name: 'К', shopIds: [other[0].id] });
  await acceptInvite(q, c.token, 'client-pass-1');
  const [u] = await q(`select id, session_version from zd.users where email = 'c@x.bg'`);
  const client = `zdo_admin=${clientSession('secret', u)}`;
  assert.equal((await call({ url: '/api/admin/voice', cookie: client, body: JSON.stringify({ action: 'call', id: orderId }) })).statusCode, 404);
  await q(`update zd.orders set status = 'shipped' where id = $1::uuid`, [orderId]);
  const shipped = await call({ body: JSON.stringify({ action: 'call', id: orderId }) });
  assert.equal(shipped.statusCode, 400);
  delete process.env.VOICE_CALL_URL;
  const off = await call({ body: JSON.stringify({ action: 'call', id: orderId }) });
  assert.match(json(off).error, /не са настроени/);
  assert.equal(calls.length, 0);
});

test('the agent\'s server error reaches the admin in Bulgarian', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Обаждания само между 9:00 и 20:00' }), { status: 429 });
  const res = await call({ body: JSON.stringify({ action: 'call', id: orderId }) });
  assert.equal(res.statusCode, 400);
  assert.equal(json(res).error, 'Обаждания само между 9:00 и 20:00');
});

test('a signed "yes" confirms the order and tells the shop', async () => {
  const res = await call(signed({ order_id: orderId, answer: 'yes' }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(await statusOf(orderId), { status: 'confirmed', confirm_answer: 'yes' });
  assert.match(sent.at(-1).title, /потвърди по телефона/);
});

test('"no" or no pickup changes nothing but tells the shop', async () => {
  for (const answer of ['no', 'no_answer', 'unclear']) assert.equal((await call(signed({ order_id: orderId, answer }))).statusCode, 200);
  assert.deepEqual(await statusOf(orderId), { status: 'new', confirm_answer: '' });
  assert.equal(sent.length, 3);
});

test('a wrong, old or replayed-elsewhere signature changes nothing', async () => {
  assert.equal((await call(signed({ order_id: orderId, answer: 'yes' }, { secret: 'other' }))).statusCode, 401);
  assert.equal((await call(signed({ order_id: orderId, answer: 'yes' }, { ts: String(Math.floor(Date.now() / 1000) - 3600) }))).statusCode, 401);
  const s = signed({ order_id: orderId, answer: 'no' });
  assert.equal((await call({ ...s, body: JSON.stringify({ order_id: orderId, answer: 'yes' }) })).statusCode, 401);
  assert.deepEqual(await statusOf(orderId), { status: 'new', confirm_answer: '' });
});

test('a "yes" after the order was sent does not reopen it', async () => {
  await q(`update zd.orders set status = 'shipped' where id = $1::uuid`, [orderId]);
  assert.equal((await call(signed({ order_id: orderId, answer: 'yes' }))).statusCode, 200);
  assert.equal((await statusOf(orderId)).status, 'shipped');
});
