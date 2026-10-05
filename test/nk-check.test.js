import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { fakeReq, fakeRes, json } from './helpers/http.js';
import { setQueryForTests } from '../lib/db.js';
import { insertOrder, listOrders } from '../lib/orders-repo.js';
import { checkOrders } from '../lib/nk-check.js';
import orders from '../api/orders.js';
import nkCron from '../api/cron/nekorekten.js';

const ORIGIN = 'https://dasezaobichame.convertbuilder.com';
process.env.ALLOWED_ORIGINS = ORIGIN;
process.env.ORDER_TOKEN = 'tok';
process.env.CRON_SECRET = 'cron';

let q;
beforeEach(async () => { q = await makeTestQuery(); setQueryForTests(q); delete process.env.NEKOREKTEN_API_KEY; });

const order = (patch = {}) => ({
  cbOrderId: 'A1', name: 'Мария', phone: '0888123456', phoneNorm: '+359888123456', email: '', deliveryType: 'econt_office',
  courier: 'econt', officeId: '', officeText: 'ЕКОНТ – офис X (1)', city: 'X', postCode: '', addressText: '', items: [],
  total: 1, currency: 'EUR', paymentMethod: 'cod', pageUrl: '', ip: '1', userAgent: '', ...patch,
});

async function withFetch(impl, fn) {
  const real = globalThis.fetch, realErr = console.error;
  globalThis.fetch = impl; console.error = () => {};
  try { return await fn(); } finally { globalThis.fetch = real; console.error = realErr; }
}

test('checkOrders flags, clears and marks errors per order', async () => {
  const a = await insertOrder(q, order({ cbOrderId: 'A', phoneNorm: '+359888000001' }));
  const b = await insertOrder(q, order({ cbOrderId: 'B', phoneNorm: '+359888000002' }));
  const c = await insertOrder(q, order({ cbOrderId: 'C', phoneNorm: '+359888000003' }));
  const fetchImpl = async (url) => {
    if (url.includes('359888000001')) return { ok: true, json: async () => ({ items: [{ id: 9 }], count: 1 }) };
    if (url.includes('359888000002')) return { ok: true, json: async () => ({ items: [], count: 0 }) };
    return { ok: false, status: 500, json: async () => ({}) };
  };
  const summary = await withFetch(globalThis.fetch, () => checkOrders(q, [
    { id: a.id, phoneNorm: '+359888000001' }, { id: b.id, phoneNorm: '+359888000002' }, { id: c.id, phoneNorm: '+359888000003' },
  ], 'KEY', fetchImpl));
  assert.deepEqual(summary, { checked: 3, flagged: 1, clean: 1, errors: 1 });
  const st = Object.fromEntries((await listOrders(q)).rows.map((r) => [r.cbOrderId, [r.nkStatus, r.nkCount]]));
  assert.deepEqual(st, { A: ['flagged', 1], B: ['clean', 0], C: ['error', null] });
});

const post = (patch = {}) => fakeReq({ method: 'POST', headers: { origin: ORIGIN, 'x-forwarded-for': '9.9.9.9' }, body: JSON.stringify({
  token: 'tok', cb_order_id: '7', name: 'Мария Иванова', phone: '0888123456', delivery_type: 'econt_office',
  office_text: 'ЕКОНТ – офис X (1)', city: 'X', items: [], total: 1, ...patch }) });

test('a new order is checked on nekorekten.com right away when a key is configured', async () => {
  process.env.NEKOREKTEN_API_KEY = 'KEY';
  const res = fakeRes();
  await withFetch(async () => ({ ok: true, json: async () => ({ items: [{ id: 3 }, { id: 4 }], count: 2 }) }), () => orders(post(), res));
  assert.equal(json(res).inserted, true);
  const [o] = (await listOrders(q)).rows;
  assert.deepEqual([o.nkStatus, o.nkCount, o.nkReportIds], ['flagged', 2, ['3', '4']]);
});

test('a nekorekten failure never loses the order', async () => {
  process.env.NEKOREKTEN_API_KEY = 'KEY';
  const res = fakeRes();
  await withFetch(async () => { throw new Error('network down'); }, () => orders(post(), res));
  assert.equal(res.statusCode, 200);
  assert.equal(json(res).inserted, true);
  assert.equal((await listOrders(q)).rows[0].nkStatus, 'error');
});

test('without a key orders stay pending', async () => {
  const res = fakeRes();
  await orders(post(), res);
  assert.equal((await listOrders(q)).rows[0].nkStatus, 'pending');
});

