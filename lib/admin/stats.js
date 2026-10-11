import { getQuery } from '../db.js';
import { adminUser } from '../users.js';
import { getStats } from '../stats.js';
import { getProfit, getProfitAll } from '../costs.js';
import { resolveShop, shopsFor } from '../shops.js';
import { send, searchParams } from '../http.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const realDate = (s) => {
  if (!DATE.test(s || '')) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const sofiaDay = (offsetDays = 0) => new Date(Date.now() + offsetDays * 864e5).toLocaleDateString('sv-SE', { timeZone: 'Europe/Sofia' });

/** GET ?from=YYYY-MM-DD&to=YYYY-MM-DD&shop=<id>|all — dashboard figures; defaults to the last 7 days. "all" adds a table per shop. */
export default async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { error: 'method' });
  const p = searchParams(req);
  const to = realDate(p.get('to')) ? p.get('to') : sofiaDay();
  const from = realDate(p.get('from')) ? p.get('from') : sofiaDay(-6);
  try {
    const q = getQuery();
    const user = await adminUser(req, q);
    if (!user) return send(res, 401, { error: 'auth' });
    const { id: shopId, ids } = await resolveShop(q, p.get('shop'), { allowAll: true, user });
    if (shopId) {
      const [stats, profit] = await Promise.all([getStats(q, { from, to, shopId }), getProfit(q, { from, to, shopId })]);
      return send(res, 200, { ...stats, profit });
    }
    // all shops this admin may see (a client: only theirs)
    const [stats, profit, shops] = await Promise.all([getStats(q, { from, to, shopIds: ids }), getProfitAll(q, { from, to, shopIds: ids }), shopsFor(q, user)]);
    const per = await Promise.all(shops.map((s) => getStats(q, { from, to, shopId: s.id })));
    const byShop = shops.map((s, i) => {
      const st = per[i], pr = profit.byShop.find((x) => x.shopId === s.id) || {};
      const eur = (st.cards.revenue || []).find((m) => m.currency === 'EUR');
      return { id: s.id, name: s.display, hidden: s.hidden, orders: st.cards.orders, revenue: eur ? eur.amount : 0, profit: pr.profit ?? 0, adSpend: pr.adSpend ?? 0,
        roas: pr.adSpend ? Math.round(((eur ? eur.amount : 0) / pr.adSpend) * 100) / 100 : null };
    });
    return send(res, 200, { ...stats, profit, byShop });
  } catch (err) {
    console.error('[admin] stats failed', err);
    return send(res, 500, { error: 'server' });
  }
}
