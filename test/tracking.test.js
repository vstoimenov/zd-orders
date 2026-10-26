import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeReq, fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { insertOrder, listOrders } from '../lib/orders-repo.js';
import { signSession } from '../lib/auth.js';
import { saveEcont, syncEcontStatuses, syncShopStatuses, cancelWaybill } from '../lib/waybills.js';
import ordersApi from '../lib/admin/orders.js';
import router from '../api/admin/[route].js';

process.env.INTEGRATIONS_SECRET = 'test-secret';
process.env.ADMIN_SECRET = 'secret';
process.env.PUBLIC_BASE_URL = 'https://app.ordyx.eu';
const SHOP = '00000000-0000-4000-8000-000000000001';
const owner = `zdo_admin=${signSession('secret')}`;
const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });

let q;
beforeEach(async () => {
  q = await makeTestQuery(); setQueryForTests(q);
  await q(`update zd.shops set domain = 'adhdbg.eu', name = 'ADHD магазин', phone = '0888 111 222' where id = $1`, [SHOP]);
  await q(`insert into zd.offices (id, courier, code, name, city, address, lat, lng, hours) values
    ('econt:1107', 'econt', '1107', 'Офис Младост', 'София', 'бул. Ал. Малинов 1', null, null, ''),
    ('econt:1127', 'econt', '1127', 'Плевен Център', 'Плевен', 'ул. Васил Левски 5', 43.41, 24.61, 'пн–пт 09:00–18:00')`);
});

const PROFILE = { profiles: [{ client: { name: 'ЕТ Консулт', phones: ['359883525008'] }, addresses: [] }] };
/** fake Econt answering profiles and statuses; records status calls */
function econt(statusFor = () => null) {
  const calls = [];
  const impl = async (url, init) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body);
    if (path.includes('getClientProfiles')) return reply(200, PROFILE);
    if (path.includes('deleteLabels')) return reply(200, { results: [{ shipmentNum: body.shipmentNumbers[0], error: null }] });
    if (path.includes('getShipmentStatuses')) {
      calls.push(body.shipmentNumbers);
      return reply(200, { shipmentStatuses: body.shipmentNumbers.map((num) => ({ status: { shipmentNumber: num, trackingEvents: [], shortDeliveryStatus: 'В Плевен', ...(statusFor(num) || {}) } })) });
    }
    return reply(404, {});
  };
  return { calls, impl };
}
async function withFetch(impl, fn) {
  const real = globalThis.fetch, err = console.error;
  globalThis.fetch = impl; console.error = () => {};
  try { return await fn(); } finally { globalThis.fetch = real; console.error = err; }
}
const settings = { username: 'shop-user', password: 'pa55', demo: false, senderType: 'office', senderOfficeCode: '1107', senderPhone: '0888888888', payer: 'receiver', weight: '1', description: '', review: false };
const connect = () => withFetch(econt().impl, () => saveEcont(q, SHOP, settings));
async function addOrder(patch = {}) {
  return (await insertOrder(q, {
    cbOrderId: `adhdbg.eu:${Math.random()}`, name: 'Мария Иванова', phone: '0888123456', phoneNorm: '+359888123456', email: 'm@x.bg',
    deliveryType: 'econt_office', courier: 'econt', officeId: 'econt:1127', officeText: 'ЕКОНТ – офис Плевен Център (1127), ул. Васил Левски 5', city: 'Плевен', postCode: '5800',
    addressText: '', items: [{ name: 'Книга', qty: 1, price: 20 }], total: 22.57, currency: 'EUR', paymentMethod: 'cod', pageUrl: '', ip: '1', shopId: SHOP, ...patch,
  })).id;
}
/** shipped with a live Econt waybill, last checked long ago */
async function ship(id, patch = '', checked = "now() - interval '2 hours'") {
  await q(`update zd.orders set status = 'shipped', status_changed_at = now() - interval '1 day', waybill_number = '1055278971773', waybill_courier = 'econt',
    waybill_created_at = now() - interval '1 day', waybill_checked_at = ${checked}, waybill_status = 'Приета' ${patch} where id = $1::uuid`, [id]);
}
const call = async ({ method = 'GET', url, cookie, body }) => {
  const res = fakeRes();
  await router({ method, url, headers: cookie ? { cookie } : {}, body: body === undefined ? undefined : JSON.stringify(body), socket: {} }, res);
  return res;
};
const tokenFor = async (id) => new URL(json(await call({ method: 'POST', url: `/api/admin/confirmadmin?shop=${SHOP}`, cookie: owner, body: { action: 'link', id } })).link).searchParams.get('t');
const page = async (t) => json(await call({ url: `/api/admin/confirm?t=${t}` }));
const stepsOf = (p) => Object.fromEntries(p.tracking.steps.map((s) => [s.key, s.done]));

