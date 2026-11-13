import { getQuery } from '../db.js';
import { adminUser } from '../users.js';
import { subscriptionView, listPayments, nextPayment, PLANS, SUB_COLS } from '../plans.js';
import { send } from '../http.js';
import { affiliateSummary } from '../affiliate.js';

/** GET → the logged-in client's profile: account, plan, the next payment and every payment with its invoice. The owner has none. */
export default async function handler(req, res) {
  const q = getQuery();
  const user = await adminUser(req, q).catch(() => null);
  if (!user) return send(res, 401, { error: 'auth' });
  if (req.method !== 'GET') return send(res, 405, { error: 'method' });
  if (user.owner && !user.id) return send(res, 200, { owner: true });
  try {
    const [r] = await q(`select ${SUB_COLS}, created_at from zd.users where id = $1::uuid`, [user.id]);
    const subscription = subscriptionView(r);
    const payments = await listPayments(q, user.id);
    const plan = subscription ? PLANS[subscription.plan] : null;
    return send(res, 200, {
      owner: Boolean(user.owner), name: user.name, email: user.email, since: r?.created_at ? new Date(r.created_at).toISOString() : null,
      subscription, plan: plan ? { name: plan.name, shops: plan.shops, maxShops: plan.maxShops, orders: plan.orders } : null,
      payments, next: subscription?.wantsFree && !subscription.paidAt ? null : nextPayment(subscription, payments), // Free: nothing to pay
      partner: await affiliateSummary(q, user.id),
    });
  } catch (err) {
    console.error('[admin] profile', err);
    return send(res, 500, { error: 'server' });
  }
}
