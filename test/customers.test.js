import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { insertOrder, updateStatus, saveNekorekten } from '../lib/orders-repo.js';
import { signSession } from '../lib/auth.js';
import { createClient, acceptInvite, clientSession } from '../lib/users.js';
import { listCustomers, customerSummary } from '../lib/customers.js';
import router from '../api/admin/[route].js';

process.env.ADMIN_SECRET = 'secret';
const SHOP = '00000000-0000-4000-8000-000000000001';
const owner = `zdo_admin=${signSession('secret')}`;
let q, n = 0;
beforeEach(async () => { q = await makeTestQuery(); setQueryForTests(q); n = 0; });

async function order({ phone = '+359888111111', name = 'Мария Иванова', email = '', total = 20, status = 'new', daysAgo = 0, shopId = SHOP, cbCheck = '' } = {}) {
  const r = await insertOrder(q, {
    cbOrderId: `s.bg:${++n}`, name, phone, phoneNorm: phone, email, deliveryType: 'econt_office', courier: 'econt', officeId: '', officeText: 'ЕКОНТ',
    city: 'Плевен', postCode: '', addressText: '', items: [{ name: 'Книга', qty: 1, price: total }], total, currency: 'EUR', paymentMethod: 'cod', pageUrl: '', ip: '1', shopId, cbCheck,
  });
  if (status !== 'new') await updateStatus(q, r.id, status);
  await q(`update zd.orders set created_at = now() - make_interval(days => $2) where id = $1::uuid`, [r.id, daysAgo]);
  return r.id;
}

test('one row per phone: orders, spent (without cancelled and returned), first and last order, latest name and email', async () => {
  await order({ total: 20, daysAgo: 40, name: 'Мария', email: 'old@x.bg' });
  await order({ total: 30, daysAgo: 10, name: 'Мария Иванова', email: 'm@x.bg', status: 'delivered' });
  await order({ total: 99, daysAgo: 5, status: 'cancelled' });
  await order({ phone: '+359888222222', name: 'Иван', total: 15, status: 'returned' });
  const { rows, total } = await listCustomers(q, { shopId: SHOP });
  assert.equal(total, 2);
  const m = rows.find((r) => r.phoneNorm === '+359888111111');
  assert.equal(m.name, 'Мария Иванова');
  assert.equal(m.email, 'm@x.bg');
  assert.equal(m.orders, 3);
  assert.equal(m.spent, 50);
  assert.equal(m.delivered, 1);
  assert.equal(m.returned, 0);
  assert.equal(m.avgOrder, 25);
  assert.ok(Date.parse(m.firstOrderAt) < Date.parse(m.lastOrderAt));
  assert.equal(rows.find((r) => r.phoneNorm === '+359888222222').spent, 0);
});

test('segments: new, returning, vip, sleeping, risky', async () => {
  await order({ phone: '+359888000001' }); // new
  await order({ phone: '+359888000002', daysAgo: 20 }); await order({ phone: '+359888000002' }); // returning
  for (let i = 0; i < 3; i++) await order({ phone: '+359888000003', total: 60, daysAgo: i }); // vip: 3+ orders
  await order({ phone: '+359888000004', daysAgo: 120 }); // sleeping
  await order({ phone: '+359888000005', status: 'returned' }); // risky
  const id = await order({ phone: '+359888000006' }); await saveNekorekten(q, id, { status: 'flagged', count: 2 }); // risky
  const seg = async (s) => (await listCustomers(q, { shopId: SHOP, segment: s })).rows.map((r) => r.phoneNorm).sort();
  assert.deepEqual(await seg('new'), ['+359888000001', '+359888000005', '+359888000006']);
  assert.deepEqual(await seg('returning'), ['+359888000002', '+359888000003']);
  assert.deepEqual(await seg('vip'), ['+359888000003']);
  assert.deepEqual(await seg('sleeping'), ['+359888000004']);
  assert.deepEqual(await seg('risky'), ['+359888000005', '+359888000006']);
  const one = (await listCustomers(q, { shopId: SHOP, search: '000003' })).rows[0];
  assert.deepEqual(one.segments.sort(), ['returning', 'vip']);
});

test('search by name or phone, sort by spent, orders or last order', async () => {
  await order({ phone: '+359888000001', name: 'Ана', total: 10 });
  await order({ phone: '+359888000002', name: 'Борис', total: 50, daysAgo: 3 });
  await order({ phone: '+359888000002', name: 'Борис', total: 5, daysAgo: 2 });
  assert.deepEqual((await listCustomers(q, { shopId: SHOP, search: 'бор' })).rows.map((r) => r.name), ['Борис']);
  assert.deepEqual((await listCustomers(q, { shopId: SHOP, search: '0888 000 001' })).rows.map((r) => r.name), ['Ана']);
  assert.deepEqual((await listCustomers(q, { shopId: SHOP, sort: 'spent' })).rows.map((r) => r.name), ['Борис', 'Ана']);
  assert.deepEqual((await listCustomers(q, { shopId: SHOP, sort: 'orders' })).rows.map((r) => r.name), ['Борис', 'Ана']);
  assert.deepEqual((await listCustomers(q, { shopId: SHOP, sort: 'last' })).rows.map((r) => r.name), ['Ана', 'Борис']);
});

test('orders kept aside (not confirmed by ConvertBuilder), other shops and orders without a phone do not make customers', async () => {
  await order({ cbCheck: 'pending' });
  await order({ phone: '' });
  const [{ id: other }] = await q(`insert into zd.shops (name, domain) values ('Б', 'b.bg') returning id`);
  await order({ shopId: other });
  assert.equal((await listCustomers(q, { shopId: SHOP })).total, 0);
  assert.equal((await listCustomers(q, { shopIds: [SHOP, other] })).total, 1);
});

test('summary for the dashboard: customers, repeat share and average lifetime value', async () => {
  await order({ phone: '+359888000001', total: 10 });
  await order({ phone: '+359888000002', total: 20, daysAgo: 1 }); await order({ phone: '+359888000002', total: 30 });
  assert.deepEqual(await customerSummary(q, { shopId: SHOP }), { customers: 2, repeat: 1, repeatShare: 0.5, avgValue: 30 });
});

test('admin route: owner lists and exports; a client only its shops; login needed', async () => {
  await order({ name: 'Мария, "ВИП"', email: 'm@x.bg', total: 20 });
  const call = async (url, cookie) => { const res = fakeRes(); await router({ method: 'GET', url, headers: cookie ? { cookie } : {}, socket: {} }, res); return res; };
  const d = json(await call(`/api/admin/customers?shop=${SHOP}`, owner));
  assert.equal(d.customers.length, 1);
  assert.deepEqual(d.summary, { customers: 1, repeat: 0, repeatShare: 0, avgValue: 20 });
  const csv = await call(`/api/admin/customers?shop=${SHOP}&format=csv`, owner);
  assert.match(csv.headers['content-type'], /text\/csv/);
  assert.match(csv.body, /"Мария, ""ВИП"""/);
  assert.equal((await call(`/api/admin/customers?shop=${SHOP}`)).statusCode, 401);
  const [{ id: other }] = await q(`insert into zd.shops (name, domain) values ('Б', 'b.bg') returning id`);
  const { id, token } = await createClient(q, { email: 'c@x.bg', shopIds: [other] });
  const u = await acceptInvite(q, token, 'client-pass-1');
  const c = `zdo_admin=${clientSession('secret', { id, session_version: u.session_version })}`;
  assert.deepEqual(json(await call(`/api/admin/customers?shop=${SHOP}`, c)).customers, []);
});
