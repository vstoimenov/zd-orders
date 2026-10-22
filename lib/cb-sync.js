// Brings ConvertBuilder orders into zd.orders: webhook events (one order) and date-range syncs (API list).
import { getIntegration, getSecret, saveIntegration } from './integrations-repo.js';
import { nekorektenKey } from './nekorekten.js';
import { cbRequest, fetchOrders, mapOrder } from './convertbuilder.js';
import { normalizePhone } from './phone.js';
import { upsertCbOrder } from './orders-repo.js';
import { checkOrders } from './nk-check.js';
import { humanize } from './errors-bg.js';
import { syncStockSafe } from './stock.js';
import { DEFAULT_SHOP } from './shops.js';
import { notifyNewOrder } from './push.js';
import { sendOrderConfirmation } from './whatsapp.js';

/** A shop's connected ConvertBuilder settings incl. the decrypted key, or null when not set up / switched off. */
export async function cbConfig(q, shopId = DEFAULT_SHOP) {
  const i = await getIntegration(q, 'convertbuilder', shopId);
  if (!i.hasSecret || !i.config.domain || i.config.active === false) return null;
  return { ...i.config, shopId, apiKey: await getSecret(q, 'convertbuilder', shopId) };
}

const toOrder = (cfg, cbOrder) => ({ ...mapOrder(cbOrder, { store: cfg.store, currency: cfg.currency || 'EUR' }), shopId: cfg.shopId || DEFAULT_SHOP });

/** A widget order kept aside that ConvertBuilder now confirms (same number, same phone) becomes a normal one; true only for the one caller that turned it. */
export async function confirmKeptAside(q, cbOrderId, shopId, phoneNorm = '') {
  return (await q(`update zd.orders set cb_check = 'ok' where cb_order_id = $1 and shop_id = $2::uuid and cb_check = 'pending'
       and ($3 = '' or phone_norm = '' or phone_norm = $3) returning id`, [cbOrderId, shopId, phoneNorm])).length > 0;
}

/** A kept-aside order whose number ConvertBuilder gives to another phone was forged (the number taken in advance): it gives way to the real one. */
async function dropForgedKeptAside(q, o) {
  if (!o.phoneNorm) return;
  await q(`delete from zd.orders where cb_order_id = $1 and shop_id = $2::uuid and cb_check = 'pending' and phone_norm <> '' and phone_norm <> $3`, [o.cbOrderId, o.shopId, o.phoneNorm]);
}

/** What a new order sets off: stock, the nekorekten.com check, the owner's notification and the customer's WhatsApp confirmation. */
export async function startOrder(q, { id, phoneNorm }, logTag = '[cb]', { confirm = true } = {}) {
  await syncStockSafe(q, id);
  const key = phoneNorm ? nekorektenKey() : null;
  if (key) { try { await checkOrders(q, [{ id, phoneNorm }], key); } catch (err) { console.error(logTag, 'nekorekten', err); } }
  await Promise.all([notifyNewOrder(q, id), confirm ? sendOrderConfirmation(q, id) : null]);
}

/** One order from a webhook; a brand-new order (or a widget order it confirms) is started right away. */
export async function processCbOrder(q, cfg, cbOrder) {
  const o = toOrder(cfg, cbOrder);
  await dropForgedKeptAside(q, o);
  const r = await upsertCbOrder(q, o);
  if (!r.id) return r; // the number belongs to another shop: left alone
  const confirmed = await confirmKeptAside(q, o.cbOrderId, o.shopId, o.phoneNorm);
  if (r.inserted || confirmed) await startOrder(q, { id: r.id, phoneNorm: o.phoneNorm });
  else await syncStockSafe(q, r.id);
  return r;
}

/** Whether the shop's ConvertBuilder has this order (same number, and the same phone when both have one). Throws when it cannot be asked. */
export async function cbKnowsOrder(cfg, { number, phoneNorm }, { timeoutMs = 5000 } = {}) {
  const p = new URLSearchParams({ limit: '50', skip: '0', created_at_min: String(Math.floor(Date.now() / 1000) - 6 * 3600) });
  const d = await cbRequest(cfg, `/orders?${p}`, { timeoutMs });
  return (Array.isArray(d?.items) ? d.items : []).some((x) => {
    if (String(x?.id) !== String(number)) return false;
    const theirs = normalizePhone(String(x.shippingAddress?.phone || x.billingAddress?.phone || '')) || '';
    return !phoneNorm || !theirs || theirs === phoneNorm;
  });
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const offsetFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Sofia', timeZoneName: 'longOffset' });
/** Unix seconds of the start (or last second) of a Sofia calendar day, with the summer/winter offset of that day. */
export function dayRange(day, end) {
  const noon = new Date(`${day}T12:00:00Z`);
  if (!DAY.test(String(day)) || Number.isNaN(noon.getTime()) || noon.toISOString().slice(0, 10) !== day) throw new Error('Невалидна дата');
  const tz = offsetFmt.formatToParts(noon).find((p) => p.type === 'timeZoneName')?.value.replace('GMT', '') || '+00:00';
  return Math.floor(Date.parse(`${day}T${end ? '23:59:59' : '00:00:00'}${tz}`) / 1000);
}

/** Orders created between two YYYY-MM-DD days (default: the last 3 days). New ones stay "pending" for nekorekten (checked in batches). */
export async function syncOrders(q, { from, to, max, shopId = DEFAULT_SHOP } = {}) {
  const since = from ? dayRange(from, false) : Math.floor(Date.now() / 1000) - 3 * 86400;
  const until = to ? dayRange(to, true) : undefined;
  const cfg = await cbConfig(q, shopId);
  if (!cfg) throw new Error('ConvertBuilder is not connected');
  const result = { fetched: 0, inserted: 0, updated: 0 };
  try {
    const orders = await fetchOrders(cfg, { since, until, ...(max ? { max } : {}) });
    result.fetched = orders.length;
    const fresh = [];
    for (const cbOrder of orders) {
      const o = toOrder(cfg, cbOrder);
      await dropForgedKeptAside(q, o);
      const r = await upsertCbOrder(q, o);
      if (!r.id) continue; // the number belongs to another shop: left alone
      if (await confirmKeptAside(q, o.cbOrderId, o.shopId, o.phoneNorm)) await startOrder(q, { id: r.id, phoneNorm: o.phoneNorm }); // a widget order it confirms
      else await syncStockSafe(q, r.id);
      if (r.inserted) fresh.push(r.id);
      result[r.inserted ? 'inserted' : 'updated']++;
    }
    // orders the webhook missed: notified together at the end (old ones stay quiet), never one slow push per order
    await Promise.all(fresh.slice(0, 20).map((id) => notifyNewOrder(q, id)));
    await saveIntegration(q, 'convertbuilder', { config: { lastSyncAt: new Date().toISOString(), lastSyncResult: result, lastError: null }, shopId });
    return result;
  } catch (err) {
    await saveIntegration(q, 'convertbuilder', { config: { lastError: humanize(err), lastErrorAt: new Date().toISOString() }, shopId });
    throw err;
  }
}
