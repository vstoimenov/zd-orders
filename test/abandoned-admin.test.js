import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { signSession } from '../lib/auth.js';
import { createClient, acceptInvite, clientSession } from '../lib/users.js';
import { captureCart } from '../lib/abandoned.js';
import router from '../api/admin/[route].js';

process.env.ADMIN_SECRET = 'secret';
const SHOP = '00000000-0000-4000-8000-000000000001';
const owner = `zdo_admin=${signSession('secret')}`;
let q, cartId;
const call = async ({ method = 'GET', url, cookie, body }) => {
  const res = fakeRes();
  await router({ method, url, headers: cookie ? { cookie } : {}, body: body === undefined ? undefined : JSON.stringify(body), socket: {} }, res);
  return res;
};

beforeEach(async () => {
  q = await makeTestQuery(); setQueryForTests(q);
  await q(`update zd.shops set domain = 'a-shop.bg', name = 'Магазин А' where id = $1`, [SHOP]);
  ({ id: cartId } = await captureCart(q, { shopId: SHOP, phone: '0888123456', name: 'Мария Иванова', items: [{ name: 'Книга', qty: 1, price: 20 }], total: 22.57, currency: 'EUR', pageUrl: 'https://a-shop.bg/c' }));
  await q(`update zd.abandoned_carts set created_at = now() - interval '1 hour', updated_at = now() - interval '1 hour'`);
});

test('the owner lists open carts and gets reminder links', async () => {
  const list = json(await call({ url: `/api/admin/abandoned?shop=${SHOP}`, cookie: owner }));
  assert.equal(list.carts.length, 1);
  assert.equal(list.openCount, 1);
  assert.equal(list.settings.code, '');
  assert.deepEqual(json(await call({ url: `/api/admin/abandoned?shop=${SHOP}&count=1`, cookie: owner })), { openCount: 1 });
  const r = await call({ method: 'POST', url: `/api/admin/abandoned?shop=${SHOP}`, cookie: owner, body: { action: 'links', id: cartId, kind: 'plain' } });
  assert.equal(r.statusCode, 200);
  assert.match(json(r).whatsapp, /^https:\/\/wa\.me\/359888123456\?text=/);
  assert.equal(json(await call({ url: `/api/admin/abandoned?shop=${SHOP}`, cookie: owner })).carts[0].state, 'open', 'looking at the text marks nothing');
  assert.equal((await call({ method: 'POST', url: `/api/admin/abandoned?shop=${SHOP}`, cookie: owner, body: { action: 'mark', id: cartId, channel: 'whatsapp' } })).statusCode, 200);
  const after = json(await call({ url: `/api/admin/abandoned?shop=${SHOP}`, cookie: owner }));
  assert.equal(after.carts[0].state, 'reminded');
  assert.equal(after.openCount, 0);
  assert.equal((await call({ method: 'POST', url: `/api/admin/abandoned?shop=${SHOP}`, cookie: owner, body: { action: 'hide', id: cartId } })).statusCode, 200);
  assert.equal(json(await call({ url: `/api/admin/abandoned?shop=${SHOP}&state=hidden`, cookie: owner })).carts.length, 1);
});

test('a client sees and acts only on its own shops', async () => {
  const [{ id: other }] = await q(`insert into zd.shops (name, domain) values ('Б', 'b-shop.bg') returning id`);
  const { id, token } = await createClient(q, { email: 'c@x.bg', shopIds: [other] });
  const u = await acceptInvite(q, token, 'client-pass-1');
  const c = `zdo_admin=${clientSession('secret', { id, session_version: u.session_version })}`;
  assert.deepEqual(json(await call({ url: `/api/admin/abandoned?shop=${SHOP}`, cookie: c })).carts, []);
  assert.deepEqual(json(await call({ url: '/api/admin/abandoned?shop=all', cookie: c })).carts, []);
  for (const body of [{ action: 'links', id: cartId, kind: 'plain' }, { action: 'mark', id: cartId, channel: 'sms' }, { action: 'hide', id: cartId }]) {
    const r = await call({ method: 'POST', url: `/api/admin/abandoned?shop=${other}`, cookie: c, body });
    assert.equal(r.statusCode, 404);
    assert.equal(json(r).error, 'Няма такава количка');
  }
  const [row] = await q(`select reminded_at, hidden_at from zd.abandoned_carts`);
  assert.deepEqual([row.reminded_at, row.hidden_at], [null, null]);
});

test('settings are per shop and refused for all shops', async () => {
  const ok = await call({ method: 'POST', url: `/api/admin/abandoned?shop=${SHOP}`, cookie: owner, body: { action: 'settings', plain: 'Здравейте {име} {линк}', discount: '{код}', code: 'A10', discountText: '10%' } });
  assert.equal(ok.statusCode, 200);
  assert.equal(json(await call({ url: `/api/admin/abandoned?shop=${SHOP}`, cookie: owner })).settings.code, 'A10');
  const all = await call({ method: 'POST', url: '/api/admin/abandoned?shop=all', cookie: owner, body: { action: 'settings', plain: 'x', discount: '{код}', code: 'A', discountText: '' } });
  assert.equal(all.statusCode, 400);
  assert.equal(json(await call({ url: '/api/admin/abandoned?shop=all', cookie: owner })).settings, null);
  const bad = await call({ method: 'POST', url: `/api/admin/abandoned?shop=${SHOP}`, cookie: owner, body: { action: 'settings', plain: 'x', discount: 'без', code: 'A1', discountText: '' } });
  assert.equal(bad.statusCode, 400);
  assert.match(json(bad).error, /\{код\}/);
});

test('without login 401', async () => {
  assert.equal((await call({ url: `/api/admin/abandoned?shop=${SHOP}` })).statusCode, 401);
  assert.equal((await call({ method: 'POST', url: `/api/admin/abandoned?shop=${SHOP}`, body: { action: 'hide', id: cartId } })).statusCode, 401);
});
