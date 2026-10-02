import { normalizePhone } from './phone.js';

const COURIER = { econt_office: 'econt', speedy_office: 'speedy', speedy_address: 'speedy' };

const str = (v, max) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/\s+/g, ' ').trim().slice(0, max) : '');
const money = (v) => Math.round(Number(v) * 100) / 100;
const fail = (error) => ({ ok: false, error });

export function validateOrder(body) {
  if (!body || typeof body !== 'object') return fail('invalid body');
  const cbOrderId = str(body.cb_order_id, 64);
  if (!cbOrderId) return fail('cb_order_id required');
  const name = str(body.name, 120);
  if (name.length < 2) return fail('name required');
  const phone = str(body.phone, 40);
  const phoneNorm = normalizePhone(phone);
  if (!phoneNorm) return fail('invalid phone');
  const deliveryType = str(body.delivery_type, 20);
  const courier = COURIER[deliveryType];
  if (!courier) return fail('invalid delivery_type');
  const officeText = str(body.office_text, 300);
  const city = str(body.city, 80);
  const addressText = str(body.address_text, 200);
  if (deliveryType === 'speedy_address') {
    if (!city || !addressText) return fail('address required');
  } else if (!officeText) return fail('office required');
  const total = Number(body.total);
  if (!Number.isFinite(total) || total < 0 || total > 100000) return fail('invalid total');
  if (!Array.isArray(body.items)) return fail('items required');
  const items = body.items
    .slice(0, 30)
    .map((it) => ({
      name: str(it?.name, 200),
      qty: Math.max(1, Math.min(999, parseInt(it?.qty, 10) || 1)),
      price: Number.isFinite(Number(it?.price)) ? money(it.price) : 0,
    }))
    .filter((it) => it.name);
  return {
    ok: true,
    order: {
      cbOrderId, name, phone, phoneNorm, email: str(body.email, 160), deliveryType, courier,
      officeId: str(body.office_id, 40), officeText, city, postCode: str(body.post_code, 12), addressText,
      items, total: money(total), currency: str(body.currency, 3).toUpperCase() || 'EUR',
      paymentMethod: str(body.payment_method, 30), pageUrl: str(body.page_url, 500),
    },
  };
}
