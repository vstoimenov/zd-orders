// All admin endpoints in one Vercel function (Hobby plan: max 12 functions). Addresses stay /api/admin/<route>.
import login from '../../lib/admin/login.js';
import orders from '../../lib/admin/orders.js';
import stats from '../../lib/admin/stats.js';
import costs from '../../lib/admin/costs.js';
import integrations from '../../lib/admin/integrations.js';
import inventory from '../../lib/admin/inventory.js';
import meta from '../../lib/admin/meta-oauth.js';
import waconnect from '../../lib/admin/wa-oauth.js';
import shops from '../../lib/admin/shops.js';
import waybills from '../../lib/admin/waybills.js';
import push from '../../lib/admin/push.js';
import me from '../../lib/admin/me.js';
import invite from '../../lib/admin/invite.js';
import users from '../../lib/admin/users.js';
import onboarding from '../../lib/admin/onboarding.js';
import signup from '../../lib/admin/signup.js';
import campaigns from '../../lib/admin/campaigns.js';
import confirm from '../../lib/admin/confirm.js';
import confirmadmin from '../../lib/admin/confirm-admin.js';
import abandoned from '../../lib/admin/abandoned.js';
import customers from '../../lib/admin/customers.js';
import voice from '../../lib/admin/voice.js';
import advisor from '../../lib/admin/advisor.js';
import profile from '../../lib/admin/profile.js';
import overview from '../../lib/admin/overview.js';
import email from '../../lib/admin/email.js';
import track from '../../lib/admin/track.js';
import support from '../../lib/admin/support.js';
import { send } from '../../lib/http.js';
import { getQuery } from '../../lib/db.js';
import { isBlocked } from '../../lib/blocklist.js';
import { adminUser } from '../../lib/users.js';

const ROUTES = { profile, overview, email, track, support, login, orders, waconnect, stats, costs, integrations, inventory, meta, shops, waybills, push, me, invite, users, onboarding, signup, campaigns, confirm, confirmadmin, abandoned, customers, voice, advisor };
const pick = (name) => (typeof name === 'string' && Object.hasOwn(ROUTES, name) ? ROUTES[name] : null);

/** Changes only from our own pages: a request carrying another site's Origin is refused (on top of the SameSite cookie). */
function foreignOrigin(req) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method || 'GET')) return false;
  const origin = req.headers?.origin;
  if (!origin) return false;
  try { return new URL(origin).host !== String(req.headers.host || ''); } catch { return true; }
}

export default async function handler(req, res) {
  if (foreignOrigin(req)) return send(res, 403, { error: 'origin' });
  const segment = new URL(req.url || '/', 'http://localhost').pathname.replace(/\/+$/, '').split('/').pop();
  const route = pick(segment) || pick(req.query?.route); // Vercel also passes the [route] segment as a query value
  if (!route) return send(res, 404, { error: 'not found' });
  // a banned person (by IP or browser) gets nothing: no registration, no data; never blocks the platform on a DB hiccup.
  // the owner is never locked out: the password login and an owner's session pass
  if (route !== login && await isBlocked(getQuery(), req).catch(() => false) && !(await adminUser(req, getQuery()).catch(() => null))?.owner) {
    return send(res, 403, { error: 'Достъпът е отказан' });
  }

  return route(req, res);
}
