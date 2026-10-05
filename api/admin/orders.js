import { getQuery } from '../../lib/db.js';
import { isAdmin } from '../../lib/auth.js';
import { listOrders, updateStatus, pendingNekorekten, deleteOrder } from '../../lib/orders-repo.js';
import { checkOrders } from '../../lib/nk-check.js';
import { nekorektenKey } from '../../lib/nekorekten.js';
import { waybillText } from '../../lib/waybill.js';
import { ordersToCsv } from '../../lib/csv.js';
import { readJson, send, searchParams } from '../../lib/http.js';

const PAGE_SIZE = 50;
const NK_RETRY = 2; // unchecked orders re-checked on nekorekten.com when the plain first page opens (free plan: 5 req/min)

export default async function handler(req, res) {
  if (!isAdmin(req)) return send(res, 401, { error: 'auth' });
  try {
    const q = getQuery();
    if (req.method === 'PATCH') {
      const b = readJson(req) || {};
      return (await updateStatus(q, String(b.id || ''), String(b.status || '')))
        ? send(res, 200, { ok: true })
        : send(res, 400, { error: 'invalid' });
    }
    if (req.method === 'DELETE') {
      const b = readJson(req) || {};
      return (await deleteOrder(q, String(b.id || ''))) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'not found' });
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'method' });
    const p = searchParams(req);
    const filters = { status: p.get('status') || '', from: p.get('from') || '', to: p.get('to') || '', search: p.get('q') || '' };
    if (p.get('format') === 'csv') {
      const { rows } = await listOrders(q, { ...filters, page: 1, pageSize: 5000 });
      const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Sofia' });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="porachki-${day}.csv"`);
      return res.end(ordersToCsv(rows));
    }
    const plainFirstPage = !p.get('page') || p.get('page') === '1';
    const nkKey = plainFirstPage && !filters.status && !filters.from && !filters.to && !filters.search ? nekorektenKey() : null;
    if (nkKey) {
      try { await checkOrders(q, await pendingNekorekten(q, NK_RETRY), nkKey); } catch (err) { console.error('[admin] nekorekten retry', err); }
    }
    const page = Math.max(1, Number(p.get('page')) || 1);
    const { rows, total } = await listOrders(q, { ...filters, page, pageSize: PAGE_SIZE });
    return send(res, 200, { orders: rows.map((o) => ({ ...o, waybill: waybillText(o) })), total, page, pageSize: PAGE_SIZE });
  } catch (err) {
    console.error('[admin] orders failed', err);
    return send(res, 500, { error: 'server' });
  }
}
