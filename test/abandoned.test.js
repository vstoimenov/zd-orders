import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { insertOrder } from '../lib/orders-repo.js';
import { captureCart, listCarts, openCount, cartStats, anonymiseOld } from '../lib/abandoned.js';

const SHOP = '00000000-0000-4000-8000-000000000001';
let q;
beforeEach(async () => {
  q = await makeTestQuery();
  await q(`update zd.shops set domain = 'a-shop.bg', name = 'Магазин А' where id = $1`, [SHOP]);
});

const cart = (patch = {}) => ({
  shopId: SHOP, phone: '0888 123 456', name: 'Мария Иванова', email: 'm@x.bg', items: [{ name: 'Книга', qty: 1, price: 20 }],
  total: 22.57, currency: 'EUR', deliveryText: 'ЕКОНТ – офис Плевен (5803)', pageUrl: 'https://a-shop.bg/checkout', ip: '1.1.1.1', ...patch,
});
/** moves a cart back in time: minutes since it was first captured / last updated */
const age = (id, createdMin, updatedMin = createdMin) =>
  q(`update zd.abandoned_carts set created_at = now() - make_interval(mins => $2), updated_at = now() - make_interval(mins => $3) where id = $1::uuid`, [id, createdMin, updatedMin]);
let n = 0;
async function order({ minutesAgo = 0, status = 'new', cbCheck = '', phoneNorm = '+359888123456' } = {}) {
  const { id } = await insertOrder(q, {
    cbOrderId: `a-shop.bg:${++n}`, name: 'Мария Иванова', phone: '0888123456', phoneNorm, email: '', deliveryType: 'econt_office', courier: 'econt',
    officeId: 'econt:1', officeText: 'ЕКОНТ', city: 'Плевен', postCode: '5800', addressText: '', items: [], total: 22.57, currency: 'EUR',
    paymentMethod: 'cod', pageUrl: '', ip: '1', shopId: SHOP, cbCheck,
  });
  await q(`update zd.orders set created_at = now() - make_interval(mins => $2), status = $3 where id = $1::uuid`, [id, minutesAgo, status]);
  return id;
}
const today = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10); // Sofia is UTC+2/+3
const daysAgo = (d) => new Date(Date.now() - d * 86400e3).toISOString().slice(0, 10);

test('a cart with an invalid phone is not stored', async () => {
  assert.equal(await captureCart(q, cart({ phone: '123' })), null);
  assert.equal((await q(`select count(*)::int as n from zd.abandoned_carts`))[0].n, 0);
});

test('the same phone within 24 h updates one row', async () => {
  const a = await captureCart(q, cart());
  assert.equal(a.created, true);
  const b = await captureCart(q, cart({ items: [{ name: 'Книга', qty: 1, price: 20 }, { name: 'Тетрадка', qty: 2, price: 6 }] }));
  assert.equal(b.created, false);
  assert.equal(b.id, a.id);
  const rows = await q(`select items from zd.abandoned_carts`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].items.length, 2);
});

test('an older cart starts a new row', async () => {
  const a = await captureCart(q, cart());
  await age(a.id, 25 * 60);
  const b = await captureCart(q, cart());
  assert.equal(b.created, true);
  assert.notEqual(b.id, a.id);
});

test('a fresh cart is not abandoned yet', async () => {
  const { id } = await captureCart(q, cart());
  assert.deepEqual(await listCarts(q, { shopId: SHOP }), []);
  await age(id, 31);
  const rows = await listCarts(q, { shopId: SHOP });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'open');
  assert.equal(rows[0].phoneNorm, '+359888123456');
  assert.equal(await openCount(q, { shopId: SHOP }), 1);
});

test('an order within 30 minutes is not abandoned', async () => {
  const { id } = await captureCart(q, cart());
  await age(id, 40);
  await order({ minutesAgo: 35 }); // 5 minutes after the cart
  assert.deepEqual(await listCarts(q, { shopId: SHOP }), []);
  assert.equal((await cartStats(q, { from: today(), to: today(), shopId: SHOP })).count, 0);
});

