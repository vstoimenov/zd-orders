// Fixes from the review of delivery change / invoice / reports / cart → order.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeReq, fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { insertOrder, upsertExternalOrder, upsertCbOrder } from '../lib/orders-repo.js';
import { changeDelivery } from '../lib/delivery-change.js';
import { createWaybill } from '../lib/waybills.js';
import { saveInvoice } from '../lib/invoice.js';
import { createManualOrder } from '../lib/manual-orders.js';
import orders from '../api/orders.js';

process.env.INTEGRATIONS_SECRET = 'test-secret';
process.env.ORDER_TOKEN = 'tok';
const SHOP = '00000000-0000-4000-8000-000000000001';
const ORIGIN = 'https://a-shop.bg';
let q;
beforeEach(async () => {
  q = await makeTestQuery(); setQueryForTests(q);
  process.env.ALLOWED_ORIGINS = ORIGIN;
  await q(`update zd.shops set domain = 'a-shop.bg' where id = $1`, [SHOP]);
  await q(`insert into zd.offices (id, courier, code, name, city) values ('econt:1127', 'econt', '1127', 'Плевен Център', 'Плевен'), ('econt:2', 'econt', '2', 'Варна', 'Варна')`);
});
const base = { name: 'Мария', phone: '0888123456', phoneNorm: '+359888123456', email: '', deliveryType: 'econt_office', courier: 'econt',
  officeId: 'econt:1127', officeText: 'Плевен Център', city: 'Плевен', postCode: '', addressText: '', items: [{ name: 'Книга', qty: 1, price: 20 }],
  total: 20, currency: 'EUR', paymentMethod: 'cod', pageUrl: '', shopId: SHOP };
const row = async (id) => (await q(`select * from zd.orders where id = $1::uuid`, [id]))[0];

test('#1 the waybill window refuses when the delivery changed since it opened; a send to the warehouse blocks a change', async () => {
  const { id } = await insertOrder(q, { ...base, cbOrderId: 'w1' });
  await changeDelivery(q, id, { courier: 'econt', officeId: 'econt:2' }, { by: 'customer' });
  await assert.rejects(createWaybill(q, { orderId: id, scopeShopId: SHOP, input: { deliveryChangedAt: null } }), /сменена/);
  const { id: b } = await insertOrder(q, { ...base, cbOrderId: 'w2' });
  await q(`update zd.orders set fulfil_notify = 'sending' where id = $1::uuid`, [b]);
  await assert.rejects(changeDelivery(q, b, { courier: 'econt', officeId: 'econt:2' }, { by: 'customer' }), /подготвя|склада/);
});

test('#2 a re-sent site order keeps a delivery the customer changed and an invoice the customer corrected', async () => {
  const first = await upsertExternalOrder(q, { ...base, cbOrderId: 'a-shop.bg:ext-1', source: 'api' });
  await changeDelivery(q, first.id, { courier: 'econt', officeId: 'econt:2' }, { by: 'customer' });
  await saveInvoice(q, first.id, { company: 'Вярна ООД', eik: '206123456' }, { strict: true });
  await upsertExternalOrder(q, { ...base, cbOrderId: 'a-shop.bg:ext-1', source: 'api', items: [{ name: 'Друга', qty: 2, price: 5 }] });
  await saveInvoice(q, first.id, { company: 'Стара ООД', eik: '1' }, { onlyIfEmpty: true });
  const r = await row(first.id);
  assert.equal(r.office_id, 'econt:2'); assert.equal(r.items[0].name, 'Друга', 'other fields still update');
  assert.equal(r.invoice.company, 'Вярна ООД');
});

test('#3 the checkout invoice is kept when the ConvertBuilder copy arrived first', async () => {
  await upsertCbOrder(q, { cbOrderId: 'a-shop.bg:77', invoiceNo: 1, name: 'Мария', phone: '0888123456', phoneNorm: '+359888123456', email: '', deliveryType: 'econt_office', courier: 'econt',
    officeText: 'x', city: 'Плевен', postCode: '', addressText: '', items: [], total: 20, currency: 'EUR', paymentMethod: 'cod', insertStatus: 'new', updateStatus: null, createdAt: null, cbStatus: 'pending', shopId: SHOP });
  const res = fakeRes();
  await orders(fakeReq({ method: 'POST', url: '/api/orders', headers: { origin: ORIGIN, 'x-forwarded-for': '9.9.9.9' }, body: JSON.stringify({
    token: 'tok', cb_order_id: '77', name: 'Мария', phone: '0888123456', delivery_type: 'econt_office', office_id: 'econt:1127', office_text: 'Плевен', city: 'Плевен',
    items: [], total: 20, invoice: { company: 'Фирма ООД', eik: '206123456' } }) }), res);
  assert.equal(res.statusCode, 200, res.body);
  const [r] = await q(`select invoice from zd.orders where cb_order_id = 'a-shop.bg:77'`);
  assert.equal(r.invoice.company, 'Фирма ООД');
});

test('#4 control characters in invoice details are stripped, never an error', async () => {
  const { id } = await insertOrder(q, { ...base, cbOrderId: 'n1' });
  await saveInvoice(q, id, { company: 'A\u0000B\u0007', eik: '206123456' });
  assert.equal((await row(id)).invoice.company, 'AB');
});

test('#5 a cart the customer already ordered from is refused for „Направи поръчка“', async () => {
  const [{ id: cart }] = await q(`insert into zd.abandoned_carts (shop_id, phone_norm, name, items, total, created_at, updated_at)
    values ($1::uuid, '+359888123456', 'Мария', '[]', 20, now() - interval '3 hours', now() - interval '3 hours') returning id`, [SHOP]);
  await insertOrder(q, { ...base, cbOrderId: 'site-1' }); // the customer ordered on the site meanwhile
  await assert.rejects(createManualOrder(q, { shopId: SHOP, domain: 'a-shop.bg', currency: 'EUR', cartId: cart, order: {
    name: 'Мария', phone: '0888123456', delivery_type: 'other', office_text: 'x', items: [{ name: 'К', qty: 1, price: 1 }], total: '1' } }), /вече поръча/);
  const [{ n }] = await q(`select count(*)::int as n from zd.orders`);
  assert.equal(n, 1);
});
