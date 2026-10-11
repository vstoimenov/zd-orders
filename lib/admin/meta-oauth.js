import { randomBytes } from 'node:crypto';
import { getQuery } from '../db.js';
import { adminUser } from '../users.js';
import { getIntegration, saveIntegration } from '../integrations-repo.js';
import { resolveShop } from '../shops.js';
import { assertReady } from '../secretbox.js';
import { metaAppConfigured, oauthDialogUrl, exchangeCode } from '../meta.js';
import { humanize } from '../errors-bg.js';
import { send, searchParams } from '../http.js';

const base = () => (process.env.PUBLIC_BASE_URL || 'https://kurier.profitbrand.online').replace(/\/$/, '');
const STATE = /^[0-9a-f]{64}$/;
// the browser that started the login carries its state: a Facebook link sent to someone else cannot finish it (login CSRF)
const STATE_COOKIE = 'zdo_meta';
const stateCookie = (v, maxAge) => `${STATE_COOKIE}=${v}; Path=/api/admin/meta; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
const cookieState = (req) => {
  const hit = String(req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(`${STATE_COOKIE}=`));
  return hit ? hit.slice(STATE_COOKIE.length + 1) : '';
};

/**
 * "Вход с Facebook". GET ?start=1 (admin) → Facebook's login with a one-time state (15 min).
 * Facebook comes back to GET ?code&state — without the admin cookie (it is SameSite=Strict), so the single-use state is the proof
 * that the admin started it. The long-lived token is sealed; the admin then picks an ad account in the admin.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { error: 'method' });
  const p = searchParams(req);
  let shopId = null;
  const back = (error) => {
    const shop = shopId ? `&shop=${shopId}` : '';
    res.statusCode = 302;
    res.setHeader('Location', error ? `${base()}/admin/?meta_error=${encodeURIComponent(error)}${shop}#integrations` : `${base()}/admin/?meta=choose${shop}#integrations`);
    res.end();
  };
  const q = getQuery();
  if (p.get('start')) {
    const user = await adminUser(req, q).catch(() => null);
    if (!user) return send(res, 401, { error: 'auth' });
    if (!metaAppConfigured()) return back('Входът с Facebook още не е настроен (липсва Meta приложение) — свържете с ключ');
    const state = randomBytes(32).toString('hex');
    try { ({ id: shopId } = await resolveShop(q, p.get('shop'), { strict: true, user })); } catch (err) { return back(err.message); }
    await q(`delete from zd.settings where key like 'meta_oauth:%' and (value->>'at')::timestamptz < now() - interval '1 day'`);
    await q(`insert into zd.settings (key, value) values ($1, jsonb_build_object('at', now(), 'shop', $2::text, 'user', $3::text))`,
      [`meta_oauth:${state}`, shopId, user.owner ? '' : user.id]);
    res.setHeader('Set-Cookie', stateCookie(state, 900));
    res.statusCode = 302;
    res.setHeader('Location', oauthDialogUrl(state));
    return res.end();
  }
  const state = String(p.get('state') || '');
  const mine = STATE.test(state) && cookieState(req) === state;
  res.setHeader('Set-Cookie', stateCookie('', 0));
  const [hit] = mine ? await q(
    `delete from zd.settings where key = $1 and (value->>'at')::timestamptz > now() - interval '15 minutes'
     returning value->>'shop' as shop, coalesce(value->>'user', '') as uid`, [`meta_oauth:${state}`],
  ) : [];
  if (!hit) return back('Входът изтече или е започнат от друг браузър — опитайте отново');
  try { ({ id: shopId } = await resolveShop(q, hit.shop, { strict: true })); } catch { return back('Магазинът вече не съществува'); }
  if (hit.uid) { // a client: still active and still with this shop
    const [ok] = await q(`select 1 from zd.users u join zd.user_shops s on s.user_id = u.id where u.id = $1::uuid and u.active and s.shop_id = $2::uuid`, [hit.uid, shopId]);
    if (!ok) return back('Нямате достъп до този магазин');
  }
  if (p.get('error')) return back('Входът беше отказан');
  try {
    assertReady();
    const { token, expiresAt } = await exchangeCode(p.get('code') || '');
    const current = await getIntegration(q, 'meta', shopId);
    await saveIntegration(q, 'meta', {
      config: { oauth: true, accountId: current.config.accountId || '', active: true, tokenExpiresAt: expiresAt, lastError: null },
      secret: token, shopId,
    });
    return back();
  } catch (err) {
    console.error('[meta] login failed', err.message);
    return back(humanize(err));
  }
}
