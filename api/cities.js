import { getQuery } from '../lib/db.js';
import { listCities } from '../lib/catalog-repo.js';
import { originAllowed, setCors, send } from '../lib/http.js';

export default async function handler(req, res) {
  setCors(res, originAllowed(req));
  if (req.method !== 'GET') return send(res, 405, { error: 'method' });
  const cities = await listCities(getQuery());
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  return send(res, 200, { cities });
}
