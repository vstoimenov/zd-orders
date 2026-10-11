import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { insertOrder } from '../lib/orders-repo.js';
import { saveIntegration } from '../lib/integrations-repo.js';
import { signSession } from '../lib/auth.js';
import { createClient, acceptInvite, clientSession } from '../lib/users.js';
import router from '../api/admin/[route].js';

process.env.ADMIN_SECRET = 'secret';
process.env.INTEGRATIONS_SECRET = 'test-secret';
const SHOP_A = '00000000-0000-4000-8000-000000000001';
const owner = `zdo_admin=${signSession('secret')}`;
let q, SHOP_B;
const get = async (url, cookie) => { const res = fakeRes(); await router({ method: 'GET', url, headers: { cookie }, socket: {} }, res); return res; };
async function clientCookie(shopIds) {
  const { id, token } = await createClient(q, { email: `c${Math.random()}@x.bg`, shopIds });
  const u = await acceptInvite(q, token, 'client-pass-1');
  return `zdo_admin=${clientSession('secret', { id, session_version: u.session_version })}`;
}

beforeEach(async () => {
  q = await makeTestQuery(); setQueryForTests(q);
  await q(`update zd.shops set domain = 'a-shop.bg', name = 'А' where id = $1`, [SHOP_A]);
  [{ id: SHOP_B }] = await q(`insert into zd.shops (name, domain, approved) values ('Б', 'b-shop.bg', false) returning id`);
});

test('a fresh shop: nothing done yet except adding it', async () => {
  const d = json(await get(`/api/admin/onboarding?shop=${SHOP_B}`, owner));
  assert.deepEqual(d.shop, { id: SHOP_B, name: 'Б', domain: 'b-shop.bg', approved: false, placeholder: false });
  assert.deepEqual(d.widget, { visits: 0, lastVisitAt: null, orders: 0, lastOrderAt: null });
  assert.equal(d.convertbuilder.connected, false);
  assert.equal(d.orders, 0);
  assert.deepEqual([d.econt, d.speedy, d.meta], [false, false, false]);
  assert.equal(d.snippet, '<script src="https://kurier.profitbrand.online/kurier.js" defer></script>');
});

test('the steps light up from real data: visits, widget orders, ConvertBuilder, couriers, ads', async () => {
  await q(`insert into zd.visits (day, site, visitor, shop_id) values (current_date, 'a-shop.bg', 'v1', $1)`, [SHOP_A]);
  await insertOrder(q, { cbOrderId: 'a-shop.bg:1', name: 'Х', phone: '1', phoneNorm: '1', email: '', deliveryType: 'econt_office', courier: 'econt', officeId: 'econt:1', officeText: 'О', city: 'С', postCode: '', addressText: '', items: [], total: 1, currency: 'EUR', paymentMethod: 'cod', pageUrl: '', ip: '1', shopId: SHOP_A });
  await saveIntegration(q, 'convertbuilder', { config: { domain: 'a-shop.bg', active: true, webhookId: 'w1', lastSyncAt: '2026-10-11T10:00:00.000Z' }, secret: 'K', shopId: SHOP_A });
  await saveIntegration(q, 'econt', { config: { sender: { type: 'office', officeCode: '1' }, active: true }, secret: '{}', shopId: SHOP_A });
  await saveIntegration(q, 'meta', { config: { accountId: '1', active: true }, secret: 'T', shopId: SHOP_A });
  const d = json(await get(`/api/admin/onboarding?shop=${SHOP_A}`, owner));
  assert.equal(d.widget.visits, 1);
  assert.ok(d.widget.lastVisitAt);
  assert.equal(d.widget.orders, 1);
  assert.equal(d.orders, 1);
  assert.deepEqual(d.convertbuilder, { connected: true, webhook: true, lastSyncAt: '2026-10-11T10:00:00.000Z', lastError: null });
  assert.deepEqual([d.econt, d.speedy, d.meta], [true, false, true]);
});

test('a client sees the guide only for their own shop; with no shop it says to add one', async () => {
  const c = await clientCookie([SHOP_B]);
  const d = json(await get(`/api/admin/onboarding?shop=${SHOP_A}`, c));
  assert.equal(d.shop.id, SHOP_B, 'never another shop');
  const none = await get('/api/admin/onboarding', await clientCookie([]));
  assert.equal(none.statusCode, 200);
  assert.deepEqual(json(none), { shop: null, snippet: '<script src="https://kurier.profitbrand.online/kurier.js" defer></script>' });
  assert.equal((await get('/api/admin/onboarding', '')).statusCode, 401);
});

test('a client without shops sees empty lists, not errors', async () => {
  const c = await clientCookie([]);
  const orders = await get('/api/admin/orders', c);
  assert.equal(orders.statusCode, 200);
  assert.equal(json(orders).total, 0);
  assert.equal((await get('/api/admin/stats', c)).statusCode, 200);
});
