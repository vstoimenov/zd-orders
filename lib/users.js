// Client logins (stage 2): the owner creates a client with shops; a one-time link sets the password; the client sees only those shops.
import { randomBytes, scrypt as scryptCb, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { verifySession, COOKIE } from './auth.js';

const scrypt = promisify(scryptCb);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WEEK = 7 * 24 * 3600;
const INVITE_DAYS = 7;
const MAX_FAILED = 10;
const LOCK_MINUTES = 15;
const MIN_PASSWORD = 8;
const sha = (v) => createHash('sha256').update(String(v)).digest('hex');
const now = () => Math.floor(Date.now() / 1000);
const base = () => (process.env.PUBLIC_BASE_URL || 'https://kurier.profitbrand.online').replace(/\/$/, '');

/* ---- passwords (scrypt, per-user salt) ---- */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(String(password), salt, 64);
  return `s1$${salt.toString('base64')}$${key.toString('base64')}`;
}
async function passwordOk(password, stored) {
  const [v, salt, key] = String(stored || '').split('$');
  if (v !== 's1' || !salt || !key) return false;
  const want = Buffer.from(key, 'base64');
  const got = await scrypt(String(password ?? ''), Buffer.from(salt, 'base64'), want.length);
  return timingSafeEqual(got, want);
}

