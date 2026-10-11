import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { insertOrder, saveNekorekten } from '../lib/orders-repo.js';
import { signSession } from '../lib/auth.js';
import { createClient, acceptInvite, clientSession } from '../lib/users.js';
import { renderMessage, smsInfo } from '../lib/campaigns.js';
import router from '../api/admin/[route].js';

process.env.ADMIN_SECRET = 'secret';
const SHOP = '00000000-0000-4000-8000-000000000001';
const owner = `zdo_admin=${signSession('secret')}`;
let q, SHOP_B;
const call = async ({ method = 'GET', url, cookie = owner, body }) => {
  const res = fakeRes();
  await router({ method, url, headers: { cookie }, body: body === undefined ? undefined : JSON.stringify(body), socket: {} }, res);
  return res;
};
async function order(shopId, { name, phone, status = 'delivered', product = 'Книга', daysAgo = 1 }) {
  const r = await insertOrder(q, {
    cbOrderId: `${shopId}:${Math.random()}`, name, phone, phoneNorm: `+359${phone.slice(1)}`, email: '', deliveryType: 'econt_office', courier: 'econt',
    officeId: 'econt:1', officeText: 'О', city: 'С', postCode: '', addressText: '', items: [{ name: product, qty: 1, price: 10 }], total: 10,
    currency: 'EUR', paymentMethod: 'cod', pageUrl: '', ip: '1', shopId,
  });
  await q(`update zd.orders set status = $2, created_at = now() - make_interval(days => $3) where id = $1`, [r.id, status, daysAgo]);
  return r.id;
}

beforeEach(async () => {
  q = await makeTestQuery(); setQueryForTests(q);
  await q(`update zd.shops set domain = 'a-shop.bg', name = 'Магазин А', url = 'https://a-shop.bg' where id = $1`, [SHOP]);
  [{ id: SHOP_B }] = await q(`insert into zd.shops (name, domain) values ('Б', 'b-shop.bg') returning id`);
  await order(SHOP, { name: 'Мария Иванова', phone: '0888111111', product: 'Книга „Спокойно дете“' });
  await order(SHOP, { name: 'Мария Иванова', phone: '0888111111', product: 'Карти', daysAgo: 0 }); // same person, latest product = Карти
  await order(SHOP, { name: 'Иван Петров', phone: '0888222222', status: 'returned' });
  const flagged = await order(SHOP, { name: 'Некоректен Клиент', phone: '0888333333' });
  await saveNekorekten(q, flagged, { status: 'flagged', count: 2, reportIds: [] });
  await order(SHOP, { name: 'Стара Поръчка', phone: '0888444444', daysAgo: 90 });
  await order(SHOP_B, { name: 'Чужд Клиент', phone: '0888999999' });
});

test('renderMessage fills the variables; smsInfo counts the parts (Cyrillic = 70 per part)', () => {
  const ctx = { name: 'Мария Иванова', product: 'Карти', shop: 'Магазин А', link: 'https://a-shop.bg' };
  assert.equal(renderMessage('Здравей, {име}! {продукт} от {магазин}: {линк} ({пълно_име})', ctx), 'Здравей, Мария! Карти от Магазин А: https://a-shop.bg (Мария Иванова)');
  assert.deepEqual(smsInfo('Hello there'), { encoding: 'GSM', chars: 11, parts: 1 });
  assert.deepEqual(smsInfo('a'.repeat(161)), { encoding: 'GSM', chars: 161, parts: 2 });
  assert.deepEqual(smsInfo('Здравей'), { encoding: 'UCS2', chars: 7, parts: 1 });
  assert.deepEqual(smsInfo('я'.repeat(71)), { encoding: 'UCS2', chars: 71, parts: 2 });
  assert.equal(smsInfo('').parts, 0);
});

test('preview: one person per number, delivered by default, flagged customers left out, their latest product', async () => {
  const res = await call({ method: 'POST', url: `/api/admin/campaigns?shop=${SHOP}`, body: { action: 'preview', channel: 'sms', message: 'Здравей, {име}! Хареса ли ти {продукт}?', segment: {} } });
  assert.equal(res.statusCode, 200);
  const p = json(res);
  assert.equal(p.count, 2, 'Мария + Стара Поръчка (Иван returned, the flagged one excluded, shop Б never)');
  const maria = p.sample.find((s) => s.name === 'Мария Иванова');
  assert.equal(maria.phone, '+359888111111');
  assert.equal(maria.text, 'Здравей, Мария! Хареса ли ти Карти?');
  assert.equal(p.sms.encoding, 'UCS2');
  assert.equal(p.sms.parts, 1);
  assert.equal(p.cost, 0.1, '2 people × 1 part × 0,05 €');
});

test('segment filters: statuses, period, product, minimum orders, flagged on request', async () => {
  const pv = async (segment) => json(await call({ method: 'POST', url: `/api/admin/campaigns?shop=${SHOP}`, body: { action: 'preview', channel: 'sms', message: 'х', segment } })).count;
  assert.equal(await pv({ statuses: ['returned'] }), 1);
  assert.equal(await pv({ from: new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10) }), 1, 'the 90-day-old order falls out');
  assert.equal(await pv({ product: 'карти' }), 1);
  assert.equal(await pv({ minOrders: 2 }), 1);
  assert.equal(await pv({ excludeFlagged: false }), 3);
});

