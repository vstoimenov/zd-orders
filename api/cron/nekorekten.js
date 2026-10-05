import { getQuery } from '../../lib/db.js';
import { pendingNekorekten } from '../../lib/orders-repo.js';
import { checkOrders } from '../../lib/nk-check.js';
import { send, safeEqual, searchParams } from '../../lib/http.js';

const BATCH = 8; // nekorekten.com allows 10 requests per minute

/** Daily (Vercel Cron, Bearer CRON_SECRET): retries orders whose nekorekten.com check is pending or failed. ?debug=1 adds the plan usage. */
export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !safeEqual(req.headers.authorization || '', `Bearer ${secret}`)) return send(res, 401, { error: 'auth' });
  const apiKey = process.env.NEKOREKTEN_API_KEY;
  if (!apiKey) return send(res, 200, { skipped: 'NEKOREKTEN_API_KEY is not set' });
  try {
    const q = getQuery();
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
