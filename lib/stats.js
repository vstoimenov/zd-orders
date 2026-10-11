// Dashboard figures computed from zd.orders. Dates are Europe/Sofia calendar days; "store" is the domain prefix of cb_order_id.
import { adSpendTotals } from './ads.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ACTIVE = `status <> 'cancelled'`;
const round2 = (v) => Math.round(Number(v) * 100) / 100;

/** shopId = one shop; else shopIds = these shops (a client's "all"); neither = every shop. */
export function scope({ from, to, shopId = null, shopIds = null }) {
  if (!DATE.test(from) || !DATE.test(to)) throw new Error('invalid period');
  const params = [from, to];
  let where = `created_at >= ($1::date)::timestamp at time zone 'Europe/Sofia' and created_at < ($2::date + 1)::timestamp at time zone 'Europe/Sofia'`;
  // qualified: some queries join products
  if (shopId) { params.push(String(shopId)); where += ` and zd.orders.shop_id = $3::uuid`; }
  else if (shopIds) { params.push(shopIds.map(String)); where += ` and zd.orders.shop_id = any($3::uuid[])`; }
  return { where, params };
}

const money = (rows, key) => rows.filter((r) => r[key] != null).map((r) => ({ currency: r.currency, amount: round2(r[key]) }));

export async function getStats(q, { from, to, shopId = null, shopIds = null }) {
  const { where, params } = scope({ from, to, shopId, shopIds });
  const only = shopId ? [String(shopId)] : shopIds ? shopIds.map(String) : null; // null = every shop
  const vParams = only ? [from, to, only] : [from, to];
  const vShop = only ? ' and shop_id = any($3::uuid[])' : '';
  const [byCurrency, [totals], daily, byDelivery, byStatus, top, recent, visitSources, orderSources, ads, [since]] = await Promise.all([
    q(`select currency, count(*) filter (where ${ACTIVE})::int as active,
         sum(total) filter (where ${ACTIVE}) as revenue, sum(total) filter (where status = 'delivered') as delivered
       from zd.orders where ${where} group by currency order by currency`, params),
    q(`select count(*)::int as orders,
         count(*) filter (where status in ('shipped', 'delivered', 'returned'))::int as sent,
         count(*) filter (where status = 'returned')::int as returned,
         count(*) filter (where nk_status = 'flagged')::int as nk
       from zd.orders where ${where}`, params),
    q(`select to_char(created_at at time zone 'Europe/Sofia', 'YYYY-MM-DD') as day, count(*)::int as orders,
         coalesce(sum(total) filter (where ${ACTIVE}), 0) as revenue
       from zd.orders where ${where} group by 1 order by 1`, params),
    q(`select delivery_type, count(*)::int as orders, coalesce(sum(total) filter (where ${ACTIVE}), 0) as revenue
       from zd.orders where ${where} group by 1 order by 2 desc, 1`, params),
    q(`select status, count(*)::int as orders from zd.orders where ${where} group by 1 order by 2 desc, 1`, params),
    q(`select it->>'name' as name, sum(coalesce((it->>'qty')::numeric, 1))::int as qty, sum(coalesce((it->>'price')::numeric, 0)) as revenue
       from zd.orders, jsonb_array_elements(items) as it
       where ${where} and ${ACTIVE} and coalesce(it->>'name', '') <> ''
       group by 1 order by 2 desc, 3 desc, 1 limit 10`, params),
    q(`select id, created_at, name, total, currency, status, office_text from zd.orders where ${where} order by created_at desc limit 10`, params),
    // a visit = one anonymous visitor on one day, credited to the first source of that day
    q(`with vd as (select distinct on (day, visitor) day, visitor, source from zd.visits
         where day between $1::date and $2::date${vShop} order by day, visitor, created_at, id)
       select source, count(*)::int as visits from vd group by 1`, vParams),
    q(`select traffic_source as source, count(*)::int as orders from zd.orders where ${where} group by 1`, params),
    adSpendTotals(q, { from, to, shopId, shopIds }),
    // CR only makes sense for orders placed after we started counting visits
    q(`select min(created_at) as at from zd.visits${only ? ' where shop_id = any($1::uuid[])' : ''}`, only ? [only] : []),
  ]);
  const visitsSince = since?.at ? new Date(since.at).toISOString() : null;
  const [tracked] = visitsSince
    ? await q(`select count(*)::int as n from zd.orders where ${where} and created_at >= $${params.length + 1}::timestamptz`, [...params, visitsSince])
    : [{ n: 0 }];
  const visits = visitSources.reduce((n, r) => n + r.visits, 0);
  const bySource = new Map(visitSources.map((r) => [r.source, { source: r.source, visits: r.visits, orders: 0 }]));
  for (const r of orderSources) (bySource.get(r.source) || bySource.set(r.source, { source: r.source, visits: 0, orders: 0 }).get(r.source)).orders = r.orders;
  const sources = [...bySource.values()].sort((a, b) => (a.source === '') - (b.source === '') || b.visits - a.visits || b.orders - a.orders || a.source.localeCompare(b.source));
  const revenue = money(byCurrency, 'revenue');
  return {
    period: { from, to },
    cards: {
      orders: totals.orders,
      revenue,
      delivered: money(byCurrency, 'delivered'),
      aov: byCurrency.filter((r) => r.active > 0).map((r) => ({ currency: r.currency, amount: round2(Number(r.revenue) / r.active) })),
      returnRate: totals.sent ? totals.returned / totals.sent : null,
      nkFlagged: totals.nk,
      nkFlaggedPct: totals.orders ? totals.nk / totals.orders : null,
      visits,
      cr: visits ? tracked.n / visits : null,
      visitsSince,
    },
    sources,
    ads,
    daily: daily.map((r) => ({ day: r.day, orders: r.orders, revenue: round2(r.revenue) })),
    byDelivery: byDelivery.map((r) => ({ deliveryType: r.delivery_type, orders: r.orders, revenue: round2(r.revenue) })),
    byStatus: byStatus.map((r) => ({ status: r.status, orders: r.orders })),
    topProducts: top.map((r) => ({ name: r.name, qty: r.qty, revenue: round2(r.revenue) })),
    recent: recent.map((r) => ({
      id: r.id, createdAt: new Date(r.created_at).toISOString(), name: r.name, total: Number(r.total),
      currency: r.currency, status: r.status, officeText: r.office_text,
    })),
  };
}
