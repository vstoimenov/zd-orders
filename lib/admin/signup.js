import { getQuery } from '../db.js';
import { signupCodeOk, registerClient, clientSession } from '../users.js';
import { offerActive, OFFER_MONTHS, OFFER_OFF } from '../offer.js';
import { sessionCookie } from '../auth.js';
import { notifyOwner } from '../push.js';
import { readJson, send, searchParams, clientIp } from '../http.js';

const PER_HOUR = 30; // accounts from one address per hour (per server instance): a room on one Wi-Fi registers together
const recent = new Map();
export function resetSignupLimitForTests() { recent.clear(); }
function tooMany(ip) {
  const now = Date.now();
  const list = (recent.get(ip) || []).filter((t) => now - t < 3600000);
  if (recent.size > 5000) recent.clear();
  recent.set(ip, list);
  return list.length >= PER_HOUR;
}
const BAD_LINK = 'Линкът за регистрация не е валиден — поискайте нов от платформата';

/**
 * No login needed. GET ?code → is the registration link valid · GET ?offer=1 → is the event offer on ·
 * POST {code | offer: true, name, email, password, website (a trap for bots)} → account + logged in.
 * A code always means a normal registration (sending offer alongside changes nothing).
 */
export default async function handler(req, res) {
  const q = getQuery();
  try {
    if (req.method === 'GET' && searchParams(req).get('offer')) {
      return (await offerActive(q)) ? send(res, 200, { ok: true, offer: { active: true, months: OFFER_MONTHS } }) : send(res, 400, { error: OFFER_OFF });
    }
    if (req.method === 'GET') return (await signupCodeOk(q, searchParams(req).get('code'))) ? send(res, 200, { ok: true }) : send(res, 400, { error: BAD_LINK });
    if (req.method !== 'POST') return send(res, 405, { error: 'method' });
    const b = readJson(req) || {};
    const ip = clientIp(req);
    if (tooMany(ip)) return send(res, 429, { error: 'Твърде много регистрации от този адрес — опитайте след час' });
    if (String(b.website || '')) return send(res, 400, { error: 'Регистрацията не беше приета' }); // humans never fill the hidden field
    const offer = !b.code && b.offer === true;
    if (offer && !(await offerActive(q))) return send(res, 400, { error: OFFER_OFF });
    if (!offer && !(await signupCodeOk(q, b.code))) return send(res, 400, { error: BAD_LINK });
    const user = await registerClient(q, b, { offer });
    recent.get(ip).push(Date.now());
    await notifyOwner(q, { title: offer ? '🎟️ Нова регистрация (скрита оферта)' : '🆕 Нова регистрация', body: `${user.name} · ${user.email}`, url: '/admin/#clients' });
    res.setHeader('Set-Cookie', sessionCookie(clientSession(process.env.ADMIN_SECRET, user)));
    return send(res, 200, { ok: true });
  } catch (err) {
    if (/[А-Яа-я]/.test(err.message)) return send(res, 400, { error: err.message });
    console.error('[admin] signup failed', err);
    return send(res, 500, { error: 'server' });
  }
}
