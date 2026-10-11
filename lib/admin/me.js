import { getQuery } from '../db.js';
import { adminUser } from '../users.js';
import { send } from '../http.js';

/** GET → who is logged in: { role: 'owner' } | { role: 'client', email, name }. */
export default async function handler(req, res) {
  const user = await adminUser(req, getQuery()).catch(() => null);
  if (!user) return send(res, 401, { error: 'auth' });
  return send(res, 200, user.owner ? { role: 'owner' } : { role: 'client', email: user.email, name: user.name });
}
