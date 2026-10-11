import { passwordMatches, signSession, sessionCookie, clearedCookie } from '../auth.js';
import { readJson, send } from '../http.js';
import { getQuery } from '../db.js';
import { loginClient, clientSession } from '../users.js';

const slow = () => new Promise((r) => setTimeout(r, 500)); // slows down guessing

/** POST {password} → the owner · POST {email, password} → a client · DELETE → logout. */
export default async function handler(req, res) {
  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', clearedCookie());
    return send(res, 200, { ok: true });
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'method' });
  const body = readJson(req) || {};
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return send(res, 500, { error: 'server' });
  if (String(body.email || '').trim()) {
    try {
      const user = await loginClient(getQuery(), body.email, body.password);
      if (!user) { await slow(); return send(res, 401, { error: 'password' }); }
      res.setHeader('Set-Cookie', sessionCookie(clientSession(secret, user)));
      return send(res, 200, { ok: true, role: 'client' });
    } catch (err) {
      if (err.locked) return send(res, 429, { error: err.message });
      console.error('[admin] client login failed', err);
      return send(res, 500, { error: 'server' });
    }
  }
  if (!passwordMatches(body.password, process.env.ADMIN_PASSWORD)) {
    await slow();
    return send(res, 401, { error: 'password' });
  }
  res.setHeader('Set-Cookie', sessionCookie(signSession(secret)));
  return send(res, 200, { ok: true, role: 'owner' });
}
