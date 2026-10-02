export const STATUSES = ['new', 'confirmed', 'shipped', 'delivered', 'returned', 'cancelled'];

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toOrder(r) {
  return {
    id: r.id, createdAt: new Date(r.created_at).toISOString(), cbOrderId: r.cb_order_id, name: r.name,
    phone: r.phone, phoneNorm: r.phone_norm, email: r.email, deliveryType: r.delivery_type, courier: r.courier,
    officeId: r.office_id, officeText: r.office_text, city: r.city, postCode: r.post_code, addressText: r.address_text,
    items: typeof r.items === 'string' ? JSON.parse(r.items) : r.items, total: Number(r.total), currency: r.currency,
    paymentMethod: r.payment_method, status: r.status, isDuplicate: r.is_duplicate,
  };
}

export async function insertOrder(q, o) {
  const rows = await q(
    `insert into zd.orders (cb_order_id, name, phone, phone_norm, email, delivery_type, courier, office_id, office_text,
       city, post_code, address_text, items, total, currency, payment_method, page_url, user_agent, ip, is_duplicate)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::text::jsonb, $14::text::numeric, $15, $16, $17, $18, $19, false)
     on conflict (cb_order_id) do nothing
     returning id`,
    [o.cbOrderId, o.name, o.phone, o.phoneNorm, o.email, o.deliveryType, o.courier, o.officeId, o.officeText,
      o.city, o.postCode, o.addressText, JSON.stringify(o.items), String(o.total), o.currency, o.paymentMethod,
      o.pageUrl, o.userAgent ?? '', o.ip ?? ''],
  );
  if (!rows.length) return { inserted: false, duplicate: false, id: null };
  const newId = rows[0].id;
  const flagged = await q(
    `update zd.orders set is_duplicate = true
     where phone_norm = $1 and created_at > now() - interval '24 hours'
       and (select count(*) from zd.orders where phone_norm = $1 and created_at > now() - interval '24 hours') > 1
     returning id`,
    [o.phoneNorm],
  );
  const duplicate = flagged.some((r) => r.id === newId);
  return { inserted: true, duplicate, id: newId };
}

export async function countRecentByIp(q, ip) {
  const rows = await q(`select count(*)::int as n from zd.orders where ip = $1 and created_at > now() - interval '10 minutes'`, [ip]);
  return rows[0].n;
}

export async function listOrders(q, { status = '', from = '', to = '', search = '', page = 1, pageSize = 50 } = {}) {
  const where = [];
  const params = [];
  const arg = (v) => { params.push(v); return `$${params.length}`; };
  if (STATUSES.includes(status)) where.push(`status = ${arg(status)}`);
  if (DATE.test(from)) where.push(`created_at >= (${arg(from)}::date)::timestamp at time zone 'Europe/Sofia'`);
  if (DATE.test(to)) where.push(`created_at < (${arg(to)}::date + 1)::timestamp at time zone 'Europe/Sofia'`);
  const s = String(search).trim().slice(0, 60);
  if (s) {
    const byName = `name ilike ${arg(`%${s}%`)}`;
    const digits = s.replace(/\D/g, '').replace(/^0/, '');
    where.push(digits.length >= 3 ? `(${byName} or phone_norm like ${arg(`%${digits}%`)})` : byName);
  }
  const validPageSize = Number.isSafeInteger(Math.trunc(pageSize)) ? Math.trunc(pageSize) : 50;
  const size = Math.min(Math.max(1, validPageSize), 5000);
  const validPage = Number.isSafeInteger(Math.trunc(page)) ? Math.max(1, Math.min(Math.trunc(page), 100000)) : 1;
  const offset = (validPage - 1) * size;
  const rows = await q(
    `select *, count(*) over () as full_count from zd.orders
     ${where.length ? `where ${where.join(' and ')}` : ''}
     order by created_at desc, cb_order_id limit ${size} offset ${offset}`,
    params,
  );
  return { rows: rows.map(toOrder), total: rows.length ? Number(rows[0].full_count) : 0 };
}

export async function updateStatus(q, id, status) {
  if (!UUID.test(String(id)) || !STATUSES.includes(status)) return false;
  const rows = await q(`update zd.orders set status = $2, status_changed_at = now() where id = $1::uuid returning id`, [id, status]);
  return rows.length > 0;
}
