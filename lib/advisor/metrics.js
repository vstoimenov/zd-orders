// Ordyx Съветник: one shop's numbers for one day, from what Ordyx already stores (orders, buyers by phone, ad spend, costs,
// carts, stock). Unknown stays null — never zero. Periods are whole Sofia days before `day` (today is not counted).
import { loadSettings } from '../costs.js';
import { adSpendTotals } from '../ads.js';
import { metaConfig } from '../meta.js';
import { openCartsCount } from '../abandoned.js';
import { sofiaDay } from '../visits.js';

const r2 = (v) => Math.round(Number(v) * 100) / 100;
const minus = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) - n * 864e5).toISOString().slice(0, 10);
const at = (p) => `($${p}::date)::timestamp at time zone 'Europe/Sofia'`; // a Sofia day's start as a timestamp
const DEFAULT_RETURN_COST = 5; // € a returned parcel when the shop has not set one (courier both ways, roughly)

// an order that left the shop: a waybill from Ordyx, or a courier status from the platform
const SHIPPED = `(o.waybill_created_at is not null or o.status in ('shipped', 'delivered', 'returned'))`;
const SHIPPED_AT = `coalesce(o.waybill_created_at, o.created_at)`;
const COUNTED = `o.status <> 'cancelled' and o.cb_check <> 'pending' and o.currency = 'EUR'`;

/**
 * Orders of one shop with their margin before ads (like „Финанси“: items without the shipping charge, minus product cost,
 * packaging, the cash-on-delivery fee and free shipping; a returned order costs the return). $1 = shop, $2..$8 = settings.
 */
const WITH_MARGIN = `with o as (
    select o.*, coalesce((select sum(coalesce((it->>'price')::numeric, 0)) from jsonb_array_elements(o.items) it), 0) as items_sum,
      coalesce((select sum(coalesce((it->>'qty')::numeric, 1) * coalesce(pc.unit_cost, 0)) from jsonb_array_elements(o.items) it
        left join zd.product_costs pc on pc.shop_id = o.shop_id and lower(btrim(pc.name)) = lower(btrim(it->>'name'))), 0) as product_cost
    from zd.orders o where o.shop_id = $1::uuid and ${COUNTED}
  ), m as (
    select o.*, case when o.status = 'returned' then -$2::numeric
      else o.items_sum - o.product_cost - $3::numeric - o.total * $4::numeric / 100
        - case when o.total - o.items_sum < 0.01 then (case o.courier when 'econt' then $5::numeric when 'speedy' then $6::numeric when 'boxnow' then $7::numeric else 0 end) else 0 end
      end as margin
    from o
  )`;

