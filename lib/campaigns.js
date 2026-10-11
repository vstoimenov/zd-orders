// SMS / WhatsApp campaigns: customers picked from a shop's own orders (one person = one phone number), a message with variables,
// SMS parts and cost; saved, exported as CSV. Sending is switched on later with a provider.
import { STATUSES } from './orders-repo.js';
import { normalizePhone } from './phone.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_RECIPIENTS = 20000;
const DEFAULT_SMS_PRICE = 0.05;
const t = (v) => String(v ?? '').trim();

// GSM 03.38 basic set (+ the extension table, which counts as two characters)
const GSM = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXT = '^{}\\[~]|€';

/** Characters and SMS parts: GSM-7 160 / 153 per part, anything else (e.g. Cyrillic) UCS-2 70 / 67. */
export function smsInfo(text) {
  const s = String(text ?? '');
  const chars = [...s];
  if (!chars.length) return { encoding: 'GSM', chars: 0, parts: 0 };
  const gsm = chars.every((c) => GSM.includes(c) || GSM_EXT.includes(c));
  if (gsm) {
    const len = chars.reduce((n, c) => n + (GSM_EXT.includes(c) ? 2 : 1), 0);
    return { encoding: 'GSM', chars: len, parts: len <= 160 ? 1 : Math.ceil(len / 153) };
  }
  return { encoding: 'UCS2', chars: chars.length, parts: chars.length <= 70 ? 1 : Math.ceil(chars.length / 67) };
}

/** Fills {name}-style variables; values are inserted as written (a function replacer: no "$&" surprises from names). */
export function fill(template, values) {
  return String(template ?? '').replace(/\{[^{}\s]+\}/g, (m) => (Object.hasOwn(values, m) ? String(values[m]) : m));
}

export function renderMessage(template, { name = '', product = '', shop = '', link = '' } = {}) {
  const full = t(name);
  return fill(template, { '{име}': full.split(/\s+/)[0] || '', '{пълно_име}': full, '{продукт}': t(product), '{магазин}': t(shop), '{линк}': t(link) });
}

const realDate = (s) => DATE.test(s || '') && new Date(`${s}T12:00:00Z`).toISOString().slice(0, 10) === s;

function cleanSegment(s = {}) {
  const statuses = (Array.isArray(s.statuses) && s.statuses.length ? s.statuses : ['delivered']).filter((x) => STATUSES.includes(x));
  return {
    statuses: statuses.length ? statuses : ['delivered'],
    from: realDate(s.from) ? s.from : '',
    to: realDate(s.to) ? s.to : '',
    product: t(s.product).slice(0, 100),
    minOrders: Math.max(1, Math.min(100, Math.trunc(Number(s.minOrders) || 1))),
    excludeFlagged: s.excludeFlagged !== false,
  };
}

/** The people a segment reaches in this shop (newest buyers first), never opted-out numbers. */
export async function recipients(q, shopId, segment, limit = MAX_RECIPIENTS) {
  const s = cleanSegment(segment);
  const params = [shopId, s.statuses];
  const arg = (v) => { params.push(v); return `$${params.length}`; };
  const where = [`o.shop_id = $1::uuid`, `o.phone_norm <> ''`, `o.status = any($2::text[])`];
  if (s.from) where.push(`o.created_at >= (${arg(s.from)}::date)::timestamp at time zone 'Europe/Sofia'`);
  if (s.to) where.push(`o.created_at < (${arg(s.to)}::date + 1)::timestamp at time zone 'Europe/Sofia'`);
  if (s.product) where.push(`exists (select 1 from jsonb_array_elements(o.items) it where it->>'name' ilike ${arg(`%${s.product.replace(/[\\%_]/g, '\\$&')}%`)})`);
  const rows = await q(
    `with per as (
       select o.phone_norm, (array_agg(o.name order by o.created_at desc))[1] as name, (array_agg(o.items order by o.created_at desc))[1] as items,
         count(*)::int as orders, max(o.created_at) as last_at
       from zd.orders o where ${where.join(' and ')} group by o.phone_norm)
     select per.* from per
     where per.orders >= ${s.minOrders}
       and not exists (select 1 from zd.campaign_optouts x where x.shop_id = $1::uuid and x.phone_norm = per.phone_norm)
       ${s.excludeFlagged ? `and not exists (select 1 from zd.orders f where f.shop_id = $1::uuid and f.phone_norm = per.phone_norm and f.nk_status = 'flagged')` : ''}
     order by per.last_at desc limit ${Math.max(1, Math.min(limit, MAX_RECIPIENTS))}`,
    params,
  );
  return rows.map((r) => {
    const items = typeof r.items === 'string' ? JSON.parse(r.items) : r.items || [];
    return { phone: r.phone_norm, name: r.name, product: items[0]?.name || '', orders: r.orders };
  });
}

async function shopCtx(q, shopId) {
  const [s] = await q(`select name, domain, url from zd.shops where id = $1::uuid`, [shopId]);
  return { shop: s?.name || s?.domain || '', link: s?.url || (s?.domain ? `https://${s.domain}` : '') };
}

export async function smsPrice(q, shopId) {
  const [r] = await q(`select value from zd.settings where key = $1`, [`sms_price:${shopId}`]);
  const v = r ? Number(typeof r.value === 'string' ? JSON.parse(r.value) : r.value) : NaN;
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_SMS_PRICE;
}
export async function setSmsPrice(q, shopId, value) {
  const v = Number(String(value ?? '').replace(',', '.'));
  if (!Number.isFinite(v) || v < 0 || v > 5) throw new Error('Цената за SMS е от 0 до 5 €');
  await q(`insert into zd.settings (key, value) values ($1, to_jsonb($2::numeric)) on conflict (key) do update set value = excluded.value`, [`sms_price:${shopId}`, String(v)]);
  return v;
}

