import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { insertOrder, countRecentByIp, listOrders, updateStatus } from '../lib/orders-repo.js';

const order = (patch = {}) => ({
  cbOrderId: 'A1', name: 'Мария Иванова', phone: '0888123456', phoneNorm: '+359888123456', email: 'm@x.bg',
  deliveryType: 'econt_office', courier: 'econt', officeId: 'econt:7538', officeText: 'ЕКОНТ – офис Айдемир (7538)',
  city: 'Айдемир', postCode: '7538', addressText: '', items: [{ name: 'Тесте', qty: 1, price: 18.5 }],
  total: 22.57, currency: 'EUR', paymentMethod: 'cod', pageUrl: 'https://x', ip: '1.1.1.1', userAgent: 'UA', ...patch,
});

test('insertOrder is idempotent on cb_order_id', async () => {
  const q = await makeTestQuery();
  const first = await insertOrder(q, order());
  assert.equal(first.inserted, true);
  assert.equal(first.duplicate, false);
  assert.deepEqual(await insertOrder(q, order()), { inserted: false, duplicate: false, id: null });
  const { rows, total } = await listOrders(q);
  assert.equal(total, 1);
  assert.equal(rows[0].total, 22.57);
  assert.deepEqual(rows[0].items, [{ name: 'Тесте', qty: 1, price: 18.5 }]);
  assert.equal(rows[0].status, 'new');
});

test('same phone within 24h flags both orders as duplicates', async () => {
  const q = await makeTestQuery();
  await insertOrder(q, order({ cbOrderId: 'OLD' }));
  await q(`update zd.orders set created_at = now() - interval '25 hours' where cb_order_id = 'OLD'`);
  assert.equal((await insertOrder(q, order({ cbOrderId: 'A1' }))).duplicate, false);
  assert.equal((await insertOrder(q, order({ cbOrderId: 'A2' }))).duplicate, true);
  const flags = Object.fromEntries((await listOrders(q)).rows.map((r) => [r.cbOrderId, r.isDuplicate]));
  assert.deepEqual(flags, { OLD: false, A1: true, A2: true });
  // New assertion: different phone should not be flagged as duplicate
  const diffPhoneRes = await insertOrder(q, order({ cbOrderId: 'B1', phoneNorm: '+359877000000' }));
  assert.equal(diffPhoneRes.duplicate, false);
  const diffPhoneOrder = (await listOrders(q)).rows.find((r) => r.cbOrderId === 'B1');
  assert.equal(diffPhoneOrder.isDuplicate, false);
});

test('countRecentByIp counts the last 10 minutes only', async () => {
  const q = await makeTestQuery();
  await insertOrder(q, order({ cbOrderId: 'A1' }));
  await insertOrder(q, order({ cbOrderId: 'A2' }));
  await insertOrder(q, order({ cbOrderId: 'A3', ip: '2.2.2.2' }));
  await q(`update zd.orders set created_at = now() - interval '11 minutes' where cb_order_id = 'A2'`);
  assert.equal(await countRecentByIp(q, '1.1.1.1'), 1);
});

test('listOrders filters by status, search and date; paginates', async () => {
  const q = await makeTestQuery();
  await insertOrder(q, order({ cbOrderId: 'A1', name: 'Мария Иванова', phoneNorm: '+359888123456' }));
  await insertOrder(q, order({ cbOrderId: 'A2', name: 'Петя Петрова', phone: '0899000111', phoneNorm: '+359899000111' }));
  await insertOrder(q, order({ cbOrderId: 'A3', name: 'Иван Колев', phone: '0877555444', phoneNorm: '+359877555444' }));
  const a2 = (await listOrders(q, { search: 'петя' })).rows[0];
  assert.equal(a2.cbOrderId, 'A2');
  assert.equal((await listOrders(q, { search: '0877 555' })).rows[0].cbOrderId, 'A3');
  assert.equal(await updateStatus(q, a2.id, 'confirmed'), true);
  assert.deepEqual((await listOrders(q, { status: 'confirmed' })).rows.map((r) => r.cbOrderId), ['A2']);
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Sofia' });
  assert.equal((await listOrders(q, { from: today, to: today })).total, 3);
  assert.equal((await listOrders(q, { from: '2000-01-01', to: '2000-01-02' })).total, 0);
  const page2 = await listOrders(q, { page: 2, pageSize: 2 });
  assert.equal(page2.total, 3);
  assert.equal(page2.rows.length, 1);
  // New assertion: Infinity page should not throw and should return valid results
  const infinityResult = await listOrders(q, { page: Infinity });
  assert.equal(typeof infinityResult.rows, 'object');
  assert.equal(Array.isArray(infinityResult.rows), true);
});

test('updateStatus rejects unknown statuses and ids', async () => {
  const q = await makeTestQuery();
  const { id } = await insertOrder(q, order());
  assert.equal(await updateStatus(q, id, 'lost'), false);
  assert.equal(await updateStatus(q, 'not-a-uuid', 'confirmed'), false);
  assert.equal(await updateStatus(q, '00000000-0000-0000-0000-000000000000', 'confirmed'), false);
});
