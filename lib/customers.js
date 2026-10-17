// Customers of a shop = its orders grouped by phone. Lifetime value counts orders that were not cancelled or returned.
const SLEEP = "interval '90 days'";
const PAID = "o.status not in ('cancelled', 'returned')";
const SEGMENTS = {
  new: `per.orders = 1 and per.last_at >= now() - ${SLEEP}`,
  returning: `per.orders >= 2 and per.last_at >= now() - ${SLEEP}`,
  vip: '(per.orders >= 3 or per.spent >= 150)',
  sleeping: `per.last_at < now() - ${SLEEP}`,
  risky: '(per.returned > 0 or per.flagged)',
};
const SORTS = { spent: 'per.spent desc, per.orders desc', orders: 'per.orders desc, per.spent desc', last: 'per.last_at desc' };
const PAGE = 100;

function base({ shopId = null, shopIds = null }, params) {
  let scope = '';
  if (shopId) { params.push(String(shopId)); scope = ` and o.shop_id = $${params.length}::uuid`; }
  else if (shopIds) { params.push(shopIds.map(String)); scope = ` and o.shop_id = any($${params.length}::uuid[])`; }
  return `with per as (
    select o.shop_id, o.phone_norm,
      (array_agg(o.name order by o.created_at desc))[1] as name,
      (array_agg(o.email order by (o.email = ''), o.created_at desc))[1] as email,
      (array_agg(o.currency order by o.created_at desc))[1] as currency,
      count(*)::int as orders, count(*) filter (where ${PAID})::int as paid_orders,
      coalesce(sum(o.total) filter (where ${PAID}), 0) as spent,
      count(*) filter (where o.status = 'delivered')::int as delivered, count(*) filter (where o.status = 'returned')::int as returned,
      min(o.created_at) as first_at, max(o.created_at) as last_at, bool_or(o.nk_status = 'flagged') as flagged
    from zd.orders o where o.phone_norm <> '' and o.cb_check <> 'pending'${scope}
    group by o.shop_id, o.phone_norm)`;
}

const round2 = (v) => Math.round(Number(v) * 100) / 100;
function toCustomer(r) {
  const spent = round2(r.spent);
  const c = {
    shopId: r.shop_id, phoneNorm: r.phone_norm, name: r.name, email: r.email, currency: r.currency, orders: r.orders, spent,
    avgOrder: r.paid_orders ? round2(spent / r.paid_orders) : 0, delivered: r.delivered, returned: r.returned,
    firstOrderAt: new Date(r.first_at).toISOString(), lastOrderAt: new Date(r.last_at).toISOString(), flagged: Boolean(r.flagged),
  };
  const sleeping = Date.now() - Date.parse(c.lastOrderAt) > 90 * 86400e3;
  c.segments = [
    !sleeping && c.orders === 1 && 'new', !sleeping && c.orders >= 2 && 'returning', (c.orders >= 3 || spent >= 150) && 'vip',
    sleeping && 'sleeping', (c.returned > 0 || c.flagged) && 'risky',
  ].filter(Boolean);
  return c;
}

/** One page of customers; search by name or phone, filter by segment, sort by spent | orders | last. */
export async function listCustomers(q, { shopId = null, shopIds = null, search = '', segment = '', sort = 'spent', page = 1, pageSize = PAGE } = {}) {
  const params = [];
  const sql = base({ shopId, shopIds }, params);
  const where = [];
  if (Object.hasOwn(SEGMENTS, segment)) where.push(SEGMENTS[segment]);
  const s = String(search).trim().slice(0, 60);
  if (s) {
    params.push(`%${s}%`);
    const byName = `per.name ilike $${params.length}`;
    const digits = s.replace(/\D/g, '').replace(/^0/, '');
    if (digits.length >= 3) { params.push(`%${digits}%`); where.push(`(${byName} or per.phone_norm like $${params.length})`); } else where.push(byName);
  }
  const size = Math.min(Math.max(1, Math.trunc(pageSize) || PAGE), 5000);
  const offset = (Math.max(1, Math.min(Math.trunc(page) || 1, 100000)) - 1) * size;
  const rows = await q(`${sql} select per.*, count(*) over () as full_count from per ${where.length ? `where ${where.join(' and ')}` : ''}
     order by ${SORTS[sort] || SORTS.spent}, per.phone_norm limit ${size} offset ${offset}`, params);
  return { rows: rows.map(toCustomer), total: rows.length ? Number(rows[0].full_count) : 0 };
}

/** Dashboard: how many customers, how many came back, average lifetime value. */
export async function customerSummary(q, scope = {}) {
  const params = [];
  const [r] = await q(`${base(scope, params)} select count(*)::int as customers, count(*) filter (where orders >= 2)::int as repeat, coalesce(avg(spent), 0) as avg from per`, params);
  return { customers: r.customers, repeat: r.repeat, repeatShare: r.customers ? r.repeat / r.customers : 0, avgValue: round2(r.avg) };
}
