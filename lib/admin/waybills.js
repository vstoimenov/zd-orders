import { getQuery } from '../db.js';
import { adminUser } from '../users.js';
import { readJson, send, searchParams } from '../http.js';
import { resolveShop } from '../shops.js';
import { waybillDefaults, previewWaybill, createWaybill, cancelWaybill, releaseWaybill, waybillPdf, confirmDrop, assignRoute } from '../waybills.js';

const ACTIONS = { defaults: waybillDefaults, preview: previewWaybill, create: createWaybill, cancel: cancelWaybill, release: releaseWaybill, drop: confirmDrop, route: assignRoute };

const errorReply = (res, err, what) => {
  if (/[А-Яа-я]/.test(err.message)) return send(res, 400, { error: err.message });
  console.error('[admin] waybills failed', what, err);
  return send(res, 500, { error: 'Неочаквана грешка на сървъра — опитайте отново' });
};

/** GET ?pdf=<order id> → a Speedy waybill PDF. */
async function pdf(req, res, q, user) {
  try {
    const p = searchParams(req);
    const scope = await resolveShop(q, p.get('shop'), { allowAll: true, user });
    const out = await waybillPdf(q, { orderId: p.get('pdf'), scopeShopId: scope.id, scopeShopIds: scope.ids || null });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${out.filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    return res.end(out.pdf);
  } catch (err) { return errorReply(res, err, 'pdf'); }
}

/** POST {action: defaults | preview | create | cancel | release | drop | route, id, ...waybill fields} · GET ?pdf=<id> — always through the order's shop (or "all shops"). */
export default async function handler(req, res) {
  const q = getQuery();
  const user = await adminUser(req, q).catch(() => null);
  if (!user) return send(res, 401, { error: 'auth' });
  if (req.method === 'GET' && searchParams(req).get('pdf')) return pdf(req, res, q, user);
  if (req.method !== 'POST') return send(res, 405, { error: 'method' });
  const b = readJson(req) || {};
  const run = Object.hasOwn(ACTIONS, b.action) ? ACTIONS[b.action] : null;
  if (!run) return send(res, 400, { error: 'Непознато действие' });
  try {
    const scope = await resolveShop(q, searchParams(req).get('shop'), { allowAll: true, user });
    const { action, id, ...input } = b;
    return send(res, 200, { ok: true, ...(await run(q, { orderId: id, scopeShopId: scope.id, scopeShopIds: scope.ids || null, input })) });
  } catch (err) { return errorReply(res, err, b.action); }
}
