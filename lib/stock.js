// Inventory: products in zd.product_costs (stock null = not tracked), automatic stock movements from orders and manual corrections.
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
    const [o] = await q(`select id, status, items, created_at, stock_applied from zd.orders where id = $1::uuid`, [orderId]);
    if (!o) return { changed: [] };
    const applied = parse(o.stock_applied);
    const desired = {};
    if (!removing && HOLDS_STOCK(o.status)) {
      // ConvertBuilder order times are whole seconds: compare at that precision
      const tracked = await q(`select name from zd.product_costs where stock is not null and date_trunc('second', tracked_since) <= $1`, [o.created_at]);
      const byKey = new Map(tracked.map((p) => [key(p.name), p.name]));
      for (const it of parse(o.items)) {
        const name = byKey.get(key(it?.name));
        const qty = Math.max(0, Math.trunc(Number(it?.qty) || 0));
        if (name && qty) desired[name] = (desired[name] || 0) + qty;
      }
    }
    const changes = [...new Set([...Object.keys(applied), ...Object.keys(desired)])]
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
         where p.name = d.name and p.stock is not null returning p.name, d.qty
       ), mv as (
         insert into zd.stock_moves (product_name, order_id, qty, reason)
         select name, $1::uuid, qty, case when qty < 0 then 'order' else 'order_restore' end from upd returning id
       )
       select (select count(*) from cas)::int as ok`,
      [orderId, JSON.stringify(desired), JSON.stringify(applied), JSON.stringify(changes)],
    );
    if (r.ok) return { changed: changes };
    // another call changed this order in between: read again and recompute
  }
  throw new Error(`stock sync conflict for order ${orderId}`);
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

/** Creates or edits a product. A changed stock number is logged as a manual correction; an empty one stops tracking. */
export async function saveProduct(q, input = {}, { create = false } = {}) {
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
  const [existing] = await q(`select name, stock from zd.product_costs where lower(btrim(name)) = $1 limit 1`, [key(name)]);
  if (existing && create) throw new Error('Продукт с това име вече съществува');
  if (!existing) {
    await q(
      `insert into zd.product_costs (name, sku, low_stock, unit_cost, stock, tracked_since, updated_at)
       values ($1, $2, $3, coalesce($4::text::numeric, 0), $5::int, case when $5::int is null then null else now() end, now())`,
      [name, sku, lowStock, unitCost == null ? null : String(unitCost), stock],
    );
    if (stock != null) await logManual(q, name, stock, 'Начална наличност');
    return { name };
  }
  const was = existing.stock == null ? null : Number(existing.stock);
  await q(
    `update zd.product_costs set sku = $2, low_stock = $3, unit_cost = coalesce($4::text::numeric, unit_cost), updated_at = now(),
       stock = case when $5::int is null then null when stock is null then $5::int else stock + ($5::int - $6::int) end,
       tracked_since = case when $5::int is null then null else coalesce(tracked_since, now()) end
     where name = $1`,
    [existing.name, sku, lowStock, unitCost == null ? null : String(unitCost), stock, was ?? 0],
  );
  if (stock != null && was == null) await logManual(q, existing.name, stock, 'Начална наличност');
  else if (stock != null && stock !== was) await logManual(q, existing.name, stock - was, 'Ръчно задаване');
  return { name: existing.name };
}

const logManual = (q, name, qty, note) =>
  q(`insert into zd.stock_moves (product_name, order_id, qty, reason, note) values ($1, null, $2, 'manual', $3)`, [name, qty, note]);

/** Manual correction (delivery, write-off, count): ± quantity with a reason, only for tracked products. */
export async function adjustStock(q, { name, delta, reason = 'Друго', note = '' } = {}) {
  const d = intOrNull(delta, 'Въведете количество (+ или −)');
  if (!d) throw new Error('Въведете количество (+ или −)');
  const why = ADJUST_REASONS.includes(reason) ? reason : 'Друго';
  const text = String(note ?? '').trim().slice(0, 200);
  const rows = await q(
    `with u as (update zd.product_costs set stock = stock + $2, updated_at = now() where name = $1 and stock is not null returning name, stock)
     insert into zd.stock_moves (product_name, order_id, qty, reason, note) select name, null, $2, 'manual', $3 from u returning (select stock from u)`,
    [String(name ?? ''), d, text ? `${why}: ${text}` : why],
  );
  if (rows.length) return { stock: Number(rows[0].stock) };
  const [p] = await q(`select 1 from zd.product_costs where name = $1`, [String(name ?? '')]);
  throw new Error(p ? 'Първо въведете наличност за продукта' : 'Няма такъв продукт');
}

/** Last 50 stock movements of a product, newest first (with the order number when it came from an order). */
export async function productHistory(q, name) {
  const rows = await q(
    `select m.qty, m.reason, m.note, m.created_at, m.order_id, o.invoice_no, o.cb_order_id
     from zd.stock_moves m left join zd.orders o on o.id = m.order_id
     where m.product_name = $1 order by m.created_at desc, m.id desc limit 50`,
    [String(name ?? '')],
  );
  return rows.map((r) => ({
    qty: r.qty, reason: r.reason, note: r.note, createdAt: new Date(r.created_at).toISOString(),
    order: r.order_id ? (r.invoice_no ? `№${r.invoice_no}` : String(r.cb_order_id || '').split(':').pop()) : r.reason === 'manual' ? null : 'изтрита',
  }));
}

/** Products (saved + sold) with stock state, the four cards and sales of the last 30 days. */
export async function listInventory(q) {
  const [saved, sold, sold30] = await Promise.all([
    q(`select name, sku, stock, low_stock, unit_cost from zd.product_costs`),
    q(`select distinct it->>'name' as name from zd.orders cross join lateral jsonb_array_elements(items) as it
       where coalesce(it->>'name', '') <> ''`),
    q(`select lower(btrim(it->>'name')) as k, sum(coalesce((it->>'qty')::numeric, 1))::int as qty
       from zd.orders cross join lateral jsonb_array_elements(items) as it
       where status not in ('cancelled', 'returned') and created_at > now() - interval '30 days' group by 1`),
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
