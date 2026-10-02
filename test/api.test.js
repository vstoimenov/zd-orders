import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeReq, fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { replaceOffices, replaceCities } from '../lib/catalog-repo.js';
import offices from '../api/offices.js';
import cities from '../api/cities.js';
import orders from '../api/orders.js';
import refresh from '../api/cron/refresh.js';

const ORIGIN = 'https://dasezaobichame.convertbuilder.com';
process.env.ALLOWED_ORIGINS = `${ORIGIN}, https://blagoslovii.com`;
process.env.ORDER_TOKEN = 'tok';
process.env.CRON_SECRET = 'cron';

let q;
beforeEach(async () => { q = await makeTestQuery(); setQueryForTests(q); });

const body = (patch = {}) => JSON.stringify({
  token: 'tok', cb_order_id: 'A1', name: 'Мария Иванова', phone: '0888123456', delivery_type: 'econt_office',
  office_id: 'econt:7538', office_text: 'ЕКОНТ – офис Айдемир (7538)', city: 'Айдемир', items: [], total: 22.57, ...patch,
});
const post = (b, headers = {}) => fakeReq({ method: 'POST', url: '/api/orders', headers: { origin: ORIGIN, 'x-forwarded-for': '9.9.9.9', ...headers }, body: b });

test('GET /api/offices returns cached Econt offices with CDN caching', async () => {
  await replaceOffices(q, 'econt', [{ id: 'econt:1', code: '1', name: 'Център', city: 'Пловдив', cityId: 1, postCode: '4000', address: 'ул. Х', isAutomat: false }]);
  const res = fakeRes();
  await offices(fakeReq({ url: '/api/offices?courier=econt', headers: { origin: ORIGIN } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(json(res).offices[0].name, 'Център');
  assert.match(res.headers['cache-control'], /s-maxage=3600/);
  assert.equal(res.headers['access-control-allow-origin'], ORIGIN);
  const bad = fakeRes();
  await offices(fakeReq({ url: '/api/offices?courier=dhl' }), bad);
  assert.equal(bad.statusCode, 400);
});

test('GET /api/cities returns cities', async () => {
  await replaceCities(q, [{ id: 1, name: 'Пловдив', postCode: '4000', region: 'Пловдив', hasOffice: true }]);
  const res = fakeRes();
  await cities(fakeReq({ url: '/api/cities' }), res);
  assert.deepEqual(json(res).cities, [{ id: 1, name: 'Пловдив', postCode: '4000', region: 'Пловдив', hasOffice: true }]);
});

test('POST /api/orders guards origin, token and fields', async () => {
  let res = fakeRes(); await orders(post(body(), { origin: 'https://evil.example' }), res);
  assert.equal(res.statusCode, 403);
  res = fakeRes(); await orders(post(body({ token: 'nope' })), res);
  assert.equal(res.statusCode, 401);
  res = fakeRes(); await orders(post(body({ phone: '1' })), res);
  assert.equal(res.statusCode, 400);
  assert.equal(json(res).error, 'invalid phone');
  res = fakeRes(); await orders(post('not json'), res);
  assert.equal(res.statusCode, 401);
});

test('POST /api/orders stores once and answers CORS preflight', async () => {
  let res = fakeRes(); await orders(post(body()), res);
  assert.deepEqual(json(res), { ok: true, inserted: true, duplicate: false });
  res = fakeRes(); await orders(post(body()), res);
  assert.deepEqual(json(res), { ok: true, inserted: false, duplicate: false });
  const [row] = await q('select ip, user_agent from zd.orders');
  assert.equal(row.ip, '9.9.9.9');
  res = fakeRes(); await orders(fakeReq({ method: 'OPTIONS', headers: { origin: ORIGIN } }), res);
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers['access-control-allow-origin'], ORIGIN);
});

test('POST /api/orders rate-limits 5 orders per IP per 10 minutes', async () => {
  for (let i = 1; i <= 5; i++) {
    const res = fakeRes(); await orders(post(body({ cb_order_id: `R${i}` })), res);
    assert.equal(res.statusCode, 200);
  }
  const res = fakeRes(); await orders(post(body({ cb_order_id: 'R6' })), res);
  assert.equal(res.statusCode, 429);
});

test('GET /api/cron/refresh requires the secret and stores Econt data', async () => {
  let res = fakeRes(); await refresh(fakeReq({ headers: {} }), res);
  assert.equal(res.statusCode, 401);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => (String(url).includes('getOffices')
      ? { offices: [{ code: '1', name: 'Център', address: { city: { id: 7, name: 'Пловдив', postCode: '4000', country: { code3: 'BGR' } }, fullAddress: 'Пловдив ул. Х 1' } }] }
      : { cities: [{ id: 7, name: 'Пловдив', postCode: '4000', regionName: 'Пловдив' }] }),
  });
  try {
    res = fakeRes(); await refresh(fakeReq({ headers: { authorization: 'Bearer cron' } }), res);
  } finally { globalThis.fetch = realFetch; }
  assert.deepEqual(json(res), { offices: { upserted: 1, removed: 0 }, cities: { upserted: 1, removed: 0 } });
  const [c] = await q('select has_office from zd.cities where id = 7');
  assert.equal(c.has_office, true);
});
