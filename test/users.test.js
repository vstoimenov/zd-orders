import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { insertOrder } from '../lib/orders-repo.js';
import { saveProduct } from '../lib/stock.js';
import { signSession } from '../lib/auth.js';
import { createClient, acceptInvite, updateClient } from '../lib/users.js';
import { saveSubscription, notifyNewOrder, setPushSenderForTests } from '../lib/push.js';
import router from '../api/admin/[route].js';
import { resetLoginLimitForTests } from '../lib/admin/login.js';

process.env.ADMIN_SECRET = 'secret';
process.env.ADMIN_PASSWORD = 'owner-pass';
process.env.INTEGRATIONS_SECRET = 'test-secret';
process.env.PUBLIC_BASE_URL = 'https://kurier.profitbrand.online';
process.env.VAPID_PUBLIC_KEY = 'B'; process.env.VAPID_PRIVATE_KEY = 'p';
const SHOP_A = '00000000-0000-4000-8000-000000000001';
let q, SHOP_B, orderA, orderB;

/** a raw request (no automatic ?shop=, unlike the shared helper) */
const req = ({ method = 'GET', url, cookie, body }) => ({ method, url, headers: cookie ? { cookie } : {}, body: body === undefined ? undefined : JSON.stringify(body), socket: { remoteAddress: '1.1.1.1' } });
async function call(opts) { const res = fakeRes(); await router(req(opts), res); return res; }
const owner = `zdo_admin=${signSession('secret')}`;
const cookieOf = (res) => String(res.headers['set-cookie'] || '').split(';')[0];

async function addOrder(shopId, name) {
  return (await insertOrder(q, {
    cbOrderId: `${shopId}:${Math.random()}`, name, phone: '0888123456', phoneNorm: '+359888123456', email: '', deliveryType: 'econt_office', courier: 'econt',
    officeId: 'econt:1', officeText: 'Офис', city: 'София', postCode: '1000', addressText: '', items: [{ name: 'Книга', qty: 1, price: 10 }], total: 10,
    currency: 'EUR', paymentMethod: 'cod', pageUrl: '', ip: '1', shopId,
  })).id;
}
/** a client with a password, logged in → its cookie */
async function clientWith(shopIds, email = 'a@client.bg') {
  const { token } = await createClient(q, { email, name: 'Клиент', shopIds });
  await acceptInvite(q, token, 'client-pass-1');
  const res = await call({ method: 'POST', url: '/api/admin/login', body: { email, password: 'client-pass-1' } });
  assert.equal(res.statusCode, 200);
  return cookieOf(res);
}

beforeEach(async () => {
  resetLoginLimitForTests();
  q = await makeTestQuery(); setQueryForTests(q);
  await q(`update zd.shops set domain = 'a-shop.bg', name = 'Магазин А' where id = $1`, [SHOP_A]);
  [{ id: SHOP_B }] = await q(`insert into zd.shops (name, domain) values ('Магазин Б', 'b-shop.bg') returning id`);
  orderA = await addOrder(SHOP_A, 'Купувач А');
  orderB = await addOrder(SHOP_B, 'Купувач Б');
  await saveProduct(q, { name: 'Продукт Б', stock: 5 }, { create: true, shopId: SHOP_B });
});

