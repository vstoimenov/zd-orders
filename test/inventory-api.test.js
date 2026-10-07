import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeReq, fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { signSession } from '../lib/auth.js';
import router from '../api/admin/[route].js';

process.env.ADMIN_SECRET = 'secret';
let q;
beforeEach(async () => { q = await makeTestQuery(); setQueryForTests(q); });
const headers = { cookie: `zdo_admin=${signSession('secret')}` };
const call = async (opts) => { const res = fakeRes(); await router(fakeReq({ url: '/api/admin/inventory', ...opts }), res); return res; };
const post = (body) => call({ method: 'POST', headers, body: JSON.stringify(body) });

test('inventory needs the admin cookie', async () => {
  assert.equal((await call({})).statusCode, 401);
});

test('create, edit, adjust and history through the admin API', async () => {
  let res = await post({ action: 'save', create: true, name: 'Книга', sku: 'BK-1', stock: 10, lowStock: 3, unitCost: 4.2 });
  assert.deepEqual([res.statusCode, json(res).ok], [200, true]);
  res = await post({ action: 'save', create: true, name: 'книга' });
  assert.equal(res.statusCode, 400);
  assert.match(json(res).error, /вече съществува/);
  res = await post({ action: 'adjust', name: 'Книга', delta: 5, reason: 'Доставка', note: 'от печатница' });
  assert.deepEqual(json(res), { ok: true, stock: 15 });
  res = await post({ action: 'save', name: 'Книга', sku: 'BK-1', stock: 14, lowStock: 3, unitCost: 4.2 });
  assert.equal(res.statusCode, 200);
  res = await call({ headers });
  assert.deepEqual(json(res).cards, { products: 1, totalStock: 14, low: 0, out: 0 });
  assert.deepEqual(json(res).products[0], { name: 'Книга', sku: 'BK-1', stock: 14, lowStock: 3, unitCost: 4.2, sold30: 0, state: 'ok' });
  res = await call({ url: `/api/admin/inventory?history=${encodeURIComponent('Книга')}`, headers });
  assert.deepEqual(json(res).moves.map((m) => [m.qty, m.note]), [[-1, 'Ръчно задаване'], [5, 'Доставка: от печатница'], [10, 'Начална наличност']]);
  res = await post({ action: 'nope' });
  assert.equal(res.statusCode, 400);
});
