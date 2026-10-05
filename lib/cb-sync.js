// Brings ConvertBuilder orders into zd.orders: webhook events (one order) and date-range syncs (API list).
import { getIntegration, getSecret, saveIntegration, nekorektenKey } from './integrations-repo.js';
import { fetchOrders, mapOrder } from './convertbuilder.js';
import { upsertCbOrder } from './orders-repo.js';
import { checkOrders } from './nk-check.js';
import { humanize } from './errors-bg.js';

/** Connected ConvertBuilder settings incl. the decrypted key, or null when not set up / switched off. */
export async function cbConfig(q) {
  const i = await getIntegration(q, 'convertbuilder');
  if (!i.hasSecret || !i.config.domain || i.config.active === false) return null;
  return { ...i.config, apiKey: await getSecret(q, 'convertbuilder') };
}

/** One order from a webhook; a brand-new order is also checked on nekorekten.com right away. */
export async function processCbOrder(q, cfg, cbOrder) {
  const o = mapOrder(cbOrder, { store: cfg.store, currency: cfg.currency || 'EUR' });
  const r = await upsertCbOrder(q, o);
  const key = r.inserted && o.phoneNorm ? await nekorektenKey(q) : null;
  if (key) { try { await checkOrders(q, [{ id: r.id, phoneNorm: o.phoneNorm }], key); } catch (err) { console.error('[cb] nekorekten', err); } }
  return r;
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
export async function syncOrders(q, { from, to, max } = {}) {
  const since = from ? dayRange(from, false) : Math.floor(Date.now() / 1000) - 3 * 86400;
  const until = to ? dayRange(to, true) : undefined;
  const cfg = await cbConfig(q);
  if (!cfg) throw new Error('ConvertBuilder is not connected');
  const result = { fetched: 0, inserted: 0, updated: 0 };
  try {
    const orders = await fetchOrders(cfg, { since, until, ...(max ? { max } : {}) });
    result.fetched = orders.length;
    for (const cbOrder of orders) {
      const r = await upsertCbOrder(q, mapOrder(cbOrder, { store: cfg.store, currency: cfg.currency || 'EUR' }));
      result[r.inserted ? 'inserted' : 'updated']++;
    }
    await saveIntegration(q, 'convertbuilder', { config: { lastSyncAt: new Date().toISOString(), lastSyncResult: result, lastError: null } });
    return result;
  } catch (err) {
    await saveIntegration(q, 'convertbuilder', { config: { lastError: humanize(err), lastErrorAt: new Date().toISOString() } });
    throw err;
  }
}
