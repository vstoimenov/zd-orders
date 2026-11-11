// Ordyx Съветник: one shop's numbers for one day, from what Ordyx already stores (orders, buyers by phone, ad spend, costs,
// carts, stock). Unknown stays null — never zero. Periods are whole Sofia days before `day` (today is not counted).
import { loadSettings } from '../costs.js';
import { adSpendTotals } from '../ads.js';
import { metaConfig } from '../meta.js';
import { openCartsCount } from '../abandoned.js';
import { sofiaDay } from '../visits.js';
import { getIntegration } from '../integrations-repo.js';

const r2 = (v) => Math.round(Number(v) * 100) / 100;
const minus = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) - n * 864e5).toISOString().slice(0, 10);
const at = (p) => `($${p}::date)::timestamp at time zone 'Europe/Sofia'`; // a Sofia day's start as a timestamp
const DEFAULT_RETURN_COST = 5; // € a returned parcel when the shop has not set one (courier both ways, roughly)

// an order that left the shop: a waybill from Ordyx, or a courier status from the platform
const SHIPPED = `(o.waybill_created_at is not null or o.status in ('shipped', 'delivered', 'returned'))`;
const SHIPPED_AT = `coalesce(o.waybill_created_at, o.created_at)`;
const COUNTED = `o.status <> 'cancelled' and o.cb_check <> 'pending' and o.currency = 'EUR'`;

/**
 * Orders of one shop with their margin before ads, the same as „Финанси“ (getProfit without one-off expenses): items without the
 * shipping charge, minus product cost, packaging, the cash-on-delivery fee and free shipping; a returned order costs the return,
 * packaging and free shipping. $1 = shop, $2..$7 = settings.
 */
