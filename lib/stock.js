// Inventory per shop: products in zd.product_costs (stock null = not tracked), automatic stock movements from orders and manual corrections.
import { DEFAULT_SHOP } from './shops.js';
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v || {});
const key = (name) => String(name ?? '').trim().toLowerCase();
const HOLDS_STOCK = (status) => status !== 'cancelled' && status !== 'returned';
export const ADJUST_REASONS = ['Доставка', 'Брак', 'Преброяване', 'Друго'];

/**
 * Makes an order's stock movements match its current state: an order holds stock (−qty of each tracked product) until it is
 * cancelled/returned or deleted (`removing`). What was taken is kept in orders.stock_applied and applied with a compare-and-swap
 * in one statement, so simultaneous calls (checkout beacon + webhook) never count twice. Orders older than the moment a
 * product's stock was entered (tracked_since) do not touch it.
 */
export async function syncOrderStock(q, orderId, { removing = false } = {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const [o] = await q(`select id, shop_id, status, items, created_at, stock_applied from zd.orders where id = $1::uuid`, [orderId]);
    if (!o) return { changed: [] };
    const applied = parse(o.stock_applied);
    const desired = {};
    // products this order may touch: tracked since before it was created (ConvertBuilder order times are whole seconds).
    // What it took in an earlier tracking period of a product is forgotten, never given back.
    const tracked = await q(`select name from zd.product_costs where shop_id = $2::uuid and stock is not null and date_trunc('second', tracked_since) <= $1`, [o.created_at, o.shop_id]);
    const byKey = new Map(tracked.map((p) => [key(p.name), p.name]));
    const eligible = new Set(byKey.values());
    if (!removing && HOLDS_STOCK(o.status)) {
      for (const it of parse(o.items)) {
        const name = byKey.get(key(it?.name));
        const qty = Math.max(0, Math.trunc(Number(it?.qty) || 0));
        if (name && qty) desired[name] = (desired[name] || 0) + qty;
      }
    }
    const changes = [...new Set([...Object.keys(applied), ...Object.keys(desired)])]
      .filter((name) => eligible.has(name))
      .map((name) => ({ name, qty: (applied[name] || 0) - (desired[name] || 0) })) // + gives stock back, − takes it
      .filter((c) => c.qty !== 0);
    if (!changes.length) return { changed: [] };
    const [r] = await q(
      `with cas as (
         update zd.orders set stock_applied = $2::text::jsonb where id = $1::uuid and stock_applied = $3::text::jsonb returning id
       ), d as (
         select c.name, c.qty from jsonb_to_recordset($4::text::jsonb) as c(name text, qty int), cas
       ), upd as (
         update zd.product_costs p set stock = p.stock + d.qty, updated_at = now() from d
         where p.shop_id = $6::uuid and p.name = d.name and p.stock is not null returning p.name, d.qty
       ), mv as (
         insert into zd.stock_moves (shop_id, product_name, order_id, qty, reason, note)
         select $6::uuid, name, $1::uuid, qty, case when qty < 0 then 'order' else 'order_restore' end, case when qty < 0 then 'Поръчка' else $5 end
         from upd returning id
       )
       select (select count(*) from cas)::int as ok`,
      [orderId, JSON.stringify(desired), JSON.stringify(applied), JSON.stringify(changes),
        removing ? 'Изтрита поръчка' : o.status === 'cancelled' ? 'Отказана поръчка' : o.status === 'returned' ? 'Върната поръчка' : 'Промяна в поръчката', o.shop_id],
    );
    if (r.ok) return { changed: changes };
    // another call changed this order in between: read again and recompute
  }
  throw new Error(`stock sync conflict for order ${orderId}`);
}

/**
 * Deletes an order and gives back what it took, in one statement: a sync racing with it either finishes first (and the delete
 * sees its stock_applied) or finds the order gone. Returns whether the order existed.
 */
export async function deleteOrderRestoringStock(q, orderId) {
  const [r] = await q(
    `with del as (
       delete from zd.orders where id = $1::uuid returning id, shop_id, stock_applied, created_at
     ), d as (
       select a.key as name, a.value::int as qty from del, jsonb_each_text(del.stock_applied) as a
     ), upd as (
       update zd.product_costs p set stock = p.stock + d.qty, updated_at = now() from d, del
       where p.shop_id = del.shop_id and p.name = d.name and p.stock is not null and date_trunc('second', p.tracked_since) <= del.created_at and d.qty <> 0
       returning p.shop_id, p.name, d.qty
     ), mv as (
       insert into zd.stock_moves (shop_id, product_name, order_id, qty, reason, note) select shop_id, name, null, qty, 'order_restore', 'Изтрита поръчка' from upd
     )
     select (select count(*) from del)::int as n`,
    [orderId],
  );
  return r.n > 0;
}

