import { getQuery } from '../db.js';
import { adminUser } from '../users.js';
import { resolveShop } from '../shops.js';
import { getAdvisor, answerCard, setWatched, setProfile, refreshDay, markSummarySeen, advisorReport, saveLimits } from '../advisor/repo.js';
import { send, searchParams, readJson } from '../http.js';

/** GET ?shop → the advisor of that shop (one shop only; „all shops“ gets {all: true}) · POST {id, action: act|dismiss, reason} · {action: 'watch', watched: [rule…]} (the filter) · {action: 'profile', value} · {action: 'refresh'} (after a history sync) · {action: 'seen', month}
 *  · owner: GET ?report=1[&days] (every metric across shops) · POST {action: 'limits', limits} (the thresholds). */
export default async function handler(req, res) {
  const q = getQuery();
  const user = await adminUser(req, q).catch(() => null);
  if (!user) return send(res, 401, { error: 'auth' });
  try {
    const p = searchParams(req);
    if (req.method === 'GET' && p.get('report') === '1') { // the owner's report across shops (for tuning the thresholds)
      if (!user.owner) return send(res, 403, { error: 'Само собственикът вижда отчета' });
      const scope = await resolveShop(q, 'all', { allowAll: true, user });
      return send(res, 200, await advisorReport(q, { days: Math.min(365, Math.max(7, Number(p.get('days')) || 90)), shopIds: scope.ids }));
    }
    if (req.method === 'POST' && (readJson(req) || {}).action === 'limits') {
      if (!user.owner) return send(res, 403, { error: 'Само собственикът сменя праговете' });
      return send(res, 200, { ok: true, limits: await saveLimits(q, (readJson(req) || {}).limits || {}) });
    }
    if (req.method === 'GET') {
      const scope = await resolveShop(q, p.get('shop'), { allowAll: true, user });
      if (scope.all) return send(res, 200, { all: true });
      return send(res, 200, await getAdvisor(q, scope.id));
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'method' });
    const { shop } = await resolveShop(q, p.get('shop'), { strict: true, user });
    const b = readJson(req) || {};
    if (b.action === 'watch') return send(res, 200, { ok: true, watched: await setWatched(q, shop.id, b.watched) });
    if (b.action === 'profile') return send(res, 200, { ok: true, profile: await setProfile(q, shop.id, b.value) });
    if (b.action === 'refresh') { await refreshDay(q, shop.id); return send(res, 200, { ok: true }); }
    if (b.action === 'seen') { await markSummarySeen(q, shop.id, b.month); return send(res, 200, { ok: true }); }
    return send(res, 200, { ok: true, card: await answerCard(q, shop.id, b) });
  } catch (err) {
    if (/[А-Яа-я]/.test(err.message)) return send(res, 400, { error: err.message });
    console.error('[admin] advisor failed', err);
    return send(res, 500, { error: 'server' });
  }
}
