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
