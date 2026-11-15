// The support chat: GET → whether it is on and the owner's WhatsApp · POST {messages} → one answer
// · POST {action: 'settings', whatsapp} (the platform owner) → the number „Пиши на човек“ opens.
import { getQuery } from '../db.js';
import { adminUser } from '../users.js';
import { askSupport, supportOn, supportSettings, saveSupportSettings } from '../support.js';
import { readJson, send } from '../http.js';

export default async function handler(req, res) {
  const q = getQuery();
  const user = await adminUser(req, q).catch(() => null);
  if (!user) return send(res, 401, { error: 'auth' });
  try {
    if (req.method === 'GET') return send(res, 200, { on: supportOn(), ...(await supportSettings(q)) });
    if (req.method !== 'POST') return send(res, 405, { error: 'method' });
    const b = readJson(req) || {};
    if (b.action === 'settings') {
      if (!user.owner) return send(res, 403, { error: 'Само за собственика на платформата' });
      return send(res, 200, { ok: true, ...(await saveSupportSettings(q, b)) });
    }
    return send(res, 200, { ok: true, ...(await askSupport(q, user, b.messages)) });
  } catch (err) {
    if (/[А-Яа-я]/.test(err.message)) return send(res, 400, { error: err.message });
    console.error('[admin] support failed', err);
    return send(res, 500, { error: 'server' });
  }
}
