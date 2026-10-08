import { getQuery } from '../db.js';
import { isAdmin } from '../auth.js';
import { readJson, send, searchParams } from '../http.js';
import { resolveShop } from '../shops.js';
import { waybillDefaults, previewWaybill, createWaybill, cancelWaybill, releaseWaybill } from '../waybills.js';

const ACTIONS = { defaults: waybillDefaults, preview: previewWaybill, create: createWaybill, cancel: cancelWaybill, release: releaseWaybill };

/** POST {action: defaults | preview | create | cancel | release, id, ...waybill fields} — always through the order's shop (or "all shops"). */
export default async function handler(req, res) {
  if (!isAdmin(req)) return send(res, 401, { error: 'auth' });
  if (req.method !== 'POST') return send(res, 405, { error: 'method' });
  const b = readJson(req) || {};
  const run = Object.hasOwn(ACTIONS, b.action) ? ACTIONS[b.action] : null;
  if (!run) return send(res, 400, { error: 'Непознато действие' });
  const q = getQuery();
  try {
    const scope = await resolveShop(q, searchParams(req).get('shop'), { allowAll: true });
    const { action, id, ...input } = b;
    return send(res, 200, { ok: true, ...(await run(q, { orderId: id, scopeShopId: scope.id, input })) });
  } catch (err) {
    if (/[А-Яа-я]/.test(err.message)) return send(res, 400, { error: err.message });
    console.error('[admin] waybills failed', b.action, err);
    return send(res, 500, { error: 'Неочаквана грешка на сървъра — опитайте отново' });
  }
}
