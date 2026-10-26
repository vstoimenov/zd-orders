import { getQuery } from '../db.js';
import { adminUser } from '../users.js';
import { resolveShop } from '../shops.js';
import { startVoiceCall, voiceResult } from '../voice-call.js';
import { readJson, readRaw, send, searchParams } from '../http.js';

/** POST {action: call, id} → the voice agent calls the customer · POST signed by the agent's server (X-Ordyx-Signature) → its answer. */
export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'method' });
  const q = getQuery();
  if (req.headers['x-ordyx-signature']) { // the agent's server, no login: the signature is the proof
    const raw = typeof req.body === 'string' ? req.body : await readRaw(req); // a text body is already the exact bytes (dev server)
    if (raw == null) return send(res, 400, { error: 'body' });
    try {
      const r = await voiceResult(q, raw, req.headers);
      return send(res, r.status, r.status === 200 ? { ok: true, applied: r.applied } : { error: 'signature' });
    } catch (err) {
      console.error('[voice] result failed', err);
      return send(res, 500, { error: 'server' });
    }
  }
  const user = await adminUser(req, q).catch(() => null);
  if (!user) return send(res, 401, { error: 'auth' });
  try {
    const b = readJson(req) || {};
    if (b.action !== 'call') return send(res, 400, { error: 'Непознато действие' });
    // clients see „Обаждания“ as coming soon (calls are sold on credits, not built yet); the owner calls already
    if (!user.owner && process.env.VOICE_PUBLIC !== '1') return send(res, 403, { error: 'Обажданията с гласов агент идват скоро' });
    const scope = await resolveShop(q, searchParams(req).get('shop'), { allowAll: true, user });
    const out = await startVoiceCall(q, { orderId: b.id, scopeShopId: scope.all ? null : scope.id, scopeShopIds: scope.all ? scope.ids : null });
    return out ? send(res, 200, out) : send(res, 404, { error: 'Няма такава поръчка' });
  } catch (err) {
    if (/[А-Яа-я]/.test(err.message)) return send(res, 400, { error: err.message });
    console.error('[admin] voice call failed', err);
    return send(res, 500, { error: 'server' });
  }
}
