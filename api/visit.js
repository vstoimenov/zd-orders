import { getQuery } from '../lib/db.js';
import { isBot, recordVisit } from '../lib/visits.js';
import { setCors, readJson, send, clientIp } from '../lib/http.js';
import { allowedShopOrigin } from '../lib/shops.js';

/** Anonymous page view from kurier.js (sendBeacon, text/plain JSON {p: path, s: query, r: referrer}). Always quick; never errors to the page. */
export default async function handler(req, res) {
  const allowed = await allowedShopOrigin(getQuery(), req).catch(() => null);
  const origin = allowed?.origin || null;
  setCors(res, origin);
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return send(res, 204);
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'method' });
  if (!origin) return send(res, 403, { error: 'origin' });
  const ua = String(req.headers['user-agent'] || '').slice(0, 400);
  if (isBot(ua)) return send(res, 204);
  const b = readJson(req) || {};
  try {
    await recordVisit(getQuery(), { site: new URL(origin).host.replace(/^www\./, ''), shopId: allowed.shopId, ip: clientIp(req), ua, path: b.p, search: b.s, referrer: b.r });
  } catch (err) {
    console.error('[visit] store failed', err);
  }
  return send(res, 204);
}
