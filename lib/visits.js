// Anonymous visit statistics: no cookies and no IP stored — a visitor is a hash of IP + browser with a salt that changes daily,
// so the same person cannot be followed from one day to the next.
import { createHash, createHmac } from 'node:crypto';

export const sofiaDay = (d = new Date()) => d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Sofia' });
const salt = (day) => createHmac('sha256', process.env.VISITS_SALT || process.env.INTEGRATIONS_SECRET || process.env.ADMIN_SECRET || 'zd-visits').update(day).digest('hex');

export function visitorId({ ip, ua, site, day = sofiaDay() }) {
  return createHash('sha256').update(`${salt(day)}|${site}|${ip}|${ua}`).digest('hex').slice(0, 16);
}

const BOT = /bot|crawl|spider|slurp|facebookexternalhit|embedly|preview|headless|lighthouse|pingdom|monitor|curl|wget|python|axios|node-fetch|go-http|java\//i;
export const isBot = (ua) => !ua || BOT.test(ua);

export function deviceOf(ua = '') {
  if (/iPad|Tablet|Android(?!.*Mobile)/i.test(ua)) return 'tablet';
  if (/Mobi|iPhone|iPod|Android/i.test(ua)) return 'mobile';
  return 'desktop';
}

const CLICK_IDS = [['fbclid', 'facebook'], ['gclid', 'google'], ['gbraid', 'google'], ['wbraid', 'google'], ['ttclid', 'tiktok'], ['msclkid', 'bing']];
const REFERRERS = [[/(^|\.)google\./, 'google'], [/(^|\.)(facebook\.com|fb\.com|fb\.me)$/, 'facebook'], [/(^|\.)instagram\.com$/, 'instagram'],
  [/(^|\.)tiktok\.com$/, 'tiktok'], [/(^|\.)(youtube\.com|youtu\.be)$/, 'youtube'], [/(^|\.)bing\.com$/, 'bing']];

/** Where the visitor came from: utm_source, else an ad click id, else the referrer's site; internal or none = direct. */
export function classify({ search = '', referrer = '', site = '' }) {
  let p;
  try { p = new URLSearchParams(String(search)); } catch { p = new URLSearchParams(); }
  const campaign = String(p.get('utm_campaign') || '').trim().slice(0, 100);
  const utm = String(p.get('utm_source') || '').trim().toLowerCase().slice(0, 60);
  if (utm) return { source: utm, campaign };
  for (const [param, source] of CLICK_IDS) if (p.get(param)) return { source, campaign };
  let host = '';
  try { host = new URL(String(referrer)).host.toLowerCase().replace(/^www\./, ''); } catch { /* none */ }
  if (!host || host === site || host.endsWith(`.${site}`)) return { source: 'direct', campaign };
  for (const [re, source] of REFERRERS) if (re.test(host)) return { source, campaign };
  return { source: host.slice(0, 60), campaign };
}

export async function recordVisit(q, { site, ip, ua, path = '', search = '', referrer = '' }) {
  const day = sofiaDay();
  const { source, campaign } = classify({ search, referrer, site });
  await q(
    `insert into zd.visits (day, site, visitor, path, source, campaign, device) values ($1::date, $2, $3, $4, $5, $6, $7)`,
    [day, site, visitorId({ ip, ua, site, day }), String(path || '/').slice(0, 200), source, campaign, deviceOf(ua)],
  );
}

/** The first traffic source of this browser on this site today ('' when it has no visit). */
export async function trafficSourceFor(q, { site, ip, ua }) {
  const day = sofiaDay();
  const [r] = await q(
    `select source from zd.visits where day = $1::date and site = $2 and visitor = $3 order by created_at, id limit 1`,
    [day, site, visitorId({ ip, ua, site, day })],
  );
  return r?.source || '';
}
