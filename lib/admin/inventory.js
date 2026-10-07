import { getQuery } from '../db.js';
import { isAdmin } from '../auth.js';
import { listInventory, productHistory, saveProduct, adjustStock } from '../stock.js';
import { readJson, send, searchParams } from '../http.js';

/** GET → cards + products · GET ?history=<name> → moves · POST {action: 'save' | 'adjust'} (errors are Bulgarian, for the admin). */
export default async function handler(req, res) {
  if (!isAdmin(req)) return send(res, 401, { error: 'auth' });
  const q = getQuery();
  if (req.method === 'GET') {
    try {
      const name = searchParams(req).get('history');
      return send(res, 200, name != null ? { moves: await productHistory(q, name) } : await listInventory(q));
    } catch (err) { console.error('[admin] inventory', err); return send(res, 500, { error: 'server' }); }
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'method' });
  const b = readJson(req) || {};
  try {
    if (b.action === 'save') return send(res, 200, { ok: true, ...(await saveProduct(q, b, { create: b.create === true })) });
    if (b.action === 'adjust') return send(res, 200, { ok: true, ...(await adjustStock(q, b)) });
    return send(res, 400, { error: 'unknown action' });
  } catch (err) {
    if (/[А-Яа-я]/.test(err.message)) return send(res, 400, { error: err.message });
    console.error('[admin] inventory action failed', b.action, err);
    return send(res, 500, { error: 'server' });
  }
}
