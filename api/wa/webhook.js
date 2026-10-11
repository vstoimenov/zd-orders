import { getQuery } from '../../lib/db.js';
import { readRaw, send, searchParams } from '../../lib/http.js';
import { signatureOk, handleWebhook } from '../../lib/whatsapp.js';

/** Meta's WhatsApp webhook for every shop: GET = subscription check (verify token), POST = signed events (button taps, STOP). */
export default async function handler(req, res) {
  if (req.method === 'GET') {
    const p = searchParams(req);
    const verify = process.env.WHATSAPP_VERIFY_TOKEN;
    if (p.get('hub.mode') === 'subscribe' && verify && p.get('hub.verify_token') === verify) {
      res.statusCode = 200; res.setHeader('Content-Type', 'text/plain'); return res.end(String(p.get('hub.challenge') || ''));
    }
    return send(res, 403, { error: 'verify' });
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'method' });
  const raw = await readRaw(req);
  if (raw == null) return send(res, 400, { error: 'body' });
  if (!signatureOk(raw, req.headers['x-hub-signature-256'])) return send(res, 401, { error: 'signature' });
  try {
    await handleWebhook(getQuery(), JSON.parse(raw));
  } catch (err) {
    console.error('[whatsapp] webhook failed', err); // still 200: Meta retries failed deliveries for days
  }
  return send(res, 200, { ok: true });
}
