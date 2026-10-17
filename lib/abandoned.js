// Abandoned carts: the checkout widget sends what the customer typed once the phone is valid; whether a cart was
// abandoned, recovered or just a normal checkout is decided when read, from zd.orders (see the 2026-10-17 design).
import { normalizePhone } from './phone.js';

const ABANDON_AFTER = "interval '30 minutes'";
const RECOVER_WITHIN = "interval '7 days'";
const SAME_CHECKOUT = "interval '24 hours'";

const t = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const num = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n < 1e7 ? Math.round(n * 100) / 100 : 0; };
function cleanItems(items) {
  return (Array.isArray(items) ? items : []).slice(0, 50).map((it) => ({
    name: t(it?.name, 200), qty: Math.max(1, Math.min(999, Math.trunc(Number(it?.qty) || 1))), price: num(it?.price),
  })).filter((it) => it.name);
}

// The first order of the same phone in the same shop after the cart was first seen (not cancelled, confirmed by ConvertBuilder).
const FIRST_ORDER = `left join lateral (
    select min(o.created_at) as at from zd.orders o
    where o.shop_id = c.shop_id and c.phone_norm <> '' and o.phone_norm = c.phone_norm and o.created_at > c.created_at
      and o.status <> 'cancelled' and o.cb_check <> 'pending'
  ) m on true`;
// facts derived per cart: completed = ordered within 30 minutes (a normal checkout); rec_at = when it was recovered
const FACTS = `(m.at is not null and m.at <= c.updated_at + ${ABANDON_AFTER}) as completed,
  coalesce(c.recovered_at, case when m.at > c.updated_at + ${ABANDON_AFTER} and m.at <= c.updated_at + ${RECOVER_WITHIN} then m.at end) as rec_at`;
const ABANDONED = `not f.completed and f.updated_at <= now() - ${ABANDON_AFTER}`;
const STATE = `case when f.hidden_at is not null then 'hidden' when f.rec_at is not null then 'recovered'
  when f.reminded_at is not null then 'reminded' else 'open' end`;

function scopeOf({ shopId = null, shopIds = null }, params) {
  if (shopId) { params.push(String(shopId)); return ` and c.shop_id = $${params.length}::uuid`; }
  if (shopIds) { params.push(shopIds.map(String)); return ` and c.shop_id = any($${params.length}::uuid[])`; }
  return '';
}
const withFacts = (where) => `select c.*, ${FACTS} from zd.abandoned_carts c ${FIRST_ORDER} where true ${where}`;

/** Stores or updates the open cart of this shop + phone; null when the phone is not valid. */
export async function captureCart(q, { shopId, phone, name, email, items, total, currency, deliveryText, pageUrl, ip }) {
  const phoneNorm = normalizePhone(phone);
  if (!phoneNorm || !shopId) return null;
  const v = [t(name, 160), t(email, 160), JSON.stringify(cleanItems(items)), String(num(total)), /^[A-Z]{3}$/.test(String(currency)) ? currency : 'EUR',
    t(deliveryText, 200), t(pageUrl, 500), t(ip, 64)];
  // the same checkout: updated recently, not reminded, hidden or recovered, and no order since it began
  const [open] = await q(
    `update zd.abandoned_carts c set name = $3, email = $4, items = $5::text::jsonb, total = $6::text::numeric, currency = $7,
       delivery_text = $8, page_url = $9, ip = $10, updated_at = now()
     where c.id = (select c.id from zd.abandoned_carts c ${FIRST_ORDER}
       where c.shop_id = $1::uuid and c.phone_norm = $2 and c.updated_at > now() - ${SAME_CHECKOUT}
         and c.reminded_at is null and c.hidden_at is null and c.anonymised_at is null and m.at is null
       order by c.updated_at desc limit 1)
     returning c.id`, [shopId, phoneNorm, ...v]);
  if (open) return { id: open.id, created: false };
  const [row] = await q(
    `insert into zd.abandoned_carts (shop_id, phone_norm, name, email, items, total, currency, delivery_text, page_url, ip)
     values ($1::uuid, $2, $3, $4, $5::text::jsonb, $6::text::numeric, $7, $8, $9, $10) returning id`, [shopId, phoneNorm, ...v]);
  return { id: row.id, created: true };
}

