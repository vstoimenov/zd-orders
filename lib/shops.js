// Shops: one admin, several shops (stage 1 — the owner's own shops). Data of each shop carries shop_id.
import { normalizeDomain } from './convertbuilder.js';

export const DEFAULT_SHOP = '00000000-0000-4000-8000-000000000001';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CURRENCIES = ['EUR', 'BGN', 'USD'];
const bare = (host) => String(host || '').toLowerCase().replace(/^www\./, '');

const view = (r) => ({
  id: r.id, name: r.name, domain: r.domain, url: r.url, email: r.email, phone: r.phone, currency: r.currency,
  hidden: r.hidden, display: r.name || (r.domain === 'shop.local' ? 'Моят магазин' : r.domain),
});

export async function listShops(q, { withHidden = true } = {}) {
  const rows = await q(`select * from zd.shops ${withHidden ? '' : 'where not hidden'} order by (id = $1) desc, created_at, domain`, [DEFAULT_SHOP]);
  return rows.map(view);
}

export async function getShop(q, id) {
  if (!UUID.test(String(id || ''))) return null;
  const [r] = await q(`select * from zd.shops where id = $1::uuid`, [id]);
  return r ? view(r) : null;
}

/** The shop whose checkout runs on this host (with or without www), or null. */
export async function shopIdForHost(q, host) {
  const [r] = await q(`select id from zd.shops where domain = $1`, [bare(host)]);
  return r?.id || null;
}

function clean(input = {}, { requireDomain }) {
  const t = (v) => String(v ?? '').trim();
  const shop = { name: t(input.name), url: t(input.url), email: t(input.email), phone: t(input.phone), currency: t(input.currency) || 'EUR' };
  if (shop.name.length > 60) throw new Error('Името на магазина е до 60 знака');
  if (shop.url && (!/^https?:\/\/[^\s/]+\.[^\s]+$/i.test(shop.url) || shop.url.length > 200)) throw new Error('Невалиден адрес — напр. https://adhdbg.eu');
  if (shop.email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(shop.email) || shop.email.length > 160)) throw new Error('Невалиден имейл');
  if (shop.phone.length > 30) throw new Error('Телефонът е до 30 знака');
  if (!CURRENCIES.includes(shop.currency)) throw new Error('Невалидна валута');
  if (requireDomain || input.domain !== undefined) {
    try { shop.domain = bare(normalizeDomain(input.domain)); } catch { throw new Error('Невалиден домейн — само домейна, напр. adhdbg.eu'); }
  }
  return shop;
}

export async function createShop(q, input) {
  const s = clean(input, { requireDomain: true });
  if (!s.name) throw new Error('Въведете име на магазина');
  const [dup] = await q(`select 1 from zd.shops where domain = $1`, [s.domain]);
  if (dup) throw new Error('Магазин с този домейн вече има');
  const [r] = await q(
    `insert into zd.shops (name, domain, url, email, phone, currency) values ($1, $2, $3, $4, $5, $6) returning *`,
    [s.name, s.domain, s.url || `https://${s.domain}`, s.email, s.phone, s.currency],
  );
  return view(r);
}

/** Store data of a shop (the domain is not changed here: orders are keyed by it). */
export async function updateShop(q, id, input) {
  const s = clean({ ...input, domain: undefined }, { requireDomain: false });
  const [r] = await q(
    `update zd.shops set name = $2, url = $3, email = $4, phone = $5, currency = $6 where id = $1::uuid returning *`,
    [id, s.name, s.url, s.email, s.phone, s.currency],
  );
  if (!r) throw new Error('Няма такъв магазин');
  return view(r);
}

export async function setShopHidden(q, id, hidden) {
  const [r] = await q(`update zd.shops set hidden = $2 where id = $1::uuid returning *`, [id, Boolean(hidden)]);
  if (!r) throw new Error('Няма такъв магазин');
  return view(r);
}

/**
 * Admin request → { id } of the chosen shop, or { all: true } when allowed. Reads without a shop open the default shop;
 * writes (strict) must name a real shop — a bad id must never land in another shop.
 */
export async function resolveShop(q, param, { allowAll = false, strict = false } = {}) {
  if (param === 'all') {
    if (!allowAll) throw new Error('Изберете магазин');
    return { all: true, id: null };
  }
  if (strict) {
    const shop = await getShop(q, param);
    if (!shop) throw new Error('Изберете магазин');
    return { all: false, id: shop.id, shop };
  }
  const shop = (await getShop(q, param)) || (await getShop(q, DEFAULT_SHOP)) || (await listShops(q))[0];
  if (!shop) throw new Error('Няма магазини');
  return { all: false, id: shop.id, shop };
}

/**
 * The request's Origin when it may send checkout orders / visits: listed in ALLOWED_ORIGINS or the domain of a shop
 * (with or without www). Returns { origin, shopId } — shopId of that domain, else the default shop — or null.
 */
export async function allowedShopOrigin(q, req) {
  const origin = String(req.headers.origin || '').replace(/\/$/, '');
  if (!/^https?:\/\/[^/]+$/i.test(origin)) return null;
  const host = new URL(origin).host;
  const listed = String(process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/$/, '')).includes(origin);
  let shopId = null;
  try { shopId = await shopIdForHost(q, host); } catch (err) { if (!listed) throw err; } // a listed origin still works when the DB has trouble
  if (host === 'shop.local') shopId = null; // the placeholder of a fresh install is not a real site
  if (!listed && !(shopId && origin.startsWith('https://'))) return null;
  return { origin, shopId: shopId || DEFAULT_SHOP };
}

/** A fresh install's default shop has the placeholder domain until its store is connected: it then takes that domain. */
export async function claimDomain(q, id, domain) {
  let d;
  try { d = bare(normalizeDomain(domain)); } catch { throw new Error('Невалиден домейн — само домейна, напр. adhdbg.eu'); }
  const [r] = await q(
    `update zd.shops set domain = $2, url = case when url = '' then 'https://' || $2 else url end
     where id = $1::uuid and domain = 'shop.local' and not exists (select 1 from zd.shops where domain = $2) returning *`,
    [id, d],
  );
  return r ? view(r) : null;
}
