import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestQuery } from './helpers/pglite.js';
import { insertOrder, upsertCbOrder, updateStatus } from '../lib/orders-repo.js';
import { mapOrder } from '../lib/convertbuilder.js';
import { syncOrderStock, saveProduct, adjustStock, listInventory, productHistory } from '../lib/stock.js';

let q;
beforeEach(async () => { q = await makeTestQuery(); });

let n = 0;
async function order(items, patch = {}) {
  n++;
  return insertOrder(q, {
    cbOrderId: `adhdbg.eu:${n}`, name: 'Клиент', phone: '', phoneNorm: '', email: '', deliveryType: 'econt_office', courier: 'econt',
    officeId: 'econt:1', officeText: 'ЕКОНТ – офис', city: 'Х', postCode: '1000', addressText: '', items, total: 20, currency: 'EUR',
    paymentMethod: 'cod', pageUrl: '', ip: String(n), userAgent: '', ...patch,
  });
}
const stockOf = async (name) => Number((await q(`select stock from zd.product_costs where name = $1`, [name]))[0]?.stock);

test('a new order takes stock once, however many times it is synced', async () => {
  await saveProduct(q, { name: 'Книга', stock: 10 }, { create: true });
  const o = await order([{ name: 'Книга', qty: 2, price: 37 }]);
  await syncOrderStock(q, o.id);
  await syncOrderStock(q, o.id);
  assert.equal(await stockOf('Книга'), 8);
});

test('the same order from the checkout and from ConvertBuilder is counted once', async () => {
  await saveProduct(q, { name: 'Книга', stock: 10 }, { create: true });
  const w = await order([{ name: 'Книга', qty: 1, price: 18.5 }], { cbOrderId: 'adhdbg.eu:82' });
  await syncOrderStock(q, w.id);
  const cb = mapOrder({ id: 82, created: Math.floor(Date.now() / 1000), customerName: 'К', shippingAddress: { address: 'ЕКОНТ – офис' },
    total: 20, status: 'pending', items: [{ name: 'Книга', quantity: 1, total: 18.5 }] }, { store: 'adhdbg.eu' });
  const r = await upsertCbOrder(q, cb);
  assert.equal(r.id, w.id);
  await syncOrderStock(q, r.id);
  assert.equal(await stockOf('Книга'), 9);
});

test('cancelled or returned gives stock back; back to an active status takes it again; deleting gives it back', async () => {
  await saveProduct(q, { name: 'Книга', stock: 5 }, { create: true });
  const o = await order([{ name: 'Книга', qty: 2, price: 37 }]);
  await syncOrderStock(q, o.id);
  assert.equal(await stockOf('Книга'), 3);
  await updateStatus(q, o.id, 'cancelled'); await syncOrderStock(q, o.id);
  assert.equal(await stockOf('Книга'), 5);
  await updateStatus(q, o.id, 'new'); await syncOrderStock(q, o.id);
  assert.equal(await stockOf('Книга'), 3);
  await updateStatus(q, o.id, 'returned'); await syncOrderStock(q, o.id);
  assert.equal(await stockOf('Книга'), 5);
  await updateStatus(q, o.id, 'shipped'); await syncOrderStock(q, o.id);
  await syncOrderStock(q, o.id, { removing: true });
  assert.equal(await stockOf('Книга'), 5, 'a deleted order returns its stock');
});

test('orders older than the moment stock was entered do not change it; names match without case', async () => {
  const old = await order([{ name: 'Книга', qty: 1, price: 18.5 }]);
  await q(`update zd.orders set created_at = now() - interval '1 day' where id = $1`, [old.id]);
  await saveProduct(q, { name: 'Книга', stock: 4 }, { create: true });
  await syncOrderStock(q, old.id);
  assert.equal(await stockOf('Книга'), 4);
  const o = await order([{ name: '  книга ', qty: 1, price: 18.5 }, { name: 'Неследен продукт', qty: 3, price: 1 }]);
  await syncOrderStock(q, o.id);
  assert.equal(await stockOf('Книга'), 3);
});

test('two simultaneous syncs of the same order (checkout + webhook) do not double count', async () => {
  await saveProduct(q, { name: 'Книга', stock: 10 }, { create: true });
  const o = await order([{ name: 'Книга', qty: 3, price: 1 }]);
  await Promise.all([syncOrderStock(q, o.id), syncOrderStock(q, o.id), syncOrderStock(q, o.id)]);
  assert.equal(await stockOf('Книга'), 7);
});

test('products: create, edit as a logged correction, adjust, history; validation in Bulgarian', async () => {
  await saveProduct(q, { name: 'Книга', sku: 'BK-1', stock: 10, lowStock: 3, unitCost: 4.2 }, { create: true });
  await assert.rejects(saveProduct(q, { name: 'книга', stock: 1 }, { create: true }), /вече съществува/);
  await saveProduct(q, { name: 'Книга', sku: 'BK-1', stock: 12, lowStock: 3, unitCost: 4.2 });
  await adjustStock(q, { name: 'Книга', delta: -2, reason: 'Брак', note: 'намокрени' });
  assert.equal(await stockOf('Книга'), 10);
  await assert.rejects(adjustStock(q, { name: 'Книга', delta: 0, reason: 'Друго' }), /количество/);
  await saveProduct(q, { name: 'Гривна' }, { create: true });
  await assert.rejects(adjustStock(q, { name: 'Гривна', delta: 5, reason: 'Доставка' }), /Първо въведете наличност/);
  for (const bad of [{ stock: 1.5 }, { lowStock: -1 }, { unitCost: -3 }, { name: '' }]) {
    await assert.rejects(saveProduct(q, { name: 'Х', ...bad }, { create: true }), undefined, JSON.stringify(bad));
  }
  const moves = await productHistory(q, 'Книга');
  assert.deepEqual(moves.map((m) => [m.qty, m.reason, m.note]), [[-2, 'manual', 'Брак: намокрени'], [2, 'manual', 'Ръчно задаване'], [10, 'manual', 'Начална наличност']]);
});