/** Like syncOrderStock, but an inventory problem never breaks taking an order: it is logged instead. */
export async function syncStockSafe(q, orderId, opts) {
  if (!orderId) return;
  try { await syncOrderStock(q, orderId, opts); } catch (err) { console.error('[stock] sync failed', orderId, err); }
}

function intOrNull(v, message, { min = -1e6, max = 1e6 } = {}) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (typeof v === 'boolean' || !Number.isInteger(n) || n < min || n > max) throw new Error(message);
  return n;
}

/**
 * Creates or edits a product. A changed stock number is logged as a manual correction; an empty one stops tracking.
 * The admin form sends `stockWas` (the number it was opened with): only the difference the admin typed is applied, so orders
 * that came in while the form was open are kept.
 */
export async function saveProduct(q, input = {}, { create = false, shopId = DEFAULT_SHOP } = {}) {
  const name = String(input.name ?? '').trim().slice(0, 200);
  if (!name) throw new Error('Въведете име на продукта');
  const sku = String(input.sku ?? '').trim().slice(0, 60);
  const stock = intOrNull(input.stock, 'Наличността трябва да е цяло число');
  const lowStock = intOrNull(input.lowStock, 'Прагът трябва да е цяло число ≥ 0', { min: 0 }) ?? 5;
  let unitCost = null;
  if (input.unitCost !== undefined && input.unitCost !== null && input.unitCost !== '') {
    unitCost = Number(input.unitCost);
    if (typeof input.unitCost === 'boolean' || !Number.isFinite(unitCost) || unitCost < 0 || unitCost > 100000) throw new Error('Невалидна себестойност');
    unitCost = Math.round(unitCost * 100) / 100;
  }
  const [existing] = await q(`select name, stock from zd.product_costs where shop_id = $2::uuid and lower(btrim(name)) = $1 limit 1`, [key(name), shopId]);
  if (existing && create) throw new Error('Продукт с това име вече съществува');
  if (!existing) {
    await q(
      `insert into zd.product_costs (shop_id, name, sku, low_stock, unit_cost, stock, tracked_since, updated_at)
       values ($6::uuid, $1, $2, $3, coalesce($4::text::numeric, 0), $5::int, case when $5::int is null then null else now() end, now())`,
      [name, sku, lowStock, unitCost == null ? null : String(unitCost), stock, shopId],
    );
    if (stock != null) await logManual(q, shopId, name, stock, 'Начална наличност');
    return { name };
  }
  const now = existing.stock == null ? null : Number(existing.stock);
  const hasWas = Object.prototype.hasOwnProperty.call(input, 'stockWas');
  const was = hasWas ? intOrNull(input.stockWas, 'Наличността трябва да е цяло число') : now;
  // keep · untrack · start · delta (relative to the number the form was opened with)
  let mode = 'keep', delta = 0;
  if (stock !== was) {
    if (hasWas && (was == null) !== (now == null)) throw new Error('Наличността се промени междувременно — презаредете страницата');
    if (stock == null) mode = 'untrack';
    else if (was == null) mode = 'start';
    else { mode = 'delta'; delta = stock - was; }
  }
  await q(
    `update zd.product_costs set sku = $2, low_stock = $3, unit_cost = coalesce($4::text::numeric, unit_cost), updated_at = now(),
       stock = case $5 when 'untrack' then null when 'start' then $6::int when 'delta' then stock + $6::int else stock end,
       tracked_since = case $5 when 'untrack' then null when 'start' then now() else tracked_since end
     where shop_id = $7::uuid and name = $1`,
    [existing.name, sku, lowStock, unitCost == null ? null : String(unitCost), mode, mode === 'start' ? stock : delta, shopId],
  );
  if (mode === 'start') await logManual(q, shopId, existing.name, stock, 'Начална наличност');
  if (mode === 'delta') await logManual(q, shopId, existing.name, delta, 'Ръчно задаване');
  return { name: existing.name };
}

const logManual = (q, shopId, name, qty, note) =>
  q(`insert into zd.stock_moves (shop_id, product_name, order_id, qty, reason, note) values ($4::uuid, $1, null, $2, 'manual', $3)`, [name, qty, note, shopId]);

