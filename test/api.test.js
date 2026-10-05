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
  assert.equal(res.headers['access-control-allow-origin'], '*');
  await replaceOffices(q, 'speedy', [{ id: 'speedy:190', code: '190', name: 'АЙТОС - КИРИЛ И МЕТОДИЙ (УЛ.)', city: 'Айтос', cityId: null, postCode: '', address: '', isAutomat: false }]);
  const sp = fakeRes();
  await offices(fakeReq({ url: '/api/offices?courier=speedy' }), sp);
  assert.deepEqual(json(sp).offices.map((o) => o.id), ['speedy:190']);
  const bad = fakeRes();
  await offices(fakeReq({ url: '/api/offices?courier=dhl' }), bad);
  assert.equal(bad.statusCode, 400);
});

test('GET /api/cities returns cities', async () => {
  await replaceCities(q, [{ id: 1, name: 'Пловдив', postCode: '4000', region: 'Пловдив', hasOffice: true }]);
  const res = fakeRes();
  await cities(fakeReq({ url: '/api/cities', headers: { origin: ORIGIN } }), res);
  assert.deepEqual(json(res).cities, [{ id: 1, name: 'Пловдив', postCode: '4000', region: 'Пловдив', hasOffice: true }]);
  assert.equal(res.headers['access-control-allow-origin'], '*');
});

test('POST /api/orders guards origin, token and fields', async () => {
  let res = fakeRes(); await orders(post(body(), { origin: 'https://evil.example' }), res);
  assert.equal(res.statusCode, 403);
  res = fakeRes(); await orders(post(body({ token: 'nope' })), res);
  assert.equal(res.statusCode, 401);
  const savedWarn = console.warn;
  const warned = [];
  console.warn = (...a) => warned.push(a);
  try {
    res = fakeRes(); await orders(post(body({ phone: '1' })), res);
  } finally { console.warn = savedWarn; }
  assert.equal(res.statusCode, 400);
  assert.equal(json(res).error, 'invalid phone');
  assert.deepEqual(warned, [['[orders] rejected', 'A1', 'invalid phone']]);
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

test('POST /api/orders keys the ConvertBuilder order id by store domain', async () => {
  let res = fakeRes(); await orders(post(body({ cb_order_id: '1' })), res);
  assert.equal(json(res).inserted, true);
  res = fakeRes(); await orders(post(body({ cb_order_id: '1', phone: '0899000111' }), { origin: 'https://blagoslovii.com' }), res);
  assert.equal(json(res).inserted, true);
  const ids = (await q('select cb_order_id from zd.orders order by cb_order_id')).map((r) => r.cb_order_id);
  assert.deepEqual(ids, ['blagoslovii.com:1', 'dasezaobichame.convertbuilder.com:1']);
});

test('POST /api/orders rate-limits 20 orders per IP per 10 minutes', async () => {
  const savedWarn = console.warn;
  const warned = [];
  console.warn = (...a) => warned.push(a);
  try {
    for (let i = 1; i <= 20; i++) {
      const res = fakeRes(); await orders(post(body({ cb_order_id: `R${i}` })), res);
      assert.equal(res.statusCode, 200);
    }
    const res = fakeRes(); await orders(post(body({ cb_order_id: 'R21' })), res);
    assert.equal(res.statusCode, 429);
    assert.equal(warned.length, 1);
    assert.deepEqual(warned[0], ['[orders] rate-limited', '9.9.9.9', 'R21']);
  } finally { console.warn = savedWarn; }
});

test('GET /api/cron/refresh requires the secret and stores Econt data', async () => {
  let res = fakeRes(); await refresh(fakeReq({ headers: {} }), res);
  assert.equal(res.statusCode, 401);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true,
    text: async () => "var speedy_offices = { 190: {oID: 190, officeName: 'АЙТОС - КИРИЛ И МЕТОДИЙ (УЛ.)', officeIcon: iconMarker, officeIconFocused: iconMarkerFocused, officeDescription: null, Y: 42.7, X: 27.2, officeType: 'OFFICE', dropOffAllowed: 1, pickUpAllowed: 1} };",
    json: async () => (String(url).includes('getOffices')
      ? { offices: [{ code: '1', name: 'Център', address: { city: { id: 7, name: 'Пловдив', postCode: '4000', country: { code3: 'BGR' } }, fullAddress: 'Пловдив ул. Х 1' } }] }
      : { cities: [{ id: 7, name: 'Пловдив', postCode: '4000', regionName: 'Пловдив' }] }),
  });
  try {
    res = fakeRes(); await refresh(fakeReq({ headers: { authorization: 'Bearer cron' } }), res);
  } finally { globalThis.fetch = realFetch; }
  assert.deepEqual(json(res), { offices: { upserted: 1, removed: 0 }, cities: { upserted: 1, removed: 0 }, speedy: { upserted: 1, removed: 0 } });
  const [sp] = await q("select name, city, is_automat from zd.offices where id = 'speedy:190'");
  assert.deepEqual(sp, { name: 'АЙТОС - КИРИЛ И МЕТОДИЙ (УЛ.)', city: 'Айтос', is_automat: false });
  const [pc] = await q("select post_code from zd.offices where id = 'speedy:190'");
  assert.equal(pc.post_code, '', 'Айтос is not in the stubbed city list');
  const [c] = await q('select has_office from zd.cities where id = 7');
  assert.equal(c.has_office, true);
});

