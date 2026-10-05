import { getQuery } from '../../lib/db.js';
import { fetchEcont, normalizeOffices, normalizeCities, econtPoints } from '../../lib/econt.js';
import { fetchSpeedyMap, parseSpeedyOffices, attachPostCodes } from '../../lib/speedy.js';
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
    const result = { offices: await replaceOffices(q, 'econt', offices), cities: await replaceCities(q, cities) };
    // Speedy comes from an unofficial public page: a failure there must not fail the Econt refresh
    try {
      result.speedy = await replaceOffices(q, 'speedy', attachPostCodes(parseSpeedyOffices(await fetchSpeedyMap()), cities, econtPoints(officesJson)));
    } catch (err) {
      console.error('[cron] speedy refresh failed', err);
      result.speedy = { error: err.message };
    }
    return send(res, 200, result);
  } catch (err) {
    console.error('[cron] refresh failed', err);
    return send(res, 500, { error: 'server' });
  }
}
