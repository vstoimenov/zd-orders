// ConvertBuilder (Simvoly white-label) website API: https://{domain}/api/site, `Authorization: Bearer <API KEY>`.
// Spec: https://websitebuilder.app-sources.com (orders list/get/update, webhooks signed with HMAC-SHA512).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { normalizePhone } from './phone.js';

const UA = 'Ordyx/1.0 (+https://app.ordyx.eu)';
const HOST = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const clean = (v) => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim();
const money = (v) => Math.round(Number(v || 0) * 100) / 100;

export function normalizeDomain(input) {
  const host = clean(input).toLowerCase().replace(/^https?:\/\//, '').split(/[/?#]/)[0].replace(/:\d+$/, '');
  if (!HOST.test(host)) throw new Error('invalid domain');
  return host;
}

export async function cbRequest({ domain, apiKey }, path, { method = 'GET', body, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const res = await fetchImpl(`https://${domain}/api/site${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, 'User-Agent': UA, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'manual', // fetch drops the Authorization header on a redirect to another host (www → bare domain)
  });
  if (res.status >= 300 && res.status < 400) {
    let to = '';
    try { to = new URL(res.headers.get('location'), `https://${domain}`).host; } catch { /* no usable Location */ }
    throw new Error(to && to !== domain ? `Домейнът ${domain} пренасочва към ${to} — въведете ${to}` : `ConvertBuilder: HTTP ${res.status} (пренасочване)`);
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty or non-JSON body */ }
  if (!res.ok) throw new Error(`ConvertBuilder: HTTP ${res.status}${data?.message ? `: ${data.message}` : ''}`);
  return data;
}

export async function testConnection(cfg, fetchImpl = fetch) {
  const d = await cbRequest(cfg, '/orders?limit=1', { fetchImpl });
  const latest = Array.isArray(d?.items) ? d.items[0] : null;
  return { totalOrders: d?.totalCount ?? null, latestOrderId: latest?.id ?? null, latestInvoiceNo: latest?.invoiceNo ?? null };
}

/** All orders created in [since, until] (unix seconds), newest first per page; capped to protect the function's time limit. */
export async function fetchOrders(cfg, { since, until, max = 2000 }, fetchImpl = fetch) {
  const out = [];
  for (let skip = 0; out.length < max; skip += 50) {
    const p = new URLSearchParams({ limit: '50', skip: String(skip) });
    if (since) p.set('created_at_min', String(since));
    if (until) p.set('created_at_max', String(until));
    const d = await cbRequest(cfg, `/orders?${p}`, { fetchImpl });
    const items = Array.isArray(d?.items) ? d.items : [];
    out.push(...items);
    if (items.length < 50 || (d?.totalCount != null && out.length >= d.totalCount)) break;
  }
  return out.slice(0, max);
}

/** Our webhook for order_created/order_updated, signed with `secret`; an older one for the same target is replaced (its secret is unknown). */
export async function ensureWebhook(cfg, target, secret, fetchImpl = fetch) {
  await removeWebhook(cfg, target, fetchImpl);
  const created = await cbRequest(cfg, '/webhooks', { method: 'POST', body: { target, secret, events: ['order_created', 'order_updated'] }, fetchImpl });
  return { id: created?.id ?? null };
}

/** Deletes our webhook(s) for `target` (integration switched off). */
export async function removeWebhook(cfg, target, fetchImpl = fetch) {
  const list = await cbRequest(cfg, '/webhooks', { fetchImpl });
  const hooks = Array.isArray(list) ? list : Array.isArray(list?.items) ? list.items : [];
  for (const h of hooks) if (h?.target === target) await cbRequest(cfg, `/webhooks/${encodeURIComponent(h.id)}`, { method: 'DELETE', fetchImpl });
}

export function verifySignature(raw, secret, signature) {
  if (!secret || !signature) return false;
  const want = Buffer.from(createHmac('sha512', secret).update(raw).digest('hex'));
  const got = Buffer.from(String(signature).trim().toLowerCase());
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Our widget writes "ЕКОНТ – …" / "ЕКОНТ – адрес: …" / "СПИДИ – офис …" / "СПИДИ – адрес: …" / "BOX NOW – автомат …"; otherwise guess from the shipping method name. */
function delivery(o) {
  const a = clean(o.shippingAddress?.address);
  if (/^ЕКОНТ\s*–\s*адрес/i.test(a)) return ['econt_address', 'econt'];
  if (/^ЕКОНТ\s*–/i.test(a)) return ['econt_office', 'econt'];
  if (/^СПИДИ\s*–\s*адрес/i.test(a)) return ['speedy_address', 'speedy'];
  if (/^СПИДИ\s*–/i.test(a)) return ['speedy_office', 'speedy'];
  if (/^BOX NOW\s*–/i.test(a)) return ['boxnow_locker', 'boxnow'];
  if (/box\s*now|бокс\s*нау/i.test(clean(o.shippingName))) return ['boxnow_locker', 'boxnow']; // the method decides, not what the customer typed
  const t = `${clean(o.shippingName)} ${a}`.toLowerCase();
  if (/econt|еконт/.test(t)) return [/адрес|address/i.test(clean(o.shippingName)) ? 'econt_address' : 'econt_office', 'econt'];
  if (/speedy|спиди/.test(t)) return [/адрес|address/.test(t) ? 'speedy_address' : 'speedy_office', 'speedy'];
  return ['other', 'other'];
}

// ConvertBuilder status → ours. Updates only move an order forward (pending never overrides our own "confirmed"; archived is ignored).
const UPDATE_STATUS = { shipped: 'shipped', completed: 'delivered', canceled: 'cancelled' };
const INSERT_STATUS = { ...UPDATE_STATUS, pending: 'new', archived: 'cancelled' };

export function mapOrder(o, { store, currency = 'EUR' }) {
  const ship = o.shippingAddress || {};
  const [deliveryType, courier] = delivery(o);
  const phone = clean(ship.phone || o.billingAddress?.phone);
  const status = clean(o.status).toLowerCase();
  return {
    cbOrderId: `${store}:${o.id}`,
    invoiceNo: o.invoiceNo == null ? '' : String(o.invoiceNo),
    name: clean(o.customerName || ship.name).slice(0, 120),
    phone: phone.slice(0, 40),
    phoneNorm: normalizePhone(phone) || '',
    email: clean(o.customerEmail).slice(0, 160),
    deliveryType, courier, officeId: '',
    officeText: clean(ship.address).slice(0, 300),
    city: clean(ship.city).slice(0, 80),
    postCode: clean(ship.zipCode).slice(0, 12),
    addressText: deliveryType === 'speedy_address' || deliveryType === 'econt_address' ? clean(ship.address).replace(/^(СПИДИ|ЕКОНТ)\s*–\s*адрес:\s*/i, '').slice(0, 200) : '',
    items: (Array.isArray(o.items) ? o.items : []).slice(0, 30)
      .map((it) => ({ name: clean(it?.name).slice(0, 200), qty: Math.max(1, Number(it?.quantity) || 1), price: money(it?.total) }))
      .filter((it) => it.name),
    total: money(o.total),
    currency,
    paymentMethod: clean(o.paymentMethod).slice(0, 30),
    pageUrl: '',
    createdAt: Number.isFinite(Number(o.created)) && o.created ? new Date(Number(o.created) * 1000).toISOString() : null,
    cbStatus: status.slice(0, 20),
    insertStatus: INSERT_STATUS[status] || 'new',
    updateStatus: UPDATE_STATUS[status] || null,
  };
}

// Products and their stock. The products list is not in the ConvertBuilder spec Ordyx was built on: it is asked for the same way
// as orders (/products, 50 a page) and its fields are read under the usual names, so a shop sees at once whether it works.
const STOCK_FIELDS = ['stock', 'quantity', 'inventoryQuantity', 'stockQuantity', 'inStock', 'qty'];
function stockOf(x) {
  if (!x || typeof x !== 'object') return null;
  if (x.trackInventory === false || x.track_inventory === false || x.manageStock === false) return null;
  for (const f of STOCK_FIELDS) {
    const v = x[f];
    if (v === null || v === undefined || v === '' || typeof v === 'boolean') continue;
    const n = Number(v);
    if (Number.isInteger(n)) return n;
  }
  if (x.inventory && typeof x.inventory === 'object') return stockOf(x.inventory);
  const n = x.inventory === null || x.inventory === undefined || x.inventory === '' ? NaN : Number(x.inventory);
  return Number.isInteger(n) ? n : null;
}
const variantName = (v) => clean(v?.name || v?.title || (Array.isArray(v?.options) ? v.options.map((o) => (typeof o === 'object' ? o?.value ?? o?.name : o)).filter(Boolean).join(', ') : ''));

/** Each product (or each variant, named "Product - Variant" like the order lines) with a counted stock. */
export function mapProductStock(products) {
  const out = [];
  for (const p of Array.isArray(products) ? products : []) {
    const name = clean(p?.name || p?.title).slice(0, 200);
    if (!name) continue;
    const variants = Array.isArray(p.variants) ? p.variants : [];
    if (variants.length) {
      for (const v of variants) {
        const stock = stockOf(v);
        const vn = variantName(v);
        if (stock != null) out.push({ name: vn ? `${name} - ${vn}`.slice(0, 200) : name, sku: clean(v?.sku).slice(0, 60), stock, variant: true });
      }
      continue;
    }
    const stock = stockOf(p);
    if (stock != null) out.push({ name, sku: clean(p.sku).slice(0, 60), stock, variant: false });
  }
  return out;
}

/** All products of the site (capped); null when the site has no products list in its API. */
export async function fetchProducts(cfg, { max = 2000, timeoutMs = 15000 } = {}, fetchImpl = fetch) {
  const out = [];
  for (let skip = 0; out.length < max; skip += 50) {
    let d;
    try { d = await cbRequest(cfg, `/products?${new URLSearchParams({ limit: '50', skip: String(skip) })}`, { fetchImpl, timeoutMs }); } catch (err) {
      if (!out.length && /HTTP 40[45]\b/.test(err.message)) return null;
      throw err;
    }
    const items = Array.isArray(d) ? d : Array.isArray(d?.items) ? d.items : Array.isArray(d?.products) ? d.products : null;
    if (!items) return out.length ? out : null;
    out.push(...items);
    if (items.length < 50 || (d?.totalCount != null && out.length >= d.totalCount)) break;
  }
  return out.slice(0, max);
}
