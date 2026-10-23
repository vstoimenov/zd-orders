import { getQuery } from '../db.js';
import { adminUser } from '../users.js';
import { listOrders, updateStatus, pendingNekorekten, atOfficeCounts, toPackCount, problemCount, setPacked, toOrder } from '../orders-repo.js';
import { syncShopStatuses } from '../waybills.js';
import { listShops } from '../shops.js';
import { checkOrders } from '../nk-check.js';
import { nekorektenKey } from '../nekorekten.js';
import { waybillText } from '../waybill.js';
import { ordersToCsv } from '../csv.js';
import { readJson, send, searchParams } from '../http.js';
import { syncStockSafe, deleteOrderRestoringStock } from '../stock.js';
import { resolveShop } from '../shops.js';
import { slipHtml } from '../packing-slip.js';
import { notifySite } from '../woo-callback.js';
import { createManualOrder, previewImport, importCsv } from '../manual-orders.js';
import { queueFulfilment, queueCancel, fulfilmentEnabled, countDue, retryDue } from '../fulfilment.js';

const SLIP_MAX = 200;
const REFRESH_START_MS = 30000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
      if (b.status === 'cancelled') await notifySite(q, String(b.id), 'cancelled'); // a WooCommerce order: its site cancels it too
      if (b.status === 'cancelled') await queueCancel(q, String(b.id)); else if (b.status === 'confirmed') await queueFulfilment(q, String(b.id));
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST') {
      const b = readJson(req) || {};
      if (b.action === 'refresh_statuses') { // „Обнови статусите“: every shop in view, its connected couriers, now
        const scope = await resolveShop(q, searchParams(req).get('shop'), { allowAll: true, user });
        const ids = scope.all ? scope.ids || (await listShops(q)).map((s) => s.id) : [scope.id];
        const deadline = Date.now() + REFRESH_START_MS; // a courier started by then still ends within the 60 s
        const total = { checked: 0, delivered: 0, returned: 0, errors: [], skipped: [] };
        for (const id of ids) {
          const r = await syncShopStatuses(q, id, { deadline });
          total.checked += r.checked; total.delivered += r.delivered; total.returned += r.returned; total.errors.push(...r.errors); total.skipped.push(...r.skipped);
        }
        return send(res, 200, { ok: true, ...total });
      }
      if (b.action === 'create' || b.action === 'import') { // typed in the admin / a CSV file — into one shop the admin may write to
        let shop;
        try { ({ shop } = await resolveShop(q, searchParams(req).get('shop'), { strict: true, user })); } catch (err) { return send(res, 400, { error: err.message }); }
        try {
          const scope = { shopId: shop.id, domain: shop.domain, currency: shop.currency || 'EUR' };
          if (b.action === 'create') return send(res, 200, { ok: true, ...(await createManualOrder(q, { ...scope, order: b.order })) });
          const csv = typeof b.csv === 'string' ? (b.csvBase64 ? Buffer.from(b.csv, 'base64') : b.csv) : '';
          if (b.confirm === true) return send(res, 200, { ok: true, ...(await importCsv(q, { ...scope, csv })) });
          const p = await previewImport(q, { ...scope, csv });
          return send(res, 200, { ok: true, ...p, rows: p.rows.map((r) => ({ row: r.row, ok: r.ok, error: r.error, order: r.order && { name: r.order.name, phone: r.order.phone, officeText: r.order.officeText, city: r.order.city, items: r.order.items, total: r.order.total, paymentMethod: r.order.paymentMethod } })) });
        } catch (err) {
          if (/[А-Яа-я]/.test(err.message)) return send(res, 400, { error: err.message });
          throw err;
        }
      }
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
    const filters = { status: p.get('status') || '', from: p.get('from') || '', to: p.get('to') || '', search: p.get('q') || '', id: p.get('id') || '' };
    const scope = await resolveShop(q, p.get('shop'), { allowAll: true, user }); // all = the shops this admin may see
    filters.shopId = scope.id;
    filters.shopIds = scope.all ? scope.ids : null;
    if (filters.id) { // the QR link on a packing slip: the order's own shop, whatever the phone has selected (if the admin may see it)
      if (!UUID.test(filters.id)) filters.id = '00000000-0000-0000-0000-000000000000';
      const [o] = await q(`select shop_id from zd.orders where id = $1::uuid`, [filters.id]);
      const mine = await resolveShop(q, 'all', { allowAll: true, user });
      if (o && (!mine.ids || mine.ids.includes(o.shop_id))) { filters.shopId = o.shop_id; filters.shopIds = null; }
    }
    if (p.get('slip')) { // packing slips: one order, or every order still to pack
      const which = String(p.get('slip'));
      let rows, capped = false;
      if (which === 'all') {
        const r = await listOrders(q, { ...filters, status: 'to_pack', page: 1, pageSize: SLIP_MAX + 1 });
        capped = r.rows.length > SLIP_MAX; rows = r.rows.slice(0, SLIP_MAX);
      } else {
        if (!UUID.test(which) || !(await sameShop(which))) return send(res, 404, { error: 'not found' });
        const [r] = await q(`select * from zd.orders where id = $1::uuid`, [which]);
        if (!r) return send(res, 404, { error: 'not found' });
        rows = [toOrder(r)];
      }
      const ids = [...new Set(rows.map((o) => String(o.shopId)))];
      const names = ids.length ? Object.fromEntries((await q(`select id, name from zd.shops where id = any($1::uuid[])`, [ids])).map((s) => [s.id, s.name])) : {};
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.end(await slipHtml(names, rows, { capped }));
    }
    if (p.get('format') === 'csv') {
      const { rows } = await listOrders(q, { ...filters, page: 1, pageSize: 5000 });
      const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Sofia' });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="porachki-${day}.csv"`);
      return res.end(ordersToCsv(rows));
    }
    const plainFirstPage = !p.get('page') || p.get('page') === '1';
    const nkKey = user.owner && plainFirstPage && !filters.status && !filters.from && !filters.to && !filters.search && !filters.id ? nekorektenKey() : null;
    if (nkKey) {
      try { await checkOrders(q, await pendingNekorekten(q, NK_RETRY), nkKey); } catch (err) { console.error('[admin] nekorekten retry', err); }
    }
    const page = Math.max(1, Number(p.get('page')) || 1);
    const scopeOf = { shopId: filters.shopId, shopIds: filters.shopIds };
    // orders still to go to the shop's fulfilment warehouse (a failed send, a CSV import): a few of them now, the rest tonight
    if (filters.shopId && plainFirstPage && await fulfilmentEnabled(q, filters.shopId) && await countDue(q, filters.shopId) > 0) {
      try { await retryDue(q, { shopId: filters.shopId, budgetMs: 3000, max: 5 }); } catch (err) { console.error('[admin] fulfilment retry', err); }
    }
    const [{ rows, total }, atOffice, toPack, problems, warehouse] = await Promise.all([
      listOrders(q, { ...filters, page, pageSize: PAGE_SIZE }), atOfficeCounts(q, scopeOf), toPackCount(q, scopeOf), problemCount(q, scopeOf),
      filters.shopId ? fulfilmentEnabled(q, filters.shopId) : false]); // the shop's fulfilment warehouse makes the waybills: no button here
    return send(res, 200, { orders: rows.map((o) => ({ ...o, waybill: waybillText(o) })), total, page, pageSize: PAGE_SIZE, atOffice, toPack, problems, warehouse });
  } catch (err) {
    console.error('[admin] orders failed', err);
    return send(res, 500, { error: 'server' });
  }
}