test('a new order shows the first step done and the rest to come; the shop phone is there, no customer phone or street', async () => {
  const p = await page(await tokenFor(await addOrder()));
  assert.equal(p.canAnswer, true);
  assert.equal(p.tracking.stage, 'placed');
  assert.deepEqual(stepsOf(p), { placed: true, confirmed: false, packed: false, shipped: false, at_office: false, delivered: false });
  assert.equal(p.tracking.shopPhone, '0888 111 222');
  const text = JSON.stringify(p);
  assert.ok(!text.includes('0888123456') && !text.includes('+359888123456') && !text.includes('m@x.bg')); // the office's own address is public
});

test('a shipped order: courier, number, tracking link, courier text; packing implied when the shop skipped it', async () => {
  await connect();
  const id = await addOrder();
  await q(`update zd.orders set confirm_answer = 'yes', confirm_answered_at = now() - interval '2 days' where id = $1::uuid`, [id]);
  await ship(id, '', 'now()');
  const p = await page(await tokenFor(id));
  assert.equal(p.canAnswer, false);
  assert.equal(p.tracking.stage, 'shipped');
  assert.deepEqual(stepsOf(p), { placed: true, confirmed: true, packed: true, shipped: true, at_office: false, delivered: false });
  assert.equal(p.tracking.steps.find((s) => s.key === 'packed').at, null);
  assert.ok(p.tracking.steps.find((s) => s.key === 'shipped').at);
  assert.equal(p.tracking.courier, 'econt');
  assert.equal(p.tracking.courierName, 'Еконт');
  assert.equal(p.tracking.number, '1055278971773');
  assert.equal(p.tracking.trackUrl, 'https://www.econt.com/services/track-shipment/1055278971773');
  assert.equal(p.tracking.courierText, 'Приета');
  assert.deepEqual(p.items, [{ name: 'Книга', qty: 1 }]);
});

test('waiting at the office: the office with its address, hours and coordinates', async () => {
  await connect();
  const id = await addOrder();
  await ship(id, `, waybill_at_office_since = now() - interval '2 days'`, 'now()');
  const p = await page(await tokenFor(id));
  assert.equal(p.tracking.stage, 'at_office');
  assert.ok(p.tracking.atOfficeSince);
  assert.deepEqual(p.tracking.office, { name: 'Плевен Център', city: 'Плевен', address: 'ул. Васил Левски 5', hours: 'пн–пт 09:00–18:00', lat: 43.41, lng: 24.61 });
});

test('delivered, cancelled and returned are final stages', async () => {
  const d = await addOrder();
  await q(`update zd.orders set status = 'delivered', status_changed_at = now() where id = $1::uuid`, [d]);
  const pd = await page(await tokenFor(d));
  assert.equal(pd.tracking.stage, 'delivered');
  assert.equal(stepsOf(pd).delivered, true);
  const c = await addOrder();
  await q(`update zd.orders set status = 'cancelled' where id = $1::uuid`, [c]);
  assert.equal((await page(await tokenFor(c))).tracking.stage, 'cancelled');
  const r = await addOrder();
  await q(`update zd.orders set status = 'returned' where id = $1::uuid`, [r]);
  assert.equal((await page(await tokenFor(r))).tracking.stage, 'returned');
});

test('address delivery has no office step and no office', async () => {
  const id = await addOrder({ deliveryType: 'speedy_address', courier: 'speedy', officeId: '', officeText: 'СПИДИ – адрес: ул. Тайна 5', city: 'Варна', addressText: 'ул. Тайна 5' });
  const p = await page(await tokenFor(id));
  assert.equal(p.tracking.steps.some((s) => s.key === 'at_office'), false);
  assert.equal(p.tracking.office, null);
  assert.ok(!JSON.stringify(p).includes('Тайна'));
});

test('opening the page asks the courier once per 30 minutes and keeps its text', async () => {
  await connect();
  const id = await addOrder();
  await ship(id);
  const t = await tokenFor(id);
  const f = econt(() => ({ shortDeliveryStatus: 'Пристигнала в Плевен' }));
  const first = await withFetch(f.impl, () => page(t));
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0], ['1055278971773']);
  assert.equal(first.tracking.courierText, 'Пристигнала в Плевен');
  await withFetch(f.impl, () => page(t));
  assert.equal(f.calls.length, 1, 'checked a moment ago');
  const [o] = await q(`select waybill_status_changed_at is not null as moved from zd.orders where id = $1::uuid`, [id]);
  assert.equal(o.moved, true);
});

