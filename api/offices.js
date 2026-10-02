import { getQuery } from '../lib/db.js';
import { listOffices } from '../lib/catalog-repo.js';
import { originAllowed, setCors, send, searchParams } from '../lib/http.js';

export default async function handler(req, res) {
  setCors(res, originAllowed(req));
  if (req.method !== 'GET') return send(res, 405, { error: 'method' });
  if (searchParams(req).get('courier') !== 'econt') return send(res, 400, { error: 'courier' });
  const offices = await listOffices(getQuery(), 'econt');
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  return send(res, 200, { offices });
}
