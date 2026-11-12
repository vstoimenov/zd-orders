import { getQuery } from '../db.js';
import { adminUser, listClients, createClient, newInvite, updateClient, getSignup, newSignupLink, signupOff } from '../users.js';
import { approveShop, rejectShop } from '../shops.js';
import { offerActive, setOfferActive, OFFER_LINK } from '../offer.js';
import { readJson, send } from '../http.js';
import { chooseSubscription, markPaid, cancelSubscription, foundersLeft, FOUNDERS } from '../plans.js';

/** Owner only. GET → clients · POST {action: create {email, name, shopIds} | invite {id} | update {id, name?, shopIds?, active?} | approve_shop {shopId} | reject_shop {shopId} | offer_on | offer_off
 *  | sub_set {id, plan, billing} | sub_paid {id, paidAt?} | sub_cancel {id}}. */
export default async function handler(req, res) {
  const q = getQuery();
  const user = await adminUser(req, q).catch(() => null);
  if (!user) return send(res, 401, { error: 'auth' });
  if (!user.owner) return send(res, 403, { error: 'Само собственикът управлява клиентите' });
  try {
    if (req.method === 'GET') {
      const [users, signup, offer, left] = await Promise.all([listClients(q), getSignup(q), offerActive(q), foundersLeft(q)]);
      return send(res, 200, { users, signup: signup ? { link: signup.link, createdAt: signup.createdAt } : null, offer: { active: offer, link: OFFER_LINK }, founders: { left, of: FOUNDERS } });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'method' });
    const b = readJson(req) || {};
    switch (b.action) {
      case 'create': { const c = await createClient(q, b); return send(res, 200, { ok: true, id: c.id, link: c.link }); }
      case 'invite': return send(res, 200, { ok: true, link: (await newInvite(q, b.id)).link });
      case 'update': return send(res, 200, await updateClient(q, b.id, { name: b.name, shopIds: b.shopIds, active: b.active }));
      case 'signup_link': return send(res, 200, { ok: true, link: (await newSignupLink(q)).link }); // the old link stops working
      case 'signup_off': await signupOff(q); return send(res, 200, { ok: true });
      case 'offer_on': await setOfferActive(q, true); return send(res, 200, { ok: true });
      case 'offer_off': await setOfferActive(q, false); return send(res, 200, { ok: true }); // the printed link then says the offer has ended
      case 'sub_set': return send(res, 200, { ok: true, subscription: await chooseSubscription(q, b.id, { plan: b.plan, billing: b.billing }) });
      case 'sub_paid': return send(res, 200, { ok: true, subscription: await markPaid(q, b.id, { paidAt: b.paidAt || undefined }) }); // the first payment
      case 'sub_cancel': await cancelSubscription(q, b.id); return send(res, 200, { ok: true }); // the launch price is gone
      case 'approve_shop': return send(res, 200, { ok: true, shop: await approveShop(q, b.shopId) }); // its domain may now take checkout orders
      case 'reject_shop': return send(res, 200, { ok: true, ...(await rejectShop(q, b.shopId)) }); // a typo or someone else's domain: gone, the domain is free
      default: return send(res, 400, { error: 'Непознато действие' });
    }
  } catch (err) {
    if (/[А-Яа-я]/.test(err.message)) return send(res, 400, { error: err.message });
    console.error('[admin] users failed', err);
    return send(res, 500, { error: 'server' });
  }
}
