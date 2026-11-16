import { getQuery } from '../db.js';
import { adminUser, renewedSession } from '../users.js';
import { sessionCookie } from '../auth.js';
import { readJson, send } from '../http.js';
import { subscriptionView, SUB_COLS } from '../plans.js';
import { planState } from '../plan-gate.js';

const OWNER_KEY = 'owner_profile';
/** The platform owner's own name and e-mail, for the greeting („Добро утро, Виктор“) and the card in the menu. */
export async function ownerProfile(q, user) {
  const [r] = await q(`select value from zd.settings where key = $1`, [OWNER_KEY]);
  const v = r ? (typeof r.value === 'string' ? JSON.parse(r.value) : r.value) || {} : {};
  return { name: v.name || user.name || '', email: v.email || user.email || '' };
}
export async function saveOwnerProfile(q, { name, email } = {}) {
  const n = String(name ?? '').trim().replace(/\s+/g, ' ').slice(0, 80), e = String(email ?? '').trim().slice(0, 120);
  if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error('Невалиден имейл');
  await q(`insert into zd.settings (key, value) values ($1, $2::text::jsonb) on conflict (key) do update set value = excluded.value`, [OWNER_KEY, JSON.stringify({ name: n, email: e })]);
  return { name: n, email: e };
}

/** GET → who is logged in: { role: 'owner', name, email } | { role: 'client', email, name, plan, freeUntil, subscription }
 *  · POST {name, email} (the owner) → the name the admin greets them with. */
export default async function handler(req, res) {
  const q = getQuery();
  const user = await adminUser(req, q).catch(() => null);
  if (!user) return send(res, 401, { error: 'auth' });
  if (req.method === 'POST') {
    if (!user.owner) return send(res, 403, { error: 'Само за собственика на платформата' });
    try { return send(res, 200, { ok: true, ...(await saveOwnerProfile(q, readJson(req) || {})) }); } catch (err) { return send(res, 400, { error: err.message }); }
  }
  const fresh = renewedSession(req, user); // the admin asks this on every start
  if (fresh) res.setHeader('Set-Cookie', sessionCookie(fresh));
  if (user.owner) return send(res, 200, { role: 'owner', ...(await ownerProfile(q, user)) });
  const [r] = await q(`select ${SUB_COLS} from zd.users where id = $1::uuid`, [user.id]);
  return send(res, 200, { role: 'client', email: user.email, name: user.name, plan: user.plan, freeUntil: user.freeUntil, subscription: subscriptionView(r), planState: await planState(q, user) });
}
