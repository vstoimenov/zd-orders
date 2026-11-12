import { getQuery } from '../db.js';
import { adminUser, renewedSession } from '../users.js';
import { sessionCookie } from '../auth.js';
import { send } from '../http.js';
import { subscriptionView, SUB_COLS } from '../plans.js';

/** GET → who is logged in: { role: 'owner' } | { role: 'client', email, name, plan, freeUntil, subscription }. */
export default async function handler(req, res) {
  const q = getQuery();
  const user = await adminUser(req, q).catch(() => null);
  if (!user) return send(res, 401, { error: 'auth' });
  const fresh = renewedSession(req, user); // the admin asks this on every start
  if (fresh) res.setHeader('Set-Cookie', sessionCookie(fresh));
  if (user.owner) return send(res, 200, { role: 'owner' });
  const [r] = await q(`select ${SUB_COLS} from zd.users where id = $1::uuid`, [user.id]);
  return send(res, 200, { role: 'client', email: user.email, name: user.name, plan: user.plan, freeUntil: user.freeUntil, subscription: subscriptionView(r) });
}
