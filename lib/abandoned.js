// Abandoned carts: the checkout widget sends what the customer typed once the phone is valid; whether a cart was
// abandoned, recovered or just a normal checkout is decided when read, from zd.orders (see the 2026-10-17 design).
import { normalizePhone } from './phone.js';
import { fill } from './campaigns.js';

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

/* ---- reminders: texts, discount code, WhatsApp / SMS / Viber links (sent by a person, never automatically) ---- */
export const DEFAULT_TEXTS = {
  plain: 'Здравейте, {име}! Видяхме, че не завършихте поръчката си в {магазин} ({продукти}). Ако имате въпрос — пишете ни тук, ще помогнем. Можете да продължите оттук: {линк}',
  discount: 'Здравейте, {име}! Поръчката ви в {магазин} ({продукти}) още ви чака. Подарък от нас: {отстъпка} с код {код}. Продължете оттук: {линк}',
};
const settingsKey = (shopId) => `abandoned_msg:${shopId}`;
const money = (v, c) => `${Number(v).toFixed(2).replace('.', ',')} ${c === 'EUR' ? '€' : c}`;
const CHANNELS = ['whatsapp', 'sms', 'viber'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getReminderSettings(q, shopId) {
  const [r] = await q(`select value from zd.settings where key = $1`, [settingsKey(shopId)]);
  const v = r ? (typeof r.value === 'string' ? JSON.parse(r.value) : r.value) : {};
  return { plain: v.plain || DEFAULT_TEXTS.plain, discount: v.discount || DEFAULT_TEXTS.discount, code: v.code || '', discountText: v.discountText || '' };
}

export async function setReminderSettings(q, shopId, b = {}) {
  if (!shopId) throw new Error('Изберете магазин');
  const plain = String(b.plain ?? '').trim() || DEFAULT_TEXTS.plain;
  const discount = String(b.discount ?? '').trim() || DEFAULT_TEXTS.discount;
  const code = String(b.code ?? '').trim();
  const discountText = t(b.discountText, 60);
  if (plain.length > 700 || discount.length > 700) throw new Error('Съобщението е до 700 знака');
  if (code && !/^[A-Za-z0-9_-]{1,40}$/.test(code)) throw new Error('Невалиден код — само латински букви, цифри, - и _ (до 40)');
  if (code && !discount.includes('{код}')) throw new Error('Текстът с отстъпка трябва да съдържа {код}');
  await q(`insert into zd.settings (key, value) values ($1, jsonb_build_object('plain', $2::text, 'discount', $3::text, 'code', $4::text, 'discountText', $5::text))
     on conflict (key) do update set value = excluded.value`, [settingsKey(shopId), plain, discount, code, discountText]);
  return { plain, discount, code, discountText };
}

/** The page the customer left, only on the shop's own https domain (it is sent under the shop's name); else the shop's home. */
export function safeLink(pageUrl, shopDomain) {
  const home = `https://${String(shopDomain || '').replace(/^www\./, '')}/`;
  try {
    const u = new URL(String(pageUrl || ''));
    const host = u.hostname.toLowerCase(), d = String(shopDomain || '').toLowerCase().replace(/^www\./, '');
    if (u.protocol !== 'https:' || !d || !(host === d || host.endsWith(`.${d}`))) return home;
    return `${u.origin}${u.pathname}`;
  } catch { return home; }
}

function scopeArgs({ scopeShopId = null, scopeShopIds = null }) {
  return [scopeShopId ? String(scopeShopId) : null, Array.isArray(scopeShopIds) ? scopeShopIds.map(String) : null];
}
const IN_SCOPE = `($2::text is null or c.shop_id = $2::uuid) and ($3::uuid[] is null or c.shop_id = any($3::uuid[]))`;

/** The ready message and the links that open it in WhatsApp, SMS or Viber (Viber cannot take the text: it is copied). */
export async function reminderLinks(q, { id, kind = 'plain', ...scope }) {
  if (!UUID.test(String(id || ''))) return null;
  const [c] = await q(
    `select c.*, s.name as shop_name, s.domain as shop_domain,
       exists (select 1 from zd.campaign_optouts x where x.shop_id = c.shop_id and x.phone_norm = c.phone_norm) as opted_out
     from zd.abandoned_carts c join zd.shops s on s.id = c.shop_id where c.id = $1::uuid and c.anonymised_at is null and ${IN_SCOPE}`,
    [id, ...scopeArgs(scope)]);
  if (!c) return null;
  const st = await getReminderSettings(q, c.shop_id);
  if (kind === 'discount' && !st.code) throw new Error('Първо въведете код за отстъпка');
  const items = typeof c.items === 'string' ? JSON.parse(c.items) : c.items || [];
  const full = t(c.name, 160);
  const message = fill(kind === 'discount' ? st.discount : st.plain, {
    '{име}': full.split(' ')[0] || '', '{пълно_име}': full, '{продукти}': items.map((it) => it.name).join(', '), '{сума}': money(c.total, c.currency),
    '{магазин}': c.shop_name || c.shop_domain, '{линк}': safeLink(c.page_url, c.shop_domain), '{код}': st.code, '{отстъпка}': st.discountText,
  });
  const phone = c.opted_out ? '' : String(c.phone_norm || '');
  return {
    message,
    whatsapp: phone ? `https://wa.me/${phone.replace(/^\+/, '')}?text=${encodeURIComponent(message)}` : null,
    sms: phone ? `sms:${phone}?&body=${encodeURIComponent(message)}` : null,
    viber: phone ? `viber://chat?number=${encodeURIComponent(phone)}` : null,
  };
}

/** The shop opened a reminder: the first time is kept ("after a reminder" is judged against it), the channel and count follow. */
export async function markReminded(q, { id, channel, ...scope }) {
  if (!UUID.test(String(id || '')) || !CHANNELS.includes(channel)) return false;
  return (await q(`update zd.abandoned_carts c set reminded_at = coalesce(c.reminded_at, now()), reminder_channel = $4, reminder_count = c.reminder_count + 1
     where c.id = $1::uuid and ${IN_SCOPE} returning c.id`, [id, ...scopeArgs(scope), channel])).length > 0;
}

export async function hideCart(q, { id, ...scope }) {
  if (!UUID.test(String(id || ''))) return false;
  return (await q(`update zd.abandoned_carts c set hidden_at = coalesce(c.hidden_at, now()) where c.id = $1::uuid and ${IN_SCOPE} returning c.id`, [id, ...scopeArgs(scope)])).length > 0;
}
