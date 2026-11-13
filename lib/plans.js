// Ordyx plans and the launch offer. No online payment: the client picks a plan at registration and gets 14 days free; the
// owner sends a payment link and marks the first payment here. Prices include VAT.
//  - Launch prices for a plan chosen by 30.11.2026 23:59 (Sofia), kept 12 months from the first payment, monthly or yearly.
//  - Founders 20: the first 20 clients who pay a yearly launch plan keep that yearly price for as long as they renew it.
//  - Afterwards (and for plans chosen after the launch) the regular price: 67 / 97 / 147 € a month, 12 × that a year.
export const PLANS = {
  starter: { key: 'starter', name: 'Starter', shops: 1, maxShops: 2, orders: 300, monthly: 67, launchMonthly: 40.2, launchYearly: 321.6 },
  growth: { key: 'growth', name: 'Growth', shops: 3, maxShops: 5, orders: 1000, monthly: 97, launchMonthly: 58.2, launchYearly: 465.6 },
  business: { key: 'business', name: 'Business', shops: 6, maxShops: null, orders: 4000, monthly: 147, launchMonthly: 88.2, launchYearly: 705.6 },
};
export const BILLINGS = ['monthly', 'yearly'];
export const LAUNCH_ENDS = Date.parse('2026-11-30T23:59:59.999+02:00');
export const TRIAL_DAYS = 14;
export const LOCK_MONTHS = 12;
export const FOUNDERS = 20;
export const EXTRA_SHOP = 7; // € a month per added store, never discounted
const r2 = (v) => Math.round(Number(v) * 100) / 100;

export const launchOpen = (at = new Date()) => new Date(at).getTime() <= LAUNCH_ENDS;
const regularPrice = (p, billing) => (billing === 'yearly' ? p.monthly * 12 : p.monthly);

/** The price of a plan chosen at `at`: the launch price until 30.11.2026 23:59, the regular one after. */
export function quote(planKey, billing, at = new Date()) {
  const p = PLANS[planKey];
  if (!p) throw new Error('Изберете план: Starter, Growth или Business');
  if (!BILLINGS.includes(billing)) throw new Error('Изберете месечно или годишно плащане');
  const launch = launchOpen(at);
  const regular = regularPrice(p, billing);
  return { plan: p.key, billing, launch, price: launch ? (billing === 'yearly' ? p.launchYearly : p.launchMonthly) : regular, regular };
}

const COLS = `sub_plan, sub_billing, sub_price, sub_regular, sub_launch, sub_chosen_at, sub_trial_until, sub_paid_at, sub_locked_until, sub_founder`;
const iso = (v) => (v ? new Date(v).toISOString() : null);

/** A user row → what the admin shows: plan, period, price now, the regular price and the dates. */
export function subscriptionView(r, now = new Date()) {
  if (!r?.sub_plan) return null;
  const p = PLANS[r.sub_plan];
  const locked = r.sub_locked_until && new Date(r.sub_locked_until) > now;
  // the launch price runs out 12 months after the first payment; a founder keeps it; unpaid: still the chosen price
  const launchOn = r.sub_launch && (r.sub_founder || !r.sub_paid_at || locked);
  return {
    plan: r.sub_plan, planName: p?.name || r.sub_plan, billing: r.sub_billing, shops: p?.shops ?? null, orders: p?.orders ?? null,
    price: Number(launchOn ? r.sub_price : r.sub_regular), launchPrice: Number(r.sub_price), regular: Number(r.sub_regular),
    launch: Boolean(r.sub_launch), founder: Boolean(r.sub_founder), chosenAt: iso(r.sub_chosen_at), trialUntil: iso(r.sub_trial_until),
    paidAt: iso(r.sub_paid_at), lockedUntil: iso(r.sub_locked_until), launchActive: Boolean(launchOn),
  };
}

export async function foundersLeft(q) {
  const [r] = await q(`select count(*)::int as n from zd.users where sub_founder_no is not null`); // a place once taken stays taken
  return Math.max(0, FOUNDERS - r.n);
}

/** The plan picked at registration (or changed by the owner): priced by the day it was first chosen, 14 days free from then. */
export async function chooseSubscription(q, userId, { plan, billing }, now = new Date()) {
  const [cur] = await q(`select sub_chosen_at, sub_paid_at, sub_founder from zd.users where id = $1::uuid`, [userId]);
  if (!cur) throw new Error('Клиентът не е намерен');
  if (cur.sub_founder) throw new Error('Founders цената е за същия план с годишно плащане — смяната ѝ отпада');
  const chosenAt = cur.sub_chosen_at ? new Date(cur.sub_chosen_at) : now; // a change keeps the launch price of the first choice
  const qt = quote(plan, billing, chosenAt);
  const [r] = await q(
    `update zd.users set sub_plan = $2, sub_billing = $3, sub_price = $4, sub_regular = $5, sub_launch = $6,
       sub_chosen_at = coalesce(sub_chosen_at, $7::timestamptz),
       sub_trial_until = coalesce(sub_trial_until, $7::timestamptz + make_interval(days => $8))
     where id = $1::uuid returning ${COLS}`,
    [userId, qt.plan, qt.billing, qt.price, qt.regular, qt.launch, now.toISOString(), TRIAL_DAYS],
  );
  return subscriptionView(r, now);
}

/**
 * The owner marks the first payment: the launch price is kept 12 months from it; a yearly launch plan among the first 20
 * paid becomes a founder (kept for as long as it is renewed). Marking again changes nothing.
 */
export async function markPaid(q, userId, { paidAt } = {}, now = new Date()) {
  const at = paidAt ? new Date(paidAt) : now;
  if (Number.isNaN(at.getTime())) throw new Error('Невалидна дата на плащане');
  const [r] = await q(
    `with cur as (select * from zd.users where id = $1::uuid for update),
     taken as (select count(*)::int as n from zd.users where sub_founder_no is not null),
     f as (select cur.sub_launch and cur.sub_billing = 'yearly' and (select n from taken) < $4 as yes from cur)
     update zd.users u set sub_paid_at = $2::timestamptz,
       sub_founder = (select yes from f),
       sub_founder_no = case when (select yes from f) then (select n from taken) + 1 end,
       sub_locked_until = case when cur.sub_launch then $2::timestamptz + make_interval(months => $3) end
     from cur where u.id = cur.id and cur.sub_plan is not null and cur.sub_paid_at is null
     returning u.sub_plan, u.sub_billing, u.sub_price, u.sub_regular, u.sub_launch, u.sub_chosen_at, u.sub_trial_until, u.sub_paid_at,
       u.sub_locked_until, u.sub_founder`,
    [userId, at.toISOString(), LOCK_MONTHS, FOUNDERS],
  );
  if (r) return subscriptionView(r, now);
  const [cur] = await q(`select ${COLS} from zd.users where id = $1::uuid`, [userId]);
  if (!cur) throw new Error('Клиентът не е намерен');
  if (!cur.sub_plan) throw new Error('Клиентът още не е избрал план');
  return subscriptionView(cur, now); // already paid
}

/** Cancelling ends the right to the launch (and founder) price: a later return pays the regular price. */
export async function cancelSubscription(q, userId) {
  await q(`update zd.users set sub_price = sub_regular, sub_launch = false, sub_founder = false, sub_locked_until = null where id = $1::uuid`, [userId]);
}

export const SUB_COLS = COLS;
