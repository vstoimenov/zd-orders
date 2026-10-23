// A shop's fulfilment warehouse: Ordyx sends it the orders that are ready to ship (signed webhook), the warehouse packs them,
// makes the waybill with its own courier account and reports back through api/fulfilment.js with the same key (Bearer).
// One generic integration — no code per warehouse. Ordyx makes no waybills for a shop with the warehouse on.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { getIntegration, saveIntegration, getSecret } from './integrations-repo.js';
import { open } from './secretbox.js';
import { signBody } from './woo-callback.js';
import { ensureConfirmToken } from './orders-repo.js';

export const PROVIDER = 'fulfilment';
const KEY = /^ordyx_ful_([A-Za-z0-9]{10})_[A-Za-z0-9_-]{32}$/;
const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const keyId = () => Array.from(randomBytes(10), (b) => B62[b % 62]).join('');
const URL_OK = /^https:\/\/[^\s]+$/;
const SEND_ON = ['confirmed', 'new'];
const iso = (v) => (v ? new Date(v).toISOString() : null);

/** A new warehouse key for the shop (shown once); the previous one stops working. */
export async function makeFulfilmentKey(q, shopId) {
  const id = keyId();
  const key = `ordyx_ful_${id}_${randomBytes(24).toString('base64url')}`;
  await saveIntegration(q, PROVIDER, { config: { keyId: id, createdAt: new Date().toISOString() }, secret: key, shopId });
  return { key };
}

/** The shop a warehouse key belongs to, or null (unknown, renewed, malformed). `enabled` tells whether orders are being sent. */
export async function fulfilmentByKey(q, key) {
  const m = KEY.exec(String(key || ''));
  if (!m) return null;
  const [r] = await q(
    `select i.shop_id, i.secret_enc, i.config, s.name from zd.integrations i join zd.shops s on s.id = i.shop_id
     where i.provider = $1 and i.config->>'keyId' = $2`, [PROVIDER, m[1]]);
  if (!r?.secret_enc) return null;
  const a = Buffer.from(open(r.secret_enc)), b = Buffer.from(String(key));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const cfg = typeof r.config === 'string' ? JSON.parse(r.config) : r.config || {};
  return { shopId: r.shop_id, name: r.name, enabled: cfg.enabled === true };
}

/** The sealed key itself, for signing what Ordyx sends to the warehouse. */
export const fulfilmentSecret = (q, shopId) => getSecret(q, PROVIDER, shopId);

export async function noteFulfilment(q, shopId, patch) { await saveIntegration(q, PROVIDER, { config: patch, shopId }); }

/** The warehouse's address and when orders go there; saving turns the integration on. Throws Bulgarian messages. */
export async function saveFulfilment(q, shopId, { url, sendOn } = {}) {
  const u = String(url || '').trim();
  if (!URL_OK.test(u) || u.length > 300) throw new Error('Адресът на склада трябва да започва с https://');
  const on = SEND_ON.includes(sendOn) ? sendOn : 'confirmed';
  await saveIntegration(q, PROVIDER, { config: { url: u, sendOn: on, enabled: true, lastError: null }, shopId });
  return fulfilmentStatus(q, shopId);
}

/** Nothing new is sent; the key keeps accepting the warehouse's reports about parcels already there. */
export async function pauseFulfilment(q, shopId) { await saveIntegration(q, PROVIDER, { config: { enabled: false }, shopId }); }

/** Forgets the warehouse and its key — only when no order sent there is still waiting for its waybill. */
export async function deleteFulfilment(q, shopId) {
  const [{ n }] = await q(
    `select count(*)::int as n from zd.orders where shop_id = $1::uuid and fulfil_sent_at is not null and waybill_number = '' and status in ('new', 'confirmed')`,
    [shopId]);
  if (n > 0) throw new Error(`${n} поръчки са при склада и още не са изпратени`);
  await q(`delete from zd.integrations where provider = $1 and shop_id = $2::uuid`, [PROVIDER, shopId]);
}

export async function fulfilmentEnabled(q, shopId) {
  const i = await getIntegration(q, PROVIDER, shopId);
  return i.config.enabled === true;
}

/** What the admin may see — never the key. */
export async function fulfilmentStatus(q, shopId) {
  const i = await getIntegration(q, PROVIDER, shopId);
  const c = i.config;
  return {
    enabled: c.enabled === true, url: c.url || '', sendOn: SEND_ON.includes(c.sendOn) ? c.sendOn : 'confirmed', keyId: c.keyId || '', hasKey: i.hasSecret,
    createdAt: c.createdAt || null, lastSentAt: c.lastSentAt || null, lastReceivedAt: c.lastReceivedAt || null, lastError: c.lastError || null,
    due: c.enabled === true ? await countDue(q, shopId) : 0,
  };
}