/* ---- sessions: c.<user>.<version>.<exp>.<hmac> (the owner's token stays <exp>.<hmac>) ---- */
const sign = (secret, v) => createHmac('sha256', secret).update(v).digest('hex');
export function clientSession(secret, user, nowSec = now()) {
  const body = `c.${user.id}.${user.session_version}.${nowSec + WEEK}`;
  return `${body}.${sign(secret, body)}`;
}
function readClientToken(secret, token, nowSec = now()) {
  const parts = String(token || '').split('.');
  if (parts.length !== 5 || parts[0] !== 'c' || !secret) return null;
  const [, id, ver, exp, sig] = parts;
  if (!UUID.test(id) || !/^\d+$/.test(ver) || !/^\d+$/.test(exp) || Number(exp) < nowSec) return null;
  const want = Buffer.from(sign(secret, `c.${id}.${ver}.${exp}`)), got = Buffer.from(String(sig));
  return want.length === got.length && timingSafeEqual(want, got) ? { id, version: Number(ver) } : null;
}
function readCookie(req) {
  const hit = String(req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  return hit ? hit.slice(COOKIE.length + 1) : '';
}

/**
 * Who is asking: { owner: true } (the platform owner's password login) | { owner: false, id, email, name, shopIds } | null.
 * A client counts only while active and while the session version matches (a new password or stopped access ends old sessions).
 */
export async function adminUser(req, q) {
  const token = readCookie(req);
  const secret = process.env.ADMIN_SECRET;
  if (verifySession(secret, token)) return { owner: true };
  const t = readClientToken(secret, token);
  if (!t) return null;
  const [u] = await q(`select id, email, name, active, session_version from zd.users where id = $1::uuid`, [t.id]);
  if (!u || !u.active || u.session_version !== t.version) return null;
  const shops = await q(`select shop_id from zd.user_shops where user_id = $1::uuid order by shop_id`, [u.id]);
  return { owner: false, id: u.id, email: u.email, name: u.name, shopIds: shops.map((s) => s.shop_id) };
}

/* ---- the owner's client list ---- */
function cleanEmail(v) {
  const e = String(v ?? '').trim().toLowerCase();
  if (!EMAIL.test(e) || e.length > 160) throw new Error('Невалиден имейл');
  return e;
}
async function checkShops(q, shopIds) {
  const ids = [...new Set((Array.isArray(shopIds) ? shopIds : []).map(String))];
  if (ids.some((id) => !UUID.test(id))) throw new Error('Невалиден магазин');
  if (!ids.length) return [];
  const found = await q(`select id from zd.shops where id = any($1::uuid[])`, [ids]);
  if (found.length !== ids.length) throw new Error('Невалиден магазин');
  return ids;
}
async function setShops(q, userId, ids) {
  await q(`delete from zd.user_shops where user_id = $1::uuid and not (shop_id = any($2::uuid[]))`, [userId, ids]);
  if (ids.length) await q(`insert into zd.user_shops (user_id, shop_id) select $1::uuid, unnest($2::uuid[]) on conflict do nothing`, [userId, ids]);
}

/** A fresh one-time link (7 days) for this client; an earlier link stops working. */
export async function newInvite(q, userId) {
  if (!UUID.test(String(userId || ''))) throw new Error('Няма такъв клиент');
  const token = randomBytes(32).toString('base64url');
  const [u] = await q(`update zd.users set invite_hash = $2, invite_expires_at = now() + interval '${INVITE_DAYS} days' where id = $1::uuid returning id`, [userId, sha(token)]);
  if (!u) throw new Error('Няма такъв клиент');
  return { token, link: `${base()}/admin/?invite=${token}` };
}

export async function createClient(q, { email, name = '', shopIds = [] }) {
  const e = cleanEmail(email);
  const n = String(name ?? '').trim().slice(0, 80);
  const ids = await checkShops(q, shopIds);
  const [dup] = await q(`select 1 from zd.users where lower(email) = $1`, [e]);
  if (dup) throw new Error('Клиент с този имейл вече има');
  const [u] = await q(`insert into zd.users (email, name) values ($1, $2) returning id`, [e, n]);
  await setShops(q, u.id, ids);
  return { id: u.id, ...(await newInvite(q, u.id)) };
}

/** name, shops, active (stopping access ends the client's sessions at once). */
export async function updateClient(q, id, { name, shopIds, active } = {}) {
  if (!UUID.test(String(id || ''))) throw new Error('Няма такъв клиент');
  const [u] = await q(`select id, active from zd.users where id = $1::uuid`, [id]);
  if (!u) throw new Error('Няма такъв клиент');
  if (name !== undefined) await q(`update zd.users set name = $2 where id = $1::uuid`, [id, String(name ?? '').trim().slice(0, 80)]);
  if (shopIds !== undefined) await setShops(q, id, await checkShops(q, shopIds));
  if (active !== undefined && Boolean(active) !== u.active) {
    await q(`update zd.users set active = $2, session_version = session_version + 1, failed_logins = 0, locked_until = null where id = $1::uuid`, [id, Boolean(active)]);
  }
  return { ok: true };
}

export async function listClients(q) {
  const rows = await q(
    `select u.id, u.email, u.name, u.active, u.password_hash is not null as has_password, u.created_at, u.last_login_at,
       u.invite_expires_at > now() as invite_open,
       coalesce((select array_agg(s.shop_id order by s.shop_id) from zd.user_shops s where s.user_id = u.id), '{}') as shop_ids
     from zd.users u order by u.created_at desc`,
  );
  return rows.map((r) => ({
    id: r.id, email: r.email, name: r.name, active: r.active, hasPassword: r.has_password, inviteOpen: Boolean(r.invite_open), shopIds: r.shop_ids,
    createdAt: new Date(r.created_at).toISOString(), lastLoginAt: r.last_login_at ? new Date(r.last_login_at).toISOString() : null,
  }));
}

/* ---- the client's side ---- */
async function byInvite(q, token) {
  if (!/^[A-Za-z0-9_-]{40,}$/.test(String(token || ''))) return null;
  const [u] = await q(`select id, email, name, active from zd.users where invite_hash = $1 and invite_expires_at > now()`, [sha(token)]);
  return u && u.active ? u : null;
}
export async function inviteInfo(q, token) {
  const u = await byInvite(q, token);
  return u ? { email: u.email, name: u.name } : null;
}
/** Sets the password once per link; earlier sessions end. */
export async function acceptInvite(q, token, password) {
  if (String(password ?? '').length < MIN_PASSWORD) throw new Error(`Паролата трябва да е поне ${MIN_PASSWORD} знака`);
  if (String(password).length > 200) throw new Error('Паролата е твърде дълга');
  const u = await byInvite(q, token);
  if (!u) throw new Error('Линкът е изтекъл или вече е използван — поискайте нов');
  const hash = await hashPassword(password);
  const [r] = await q(
    `update zd.users set password_hash = $2, invite_hash = null, invite_expires_at = null, session_version = session_version + 1,
       failed_logins = 0, locked_until = null, last_login_at = now()
     where id = $1::uuid and invite_hash = $3 returning id, session_version`, [u.id, hash, sha(token)],
  );
  if (!r) throw new Error('Линкът е изтекъл или вече е използван — поискайте нов');
  return r;
}

/** Email + password → the user (for the session), or a Bulgarian error. Too many wrong passwords lock the account for a while. */
export async function loginClient(q, email, password) {
  let e;
  try { e = cleanEmail(email); } catch { return null; }
  const [u] = await q(`select id, password_hash, active, session_version, failed_logins, locked_until > now() as locked from zd.users where lower(email) = $1`, [e]);
  if (!u || !u.active || !u.password_hash) return null;
  if (u.locked) throw Object.assign(new Error(`Твърде много грешни опити — опитайте пак след ${LOCK_MINUTES} минути`), { locked: true });
  if (!(await passwordOk(password, u.password_hash))) {
    await q(
      `update zd.users set
         locked_until = case when failed_logins + 1 >= ${MAX_FAILED} then now() + interval '${LOCK_MINUTES} minutes' else locked_until end,
         failed_logins = case when failed_logins + 1 >= ${MAX_FAILED} then 0 else failed_logins + 1 end
       where id = $1::uuid`, [u.id]);
    return null;
  }
  await q(`update zd.users set failed_logins = 0, locked_until = null, last_login_at = now() where id = $1::uuid`, [u.id]);
  return { id: u.id, session_version: u.session_version };
}
