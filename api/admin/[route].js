// All admin endpoints in one Vercel function (Hobby plan: max 12 functions). Addresses stay /api/admin/<route>.
import login from '../../lib/admin/login.js';
import orders from '../../lib/admin/orders.js';
import stats from '../../lib/admin/stats.js';
import costs from '../../lib/admin/costs.js';
import integrations from '../../lib/admin/integrations.js';
import { send } from '../../lib/http.js';

const ROUTES = { login, orders, stats, costs, integrations };
const pick = (name) => (typeof name === 'string' && Object.hasOwn(ROUTES, name) ? ROUTES[name] : null);

export default function handler(req, res) {
  const segment = new URL(req.url || '/', 'http://localhost').pathname.replace(/\/+$/, '').split('/').pop();
  const route = pick(segment) || pick(req.query?.route); // Vercel also passes the [route] segment as a query value
  if (!route) return send(res, 404, { error: 'not found' });
  return route(req, res);
}
