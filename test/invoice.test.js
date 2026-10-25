import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeReq, fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { insertOrder, ensureConfirmToken, toOrder } from '../lib/orders-repo.js';
import { cleanInvoice, saveInvoice } from '../lib/invoice.js';
import { createManualOrder, previewImport } from '../lib/manual-orders.js';
import { ordersToCsv } from '../lib/csv.js';
import { makeShopKey, resetKeyLimitsForTests } from '../lib/shop-keys.js';
import confirmApi from '../lib/admin/confirm.js';
import orders from '../api/orders.js';

process.env.INTEGRATIONS_SECRET = 'test-secret';
const SHOP = '00000000-0000-4000-8000-000000000001';
let q;
beforeEach(async () => {
  q = await makeTestQuery(); setQueryForTests(q); resetKeyLimitsForTests();
  await q(`update zd.shops set domain = 'a-shop.bg', name = 'Магазин А' where id = $1`, [SHOP]);
  await q(`insert into zd.offices (id, courier, code, name, city) values ('econt:1127', 'econt', '1127', 'Плевен Център', 'Плевен')`);
});
let seq = 0;
const order = async (patch = {}) => (await insertOrder(q, {
  cbOrderId: `i-${++seq}`, name: 'Мария', phone: '0888123456', phoneNorm: '+359888123456', email: '', deliveryType: 'econt_office', courier: 'econt',
  officeId: 'econt:1127', officeText: 'Плевен Център', city: 'Плевен', postCode: '', addressText: '', items: [{ name: 'Книга', qty: 1, price: 20 }],
  total: 20, currency: 'EUR', paymentMethod: 'cod', pageUrl: '', shopId: SHOP, ...patch,
})).id;
const GOOD = { company: 'Профитбранд ЕООД', eik: '206123456', vat: 'bg 206123456', mol: 'Иван Иванов', address: 'гр. Плевен, ул. Х 1' };

test('cleanInvoice: a good invoice is trimmed and normalised; empty input is no invoice', () => {
  assert.deepEqual(cleanInvoice(GOOD), { ok: true, invoice: { company: 'Профитбранд ЕООД', eik: '206123456', vat: 'BG206123456', mol: 'Иван Иванов', address: 'гр. Плевен, ул. Х 1' } });
  assert.deepEqual(cleanInvoice({}), { ok: true, invoice: {} });
  assert.deepEqual(cleanInvoice({ company: '  ', eik: '' }), { ok: true, invoice: {} });
  assert.deepEqual(cleanInvoice(null), { ok: true, invoice: {} });
});

test('cleanInvoice strict: Bulgarian errors; lenient: kept as typed and marked invalid', () => {
  assert.match(cleanInvoice({ ...GOOD, company: '' }, { strict: true }).error, /фирма/i);
  assert.match(cleanInvoice({ ...GOOD, eik: '12345' }, { strict: true }).error, /ЕИК/);
  assert.match(cleanInvoice({ ...GOOD, vat: 'DE123' }, { strict: true }).error, /ДДС/);
  const lenient = cleanInvoice({ ...GOOD, eik: '12345' });
  assert.equal(lenient.ok, true); assert.equal(lenient.invoice.eik, '12345'); assert.equal(lenient.invoice.invalid, true);
  assert.equal(cleanInvoice({ ...GOOD, eik: '1234567890123' }, { strict: true }).ok, true, '13-digit ЕИК (branch) is valid');
});

test('the order carries the invoice to the admin and the CSV export', async () => {
  const id = await order();
  await saveInvoice(q, id, GOOD);
  const [r] = await q(`select * from zd.orders where id = $1::uuid`, [id]);
  const o = toOrder(r);
  assert.equal(o.invoice.company, 'Профитбранд ЕООД'); assert.equal(o.invoice.vat, 'BG206123456');
  const csv = ordersToCsv([o]);
  assert.match(csv, /Фирма/); assert.match(csv, /206123456/);
  assert.deepEqual(toOrder((await q(`select * from zd.orders where id = $1::uuid`, [await order()]))[0]).invoice, {});
});

test('the customer adds invoice details on the order page until the order is shipped', async () => {
  const id = await order();
  const t = await ensureConfirmToken(q, id);
  const call = async (body) => { const res = fakeRes(); await confirmApi(fakeReq({ method: 'POST', url: '/api/admin/confirm', body: JSON.stringify({ t, action: 'invoice', ...body }) }), res); return res; };
  const bad = await call({ ...GOOD, eik: '1' });
  assert.equal(bad.statusCode, 400); assert.match(json(bad).error, /ЕИК/);
  assert.equal((await call(GOOD)).statusCode, 200);
  const page = json(await (async () => { const res = fakeRes(); await confirmApi(fakeReq({ url: `/api/admin/confirm?t=${t}` }), res); return res; })());
  assert.equal(page.invoice.company, 'Профитбранд ЕООД'); assert.equal(page.canInvoice, true);
  await q(`update zd.orders set status = 'shipped', waybill_number = '1' where id = $1::uuid`, [id]);
  assert.equal((await call(GOOD)).statusCode, 400);
});

test('manual orders and CSV imports take invoice columns', async () => {
  const r = await createManualOrder(q, { shopId: SHOP, domain: 'a-shop.bg', currency: 'EUR', order: {
    name: 'Иван', phone: '0888123456', delivery_type: 'econt_office', office_id: 'econt:1127', items: [{ name: 'К', qty: 1, price: 5 }], total: '5', invoice: GOOD } });
  const [row] = await q(`select invoice from zd.orders where id = $1::uuid`, [r.id]);
  assert.equal(row.invoice.eik, '206123456');
  const csv = 'Име;Телефон;Офис;Артикули;Сума;Фирма;ЕИК;ДДС номер;МОЛ;Адрес по регистрация\nИван;0888123456;Еконт Плевен Център (1127);1 × Книга;5;Фирма ООД;206123456;;Петър;гр. Плевен\n';
  const p = await previewImport(q, { shopId: SHOP, domain: 'a-shop.bg', currency: 'EUR', csv });
  assert.equal(p.rows[0].ok, true, JSON.stringify(p.rows[0]));
  assert.deepEqual(p.rows[0].order.invoice, { company: 'Фирма ООД', eik: '206123456', mol: 'Петър', address: 'гр. Плевен' });
});

test('a site sends invoice details with the order; garbage never refuses the order', async () => {
  const { key } = await makeShopKey(q, SHOP);
  const res = fakeRes();
  await orders(fakeReq({ method: 'POST', url: '/api/orders', headers: { authorization: `Bearer ${key}` }, body: JSON.stringify({
    source: 'api', external_id: 'X-1', name: 'Мария', phone: '0888123456', delivery_type: 'econt_office', office_id: 'econt:1127', office_text: 'Плевен', city: 'Плевен',
    items: [{ name: 'К', qty: 1, price: 5 }], total: 5, invoice: { company: 'Ф ООД', eik: 'abc' } }) }), res);
  assert.equal(res.statusCode, 200, res.body);
  const [row] = await q(`select invoice from zd.orders where cb_order_id = 'a-shop.bg:ext-X-1'`);
  assert.equal(row.invoice.company, 'Ф ООД'); assert.equal(row.invoice.invalid, true);
});
