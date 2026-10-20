// What the checkout widget needs to know about a shop before the customer chooses anything: whether BOX NOW is switched on and the
// delivery-time line under each courier ("1–2 работни дни" unless the shop wrote its own).
import { shopIdForHost } from './shops.js';
import { getIntegration } from './integrations-repo.js';

export const ETA_DEFAULT = '1–2 работни дни';
const COURIERS = ['econt', 'speedy', 'boxnow'];
const ETA_MAX = 40;
const key = (shopId) => `checkout:${shopId}`;

/** The shop's own checkout texts (defaults filled in). */
export async function getCheckoutText(q, shopId) {
  const [row] = await q(`select value from zd.settings where key = $1`, [key(shopId)]);
  const eta = row?.value?.eta || {};
  return { eta: Object.fromEntries(COURIERS.map((c) => [c, typeof eta[c] === 'string' ? eta[c] : ETA_DEFAULT])) };
}

/** Saves the delivery-time lines ('' = no line); only known couriers, at most 40 characters each. */
export async function saveCheckoutText(q, shopId, { eta } = {}) {
  const current = (await getCheckoutText(q, shopId)).eta;
  for (const [c, v] of Object.entries(eta || {})) {
    if (!COURIERS.includes(c)) throw new Error('Непознат куриер');
    const t = String(v ?? '').replace(/\s+/g, ' ').trim();
    if (t.length > ETA_MAX) throw new Error(`Срокът за доставка е до ${ETA_MAX} знака`);
    current[c] = t;
  }
  await q(`insert into zd.settings (key, value) values ($1, jsonb_build_object('eta', $2::jsonb)) on conflict (key) do update set value = excluded.value`, [key(shopId), JSON.stringify(current)]);
  return { eta: current };
}

/** For the widget, by the host it runs on: BOX NOW switch + delivery-time lines (defaults for an unknown site). */
export async function getCheckoutInfo(q, host) {
  const shopId = host ? await shopIdForHost(q, String(host).toLowerCase()) : null;
  if (!shopId) return { boxnow: false, eta: Object.fromEntries(COURIERS.map((c) => [c, ETA_DEFAULT])) };
  const [boxnow, text] = await Promise.all([getIntegration(q, 'boxnow', shopId), getCheckoutText(q, shopId)]);
  return { boxnow: boxnow.config.checkout === true, eta: text.eta };
}
