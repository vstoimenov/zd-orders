import { getQuery } from '../../lib/db.js';
import { fetchEcont, normalizeOffices, normalizeCities } from '../../lib/econt.js';
import { replaceOffices, replaceCities } from '../../lib/catalog-repo.js';
import { send, safeEqual } from '../../lib/http.js';

/** Vercel Cron calls this daily with `Authorization: Bearer $CRON_SECRET`. */
export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !safeEqual(req.headers.authorization || '', `Bearer ${secret}`)) return send(res, 401, { error: 'auth' });
  try {
    const [officesJson, citiesJson] = await Promise.all([fetchEcont('getOffices'), fetchEcont('getCities')]);
    const offices = normalizeOffices(officesJson);
    const cities = normalizeCities(citiesJson, offices);
    const q = getQuery();
    return send(res, 200, { offices: await replaceOffices(q, 'econt', offices), cities: await replaceCities(q, cities) });
  } catch (err) {
    console.error('[cron] refresh failed', err);
    return send(res, 500, { error: 'server' });
  }
}