const WITH_MARGIN = `with o as (
    select o.*, coalesce((select sum(coalesce((it->>'price')::numeric, 0)) from jsonb_array_elements(o.items) it), 0) as items_sum,
      coalesce((select sum(coalesce((it->>'qty')::numeric, 1) * coalesce(pc.unit_cost, 0)) from jsonb_array_elements(o.items) it
        left join zd.product_costs pc on pc.shop_id = o.shop_id and lower(btrim(pc.name)) = lower(btrim(it->>'name'))), 0) as product_cost
    from zd.orders o where o.shop_id = $1::uuid and ${COUNTED}
  ), m as (
    -- as „Финанси“: packaging and free shipping for every parcel sent; a returned one brings nothing and costs the return
    select o.*, case when o.status = 'returned' then -$2::numeric else o.items_sum - o.product_cost - o.total * $4::numeric / 100 end
        - $3::numeric
        - case when o.total - o.items_sum < 0.01 then (case o.courier when 'econt' then $5::numeric when 'speedy' then $6::numeric when 'boxnow' then $7::numeric else 0 end) else 0 end
      as margin
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
         coalesce(sum(m.margin), 0) as margin_ordered, -- returns count as the loss they are
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
    // the shop's 3 products with the most revenue in 30 days (those with stock tracked): days left at the pace of the last 14 days
    q(`with it as (
         select lower(btrim(it->>'name')) as key, max(btrim(it->>'name')) as name, sum(coalesce((it->>'qty')::numeric, 1)) as qty,
           sum(coalesce((it->>'qty')::numeric, 1)) filter (where o.created_at >= ${at(3)}) as qty14, sum(coalesce((it->>'price')::numeric, 0)) as revenue
         from zd.orders o cross join lateral jsonb_array_elements(o.items) it
         where o.shop_id = $1::uuid and ${COUNTED} and o.status <> 'returned' and o.created_at >= ${at(2)} and o.created_at < ${at(4)}
         group by 1), tot as (select sum(revenue) as all_rev from it),
       top as (select * from it order by revenue desc limit 3)
       select top.name, top.qty, coalesce(top.qty14, 0) as qty14, top.revenue, tot.all_rev, pc.stock, coalesce(pc.unit_cost, 0) as unit_cost
       from top cross join tot join zd.product_costs pc on pc.shop_id = $1::uuid and lower(btrim(pc.name)) = top.key
       where pc.stock is not null order by top.revenue desc`, [shopId, d30, minus(day, 14), day]),
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
  // a connected courier only reports parcels sent with Ordyx waybills: tell the shop which of the two is missing
  const [cour] = await q(`select count(*)::int as n from zd.integrations where shop_id = $1::uuid and provider in ('econt', 'speedy', 'boxnow')
     and secret_enc is not null and coalesce(config->>'active', 'true') <> 'false'`, [shopId]);
  const pf = profile ? (typeof profile.value === 'string' ? JSON.parse(profile.value) : profile.value) : {};

  // payback: by delivered parcels when couriers report them, else by orders not returned (cash on delivery is paid at delivery)
  const cohortMargin = r2(statusTracked ? cohort.margin_delivered : cohort.margin_ordered);
  const payback = meta && marginKnown && cohort.buyers >= 5 && adsCohort.spend >= 30
    ? { value: r2(cohortMargin / adsCohort.spend), newBuyers: cohort.buyers, spend: adsCohort.spend, margin: cohortMargin, byDelivery: statusTracked } : null;

  const [growth, order] = await Promise.all([
    growthMetrics(q, shopId, day, { meta, spend30: meta ? ads30.spend : null }),
    orderMetrics(q, shopId, day, { returnCost }),
  ]);
  return {
    ...growth, ...order,
    day, orders30, revenue30, aov: orders30 ? r2(Number(o30.gross) / orders30) : 0, contribution30, marginKnown,
    marginPerOrder: marginKnown && orders30 ? r2(contribution30 / orders30) : null,
    meta, spend30: meta ? ads30.spend : null, spend7: meta ? ads7.spend : null, revenue7: r2(o7.revenue),
    roas7: meta && ads7.spend > 0 ? r2(Number(o7.revenue) / ads7.spend) : null,
    breakEvenRoas: marginKnown && contribution30 > 0 ? r2(revenue30 / contribution30) : null,
    payback, statusTracked, couriers: { connected: cour.n > 0, shipped: tracked.n, final: tracked.final }, shipped30: o30.shipped, returnCost, returnCostSet: s.returnCost > 0,
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

const median = (col) => `percentile_cont(0.5) within group (order by ${col})`;
const HOURS = `extract(epoch from (o.waybill_created_at - o.created_at)) / 3600`;
const rate = (num, den) => (den ? Math.round((num / den) * 1000) / 1000 : null);

/**
 * Stage 2 numbers: how fast parcels leave, the price of a new buyer, conversion of visits, second orders, refusals at
 * confirmation, last month's payback, the history Ordyx has and how often buyers come back. Each against the shop's
 * previous 90 days.
 */
export async function growthMetrics(q, shopId, day, { meta, spend30 }) {
  const d30 = minus(day, 30), d120 = minus(day, 120);
  const [[ship], [speed], [buyers], [visits], [rep], [ref], [prev], [hist], [gap], cb] = await Promise.all([
    // hours from the order to the waybill (Ordyx waybills only: those carry the time)
    q(`select count(*) filter (where o.created_at >= ${at(2)})::int as n, ${median(HOURS)} filter (where o.created_at >= ${at(2)}) as median,
         count(*) filter (where o.created_at < ${at(2)})::int as base_n, ${median(HOURS)} filter (where o.created_at < ${at(2)}) as base_median,
         count(*) filter (where o.created_at >= ${at(2)} and ${HOURS} > 48)::int as slow
       from zd.orders o where o.shop_id = $1::uuid and ${COUNTED} and o.waybill_created_at is not null
         and o.created_at >= ${at(3)} and o.created_at < ${at(4)}`, [shopId, d30, d120, day]),
    // do slow parcels come back more often? (180 days, parcels that ended)
    q(`select count(*) filter (where ${HOURS} > 48)::int as slow_n, count(*) filter (where ${HOURS} > 48 and o.status = 'returned')::int as slow_ret,
         count(*) filter (where ${HOURS} <= 48)::int as fast_n, count(*) filter (where ${HOURS} <= 48 and o.status = 'returned')::int as fast_ret
       from zd.orders o where o.shop_id = $1::uuid and ${COUNTED} and o.waybill_created_at is not null and o.status in ('delivered', 'returned')
         and o.created_at >= ${at(2)} and o.created_at < ${at(3)}`, [shopId, minus(day, 180), day]),
    // new buyers (first order by phone) now and in the 90 days before
    q(`with f as (select o.phone_norm, min(o.created_at) as first_at from zd.orders o
         where o.shop_id = $1::uuid and ${COUNTED} and o.phone_norm <> '' group by 1)
       select count(*) filter (where first_at >= ${at(2)} and first_at < ${at(4)})::int as n30,
         count(*) filter (where first_at >= ${at(3)} and first_at < ${at(2)})::int as base_n from f`, [shopId, d30, d120, day]),
    // visits (one per visitor and day) since tracking began, and orders on the same days
    q(`with v as (select day, count(*)::int as n from zd.visits where shop_id = $1::uuid and day >= $3::date and day < $4::date group by day),
         t as (select min(day) as since from zd.visits where shop_id = $1::uuid)
       select coalesce(sum(n) filter (where day >= $2::date), 0)::int as visits30, coalesce(sum(n) filter (where day < $2::date), 0)::int as base_visits,
         count(*) filter (where day < $2::date)::int as base_days, (select since from t) as since,
         (select count(*) from zd.orders o where o.shop_id = $1::uuid and ${COUNTED} and o.created_at >= ($2::date)::timestamp at time zone 'Europe/Sofia'
            and o.created_at < ($4::date)::timestamp at time zone 'Europe/Sofia')::int as orders30,
         (select count(*) from zd.orders o where o.shop_id = $1::uuid and ${COUNTED}
            and o.created_at >= (greatest($3::date, coalesce((select since from t), $2::date)))::timestamp at time zone 'Europe/Sofia'
            and o.created_at < ($2::date)::timestamp at time zone 'Europe/Sofia')::int as base_orders
       from v`, [shopId, d30, d120, day]),
    // new buyers of 60–90 days ago (and of 90–180 days ago): how many ordered a second time within 60 days
    q(`with f as (select o.phone_norm, min(o.created_at) as first_at from zd.orders o
         where o.shop_id = $1::uuid and ${COUNTED} and o.phone_norm <> '' group by 1),
       c as (select f.*, exists (select 1 from zd.orders o where o.shop_id = $1::uuid and ${COUNTED} and o.phone_norm = f.phone_norm
         and o.created_at > f.first_at + interval '1 hour' and o.created_at < f.first_at + interval '60 days') as again from f)
       select count(*) filter (where first_at >= ${at(3)} and first_at < ${at(2)})::int as n, count(*) filter (where first_at >= ${at(3)} and first_at < ${at(2)} and again)::int as again,
         count(*) filter (where first_at >= ${at(4)} and first_at < ${at(3)})::int as base_n, count(*) filter (where first_at >= ${at(4)} and first_at < ${at(3)} and again)::int as base_again
       from c`, [shopId, minus(day, 60), minus(day, 90), minus(day, 180)]),
    // the customers' answers to the confirmation message
    q(`select count(*) filter (where o.confirm_answered_at >= ${at(2)})::int as answered, count(*) filter (where o.confirm_answered_at >= ${at(2)} and o.confirm_answer = 'no')::int as no,
         count(*) filter (where o.confirm_answered_at < ${at(2)})::int as base_answered, count(*) filter (where o.confirm_answered_at < ${at(2)} and o.confirm_answer = 'no')::int as base_no
       from zd.orders o where o.shop_id = $1::uuid and o.cb_check <> 'pending' and o.confirm_answer in ('yes', 'no')
         and o.confirm_answered_at >= ${at(3)} and o.confirm_answered_at < ${at(4)}`, [shopId, d30, d120, day]),
    // the payback a month ago (the stored numbers of that day, a few days either side)
    q(`select metrics->'payback'->>'value' as value from zd.advisor_daily where shop_id = $1::uuid and day between $2::date and $3::date
       order by abs(day - $4::date) limit 1`, [shopId, minus(day, 33), minus(day, 27), d30]),
    q(`select min(o.created_at) as first_at from zd.orders o where o.shop_id = $1::uuid and o.status <> 'cancelled'`, [shopId]),
    // days between a buyer's first and second order (for the shop's profile)
    q(`with r as (select o.phone_norm, o.created_at, row_number() over (partition by o.phone_norm order by o.created_at) as k from zd.orders o
         where o.shop_id = $1::uuid and ${COUNTED} and o.phone_norm <> ''),
       g as (select extract(epoch from (b.created_at - a.created_at)) / 86400 as days from r a join r b on b.phone_norm = a.phone_norm and a.k = 1 and b.k = 2)
       select count(*)::int as n, ${median('days')} as median from g`, [shopId]),
    getIntegration(q, 'convertbuilder', shopId).catch(() => null),
  ]);

  const shipOut = ship.n >= 20 && ship.base_n >= 20 ? {
    median: r2(ship.median), base: r2(ship.base_median), n: ship.n, baseN: ship.base_n, slow30: ship.slow,
    slowReturnRate: speed.slow_n >= 10 ? rate(speed.slow_ret, speed.slow_n) : null, fastReturnRate: speed.fast_n >= 10 ? rate(speed.fast_ret, speed.fast_n) : null,
  } : null;
  // the price of a new buyer: this month's spend ÷ new buyers, against the 90 days before (needs ads in both)
  let newBuyers = { n30: buyers.n30, cac: null, cacBase: null };
  if (meta) {
    const base = await adSpendTotals(q, { from: d120, to: minus(day, 31), shopId });
    newBuyers = {
      n30: buyers.n30, cac: buyers.n30 >= 10 && spend30 > 0 ? r2(spend30 / buyers.n30) : null,
      cacBase: buyers.base_n >= 15 && base.spend >= 30 ? r2(base.spend / buyers.base_n) : null,
    };
  }
  const conversion = visits.visits30 >= 100 && visits.base_visits >= 300 && visits.base_days >= 30 ? {
    rate: rate(visits.orders30, visits.visits30), base: rate(visits.base_orders, visits.base_visits), visits30: visits.visits30,
    visitsPerDay: r2(visits.visits30 / 30), baseVisitsPerDay: r2(visits.base_visits / visits.base_days),
  } : null;
  const firstAt = hist.first_at ? new Date(hist.first_at) : null;
  const historyDays = firstAt ? Math.floor((Date.parse(`${day}T00:00:00Z`) - firstAt.getTime()) / 864e5) : 0;
  const g = gap.n >= 20 && historyDays >= 180 ? Number(gap.median) : null;
  return {
    ship: shipOut, newBuyers, conversion,
    repeat60: rep.n >= 30 && rep.base_n >= 30 ? { rate: rate(rep.again, rep.n), base: rate(rep.base_again, rep.base_n), n: rep.n, baseN: rep.base_n } : null,
    refusals: ref.answered >= 20 ? { rate: rate(ref.no, ref.answered), base: ref.base_answered >= 20 ? rate(ref.base_no, ref.base_answered) : null, answered: ref.answered, refused: ref.no } : null,
    paybackMonthAgo: prev?.value != null ? Number(prev.value) : null,
    history: { days: historyDays, cb: Boolean(cb?.hasSecret && cb.config.active !== false) },
    profileSuggested: g == null ? '' : g <= 60 ? 'often' : g <= 180 ? 'sometimes' : 'rarely',
    secondOrderDays: g == null ? null : Math.round(g),
  };
}

const ITEMS_SUM = `coalesce((select sum(coalesce((it->>'price')::numeric, 0)) from jsonb_array_elements(o.items) it), 0)`;
const UNITS = `coalesce((select sum(coalesce((it->>'qty')::numeric, 1)) from jsonb_array_elements(o.items) it), 0)`;

/**
 * Stage 3 numbers: the order itself (average now and before, units, one-product orders, the free-shipping threshold as the
 * shop's own orders show it), where orders come from, and the funnel from visit to delivery with the euros lost at each step.
 */
export async function orderMetrics(q, shopId, day, { returnCost }) {
  const d30 = minus(day, 30), d120 = minus(day, 120);
  // the funnel looks at orders of 14–44 days ago: by now most of them were delivered or came back
  const f0 = minus(day, 44), f1 = minus(day, 14);
  const [[basket], [free], channels, [funnel]] = await Promise.all([
    q(`select count(*) filter (where o.created_at >= ${at(2)})::int as n, avg(o.total) filter (where o.created_at >= ${at(2)}) as aov,
         avg(${UNITS}) filter (where o.created_at >= ${at(2)}) as units, count(*) filter (where o.created_at >= ${at(2)} and ${UNITS} = 1)::int as single,
         count(*) filter (where o.created_at < ${at(2)})::int as base_n, avg(o.total) filter (where o.created_at < ${at(2)}) as base_aov
       from zd.orders o where o.shop_id = $1::uuid and ${COUNTED} and o.created_at >= ${at(3)} and o.created_at < ${at(4)}`, [shopId, d30, d120, day]),
    // free shipping: orders whose total is just the items; the threshold is the smallest such basket, if no paid one is above it
    q(`with x as (select ${ITEMS_SUM} as items, o.total - ${ITEMS_SUM} < 0.01 as free from zd.orders o
         where o.shop_id = $1::uuid and ${COUNTED} and o.created_at >= ${at(2)} and o.created_at < ${at(3)})
       select count(*) filter (where free)::int as free_n, count(*) filter (where not free)::int as paid_n,
         min(items) filter (where free) as min_free, max(items) filter (where not free) as max_paid,
         count(*) filter (where free and items > 0)::int as free_items from x`, [shopId, minus(day, 90), day]),
    q(`select coalesce(nullif(o.traffic_source, ''), '') as source, count(*)::int as n from zd.orders o
       where o.shop_id = $1::uuid and ${COUNTED} and o.created_at >= ${at(2)} and o.created_at < ${at(3)} group by 1 order by 2 desc`, [shopId, minus(day, 60), day]),
    q(`select (select count(*) from zd.visits where shop_id = $1::uuid and day >= $2::date and day < $3::date)::int as visits,
         (select min(day) from zd.visits where shop_id = $1::uuid) as tracked_since,
         count(*)::int as orders, count(*) filter (where o.status = 'cancelled' or o.confirm_answer = 'no')::int as dropped,
         coalesce(sum(o.total) filter (where o.status = 'cancelled' or o.confirm_answer = 'no'), 0) as dropped_eur,
         count(*) filter (where o.status <> 'cancelled' and (o.waybill_created_at is not null or o.status in ('shipped', 'delivered', 'returned')))::int as shipped,
         count(*) filter (where o.status = 'delivered')::int as delivered, coalesce(sum(o.total) filter (where o.status = 'delivered'), 0) as delivered_eur,
         count(*) filter (where o.status = 'returned')::int as returned, coalesce(sum(o.total) filter (where o.status = 'returned'), 0) as returned_eur
       from zd.orders o where o.shop_id = $1::uuid and o.cb_check <> 'pending' and o.currency = 'EUR'
         and o.created_at >= ($2::date)::timestamp at time zone 'Europe/Sofia' and o.created_at < ($3::date)::timestamp at time zone 'Europe/Sofia'`, [shopId, f0, f1]),
  ]);

  const threshold = free.free_n >= 5 && free.paid_n >= 5 && free.free_items === free.free_n && (free.max_paid == null || Number(free.max_paid) < Number(free.min_free))
    ? r2(free.min_free) : null;
  let freeShare = null;
  if (threshold != null) {
    const [x] = await q(`select count(*)::int as n, count(*) filter (where ${ITEMS_SUM} >= $4::numeric)::int as above from zd.orders o
       where o.shop_id = $1::uuid and ${COUNTED} and o.created_at >= ${at(2)} and o.created_at < ${at(3)}`, [shopId, d30, day, String(threshold)]);
    freeShare = rate(x.above, x.n);
  }
  const withSource = channels.filter((c) => c.source), known = withSource.reduce((a, c) => a + c.n, 0);
  const top = withSource[0];
  const trackedSince = funnel.tracked_since ? dayOf(funnel.tracked_since) : null;
  return {
    basket: basket.n ? {
      aov: r2(basket.aov), baseAov: basket.base_n >= 30 ? r2(basket.base_aov) : null, units: r2(basket.units), single: rate(basket.single, basket.n), n: basket.n,
    } : null,
    freeShipping: threshold == null ? null : { threshold, share: freeShare },
    channel: known >= 60 && top ? { source: top.source, share: rate(top.n, known), n: known } : null,
    funnel: funnel.orders ? {
      from: f0, to: minus(f1, 1), visits: trackedSince && trackedSince <= f0 ? funnel.visits : null,
      orders: funnel.orders, dropped: funnel.dropped, droppedEur: r2(funnel.dropped_eur), shipped: funnel.shipped,
      delivered: funnel.delivered, deliveredEur: r2(funnel.delivered_eur), returned: funnel.returned, returnedEur: r2(funnel.returned_eur),
      returnCostEur: r2(funnel.returned * returnCost),
    } : null,
  };
}
const dayOf = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
