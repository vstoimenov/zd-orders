// GET (public) → the ids the browser tags need · GET ?gsc=<file> (public) → the Search Console verification file
// GET ?settings=1 / POST (the platform owner) → the tracking settings of ordyx.eu.
import { getQuery } from '../db.js';
import { adminUser } from '../users.js';
import { trackingSettings, saveTracking, publicTracking, gscFile } from '../track.js';
import { readJson, send, searchParams } from '../http.js';

export default async function handler(req, res) {
  const q = getQuery();
  const p = searchParams(req);
  try {
    if (req.method === 'GET' && p.get('gsc')) {
      const body = await gscFile(q, p.get('gsc'));
      if (!body) return send(res, 404, { error: 'not found' });
      res.statusCode = 200; res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'public, s-maxage=3600');
      return res.end(body);
    }
    if (req.method === 'GET' && !p.get('settings')) {
      res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return send(res, 200, await publicTracking(q));
    }
    const user = await adminUser(req, q).catch(() => null);
    if (!user) return send(res, 401, { error: 'auth' });
    if (!user.owner) return send(res, 403, { error: 'Само за собственика на платформата' });
    if (req.method === 'GET') return send(res, 200, await trackingSettings(q));
    if (req.method !== 'POST') return send(res, 405, { error: 'method' });
    return send(res, 200, { ok: true, settings: await saveTracking(q, readJson(req) || {}) });
  } catch (err) {
    if (/[А-Яа-я]/.test(err.message)) return send(res, 400, { error: err.message });
    console.error('[admin] track failed', err);
    return send(res, 500, { error: 'server' });
  }
}
