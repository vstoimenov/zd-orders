import { getQuery } from '../lib/db.js';
import { listCities } from '../lib/catalog-repo.js';
import { send } from '../lib/http.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return send(res, 405, { error: 'method' });
  try {
    const cities = await listCities(getQuery());
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    return send(res, 200, { cities });
  } catch (err) {
    console.error('[cities] fetch failed', err);
    return send(res, 500, { error: 'server' });
  }
}
