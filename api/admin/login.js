import { passwordMatches, signSession, sessionCookie } from '../../lib/auth.js';
import { readJson, send } from '../../lib/http.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'method' });
  const body = readJson(req) || {};
  if (!process.env.ADMIN_SECRET || !passwordMatches(body.password, process.env.ADMIN_PASSWORD)) {
    await new Promise((r) => setTimeout(r, 500)); // slows down guessing
    return send(res, 401, { error: 'password' });
  }
  res.setHeader('Set-Cookie', sessionCookie(signSession(process.env.ADMIN_SECRET)));
  return send(res, 200, { ok: true });
}