const toCart = (r) => ({
  id: r.id, shopId: r.shop_id, createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
  name: r.name, phoneNorm: r.phone_norm, email: r.email, items: typeof r.items === 'string' ? JSON.parse(r.items) : r.items,
  total: Number(r.total), currency: r.currency, deliveryText: r.delivery_text, pageUrl: r.page_url, state: r.state,
  remindedAt: r.reminded_at ? new Date(r.reminded_at).toISOString() : null, reminderChannel: r.reminder_channel, reminderCount: r.reminder_count,
  recoveredAt: r.rec_at ? new Date(r.rec_at).toISOString() : null, optedOut: Boolean(r.opted_out),
});

const LIST_STATES = ['open', 'all', 'reminded', 'recovered', 'hidden'];
/** Abandoned (and recovered) carts of the last 30 days, newest first. state 'open' = still to act on (open or reminded). */
export async function listCarts(q, { shopId = null, shopIds = null, state = 'open' } = {}) {
  const params = [];
  const where = scopeOf({ shopId, shopIds }, params) + ` and c.anonymised_at is null and c.updated_at > now() - interval '30 days'`;
  const s = LIST_STATES.includes(state) ? state : 'open';
  const pick = s === 'all' ? '' : s === 'open' ? ` and st.state in ('open', 'reminded')` : ` and st.state = '${s}'`;
  const rows = await q(
    `select st.*, exists (select 1 from zd.campaign_optouts x where x.shop_id = st.shop_id and x.phone_norm = st.phone_norm) as opted_out
     from (select f.*, ${STATE} as state from (${withFacts(where)}) f where ${ABANDONED}) st
     where true ${pick} order by st.updated_at desc limit 200`, params);
  return rows.map(toCart);
}

/** The badge: open carts (not reminded, hidden or recovered) of the last 7 days. */
export async function openCount(q, scope = {}) {
  const params = [];
  const where = scopeOf(scope, params) + ` and c.anonymised_at is null and c.updated_at > now() - interval '7 days'`;
  const [r] = await q(`select count(*)::int as n from (select f.*, ${STATE} as state from (${withFacts(where)}) f where ${ABANDONED}) st where st.state = 'open'`, params);
  return r.n;
}

/** Carts first seen in the period (Sofia days) that were abandoned; how many came back, and how many after a reminder. */
export async function cartStats(q, { from, to, shopId = null, shopIds = null }) {
  const params = [from, to];
  const where = ` and c.created_at >= ($1::date)::timestamp at time zone 'Europe/Sofia' and c.created_at < ($2::date + 1)::timestamp at time zone 'Europe/Sofia'`
    + scopeOf({ shopId, shopIds }, params);
  const rows = await q(
    `select f.currency, count(*)::int as n, sum(f.total) as total, count(f.rec_at)::int as recovered,
       count(*) filter (where f.rec_at is not null and f.reminded_at is not null and f.reminded_at < f.rec_at)::int as after_reminder
     from (${withFacts(where)}) f where ${ABANDONED} group by f.currency order by f.currency`, params);
  return {
    count: rows.reduce((a, r) => a + r.n, 0),
    total: rows.map((r) => ({ currency: r.currency, amount: Math.round(Number(r.total) * 100) / 100 })),
    recovered: rows.reduce((a, r) => a + r.recovered, 0),
    afterReminder: rows.reduce((a, r) => a + r.after_reminder, 0),
  };
}

/** Nightly: after 30 days personal details go (figures stay); normal checkouts go; after 400 days everything goes. */
export async function anonymiseOld(q) {
  const old = await q(`delete from zd.abandoned_carts where created_at < now() - interval '400 days' returning id`);
  const done = await q(
    `delete from zd.abandoned_carts where id in (select f.id from (${withFacts(`and c.anonymised_at is null and c.updated_at < now() - interval '30 days'`)}) f where f.completed) returning id`);
  const anon = await q(
    `update zd.abandoned_carts a set recovered_at = f.rec_at, phone_norm = '', name = '', email = '', items = '[]', page_url = '', delivery_text = '', ip = '',
       anonymised_at = now()
     from (${withFacts(`and c.anonymised_at is null and c.updated_at < now() - interval '30 days'`)}) f where a.id = f.id returning a.id`);
  return { anonymised: anon.length, deleted: old.length + done.length };
}
