import { randomBytes } from 'node:crypto';
import { getQuery } from '../../lib/db.js';
import { isAdmin } from '../../lib/auth.js';
import { getIntegration, saveIntegration, getSecret, nekorektenKey } from '../../lib/integrations-repo.js';
import { normalizeDomain, testConnection, ensureWebhook, removeWebhook } from '../../lib/convertbuilder.js';
import { syncOrders } from '../../lib/cb-sync.js';
import { getUsage } from '../../lib/nekorekten.js';
import { readJson, send } from '../../lib/http.js';
import { humanize } from '../../lib/errors-bg.js';
import { assertReady } from '../../lib/secretbox.js';

const base = () => (process.env.PUBLIC_BASE_URL || 'https://kurier.profitbrand.online').replace(/\/$/, '');
const fail = (res, err) => send(res, 400, { error: humanize(err) });

async function status(q) {
  const [cb, nk, offices] = await Promise.all([
    getIntegration(q, 'convertbuilder'),
    getIntegration(q, 'nekorekten'),
    q(`select courier, count(*)::int as n, max(updated_at) as updated from zd.offices group by courier`),
  ]);
  const c = cb.config;
  const byCourier = Object.fromEntries(offices.map((r) => [r.courier, { offices: r.n, updatedAt: r.updated ? new Date(r.updated).toISOString() : null }]));
  return {
    convertbuilder: {
      configured: cb.hasSecret, connected: cb.hasSecret && c.active !== false && Boolean(c.domain), domain: c.domain || '', active: c.active !== false,
      webhook: Boolean(c.webhookId), connectedAt: c.connectedAt || null, lastSyncAt: c.lastSyncAt || null, lastSyncResult: c.lastSyncResult || null,
      lastError: c.lastError || null,
    },
    nekorekten: { configured: nk.hasSecret || Boolean(process.env.NEKOREKTEN_API_KEY), source: nk.hasSecret ? 'admin' : process.env.NEKOREKTEN_API_KEY ? 'env' : null },
    econt: byCourier.econt || { offices: 0, updatedAt: null },
    speedy: byCourier.speedy || { offices: 0, updatedAt: null },
    meta: { soon: true },
  };
}

/** Hosts the checkout widget recorded orders under lately (api/orders.js keys them by the page's domain without www). */
async function widgetStores(q) {
  const rows = await q(`select distinct split_part(cb_order_id, ':', 1) as store from zd.orders
    where source = 'widget' and created_at > now() - interval '60 days' order by 1`);
  return rows.map((r) => r.store);
}

async function saveConvertBuilder(q, b) {
  assertReady(); // nothing may change at ConvertBuilder if the key could not be stored afterwards
  const domain = normalizeDomain(b.domain);
  const store = domain.replace(/^www\./, '');
  const current = await getIntegration(q, 'convertbuilder');
  const typedKey = String(b.apiKey || '').trim();
  // the stored key only ever goes to the domain it was saved for
  if (!typedKey && (!current.hasSecret || current.config.domain !== domain)) {
    throw new Error(current.hasSecret ? 'При смяна на домейна въведете API ключа отново' : 'Въведете API ключ');
  }
  // the same order must get the same id from the widget and from the API, or every order would be stored twice
  const stores = await widgetStores(q);
  if (stores.length && !stores.includes(store)) {
    throw new Error(`Чекаутът записва поръчките под домейн ${stores.join(', ')}. Въведете този домейн, за да не се дублират поръчките.`);
  }
  const apiKey = typedKey || (await getSecret(q, 'convertbuilder'));
  const cfg = { domain, apiKey };
  const target = `${base()}/api/cb/webhook`;
  const config = { domain, store, currency: 'EUR', lastError: null };
  if (b.active === false) {
    // switching off must work even with a revoked key: remove our webhook if ConvertBuilder still lets us
    try { await removeWebhook(cfg, target); } catch (err) { console.error('[admin] webhook removal failed', err.message); }
    await saveIntegration(q, 'convertbuilder', { config: { ...config, active: false, webhookId: null, webhookSecret: null }, secret: typedKey || undefined });
    return { active: false };
  }
  const test = await testConnection(cfg);
  Object.assign(config, { active: true, connectedAt: new Date().toISOString(), webhookSecret: randomBytes(32).toString('hex') });
  try {
    config.webhookId = (await ensureWebhook(cfg, target, config.webhookSecret)).id;
  } catch (err) {
    // the old hook may already be deleted: do not keep showing it as registered
    await saveIntegration(q, 'convertbuilder', { config: { webhookId: null } });
    throw err;
  }
  await saveIntegration(q, 'convertbuilder', { config, secret: typedKey || undefined });
  return { active: true, ...test };
}

/** GET status · POST {action}: save_convertbuilder {domain, apiKey, active} | test_convertbuilder | sync_convertbuilder {from, to}
 *  | save_nekorekten {apiKey} | test_nekorekten. Keys are sealed in the DB and never sent back. */
export default async function handler(req, res) {
  if (!isAdmin(req)) return send(res, 401, { error: 'auth' });
  const q = getQuery();
  if (req.method === 'GET') {
    try { return send(res, 200, await status(q)); } catch (err) { console.error('[admin] integrations', err); return send(res, 500, { error: 'server' }); }
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'method' });
  const b = readJson(req) || {};
  try {
    switch (b.action) {
      case 'save_convertbuilder': return send(res, 200, { ok: true, ...(await saveConvertBuilder(q, b)) });
      case 'test_convertbuilder': {
        const i = await getIntegration(q, 'convertbuilder');
        if (!i.hasSecret) throw new Error('ConvertBuilder не е свързан');
        return send(res, 200, { ok: true, ...(await testConnection({ domain: i.config.domain, apiKey: await getSecret(q, 'convertbuilder') })) });
      }
      case 'sync_convertbuilder': return send(res, 200, { ok: true, result: await syncOrders(q, { from: b.from, to: b.to }) });
      case 'save_nekorekten': {
        const key = String(b.apiKey || '').trim();
        if (!key) throw new Error('Въведете API ключ');
        const usage = await getUsage(key);
        await saveIntegration(q, 'nekorekten', { config: { connectedAt: new Date().toISOString() }, secret: key });
        return send(res, 200, { ok: true, usage });
      }
      case 'test_nekorekten': {
        const key = await nekorektenKey(q);
        if (!key) throw new Error('НЕкоректен не е свързан');
        return send(res, 200, { ok: true, usage: await getUsage(key) });
      }
      default: return send(res, 400, { error: 'unknown action' });
    }
  } catch (err) {
    console.error('[admin] integrations action failed', b.action, err.message);
    return fail(res, err);
  }
}
