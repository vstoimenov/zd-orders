import { getQuery } from '../../lib/db.js';
import { cbConfig, processCbOrder } from '../../lib/cb-sync.js';
import { verifySignature } from '../../lib/convertbuilder.js';
import { readRaw, send } from '../../lib/http.js';

/** ConvertBuilder webhook (order_created / order_updated), signed with HMAC-SHA512 of the raw body (X-Webhook-Signature). */
export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'method' });
  const raw = await readRaw(req);
  if (raw == null) return send(res, 400, { error: 'body' });
  try {
    const q = getQuery();
    const cfg = await cbConfig(q);
    if (!cfg) return send(res, 404, { error: 'not connected' });
    if (!verifySignature(raw, cfg.webhookSecret, req.headers['x-webhook-signature'])) return send(res, 401, { error: 'signature' });
    const topic = String(req.headers['x-webhook-topic'] || '');
    if (topic !== 'order_created' && topic !== 'order_updated') return send(res, 200, { ok: true, ignored: topic });
    const order = JSON.parse(raw);
    if (!order || order.id == null) return send(res, 400, { error: 'no order' });
    const r = await processCbOrder(q, cfg, order);
    return send(res, 200, { ok: true, inserted: r.inserted });
  } catch (err) {
    console.error('[cb] webhook failed', err);
    return send(res, 500, { error: 'server' });
  }
}
