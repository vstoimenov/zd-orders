import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const COOKIE = 'zdo_admin';
const WEEK = 7 * 24 * 3600;
const now = () => Math.floor(Date.now() / 1000);

const hmac = (secret, v) => createHmac('sha256', secret).update(v).digest('hex');
const sha = (v) => createHash('sha256').update(v).digest('hex');
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

export function signSession(secret, nowSec = now()) {
  const exp = String(nowSec + WEEK);
  return `${exp}.${hmac(secret, exp)}`;
}

export function verifySession(secret, token, nowSec = now()) {
  const [exp, sig] = String(token || '').split('.');
  if (!secret || !/^\d+$/.test(exp || '') || !sig || Number(exp) < nowSec) return false;
  return safeEqual(sig, hmac(secret, exp));
}

export function passwordMatches(input, expected) {
  return Boolean(expected) && safeEqual(sha(String(input ?? '')), sha(expected));
}

function readCookie(req, name) {
  const hit = String(req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(`${name}=`));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : '';
}

export function isAdmin(req) {
  return verifySession(process.env.ADMIN_SECRET, readCookie(req, COOKIE));
}

export function sessionCookie(token) {
  return `${COOKIE}=${token}; Path=/api/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${WEEK}`;
}
