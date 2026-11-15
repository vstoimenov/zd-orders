// „Профил“ → the whole picture: the three numbers across the user's shops against the period before, the curve, the shops, the latest orders.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { insertOrder, updateStatus } from '../lib/orders-repo.js';
import { signSession } from '../lib/auth.js';
import { createClient, acceptInvite, clientSession } from '../lib/users.js';
import { saveCosts } from '../lib/costs.js';
import { getOverview, buckets, bucketize } from '../lib/admin/overview.js';
import router from '../api/admin/[route].js';

process.env.ADMIN_SECRET = 'secret';
process.env.INTEGRATIONS_SECRET = 'test-secret';
const SHOP = '00000000-0000-4000-8000-000000000001';
const owner = `zdo_admin=${signSession('secret')}`;
let q, other, n = 0;
beforeEach(async () => {
  q = await makeTestQuery(); setQueryForTests(q); n = 0;
  [{ id: other }] = await q(`insert into zd.shops (name, domain) values ('Втори', 'vtori.bg') returning id`);
});
const daysAgo = (d) => new Date(Date.now() - d * 864e5).toISOString();
async function order({ shopId = SHOP, ago = 0, total = 30, status = 'delivered', price = 25 } = {}) {
  n++;
  const r = await insertOrder(q, {
    cbOrderId: `s:${n}`, name: 'Мария', phone: '0888', phoneNorm: `+3598880${String(n).padStart(5, '0')}`, email: '', deliveryType: 'econt_office', courier: 'econt',
    officeId: '', officeText: 'x', city: 'x', postCode: '', addressText: '', items: [{ name: 'Крем', qty: 1, price }], total, currency: 'EUR', paymentMethod: 'cod', pageUrl: '', ip: String(n), shopId,
  });
  if (status !== 'new') await updateStatus(q, r.id, status);
  await q(`update zd.orders set created_at = $2::timestamptz where id = $1::uuid`, [r.id, daysAgo(ago)]);
  return r;
}
const call = async (cookie, url) => { const res = fakeRes(); await router({ method: 'GET', url, headers: { cookie }, socket: {} }, res); return res; };

test('buckets: days for a week or a month, weeks for a quarter, months for a year; daily rows fall into them, gaps are 0', () => {
  assert.equal(buckets('2026-11-09', '2026-11-15').length, 7);
  assert.equal(buckets('2026-10-17', '2026-11-15').length, 30);
  const weeks = buckets('2026-08-18', '2026-11-15');
  assert.equal(weeks.length, 13);
  assert.deepEqual([weeks[0].from, weeks[0].to, weeks[12].to], ['2026-08-18', '2026-08-24', '2026-11-15']);
  const months = buckets('2025-11-16', '2026-11-15');
  assert.equal(months.length, 13);
  assert.deepEqual([months[0].from, months[0].to, months[1].from, months[12].to], ['2025-11-16', '2025-11-30', '2025-12-01', '2026-11-15']);
  const b = bucketize([{ day: '2026-11-10', orders: 2, revenue: 50 }, { day: '2026-11-10', orders: 1, revenue: 10.5 }, { day: '2026-11-15', orders: 1, revenue: 20 }], buckets('2026-11-09', '2026-11-15'));
  assert.deepEqual(b.map((x) => x.revenue), [0, 60.5, 0, 0, 0, 0, 20]);
  assert.deepEqual(b.map((x) => x.orders), [0, 3, 0, 0, 0, 0, 1]);
});

test('the owner sees every shop: the three numbers against the period before, the curve, the shops and the latest orders', async () => {
  await saveCosts(q, { products: [{ name: 'Крем', unitCost: 10 }], shopId: SHOP });
  await order({ ago: 1, total: 30 }); await order({ ago: 2, total: 40 }); await order({ ago: 3, total: 20, status: 'returned' }); await order({ ago: 3, total: 99, status: 'cancelled' });
  await order({ shopId: other, ago: 2, total: 50 });
  await order({ ago: 10, total: 100 }); await order({ shopId: other, ago: 12, total: 10 }); // the week before
  const o = await getOverview(q, { owner: true }, '7d');
  assert.equal(o.shops, 2);
  const by = Object.fromEntries(o.kpis.map((k) => [k.id, k]));
  assert.deepEqual([by.revenue.value, by.revenue.previous], [120, 110], 'returned and cancelled bring nothing; both shops count');
  assert.deepEqual([by.orders.value, by.orders.previous], [5, 2]);
  assert.equal(by.profit.unreal, true, 'the second shop has no unit costs');
  assert.ok(by.profit.value > 0 && by.profit.value < 120);
  assert.equal(o.points.length, 7);
  assert.equal(o.points.reduce((s, p) => s + p.current, 0), 120);
  assert.equal(o.points.reduce((s, p) => s + p.previous, 0), 110);
  assert.equal(by.revenue.spark.length, 7);
  assert.equal(by.profit.spark, null);
  assert.deepEqual(o.byShop.map((s) => [s.revenue, s.previous, s.orders]), [[70, 100, 4], [50, 10, 1]]);
  assert.equal(o.recent.length, 7);
  assert.ok(o.recent[0].shop);
});

test('a client sees only its shops; the route needs a login and takes the range', async () => {
  await order({ ago: 1, total: 30 }); await order({ shopId: other, ago: 1, total: 500 });
  const c = await createClient(q, { email: 'c@x.bg', name: 'К', shopIds: [SHOP] });
  await acceptInvite(q, c.token, 'client-pass-1');
  const [u] = await q(`select id, session_version from zd.users where email = 'c@x.bg'`);
  const client = `zdo_admin=${clientSession('secret', u)}`;
  let res = await call(client, '/api/admin/overview?range=30d');
  assert.equal(res.statusCode, 200);
  const d = json(res);
  assert.equal(d.shops, 1);
  assert.equal(d.kpis[0].value, 30);
  assert.equal(d.points.length, 30);
  assert.ok(d.recent.every((r) => r.shopId === SHOP));
  res = await call(owner, '/api/admin/overview?range=12m');
  assert.equal(json(res).kpis[0].value, 530);
  assert.equal(json(res).points.length, 13);
  assert.equal((await call(owner, '/api/admin/overview?range=bogus')).statusCode, 200);
  assert.equal(json(await call(owner, '/api/admin/overview?range=bogus')).range, '30d');
  assert.equal((await call('', '/api/admin/overview')).statusCode, 401);
});
