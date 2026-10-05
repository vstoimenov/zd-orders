import { getQuery } from '../../lib/db.js';
import { isAdmin } from '../../lib/auth.js';
import { getStats } from '../../lib/stats.js';
import { send, searchParams } from '../../lib/http.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const sofiaDay = (offsetDays = 0) => new Date(Date.now() + offsetDays * 864e5).toLocaleDateString('sv-SE', { timeZone: 'Europe/Sofia' });

/** GET ?from=YYYY-MM-DD&to=YYYY-MM-DD&store=<domain> — dashboard figures; defaults to the last 7 days. */
export default async function handler(req, res) {
  if (!isAdmin(req)) return send(res, 401, { error: 'auth' });
  if (req.method !== 'GET') return send(res, 405, { error: 'method' });
  const p = searchParams(req);
  const to = DATE.test(p.get('to') || '') ? p.get('to') : sofiaDay();
  const from = DATE.test(p.get('from') || '') ? p.get('from') : sofiaDay(-6);
  try {
    return send(res, 200, await getStats(getQuery(), { from, to, store: (p.get('store') || '').slice(0, 120) }));
  } catch (err) {
    console.error('[admin] stats failed', err);
    return send(res, 500, { error: 'server' });
  }
}
