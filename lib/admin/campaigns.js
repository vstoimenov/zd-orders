import { getQuery } from '../db.js';
import { adminUser } from '../users.js';
import { resolveShop } from '../shops.js';
import { readJson, send, searchParams } from '../http.js';
import { preview, listCampaigns, saveCampaign, deleteCampaign, exportCampaign, addOptouts, removeOptout, listOptouts, smsPrice, setSmsPrice } from '../campaigns.js';

/** One shop at a time. GET → campaigns · GET ?export=<id> → CSV · POST {action: preview | save | delete | optout_add | optout_remove | optouts | price}. */
export default async function handler(req, res) {
  const q = getQuery();
  const user = await adminUser(req, q).catch(() => null);
  if (!user) return send(res, 401, { error: 'auth' });
  try {
    const p = searchParams(req);
    const { id: shopId } = await resolveShop(q, p.get('shop'), { strict: req.method !== 'GET', user });
    if (req.method === 'GET') {
      if (p.get('export')) {
        const out = await exportCampaign(q, shopId, p.get('export'));
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(out.filename)}`);
        res.setHeader('Cache-Control', 'private, no-store');
        return res.end(out.csv);
      }
      const [campaigns, optouts, price] = await Promise.all([listCampaigns(q, shopId), listOptouts(q, shopId), smsPrice(q, shopId)]);
      return send(res, 200, { campaigns, optoutCount: optouts.length, smsPrice: price });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'method' });
    const b = readJson(req) || {};
    switch (b.action) {
      case 'preview': return send(res, 200, { ok: true, ...(await preview(q, shopId, b)) });
      case 'save': return send(res, 200, { ok: true, campaign: await saveCampaign(q, shopId, b) });
      case 'delete': return (await deleteCampaign(q, shopId, b.id)) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'Няма такава кампания' });
      case 'optout_add': return send(res, 200, { ok: true, ...(await addOptouts(q, shopId, b.phones)) });
      case 'optout_remove': await removeOptout(q, shopId, b.phone); return send(res, 200, { ok: true });
      case 'optouts': return send(res, 200, { ok: true, optouts: await listOptouts(q, shopId) });
      case 'price': return send(res, 200, { ok: true, smsPrice: await setSmsPrice(q, shopId, b.smsPrice) });
      default: return send(res, 400, { error: 'Непознато действие' });
    }
  } catch (err) {
    if (/[А-Яа-я]/.test(err.message)) return send(res, 400, { error: err.message });
    console.error('[admin] campaigns failed', err);
    return send(res, 500, { error: 'server' });
  }
}