test('GET /api/cron/refresh keeps the Econt refresh when Speedy fails', async () => {
  const realFetch = globalThis.fetch, savedError = console.error;
  console.error = () => {};
  globalThis.fetch = async (url) => (String(url).includes('speedy')
    ? { ok: false, status: 503 }
    : { ok: true, json: async () => (String(url).includes('getOffices')
      ? { offices: [{ code: '1', name: 'Център', address: { city: { id: 7, name: 'Пловдив', postCode: '4000', country: { code3: 'BGR' } }, fullAddress: 'Пловдив ул. Х 1' } }] }
      : { cities: [{ id: 7, name: 'Пловдив', postCode: '4000', regionName: 'Пловдив' }] }) });
  let res;
  try {
    res = fakeRes(); await refresh(fakeReq({ headers: { authorization: 'Bearer cron' } }), res);
  } finally { globalThis.fetch = realFetch; console.error = savedError; }
  assert.equal(res.statusCode, 200);
  assert.deepEqual(json(res).offices, { upserted: 1, removed: 0 });
  assert.match(json(res).speedy.error, /HTTP 503/);
});

test('POST /api/orders handles and logs DB errors', async () => {
  const savedError = console.error;
  let errorLogged = '';
  console.error = (msg, ...args) => { errorLogged = msg + ' ' + args.join(' '); };
  try {
    setQueryForTests(async () => { throw new Error('db down'); });
    const res = fakeRes(); await orders(post(body()), res);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(json(res), { error: 'server' });
    assert.equal(res.headers['access-control-allow-origin'], ORIGIN);
    assert.match(errorLogged, /\[orders\]/);
  } finally {
    console.error = savedError;
    q = await makeTestQuery(); setQueryForTests(q);
  }
});

test('GET /api/offices handles and logs DB errors, no cache on error', async () => {
  const savedError = console.error;
  let errorLogged = '';
  console.error = (msg, ...args) => { errorLogged = msg + ' ' + args.join(' '); };
  try {
    setQueryForTests(async () => { throw new Error('db down'); });
    const res = fakeRes();
    await offices(fakeReq({ url: '/api/offices?courier=econt', headers: { origin: ORIGIN } }), res);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(json(res), { error: 'server' });
    assert.equal(res.headers['cache-control'], undefined);
    assert.match(errorLogged, /\[offices\]/);
  } finally {
    console.error = savedError;
    q = await makeTestQuery(); setQueryForTests(q);
  }
});

test('GET /api/cities handles and logs DB errors, no cache on error', async () => {
  const savedError = console.error;
  let errorLogged = '';
  console.error = (msg, ...args) => { errorLogged = msg + ' ' + args.join(' '); };
  try {
    setQueryForTests(async () => { throw new Error('db down'); });
    const res = fakeRes();
    await cities(fakeReq({ url: '/api/cities', headers: { origin: ORIGIN } }), res);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(json(res), { error: 'server' });
    assert.equal(res.headers['cache-control'], undefined);
    assert.match(errorLogged, /\[cities\]/);
  } finally {
    console.error = savedError;
    q = await makeTestQuery(); setQueryForTests(q);
  }
});

test('GET /api/cron/refresh handles and logs errors', async () => {
  const savedError = console.error;
  let errorLogged = '';
  console.error = (msg, ...args) => { errorLogged = msg + ' ' + args.join(' '); };
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false, status: 503 });
    const res = fakeRes();
    await refresh(fakeReq({ headers: { authorization: 'Bearer cron' } }), res);
    assert.equal(res.statusCode, 500);
    assert.equal(json(res).error, 'server');
    assert.match(errorLogged, /\[cron\]/);
  } finally {
    globalThis.fetch = realFetch;
    console.error = savedError;
  }
});
