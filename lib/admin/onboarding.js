import { getQuery } from '../db.js';
import { adminUser } from '../users.js';
import { resolveShop } from '../shops.js';
import { getIntegration } from '../integrations-repo.js';
import { send, searchParams } from '../http.js';

const base = () => (process.env.PUBLIC_BASE_URL || 'https://kurier.profitbrand.online').replace(/\/$/, '');
const iso = (v) => (v ? new Date(v).toISOString() : null);

/** GET ?shop= → what of the "Първи стъпки" guide is done for this shop (read from real data); { shop: null } when the client has none. */
export default async function handler(req, res) {
  const q = getQuery();
  const user = await adminUser(req, q).catch(() => null);
  if (!user) return send(res, 401, { error: 'auth' });
  if (req.method !== 'GET') return send(res, 405, { error: 'method' });
  const snippet = `<script src="${base()}/kurier.js" defer></script>`;
  const param = searchParams(req).get('shop');
  let shop;
  try {
    ({ shop } = await resolveShop(q, param === 'all' ? null : param, { user }));
  } catch {
    return send(res, 200, { shop: null, snippet }); // a client without a shop: the guide starts with "add your shop"
  }
  try {
    const [[visits], [widget], [orders], cb, econt, speedy, meta] = await Promise.all([
      q(`select count(*)::int as n, max(created_at) as at from zd.visits where shop_id = $1::uuid and day > current_date - 30`, [shop.id]),
      q(`select count(*)::int as n, max(created_at) as at from zd.orders where shop_id = $1::uuid and source = 'widget'`, [shop.id]),
      q(`select count(*)::int as n from zd.orders where shop_id = $1::uuid`, [shop.id]),
      getIntegration(q, 'convertbuilder', shop.id),
      getIntegration(q, 'econt', shop.id),
      getIntegration(q, 'speedy', shop.id),
      getIntegration(q, 'meta', shop.id),
    ]);
    const on = (i, ready) => i.hasSecret && i.config.active !== false && ready(i.config);
    return send(res, 200, {
      snippet,
      shop: { id: shop.id, name: shop.name, domain: shop.domain, approved: shop.approved, placeholder: shop.domain === 'shop.local' },
      widget: { visits: visits.n, lastVisitAt: iso(visits.at), orders: widget.n, lastOrderAt: iso(widget.at) },
      orders: orders.n,
      convertbuilder: { connected: on(cb, (c) => Boolean(c.domain)), webhook: Boolean(cb.config.webhookId), lastSyncAt: cb.config.lastSyncAt || null, lastError: cb.config.lastError || null },
      econt: on(econt, (c) => Boolean(c.sender)),
      speedy: on(speedy, (c) => Boolean(c.sender && c.clientId)),
      meta: on(meta, (c) => Boolean(c.accountId)),
    });
  } catch (err) {
    console.error('[admin] onboarding failed', err);
    return send(res, 500, { error: 'server' });
  }
}
