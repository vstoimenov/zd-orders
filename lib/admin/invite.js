import { getQuery } from '../db.js';
import { inviteInfo, acceptInvite, clientSession } from '../users.js';
import { sessionCookie } from '../auth.js';
import { readJson, send, searchParams } from '../http.js';

/** No login needed: GET ?token → whose link it is · POST {token, password} → sets the password once and logs the client in. */
export default async function handler(req, res) {
  const q = getQuery();
  try {
    if (req.method === 'GET') {
      const info = await inviteInfo(q, searchParams(req).get('token'));
      return info ? send(res, 200, { ok: true, ...info }) : send(res, 400, { error: 'Линкът е изтекъл или вече е използван — поискайте нов' });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'method' });
    const b = readJson(req) || {};
    const user = await acceptInvite(q, b.token, b.password);
    res.setHeader('Set-Cookie', sessionCookie(clientSession(process.env.ADMIN_SECRET, user)));
    return send(res, 200, { ok: true });
  } catch (err) {
    if (/[А-Яа-я]/.test(err.message)) return send(res, 400, { error: err.message });
    console.error('[admin] invite failed', err);
    return send(res, 500, { error: 'server' });
  }
}
