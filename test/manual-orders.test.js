import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeReq, fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { listOrders } from '../lib/orders-repo.js';
import { signSession } from '../lib/auth.js';
import { createClient, acceptInvite, clientSession } from '../lib/users.js';
import { saveSubscription, setPushSenderForTests } from '../lib/push.js';
import { parseCsv, previewImport, createManualOrder } from '../lib/manual-orders.js';
import ordersApi from '../lib/admin/orders.js';

process.env.ADMIN_SECRET = 'secret';
process.env.VAPID_PUBLIC_KEY = 'B'; process.env.VAPID_PRIVATE_KEY = 'p';
const SHOP = '00000000-0000-4000-8000-000000000001';
const owner = `zdo_admin=${signSession('secret')}`;
let q, sent;
beforeEach(async () => {
  q = await makeTestQuery(); setQueryForTests(q);
  await q(`update zd.shops set domain = 'a-shop.bg', name = 'Магазин А' where id = $1`, [SHOP]);
  await q(`insert into zd.offices (id, courier, code, name, city, address) values ('econt:1127', 'econt', '1127', 'Плевен Център', 'Плевен', 'ул. Левски 5'), ('speedy:79', 'speedy', '79', 'ПЛОВДИВ - ОФИС', 'Пловдив', '')`);
  sent = [];
  setPushSenderForTests(async (s, payload) => { sent.push(JSON.parse(payload)); return { statusCode: 201 }; });
  await saveSubscription(q, { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/owner', keys: { p256dh: 'p', auth: 'a' } }, shopId: null });
});
const post = async (body, cookie = owner, shop = SHOP) => {
  const res = fakeRes();
  await ordersApi(fakeReq({ method: 'POST', url: `/api/admin/orders?shop=${shop}`, headers: { cookie }, body: JSON.stringify(body) }), res);
  return res;
};
const manual = (patch = {}) => ({
  name: 'Мария Иванова', phone: '0888 123 456', email: 'm@x.bg', delivery_type: 'econt_office', office_id: 'econt:1127',
  items: [{ name: 'Книга', qty: 2, price: 12.9 }], total: 30.3, payment_method: 'cod', ...patch,
});

test('a manual order: source manual, its own number, the office from the id, stock/push run, no WhatsApp', async () => {
  const res = await post({ action: 'create', order: manual() });
  assert.equal(res.statusCode, 200, res.body);
  const [o] = (await listOrders(q)).rows;
  assert.equal(o.cbOrderId.startsWith('a-shop.bg:m-'), true);
  assert.equal(o.officeId, 'econt:1127');
  assert.equal(o.officeText, 'ЕКОНТ – офис Плевен Център (1127), ул. Левски 5');
  assert.equal(o.city, 'Плевен');
  assert.equal(o.phoneNorm, '+359888123456');
  assert.equal(o.paymentMethod, 'cod');
  assert.equal(o.total, 30.3);
  assert.equal((await q(`select source from zd.orders`))[0].source, 'manual');
  assert.ok(sent.some((p) => /Нова поръчка/.test(p.title)));
  assert.equal(o.confirmation.sent, false);
});

test('a manual order to an address, or with an unknown courier, and the checks', async () => {
  assert.equal((await post({ action: 'create', order: manual({ delivery_type: 'speedy_address', office_id: '', city: 'Варна', post_code: '9000', address_text: 'ул. Тайна 5' }) })).statusCode, 200);
  assert.equal((await post({ action: 'create', order: manual({ delivery_type: 'other', office_id: '', office_text: 'Вземане от магазина' }) })).statusCode, 200);
  const bad = await post({ action: 'create', order: manual({ phone: '' }) });
  assert.equal(bad.statusCode, 400);
  assert.match(json(bad).error, /телефон/i);
  assert.equal((await post({ action: 'create', order: manual({ office_id: 'econt:9999' }) })).statusCode, 400);
  assert.equal((await post({ action: 'create', order: manual({ items: [] }) })).statusCode, 400);
});

test('parseCsv: BOM + semicolons, quoted commas and new lines, Windows-1251 commas', () => {
  const a = parseCsv('﻿Име;Телефон;Артикули\r\n"Иванова, Мария";0888123456;"Книга x2\nСтикери x1"\r\n');
  assert.equal(a.delimiter, ';');
  assert.deepEqual(a.rows, [{ 'Име': 'Иванова, Мария', 'Телефон': '0888123456', 'Артикули': 'Книга x2\nСтикери x1' }]);
  const win = Buffer.from('\xc8\xec\xe5,\xd2\xe5\xeb\xe5\xf4\xee\xed\r\n\xcc\xe0\xf0\xe8\xff,0888123456\r\n', 'latin1'); // "Име,Телефон" / "Мария,…" in cp1251
  const b = parseCsv(win);
  assert.equal(b.encoding, 'windows-1251');
  assert.deepEqual(b.rows, [{ 'Име': 'Мария', 'Телефон': '0888123456' }]);
});

const CSV = '﻿Име;Телефон;Имейл;Град;Офис;Артикули;Сума;Плащане\r\n' +
  'Мария Иванова;0888123456;m@x.bg;Плевен;ЕКОНТ – офис Плевен Център (1127);"Книга ×2; Стикери ×1";30,30;наложен платеж\r\n' +
  'Петър Петров;0888222222;;Варна;ул. Тайна 5;Книга;12.90;платена\r\n' +
  'Без Телефон;;;София;;Книга;12.90;\r\n';

test('previewImport reads every row, matches an office by its code, flags what will be skipped, and nothing is written yet', async () => {
  const p = await previewImport(q, { shopId: SHOP, domain: 'a-shop.bg', csv: CSV });
  assert.equal(p.rows.length, 3);
  const [r1, r2, r3] = p.rows;
  assert.equal(r1.ok, true);
  assert.equal(r1.order.officeId, 'econt:1127');
  assert.equal(r1.order.deliveryType, 'econt_office');
  assert.deepEqual(r1.order.items, [{ name: 'Книга', qty: 2, price: 0 }, { name: 'Стикери', qty: 1, price: 0 }]);
  assert.equal(r1.order.total, 30.3);
  assert.equal(r1.order.paymentMethod, 'cod');
  assert.equal(r2.ok, true);
  assert.equal(r2.order.deliveryType, 'other');
  assert.equal(r2.order.officeText, 'ул. Тайна 5');
  assert.equal(r2.order.paymentMethod, 'card');
  assert.equal(r3.ok, false);
  assert.match(r3.error, /телефон/i);
  assert.deepEqual(p.summary, { total: 3, ok: 2, skipped: 1 });
  assert.equal((await listOrders(q)).rows.length, 0);
});

test('import writes the good rows once; the same file again updates instead of duplicating', async () => {
  const res = await post({ action: 'import', csv: CSV, confirm: true });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(json(res), { ok: true, inserted: 2, updated: 0, skipped: 1, errors: ['ред 3: Липсва телефон'] });
  const rows = (await listOrders(q)).rows;
  assert.equal(rows.length, 2);
  assert.ok(rows.every((o) => /^a-shop\.bg:c-[0-9a-f]{8}-\d+$/.test(o.cbOrderId)));
  assert.equal((await q(`select count(*)::int as n from zd.orders where source = 'csv'`))[0].n, 2);
  const again = await post({ action: 'import', csv: CSV, confirm: true });
  assert.deepEqual(json(again), { ok: true, inserted: 0, updated: 2, skipped: 1, errors: ['ред 3: Липсва телефон'] });
  assert.equal((await listOrders(q)).rows.length, 2);
  const preview = await post({ action: 'import', csv: CSV });
  assert.equal(json(preview).summary.ok, 2);
});

test('a client creates and imports only into their own shop; "all shops" is refused', async () => {
  const [{ id: other }] = await q(`insert into zd.shops (name, domain) values ('Б', 'b-shop.bg') returning id`);
  const { id, token } = await createClient(q, { email: 'c@x.bg', shopIds: [other] });
  const u = await acceptInvite(q, token, 'client-pass-1');
  const c = `zdo_admin=${clientSession('secret', { id, session_version: u.session_version })}`;
  assert.equal((await post({ action: 'create', order: manual() }, c, SHOP)).statusCode, 400);
  assert.equal((await post({ action: 'create', order: manual() }, c, other)).statusCode, 200);
  assert.equal((await q(`select shop_id from zd.orders`))[0].shop_id, other);
  assert.equal((await post({ action: 'import', csv: CSV, confirm: true }, owner, 'all')).statusCode, 400);
});

test('previewImport refuses more than 500 rows and files over 1 MB', async () => {
  const big = 'Име;Телефон\r\n' + Array.from({ length: 501 }, (_, i) => `К${i};088800${String(i).padStart(4, '0')}\r\n`).join('');
  await assert.rejects(previewImport(q, { shopId: SHOP, domain: 'a-shop.bg', csv: big }), /500/);
  await assert.rejects(previewImport(q, { shopId: SHOP, domain: 'a-shop.bg', csv: 'x'.repeat(1024 * 1024 + 1) }), /1 MB/);
});

/* ---- review fixes ---- */
const HEAD = '\uFEFFИме;Телефон;Офис;Артикули;Сума;Плащане\r\n';
const row = (office, items, total, pay, phone = '0888123456') => `Клиент;${phone};${office};"${items}";${total};${pay}\r\n`;
const prev = (csv) => previewImport(q, { shopId: SHOP, domain: 'a-shop.bg', csv });

test('payment column: cash on delivery unless it clearly says paid', async () => {
  const p = await prev(HEAD + row('x', 'Книга', '10', 'неплатена') + row('x', 'Книга', '10', 'платеж при доставка') + row('x', 'Книга', '10', 'платена') + row('x', 'Книга', '10', 'card') + row('x', 'Книга', '10', 'да') + row('x', 'Книга', '10', ''));
  assert.deepEqual(p.rows.map((r) => r.order.paymentMethod), ['cod', 'cod', 'card', 'card', 'card', 'cod']);
});

test('an office is matched by its code only when the courier is named; the code must belong to that courier', async () => {
  const p = await prev(HEAD + row('ЕКОНТ – офис Плевен Център (1127)', 'Книга', '10', '') + row('СПИДИ – офис Плевен (1127)', 'Книга', '10', '') + row('ул. Витоша 10 (2)', 'Книга', '10', '') + row('Speedy office ПЛОВДИВ (79)', 'Книга', '10', ''));
  assert.deepEqual(p.rows.map((r) => [r.order.deliveryType, r.order.officeId]), [['econt_office', 'econt:1127'], ['other', ''], ['other', ''], ['speedy_office', 'speedy:79']]);
});

test('a missing, empty or zero total is refused; amounts with currency signs and spaces are read', async () => {
  await assert.rejects(prev('\uFEFFИме;Телефон;Артикули\r\nК;0888123456;Книга\r\n'), /Сума/);
  const p = await prev(HEAD + row('x', 'Книга', '', '') + row('x', 'Книга', '0', '') + row('x', 'Книга', '30,30 лв', '') + row('x', 'Книга', '€1 234.50', ''));
  assert.equal(p.rows[0].ok, false); assert.match(p.rows[0].error, /сума/i);
  assert.equal(p.rows[1].ok, false);
  assert.equal(p.rows[2].order.total, 30.3);
  assert.equal(p.rows[3].order.total, 1234.5);
  const res = await post({ action: 'create', order: manual({ total: '' }) });
  assert.equal(res.statusCode, 400);
  assert.match(json(res).error, /сума/i);
});

test('items: the Cyrillic х counts as ×, commas stay inside a name, ; and new lines split', async () => {
  const p = await prev(HEAD + row('x', 'Книга х2; Тениска M, черна\n3 x Стикери', '10', ''));
  assert.deepEqual(p.rows[0].order.items, [{ name: 'Книга', qty: 2, price: 0 }, { name: 'Тениска M, черна', qty: 1, price: 0 }, { name: 'Стикери', qty: 3, price: 0 }]);
});

test('an unclosed quote is reported as such', async () => {
  await assert.rejects(prev(HEAD + 'К;0888123456;x;"Книга;10;\r\nДруг;0888123457;x;Книга;10;\r\n'), /кавички/);
});

test('manual and CSV orders take the shop\'s currency', async () => {
  await q(`update zd.shops set currency = 'BGN' where id = $1`, [SHOP]);
  await post({ action: 'create', order: manual() });
  assert.equal((await listOrders(q)).rows[0].currency, 'BGN');
});

/* ---- an abandoned cart turned into an order ---- */
test('„Направи поръчка“ from an abandoned cart links the cart to the new order and marks it recovered, once', async () => {
  const [{ id: cart }] = await q(`insert into zd.abandoned_carts (shop_id, phone_norm, name, items, total, created_at, updated_at)
    values ($1::uuid, '+359888999000', 'Петя', '[{"name":"Книга","qty":1,"price":20}]', 20, now() - interval '2 hours', now() - interval '2 hours') returning id`, [SHOP]);
  const body = (cartId) => JSON.stringify({ action: 'create', cartId, order: { name: 'Петя', phone: '0888999000', delivery_type: 'other', office_text: 'По телефона', items: [{ name: 'Книга', qty: 1, price: 20 }], total: '20' } });
  const call = async (b) => { const res = fakeRes(); await ordersApi(fakeReq({ method: 'POST', url: `/api/admin/orders?shop=${SHOP}`, headers: { cookie: `zdo_admin=${signSession('secret')}` }, body: b }), res); return res; };
  const res = await call(body(cart));
  assert.equal(res.statusCode, 200, res.body);
  const [c] = await q(`select order_id, recovered_at from zd.abandoned_carts where id = $1::uuid`, [cart]);
  assert.equal(c.order_id, json(res).id); assert.ok(c.recovered_at);
  const again = await call(body(cart));
  assert.equal(again.statusCode, 200);
  const [c2] = await q(`select order_id from zd.abandoned_carts where id = $1::uuid`, [cart]);
  assert.equal(c2.order_id, json(res).id, 'the first order stays linked');
  const { listCarts } = await import('../lib/abandoned.js');
  const [listed] = await listCarts(q, { shopId: SHOP, state: 'all' });
  assert.equal(listed.orderId, json(res).id);
});

test('a cart of another shop is never linked', async () => {
  const [{ id: other }] = await q(`insert into zd.shops (name, domain) values ('Б', 'b-shop.bg') returning id`);
  const [{ id: cart }] = await q(`insert into zd.abandoned_carts (shop_id, phone_norm, name, items, total) values ($1::uuid, '+359888999000', 'П', '[]', 1) returning id`, [other]);
  await createManualOrder(q, { shopId: SHOP, domain: 'a-shop.bg', currency: 'EUR', cartId: cart, order: { name: 'П', phone: '0888999000', delivery_type: 'other', office_text: 'x', items: [{ name: 'К', qty: 1, price: 1 }], total: '1' } });
  const [c] = await q(`select order_id from zd.abandoned_carts where id = $1::uuid`, [cart]);
  assert.equal(c.order_id, null);
});