test('the fresh check moves a delivered parcel at once', async () => {
  await connect();
  const id = await addOrder();
  await ship(id);
  const f = econt(() => ({ deliveryTime: 1, shortDeliveryStatus: 'Доставена' }));
  const p = await withFetch(f.impl, async () => page(await tokenFor(id)));
  assert.equal(p.tracking.stage, 'delivered');
});

test('test waybills are never checked; a courier failure still shows the page', async () => {
  await connect();
  const demo = await addOrder();
  await ship(demo, `, waybill_demo = true`);
  const f = econt(() => { throw new Error('must not be called'); });
  assert.equal((await withFetch(f.impl, async () => page(await tokenFor(demo)))).tracking.stage, 'shipped');
  assert.equal(f.calls.length, 0);
  const live = await addOrder();
  await ship(live);
  const down = { impl: async () => { throw new TypeError('fetch failed'); } };
  const p = await withFetch(down.impl, async () => page(await tokenFor(live)));
  assert.equal(p.tracking.stage, 'shipped');
  assert.equal(p.tracking.courierText, 'Приета');
});

test('the night check leaves the movement time alone when the courier text did not change', async () => {
  await connect();
  const id = await addOrder();
  await ship(id);
  await q(`update zd.orders set waybill_status = 'В Плевен', waybill_status_changed_at = now() - interval '5 days' where id = $1::uuid`, [id]);
  await withFetch(econt().impl, () => syncEcontStatuses(q, SHOP));
  const [o] = await q(`select (now() - waybill_status_changed_at) > interval '4 days' as old from zd.orders where id = $1::uuid`, [id]);
  assert.equal(o.old, true);
});

test('the shop gets a tracking message with the short link once the order has a waybill', async () => {
  const id = await addOrder();
  const before = await call({ method: 'POST', url: `/api/admin/confirmadmin?shop=${SHOP}`, cookie: owner, body: { action: 'track', id } });
  assert.equal(before.statusCode, 400);
  assert.match(json(before).error, /товарителница/);
  await ship(id);
  const r = json(await call({ method: 'POST', url: `/api/admin/confirmadmin?shop=${SHOP}`, cookie: owner, body: { action: 'track', id } }));
  assert.match(r.link, /^https:\/\/app\.ordyx\.eu\/p\/[A-Za-z0-9_-]{30,64}$/);
  assert.equal(r.message, `Здравейте, Мария! Поръчката Ви от ADHD магазин е изпратена с Еконт (1055278971773). Проследете я тук: ${r.link}`);
  assert.match(r.whatsapp, /^https:\/\/wa\.me\/359888123456\?text=/);
  const t = r.link.split('/p/')[1];
  assert.equal((await page(t)).tracking.number, '1055278971773');
});

/* ---- the shop's problem parcels ---- */
async function listAs(status) {
  const res = fakeRes();
  await ordersApi(fakeReq({ url: `/api/admin/orders?shop=${SHOP}${status ? `&status=${status}` : ''}`, headers: { cookie: owner } }), res);
  return json(res);
}

// n calendar days back in Sofia at midday (SQL): now() minus n×24 h lands on another date around a clock change
const sofiaDaysAgo = (n) => `((((now() at time zone 'Europe/Sofia')::date - ${n}) + time '12:00') at time zone 'Europe/Sofia')`;
test('problem parcels: 3+ days at the office or 3+ days without movement; counted next to the pills', async () => {
  const office = await addOrder();
  await ship(office, `, waybill_at_office_since = ${sofiaDaysAgo(4)}`);
  const quiet = await addOrder();
  await ship(quiet, `, waybill_status_changed_at = ${sofiaDaysAgo(4)}`);
  await q(`update zd.orders set waybill_created_at = ${sofiaDaysAgo(6)} where id = $1::uuid`, [quiet]);
  const fresh = await addOrder();
  await ship(fresh, `, waybill_status_changed_at = ${sofiaDaysAgo(1)}`);
  const demo = await addOrder();
  await ship(demo, `, waybill_demo = true, waybill_status_changed_at = ${sofiaDaysAgo(9)}`);
  const list = await listAs('problems');
  assert.deepEqual(list.orders.map((o) => o.id).sort(), [office, quiet].sort());
  assert.equal(list.problems, 2);
  assert.equal(list.orders.find((o) => o.id === quiet).quietDays, 4);
  assert.equal((await listAs('')).problems, 2);
});

