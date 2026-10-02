import { getQuery } from '../lib/db.js';
import { validateOrder } from '../lib/order.js';
import { insertOrder, countRecentByIp } from '../lib/orders-repo.js';
import { originAllowed, setCors, readJson, send, clientIp } from '../lib/http.js';

const RATE_LIMIT = 5; // orders per IP per 10 minutes

export default async function handler(req, res) {
  const origin = originAllowed(req);
  setCors(res, origin);
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return send(res, 204);
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'method' });
  if (!origin) return send(res, 403, { error: 'origin' });
  const body = readJson(req);
  const token = process.env.ORDER_TOKEN;
  if (!token || !body || body.token !== token) return send(res, 401, { error: 'token' });
  const v = validateOrder(body);
  if (!v.ok) return send(res, 400, { error: v.error });
  try {
    const q = getQuery();
    const ip = clientIp(req);
    if ((await countRecentByIp(q, ip)) >= RATE_LIMIT) return send(res, 429, { error: 'rate' });
    const r = await insertOrder(q, { ...v.order, ip, userAgent: String(req.headers['user-agent'] || '').slice(0, 300) });
    return send(res, 200, { ok: true, inserted: r.inserted, duplicate: r.duplicate });
  } catch (err) {
    console.error('[orders] store failed', v.order.cbOrderId, err);
    return send(res, 500, { error: 'server' });
  }
}
