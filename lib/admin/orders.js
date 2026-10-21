import { getQuery } from '../db.js';
import { adminUser } from '../users.js';
import { listOrders, updateStatus, pendingNekorekten, atOfficeCounts, toPackCount, setPacked } from '../orders-repo.js';
import { checkOrders } from '../nk-check.js';
import { nekorektenKey } from '../nekorekten.js';
import { waybillText } from '../waybill.js';
import { ordersToCsv } from '../csv.js';
import { readJson, send, searchParams } from '../http.js';
import { syncStockSafe, deleteOrderRestoringStock } from '../stock.js';
import { resolveShop } from '../shops.js';

const PAGE_SIZE = 50;
const NK_RETRY = 2; // unchecked orders re-checked on nekorekten.com when the plain first page opens (free plan: 5 req/min)

export default async function handler(req, res) {
  const q = getQuery();
  const user = await adminUser(req, q).catch(() => null);
  if (!user) return send(res, 401, { error: 'auth' });
  try {
    // a change by id must go through the order's own shop (or "all shops" the admin may see)
    const sameShop = async (id) => {
      const scope = await resolveShop(q, searchParams(req).get('shop'), { allowAll: true, user });
      const [o] = /^[0-9a-f-]{36}$/i.test(String(id || '')) ? await q(`select shop_id from zd.orders where id = $1::uuid`, [id]) : [];
      if (!o) return true; // not found later anyway
      return scope.all ? !scope.ids || scope.ids.includes(o.shop_id) : o.shop_id === scope.id;
    };
    if (req.method === 'PATCH') {
      const b = readJson(req) || {};
      if (!(await sameShop(b.id))) return send(res, 404, { error: 'not found' });
      if (!(await updateStatus(q, String(b.id || ''), String(b.status || '')))) return send(res, 400, { error: 'invalid' });
      await syncStockSafe(q, String(b.id)); // cancelled/returned gives stock back, other statuses take it
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST') {
      const b = readJson(req) || {};
      if (b.action !== 'packed') return send(res, 400, { error: 'action' });
      if (!(await sameShop(b.id))) return send(res, 404, { error: 'not found' });
      const packedAt = await setPacked(q, String(b.id || ''), b.on === true);
      return packedAt === undefined ? send(res, 404, { error: 'not found' }) : send(res, 200, { ok: true, packedAt });
    }
    if (req.method === 'DELETE') {
      const b = readJson(req) || {};
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(b.id || ''))) return send(res, 404, { error: 'not found' });
      if (!(await sameShop(b.id))) return send(res, 404, { error: 'not found' });
      const [w] = await q(`select waybill_number from zd.orders where id = $1::uuid and waybill_number <> '' and not waybill_demo`, [b.id]);
      if (w) return send(res, 400, { error: 'Поръчката има товарителница в Еконт — първо я анулирайте (или проверете в e-Econt), после изтрийте поръчката' });
      // deletes and gives its stock back in one step
      return (await deleteOrderRestoringStock(q, String(b.id))) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'not found' });
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'method' });
    const p = searchParams(req);
    const filters = { status: p.get('status') || '', from: p.get('from') || '', to: p.get('to') || '', search: p.get('q') || '' };
    const scope = await resolveShop(q, p.get('shop'), { allowAll: true, user }); // all = the shops this admin may see
    filters.shopId = scope.id;
    filters.shopIds = scope.all ? scope.ids : null;
    if (p.get('format') === 'csv') {
      const { rows } = await listOrders(q, { ...filters, page: 1, pageSize: 5000 });
      const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Sofia' });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="porachki-${day}.csv"`);
      return res.end(ordersToCsv(rows));
    }
    const plainFirstPage = !p.get('page') || p.get('page') === '1';
    const nkKey = user.owner && plainFirstPage && !filters.status && !filters.from && !filters.to && !filters.search ? nekorektenKey() : null;
    if (nkKey) {
      try { await checkOrders(q, await pendingNekorekten(q, NK_RETRY), nkKey); } catch (err) { console.error('[admin] nekorekten retry', err); }
    }
    const page = Math.max(1, Number(p.get('page')) || 1);
    const scopeOf = { shopId: filters.shopId, shopIds: filters.shopIds };
    const [{ rows, total }, atOffice, toPack] = await Promise.all([listOrders(q, { ...filters, page, pageSize: PAGE_SIZE }), atOfficeCounts(q, scopeOf), toPackCount(q, scopeOf)]);
    return send(res, 200, { orders: rows.map((o) => ({ ...o, waybill: waybillText(o) })), total, page, pageSize: PAGE_SIZE, atOffice, toPack });
  } catch (err) {
    console.error('[admin] orders failed', err);
    return send(res, 500, { error: 'server' });
  }
}
