// Changing where an order goes after it was placed — by the customer (order page) or the shop (admin). Only while nothing
// was sent: no waybill, not at a fulfilment warehouse, still new/confirmed. The write itself re-checks that (a waybill made
// meanwhile wins).
import { getIntegration } from './integrations-repo.js';
import { notifyOrderEvent } from './push.js';

const NAME = { econt: 'Еконт', speedy: 'Спиди', boxnow: 'BOX NOW' };
const OPEN = ['new', 'confirmed'];
const str = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Whether this order's delivery may still be changed (for the order page / admin buttons). */
export const canChangeDelivery = (o) => OPEN.includes(o.status) && !o.waybill_number && !o.fulfil_sent_at;

/** BOX NOW lockers offered to this shop's customers (the shop turned them on for its checkout). */
export async function boxnowForCustomers(q, shopId) {
  return (await getIntegration(q, 'boxnow', shopId)).config.checkout === true;
}

/**
 * input: {courier, officeId} | {courier, city, postCode, addressText}. by: 'customer' | 'shop'. scope limits the shops
 * (admin): {shopId} or {shopIds}. Throws Bulgarian messages; returns the updated row.
 */
export async function changeDelivery(q, orderId, input = {}, { by = 'shop', scopeShopId = null, scopeShopIds = null } = {}) {
  const [o] = await q(
    `select * from zd.orders where id = $1::uuid and ($2::text is null or shop_id = $2::uuid) and ($3::uuid[] is null or shop_id = any($3::uuid[]))`,
    [orderId, scopeShopId, scopeShopIds]);
  if (!o) throw new Error('Няма такава поръчка');
  const customer = by === 'customer';
  if (o.fulfil_sent_at) throw new Error(customer ? 'Поръчката вече се подготвя за изпращане — за промяна се обадете на магазина' : 'Поръчката е при склада');
  if (o.waybill_number) throw new Error(customer ? 'Поръчката вече е изпратена — за промяна се обадете на магазина' : 'Поръчката вече има товарителница');
  if (!OPEN.includes(o.status)) throw new Error(customer ? 'Поръчката вече е изпратена или затворена — за промяна се обадете на магазина' : 'Поръчката вече е изпратена или затворена');
  const courier = String(input.courier || '');
  if (!NAME[courier]) throw new Error('Изберете куриер');
  if (courier === 'boxnow' && customer && !(await boxnowForCustomers(q, o.shop_id))) throw new Error('Магазинът не изпраща с BOX NOW');
  let patch;
  const officeId = str(input.officeId, 40);
  if (officeId) {
    const [f] = await q(`select id, name, city, code from zd.offices where id = $1 and courier = $2`, [officeId, courier]);
    if (!f) throw new Error('Няма такъв офис или автомат — изберете от списъка');
    patch = { deliveryType: courier === 'boxnow' ? 'boxnow_locker' : `${courier}_office`, officeId: f.id, officeText: `${f.name}, ${f.city} (${f.code})`, city: f.city, postCode: '', addressText: '' };
  } else {
    if (courier === 'boxnow') throw new Error('BOX NOW доставя само до автомат — изберете автомат');
    const city = str(input.city, 80), addressText = str(input.addressText, 200);
    if (!city || !addressText) throw new Error('Въведете град и адрес');
    patch = { deliveryType: `${courier}_address`, officeId: '', officeText: `${NAME[courier]} – адрес: ${addressText}, ${city}`, city, postCode: str(input.postCode, 12), addressText };
  }
  const [r] = await q(
    `update zd.orders set courier = $2, delivery_type = $3, office_id = $4, office_text = $5, city = $6, post_code = $7, address_text = $8,
       delivery_changed_at = now(), delivery_changed_by = $9
     where id = $1::uuid and waybill_number = '' and fulfil_sent_at is null and status = any($10::text[]) returning *`,
    [o.id, courier, patch.deliveryType, patch.officeId, patch.officeText, patch.city, patch.postCode, patch.addressText, customer ? 'customer' : 'shop', OPEN]);
  if (!r) throw new Error(customer ? 'Поръчката вече е изпратена — за промяна се обадете на магазина' : 'Поръчката вече има товарителница');
  if (customer) await notifyOrderEvent(q, o.id, '📍 Клиентът смени доставката');
  return r;
}
