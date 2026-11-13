// What a client may do now — the reverse trial: 14 days on the plan picked at registration, then Free for good unless a payment
// came in. Free: 1 shop, 50 orders a month, orders / couriers / waybills / basic statistics and Growth Club; no profit analysis,
// no AI voice confirmations, no Growth Lab. At 40 of 50 the client is warned; at 50 orders keep coming in and everything stays
// visible, but new processing (waybills) waits for the next month or an upgrade. Paid plans are never blocked: orders above
// their limit are billed (5 € for every 250). The owner, and accounts without a picked plan (made by the owner, the event
// offer), have no limits.
import { PLANS, subscriptionView, SUB_COLS } from './plans.js';

export const FREE = { key: 'free', name: 'Free', shops: 1, maxShops: 1, orders: 50, warnAt: 40 };
const sofiaMonthStart = (now) => `${new Date(now).toLocaleDateString('sv', { timeZone: 'Europe/Sofia' }).slice(0, 7)}-01`;

/** Orders this Sofia month in the client's shops (a „Унищожена“ fake / test order does not count). */
export async function ordersThisMonth(q, userId, now = new Date()) {
  const [r] = await q(
    `select count(*)::int as n from zd.orders o join zd.user_shops s on s.shop_id = o.shop_id
     where s.user_id = $1::uuid and o.destroyed_at is null and o.created_at >= ($2::date)::timestamp at time zone 'Europe/Sofia'`,
    [userId, sofiaMonthStart(now)]);
  return r.n;
}

export async function planState(q, user, now = new Date()) {
  if (!user || user.owner) return { unlimited: true };
  const [row] = await q(`select ${SUB_COLS} from zd.users where id = $1::uuid`, [user.id]);
  const sub = subscriptionView(row, now);
  if (!sub) return { unlimited: true };
  const trial = !sub.paidAt && Boolean(sub.trialUntil) && new Date(sub.trialUntil) > now;
  const effective = sub.paidAt || trial ? sub.plan : FREE.key;
  const free = effective === FREE.key;
  const plan = free ? FREE : PLANS[effective];
  const used = await ordersThisMonth(q, user.id, now);
  return {
    unlimited: false, effective, planName: plan.name, chosen: sub.planName, trial, trialUntil: sub.trialUntil, paid: Boolean(sub.paidAt),
    used, limit: plan.orders, maxShops: plan.maxShops,
    warn: free && used >= FREE.warnAt && used < FREE.orders, blocked: free && used >= FREE.orders,
    features: { profit: !free, voice: !free, growthLab: !free, growthClub: true },
  };
}

export const LIMIT_MESSAGE = 'Достигнахте 50 поръчки за месеца в безплатния план — новите поръчки се пазят, а товарителници ще правите от 1-во число или веднага с платен план (Профил → План).';
export const PROFIT_MESSAGE = 'Анализът на печалбата е в платените планове — Starter, Growth и Business.';
