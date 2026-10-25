import { normalizePhone } from './phone.js';
import { cleanInvoice } from './invoice.js';

// `other`: a site sent the order without one of our couriers (WooCommerce „само поръчките“) — the shop picks it in the waybill window
const COURIER = { econt_office: 'econt', econt_address: 'econt', speedy_office: 'speedy', speedy_address: 'speedy', boxnow_locker: 'boxnow', other: 'other' };
const ADDRESS = ['speedy_address', 'econt_address'];

const str = (v, max) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/\s+/g, ' ').trim().slice(0, max) : '');
const money = (v) => Math.round(Number(v) * 100) / 100;
const fail = (error) => ({ ok: false, error });

export function validateOrder(body) {
  if (!body || typeof body !== 'object') return fail('invalid body');
  const cbOrderId = str(body.cb_order_id, 64);
  if (!cbOrderId) return fail('cb_order_id required');
  const name = str(body.name, 120);
  const phone = str(body.phone, 40);
  // ConvertBuilder already accepted the order: keep the copy even without a name or with a phone we can't normalise
  const phoneNorm = normalizePhone(phone) || '';
  const deliveryType = str(body.delivery_type, 20);
  if (!Object.hasOwn(COURIER, deliveryType)) return fail('invalid delivery_type');
  const courier = COURIER[deliveryType];
  const officeText = str(body.office_text, 300);
  const city = str(body.city, 80);
  const addressText = str(body.address_text, 200);
  if (ADDRESS.includes(deliveryType)) {
    if (!city || !addressText) return fail('address required');
  } else if (deliveryType !== 'other' && !officeText) return fail('office required');
  const total = Number(body.total);
  if (!Number.isFinite(total) || total < 0 || total > 100000) return fail('invalid total');
  if (!Array.isArray(body.items)) return fail('items required');
  const items = body.items
    .slice(0, 30)
    .map((it) => ({
      name: str(it?.name, 200),
      qty: Math.max(1, Math.min(999, parseInt(it?.qty, 10) || 1)),
      price: Number.isFinite(Number(it?.price)) ? money(it.price) : 0,
      ...(str(it?.sku, 64) ? { sku: str(it.sku, 64) } : {}),
    }))
    .filter((it) => it.name);
  return {
    ok: true,
    order: {
      cbOrderId, name, phone, phoneNorm, email: str(body.email, 160), deliveryType, courier,
      officeId: str(body.office_id, 40), officeText, city, postCode: str(body.post_code, 12), addressText,
      items, total: money(total), currency: str(body.currency, 3).toUpperCase() || 'EUR',
      paymentMethod: str(body.payment_method, 30), pageUrl: str(body.page_url, 500),
      invoice: cleanInvoice(body.invoice).invoice, // kept as typed; never refuses the order
    },
  };
}
