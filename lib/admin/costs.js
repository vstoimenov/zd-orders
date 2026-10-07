import { getQuery } from '../db.js';
import { isAdmin } from '../auth.js';
import { getCosts, saveCosts, addExpense, deleteExpense } from '../costs.js';
import { readJson, send } from '../http.js';

/** GET costs · PUT {products, settings} · POST {spentOn, name, amount} adds an expense · DELETE {id} removes one. */
export default async function handler(req, res) {
  if (!isAdmin(req)) return send(res, 401, { error: 'auth' });
  try {
    const q = getQuery();
    const b = readJson(req) || {};
    if (req.method === 'GET') return send(res, 200, await getCosts(q));
    if (req.method === 'PUT') { await saveCosts(q, b); return send(res, 200, { ok: true }); }
    if (req.method === 'POST') return send(res, 200, { ok: true, ...(await addExpense(q, b)) });
    if (req.method === 'DELETE') return (await deleteExpense(q, b.id)) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'not found' });
    return send(res, 405, { error: 'method' });
  } catch (err) {
    if (/invalid/.test(err.message)) return send(res, 400, { error: 'invalid' });
    console.error('[admin] costs failed', err);
    return send(res, 500, { error: 'server' });
  }
}
