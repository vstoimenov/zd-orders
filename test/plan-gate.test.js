// The reverse trial: 14 days on the chosen plan, then Free (1 shop, 50 orders a month) unless paid.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { createClient, acceptInvite, clientSession } from '../lib/users.js';
import { chooseSubscription, addPayment } from '../lib/plans.js';
import { planState } from '../lib/plan-gate.js';
import { insertOrder } from '../lib/orders-repo.js';
import router from '../api/admin/[route].js';

process.env.ADMIN_SECRET = 'secret';
const SHOP = '00000000-0000-4000-8000-000000000001';
let q;
beforeEach(async () => { q = await makeTestQuery(); setQueryForTests(q); });
const call = async ({ method = 'GET', url, cookie, body }) => { const res = fakeRes(); await router({ method, url, headers: cookie ? { cookie } : {}, body: body === undefined ? undefined : JSON.stringify(body) }, res); return res; };
async function client() {
  const c = await createClient(q, { email: 'f@shop.bg', name: 'Ф', shopIds: [SHOP] });
  const u = await acceptInvite(q, c.token, 'free-pass-123');
  return { id: c.id, user: { owner: false, id: c.id }, cookie: `zdo_admin=${clientSession('secret', { id: c.id, session_version: u.session_version })}` };
}
let n = 0;
const orders = async (k, at = new Date()) => { for (let i = 0; i < k; i++) { const o = await insertOrder(q, { cbOrderId: `g-${++n}`, name: 'К', phone: '', phoneNorm: '', email: '', deliveryType: 'econt_office', courier: 'econt', officeId: 'econt:1', officeText: 'О', city: 'С', postCode: '', addressText: '', items: [{ name: 'Книга', qty: 1, price: 10 }], total: 10, currency: 'EUR', paymentMethod: 'cod', pageUrl: '', shopId: SHOP }); await q(`update zd.orders set created_at = $2 where id = $1::uuid`, [o.id, at.toISOString()]); } };

test('14 days on the chosen plan, then Free unless paid; paid stays on its plan; no plan picked = no limits', async () => {
  const { id, user } = await client();
  assert.deepEqual(await planState(q, user), { unlimited: true }, 'made by the owner, no plan');
  const t0 = new Date('2026-11-20T10:00:00Z');
  await chooseSubscription(q, id, { plan: 'growth', billing: 'monthly' }, t0);
  let s = await planState(q, user, new Date('2026-11-25T10:00:00Z'));
  assert.deepEqual([s.effective, s.trial, s.limit, s.features.profit], ['growth', true, 1000, true]);
  s = await planState(q, user, new Date('2026-12-05T10:00:00Z'));
  assert.deepEqual([s.effective, s.planName, s.limit, s.maxShops, s.features.profit, s.features.voice, s.features.growthClub], ['free', 'Free', 50, 1, false, false, true]);
  await addPayment(q, id, { paidAt: '2026-12-06' }, new Date('2026-12-06T10:00:00Z'));
  s = await planState(q, user, new Date('2026-12-07T10:00:00Z'));
  assert.deepEqual([s.effective, s.paid], ['growth', true]);
});

test('Free: warned at 40 orders this month, at 50 no new waybills — orders still come in; a new month starts again', async () => {
  const { id, user, cookie } = await client();
  await chooseSubscription(q, id, { plan: 'starter', billing: 'monthly' }, new Date(Date.now() - 20 * 864e5)); // trial over
  await orders(39);
  await orders(30, new Date(Date.now() - 40 * 864e5)); // last month: not counted
  let s = await planState(q, user);
  assert.deepEqual([s.used, s.warn, s.blocked], [39, false, false]);
  await orders(1);
  s = await planState(q, user);
  assert.deepEqual([s.used, s.warn, s.blocked], [40, true, false]);
  await orders(10);
  s = await planState(q, user);
  assert.deepEqual([s.used, s.warn, s.blocked], [50, false, true]);
  const res = await call({ method: 'POST', url: `/api/admin/waybills?shop=${SHOP}`, cookie, body: { action: 'create', id: '00000000-0000-4000-8000-000000000009' } });
  assert.equal(res.statusCode, 402);
  assert.match(json(res).error, /50 поръчки/);
  await orders(1);
  assert.equal((await planState(q, user)).used, 51, 'orders keep coming in');
  assert.equal(json(await call({ url: `/api/admin/orders?shop=${SHOP}`, cookie })).total, 81, 'every order stays visible');
  assert.equal((await call({ url: `/api/admin/costs?shop=${SHOP}`, cookie })).statusCode, 402, 'no profit analysis on Free');
  assert.equal(json(await call({ url: '/api/admin/me', cookie })).planState.blocked, true);
});
