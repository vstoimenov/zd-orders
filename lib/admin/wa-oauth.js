// „Свържи WhatsApp“ without a popup: GET ?start=1&shop → Meta's Embedded Signup page; Meta comes back to GET ?code&state and
// the number is stored. Same one-time-state pattern as lib/admin/meta-oauth.js (a link sent elsewhere cannot finish it).
import { randomBytes } from 'node:crypto';
import { getQuery } from '../db.js';
import { adminUser } from '../users.js';
import { resolveShop } from '../shops.js';
import { waAppReady, waDialogUrl, exchangeWaCode, connectWhatsAppWithToken } from '../whatsapp.js';
import { send, searchParams } from '../http.js';

const base = () => (process.env.PUBLIC_BASE_URL || 'https://app.ordyx.eu').replace(/\/$/, '');
const STATE = /^[0-9a-f]{64}$/;
const STATE_COOKIE = 'zdo_wa';
const stateCookie = (v, maxAge) => `${STATE_COOKIE}=${v}; Path=/api/admin/waconnect; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
const cookieState = (req) => {
  const hit = String(req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(`${STATE_COOKIE}=`));
  return hit ? hit.slice(STATE_COOKIE.length + 1) : '';
};
/** Embedded Signup works for the app's admins before Meta's review and the app going live: clients get it with WHATSAPP_PUBLIC=1. */
const openFor = (user) => Boolean(user?.owner) || process.env.WHATSAPP_PUBLIC === '1';

export default async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { error: 'method' });
  const p = searchParams(req);
  let shopId = null;
  const back = (error) => {
    const shop = shopId ? `&shop=${shopId}` : '';
    res.statusCode = 302;
    res.setHeader('Location', error ? `${base()}/admin/?wa_error=${encodeURIComponent(error)}${shop}#integrations` : `${base()}/admin/?wa=ok${shop}#integrations`);
    res.end();
  };
  const q = getQuery();
  if (p.get('start')) {
    const user = await adminUser(req, q).catch(() => null);
    if (!user) return send(res, 401, { error: 'auth' });
    try { ({ id: shopId } = await resolveShop(q, p.get('shop'), { strict: true, user })); } catch (err) { return back(err.message); }
    if (!waAppReady()) return back('WhatsApp още не е настроен на платформата');
    if (!openFor(user)) return back('Свързването с бутон още не е пуснато за клиенти — пишете ни');
    const state = randomBytes(32).toString('hex');
    await q(`delete from zd.settings where key like 'wa_oauth:%' and (value->>'at')::timestamptz < now() - interval '1 day'`);
    await q(`insert into zd.settings (key, value) values ($1, jsonb_build_object('at', now(), 'shop', $2::text, 'user', $3::text))`,
      [`wa_oauth:${state}`, shopId, user.owner ? '' : user.id]);
    res.setHeader('Set-Cookie', stateCookie(state, 900));
    res.statusCode = 302;
    res.setHeader('Location', waDialogUrl(state));
    return res.end();
  }
  const state = String(p.get('state') || '');
  const mine = STATE.test(state) && cookieState(req) === state;
  res.setHeader('Set-Cookie', stateCookie('', 0));
  const [hit] = mine ? await q(
    `delete from zd.settings where key = $1 and (value->>'at')::timestamptz > now() - interval '15 minutes'
     returning value->>'shop' as shop, coalesce(value->>'user', '') as uid`, [`wa_oauth:${state}`],
  ) : [];
  if (!hit) return back('Свързването изтече или е започнато от друг браузър — опитайте отново');
  try { ({ id: shopId } = await resolveShop(q, hit.shop, { strict: true })); } catch { return back('Магазинът вече не съществува'); }
  if (hit.uid) {
    const [ok] = await q(`select 1 from zd.users u join zd.user_shops s on s.user_id = u.id where u.id = $1::uuid and u.active and s.shop_id = $2::uuid`, [hit.uid, shopId]);
    if (!ok) return back('Нямате достъп до този магазин');
  }
  if (p.get('error')) return back('Свързването беше отказано в Meta');
  try {
    const token = await exchangeWaCode(p.get('code') || '');
    await connectWhatsAppWithToken(q, shopId, token);
    return back();
  } catch (err) {
    console.error('[whatsapp] connect failed', err.message);
    return back(/[А-Яа-я]/.test(err.message) ? err.message : 'Свързването не завърши — опитайте отново');
  }
}
