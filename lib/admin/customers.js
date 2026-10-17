import { getQuery } from '../db.js';
import { adminUser } from '../users.js';
import { resolveShop } from '../shops.js';
import { listCustomers, customerSummary } from '../customers.js';
import { customersToCsv } from '../csv.js';
import { send, searchParams } from '../http.js';

/** GET ?shop&q&segment&sort&page → { customers, total, page, pageSize, summary } · &format=csv → the whole list. */
export default async function handler(req, res) {
  const q = getQuery();
  const user = await adminUser(req, q).catch(() => null);
  if (!user) return send(res, 401, { error: 'auth' });
  if (req.method !== 'GET') return send(res, 405, { error: 'method' });
  try {
    const p = searchParams(req);
    const scope = await resolveShop(q, p.get('shop'), { allowAll: true, user });
    const where = scope.all ? { shopIds: scope.ids } : { shopId: scope.id };
    const filters = { ...where, search: p.get('q') || '', segment: p.get('segment') || '', sort: p.get('sort') || 'spent' };
    if (p.get('format') === 'csv') {
      const { rows } = await listCustomers(q, { ...filters, page: 1, pageSize: 5000 });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="kupuvachi-${new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Sofia' })}.csv"`);
      return res.end(customersToCsv(rows));
    }
    const page = Math.max(1, Number(p.get('page')) || 1);
    const [{ rows, total }, summary] = await Promise.all([listCustomers(q, { ...filters, page }), customerSummary(q, where)]);
    return send(res, 200, { customers: rows, total, page, pageSize: 100, summary });
  } catch (err) {
    if (/[А-Яа-я]/.test(err.message)) return send(res, 400, { error: err.message });
    console.error('[admin] customers failed', err);
    return send(res, 500, { error: 'server' });
  }
}
