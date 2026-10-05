import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeReq, fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { insertOrder } from '../lib/orders-repo.js';
import { signSession, verifySession, passwordMatches } from '../lib/auth.js';
import { waybillText } from '../lib/waybill.js';
import { ordersToCsv } from '../lib/csv.js';
import login from '../api/admin/login.js';
import adminOrders from '../api/admin/orders.js';

process.env.ADMIN_PASSWORD = 'парола-123';
process.env.ADMIN_SECRET = 'secret';

const sample = {
  id: 'x', createdAt: '2026-10-02T10:05:00.000Z', cbOrderId: 'A1', name: 'Мария Иванова', phone: '0888123456',
  phoneNorm: '+359888123456', email: 'm@x.bg', deliveryType: 'econt_office', courier: 'econt', officeId: 'econt:7538',
  officeText: 'ЕКОНТ – офис Айдемир (7538), ул. София 7', city: 'Айдемир', postCode: '7538', addressText: '',
  items: [{ name: 'Тесте', qty: 1, price: 18.5 }, { name: 'Аудио; "бонус"', qty: 2, price: 6 }],
  total: 30.5, currency: 'EUR', paymentMethod: 'cod', pageUrl: '', status: 'new', isDuplicate: true,
};

test('session tokens expire and cannot be forged', () => {
  const t = signSession('s', 1000);
  assert.equal(verifySession('s', t, 1000), true);
  assert.equal(verifySession('s', t, 1000 + 8 * 24 * 3600), false);
  assert.equal(verifySession('other', t, 1000), false);
  assert.equal(verifySession('s', 'garbage', 1000), false);
  assert.equal(passwordMatches('a', 'a'), true);
  assert.equal(passwordMatches('a', 'b'), false);
  assert.equal(passwordMatches('a', ''), false);
});

test('waybillText has everything the courier counter needs', () => {
  assert.equal(waybillText(sample), [
    'Получател: Мария Иванова',
    'Телефон: 0888123456',
    'Куриер: Еконт – до офис',
    'Доставка: ЕКОНТ – офис Айдемир (7538), ул. София 7',
    'Град: Айдемир (7538)',
    'Наложен платеж: 30.50 EUR',
    'Съдържание: 1 × Тесте; 2 × Аудио; "бонус"',
  ].join('\n'));
});

test('ordersToCsv uses a BOM, semicolons and quotes', () => {
  const lines = ordersToCsv([sample]).split('\r\n');
  assert.ok(lines[0].startsWith('﻿Дата;Име;Телефон'));
  assert.equal(lines[1].split(';')[0], '2026-10-02 13:05');
  assert.ok(lines[1].includes('"1 × Тесте; 2 × Аудио; ""бонус"""'));
  assert.ok(lines[1].includes(';30.50;EUR;new;да;A1'));
});

test('ordersToCsv escapes formula injection', () => {
  const lines = ordersToCsv([{ ...sample, name: '=1+1', email: '@evil', phone: '+359888123456' }]).split('\r\n');
  const cols = lines[1].split(';');
  assert.equal(cols[1], "'=1+1");
  assert.equal(cols[3], "'@evil");
  assert.equal(cols[2], '+359888123456');

  const lines2 = ordersToCsv([{ ...sample, name: '-x' }]).split('\r\n');
  const cols2 = lines2[1].split(';');
  assert.equal(cols2[1], "'-x");
});

test('ordersToCsv escapes formula injection with dangerous separators', () => {
  const csv = ordersToCsv([{ ...sample, name: '@a;=HYPERLINK("http://evil";"x")' }]);
  // The name cell must be quoted and prefixed to prevent semicolon from breaking the row
  assert.ok(csv.includes(';"\'@a;=HYPERLINK(""http://evil"";""x"")";'), 'name cell should be quoted and prefixed');

  const csv2 = ordersToCsv([{ ...sample, name: '=1\r\n=cmd|x!A0' }]);
  // The newline inside must be quoted (and the formula prefixed)
  assert.ok(csv2.includes('"\'=1\r\n=cmd|x!A0"'), 'name cell with newline should be quoted and prefixed');
});

let q;
beforeEach(async () => { q = await makeTestQuery(); setQueryForTests(q); });

async function cookie() {
  const res = fakeRes();
  await login(fakeReq({ method: 'POST', body: JSON.stringify({ password: 'парола-123' }) }), res);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['set-cookie'], /^zdo_admin=\d+\.[0-9a-f]+; Path=\/api\/admin; HttpOnly; Secure; SameSite=Strict/);
  return res.headers['set-cookie'].split(';')[0];
}

test('login rejects a wrong password', async () => {
  const res = fakeRes();
  await login(fakeReq({ method: 'POST', body: JSON.stringify({ password: 'грешна' }) }), res);
  assert.equal(res.statusCode, 401);
});

test('admin orders: auth, list with waybill, status change, csv', async () => {
  await insertOrder(q, { ...sample, ip: '1', userAgent: '' });
  let res = fakeRes();
  await adminOrders(fakeReq({ url: '/api/admin/orders' }), res);
  assert.equal(res.statusCode, 401);

  const c = await cookie();
  res = fakeRes();
  await adminOrders(fakeReq({ url: '/api/admin/orders?status=new', headers: { cookie: c } }), res);
  const data = json(res);
  assert.equal(data.total, 1);
  assert.match(data.orders[0].waybill, /^Получател: Мария Иванова/);

  res = fakeRes();
  await adminOrders(fakeReq({ method: 'PATCH', headers: { cookie: c }, body: JSON.stringify({ id: data.orders[0].id, status: 'shipped' }) }), res);
  assert.deepEqual(json(res), { ok: true });
  res = fakeRes();
  await adminOrders(fakeReq({ method: 'PATCH', headers: { cookie: c }, body: JSON.stringify({ id: data.orders[0].id, status: 'lost' }) }), res);
  assert.equal(res.statusCode, 400);

  res = fakeRes();
  await adminOrders(fakeReq({ url: '/api/admin/orders?format=csv&status=shipped', headers: { cookie: c } }), res);
  assert.match(res.headers['content-type'], /text\/csv/);
  assert.match(res.headers['content-disposition'], /attachment; filename="porachki-\d{4}-\d{2}-\d{2}\.csv"/);
  assert.equal(res.body.split('\r\n').length, 2);
});

test('admin orders rejects malformed cookie with 401', async () => {
  const res = fakeRes();
  await adminOrders(fakeReq({ url: '/api/admin/orders', headers: { cookie: 'zdo_admin=%' } }), res);
  assert.equal(res.statusCode, 401);
});

test('admin can delete an order permanently', async () => {
  const { insertOrder: ins, deleteOrder, listOrders: list } = await import('../lib/orders-repo.js');
  const { id } = await ins(q, { ...sample, cbOrderId: 'DEL1', ip: '1', userAgent: '' });
  assert.equal(await deleteOrder(q, 'not-a-uuid'), false);
  const c = await cookie();
  let res = fakeRes();
  await adminOrders(fakeReq({ method: 'DELETE', headers: { cookie: c }, body: JSON.stringify({ id }) }), res);
  assert.deepEqual(json(res), { ok: true });
  assert.equal((await list(q)).total, 0);
  res = fakeRes();
  await adminOrders(fakeReq({ method: 'DELETE', headers: { cookie: c }, body: JSON.stringify({ id }) }), res);
  assert.equal(res.statusCode, 404);
  res = fakeRes();
  await adminOrders(fakeReq({ method: 'DELETE', body: JSON.stringify({ id }) }), res);
  assert.equal(res.statusCode, 401);
});