test('the owner logs in with the password only, as before; a client with email + password', async () => {
  let res = await call({ method: 'POST', url: '/api/admin/login', body: { password: 'owner-pass' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(json(await call({ url: '/api/admin/me', cookie: cookieOf(res) })), { role: 'owner' });
  const c = await clientWith([SHOP_A]);
  assert.deepEqual(json(await call({ url: '/api/admin/me', cookie: c })), { role: 'client', email: 'a@client.bg', name: 'Клиент', plan: 'standard', freeUntil: null });
  res = await call({ method: 'POST', url: '/api/admin/login', body: { email: 'a@client.bg', password: 'wrong' } });
  assert.equal(res.statusCode, 401);
  res = await call({ method: 'POST', url: '/api/admin/login', body: { email: 'A@Client.BG', password: 'client-pass-1' } });
  assert.equal(res.statusCode, 200, 'email is case-insensitive');
});

test('the owner creates a client and gets a one-time link; the link sets the password once', async () => {
  const res = await call({ method: 'POST', url: '/api/admin/users', cookie: owner, body: { action: 'create', email: 'new@client.bg', name: 'Нов', shopIds: [SHOP_B] } });
  assert.equal(res.statusCode, 200);
  const link = json(res).link;
  assert.match(link, /^https:\/\/kurier\.profitbrand\.online\/admin\/\?invite=[A-Za-z0-9_-]{40,}$/);
  const token = new URL(link).searchParams.get('invite');
  assert.deepEqual(json(await call({ url: `/api/admin/invite?token=${token}` })), { ok: true, email: 'new@client.bg', name: 'Нов' });
  assert.equal((await call({ method: 'POST', url: '/api/admin/invite', body: { token, password: 'short' } })).statusCode, 400, 'at least 8 characters');
  const set = await call({ method: 'POST', url: '/api/admin/invite', body: { token, password: 'a-good-password' } });
  assert.equal(set.statusCode, 200);
  assert.deepEqual(json(await call({ url: '/api/admin/me', cookie: cookieOf(set) })).role, 'client', 'logged in right away');
  assert.equal((await call({ method: 'POST', url: '/api/admin/invite', body: { token, password: 'another-password' } })).statusCode, 400, 'used once');
  const list = json(await call({ url: '/api/admin/users', cookie: owner })).users;
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].shopIds, [SHOP_B]);
  assert.equal(list[0].hasPassword, true);
  assert.ok(!JSON.stringify(list).includes('hash'));
});

test('a client sees only their shops and their orders — never another shop\'s', async () => {
  const c = await clientWith([SHOP_A]);
  const shops = json(await call({ url: '/api/admin/shops', cookie: c })).shops;
  assert.deepEqual(shops.map((s) => s.id), [SHOP_A]);
  for (const shop of ['all', SHOP_B, '']) {
    const orders = json(await call({ url: `/api/admin/orders?shop=${shop}`, cookie: c })).orders;
    assert.deepEqual(orders.map((o) => o.id), [orderA], `orders with shop=${shop}`);
  }
  const csv = await call({ url: `/api/admin/orders?shop=all&format=csv`, cookie: c });
  assert.ok(csv.body.includes('Купувач А') && !csv.body.includes('Купувач Б'));
  assert.equal((await call({ method: 'PATCH', url: '/api/admin/orders?shop=all', cookie: c, body: { id: orderB, status: 'cancelled' } })).statusCode, 404);
  assert.equal((await call({ method: 'DELETE', url: '/api/admin/orders?shop=all', cookie: c, body: { id: orderB } })).statusCode, 404);
  const [b] = await q(`select status from zd.orders where id = $1`, [orderB]);
  assert.equal(b.status, 'new');
});

test('a client\'s dashboard, costs, inventory and integrations never show another shop', async () => {
  const c = await clientWith([SHOP_A]);
  const stats = json(await call({ url: '/api/admin/stats?shop=all', cookie: c }));
  assert.equal(stats.cards.orders, 1);
  assert.deepEqual(stats.byShop.map((s) => s.id), [SHOP_A]);
  const inv = json(await call({ url: `/api/admin/inventory?shop=${SHOP_B}`, cookie: c }));
  assert.ok(!JSON.stringify(inv).includes('Продукт Б'), 'falls back to an own shop, never B');
  assert.equal((await call({ method: 'POST', url: `/api/admin/inventory?shop=${SHOP_B}`, cookie: c, body: { action: 'save', name: 'X', create: true } })).statusCode, 400);
  assert.equal((await call({ method: 'PUT', url: `/api/admin/costs?shop=${SHOP_B}`, cookie: c, body: { products: [], settings: {} } })).statusCode, 400);
  const integ = json(await call({ url: `/api/admin/integrations?shop=${SHOP_B}`, cookie: c }));
  assert.equal(integ.shop.id, SHOP_A);
  assert.equal((await call({ method: 'POST', url: `/api/admin/integrations?shop=${SHOP_B}`, cookie: c, body: { action: 'save_shop', name: 'Х' } })).statusCode, 400);
  assert.equal((await call({ method: 'POST', url: '/api/admin/waybills?shop=all', cookie: c, body: { action: 'defaults', id: orderB } })).statusCode, 400);
  const meta = await call({ url: `/api/admin/meta?start=1&shop=${SHOP_B}`, cookie: c });
  assert.equal(meta.statusCode, 302);
  assert.match(meta.headers.location, /meta_error=/, 'no Facebook login for another shop');
});

test('a client adds their own shop and may hide only their own', async () => {
  const c = await clientWith([SHOP_A]);
  const res = await call({ method: 'POST', url: '/api/admin/shops', cookie: c, body: { name: 'Нов магазин', domain: 'new-shop.bg' } });
  assert.equal(res.statusCode, 200);
  const mine = json(await call({ url: '/api/admin/shops', cookie: c })).shops.map((s) => s.domain).sort();
  assert.deepEqual(mine, ['a-shop.bg', 'new-shop.bg']);
  assert.equal((await call({ method: 'PATCH', url: '/api/admin/shops', cookie: c, body: { id: SHOP_B, hidden: true } })).statusCode, 400);
  assert.equal(json(await call({ url: '/api/admin/shops', cookie: owner })).shops.length, 2, "a client's own shop is not in the owner's menu");
});

test('a client\'s "all shops" phone is notified only for their shops', async () => {
  const c = await clientWith([SHOP_A]);
  const sent = [];
  setPushSenderForTests(async (s) => { sent.push(s.endpoint); return { statusCode: 201 }; });
  const res = await call({ method: 'POST', url: '/api/admin/push?shop=all', cookie: c, body: { action: 'subscribe', subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/client', keys: { p256dh: 'p', auth: 'a' } } } });
  assert.equal(res.statusCode, 200);
  await notifyNewOrder(q, await addOrder(SHOP_B, 'Друг'));
  assert.deepEqual(sent, []);
  await notifyNewOrder(q, await addOrder(SHOP_A, 'Мой'));
  assert.deepEqual(sent, ['https://fcm.googleapis.com/fcm/send/client']);
  await saveSubscription(q, { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/owner', keys: { p256dh: 'p', auth: 'a' } }, shopId: null });
  sent.length = 0;
  await notifyNewOrder(q, await addOrder(SHOP_B, 'Друг 2'));
  assert.deepEqual(sent, ['https://fcm.googleapis.com/fcm/send/owner'], 'the owner\'s device still gets every shop');
});

test('only the owner manages clients', async () => {
  const c = await clientWith([SHOP_A]);
  assert.equal((await call({ url: '/api/admin/users', cookie: c })).statusCode, 403);
  assert.equal((await call({ method: 'POST', url: '/api/admin/users', cookie: c, body: { action: 'create', email: 'x@y.bg', shopIds: [SHOP_B] } })).statusCode, 403);
  assert.equal((await call({ url: '/api/admin/users' })).statusCode, 401);
});

test('stopping access or setting a new password ends the old sessions', async () => {
  const c = await clientWith([SHOP_A]);
  const [u] = await q(`select id from zd.users`);
  await updateClient(q, u.id, { active: false });
  assert.equal((await call({ url: '/api/admin/orders?shop=all', cookie: c })).statusCode, 401);
  assert.equal((await call({ method: 'POST', url: '/api/admin/login', body: { email: 'a@client.bg', password: 'client-pass-1' } })).statusCode, 401);
  await updateClient(q, u.id, { active: true });
  const fresh = cookieOf(await call({ method: 'POST', url: '/api/admin/login', body: { email: 'a@client.bg', password: 'client-pass-1' } }));
  const link = json(await call({ method: 'POST', url: '/api/admin/users', cookie: owner, body: { action: 'invite', id: u.id } })).link;
  await call({ method: 'POST', url: '/api/admin/invite', body: { token: new URL(link).searchParams.get('invite'), password: 'brand-new-pass' } });
  assert.equal((await call({ url: '/api/admin/orders?shop=all', cookie: fresh })).statusCode, 401, 'old session ended');
});

test('removing a shop from a client takes it away at once', async () => {
  const c = await clientWith([SHOP_A, SHOP_B]);
  assert.equal(json(await call({ url: '/api/admin/orders?shop=all', cookie: c })).total, 2);
  const [u] = await q(`select id from zd.users`);
  await call({ method: 'POST', url: '/api/admin/users', cookie: owner, body: { action: 'update', id: u.id, shopIds: [SHOP_A] } });
  assert.equal(json(await call({ url: '/api/admin/orders?shop=all', cookie: c })).total, 1);
});

test('10 wrong passwords lock the account for a while', async () => {
  await clientWith([SHOP_A]);
  const realSet = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => realSet(fn, 0); // skip the anti-guessing pause
  try {
    for (let i = 0; i < 10; i++) await call({ method: 'POST', url: '/api/admin/login', body: { email: 'a@client.bg', password: 'nope' } });
    const res = await call({ method: 'POST', url: '/api/admin/login', body: { email: 'a@client.bg', password: 'client-pass-1' } });
    assert.equal(res.statusCode, 401, 'still locked');
    assert.match(json(res).error, /временно спрян/, 'only the right password learns why (the account is theirs)');
    const wrong = await call({ method: 'POST', url: '/api/admin/login', body: { email: 'a@client.bg', password: 'nope-again' } });
    assert.match(json(wrong).error, /минути/, 'a wrong password gets the usual answer');
  } finally { globalThis.setTimeout = realSet; }
});

test('a client cannot be created for an unknown shop or with a used email', async () => {
  let res = await call({ method: 'POST', url: '/api/admin/users', cookie: owner, body: { action: 'create', email: 'x@y.bg', shopIds: ['00000000-0000-4000-8000-00000000dead'] } });
  assert.equal(res.statusCode, 400);
  await call({ method: 'POST', url: '/api/admin/users', cookie: owner, body: { action: 'create', email: 'x@y.bg', shopIds: [SHOP_A] } });
  res = await call({ method: 'POST', url: '/api/admin/users', cookie: owner, body: { action: 'create', email: 'X@Y.bg', shopIds: [SHOP_A] } });
  assert.equal(res.statusCode, 400);
  assert.match(json(res).error, /имейл/);
});

/* ---- security review fixes ---- */
import { allowedShopOrigin } from '../lib/shops.js';
import { upsertCbOrder } from '../lib/orders-repo.js';
import { mapOrder } from '../lib/convertbuilder.js';

test('a client cannot take a domain that is already in use anywhere (listed checkout, old orders, visits, the placeholder)', async () => {
  const c = await clientWith([SHOP_A]);
  process.env.ALLOWED_ORIGINS = 'https://listed-shop.bg, https://www.listed-shop.bg';
  await q(`insert into zd.orders (cb_order_id, name, phone, phone_norm, delivery_type, courier, shop_id) values ('old-site.bg:5', 'X', '1', '1', 'econt_office', 'econt', $1)`, [SHOP_A]);
  await q(`insert into zd.visits (day, site, visitor, shop_id) values (current_date, 'visited-site.bg', 'v1', $1)`, [SHOP_A]);
  for (const domain of ['listed-shop.bg', 'old-site.bg', 'visited-site.bg', 'shop.local']) {
    const res = await call({ method: 'POST', url: '/api/admin/shops', cookie: c, body: { name: 'Мой', domain } });
    assert.equal(res.statusCode, 400, domain);
  }
  delete process.env.ALLOWED_ORIGINS;
});

test('a client\'s new shop takes no checkout orders until the owner approves it', async () => {
  const c = await clientWith([SHOP_A]);
  const shop = json(await call({ method: 'POST', url: '/api/admin/shops', cookie: c, body: { name: 'Нов', domain: 'fresh-shop.bg' } })).shop;
  assert.equal(shop.approved, false);
  const origin = { headers: { origin: 'https://fresh-shop.bg' } };
  assert.equal(await allowedShopOrigin(q, origin), null, 'not yet');
  const list = json(await call({ url: '/api/admin/users', cookie: owner })).users;
  assert.deepEqual(list[0].pendingShops.map((s) => s.domain), ['fresh-shop.bg']);
  assert.equal((await call({ method: 'POST', url: '/api/admin/users', cookie: c, body: { action: 'approve_shop', shopId: shop.id } })).statusCode, 403);
  assert.equal((await call({ method: 'POST', url: '/api/admin/users', cookie: owner, body: { action: 'approve_shop', shopId: shop.id } })).statusCode, 200);
  assert.equal((await allowedShopOrigin(q, origin)).shopId, shop.id);
});

test('a client shop can never rename itself onto a free domain (only a fresh install claims its domain once)', async () => {
  const c = await clientWith([SHOP_A]);
  const res = await call({ method: 'POST', url: `/api/admin/integrations?shop=${SHOP_A}`, cookie: c, body: { action: 'save_shop', name: 'А', domain: 'stolen.bg' } });
  assert.equal(res.statusCode, 200);
  const [s] = await q(`select domain from zd.shops where id = $1`, [SHOP_A]);
  assert.equal(s.domain, 'a-shop.bg');
});

test('an order number of another shop is never overwritten (checkout widget or ConvertBuilder)', async () => {
  const [{ cb_order_id: key }] = await q(`select cb_order_id from zd.orders where id = $1`, [orderA]);
  const r = await insertOrder(q, { cbOrderId: key, name: 'Нападател', phone: '1', phoneNorm: '1', email: '', deliveryType: 'speedy_address', courier: 'speedy', officeId: 'speedy:9', officeText: 'Друго', city: 'Х', postCode: '', addressText: 'Друг адрес', items: [], total: 1, currency: 'EUR', paymentMethod: 'cod', pageUrl: '', ip: '1', shopId: SHOP_B });
  assert.equal(r.id, null);
  await q(`update zd.orders set source = 'convertbuilder', office_id = '' where id = $1`, [orderA]);
  const cb = mapOrder({ id: 1, invoiceNo: 1, created: Math.floor(Date.now() / 1000), customerName: 'Нападател', customerEmail: '', shippingAddress: { phone: '1', city: 'Х', address: 'х' }, total: 999, shippingName: 'x', paymentMethod: 'cod', status: 'completed', items: [] }, { store: 'x' });
  const u = await upsertCbOrder(q, { ...cb, cbOrderId: key, shopId: SHOP_B });
  assert.equal(u.id, null);
  const [a] = await q(`select name, total, office_text, shop_id from zd.orders where id = $1`, [orderA]);
  assert.deepEqual([a.name, Number(a.total), a.office_text, a.shop_id], ['Купувач А', 10, 'Офис', SHOP_A]);
});

test('Facebook login comes back only to the browser that started it', async () => {
  process.env.META_APP_ID = 'app'; process.env.META_APP_SECRET = 'sec';
  try {
    const start = await call({ url: `/api/admin/meta?start=1&shop=${SHOP_A}`, cookie: owner });
    const state = new URL(start.headers.location).searchParams.get('state');
    const cookie = String(start.headers['set-cookie']).split(';')[0];
    assert.match(cookie, /^zdo_meta=/);
    const stranger = await call({ url: `/api/admin/meta?code=x&state=${state}` });
    assert.match(stranger.headers.location, /meta_error=/, 'another browser cannot finish it');
  } finally { delete process.env.META_APP_ID; delete process.env.META_APP_SECRET; }
});

test('parallel wrong passwords still lock the account; unknown and locked logins look the same', async () => {
  await clientWith([SHOP_A]);
  const realSet = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => realSet(fn, 0);
  try {
    await Promise.all(Array.from({ length: 25 }, () => call({ method: 'POST', url: '/api/admin/login', body: { email: 'a@client.bg', password: 'nope' } })));
    resetLoginLimitForTests(); // the account lock is checked here, not the per-address limit
    const locked = await call({ method: 'POST', url: '/api/admin/login', body: { email: 'a@client.bg', password: 'wrong-guess' } });
    const unknown = await call({ method: 'POST', url: '/api/admin/login', body: { email: 'nobody@x.bg', password: 'whatever1' } });
    assert.equal(locked.statusCode, 401);
    assert.equal(unknown.statusCode, 401);
    assert.equal(json(locked).error, json(unknown).error, 'a guesser cannot tell a locked account from an unknown email');
    const [u] = await q(`select locked_until > now() as locked from zd.users`);
    assert.equal(u.locked, true);
  } finally { globalThis.setTimeout = realSet; }
});

test('admin changes from another website are refused', async () => {
  const res = fakeRes();
  await router({ ...req({ method: 'POST', url: '/api/admin/users', cookie: owner, body: { action: 'create', email: 'z@z.bg', shopIds: [] } }), headers: { cookie: owner, origin: 'https://evil.example', host: 'kurier.profitbrand.online' } }, res);
  assert.equal(res.statusCode, 403);
});

test('a new link from the owner ends the client\'s current sessions', async () => {
  const c = await clientWith([SHOP_A]);
  const [u] = await q(`select id from zd.users`);
  await call({ method: 'POST', url: '/api/admin/users', cookie: owner, body: { action: 'invite', id: u.id } });
  assert.equal((await call({ url: '/api/admin/orders?shop=all', cookie: c })).statusCode, 401);
});

test('a client may own at most 10 shops', async () => {
  const c = await clientWith([SHOP_A]);
  let last;
  for (let i = 0; i < 11; i++) last = await call({ method: 'POST', url: '/api/admin/shops', cookie: c, body: { name: `М${i}`, domain: `cap${i}-shop.bg` } });
  assert.equal(last.statusCode, 400);
  assert.match(json(last).error, /10/);
});

test('one address cannot hammer the client login (a few attempts a minute)', async () => {
  const realSet = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => realSet(fn, 0);
  try {
    let last;
    for (let i = 0; i < 25; i++) last = await call({ method: 'POST', url: '/api/admin/login', body: { email: `x${i}@nobody.bg`, password: 'whatever1' } });
    assert.equal(last.statusCode, 429);
  } finally { globalThis.setTimeout = realSet; }
});
