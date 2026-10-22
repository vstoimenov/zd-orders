import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { insertOrder, listOrders } from '../lib/orders-repo.js';
import { signSession } from '../lib/auth.js';
import { createClient, acceptInvite, clientSession } from '../lib/users.js';
import { saveSubscription, setPushSenderForTests } from '../lib/push.js';
import router from '../api/admin/[route].js';

process.env.ADMIN_SECRET = 'secret';
process.env.PUBLIC_BASE_URL = 'https://kurier.profitbrand.online';
process.env.VAPID_PUBLIC_KEY = 'B'; process.env.VAPID_PRIVATE_KEY = 'p';
const SHOP = '00000000-0000-4000-8000-000000000001';
const owner = `zdo_admin=${signSession('secret')}`;
let q, orderId, sent;
const call = async ({ method = 'GET', url, cookie, body }) => {
  const res = fakeRes();
  await router({ method, url, headers: cookie ? { cookie } : {}, body: body === undefined ? undefined : JSON.stringify(body), socket: {} }, res);
  return res;
};
const linkFor = async (id, cookie = owner) => call({ method: 'POST', url: `/api/admin/confirmadmin?shop=${SHOP}`, cookie, body: { action: 'link', id } });
const tokenOf = (link) => new URL(link).searchParams.get('t');