export async function shopMetrics(q, shopId, day = sofiaDay()) {
  const s = await loadSettings(q, shopId);
  const returnCost = s.returnCost > 0 ? s.returnCost : DEFAULT_RETURN_COST;
  const set = [shopId, String(returnCost), String(s.packaging), String(s.codFeePct), String(s.freeShippingEcont), String(s.freeShippingSpeedy), String(s.freeShippingBoxnow)];
  const p = set.length; // the next placeholder is $8
  const d30 = minus(day, 30), d60 = minus(day, 60), d7 = minus(day, 7);

  const [[o30], [o7], [costs], [tracked], [cohort], [ret], [risky], stock, [cust], [profile], cfg] = await Promise.all([
    q(`${WITH_MARGIN} select count(*)::int as n, coalesce(sum(total) filter (where status <> 'returned'), 0) as revenue,
         coalesce(sum(total), 0) as gross, coalesce(sum(margin), 0) as margin,
         count(*) filter (where ${SHIPPED.replace(/o\./g, '')} and ${SHIPPED_AT.replace(/o\./g, '')} >= ${at(p + 1)})::int as shipped
       from m where created_at >= ${at(p + 1)} and created_at < ${at(p + 2)}`, [...set, d30, day]),
    q(`select coalesce(sum(o.total) filter (where o.status <> 'returned'), 0) as revenue from zd.orders o
       where o.shop_id = $1::uuid and ${COUNTED} and o.created_at >= ${at(2)} and o.created_at < ${at(3)}`, [shopId, d7, day]),
    q(`select count(*)::int as n from zd.product_costs where shop_id = $1::uuid and unit_cost > 0`, [shopId]),
    // courier statuses reach Ordyx: most parcels sent 30–120 days ago ended as delivered or returned
    q(`select count(*)::int as n, count(*) filter (where o.status in ('delivered', 'returned'))::int as final from zd.orders o
       where o.shop_id = $1::uuid and ${COUNTED} and ${SHIPPED} and ${SHIPPED_AT} >= ${at(2)} and ${SHIPPED_AT} < ${at(3)}`,
      [shopId, minus(day, 120), d30]),
    // new buyers whose first order was 30–60 days ago, and the margin of their orders in their first 30 days
    q(`${WITH_MARGIN}, first as (
         select phone_norm, min(created_at) as first_at from m where phone_norm <> '' group by phone_norm
         having min(created_at) >= ${at(p + 1)} and min(created_at) < ${at(p + 2)})
       select count(distinct f.phone_norm)::int as buyers,
         coalesce(sum(m.margin) filter (where m.status <> 'returned'), 0) as margin_ordered,
         coalesce(sum(m.margin) filter (where m.status in ('delivered', 'returned')), 0) as margin_delivered
       from first f join m on m.phone_norm = f.phone_norm and m.created_at < f.first_at + interval '30 days'`, [...set, d60, d30]),
    // returns by the week a parcel left: only parcels sent at least 21 days ago (a return takes up to three weeks)
    q(`select count(*) filter (where ${SHIPPED_AT} >= ${at(2)})::int as shipped, count(*) filter (where ${SHIPPED_AT} >= ${at(2)} and o.status = 'returned')::int as returned,
         count(*) filter (where ${SHIPPED_AT} < ${at(2)})::int as base_shipped, count(*) filter (where ${SHIPPED_AT} < ${at(2)} and o.status = 'returned')::int as base_returned
       from zd.orders o where o.shop_id = $1::uuid and ${COUNTED} and ${SHIPPED} and ${SHIPPED_AT} >= ${at(3)} and ${SHIPPED_AT} < ${at(4)}`,
      [shopId, minus(day, 51), minus(day, 141), minus(day, 21)]),
    // parcels to customers flagged in НЕкоректен that left without the customer's „yes“; and how often such parcels come back
    q(`select count(*) filter (where o.created_at >= ${at(2)} and coalesce(o.confirm_answer, '') <> 'yes')::int as n,
         count(*) filter (where o.status in ('delivered', 'returned'))::int as final, count(*) filter (where o.status = 'returned')::int as returned
       from zd.orders o where o.shop_id = $1::uuid and ${COUNTED} and o.nk_status = 'flagged' and ${SHIPPED} and o.created_at >= ${at(3)} and o.created_at < ${at(4)}`,
      [shopId, d30, minus(day, 180), day]),
    // the 3 products with the most revenue in 30 days that have stock tracked: days left at the pace of the last 14 days
    q(`with it as (
         select lower(btrim(it->>'name')) as key, max(btrim(it->>'name')) as name, sum(coalesce((it->>'qty')::numeric, 1)) as qty,
           sum(coalesce((it->>'qty')::numeric, 1)) filter (where o.created_at >= ${at(3)}) as qty14, sum(coalesce((it->>'price')::numeric, 0)) as revenue
         from zd.orders o cross join lateral jsonb_array_elements(o.items) it
         where o.shop_id = $1::uuid and ${COUNTED} and o.status <> 'returned' and o.created_at >= ${at(2)} and o.created_at < ${at(4)}
         group by 1), tot as (select sum(revenue) as all_rev from it)
       select it.name, it.qty, coalesce(it.qty14, 0) as qty14, it.revenue, tot.all_rev, pc.stock, coalesce(pc.unit_cost, 0) as unit_cost
       from it cross join tot join zd.product_costs pc on pc.shop_id = $1::uuid and lower(btrim(pc.name)) = it.key
       where pc.stock is not null order by it.revenue desc limit 3`, [shopId, d30, minus(day, 14), day]),
    // buyers (by phone) seen in the last 365 days; sleeping = last order 90–365 days ago and at least one order not returned
    q(`with c as (select o.phone_norm, max(o.created_at) as last_at, bool_or(o.status <> 'returned') as kept from zd.orders o
         where o.shop_id = $1::uuid and ${COUNTED} and o.phone_norm <> '' and o.created_at < ${at(3)} group by 1)
       select count(*) filter (where last_at >= ${at(2)})::int as active365,
         count(*) filter (where last_at >= ${at(2)} and last_at < ${at(4)} and kept)::int as sleeping from c`,
      [shopId, minus(day, 365), day, minus(day, 90)]),
    q(`select value from zd.settings where key = $1`, [`advisor:${shopId}`]),
    metaConfig(q, shopId).catch(() => null),
  ]);
  const [ads30, ads7, adsCohort, carts] = await Promise.all([
    adSpendTotals(q, { from: d30, to: minus(day, 1), shopId }),
    adSpendTotals(q, { from: d7, to: minus(day, 1), shopId }),
    adSpendTotals(q, { from: d60, to: minus(day, 31), shopId }),
    openCartsCount(q, { shopId, from: d30 }),
  ]);

  const orders30 = o30.n, revenue30 = r2(o30.revenue), contribution30 = r2(o30.margin);
  const meta = Boolean(cfg);
  const marginKnown = costs.n > 0;
  const statusTracked = tracked.n >= 10 && tracked.final / tracked.n >= 0.5;
  const pf = profile ? (typeof profile.value === 'string' ? JSON.parse(profile.value) : profile.value) : {};

  // payback: by delivered parcels when couriers report them, else by orders not returned (cash on delivery is paid at delivery)
  const cohortMargin = r2(statusTracked ? cohort.margin_delivered : cohort.margin_ordered);
  const payback = meta && marginKnown && cohort.buyers >= 5 && adsCohort.spend >= 30
    ? { value: r2(cohortMargin / adsCohort.spend), newBuyers: cohort.buyers, spend: adsCohort.spend, margin: cohortMargin, byDelivery: statusTracked } : null;

  return {
    day, orders30, revenue30, aov: orders30 ? r2(Number(o30.gross) / orders30) : 0, contribution30, marginKnown,
    marginPerOrder: marginKnown && orders30 ? r2(contribution30 / orders30) : null,
    meta, spend30: meta ? ads30.spend : null, spend7: meta ? ads7.spend : null, revenue7: r2(o7.revenue),
    roas7: meta && ads7.spend > 0 ? r2(Number(o7.revenue) / ads7.spend) : null,
    breakEvenRoas: marginKnown && contribution30 > 0 ? r2(revenue30 / contribution30) : null,
    payback, statusTracked, shipped30: o30.shipped, returnCost, returnCostSet: s.returnCost > 0,
    returns: ret.shipped || ret.base_shipped ? {
      rate: ret.shipped ? r2((ret.returned / ret.shipped) * 1000) / 1000 : null, shipped: ret.shipped,
      base: ret.base_shipped ? r2((ret.base_returned / ret.base_shipped) * 1000) / 1000 : null, baseShipped: ret.base_shipped,
    } : null,
    risky: { count: risky.n, returnRate: risky.final >= 10 ? r2(risky.returned / risky.final) : 0.3 },
    stock: stock.map((x) => {
      const perDay = Number(x.qty14) / 14;
      return {
        name: x.name, stock: Number(x.stock), daysLeft: perDay > 0 ? r2(Number(x.stock) / perDay) : null,
        revenueShare: Number(x.all_rev) > 0 ? r2(Number(x.revenue) / Number(x.all_rev)) : 0,
        marginPerDay: r2((Number(x.revenue) - Number(x.qty) * Number(x.unit_cost)) / 30),
      };
    }),
    carts: { open: carts }, customers: { sleeping: cust.sleeping, active365: cust.active365 },
    repeatProfile: ['often', 'sometimes', 'rarely'].includes(pf.repeatProfile) ? pf.repeatProfile : '',
  };
}
