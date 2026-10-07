// Costs & profit (EUR). Product unit costs, per-order cost settings and dated one-off expenses; profit for a period.
import { scope } from './stats.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULTS = { packaging: 0, codFeePct: 0, freeShippingEcont: 0, freeShippingSpeedy: 0, returnCost: 0 };
const round2 = (v) => Math.round(Number(v) * 100) / 100;

function amount(v) {
  const n = Number(v);
  if (v === '' || v == null || typeof v === 'boolean' || !Number.isFinite(n) || n < 0 || n > 100000) throw new Error('invalid value');
  return round2(n);
}
function realDate(s) {
  if (!DATE.test(String(s))) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

async function loadSettings(q) {
  const [row] = await q(`select value from zd.settings where key = 'costs'`);
  const v = row ? (typeof row.value === 'string' ? JSON.parse(row.value) : row.value) : {};
  return Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, Number(v[k] ?? DEFAULTS[k])]));
}

export async function getCosts(q) {
  const [sold, saved, settings, expenses] = await Promise.all([
    q(`select it->>'name' as name, sum(coalesce((it->>'qty')::numeric, 1))::int as qty
       from zd.orders cross join lateral jsonb_array_elements(items) as it
       where status <> 'cancelled' and coalesce(it->>'name', '') <> '' group by 1`),
    q(`select name, unit_cost from zd.product_costs`),
    loadSettings(q),
    q(`select id, to_char(spent_on, 'YYYY-MM-DD') as spent_on, name, amount from zd.expenses order by spent_on desc, created_at desc limit 200`),
  ]);
  // one product per name regardless of capitals/outer spaces: the saved spelling wins
  const key = (n) => String(n).trim().toLowerCase();
  const byKey = new Map(saved.map((r) => [key(r.name), { name: r.name, unitCost: Number(r.unit_cost), soldQty: 0 }]));
  for (const r of sold) {
    const p = byKey.get(key(r.name)) || byKey.set(key(r.name), { name: r.name, unitCost: 0, soldQty: 0 }).get(key(r.name));
    p.soldQty += r.qty;
  }
  const products = [...byKey.values()]
    .sort((a, b) => b.soldQty - a.soldQty || a.name.localeCompare(b.name, 'bg'));
  return {
    products,
    settings,
    expenses: expenses.map((e) => ({ id: e.id, spentOn: e.spent_on, name: e.name, amount: Number(e.amount) })),
  };
}

/** Validates everything first, then saves unit costs and (merged) per-order settings. */
export async function saveCosts(q, { products = [], settings } = {}) {
  const rows = (Array.isArray(products) ? products : []).slice(0, 500).map((p) => {
    const name = String(p?.name ?? '').trim().slice(0, 200);
    if (!name) throw new Error('invalid value');
    return { name, unit_cost: amount(p.unitCost) };
  });
  let next = null;
  if (settings && typeof settings === 'object') {
    next = await loadSettings(q);
    for (const k of Object.keys(DEFAULTS)) if (k in settings) next[k] = amount(settings[k]);
  }
  if (rows.length) {
    // save under the existing spelling of the product (names differing only in capitals are one product)
    const existing = new Map((await q(`select name from zd.product_costs`)).map((r) => [r.name.trim().toLowerCase(), r.name]));
    const byKey = new Map();
    for (const r of rows) { const k = r.name.toLowerCase(); byKey.set(k, { ...r, name: existing.get(k) || byKey.get(k)?.name || r.name }); }
    rows.length = 0; rows.push(...byKey.values());
    await q(
      `insert into zd.product_costs (name, unit_cost, updated_at)
       select name, unit_cost, now() from jsonb_to_recordset($1::text::jsonb) as r(name text, unit_cost numeric)
       on conflict (name) do update set unit_cost = excluded.unit_cost, updated_at = now()`,
      [JSON.stringify(rows)],
    );
  }
  if (next) {
    await q(
      `insert into zd.settings (key, value, updated_at) values ('costs', $1::text::jsonb, now())
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [JSON.stringify(next)],
    );
  }
}

export async function addExpense(q, { spentOn, name, amount: value }) {
  const n = String(name ?? '').trim().slice(0, 120);
  if (!realDate(spentOn) || !n) throw new Error('invalid value');
  const [row] = await q(
    `insert into zd.expenses (spent_on, name, amount) values ($1::date, $2, $3::text::numeric) returning id`,
    [spentOn, n, String(amount(value))],
  );
  return { id: row.id };
}

export async function deleteExpense(q, id) {
  if (!UUID.test(String(id))) return false;
  return (await q(`delete from zd.expenses where id = $1::uuid returning id`, [id])).length > 0;
}

/** Profit before VAT for EUR orders in the period (see docs/superpowers/specs/2026-10-05-costs-profit-design.md). */
export async function getProfit(q, { from, to, store = '' }) {
  const { where, params } = scope({ from, to, store });
  const s = await loadSettings(q);
  const pct = `$${params.length + 1}`;
  const [[o], [pc], [ex]] = await Promise.all([
    q(`with o as (
         select status, courier, total,
           coalesce((select sum(coalesce((it->>'price')::numeric, 0)) from jsonb_array_elements(items) as it), 0) as items_sum
         from zd.orders where ${where} and currency = 'EUR' and status <> 'cancelled')
       select coalesce(sum(items_sum) filter (where status <> 'returned'), 0) as items_revenue,
         count(*)::int as packed,
         coalesce(round(sum(total) filter (where status <> 'returned') * ${pct}::text::numeric / 100, 2), 0) as cod_fee,
         count(*) filter (where total - items_sum < 0.01 and courier = 'econt')::int as free_econt,
         count(*) filter (where total - items_sum < 0.01 and courier = 'speedy')::int as free_speedy,
         count(*) filter (where status = 'returned')::int as returned
       from o`, [...params, String(s.codFeePct)]),
    q(`select coalesce(sum(coalesce((it->>'qty')::numeric, 1) * coalesce(pc.unit_cost, 0)), 0) as cost
       from zd.orders cross join lateral jsonb_array_elements(items) as it
       left join zd.product_costs pc on pc.name = it->>'name'
       where ${where} and currency = 'EUR' and status not in ('cancelled', 'returned')`, params),
    q(`select coalesce(sum(amount), 0) as total from zd.expenses where spent_on between $1::date and $2::date`, [from, to]),
  ]);
  const itemsRevenue = round2(o.items_revenue);
  const productCost = round2(pc.cost);
  const packaging = round2(o.packed * s.packaging);
  const codFee = round2(o.cod_fee);
  const freeShipping = round2(o.free_econt * s.freeShippingEcont + o.free_speedy * s.freeShippingSpeedy);
  const returns = round2(o.returned * s.returnCost);
  const expenses = round2(ex.total);
  const otherCosts = round2(packaging + codFee + freeShipping + returns + expenses);
  const profit = round2(itemsRevenue - productCost - otherCosts);
  return {
    currency: 'EUR', itemsRevenue, productCost, packaging, codFee, freeShipping, returns, expenses, otherCosts, profit,
    margin: itemsRevenue ? Math.round((profit / itemsRevenue) * 10000) / 10000 : null,
  };
}
