// Public, no login: the unsubscribe link in every campaign e-mail (GET shows the page and unsubscribes; the one-click POST of mail
// clients does the same) and Resend's webhook (POST ?webhook=1) with what happened to each message.
import { getQuery } from '../db.js';
import { readUnsub, webhookOk } from '../email.js';
import { addEmailOptout, applyEmailEvent } from '../email-campaigns.js';
import { readJson, readRaw, send, searchParams } from '../http.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const page = (title, text) => `<!doctype html><html lang="bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{margin:0;background:#f4f4f1;font:16px/1.5 Inter,system-ui,sans-serif;color:#14140f;display:grid;place-items:center;min-height:100vh}.c{background:#fff;border:1px solid #e6e4dc;border-radius:16px;padding:28px 32px;max-width:420px;text-align:center}h1{font-size:22px;margin:0 0 8px}p{margin:0;color:#6d6c66}</style></head>
<body><div class="c"><h1>${esc(title)}</h1><p>${esc(text)}</p></div></body></html>`;
const html = (res, status, body) => { res.statusCode = status; res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'private, no-store'); return res.end(body); };

export default async function handler(req, res) {
  const q = getQuery();
  const p = searchParams(req);
  try {
    if (p.get('webhook') === '1') {
      if (req.method !== 'POST') return send(res, 405, { error: 'method' });
      const raw = await readRaw(req);
      if (!webhookOk(raw, req.headers)) return send(res, 401, { error: 'signature' });
      let event = null;
      try { event = JSON.parse(raw); } catch { return send(res, 400, { error: 'json' }); }
      return send(res, 200, await applyEmailEvent(q, event));
    }
    const t = readUnsub(p.get('u'));
    if (!t) return req.method === 'GET' ? html(res, 404, page('Линкът не е валиден', 'Отворете линка за отписване от самия имейл.')) : send(res, 404, { error: 'token' });
    if (!['GET', 'POST'].includes(req.method)) return send(res, 405, { error: 'method' });
    const c = String(p.get('c') || '');
    const [s] = await q(`select name, domain from zd.shops where id = $1::uuid`, [t.shopId]);
    await addEmailOptout(q, t.shopId, t.email, /^[0-9a-f-]{36}$/.test(c) ? `campaign:${c}` : 'link');
    if (req.method === 'POST') return send(res, 200, { ok: true });
    return html(res, 200, page('Отписахте се', `${t.email} няма да получава повече имейли от ${s?.name || s?.domain || 'магазина'}.`));
  } catch (err) {
    console.error('[email] public failed', err);
    return req.method === 'GET' && !p.get('webhook') ? html(res, 500, page('Нещо се обърка', 'Опитайте пак след малко.')) : send(res, 500, { error: 'server' });
  }
}
