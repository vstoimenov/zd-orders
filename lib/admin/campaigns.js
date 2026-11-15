import { getQuery } from '../db.js';
import { adminUser } from '../users.js';
import { resolveShop } from '../shops.js';
import { readJson, send, searchParams } from '../http.js';
import { preview, listCampaigns, saveCampaign, deleteCampaign, exportCampaign, addOptouts, removeOptout, listOptouts, smsPrice, setSmsPrice } from '../campaigns.js';
import { previewEmail, startSend, sendSome, retryFailed, sendTestEmail, campaignProgress, progressAll, addEmailOptouts, removeEmailOptout, listEmailOptouts } from '../email-campaigns.js';
import { emailConfigured } from '../email.js';

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
      const [campaigns, optouts, price, emailStats] = await Promise.all([listCampaigns(q, shopId), listOptouts(q, shopId), smsPrice(q, shopId), progressAll(q, shopId)]);
      return send(res, 200, { campaigns: campaigns.map((c) => (c.channel === 'email' ? { ...c, stats: emailStats[c.id] || null } : c)), optoutCount: optouts.length, smsPrice: price, emailOn: emailConfigured() });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'method' });
    const b = readJson(req) || {};
    switch (b.action) {
      case 'preview': return send(res, 200, { ok: true, ...(b.channel === 'email' ? await previewEmail(q, shopId, b) : await preview(q, shopId, b)) });
      case 'email_send': return send(res, 200, { ok: true, progress: await startSend(q, shopId, b.id) });
      case 'email_more': return send(res, 200, { ok: true, progress: await sendSome(q, shopId, b.id) });
      case 'email_retry': return send(res, 200, { ok: true, progress: await retryFailed(q, shopId, b.id) });
      case 'email_test': return send(res, 200, await sendTestEmail(q, shopId, b.id, b.to || user.email));
      case 'email_progress': return send(res, 200, { ok: true, progress: await campaignProgress(q, shopId, b.id) });
      case 'email_optouts': return send(res, 200, { ok: true, optouts: await listEmailOptouts(q, shopId) });
      case 'email_optout_add': return send(res, 200, { ok: true, ...(await addEmailOptouts(q, shopId, b.emails)) });
      case 'email_optout_remove': await removeEmailOptout(q, shopId, b.email); return send(res, 200, { ok: true });
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
