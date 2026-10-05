import { randomBytes } from 'node:crypto';
import { getQuery } from '../../lib/db.js';
import { isAdmin } from '../../lib/auth.js';
import { getIntegration, saveIntegration, getSecret, nekorektenKey } from '../../lib/integrations-repo.js';
import { normalizeDomain, testConnection, ensureWebhook } from '../../lib/convertbuilder.js';
import { syncOrders } from '../../lib/cb-sync.js';
import { getUsage } from '../../lib/nekorekten.js';
import { readJson, send } from '../../lib/http.js';

const base = () => (process.env.PUBLIC_BASE_URL || 'https://kurier.profitbrand.online').replace(/\/$/, '');
// errors are shown to the shop owner in the admin: say what to fix, in Bulgarian, keeping the HTTP code
function humanize(err) {
  const m = err?.message || String(err);
  if (m === 'invalid domain') return 'Невалиден домейн — въведете само домейна на магазина, напр. adhdbg.eu';
  if (/HTTP (401|403)/.test(m)) return `Ключът е отхвърлен (${m}). Проверете API ключа и домейна.`;
  if (/HTTP 404/.test(m)) return `Домейнът не отговаря като ConvertBuilder магазин (${m}). Проверете домейна.`;
  if (/HTTP 429/.test(m)) return `Твърде много заявки (${m}). Опитайте след минута.`;
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return 'Магазинът не отговори навреме. Опитайте отново.';
  if (/fetch failed|ENOTFOUND|EAI_AGAIN/.test(m)) return 'Домейнът не е достъпен. Проверете домейна.';
  if (m === 'ConvertBuilder is not connected') return 'ConvertBuilder не е свързан';
  if (m === 'INTEGRATIONS_SECRET is not set') return 'Сървърът не е настроен за пазене на ключове (липсва INTEGRATIONS_SECRET).';
  return m;
}
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

async function saveConvertBuilder(q, b) {
  const domain = normalizeDomain(b.domain);
  const apiKey = String(b.apiKey || '').trim() || (await getSecret(q, 'convertbuilder'));
  if (!apiKey) throw new Error('Въведете API ключ');
  const active = b.active !== false;
  const test = await testConnection({ domain, apiKey });
  const config = { domain, store: domain.replace(/^www\./, ''), active, currency: 'EUR', connectedAt: new Date().toISOString(), lastError: null };
  if (active) {
    config.webhookSecret = randomBytes(32).toString('hex');
    config.webhookId = (await ensureWebhook({ domain, apiKey }, `${base()}/api/cb/webhook`, config.webhookSecret)).id;
  }
  await saveIntegration(q, 'convertbuilder', { config, secret: String(b.apiKey || '').trim() || undefined });
  return test;
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
