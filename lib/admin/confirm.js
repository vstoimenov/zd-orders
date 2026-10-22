import { getQuery } from '../db.js';
import { confirmPage, answerConfirm, orderIdByToken } from '../confirm.js';
import { refreshOrderStatus } from '../waybills.js';
import { readJson, send, searchParams } from '../http.js';

/** Public (the customer, no login): GET ?t → the order page (to confirm, then where it is — fresh from the courier) · POST {t, answer: yes | no}. */
export default async function handler(req, res) {
  const q = getQuery();
  try {
    if (req.method === 'GET') {
      const t = searchParams(req).get('t');
      const id = await orderIdByToken(q, t);
      if (id) await refreshOrderStatus(q, id); // at most every 30 minutes, ~5 s budget, never throws
      const page = await confirmPage(q, t);
      return page ? send(res, 200, { ok: true, ...page }) : send(res, 404, { error: 'Линкът не е валиден' });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'method' });
    const b = readJson(req) || {};
    const r = await answerConfirm(q, b.t, b.answer);
    return r ? send(res, 200, r) : send(res, 404, { error: 'Линкът не е валиден' });
  } catch (err) {
    if (/[А-Яа-я]/.test(err.message)) return send(res, 400, { error: err.message });
    console.error('[confirm] failed', err);
    return send(res, 500, { error: 'server' });
  }
}