/* ---- orders → warehouse ---- */

/**
 * Which orders go to the warehouse: not sent yet, no waybill, not held by a ConvertBuilder check; confirmed by the customer — or
 * still new when the shop sends at once (`sendOn = 'new'`) or the order is paid (card/bank: it never gets a confirmation request).
 * `o` = zd.orders, `c` = the shop's fulfilment integration row.
 */
export const DUE_SQL = `o.fulfil_sent_at is null and o.waybill_number = '' and o.cb_check <> 'pending'
  and (o.status = 'confirmed' or (o.status = 'new' and (c.config->>'sendOn' = 'new' or o.payment_method <> 'cod')))`;
const ENABLED_JOIN = `join zd.integrations c on c.shop_id = o.shop_id and c.provider = '${PROVIDER}' and c.config->>'enabled' = 'true'`;

/** The same rule for one loaded row and its integration config. */
export function isDue(o, cfg) {
  if (!cfg || cfg.enabled !== true) return false;
  if (o.fulfil_sent_at || o.waybill_number !== '' || o.cb_check === 'pending') return false;
  if (o.status === 'confirmed') return true;
  return o.status === 'new' && (cfg.sendOn === 'new' || o.payment_method !== 'cod');
}

const base = () => (process.env.PUBLIC_BASE_URL || 'https://app.ordyx.eu').replace(/\/$/, '');
const num = (v) => Math.round(Number(v || 0) * 100) / 100;

/** The body the warehouse gets for a new order (spec: event 'order'). */
export async function buildOrderBody(q, r) {
  const items = (typeof r.items === 'string' ? JSON.parse(r.items) : r.items) || [];
  const noSku = items.filter((it) => !it.sku).map((it) => String(it.name || ''));
  const skus = new Map();
  if (noSku.length) {
    for (const p of await q(`select name, sku from zd.product_costs where shop_id = $1::uuid and sku <> '' and name = any($2::text[])`, [r.shop_id, noSku])) skus.set(p.name, p.sku);
  }
  const t = String(r.delivery_type || '');
  const office = /_(office|locker)$/.test(t) ? { id: r.office_id || '', code: String(r.office_id || '').replace(/^[^:]*:/, ''), text: r.office_text || '' } : null;
  const address = /_address$/.test(t) ? { city: r.city || '', post_code: r.post_code || '', street: r.address_text || '' } : null;
  const delivery = { type: t, courier: r.courier || '', office, address, ...(t === 'other' ? { text: r.office_text || '' } : {}) };
  const body = {
    api: 1, event: 'order',
    order: {
      id: r.id, number: r.cb_order_id, created_at: new Date(r.created_at).toISOString(), status: r.status,
      customer: { name: String(r.name || '').trim(), phone: r.phone_norm || r.phone || '', email: r.email || '' },
      delivery,
      items: items.map((it) => ({ sku: String(it.sku || skus.get(String(it.name || '')) || ''), name: String(it.name || ''), qty: Number(it.qty) || 1, price: num(it.price) })),
      total: num(r.total), currency: r.currency || 'EUR',
      payment: { method: r.payment_method || 'cod', cod_amount: r.payment_method === 'cod' ? num(r.total) : 0 },
      tracking_page: `${base()}/p/${await ensureConfirmToken(q, r.id)}`,
    },
  };
  if (r.is_duplicate) body.duplicate = true;
  return body;
}

const TIMEOUT_MS = 5000;
async function target(q, shopId) {
  const i = await getIntegration(q, PROVIDER, shopId);
  const key = i.hasSecret ? await fulfilmentSecret(q, shopId) : null;
  return { cfg: i.config, url: i.config.url || '', key };
}

/**
 * Sends one event ('order' | 'cancelled') for the order to its shop's warehouse. True when the warehouse took it; false otherwise
 * (the event stays in fulfil_notify and the error in the integration). Never throws. A paused integration still gets cancels.
 */
