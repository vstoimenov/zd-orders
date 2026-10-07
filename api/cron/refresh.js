import { getQuery } from '../../lib/db.js';
import { fetchEcont, normalizeOffices, normalizeCities, econtPoints } from '../../lib/econt.js';
import { fetchSpeedyMap, parseSpeedyOffices, attachPostCodes } from '../../lib/speedy.js';
import { replaceOffices, replaceCities } from '../../lib/catalog-repo.js';
import { send, safeEqual } from '../../lib/http.js';
import { cbConfig, syncOrders } from '../../lib/cb-sync.js';
import { metaConfig, syncMeta } from '../../lib/meta.js';
import { listShops } from '../../lib/shops.js';

/** Vercel Cron calls this daily with `Authorization: Bearer $CRON_SECRET`. */
export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !safeEqual(req.headers.authorization || '', `Bearer ${secret}`)) return send(res, 401, { error: 'auth' });
  const q = getQuery();
  const result = {};
  let econtOk = true;
  try {
    const [officesJson, citiesJson] = await Promise.all([fetchEcont('getOffices'), fetchEcont('getCities')]);
    const offices = normalizeOffices(officesJson);
    const cities = normalizeCities(citiesJson, offices);
    result.offices = await replaceOffices(q, 'econt', offices);
    result.cities = await replaceCities(q, cities);
    // Speedy comes from an unofficial public page: a failure there must not fail the Econt refresh
    try {
      result.speedy = await replaceOffices(q, 'speedy', attachPostCodes(parseSpeedyOffices(await fetchSpeedyMap()), cities, econtPoints(officesJson)), { minRatio: 0.8 });
    } catch (err) {
      console.error('[cron] speedy refresh failed', err);
      result.speedy = { error: err.message };
    }
  } catch (err) {
    console.error('[cron] refresh failed', err);
    econtOk = false;
  }
  // catch up on ConvertBuilder orders a webhook might have missed (last 3 days) — independent of the courier refresh
  const shops = await listShops(q).catch(() => []);
  for (const shop of shops) {
    try {
      if (await cbConfig(q, shop.id)) (result.convertbuilder ??= {})[shop.domain] = await syncOrders(q, { max: 500, shopId: shop.id });
    } catch (err) {
      console.error('[cron] convertbuilder sync failed', shop.domain, err);
      (result.convertbuilder ??= {})[shop.domain] = { error: err.message };
    }
  }
  // anonymous visit statistics are kept 400 days
  try {
    result.visitsDeleted = (await q(`delete from zd.visits where day < current_date - 400 returning 1`)).length;
    // salts older than 2 days are destroyed: from then on no visit can be linked to anyone
    await q(`delete from zd.settings where key like 'visit_salt:%' and key < 'visit_salt:' || to_char(current_date - 2, 'YYYY-MM-DD')`);
  } catch (err) {
    console.error('[cron] visits cleanup failed', err);
  }
  // Meta ad spend of the last 7 days (Meta keeps refining recent days)
  for (const shop of shops) {
    try {
      if (await metaConfig(q, shop.id)) (result.meta ??= {})[shop.domain] = await syncMeta(q, { shopId: shop.id });
    } catch (err) {
      console.error('[cron] meta sync failed', shop.domain, err);
      (result.meta ??= {})[shop.domain] = { error: err.message };
    }
  }
  return econtOk ? send(res, 200, result) : send(res, 500, { error: 'server', ...result });
}
