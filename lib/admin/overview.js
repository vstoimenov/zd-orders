// „Профил“ → the whole picture: the three numbers that matter across every shop the user sees, against the period before,
// the revenue curve of both periods, the shops side by side and the latest orders. GET ?range=7d|30d|90d|12m[&shop=<id>|all]
// (with shop: only that shop, or the admin's own shops, as on „Табло“) · POST {action: 'goal', amount, shop} → the month's goal.
import { getQuery } from '../db.js';
import { adminUser } from '../users.js';
import { listShops, shopsFor, resolveShop } from '../shops.js';
import { getStats, scope } from '../stats.js';
import { getProfitAll } from '../costs.js';
import { readJson, send, searchParams } from '../http.js';

const RANGES = { '7d': 7, '30d': 30, '90d': 90, '12m': 365 };
const SOLD = `status not in ('cancelled', 'returned')`;
const round2 = (v) => Math.round(Number(v) * 100) / 100;
const sofiaDay = (ms = Date.now()) => new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Europe/Sofia' });
const shift = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const MONTHS_BG = ['яну', 'фев', 'мар', 'апр', 'май', 'юни', 'юли', 'авг', 'сеп', 'окт', 'ное', 'дек'];

/** The buckets of a window: days (≤ 31), weeks (≤ 120 days) or calendar months. Each { from, to, tick, label }. */
export function buckets(from, to) {
  const days = Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 864e5) + 1;
  const out = [];
  const dm = (d) => `${Number(d.slice(8))} ${MONTHS_BG[Number(d.slice(5, 7)) - 1]}`;
  if (days <= 31) {
    for (let d = from; d <= to; d = shift(d, 1)) out.push({ from: d, to: d, tick: d.slice(8) + '.' + d.slice(5, 7), label: dm(d) });
  } else if (days <= 120) {
    for (let d = from; d <= to; d = shift(d, 7)) { const e = shift(d, 6) > to ? to : shift(d, 6); out.push({ from: d, to: e, tick: dm(d), label: `${dm(d)} – ${dm(e)}` }); }
  } else {
    let d = from;
    while (d <= to) {
      const end = new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)), 0)).toISOString().slice(0, 10); // last day of d's month
      const e = end > to ? to : end;
      out.push({ from: d, to: e, tick: MONTHS_BG[Number(d.slice(5, 7)) - 1], label: `${MONTHS_BG[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}` });
      d = shift(e, 1);
    }
  }
  return out;
}
/** Sums the daily rows (day, orders, revenue) into the buckets; a bucket without rows is 0. */
export function bucketize(daily, bs) {
  const out = bs.map((b) => ({ ...b, orders: 0, revenue: 0 }));
  for (const r of daily) { const b = out.find((x) => r.day >= x.from && r.day <= x.to); if (b) { b.orders += r.orders; b.revenue = round2(b.revenue + r.revenue); } }
  return out;
}
const eur = (list) => { const m = (list || []).find((x) => x.currency === 'EUR'); return m ? m.amount : 0; };

async function perShop(q, { from, to, shopIds }) {
  const { where, params } = scope({ from, to, shopIds });
  return q(`select shop_id, count(*)::int as orders, coalesce(sum(total) filter (where ${SOLD} and currency = 'EUR'), 0) as revenue
     from zd.orders where ${where} group by 1`, params);
}