/** How many people, a sample of the personalised texts, SMS parts (of the longest text) and cost. */
export async function preview(q, shopId, { channel = 'sms', message = '', segment = {} }) {
  const [list, ctx, price] = await Promise.all([recipients(q, shopId, segment), shopCtx(q, shopId), smsPrice(q, shopId)]);
  const texts = list.map((r) => renderMessage(message, { ...ctx, name: r.name, product: r.product }));
  const parts = texts.reduce((n, x) => n + smsInfo(x).parts, 0);
  const longest = texts.reduce((a, b) => (b.length > a.length ? b : a), renderMessage(message, ctx));
  return {
    count: list.length,
    sample: list.slice(0, 5).map((r, i) => ({ phone: r.phone, name: r.name, text: texts[i] })),
    sms: smsInfo(longest),
    cost: channel === 'sms' ? Math.round(parts * price * 100) / 100 : null, // WhatsApp: Meta's price per conversation
    smsPrice: price,
  };
}

const view = (r) => ({
  id: r.id, name: r.name, channel: r.channel, message: r.message, segment: typeof r.segment === 'string' ? JSON.parse(r.segment) : r.segment,
  consent: r.consent, status: r.status, recipients: r.recipients, createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
});

export async function listCampaigns(q, shopId) {
  return (await q(`select * from zd.campaigns where shop_id = $1::uuid order by created_at desc limit 200`, [shopId])).map(view);
}

export async function saveCampaign(q, shopId, b) {
  const name = t(b.name).slice(0, 80) || 'Кампания';
  const channel = b.channel === 'whatsapp' ? 'whatsapp' : 'sms';
  const message = String(b.message ?? '').slice(0, 1000);
  if (!t(message)) throw new Error('Напишете съобщението');
  const status = b.status === 'ready' ? 'ready' : 'draft';
  if (status === 'ready' && b.consent !== true) throw new Error('Потвърдете, че имате съгласието на клиентите за такива съобщения');
  const segment = cleanSegment(b.segment);
  const count = (await recipients(q, shopId, segment)).length;
  if (b.id) {
    if (!UUID.test(String(b.id))) throw new Error('Няма такава кампания');
    const [r] = await q(
      `update zd.campaigns set name = $3, channel = $4, message = $5, segment = $6::text::jsonb, consent = $7, status = $8, recipients = $9, updated_at = now()
       where id = $1::uuid and shop_id = $2::uuid returning *`,
      [b.id, shopId, name, channel, message, JSON.stringify(segment), b.consent === true, status, count],
    );
    if (!r) throw new Error('Няма такава кампания');
    return view(r);
  }
  const [r] = await q(
    `insert into zd.campaigns (shop_id, name, channel, message, segment, consent, status, recipients) values ($1::uuid, $2, $3, $4, $5::text::jsonb, $6, $7, $8) returning *`,
    [shopId, name, channel, message, JSON.stringify(segment), b.consent === true, status, count],
  );
  return view(r);
}

export async function deleteCampaign(q, shopId, id) {
  if (!UUID.test(String(id || ''))) return false;
  return (await q(`delete from zd.campaigns where id = $1::uuid and shop_id = $2::uuid returning id`, [id, shopId])).length > 0;
}

const csvCell = (v) => { const s = String(v ?? '').replace(/^[=+\-@\t\r]/, "'$&"); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
// a normalised phone (+359…) is data, not a formula: written as it is so SMS tools accept it
const csvPhone = (v) => (/^\+\d{6,15}$/.test(String(v)) ? String(v) : csvCell(v));

/** The personalised list of a campaign with consent, as CSV for any bulk SMS / WhatsApp tool. */
export async function exportCampaign(q, shopId, id) {
  if (!UUID.test(String(id || ''))) throw new Error('Няма такава кампания');
  const [c] = await q(`select * from zd.campaigns where id = $1::uuid and shop_id = $2::uuid`, [id, shopId]);
  if (!c) throw new Error('Няма такава кампания');
  if (!c.consent) throw new Error('Експортът е след потвърждение за съгласието на клиентите (отметката в кампанията)');
  const [list, ctx] = await Promise.all([recipients(q, shopId, typeof c.segment === 'string' ? JSON.parse(c.segment) : c.segment), shopCtx(q, shopId)]);
  const lines = ['phone,name,message', ...list.map((r) => [csvPhone(r.phone), csvCell(r.name), csvCell(renderMessage(c.message, { ...ctx, name: r.name, product: r.product }))].join(','))];
  return { csv: `﻿${lines.join('\n')}\n`, filename: `kampania-${String(c.name).replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 40) || 'list'}.csv` };
}

/* ---- the STOP list ---- */
export async function addOptouts(q, shopId, text) {
  const phones = [...new Set(String(text ?? '').split(/[\n,;]+/).map((x) => normalizePhone(x)).filter(Boolean))].slice(0, 5000);
  if (phones.length) await q(`insert into zd.campaign_optouts (shop_id, phone_norm) select $1::uuid, unnest($2::text[]) on conflict do nothing`, [shopId, phones]);
  return { added: phones.length };
}
export async function removeOptout(q, shopId, phone) {
  await q(`delete from zd.campaign_optouts where shop_id = $1::uuid and phone_norm = $2`, [shopId, String(phone || '')]);
}
export async function listOptouts(q, shopId) {
  return (await q(`select phone_norm, created_at from zd.campaign_optouts where shop_id = $1::uuid order by created_at desc limit 5000`, [shopId]))
    .map((r) => ({ phone: r.phone_norm, createdAt: new Date(r.created_at).toISOString() }));
}
