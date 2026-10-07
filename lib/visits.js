// Anonymous visit statistics: no cookies and no IP stored — a visitor is a hash of IP + browser with a random salt per day.
// Salts are kept 2 days and then deleted (nightly job), after which no hash can be linked to anyone again.
import { createHash, randomBytes } from 'node:crypto';
import { DEFAULT_SHOP } from './shops.js';

export const sofiaDay = (d = new Date()) => d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Sofia' });
export const MAX_VISITORS_PER_ADDRESS = 50; // per site and day — stops a script from inventing visitors by changing its browser name
const saltCache = new WeakMap(); // q → { day, salt } on warm instances

/** Today's random salt (created on first use, stored in zd.settings until the nightly job removes it). */
export async function dailySalt(q, day = sofiaDay()) {
  const hit = saltCache.get(q);
  if (hit && hit.day === day) return hit.salt;
  const key = `visit_salt:${day}`;
  await q(`insert into zd.settings (key, value) values ($1, jsonb_build_object('salt', $2::text)) on conflict (key) do nothing`, [key, randomBytes(32).toString('hex')]);
  const [r] = await q(`select value->>'salt' as salt from zd.settings where key = $1`, [key]);
  saltCache.set(q, { day, salt: r.salt });
  return r.salt;
}

const hash = (v) => createHash('sha256').update(v).digest('hex').slice(0, 16);
export const visitorId = ({ ip, ua, site, salt }) => hash(`${salt}|${site}|${ip}|${ua}`);
const addressId = ({ ip, site, salt }) => hash(`${salt}|${site}|${ip}|address`);

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
  const utm = String(p.get('utm_source') || '').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 40); // free text from the URL: keep it tidy
  const UTM_ALIASES = { fb: 'facebook', ig: 'instagram' }; // what Meta ads put in utm_source
  if (utm) return { source: UTM_ALIASES[utm] || utm, campaign };
  for (const [param, source] of CLICK_IDS) if (p.get(param)) return { source, campaign };
  let host = '';
  try { host = new URL(String(referrer)).host.toLowerCase().replace(/^www\./, ''); } catch { /* none */ }
  if (!host || host === site || host.endsWith(`.${site}`)) return { source: 'direct', campaign };
  for (const [re, source] of REFERRERS) if (re.test(host)) return { source, campaign };
  return { source: host.slice(0, 60), campaign };
}

/** One row per visitor per day (its first page and source); at most MAX_VISITORS_PER_ADDRESS visitors per address per day. */
export async function recordVisit(q, { site, shopId, ip, ua, path = '', search = '', referrer = '' }) {
  const day = sofiaDay();
  const salt = await dailySalt(q, day);
  const { source, campaign } = classify({ search, referrer, site });
  const ipHash = addressId({ ip, site, salt });
  await q(
    `insert into zd.visits (day, site, visitor, ip_hash, path, source, campaign, device, shop_id)
     select $1::date, $2, $3, $4, $5, $6, $7, $8, $10::uuid
     where (select count(*) from zd.visits where day = $1::date and site = $2 and ip_hash = $4) < $9
     on conflict (day, site, visitor) do nothing`,
    [day, site, visitorId({ ip, ua, site, salt }), ipHash, String(path || '/').slice(0, 200), source, campaign.replace(/[<>"]/g, ''), deviceOf(ua), MAX_VISITORS_PER_ADDRESS, shopId || DEFAULT_SHOP],
  );
}

/** The first traffic source of this browser on this site today ('' when it has no visit). */
export async function trafficSourceFor(q, { site, ip, ua }) {
  const day = sofiaDay();
  const salt = await dailySalt(q, day);
  const [r] = await q(
    `select source from zd.visits where day = $1::date and site = $2 and visitor = $3 order by created_at, id limit 1`,
    [day, site, visitorId({ ip, ua, site, salt })],
  );
  return r?.source || '';
}
