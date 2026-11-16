// The Europe landing (ordyx.eu/europa) lets a visitor vote for the country Ordyx should open next.
// No login. GET → the counts per country · POST {country} → one vote per browser (a cookie remembers it; a new country moves it).
// Kept in zd.settings `eu_votes` as { RO: 12, GR: 7, … } — the pages show only the countries they know.
import { getQuery } from '../db.js';
import { readJson, send } from '../http.js';

const KEY = 'eu_votes';
const COOKIE = 'zd_euvote';
const MAX_COUNTRIES = 64; // 24 real ones; a few stray codes cannot grow the row forever

const json = (v) => (typeof v === 'string' ? JSON.parse(v) : v) || {};
const cookieOf = (req) => (/(?:^|;\s*)zd_euvote=([A-Z]{2})/.exec(String(req.headers?.cookie || '')) || [])[1] || '';

export async function getVotes(q) {
  const [r] = await q(`select value from zd.settings where key = $1`, [KEY]);
  const v = r ? json(r.value) : {};
  const votes = {};
  for (const [k, n] of Object.entries(v)) if (/^[A-Z]{2}$/.test(k) && Number(n) > 0) votes[k] = Number(n);
  return votes;
}

/** Records a vote for `country`, moving it from `previous` when the same browser voted before. Returns the new counts. */
export async function vote(q, country, previous = '') {
  const code = String(country || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) throw new Error('Изберете държава');
  const votes = await getVotes(q);
  if (previous === code) return votes; // already counted
  if (previous && votes[previous]) { votes[previous] -= 1; if (!votes[previous]) delete votes[previous]; }
  if (!votes[code] && Object.keys(votes).length >= MAX_COUNTRIES) throw new Error('Изберете държава');
  votes[code] = (votes[code] || 0) + 1;
  await q(`insert into zd.settings (key, value) values ($1, $2::text::jsonb) on conflict (key) do update set value = excluded.value`, [KEY, JSON.stringify(votes)]);
  return votes;
}

export default async function handler(req, res) {
  const q = getQuery();
  try {
    if (req.method === 'GET') {
      res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
      return send(res, 200, { votes: await getVotes(q) });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'method' });
    const b = readJson(req) || {};
    const code = String(b.country || '').trim().toUpperCase();
    const votes = await vote(q, code, cookieOf(req));
    res.setHeader('Set-Cookie', `${COOKIE}=${code}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`);
    return send(res, 200, { ok: true, country: code, votes });
  } catch (err) {
    if (/[А-Яа-я]/.test(err.message)) return send(res, 400, { error: err.message });
    console.error('[admin] euvote failed', err);
    return send(res, 500, { error: 'server' });
  }
}