test('"Обнови статусите" checks the shop\'s shipped parcels now', async () => {
  await connect();
  const id = await addOrder();
  await ship(id);
  const f = econt(() => ({ deliveryTime: 1, shortDeliveryStatus: 'Доставена' }));
  const res = fakeRes();
  await withFetch(f.impl, () => ordersApi(fakeReq({ method: 'POST', url: `/api/admin/orders?shop=${SHOP}`, headers: { cookie: owner }, body: JSON.stringify({ action: 'refresh_statuses' }) }), res));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(json(res), { ok: true, checked: 1, delivered: 1, returned: 0, errors: [], skipped: [] });
  assert.equal((await listOrders(q)).rows.find((o) => o.id === id).status, 'delivered');
});

/* ---- review fixes ---- */
test('a failing courier is not asked again for 30 minutes, and parallel opens ask once', async () => {
  await connect();
  const id = await addOrder();
  await ship(id);
  const t = await tokenFor(id);
  let calls = 0;
  const down = async (url) => { if (String(url).includes('getShipmentStatuses')) calls++; throw new TypeError('fetch failed'); };
  await withFetch(down, () => page(t));
  await withFetch(down, () => page(t));
  assert.equal(calls, 1, 'the failed check still waits out the 30 minutes');
  const other = await addOrder();
  await ship(other);
  const t2 = await tokenFor(other);
  const f = econt();
  await withFetch(f.impl, () => Promise.all([page(t2), page(t2), page(t2)]));
  assert.equal(f.calls.length, 1);
});

test('shop notes kept in the courier text (drop it in a locker, order a pickup) stay for the shop and never reach the buyer', async () => {
  await connect();
  const id = await addOrder();
  const note = 'Куриер не е поръчан — поръчайте вземане в MySpeedy';
  await ship(id);
  await q(`update zd.orders set waybill_status = $2 where id = $1::uuid`, [id, note]);
  const p = await withFetch(econt(() => ({ shortDeliveryStatus: 'Приета в офис' })).impl, async () => page(await tokenFor(id)));
  assert.equal(p.tracking.courierText, '');
  assert.equal((await q(`select waybill_status from zd.orders where id = $1::uuid`, [id]))[0].waybill_status, note);
  await withFetch(econt(() => ({ shortDeliveryStatus: 'Приета в офис' })).impl, () => syncEcontStatuses(q, SHOP));
  assert.equal((await q(`select waybill_status from zd.orders where id = $1::uuid`, [id]))[0].waybill_status, note);
});

test('a test waybill on a real order is not shown to the buyer and gets no tracking message', async () => {
  const id = await addOrder();
  await q(`update zd.orders set waybill_number = '1051604331075', waybill_courier = 'econt', waybill_demo = true, waybill_created_at = now() where id = $1::uuid`, [id]);
  const p = await page(await tokenFor(id));
  assert.equal(p.tracking.stage, 'placed');
  assert.equal(p.tracking.number, '');
  const r = await call({ method: 'POST', url: `/api/admin/confirmadmin?shop=${SHOP}`, cookie: owner, body: { action: 'track', id } });
  assert.equal(r.statusCode, 400);
});

test('a cancelled waybill forgets its office day and movement time', async () => {
  await connect();
  const id = await addOrder();
  await ship(id, `, waybill_at_office_since = now() - interval '5 days', waybill_status_changed_at = now() - interval '5 days'`);
  await withFetch(econt().impl, () => cancelWaybill(q, { orderId: id, scopeShopId: SHOP }));
  const [o] = await q(`select waybill_at_office_since, waybill_status_changed_at from zd.orders where id = $1::uuid`, [id]);
  assert.equal(o.waybill_at_office_since, null);
  assert.equal(o.waybill_status_changed_at, null);
});

test('"Обнови статусите" stops starting couriers after its time budget and says which were skipped', async () => {
  await connect();
  const id = await addOrder();
  await ship(id);
  const f = econt();
  const r = await withFetch(f.impl, () => syncShopStatuses(q, SHOP, { deadline: Date.now() - 1 }));
  assert.equal(f.calls.length, 0);
  assert.deepEqual(r, { checked: 0, delivered: 0, returned: 0, errors: [], skipped: ['Еконт'] });
});
