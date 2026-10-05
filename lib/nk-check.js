import { lookupPhone } from './nekorekten.js';
import { saveNekorekten } from './orders-repo.js';

/**
 * Checks orders' phones on nekorekten.com one by one (the API allows 10 requests/min) and stores each result.
 * The shop owner chose automatic checks (2026-10-05); the store's privacy policy must mention them.
 */
export async function checkOrders(q, orders, apiKey, fetchImpl = fetch) {
  const summary = { checked: 0, flagged: 0, clean: 0, errors: 0 };
  for (const o of orders) {
    summary.checked++;
    try {
      const { count, reportIds } = await lookupPhone(o.phoneNorm, apiKey, fetchImpl);
      const status = count > 0 ? 'flagged' : 'clean';
      await saveNekorekten(q, o.id, { status, count, reportIds });
      summary[status]++;
    } catch (err) {
      console.error('[nekorekten] check failed', o.id, err.message);
      await saveNekorekten(q, o.id, { status: 'error' });
      summary.errors++;
    }
  }
  return summary;
}
