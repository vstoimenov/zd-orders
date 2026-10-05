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
    nkStatus: r.nk_status, nkCount: r.nk_count, nkReportIds: typeof r.nk_report_ids === 'string' ? JSON.parse(r.nk_report_ids) : (r.nk_report_ids || []),
    nkCheckedAt: r.nk_checked_at ? new Date(r.nk_checked_at).toISOString() : null,
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
  if (!o.phoneNorm) return { inserted: true, duplicate: false, id: newId }; // no valid phone → nothing to match
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

/** Stores a nekorekten.com check: status 'clean' | 'flagged' (with count + report ids) | 'error' (retried later). */
export async function saveNekorekten(q, id, { status, count = null, reportIds = [] }) {
  await q(
    `update zd.orders set nk_status = $2, nk_count = $3::text::int, nk_report_ids = $4::text::jsonb, nk_checked_at = now() where id = $1::uuid`,
    [id, status, count == null ? null : String(count), JSON.stringify(reportIds)],
  );
}

/** Orders from the last 30 days still waiting for (or failed) a nekorekten.com check, newest first. */
export async function pendingNekorekten(q, limit) {
  const rows = await q(
    `select id, phone_norm from zd.orders where nk_status in ('pending', 'error') and phone_norm <> '' and created_at > now() - interval '30 days'
       and (nk_checked_at is null or nk_checked_at < now() - interval '30 minutes')
     order by nk_checked_at nulls first, created_at desc limit ${Math.min(Math.max(1, Math.trunc(limit) || 1), 50)}`,
  );
  return rows.map((r) => ({ id: r.id, phoneNorm: r.phone_norm }));
}

/** Permanently removes an order (admin action). */
export async function deleteOrder(q, id) {
  if (!UUID.test(String(id))) return false;
  const rows = await q(`delete from zd.orders where id = $1::uuid returning id`, [id]);
  return rows.length > 0;
}