test('an order after abandonment recovers it, a cancelled or pending one does not', async () => {
  const { id } = await captureCart(q, cart());
  await age(id, 120);
  const o = await order({ minutesAgo: 30, status: 'cancelled' });
  await order({ minutesAgo: 20, cbCheck: 'pending' });
  assert.equal((await listCarts(q, { shopId: SHOP }))[0].state, 'open');
  await q(`update zd.orders set status = 'new' where id = $1::uuid`, [o]);
  const [r] = await listCarts(q, { shopId: SHOP, state: 'all' });
  assert.equal(r.state, 'recovered');
  assert.ok(r.recoveredAt);
  assert.equal(await openCount(q, { shopId: SHOP }), 0);
});

test('an order more than 7 days later does not count as recovered', async () => {
  const { id } = await captureCart(q, cart());
  await age(id, 9 * 1440);
  await order({ minutesAgo: 1 * 1440 }); // 8 days after
  assert.equal((await listCarts(q, { shopId: SHOP, state: 'all' }))[0].state, 'open');
});

test('another shop or another phone does not recover it', async () => {
  const { id } = await captureCart(q, cart());
  await age(id, 120);
  await order({ minutesAgo: 10, phoneNorm: '+359877000000' });
  assert.equal((await listCarts(q, { shopId: SHOP }))[0].state, 'open');
  const [{ id: other }] = await q(`insert into zd.shops (name, domain) values ('Б', 'b-shop.bg') returning id`);
  assert.deepEqual(await listCarts(q, { shopId: other }), []);
  assert.equal((await listCarts(q, { shopIds: [SHOP, other] })).length, 1);
});

test('oversized carts are trimmed', async () => {
  const long = 'я'.repeat(5000);
  const items = Array.from({ length: 200 }, () => ({ name: long, qty: 1, price: 1 }));
  const { id } = await captureCart(q, cart({ items, name: long, email: long, pageUrl: `https://a-shop.bg/${long}`, deliveryText: long }));
  const [r] = await q(`select * from zd.abandoned_carts where id = $1::uuid`, [id]);
  assert.equal(r.items.length, 50);
  assert.ok(r.items.every((it) => it.name.length <= 200));
  assert.ok(r.name.length <= 160 && r.email.length <= 160);
  assert.ok(r.page_url.length <= 500);
  assert.ok(r.delivery_text.length <= 200);
});

test('stats count abandoned, recovered and after a reminder by first capture day', async () => {
  const a = await captureCart(q, cart({ phone: '0888111111', total: 10 }));
  const b = await captureCart(q, cart({ phone: '0888222222', total: 20 }));
  const c = await captureCart(q, cart({ phone: '0888333333', total: 30 }));
  for (const x of [a, b, c]) await age(x.id, 180);
  await order({ minutesAgo: 60, phoneNorm: '+359888222222' });
  await q(`update zd.abandoned_carts set reminded_at = now() - interval '2 hours' where id = $1::uuid`, [c.id]);
  await order({ minutesAgo: 30, phoneNorm: '+359888333333' });
  const s = await cartStats(q, { from: daysAgo(1), to: today(), shopId: SHOP });
  assert.equal(s.count, 3);
  assert.equal(s.recovered, 2);
  assert.equal(s.afterReminder, 1);
  assert.deepEqual(s.total, [{ currency: 'EUR', amount: 60 }]);
});

test('old carts are anonymised, very old deleted', async () => {
  const a = await captureCart(q, cart());
  await age(a.id, 31 * 1440);
  await order({ minutesAgo: 30 * 1440 }); // recovered a day later
  const b = await captureCart(q, cart({ phone: '0888999999' }));
  await age(b.id, 401 * 1440);
  const r = await anonymiseOld(q);
  assert.deepEqual(r, { anonymised: 1, deleted: 1 });
  const [row] = await q(`select * from zd.abandoned_carts`);
  assert.equal(row.phone_norm, '');
  assert.equal(row.name, '');
  assert.equal(row.email, '');
  assert.deepEqual(row.items, []);
  assert.equal(row.page_url, '');
  assert.ok(row.anonymised_at);
  const s = await cartStats(q, { from: daysAgo(32), to: today(), shopId: SHOP });
  assert.equal(s.count, 1);
  assert.equal(s.recovered, 1, 'the recovered fact survives anonymising');
});

test('opted-out numbers are flagged', async () => {
  const { id } = await captureCart(q, cart());
  await age(id, 60);
  await q(`insert into zd.campaign_optouts (shop_id, phone_norm) values ($1::uuid, '+359888123456')`, [SHOP]);
  assert.equal((await listCarts(q, { shopId: SHOP }))[0].optedOut, true);
});
