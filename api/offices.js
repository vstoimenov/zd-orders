import { getQuery } from '../lib/db.js';
import { listOffices } from '../lib/catalog-repo.js';
import { shopIdForHost } from '../lib/shops.js';
import { getIntegration } from '../lib/integrations-repo.js';
import { send, searchParams } from '../lib/http.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return send(res, 405, { error: 'method' });
  const courier = searchParams(req).get('courier');
  if (!['econt', 'speedy', 'boxnow'].includes(courier)) return send(res, 400, { error: 'courier' });
  try {
    const q = getQuery();
    if (courier === 'boxnow') return send(res, 200, await boxnowFor(q, searchParams(req).get('host'), res));
    const offices = await listOffices(q, courier);
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    return send(res, 200, { offices });
  } catch (err) {
    console.error('[offices] fetch failed', err);
    return send(res, 500, { error: 'server' });
  }
}

/** BOX NOW lockers only for a shop that switched BOX NOW on in Ordyx (cached briefly so switching shows within minutes). */
async function boxnowFor(q, host, res) {
  const shopId = host ? await shopIdForHost(q, String(host).toLowerCase()) : null;
  const on = shopId ? (await getIntegration(q, 'boxnow', shopId)).config.checkout === true : false;
  const answer = on ? { offices: await listOffices(q, 'boxnow'), enabled: true } : { offices: [], enabled: false };
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
  return answer;
}
