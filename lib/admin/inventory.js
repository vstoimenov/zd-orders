import { getQuery } from '../db.js';
import { adminUser } from '../users.js';
import { listInventory, productHistory, saveProduct, adjustStock } from '../stock.js';
import { readJson, send, searchParams } from '../http.js';
import { resolveShop } from '../shops.js';
import { getIntegration } from '../integrations-repo.js';
import { pullCbStock } from '../cb-sync.js';
import { humanize } from '../errors-bg.js';

/** GET → cards + products (+ the ConvertBuilder stock state) · GET ?history=<name> → moves · POST {action: 'save' | 'adjust' | 'pull'} (errors are Bulgarian, for the admin). */
export default async function handler(req, res) {
  const q = getQuery();
  const user = await adminUser(req, q).catch(() => null);
  if (!user) return send(res, 401, { error: 'auth' });
  let shopId;
  try { ({ id: shopId } = await resolveShop(q, searchParams(req).get('shop'), { strict: req.method !== 'GET', user })); } catch (err) { return send(res, 400, { error: err.message }); }
  if (req.method === 'GET') {
    try {
      const name = searchParams(req).get('history');
      if (name != null) return send(res, 200, { moves: await productHistory(q, name, { shopId }) });
      const [list, cb] = await Promise.all([listInventory(q, { shopId }), getIntegration(q, 'convertbuilder', shopId)]);
      const c = cb.config;
      const convertbuilder = cb.hasSecret && c.domain && c.active !== false
        ? { stockApi: c.stockApi ?? null, lastStockAt: c.lastStockAt || null, lastStockError: c.lastStockError || null } : null;
      return send(res, 200, { ...list, convertbuilder });
    } catch (err) { console.error('[admin] inventory', err); return send(res, 500, { error: 'server' }); }
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'method' });
  const b = readJson(req) || {};
  try {
    if (b.action === 'save') return send(res, 200, { ok: true, ...(await saveProduct(q, b, { create: b.create === true, shopId })) });
    if (b.action === 'adjust') return send(res, 200, { ok: true, ...(await adjustStock(q, { ...b, shopId })) });
    if (b.action === 'pull') {
      try { return send(res, 200, { ok: true, ...(await pullCbStock(q, shopId)) }); } catch (err) { return send(res, 400, { error: humanize(err) }); }
    }
    return send(res, 400, { error: 'unknown action' });
  } catch (err) {
    if (/[А-Яа-я]/.test(err.message)) return send(res, 400, { error: err.message });
    console.error('[admin] inventory action failed', b.action, err);
    return send(res, 500, { error: 'server' });
  }
}