/** Manual correction (delivery, write-off, count): ± quantity with a reason, only for tracked products. */
export async function adjustStock(q, { name, delta, reason = 'Друго', note = '', shopId = DEFAULT_SHOP } = {}) {
  const d = intOrNull(delta, 'Въведете количество (+ или −)');
  if (!d) throw new Error('Въведете количество (+ или −)');
  const why = ADJUST_REASONS.includes(reason) ? reason : 'Друго';
  const text = String(note ?? '').trim().slice(0, 200);
  const rows = await q(
    `with u as (update zd.product_costs set stock = stock + $2, updated_at = now() where shop_id = $4::uuid and name = $1 and stock is not null returning name, stock)
     insert into zd.stock_moves (shop_id, product_name, order_id, qty, reason, note) select $4::uuid, name, null, $2, 'manual', $3 from u returning (select stock from u)`,
    [String(name ?? ''), d, text ? `${why}: ${text}` : why, shopId],
  );
  if (rows.length) return { stock: Number(rows[0].stock) };
  const [p] = await q(`select 1 from zd.product_costs where shop_id = $2::uuid and name = $1`, [String(name ?? ''), shopId]);
  throw new Error(p ? 'Първо въведете наличност за продукта' : 'Няма такъв продукт');
}

/** Last 50 stock movements of a product, newest first (with the order number when it came from an order). */
export async function productHistory(q, name, { shopId = DEFAULT_SHOP } = {}) {
  const rows = await q(
    `select m.qty, m.reason, m.note, m.created_at, m.order_id, o.invoice_no, o.cb_order_id
     from zd.stock_moves m left join zd.orders o on o.id = m.order_id
     where m.shop_id = $2::uuid and m.product_name = $1 order by m.created_at desc, m.id desc limit 50`,
    [String(name ?? ''), shopId],
  );
  return rows.map((r) => ({
    qty: r.qty, reason: r.reason, note: r.note, createdAt: new Date(r.created_at).toISOString(),
    order: r.order_id ? (r.invoice_no ? `№${r.invoice_no}` : String(r.cb_order_id || '').split(':').pop()) : r.reason === 'manual' ? null : 'изтрита',
  }));
}

/** Products (saved + sold) with stock state, the four cards and sales of the last 30 days. */
export async function listInventory(q, { shopId = DEFAULT_SHOP } = {}) {
  const [saved, sold, sold30] = await Promise.all([
    q(`select name, sku, stock, low_stock, unit_cost from zd.product_costs where shop_id = $1::uuid`, [shopId]),
    q(`select distinct it->>'name' as name from zd.orders cross join lateral jsonb_array_elements(items) as it
       where shop_id = $1::uuid and coalesce(it->>'name', '') <> ''`, [shopId]),
    q(`select lower(btrim(it->>'name')) as k, sum(coalesce((it->>'qty')::numeric, 1))::int as qty
       from zd.orders cross join lateral jsonb_array_elements(items) as it
       where shop_id = $1::uuid and status not in ('cancelled', 'returned') and created_at > now() - interval '30 days' group by 1`, [shopId]),
  ]);
  const sales = new Map(sold30.map((r) => [r.k, r.qty]));
  const products = saved.map((p) => {
    const stock = p.stock == null ? null : Number(p.stock), low = Number(p.low_stock);
    const state = stock == null ? 'untracked' : stock <= 0 ? 'out' : stock <= low ? 'low' : 'ok';
    return { name: p.name, sku: p.sku, stock, lowStock: low, unitCost: Number(p.unit_cost), sold30: sales.get(key(p.name)) || 0, state };
  });
  const known = new Set(products.map((p) => key(p.name)));
  for (const r of sold) {
    if (known.has(key(r.name))) continue;
    known.add(key(r.name));
    products.push({ name: r.name, sku: '', stock: null, lowStock: 5, unitCost: 0, sold30: sales.get(key(r.name)) || 0, state: 'untracked' });
  }
  const order = { out: 0, low: 1, ok: 2, untracked: 3 };
  products.sort((a, b) => order[a.state] - order[b.state] || a.name.localeCompare(b.name, 'bg'));
  const tracked = products.filter((p) => p.stock != null);
  return {
    cards: {
      products: tracked.length,
      totalStock: tracked.reduce((s, p) => s + Math.max(0, p.stock), 0),
      low: tracked.filter((p) => p.state === 'low').length,
      out: tracked.filter((p) => p.state === 'out').length,
    },
    products,
  };
}