test('inventory cards and list: tracked products, total, low, out, sold in 30 days', async () => {
  await saveProduct(q, { name: 'Книга', stock: 10, lowStock: 3 }, { create: true });
  await saveProduct(q, { name: 'Аудио', stock: 2, lowStock: 3 }, { create: true });
  await saveProduct(q, { name: 'Гривна', stock: 0 }, { create: true });
  const o = await order([{ name: 'Книга', qty: 2, price: 37 }]);
  await syncOrderStock(q, o.id);
  await order([{ name: 'Тесте', qty: 1, price: 5 }]); // sold but not tracked
  const inv = await listInventory(q);
  assert.deepEqual(inv.cards, { products: 3, totalStock: 10, low: 1, out: 1 });
  const byName = Object.fromEntries(inv.products.map((p) => [p.name, p]));
  assert.deepEqual([byName['Книга'].stock, byName['Книга'].sold30, byName['Книга'].state], [8, 2, 'ok']);
  assert.equal(byName['Аудио'].state, 'low');
  assert.equal(byName['Гривна'].state, 'out');
  assert.deepEqual([byName['Тесте'].stock, byName['Тесте'].state], [null, 'untracked']);
});

test('switching tracking off and on again never gives back stock taken by older orders', async () => {
  await saveProduct(q, { name: 'Книга', stock: 10 }, { create: true });
  const o = await order([{ name: 'Книга', qty: 2, price: 37 }]);
  await syncOrderStock(q, o.id);
  await q(`update zd.orders set created_at = now() - interval '1 day' where id = $1`, [o.id]);
  await saveProduct(q, { name: 'Книга', stock: '' });
  await saveProduct(q, { name: 'Книга', stock: 20 });
  await syncOrderStock(q, o.id);
  assert.equal(await stockOf('Книга'), 20);
  await updateStatus(q, o.id, 'cancelled'); await syncOrderStock(q, o.id);
  assert.equal(await stockOf('Книга'), 20, 'that order belongs to the old tracking period');
});

test('names differing only in capitals are one product (also when saved from Финанси)', async () => {
  const { saveCosts } = await import('../lib/costs.js');
  await saveProduct(q, { name: 'Книга', stock: 10 }, { create: true });
  await saveCosts(q, { products: [{ name: 'КНИГА', unitCost: 3 }, { name: 'книга ', unitCost: 4 }] });
  const rows = await q(`select name, unit_cost from zd.product_costs`);
  assert.deepEqual(rows.map((r) => [r.name, Number(r.unit_cost)]), [['Книга', 4]]);
  await assert.rejects(q(`insert into zd.product_costs (name) values ('КНИГА')`), 'the database refuses a case twin');
  const o = await order([{ name: 'КНИГА', qty: 1, price: 18.5 }]);
  await syncOrderStock(q, o.id);
  assert.equal(await stockOf('Книга'), 9);
});

test('saving an old form changes stock only by what the admin typed', async () => {
  await saveProduct(q, { name: 'Книга', stock: 10 }, { create: true });
  const o = await order([{ name: 'Книга', qty: 2, price: 37 }]);
  await syncOrderStock(q, o.id); // 8 now, the open form still shows 10
  await saveProduct(q, { name: 'Книга', sku: 'BK', stock: 10, stockWas: 10 });
  assert.equal(await stockOf('Книга'), 8, 'only the SKU changed');
  await saveProduct(q, { name: 'Книга', stock: 15, stockWas: 10 });
  assert.equal(await stockOf('Книга'), 13, '+5 on top of what orders did meanwhile');
  await saveProduct(q, { name: 'Гривна' }, { create: true });
  await saveProduct(q, { name: 'Гривна', stock: 3 });
  await assert.rejects(saveProduct(q, { name: 'Гривна', stock: 7, stockWas: null }), /презаредете/);
});

test('deleting an order gives its stock back in the same step; history says why stock moved', async () => {
  const { deleteOrderRestoringStock } = await import('../lib/stock.js');
  await saveProduct(q, { name: 'Книга', stock: 10 }, { create: true });
  const a = await order([{ name: 'Книга', qty: 2, price: 37 }]);
  await syncOrderStock(q, a.id);
  await updateStatus(q, a.id, 'returned'); await syncOrderStock(q, a.id);
  await updateStatus(q, a.id, 'new'); await syncOrderStock(q, a.id);
  await updateStatus(q, a.id, 'cancelled'); await syncOrderStock(q, a.id);
  await updateStatus(q, a.id, 'new'); await syncOrderStock(q, a.id);
  assert.equal(await deleteOrderRestoringStock(q, a.id), true);
  assert.equal(await stockOf('Книга'), 10);
  assert.equal((await q(`select count(*)::int as n from zd.orders where id = $1`, [a.id]))[0].n, 0);
  const notes = (await productHistory(q, 'Книга')).map((m) => `${m.qty} ${m.note}`);
  assert.deepEqual(notes, ['2 Изтрита поръчка', '-2 Поръчка', '2 Отказана поръчка', '-2 Поръчка', '2 Върната поръчка', '-2 Поръчка', '10 Начална наличност']);
  assert.equal(await deleteOrderRestoringStock(q, a.id), false);
});
