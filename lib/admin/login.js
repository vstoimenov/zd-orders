import { passwordMatches, signSession, sessionCookie, clearedCookie } from '../auth.js';
import { readJson, send, clientIp } from '../http.js';
import { getQuery } from '../db.js';
import { loginClient, clientSession, LOGIN_FAILED } from '../users.js';

const slow = () => new Promise((r) => setTimeout(r, 500)); // slows down guessing
// each failed client login costs a strong password check: one address gets a few a minute (per server instance)
const PER_MINUTE = 20;
const failures = new Map();
const recentFailures = (ip) => (failures.get(ip) || []).filter((t) => Date.now() - t < 60000);
function failed(ip) {
  if (failures.size > 5000) failures.clear(); // never grows without bound
  failures.set(ip, [...recentFailures(ip), Date.now()]);
}
export function resetLoginLimitForTests() { failures.clear(); }

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
    const ip = clientIp(req);
    if (recentFailures(ip).length >= PER_MINUTE) return send(res, 429, { error: 'Твърде много опити за вход — изчакайте минута' });
    try {
      const user = await loginClient(getQuery(), body.email, body.password);
      if (!user) { failed(ip); await slow(); return send(res, 401, { error: LOGIN_FAILED }); }
      res.setHeader('Set-Cookie', sessionCookie(clientSession(secret, user)));
      return send(res, 200, { ok: true, role: 'client' });
    } catch (err) {
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
