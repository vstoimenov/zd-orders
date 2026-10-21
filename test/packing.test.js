import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeReq, fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { insertOrder, listOrders, updateStatus, setPacked, toPackCount } from '../lib/orders-repo.js';
import { signSession } from '../lib/auth.js';
import { createClient, acceptInvite, clientSession } from '../lib/users.js';
import router from '../api/admin/[route].js';

process.env.ADMIN_SECRET = 'secret';
const SHOP = '00000000-0000-4000-8000-000000000001';
const owner = `zdo_admin=${signSession('secret')}`;
let q, n = 0;
beforeEach(async () => { q = await makeTestQuery(); setQueryForTests(q); n = 0; });

async function add(patch = {}, status = 'new') {
  n++;
  const r = await insertOrder(q, {
    cbOrderId: `adhdbg.eu:${n}`, name: `Клиент ${n}`, phone: '0888123456', phoneNorm: `+3598881${String(n).padStart(5, '0')}`, email: '',
    deliveryType: 'econt_office', courier: 'econt', officeId: 'econt:1107', officeText: 'ЕКОНТ – офис София Младост (1107)', city: 'София', postCode: '1000',
    addressText: '', items: [{ name: 'Книга', qty: 2, price: 18.5 }, { name: 'Тесте', qty: 1, price: 9 }], total: 50.07, currency: 'EUR', paymentMethod: 'cod', pageUrl: '', ip: '1', ...patch,
  });
  if (status !== 'new') await updateStatus(q, r.id, status);
  return r.id;
}
const call = async (opts) => { const res = fakeRes(); await router(fakeReq({ url: `/api/admin/orders?shop=${SHOP}`, headers: { cookie: owner }, ...opts }), res); return res; };

test('"За пакетиране" = orders still to be sent that nobody packed yet; packing remembers the first time, un-packing clears it', async () => {
  const a = await add(), b = await add({}, 'confirmed'), c = await add({}, 'shipped'), d = await add({}, 'cancelled');
  const kept = await add({ cbCheck: 'pending' });
  await q(`update zd.orders set cb_check = 'pending' where id = $1::uuid`, [kept]);
  assert.deepEqual((await listOrders(q, { status: 'to_pack', shopId: SHOP })).rows.map((o) => o.id).sort(), [a, b].sort());
  assert.equal(await toPackCount(q, { shopId: SHOP }), 2);
  const t1 = await setPacked(q, a, true);
  assert.ok(t1 && Date.parse(t1) > Date.now() - 5000);
  assert.equal(await setPacked(q, a, true), t1, 'packing twice keeps the first time');
  assert.deepEqual((await listOrders(q, { status: 'to_pack', shopId: SHOP })).rows.map((o) => o.id), [b]);
  assert.equal((await listOrders(q, { shopId: SHOP })).rows.find((o) => o.id === a).packedAt, t1);
  assert.equal(await setPacked(q, a, false), null);
  assert.equal(await toPackCount(q, { shopId: SHOP }), 2);
  assert.equal(await setPacked(q, '00000000-0000-4000-8000-00000000dead', true), undefined, 'unknown order');
  void c; void d;
});

test('admin: the packed action, the toPack count in the list and the shop scope', async () => {
  const a = await add();
  let res = await call({});
  assert.equal(json(res).toPack, 1);
  res = await call({ method: 'POST', body: JSON.stringify({ action: 'packed', id: a, on: true }) });
  assert.equal(res.statusCode, 200, res.body);
  assert.ok(json(res).packedAt);
  res = await call({ url: `/api/admin/orders?shop=${SHOP}&status=to_pack` });
  assert.deepEqual([json(res).orders.length, json(res).toPack], [0, 0]);
  res = await call({});
  assert.ok(json(res).orders[0].packedAt, 'the list shows when it was packed');
  res = await call({ method: 'POST', body: JSON.stringify({ action: 'packed', id: a, on: false }) });
  assert.equal(json(res).packedAt, null);
  // a client of another shop cannot touch it
  const [{ id: other }] = await q(`insert into zd.shops (name, domain) values ('Друг', 'other.bg') returning id`);
  const { id, token } = await createClient(q, { email: 'c@x.bg', shopIds: [other] });
  const u = await acceptInvite(q, token, 'client-pass-1');
  const c = `zdo_admin=${clientSession('secret', { id, session_version: u.session_version })}`;
  res = await call({ url: `/api/admin/orders?shop=${other}`, headers: { cookie: c }, method: 'POST', body: JSON.stringify({ action: 'packed', id: a, on: true }) });
  assert.equal(res.statusCode, 404);
  assert.equal((await listOrders(q, { shopId: SHOP })).rows[0].packedAt, null);
});

test('the QR link opens one order: the list can be asked for a single id (nothing for a foreign or unknown one)', async () => {
  const a = await add(), b = await add();
  assert.deepEqual((await listOrders(q, { id: a, shopId: SHOP })).rows.map((o) => o.id), [a]);
  assert.deepEqual((await listOrders(q, { id: 'nope', shopId: SHOP })).rows, []);
  const res = await call({ url: `/api/admin/orders?shop=${SHOP}&id=${a}` });
  assert.deepEqual(json(res).orders.map((o) => o.id), [a]);
  const [{ id: other }] = await q(`insert into zd.shops (name, domain) values ('Друг', 'other.bg') returning id`);
  // the phone may have another shop selected when the QR is scanned: the owner still gets the order (from its own shop)
  const res2 = await call({ url: `/api/admin/orders?shop=${other}&id=${a}` });
  assert.deepEqual(json(res2).orders.map((o) => [o.id, o.shopId]), [[a, SHOP]], 'the owner sees it whatever shop is selected');
  // a client of another shop never does
  const { id, token } = await createClient(q, { email: 'c2@x.bg', shopIds: [other] });
  const u = await acceptInvite(q, token, 'client-pass-1');
  const c = `zdo_admin=${clientSession('secret', { id, session_version: u.session_version })}`;
  assert.deepEqual(json(await call({ url: `/api/admin/orders?shop=${other}&id=${a}`, headers: { cookie: c } })).orders, []);
  assert.equal((await call({ url: `/api/admin/orders?shop=${SHOP}&id=${'-'.repeat(36)}` })).statusCode, 200, 'a malformed id is just nothing, not a crash');
  void b;
});

test('packing never changes the status', async () => {
  const a = await add({}, 'confirmed');
  await setPacked(q, a, true);
  assert.equal((await listOrders(q, { shopId: SHOP })).rows[0].status, 'confirmed');
});