beforeEach(async () => {
  q = await makeTestQuery(); setQueryForTests(q);
  await q(`update zd.shops set domain = 'a-shop.bg', name = 'Магазин А' where id = $1`, [SHOP]);
  orderId = (await insertOrder(q, {
    cbOrderId: 'a-shop.bg:7', name: 'Мария Иванова', phone: '0888 123 456', phoneNorm: '+359888123456', email: '', deliveryType: 'econt_office', courier: 'econt',
    officeId: 'econt:1', officeText: 'ЕКОНТ – офис Плевен (5803), ул. Х', city: 'Плевен', postCode: '5800', addressText: '', items: [{ name: 'Книга', qty: 2, price: 20 }],
    total: 22.57, currency: 'EUR', paymentMethod: 'cod', pageUrl: '', ip: '1', shopId: SHOP,
  })).id;
  sent = [];
  setPushSenderForTests(async (s, payload) => { sent.push(JSON.parse(payload)); return { statusCode: 201 }; });
  await saveSubscription(q, { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/owner', keys: { p256dh: 'p', auth: 'a' } }, shopId: null });
});

test('the admin gets a WhatsApp message with the customer\'s personal confirmation link (same link every time)', async () => {
  const res = await linkFor(orderId);
  assert.equal(res.statusCode, 200);
  const d = json(res);
  assert.match(d.link, /^https:\/\/kurier\.profitbrand\.online\/confirm\/\?t=[A-Za-z0-9_-]{30,}$/);
  assert.match(d.message, /^Здравейте, Мария!/);
  assert.ok(d.message.includes(d.link));
  assert.ok(d.message.includes('22,57 €'));
  assert.equal(d.whatsapp, `https://wa.me/359888123456?text=${encodeURIComponent(d.message)}`);
  assert.equal(d.sms, `sms:+359888123456?&body=${encodeURIComponent(d.message)}`);
  assert.equal(json(await linkFor(orderId)).link, d.link);
  const [o] = (await listOrders(q)).rows;
  assert.deepEqual(o.confirmation, { sent: true, answer: '', answeredAt: null });
});

test('the customer opens the link, sees the order and confirms it: the order is confirmed and the shop hears about it', async () => {
  const t = tokenOf(json(await linkFor(orderId)).link);
  const page = json(await call({ url: `/api/admin/confirm?t=${t}` }));
  const { tracking, createdAt, ...rest } = page;
  assert.deepEqual(rest, {
    ok: true, shop: 'Магазин А', name: 'Мария', items: [{ name: 'Книга', qty: 2 }], total: 22.57, currency: 'EUR', cod: true,
    delivery: 'ЕКОНТ – офис Плевен (5803)', answer: '', canAnswer: true,
  });
  assert.ok(createdAt);
  assert.equal(tracking.stage, 'placed');
  assert.ok(!JSON.stringify(page).includes('888'), 'no phone on the public page');
  const res = await call({ method: 'POST', url: '/api/admin/confirm', body: { t, answer: 'yes' } });
  assert.equal(res.statusCode, 200);
  const [o] = (await listOrders(q)).rows;
  assert.equal(o.status, 'confirmed');
  assert.equal(o.confirmation.answer, 'yes');
  assert.match(sent.at(-1).title, /потвърди/);
  assert.match(sent.at(-1).body, /Мария Иванова/);
});

test('the customer may cancel; after shipping nothing changes any more', async () => {
  const t = tokenOf(json(await linkFor(orderId)).link);
  await call({ method: 'POST', url: '/api/admin/confirm', body: { t, answer: 'no' } });
  let [o] = (await listOrders(q)).rows;
  assert.equal(o.status, 'cancelled');
  assert.match(sent.at(-1).title, /отказа/);
  await q(`update zd.orders set status = 'shipped' where id = $1`, [orderId]);
  const late = await call({ method: 'POST', url: '/api/admin/confirm', body: { t, answer: 'yes' } });
  assert.equal(late.statusCode, 400);
  assert.match(json(late).error, /изпратена/);
  assert.equal(json(await call({ url: `/api/admin/confirm?t=${t}` })).canAnswer, false);
  [o] = (await listOrders(q)).rows;
  assert.equal(o.status, 'shipped');
});

test('a wrong link shows nothing; a client cannot make links for another shop\'s orders', async () => {
  assert.equal((await call({ url: '/api/admin/confirm?t=' + 'x'.repeat(32) })).statusCode, 404);
  assert.equal((await call({ method: 'POST', url: '/api/admin/confirm', body: { t: 'nope', answer: 'yes' } })).statusCode, 404);
  const [{ id: other }] = await q(`insert into zd.shops (name, domain) values ('Б', 'b-shop.bg') returning id`);
  const { id, token } = await createClient(q, { email: 'c@x.bg', shopIds: [other] });
  const u = await acceptInvite(q, token, 'client-pass-1');
  const c = `zdo_admin=${clientSession('secret', { id, session_version: u.session_version })}`;
  const res = await call({ method: 'POST', url: `/api/admin/confirmadmin?shop=${other}`, cookie: c, body: { action: 'link', id: orderId } });
  assert.equal(res.statusCode, 404);
  assert.equal((await call({ method: 'POST', url: `/api/admin/confirmadmin?shop=${SHOP}`, body: { action: 'link', id: orderId } })).statusCode, 401);
});

test('the shop sets its own confirmation text', async () => {
  const res = await call({ method: 'POST', url: `/api/admin/confirmadmin?shop=${SHOP}`, cookie: owner, body: { action: 'template', text: 'Здрасти {име}, потвърди: {линк_потвърждение}' } });
  assert.equal(res.statusCode, 200);
  const d = json(await linkFor(orderId));
  assert.equal(d.message, `Здрасти Мария, потвърди: ${d.link}`);
  const got = json(await call({ url: `/api/admin/confirmadmin?shop=${SHOP}`, cookie: owner }));
  assert.equal(got.template, 'Здрасти {име}, потвърди: {линк_потвърждение}');
  assert.equal((await call({ method: 'POST', url: `/api/admin/confirmadmin?shop=${SHOP}`, cookie: owner, body: { action: 'template', text: 'без линк' } })).statusCode, 400);
});

/* ---- review fixes ---- */
import { answerConfirm } from '../lib/confirm.js';
import { createWaybill } from '../lib/waybills.js';

test('if the order is sent meanwhile, the customer\'s answer is refused and nobody is told it was cancelled', async () => {
  const t = tokenOf(json(await linkFor(orderId)).link);
  const real = q;
  let ships = true;
  const racing = async (text, params) => {
    if (ships && /set confirm_answer/.test(text)) { ships = false; await real(`update zd.orders set status = 'shipped' where id = $1`, [orderId]); }
    return real(text, params);
  };
  const before = sent.length;
  await assert.rejects(answerConfirm(racing, t, 'no'), /изпратена/);
  assert.equal(sent.length, before);
  const [o] = (await listOrders(q)).rows;
  assert.equal(o.status, 'shipped');
});

test('the public page shows no street address, before or after the order is closed', async () => {
  const addr = (await insertOrder(q, {
    cbOrderId: 'a-shop.bg:8', name: 'Петър Петров', phone: '0888222222', phoneNorm: '+359888222222', email: '', deliveryType: 'speedy_address', courier: 'speedy',
    officeId: '', officeText: 'СПИДИ – адрес: ул. Тайна 5, ап. 3', city: 'Варна', postCode: '9000', addressText: 'ул. Тайна 5, ап. 3', items: [{ name: 'Книга', qty: 1, price: 10 }],
    total: 10, currency: 'EUR', paymentMethod: 'cod', pageUrl: '', ip: '1', shopId: SHOP,
  })).id;
  const t = tokenOf(json(await linkFor(addr)).link);
  const page = json(await call({ url: `/api/admin/confirm?t=${t}` }));
  assert.equal(page.delivery, 'до адрес във Варна');
  assert.ok(!JSON.stringify(page).includes('Тайна'));
  const office = json(await call({ url: `/api/admin/confirm?t=${tokenOf(json(await linkFor(orderId)).link)}` }));
  assert.equal(office.delivery, 'ЕКОНТ – офис Плевен (5803)');
  await call({ method: 'POST', url: '/api/admin/confirm', body: { t, answer: 'yes' } });
  await q(`update zd.orders set status = 'shipped' where id = $1`, [addr]);
  const closed = json(await call({ url: `/api/admin/confirm?t=${t}` }));
  assert.equal(closed.canAnswer, false);
  assert.equal(closed.answer, 'yes');
  assert.equal(closed.tracking.stage, 'shipped');
  assert.ok(!JSON.stringify(closed).includes('Тайна') && !JSON.stringify(closed).includes('888'));
});

test('answering the same again does not notify again', async () => {
  const t = tokenOf(json(await linkFor(orderId)).link);
  await call({ method: 'POST', url: '/api/admin/confirm', body: { t, answer: 'yes' } });
  const n = sent.length;
  await call({ method: 'POST', url: '/api/admin/confirm', body: { t, answer: 'yes' } });
  assert.equal(sent.length, n);
});

test('a customer name with $ signs stays as written in the message', async () => {
  await q(`update zd.orders set name = 'Ана $& $$ Бойс' where id = $1`, [orderId]);
  assert.match(json(await linkFor(orderId)).message, /^Здравейте, Ана!/);
  await call({ method: 'POST', url: `/api/admin/confirmadmin?shop=${SHOP}`, cookie: owner, body: { action: 'template', text: '{пълно_име}: {линк_потвърждение}' } });
  assert.match(json(await linkFor(orderId)).message, /^Ана \$& \$\$ Бойс: /);
});

test('the confirmation text cannot be saved for "all shops"', async () => {
  const res = await call({ method: 'POST', url: '/api/admin/confirmadmin?shop=all', cookie: owner, body: { action: 'template', text: 'х {линк_потвърждение}' } });
  assert.equal(res.statusCode, 400);
});

test('a waybill is never made for an order the customer cancelled a moment ago', async () => {
  const real = q;
  let cancels = true;
  const racing = async (text, params) => {
    if (cancels && /waybill_number = 'creating'/.test(text)) { cancels = false; await real(`update zd.orders set status = 'cancelled' where id = $1`, [orderId]); }
    return real(text, params);
  };
  await q(`insert into zd.offices (id, courier, code, name, city) values ('econt:1', 'econt', '1', 'О', 'С') on conflict do nothing`);
  const { saveIntegration } = await import('../lib/integrations-repo.js');
  process.env.INTEGRATIONS_SECRET = 'x';
  await saveIntegration(q, 'econt', { config: { sender: { type: 'office', officeCode: '1', text: 'О' }, senderPhone: '0888', active: true }, secret: JSON.stringify({ username: 'u', password: 'p' }) });
  await assert.rejects(createWaybill(racing, { orderId, scopeShopId: SHOP, input: {} }), /вече се създава|отказана|за изпращане/);
  const [o] = (await listOrders(q)).rows;
  assert.equal(o.shipment, null);
});
