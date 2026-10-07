import { getQuery } from '../db.js';
import { isAdmin } from '../auth.js';
import { getStats } from '../stats.js';
import { getProfit } from '../costs.js';
import { send, searchParams } from '../http.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const realDate = (s) => {
  if (!DATE.test(s || '')) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const sofiaDay = (offsetDays = 0) => new Date(Date.now() + offsetDays * 864e5).toLocaleDateString('sv-SE', { timeZone: 'Europe/Sofia' });

/** GET ?from=YYYY-MM-DD&to=YYYY-MM-DD&store=<domain> — dashboard figures; defaults to the last 7 days. */
export default async function handler(req, res) {
  if (!isAdmin(req)) return send(res, 401, { error: 'auth' });
  if (req.method !== 'GET') return send(res, 405, { error: 'method' });
  const p = searchParams(req);
  const to = realDate(p.get('to')) ? p.get('to') : sofiaDay();
  const from = realDate(p.get('from')) ? p.get('from') : sofiaDay(-6);
  try {
    const q = getQuery(), opts = { from, to, store: (p.get('store') || '').slice(0, 120) };
    const [stats, profit] = await Promise.all([getStats(q, opts), getProfit(q, opts)]);
    return send(res, 200, { ...stats, profit });
  } catch (err) {
    console.error('[admin] stats failed', err);
    return send(res, 500, { error: 'server' });
  }
}