async function revenueOf(q, { from, to, shopIds }) {
  const { where, params } = scope({ from, to, shopIds });
  const [r] = await q(`select coalesce(sum(total) filter (where ${SOLD} and currency = 'EUR'), 0) as revenue from zd.orders where ${where}`, params);
  return round2(r.revenue);
}
const goalKey = (user, scopeKey) => `goal:${user.owner ? 'owner' : user.id}:${scopeKey}`;
/** This month so far, the whole month before, the days left and the goal the admin set for it (null: none yet). */
async function monthOf(q, user, ids, scopeKey) {
  const today = sofiaDay(), first = `${today.slice(0, 8)}01`, pTo = shift(first, -1), pFrom = `${pTo.slice(0, 8)}01`;
  const end = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const [revenue, lastMonth, [g]] = ids.length
    ? await Promise.all([revenueOf(q, { from: first, to: today, shopIds: ids }), revenueOf(q, { from: pFrom, to: pTo, shopIds: ids }),
      q(`select value from zd.settings where key = $1`, [goalKey(user, scopeKey)])])
    : [0, 0, []];
  const v = g ? (typeof g.value === 'string' ? JSON.parse(g.value) : g.value) : null;
  return { month: Number(today.slice(5, 7)), revenue, lastMonth, daysLeft: Math.round((Date.parse(`${end}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 864e5) + 1,
    goal: v && Number(v.amount) > 0 ? Number(v.amount) : null };
}
/** The admin's goal for this month's revenue (EUR), for one shop or all of theirs; 0 removes it. */
export async function saveGoal(q, user, { amount, shop = 'all' } = {}) {
  const a = Math.round(Number(amount) * 100) / 100;
  if (!Number.isFinite(a) || a < 0 || a > 1e9) throw new Error('Невалидна цел');
  const s = await resolveShop(q, String(shop || 'all'), { allowAll: true, user });
  const key = goalKey(user, s.all ? 'all' : s.id);
  if (!a) await q(`delete from zd.settings where key = $1`, [key]);
  else await q(`insert into zd.settings (key, value) values ($1, $2::text::jsonb) on conflict (key) do update set value = excluded.value`, [key, JSON.stringify({ amount: a })]);
  return { goal: a || null };
}

export async function getOverview(q, user, range = '30d', shop = null) {
  const len = RANGES[range] || 30;
  const to = sofiaDay(), from = shift(to, -(len - 1)), pTo = shift(from, -1), pFrom = shift(pTo, -(len - 1));
  // the owner sees every shop of the platform, a client only theirs; with a shop: that one, or the admin's own (as „Табло“ counts them)
  let shops = user.owner ? await listShops(q) : await shopsFor(q, user), scopeKey = null;
  if (shop) {
    const s = await resolveShop(q, String(shop), { allowAll: true, user });
    const keep = new Set(s.all ? s.ids : [s.id]);
    shops = shops.filter((x) => keep.has(x.id)); scopeKey = s.all ? 'all' : s.id;
  }
  const ids = shops.map((s) => s.id);
  const empty = { cards: { orders: 0, revenue: [] }, daily: [], recent: [] };
  const [cur, prev, pCur, pPrev, rowsCur, rowsPrev] = ids.length ? await Promise.all([
    getStats(q, { from, to, shopIds: ids }), getStats(q, { from: pFrom, to: pTo, shopIds: ids }),
    getProfitAll(q, { from, to, shopIds: ids }), getProfitAll(q, { from: pFrom, to: pTo, shopIds: ids }),
    perShop(q, { from, to, shopIds: ids }), perShop(q, { from: pFrom, to: pTo, shopIds: ids }),
  ]) : [empty, empty, { profit: 0, missingCosts: { products: 0, of: 0 } }, { profit: 0 }, [], []];
  const bs = buckets(from, to), pbs = buckets(pFrom, pTo);
  const curB = bucketize(cur.daily, bs), prevB = bucketize(prev.daily, pbs);
  const points = curB.map((b, i) => ({ tick: b.tick, label: b.label, current: b.revenue, previous: prevB[i] ? prevB[i].revenue : 0, orders: b.orders, previousOrders: prevB[i] ? prevB[i].orders : 0 }));
  const byId = (rows) => Object.fromEntries(rows.map((r) => [r.shop_id, { orders: r.orders, revenue: round2(r.revenue) }]));
  const sc = byId(rowsCur), sp = byId(rowsPrev);
  const byShop = shops.map((s) => ({ id: s.id, name: s.display || s.name, orders: (sc[s.id] || {}).orders || 0, revenue: (sc[s.id] || {}).revenue || 0, previous: (sp[s.id] || {}).revenue || 0 }))
    .filter((s) => s.orders || s.revenue || s.previous).sort((a, b) => b.revenue - a.revenue || b.orders - a.orders);
  const nameOf = Object.fromEntries(shops.map((s) => [s.id, s.display || s.name || s.domain]));
  const recent = ids.length ? await q(`select o.id, o.created_at, o.name, o.total, o.currency, o.status, o.shop_id
     from zd.orders o where o.shop_id = any($1::uuid[]) and o.cb_check <> 'pending' order by o.created_at desc limit 10`, [ids]) : [];
  return {
    range, period: { from, to }, previous: { from: pFrom, to: pTo }, shops: shops.length,
    kpis: [
      { id: 'revenue', label: 'Оборот', format: 'currency', value: eur(cur.cards.revenue), previous: eur(prev.cards.revenue), spark: curB.map((b) => b.revenue), hint: 'без отказаните и върнатите' },
      { id: 'profit', label: 'Печалба преди ДДС', format: 'currency', value: round2(pCur.profit), previous: round2(pPrev.profit), spark: null,
        hint: pCur.missingCosts && pCur.missingCosts.products ? `не е вярна: ${pCur.missingCosts.products} продукта без себестойност` : 'след себестойност, куриер и реклама',
        unreal: Boolean(pCur.missingCosts && pCur.missingCosts.products) },
      { id: 'orders', label: 'Поръчки', format: 'number', value: cur.cards.orders, previous: prev.cards.orders, spark: curB.map((b) => b.orders), hint: 'всички постъпили' },
    ],
    points, byShop,
    recent: recent.map((r) => ({ id: r.id, createdAt: new Date(r.created_at).toISOString(), name: r.name, total: Number(r.total), currency: r.currency, status: r.status, shopId: r.shop_id, shop: nameOf[r.shop_id] || '' })),
    ...(scopeKey ? { month: await monthOf(q, user, ids, scopeKey) } : {}),
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return send(res, 405, { error: 'method' });
  try {
    const q = getQuery();
    const user = await adminUser(req, q);
    if (!user) return send(res, 401, { error: 'auth' });
    if (req.method === 'POST') {
      const b = readJson(req) || {};
      if (b.action !== 'goal') return send(res, 400, { error: 'unknown action' });
      try { return send(res, 200, { ok: true, ...(await saveGoal(q, user, b)) }); } catch (err) { return send(res, 400, { error: err.message }); }
    }
    const p = searchParams(req), range = p.get('range');
    return send(res, 200, await getOverview(q, user, Object.hasOwn(RANGES, range) ? range : '30d', p.get('shop') || null));
  } catch (err) {
    console.error('[admin] overview failed', err);
    return send(res, 500, { error: 'server' });
  }
}
