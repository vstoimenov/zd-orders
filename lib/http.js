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

/**
 * Exact request body bytes (webhook signatures), or null. On Vercel the runtime has already read the body: it replays it
 * through req.on('data'/'end') while req.body is the parsed JSON, so req.body is never used (re-serializing changes bytes).
 * Plain objects without .on (tests) pass a string/Buffer body.
 */
export function readRaw(req, { timeoutMs = 5000 } = {}) {
  if (typeof req.on !== 'function') {
    const b = req.body;
    return Promise.resolve(typeof b === 'string' ? b : Buffer.isBuffer(b) ? b.toString('utf8') : null);
  }
  return new Promise((resolve) => {
    const chunks = [];
    const done = (v) => { clearTimeout(timer); resolve(v); };
    const timer = setTimeout(() => resolve(null), timeoutMs);
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => done(null));
  });
}
