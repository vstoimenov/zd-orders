// People the platform owner has banned: their e-mails, the browser (Meta _fbp cookie) and the IP addresses they used,
// or a single IP address on its own.
// A request from any of them gets nothing from the admin API — no login, no registration, no data. Kept in zd.settings `blocklist`.
import { clientIp } from './http.js';

const KEY = 'blocklist';
const TTL = 30e3; // the list is read at most every 30 s per server instance
let cache = null, cachedAt = 0;
const json = (v) => (typeof v === 'string' ? JSON.parse(v) : v || {});
const norm = (s) => String(s || '').trim().toLowerCase();
const uniq = (a) => [...new Set(a.filter(Boolean))];

export async function getBlocklist(q, { fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cachedAt < TTL) return cache;
  const [r] = await q(`select value from zd.settings where key = $1`, [KEY]);
  const v = r ? json(r.value) : {};
  cache = { emails: v.emails || [], browsers: v.browsers || [], ips: v.ips || [], people: v.people || [], notes: v.notes || {} };
  cachedAt = Date.now();
  return cache;
}
async function save(q, list) {
  await q(`insert into zd.settings (key, value) values ($1, $2::text::jsonb) on conflict (key) do update set value = excluded.value`, [KEY, JSON.stringify(list)]);
  cache = list; cachedAt = Date.now();
  return list;
}
export function resetBlocklistCache() { cache = null; cachedAt = 0; }

const fbpOf = (req) => (/(?:^|;\s*)_fbp=([^;]+)/.exec(String(req.headers?.cookie || '')) || [])[1] || '';

const ipsOf = (b) => [...new Set([...b.ips, ...b.people.map((p) => p.ip)].filter(Boolean))];

/** Whether this request (or this e-mail) is banned. A banned IP stays banned until the owner lifts it. */
export async function isBlocked(q, req, email = '') {
  const b = await getBlocklist(q);
  if (!b.people.length && !b.ips.length && !b.emails.length && !b.browsers.length) return false;
  const ip = clientIp(req), fbp = fbpOf(req), e = norm(email);
  return Boolean((ip && ipsOf(b).includes(ip)) || (fbp && b.browsers.includes(fbp)) || (e && b.emails.includes(e)));
}

/** Bans one IP address on its own (no account behind it). */
export async function blockIp(q, ip, { reason = '' } = {}) {
  const v = String(ip || '').trim();
  if (!/^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]{3,39}$/i.test(v)) throw new Error('Невалиден IP адрес');
  const b = await getBlocklist(q, { fresh: true });
  return save(q, { ...b, ips: uniq([...b.ips, v]), notes: { ...(b.notes || {}), [v]: String(reason).slice(0, 200) } });
}
export async function unblockIp(q, ip) {
  const b = await getBlocklist(q, { fresh: true });
  return save(q, { ...b, ips: b.ips.filter((x) => x !== String(ip).trim()) });
}

/**
 * Bans a client: the account is switched off and logged out everywhere, and its e-mail, the IP and browser it registered
 * from (when known) go to the list. Returns the person as listed.
 */
export async function blockUser(q, userId, { reason = '' } = {}) {
  const [u] = await q(`update zd.users set active = false, session_version = session_version + 1 where id = $1::uuid returning id, email, name, track`, [userId]);
  if (!u) throw new Error('Клиентът не е намерен');
  const t = json(u.track);
  const b = await getBlocklist(q, { fresh: true });
  const person = { id: u.id, email: norm(u.email), name: u.name || '', ip: t.ip || '', browser: t.fbp || '', reason: String(reason).slice(0, 200), at: new Date().toISOString() };
  return save(q, {
    ...b, emails: uniq([...b.emails, person.email]), browsers: uniq([...b.browsers, person.browser]),
    people: [...b.people.filter((p) => p.id !== u.id), person],
  });
}

/** Lifts a ban: the person's e-mail, IP and browser come off the list (the account stays switched off until „Пусни достъп“). */
export async function unblockUser(q, userId) {
  const b = await getBlocklist(q, { fresh: true });
  const p = b.people.find((x) => x.id === userId);
  if (!p) throw new Error('Този клиент не е блокиран');
  const rest = b.people.filter((x) => x.id !== userId);
  const still = (k) => new Set(rest.map((x) => x[k]).filter(Boolean));
  const e = still('email'), br = still('browser');
  return save(q, { ...b, emails: b.emails.filter((x) => x !== p.email || e.has(x)), browsers: b.browsers.filter((x) => x !== p.browser || br.has(x)), people: rest });
}
