import { getQuery } from '../../lib/db.js';
import { pendingNekorekten } from '../../lib/orders-repo.js';
import { checkOrders } from '../../lib/nk-check.js';
import { nekorektenKey } from '../../lib/nekorekten.js';
import { send, safeEqual, searchParams } from '../../lib/http.js';

const BATCH = 4; // free plan: 5 API requests/min and 30 searches/day

/** Daily (Vercel Cron, Bearer CRON_SECRET): retries orders whose nekorekten.com check is pending or failed. ?debug=1 adds the plan usage. */
export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !safeEqual(req.headers.authorization || '', `Bearer ${secret}`)) return send(res, 401, { error: 'auth' });
  try {
    const q = getQuery();
    const apiKey = nekorektenKey();
    if (!apiKey) return send(res, 200, { skipped: 'nekorekten is not connected' });
    const summary = await checkOrders(q, await pendingNekorekten(q, BATCH), apiKey);
    const out = { summary };
    if (searchParams(req).get('debug') === '1') {
      const r = await fetch('https://api.nekorekten.com/api/v1/api-keys/current/usage', { headers: { 'Api-Key': apiKey, Accept: 'application/json' } });
      out.usage = { status: r.status, body: await r.json().catch(() => null) };
    }
    return send(res, 200, out);
  } catch (err) {
    console.error('[cron] nekorekten failed', err);
    return send(res, 500, { error: 'server' });
  }
}