test('the STOP list: opted-out numbers never get a campaign', async () => {
  await call({ method: 'POST', url: `/api/admin/campaigns?shop=${SHOP}`, body: { action: 'optout_add', phones: '0888 111 111\n+359888444444\nглупост' } });
  const list = json(await call({ method: 'POST', url: `/api/admin/campaigns?shop=${SHOP}`, body: { action: 'optouts' } })).optouts.map((o) => o.phone).sort();
  assert.deepEqual(list, ['+359888111111', '+359888444444']);
  assert.equal(json(await call({ method: 'POST', url: `/api/admin/campaigns?shop=${SHOP}`, body: { action: 'preview', channel: 'sms', message: 'х', segment: {} } })).count, 0);
  await call({ method: 'POST', url: `/api/admin/campaigns?shop=${SHOP}`, body: { action: 'optout_remove', phone: '+359888444444' } });
  assert.equal(json(await call({ method: 'POST', url: `/api/admin/campaigns?shop=${SHOP}`, body: { action: 'preview', channel: 'sms', message: 'х', segment: {} } })).count, 1);
});

test('save a campaign, list it, export the personalised list; ready/export need the consent', async () => {
  const base = { action: 'save', name: 'Благодарност', channel: 'sms', message: 'Благодарим, {име}!', segment: {} };
  assert.equal((await call({ method: 'POST', url: `/api/admin/campaigns?shop=${SHOP}`, body: { ...base, status: 'ready', consent: false } })).statusCode, 400);
  const draft = json(await call({ method: 'POST', url: `/api/admin/campaigns?shop=${SHOP}`, body: base })).campaign;
  assert.equal(draft.status, 'draft');
  assert.equal(draft.recipients, 2);
  assert.equal((await call({ url: `/api/admin/campaigns?shop=${SHOP}&export=${draft.id}` })).statusCode, 400, 'no export without consent');
  const ready = json(await call({ method: 'POST', url: `/api/admin/campaigns?shop=${SHOP}`, body: { ...base, id: draft.id, status: 'ready', consent: true } })).campaign;
  assert.equal(ready.id, draft.id);
  assert.equal(ready.status, 'ready');
  const list = json(await call({ url: `/api/admin/campaigns?shop=${SHOP}` }));
  assert.equal(list.campaigns.length, 1);
  assert.equal(list.smsPrice, 0.05);
  const csv = await call({ url: `/api/admin/campaigns?shop=${SHOP}&export=${draft.id}` });
  assert.equal(csv.statusCode, 200);
  assert.match(csv.headers['content-type'], /text\/csv/);
  assert.match(csv.body, /phone,name,message/);
  assert.match(csv.body, /\+359888111111,Мария Иванова,"?Благодарим, Мария!"?/);
  assert.equal((await call({ method: 'POST', url: `/api/admin/campaigns?shop=${SHOP}`, body: { action: 'delete', id: draft.id } })).statusCode, 200);
  assert.equal(json(await call({ url: `/api/admin/campaigns?shop=${SHOP}` })).campaigns.length, 0);
});

test('the SMS price is a shop setting', async () => {
  await call({ method: 'POST', url: `/api/admin/campaigns?shop=${SHOP}`, body: { action: 'price', smsPrice: '0,07' } });
  assert.equal(json(await call({ url: `/api/admin/campaigns?shop=${SHOP}` })).smsPrice, 0.07);
});

test('a client works only with their own shop\'s customers and campaigns', async () => {
  const { id, token } = await createClient(q, { email: 'c@x.bg', shopIds: [SHOP_B] });
  const u = await acceptInvite(q, token, 'client-pass-1');
  const c = `zdo_admin=${clientSession('secret', { id, session_version: u.session_version })}`;
  assert.equal((await call({ method: 'POST', url: `/api/admin/campaigns?shop=${SHOP}`, cookie: c, body: { action: 'preview', channel: 'sms', message: '{пълно_име}', segment: {} } })).statusCode, 400, 'shop А is refused');
  const p = json(await call({ method: 'POST', url: `/api/admin/campaigns?shop=${SHOP_B}`, cookie: c, body: { action: 'preview', channel: 'sms', message: '{пълно_име}', segment: {} } }));
  assert.deepEqual(p.sample.map((s) => s.text), ['Чужд Клиент'], 'only their own customers');
  const saved = json(await call({ method: 'POST', url: `/api/admin/campaigns?shop=${SHOP_B}`, cookie: c, body: { action: 'save', name: 'Моя', channel: 'sms', message: 'х', segment: {} } })).campaign;
  assert.equal((await call({ url: `/api/admin/campaigns?shop=${SHOP}&export=${saved.id}` })).statusCode, 400, 'the owner in another shop scope does not see it as shop А\'s');
  const own = await call({ method: 'POST', url: `/api/admin/campaigns?shop=${SHOP}`, body: { action: 'save', name: 'А', channel: 'sms', message: 'х', segment: {} } });
  const aId = json(own).campaign.id;
  assert.equal((await call({ method: 'POST', url: `/api/admin/campaigns?shop=${SHOP_B}`, cookie: c, body: { action: 'delete', id: aId } })).statusCode, 404);
  assert.equal((await call({ url: `/api/admin/campaigns?shop=all` })).statusCode, 400, 'one shop at a time');
});
