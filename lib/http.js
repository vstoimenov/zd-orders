import crypto from 'node:crypto';

export function allowedOrigins() {
  return String(process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
}

export function originAllowed(req) {
  const origin = String(req.headers.origin || '').replace(/\/$/, '');
  return origin && allowedOrigins().includes(origin) ? origin : null;
}

export function setCors(res, origin) {
  res.setHeader('Vary', 'Origin');
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
}

/** Vercel parses JSON bodies; a sendBeacon text/plain body arrives as a string (or Buffer). */
export function readJson(req) {
  const b = req.body;
  if (b && typeof b === 'object' && !Buffer.isBuffer(b)) return b;
  try {
    const v = JSON.parse(Buffer.isBuffer(b) ? b.toString('utf8') : String(b ?? ''));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

export function send(res, status, data) {
  res.statusCode = status;
  if (status === 204) return res.end();
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.end(JSON.stringify(data));
}

export function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '';
}

export function searchParams(req) {
  return new URL(req.url || '/', 'http://localhost').searchParams;
}

/** Compare two strings in constant time to prevent timing attacks. */
export function safeEqual(a, b) {
  const aBuffer = Buffer.from(String(a));
  const bBuffer = Buffer.from(String(b));
  if (aBuffer.length !== bBuffer.length) return false;
  return crypto.timingSafeEqual(aBuffer, bBuffer);
}

/** Exact request body (needed to verify webhook signatures): the unread stream on Vercel, or a string/Buffer body in tests. */
export async function readRaw(req) {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (typeof req.on === 'function' && req.readable) {
    const chunks = [];
    for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    return Buffer.concat(chunks).toString('utf8');
  }
  return req.body && typeof req.body === 'object' ? JSON.stringify(req.body) : '';
}