export async function sendEvent(q, orderId, event, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  let shopId = null;
  try {
    const [r] = await q(`select * from zd.orders where id = $1::uuid`, [orderId]);
    if (!r) return false;
    shopId = r.shop_id;
    const { cfg, url, key } = await target(q, shopId);
    if (!url || !key || (cfg.enabled !== true && event !== 'cancelled')) return false;
    const body = JSON.stringify(event === 'cancelled' ? { api: 1, event, order: { id: r.id, number: r.cb_order_id } } : await buildOrderBody(q, r));
    const { timestamp, signature } = signBody(key, body);
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST', body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'Content-Type': 'application/json', 'X-Ordyx-Timestamp': timestamp, 'X-Ordyx-Signature': signature },
      });
    } catch {
      throw new Error('складът не отговаря');
    }
    if (res.status >= 300 && res.status < 400) throw new Error(`складът пренасочва (${res.status})`);
    if (!res.ok) throw new Error(`складът отговори ${res.status}`);
    if (event === 'cancelled') await q(`update zd.orders set fulfil_sent_at = null, fulfil_notify = '' where id = $1::uuid`, [r.id]);
    else await q(`update zd.orders set fulfil_sent_at = now(), fulfil_notify = '' where id = $1::uuid`, [r.id]);
    await noteFulfilment(q, shopId, { lastSentAt: new Date().toISOString(), lastError: null });
    return true;
  } catch (err) {
    console.error('[fulfilment] send failed', orderId, event, err?.message);
    if (shopId) {
      await q(`update zd.orders set fulfil_notify = $2 where id = $1::uuid`, [orderId, event]).catch(() => {});
      await noteFulfilment(q, shopId, { lastError: `Към склада (${event === 'cancelled' ? 'отказ' : 'поръчка'}): ${err?.message || err}` }).catch(() => {});
    }
    return false;
  }
}

/** The order just became ready (confirmed / created): to the warehouse at once when it is due. Never throws. */
export async function queueFulfilment(q, orderId, opts = {}) {
  try {
    const [r] = await q(`select o.*, c.config as ful_config from zd.orders o left join zd.integrations c on c.shop_id = o.shop_id and c.provider = '${PROVIDER}' where o.id = $1::uuid`, [orderId]);
    if (!r) return;
    const cfg = typeof r.ful_config === 'string' ? JSON.parse(r.ful_config) : r.ful_config;
    if (!isDue(r, cfg)) return;
    await q(`update zd.orders set fulfil_notify = 'order' where id = $1::uuid`, [orderId]);
    await sendEvent(q, orderId, 'order', opts);
  } catch (err) {
    console.error('[fulfilment] queue failed', orderId, err?.message);
  }
}

/** The order was cancelled: the warehouse hears it when it already has the order; otherwise there is nothing to send. Never throws. */
export async function queueCancel(q, orderId, opts = {}) {
  try {
    const [r] = await q(`select fulfil_sent_at from zd.orders where id = $1::uuid`, [orderId]);
    if (!r) return;
    if (!r.fulfil_sent_at) { await q(`update zd.orders set fulfil_notify = '' where id = $1::uuid`, [orderId]); return; }
    await q(`update zd.orders set fulfil_notify = 'cancelled' where id = $1::uuid`, [orderId]);
    await sendEvent(q, orderId, 'cancelled', opts);
  } catch (err) {
    console.error('[fulfilment] cancel failed', orderId, err?.message);
  }
}

const RETRY_DAYS = 30;
const WAITING = `o.created_at > now() - interval '${RETRY_DAYS} days' and (o.fulfil_notify <> '' or (${DUE_SQL}))`;

/**
 * Orders still to go to the warehouse (due, or an event that did not get through) — oldest first, within a time budget; a shop
 * whose warehouse fails once is left for the next run. Nightly, when the shop opens Поръчки, and on „Изпрати неизпратените“.
 */
export async function retryDue(q, { shopId = null, budgetMs = 15000, max = Infinity, fetchImpl } = {}) {
  const rows = await q(`select o.id, o.shop_id, o.fulfil_notify from zd.orders o ${ENABLED_JOIN} where ${WAITING} and ($1::uuid is null or o.shop_id = $1::uuid) order by o.created_at limit 500`, [shopId]);
  const deadline = Date.now() + budgetMs, failed = new Set();
  let retried = 0, sent = 0;
  for (const r of rows) {
    if (retried >= max || Date.now() > deadline || failed.has(r.shop_id)) continue;
    retried++;
    if (await sendEvent(q, r.id, r.fulfil_notify || 'order', fetchImpl ? { fetchImpl } : {})) sent++; else failed.add(r.shop_id);
  }
  return { retried, sent };
}

/** Orders of this shop waiting to go to the warehouse. */
export async function countDue(q, shopId) {
  const [{ n }] = await q(`select count(*)::int as n from zd.orders o ${ENABLED_JOIN} where ${WAITING} and o.shop_id = $1::uuid`, [shopId]);
  return n;
}

export { iso };
