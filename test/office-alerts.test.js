// Parcels waiting at the office: the morning push to the shop, the reminder the shop sends by hand, and the push when a parcel comes back.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { insertOrder } from '../lib/orders-repo.js';
import { signSession } from '../lib/auth.js';
import { saveEcont, syncEcontStatuses, officeAlerts } from '../lib/waybills.js';
import { saveSubscription, setPushSenderForTests } from '../lib/push.js';
import router from '../api/admin/[route].js';

process.env.INTEGRATIONS_SECRET = 'test-secret';
process.env.ADMIN_SECRET = 'secret';
process.env.PUBLIC_BASE_URL = 'https://app.ordyx.eu';
process.env.VAPID_PUBLIC_KEY = 'B'; process.env.VAPID_PRIVATE_KEY = 'p';
const SHOP = '00000000-0000-4000-8000-000000000001';
const SHOP_B = '00000000-0000-4000-8000-0000000000b2';
const owner = `zdo_admin=${signSession('secret')}`;
const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });

let q, sent;
beforeEach(async () => {
  q = await makeTestQuery(); setQueryForTests(q);
  await q(`update zd.shops set domain = 'adhdbg.eu', name = 'ADHD магазин' where id = $1`, [SHOP]);
  await q(`insert into zd.shops (id, name, domain, approved) values ($1, 'Магазин Б', 'b-shop.bg', true)`, [SHOP_B]);
  sent = [];
  setPushSenderForTests(async (s, payload) => { sent.push(JSON.parse(payload)); return { statusCode: 201 }; });
  await q(`insert into zd.offices (id, courier, code, name, city) values ('econt:1107', 'econt', '1107', 'Офис Младост', 'София')`);
  await saveSubscription(q, { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/owner', keys: { p256dh: 'p', auth: 'a' } }, shopId: null });
});

function econt(statusFor = () => null) {
  return async (url, init) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body);
    if (path.includes('getClientProfiles')) return reply(200, { profiles: [{ client: { name: 'ЕТ', phones: ['359883525008'] }, addresses: [] }] });
    if (path.includes('getMyAWB')) return reply(200, { results: [], page: 1, totalPages: 1 });
    if (path.includes('getShipmentStatuses')) {
      return reply(200, { shipmentStatuses: body.shipmentNumbers.map((num) => ({ status: { shipmentNumber: num, trackingEvents: [], shortDeliveryStatus: 'В Плевен', ...(statusFor(num) || {}) } })) });
    }
    return reply(404, {});
  };
}
async function withFetch(impl, fn) {
  const real = globalThis.fetch, err = console.error;
  globalThis.fetch = impl; console.error = () => {};
  try { return await fn(); } finally { globalThis.fetch = real; console.error = err; }
}
const settings = { username: 'shop-user', password: 'pa55', demo: false, senderType: 'office', senderOfficeCode: '1107', senderPhone: '0888888888', payer: 'receiver', weight: '1', description: '', review: false };
async function addOrder(patch = {}) {
  return (await insertOrder(q, {
    cbOrderId: `adhdbg.eu:${Math.random()}`, name: 'Мария Иванова', phone: '0888123456', phoneNorm: '+359888123456', email: '',
    deliveryType: 'econt_office', courier: 'econt', officeId: 'econt:1127', officeText: 'ЕКОНТ – офис Плевен Център (1127), ул. Васил Левски 5', city: 'Плевен', postCode: '5800',
    addressText: '', items: [{ name: 'Книга', qty: 1, price: 20 }], total: 22.57, currency: 'EUR', paymentMethod: 'cod', pageUrl: '', ip: '1', shopId: SHOP, ...patch,
  })).id;
}
const sofiaDaysAgo = (n) => `((((now() at time zone 'Europe/Sofia')::date - ${n}) + time '12:00') at time zone 'Europe/Sofia')`;
async function ship(id, patch = '', number = '1055278971773', courier = 'econt') {
  await q(`update zd.orders set status = 'shipped', waybill_number = $2, waybill_courier = $3, waybill_created_at = now() - interval '5 days',
    waybill_checked_at = now() - interval '2 hours', waybill_status = 'В офис' ${patch} where id = $1::uuid`, [id, number, courier]);
}
const remind = async (id) => {
  const res = fakeRes();
  await router({ method: 'POST', url: `/api/admin/confirmadmin?shop=${SHOP}`, headers: { cookie: owner }, body: JSON.stringify({ action: 'remind', id }), socket: {} }, res);
  return res;
};

test('the shop reminds the customer by hand: the office, the days it waits and the tracking link', async () => {
  const id = await addOrder();
  await ship(id, `, waybill_at_office_since = ${sofiaDaysAgo(2)}`);
  const r = json(await remind(id));
  assert.match(r.link, /^https:\/\/app\.ordyx\.eu\/p\//);
  assert.equal(r.message, `Здравейте, Мария! Пратката Ви от ADHD магазин (Еконт, 1055278971773) Ви чака в офис Плевен Център (1127), ул. Васил Левски 5 от 3 дни. Моля, вземете я, преди да бъде върната на подателя. Подробности: ${r.link}`);
  assert.match(r.whatsapp, /^https:\/\/wa\.me\/359888123456\?text=/);
  assert.equal(sent.length, 0, 'nothing is sent by Ordyx itself');
  const locker = await addOrder({ deliveryType: 'boxnow_locker', courier: 'boxnow', officeId: 'boxnow:4', officeText: 'BOX NOW – автомат Лидл Плевен, ул. Дойран 2' });
  await ship(locker, `, waybill_at_office_since = ${sofiaDaysAgo(0)}`, '9001', 'boxnow');
  assert.match(json(await remind(locker)).message, /\(BOX NOW, 9001\) Ви чака в автомат Лидл Плевен, ул\. Дойран 2 от днес\./);
  const moving = await addOrder();
  await ship(moving);
  const no = await remind(moving);
  assert.equal(no.statusCode, 400);
  assert.match(json(no).error, /не чака в офис/);
});

test('every morning each shop hears how many parcels wait at the office since the 4th day; none → no message', async () => {
  const due = await addOrder();
  await ship(due, `, waybill_at_office_since = ${sofiaDaysAgo(3)}`);
  const due2 = await addOrder();
  await ship(due2, `, waybill_at_office_since = ${sofiaDaysAgo(6)}`, '2');
  const early = await addOrder();
  await ship(early, `, waybill_at_office_since = ${sofiaDaysAgo(1)}`, '3');
  const r = await officeAlerts(q);
  assert.deepEqual(r, { 'adhdbg.eu': 2 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, '📦 2 пратки чакат в офиса от 4+ дни');
  assert.match(sent[0].body, /звъннете|напомнете/);
});

test('a parcel that comes back: the shop hears it at once', async () => {
  await withFetch(econt(), () => saveEcont(q, SHOP, settings));
  const id = await addOrder();
  await ship(id);
  const ok = await addOrder();
  await ship(ok, '', '2222');
  const r = await withFetch(econt((num) => (num === '1055278971773' ? { trackingEvents: [{ destinationType: 'return' }] } : null)), () => syncEcontStatuses(q, SHOP));
  assert.equal(r.returned, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, '↩️ Пратката се върна');
  assert.match(sent[0].body, /Мария Иванова/);
  await withFetch(econt((num) => (num === '1055278971773' ? { trackingEvents: [{ destinationType: 'return' }] } : null)), () => syncEcontStatuses(q, SHOP));
  assert.equal(sent.length, 1, 'only once');
});