test('the nekorekten cron retries pending orders and needs the cron secret', async () => {
  let res = fakeRes(); await nkCron(fakeReq({ headers: {} }), res);
  assert.equal(res.statusCode, 401);
  await insertOrder(q, order({ cbOrderId: 'P1' }));
  process.env.NEKOREKTEN_API_KEY = 'KEY';
  res = fakeRes();
  await withFetch(async () => ({ ok: true, json: async () => ({ items: [], count: 0 }) }),
    () => nkCron(fakeReq({ url: '/api/cron/nekorekten', headers: { authorization: 'Bearer cron' } }), res));
  assert.deepEqual(json(res).summary, { checked: 1, flagged: 0, clean: 1, errors: 0 });
  assert.equal((await listOrders(q)).rows[0].nkStatus, 'clean');
});

test('opening the plain first admin page retries up to 2 unchecked orders, filtered views do not', async () => {
  const { signSession } = await import('../lib/auth.js');
  const adminOrders = (await import('../api/admin/orders.js')).default;
  process.env.ADMIN_SECRET = 'secret';
  for (const id of ['L1', 'L2', 'L3', 'L4']) await insertOrder(q, order({ cbOrderId: id }));
  process.env.NEKOREKTEN_API_KEY = 'KEY';
  const res = fakeRes();
  await withFetch(async () => ({ ok: true, json: async () => ({ items: [{ id: 1 }], count: 1 }) }),
    () => adminOrders(fakeReq({ url: '/api/admin/orders', headers: { cookie: `zdo_admin=${signSession('secret')}` } }), res));
  const statuses = json(res).orders.map((o) => o.nkStatus).sort();
  assert.deepEqual(statuses, ['flagged', 'flagged', 'pending', 'pending']);
  const res2 = fakeRes();
  await withFetch(async () => ({ ok: true, json: async () => ({ items: [], count: 0 }) }),
    () => adminOrders(fakeReq({ url: '/api/admin/orders?q=Мария', headers: { cookie: `zdo_admin=${signSession('secret')}` } }), res2));
  assert.equal(json(res2).orders.filter((o) => o.nkStatus === 'clean').length, 0, 'searching does not spend nekorekten requests');
});

test('the CSV export has a nekorekten column', async () => {
  const { ordersToCsv } = await import('../lib/csv.js');
  const base = { createdAt: '2026-10-05T10:00:00Z', name: 'М', phone: '1', email: '', officeText: '', city: '', postCode: '', items: [], total: 1, currency: 'EUR', status: 'new', isDuplicate: false, cbOrderId: 'x' };
  const lines = ordersToCsv([{ ...base, nkStatus: 'flagged', nkCount: 2 }, { ...base, nkStatus: 'clean', nkCount: 0 }, { ...base, nkStatus: 'pending' }]).split('\r\n');
  assert.ok(lines[0].endsWith(';НЕкоректен'));
  assert.deepEqual(lines.slice(1).map((l) => l.split(';').pop()), ['2 сигнала', 'чист', 'непроверен']);
});

test('orders without a valid phone are not sent to nekorekten.com nor retried', async () => {
  const { pendingNekorekten } = await import('../lib/orders-repo.js');
  const a = await insertOrder(q, order({ cbOrderId: 'NP', phone: '12', phoneNorm: '' }));
  let calls = 0;
  const summary = await checkOrders(q, [{ id: a.id, phoneNorm: '' }], 'KEY', async () => { calls++; return { ok: true, json: async () => ({ items: [], count: 0 }) }; });
  assert.equal(calls, 0);
  assert.deepEqual(summary, { checked: 0, flagged: 0, clean: 0, errors: 0 });
  assert.deepEqual(await pendingNekorekten(q, 10), []);
});

test('pending checks back off for 30 minutes after a failed attempt', async () => {
  const { pendingNekorekten, saveNekorekten } = await import('../lib/orders-repo.js');
  const a = await insertOrder(q, order({ cbOrderId: 'B1', phoneNorm: '+359888000011' }));
  const b = await insertOrder(q, order({ cbOrderId: 'B2', phoneNorm: '+359888000012' }));
  await saveNekorekten(q, a.id, { status: 'error' });
  assert.deepEqual((await pendingNekorekten(q, 10)).map((o) => o.id), [b.id]);
  await q(`update zd.orders set nk_checked_at = now() - interval '31 minutes' where id = $1`, [a.id]);
  assert.deepEqual((await pendingNekorekten(q, 10)).map((o) => o.id).sort(), [a.id, b.id].sort());
});
