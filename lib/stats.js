// Dashboard figures computed from zd.orders. Dates are Europe/Sofia calendar days; "store" is the domain prefix of cb_order_id.
import { adSpendTotals } from './ads.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ACTIVE = `status <> 'cancelled'`;
const round2 = (v) => Math.round(Number(v) * 100) / 100;

export function scope({ from, to, store }) {
  if (!DATE.test(from) || !DATE.test(to)) throw new Error('invalid period');
  const params = [from, to];
  let where = `created_at >= ($1::date)::timestamp at time zone 'Europe/Sofia' and created_at < ($2::date + 1)::timestamp at time zone 'Europe/Sofia'`;
  if (store) { params.push(String(store)); where += ` and split_part(cb_order_id, ':', 1) = $3`; }
  return { where, params };
}

const money = (rows, key) => rows.filter((r) => r[key] != null).map((r) => ({ currency: r.currency, amount: round2(r[key]) }));

export async function getStats(q, { from, to, store = '' }) {
  const { where, params } = scope({ from, to, store });
  const vParams = store ? [from, to, String(store)] : [from, to];
  const vSite = store ? ' and site = $3' : '';
  const [byCurrency, [totals], daily, byDelivery, byStatus, top, recent, stores, visitSources, orderSources, ads] = await Promise.all([
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
    q(`select distinct split_part(cb_order_id, ':', 1) as store from zd.orders order by 1`),
    // a visit = one anonymous visitor on one day, credited to the first source of that day
    q(`with vd as (select distinct on (day, visitor) day, visitor, source from zd.visits
         where day between $1::date and $2::date${vSite} order by day, visitor, created_at, id)
       select source, count(*)::int as visits from vd group by 1`, vParams),
    q(`select traffic_source as source, count(*)::int as orders from zd.orders where ${where} group by 1`, params),
    adSpendTotals(q, { from, to }),
  ]);
  const visits = visitSources.reduce((n, r) => n + r.visits, 0);
  const bySource = new Map(visitSources.map((r) => [r.source, { source: r.source, visits: r.visits, orders: 0 }]));
  for (const r of orderSources) (bySource.get(r.source) || bySource.set(r.source, { source: r.source, visits: 0, orders: 0 }).get(r.source)).orders = r.orders;
  const sources = [...bySource.values()].sort((a, b) => (a.source === '') - (b.source === '') || b.visits - a.visits || b.orders - a.orders || a.source.localeCompare(b.source));
  const revenue = money(byCurrency, 'revenue');
  return {
    period: { from, to },
    stores: stores.map((r) => r.store),
    cards: {
      orders: totals.orders,
      revenue,
      delivered: money(byCurrency, 'delivered'),
      aov: byCurrency.filter((r) => r.active > 0).map((r) => ({ currency: r.currency, amount: round2(Number(r.revenue) / r.active) })),
      returnRate: totals.sent ? totals.returned / totals.sent : null,
      nkFlagged: totals.nk,
      nkFlaggedPct: totals.orders ? totals.nk / totals.orders : null,
      visits,
      cr: visits ? totals.orders / visits : null,
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
