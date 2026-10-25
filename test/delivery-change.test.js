import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeReq, fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { insertOrder, ensureConfirmToken, toOrder } from '../lib/orders-repo.js';
import { saveIntegration } from '../lib/integrations-repo.js';
import { changeDelivery } from '../lib/delivery-change.js';
import { confirmPage } from '../lib/confirm.js';
import { signSession } from '../lib/auth.js';
import { saveSubscription, setPushSenderForTests } from '../lib/push.js';
import confirmApi from '../lib/admin/confirm.js';
import ordersApi from '../lib/admin/orders.js';

process.env.ADMIN_SECRET = 'secret';
process.env.INTEGRATIONS_SECRET = 'test-secret';
process.env.VAPID_PUBLIC_KEY = 'B'; process.env.VAPID_PRIVATE_KEY = 'p';
const SHOP = '00000000-0000-4000-8000-000000000001';
let q, sent;
beforeEach(async () => {
  q = await makeTestQuery(); setQueryForTests(q);
  await q(`insert into zd.offices (id, courier, code, name, city, is_automat) values
    ('econt:1127', 'econt', '1127', 'Плевен Център', 'Плевен', false),
    ('speedy:79', 'speedy', '79', 'ПЛОВДИВ - ОФИС', 'Пловдив', false),
    ('boxnow:9', 'boxnow', '9', 'Автомат Лидл', 'София', true)`);
  sent = [];
  setPushSenderForTests(async (s, payload) => { sent.push(JSON.parse(payload)); return { statusCode: 201 }; });
  await saveSubscription(q, { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/owner', keys: { p256dh: 'p', auth: 'a' } }, shopId: null });
});
let seq = 0;
const order = async (patch = {}) => (await insertOrder(q, {
  cbOrderId: `d-${++seq}`, name: 'Мария', phone: '0888123456', phoneNorm: '+359888123456', email: '', deliveryType: 'econt_office', courier: 'econt',
  officeId: 'econt:1', officeText: 'Стар офис', city: 'София', postCode: '', addressText: '', items: [{ name: 'Книга', qty: 1, price: 20 }],
  total: 20, currency: 'EUR', paymentMethod: 'cod', pageUrl: '', shopId: SHOP, ...patch,
})).id;
const row = async (id) => (await q(`select * from zd.orders where id = $1::uuid`, [id]))[0];

test('the customer moves the order to another office: fields, who changed it, and the shop hears it', async () => {
  const id = await order();
  await changeDelivery(q, id, { courier: 'speedy', officeId: 'speedy:79' }, { by: 'customer' });
  const r = await row(id);
  assert.equal(r.courier, 'speedy'); assert.equal(r.delivery_type, 'speedy_office'); assert.equal(r.office_id, 'speedy:79');
  assert.equal(r.office_text, 'ПЛОВДИВ - ОФИС, Пловдив (79)'); assert.equal(r.city, 'Пловдив');
  assert.equal(r.delivery_changed_by, 'customer'); assert.ok(r.delivery_changed_at);
  assert.deepEqual(sent.map((p) => p.title), ['📍 Клиентът смени доставката']);
  assert.equal(toOrder(r).deliveryChangedBy, 'customer');
});

test('an address change needs city and address; BOX NOW is lockers only', async () => {
  const id = await order();
  await assert.rejects(changeDelivery(q, id, { courier: 'econt', city: 'Варна' }, { by: 'shop' }), /адрес/i);
  await changeDelivery(q, id, { courier: 'econt', city: 'Варна', postCode: '9000', addressText: 'ул. Х 1' }, { by: 'shop' });
  const r = await row(id);
  assert.equal(r.delivery_type, 'econt_address'); assert.equal(r.office_id, ''); assert.equal(r.address_text, 'ул. Х 1');
  assert.equal(r.office_text, 'Еконт – адрес: ул. Х 1, Варна'); assert.equal(r.delivery_changed_by, 'shop');
  assert.equal(sent.length, 0);
  await assert.rejects(changeDelivery(q, id, { courier: 'boxnow', city: 'София', addressText: 'ул. 1' }, { by: 'shop' }), /автомат/);
});

test('refused once the order has a waybill, is shipped, is at the warehouse, or the office is unknown', async () => {
  const a = await order(); await q(`update zd.orders set waybill_number = '1055' where id = $1::uuid`, [a]);
  await assert.rejects(changeDelivery(q, a, { courier: 'econt', officeId: 'econt:1127' }, { by: 'customer' }), /изпратена/);
  await assert.rejects(changeDelivery(q, a, { courier: 'econt', officeId: 'econt:1127' }, { by: 'shop' }), /товарителница/);
  const b = await order(); await q(`update zd.orders set status = 'cancelled' where id = $1::uuid`, [b]);
  await assert.rejects(changeDelivery(q, b, { courier: 'econt', officeId: 'econt:1127' }, { by: 'customer' }), /изпратена|затворена/);
  const c = await order(); await q(`update zd.orders set fulfil_sent_at = now() where id = $1::uuid`, [c]);
  await assert.rejects(changeDelivery(q, c, { courier: 'econt', officeId: 'econt:1127' }, { by: 'shop' }), /склада/);
  const d = await order();
  await assert.rejects(changeDelivery(q, d, { courier: 'econt', officeId: 'speedy:79' }, { by: 'shop' }), /офис/);
  await assert.rejects(changeDelivery(q, d, { courier: 'dhl', officeId: 'x' }, { by: 'shop' }), /куриер/);
});

test('the customer gets lockers only when the shop offers BOX NOW in its checkout', async () => {
  const id = await order();
  await assert.rejects(changeDelivery(q, id, { courier: 'boxnow', officeId: 'boxnow:9' }, { by: 'customer' }), /BOX NOW/);
  await saveIntegration(q, 'boxnow', { config: { checkout: true }, shopId: SHOP });
  await changeDelivery(q, id, { courier: 'boxnow', officeId: 'boxnow:9' }, { by: 'customer' });
  assert.equal((await row(id)).delivery_type, 'boxnow_locker');
});

test('the order page says whether the delivery can be changed; the public action changes it', async () => {
  const id = await order();
  const t = await ensureConfirmToken(q, id);
  const page = await confirmPage(q, t);
  assert.equal(page.canChangeDelivery, true); assert.equal(page.boxnow, false); assert.equal(page.deliveryType, 'econt_office');
  const res = fakeRes();
  await confirmApi(fakeReq({ method: 'POST', url: '/api/admin/confirm', body: JSON.stringify({ t, action: 'delivery', courier: 'econt', officeId: 'econt:1127' }) }), res);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal((await row(id)).office_id, 'econt:1127');
  await q(`update zd.orders set waybill_number = '1' where id = $1::uuid`, [id]);
  assert.equal((await confirmPage(q, t)).canChangeDelivery, false);
});

test('the shop changes it from the admin', async () => {
  const id = await order();
  const res = fakeRes();
  await ordersApi(fakeReq({ method: 'POST', url: '/api/admin/orders', headers: { cookie: `zdo_admin=${signSession('secret')}` },
    body: JSON.stringify({ action: 'delivery', id, courier: 'econt', officeId: 'econt:1127' }) }), res);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(json(res).order.officeId, 'econt:1127');
});
