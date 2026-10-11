import { getQuery } from '../db.js';
import { confirmPage, answerConfirm } from '../confirm.js';
import { readJson, send, searchParams } from '../http.js';

/** Public (the customer, no login): GET ?t → the order to confirm · POST {t, answer: yes | no}. */
export default async function handler(req, res) {
  const q = getQuery();
  try {
    if (req.method === 'GET') {
      const page = await confirmPage(q, searchParams(req).get('t'));
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
