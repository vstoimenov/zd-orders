import { DEFAULT_SHOP } from './shops.js';
import { trackUrl as econtTrack } from './econt-api.js';
import { trackUrl as speedyTrack } from './speedy-api.js';

export const STATUSES = ['new', 'confirmed', 'shipped', 'delivered', 'returned', 'cancelled'];

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const WAYBILL_PENDING = ['creating', 'unknown'];
const STALE_MS = 2 * 60 * 1000;
/** '' | 'creating' (right now) | 'unknown' (unclear, or a creation that never finished): no new waybill until a person releases it. */
function waybillState(r) {
  if (r.waybill_number === 'unknown') return 'unknown';
  if (r.waybill_number !== 'creating') return '';
  return r.waybill_created_at && Date.now() - new Date(r.waybill_created_at).getTime() > STALE_MS ? 'unknown' : 'creating';
}

/** A created courier waybill on the order, or null (none, or being created right now). */
/** Day N at the receiver's office, counted in Sofia calendar days (the arrival day is day 1). */
const sofiaDay = (d) => Date.parse(new Date(d).toLocaleDateString('sv-SE', { timeZone: 'Europe/Sofia' }));
const officeDay = (since) => (since ? Math.round((sofiaDay(Date.now()) - sofiaDay(since)) / 86400e3) + 1 : null);
const AT_OFFICE = `status = 'shipped' and waybill_at_office_since is not null`;
const TO_PACK = `status in ('new', 'confirmed') and packed_at is null and cb_check <> 'pending'`; // still to be sent, nobody packed it yet
const DUE = `(now() at time zone 'Europe/Sofia')::date - (waybill_at_office_since at time zone 'Europe/Sofia')::date >= 3`; // the 4th day: call the customer
// a live waybill whose parcel waits at the office from the 4th day, or whose courier status has not changed for 3+ days
const QUIET = `(now() at time zone 'Europe/Sofia')::date - (coalesce(waybill_status_changed_at, waybill_created_at) at time zone 'Europe/Sofia')::date >= 3`;
const PROBLEM = `status = 'shipped' and waybill_number not in ('', 'creating', 'unknown') and not waybill_demo
  and ((waybill_at_office_since is not null and ${DUE}) or (waybill_at_office_since is null and ${QUIET}))`;
const LIVE_WAYBILL = (r) => r.waybill_number && !['creating', 'unknown'].includes(r.waybill_number) && !r.waybill_demo;

function shipmentOf(r) {
  if (!r.waybill_number || WAYBILL_PENDING.includes(r.waybill_number)) return null;
  return {
    number: r.waybill_number, courier: r.waybill_courier,
    // Speedy and BOX NOW print only through their API with the shop's login: the admin fetches the PDF from our own route
    pdf: ['speedy', 'boxnow'].includes(r.waybill_courier) ? `/api/admin/waybills?pdf=${r.id}&shop=${r.shop_id}` : r.waybill_pdf, price: r.waybill_price == null ? null : Number(r.waybill_price),
    currency: r.waybill_currency, demo: Boolean(r.waybill_demo), status: r.waybill_status,
    parcels: r.waybill_parcels ? String(r.waybill_parcels).split(',') : [],
    createdAt: r.waybill_created_at ? new Date(r.waybill_created_at).toISOString() : null,
    atOfficeSince: r.status === 'shipped' && r.waybill_at_office_since ? new Date(r.waybill_at_office_since).toISOString() : null,
    atOfficeDay: r.status === 'shipped' && r.waybill_at_office_since ? officeDay(r.waybill_at_office_since) : null,
    trackUrl: r.waybill_courier === 'econt' ? econtTrack(r.waybill_number) : r.waybill_courier === 'speedy' ? speedyTrack(r.waybill_number) : null,
  };
}

export function toOrder(r) {
  return {
    id: r.id, createdAt: new Date(r.created_at).toISOString(), cbOrderId: r.cb_order_id, name: r.name,
    phone: r.phone, phoneNorm: r.phone_norm, email: r.email, deliveryType: r.delivery_type, courier: r.courier,
    officeId: r.office_id, officeText: r.office_text, city: r.city, postCode: r.post_code, addressText: r.address_text,
    items: typeof r.items === 'string' ? JSON.parse(r.items) : r.items, total: Number(r.total), currency: r.currency,
    paymentMethod: r.payment_method, status: r.status, isDuplicate: r.is_duplicate, shopId: r.shop_id,
    nkStatus: r.nk_status, nkCount: r.nk_count, nkReportIds: typeof r.nk_report_ids === 'string' ? JSON.parse(r.nk_report_ids) : (r.nk_report_ids || []),
    nkCheckedAt: r.nk_checked_at ? new Date(r.nk_checked_at).toISOString() : null,
    shipment: shipmentOf(r),
    confirmation: { sent: Boolean(r.confirm_token), answer: r.confirm_answer || '', answeredAt: r.confirm_answered_at ? new Date(r.confirm_answered_at).toISOString() : null },
    waybillState: waybillState(r), waybillAttempt: r.waybill_attempt || 0,
    cbCheck: r.cb_check ?? '',
    packedAt: r.packed_at ? new Date(r.packed_at).toISOString() : null,
    // days the courier has shown no change (on the way, not at the office) — the shop looks once it reaches 3
    quietDays: r.status === 'shipped' && LIVE_WAYBILL(r) && !r.waybill_at_office_since && (r.waybill_status_changed_at || r.waybill_created_at)
      ? officeDay(r.waybill_status_changed_at || r.waybill_created_at) - 1 : null,
  };
}

export async function insertOrder(q, o) {
  const rows = await q(
    `insert into zd.orders (cb_order_id, name, phone, phone_norm, email, delivery_type, courier, office_id, office_text,
       city, post_code, address_text, items, total, currency, payment_method, page_url, user_agent, ip, is_duplicate, traffic_source, shop_id, cb_check)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::text::jsonb, $14::text::numeric, $15, $16, $17, $18, $19, false, $20, $21::uuid, $22)
     on conflict (cb_order_id) do update set
       office_id = excluded.office_id, office_text = excluded.office_text, delivery_type = excluded.delivery_type, courier = excluded.courier,
       city = excluded.city, post_code = excluded.post_code, address_text = excluded.address_text,
       page_url = excluded.page_url, user_agent = excluded.user_agent, ip = excluded.ip, traffic_source = excluded.traffic_source
       where zd.orders.source = 'convertbuilder' and zd.orders.office_id = '' and zd.orders.shop_id = excluded.shop_id
         and zd.orders.created_at > now() - interval '2 days'
         and zd.orders.phone_norm = excluded.phone_norm -- the order number alone (public, sequential) never changes where an order goes
     returning id, (xmax::text = '0') as inserted`,
    [o.cbOrderId, o.name, o.phone, o.phoneNorm, o.email, o.deliveryType, o.courier, o.officeId, o.officeText,
      o.city, o.postCode, o.addressText, JSON.stringify(o.items), String(o.total), o.currency, o.paymentMethod,
      o.pageUrl, o.userAgent ?? '', o.ip ?? '', o.trafficSource ?? '', o.shopId || DEFAULT_SHOP, o.cbCheck ?? ''],
  );
  if (!rows.length) return { inserted: false, duplicate: false, id: null };
  // the ConvertBuilder copy came first: the widget only filled in its office details
  if (!rows[0].inserted) return { inserted: false, duplicate: false, id: rows[0].id };
  return { inserted: true, duplicate: await flagDuplicates(q, o.phoneNorm, rows[0].id, o.shopId || DEFAULT_SHOP), id: rows[0].id };
}

/**
 * An order a shop's own site sent (WooCommerce, a custom site) under its key: inserted, or updated by a re-send while it has no
 * waybill yet (locked afterwards). The number is `<domain>:<prefix>-<id>`, so it never meets another shop's orders.
 */
export async function upsertExternalOrder(q, o) {
  const rows = await q(
    `insert into zd.orders (cb_order_id, name, phone, phone_norm, email, delivery_type, courier, office_id, office_text,
       city, post_code, address_text, items, total, currency, payment_method, page_url, user_agent, ip, is_duplicate, shop_id, source, cb_check)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::text::jsonb, $14::text::numeric, $15, $16, '', '', '', false, $17::uuid, $18, '')
     on conflict (cb_order_id) do update set
       name = excluded.name, phone = excluded.phone, phone_norm = excluded.phone_norm, email = excluded.email,
       delivery_type = excluded.delivery_type, courier = excluded.courier, office_id = excluded.office_id, office_text = excluded.office_text,
       city = excluded.city, post_code = excluded.post_code, address_text = excluded.address_text,
       items = excluded.items, total = excluded.total, currency = excluded.currency, payment_method = excluded.payment_method
       where zd.orders.shop_id = excluded.shop_id and zd.orders.source = excluded.source and zd.orders.waybill_number = ''
         and zd.orders.status in ('new', 'confirmed')
     returning id, (xmax::text = '0') as inserted`,
    [o.cbOrderId, o.name, o.phone, o.phoneNorm, o.email, o.deliveryType, o.courier, o.officeId, o.officeText,
      o.city, o.postCode, o.addressText, JSON.stringify(o.items), String(o.total), o.currency, o.paymentMethod, o.shopId, o.source],
  );
  if (rows.length) {
    const { id, inserted } = rows[0];
    return { id, inserted, updated: !inserted, locked: false, duplicate: inserted ? await flagDuplicates(q, o.phoneNorm, id, o.shopId) : false };
  }
  const [cur] = await q(`select id from zd.orders where cb_order_id = $1 and shop_id = $2::uuid`, [o.cbOrderId, o.shopId]);
  return { id: cur?.id || null, inserted: false, updated: false, locked: Boolean(cur), duplicate: false };
}

/** Flags every order of this phone in this shop in the last 24 h when there are 2+; returns whether `newId` is one of them. */
async function flagDuplicates(q, phoneNorm, newId, shopId = DEFAULT_SHOP) {
  if (!phoneNorm) return false; // no valid phone → nothing to match
  const flagged = await q(
    `update zd.orders set is_duplicate = true
     where shop_id = $2::uuid and phone_norm = $1 and created_at > now() - interval '24 hours'
       and (select count(*) from zd.orders where shop_id = $2::uuid and phone_norm = $1 and created_at > now() - interval '24 hours') > 1
     returning id`,
    [phoneNorm, shopId],
  );
  return flagged.some((r) => r.id === newId);
}

/**
 * Order from ConvertBuilder's API/webhook (lib/convertbuilder.js mapOrder): inserts it, or refreshes items/total and fills an empty
 * name/email/phone. Office details written by the widget are kept. The status follows ConvertBuilder only when its status changed
 * since we last saw it (cb_status), so re-syncs never undo a status set in our admin. The first time ConvertBuilder reports an order
 * we already had (widget), its status is taken only while ours is still new/confirmed. Never automatic: out of returned, or from
 * delivered to anything but cancelled.
 */
const MOVE = `$19::text is not null and $19::text <> zd.orders.status and excluded.cb_status <> zd.orders.cb_status
  and (zd.orders.cb_status <> '' or zd.orders.status in ('new', 'confirmed'))
  and zd.orders.status <> 'returned' and (zd.orders.status <> 'delivered' or $19::text = 'cancelled')`;

export async function upsertCbOrder(q, o) {
  const rows = await q(
    `insert into zd.orders (cb_order_id, invoice_no, name, phone, phone_norm, email, delivery_type, courier, office_id, office_text,
       city, post_code, address_text, items, total, currency, payment_method, status, source, created_at, is_duplicate, cb_status, shop_id, cb_check)
     values ($1, $2, $3, $4, $5, $6, $7, $8, '', $9, $10, $11, $12, $13::text::jsonb, $14::text::numeric, $15, $16, $17, 'convertbuilder',
       coalesce($18::text::timestamptz, now()), false, $20, $21::uuid, 'ok')
     on conflict (cb_order_id) do update set
       invoice_no = excluded.invoice_no, items = excluded.items, total = excluded.total, currency = excluded.currency,
       name = case when zd.orders.name = '' then excluded.name else zd.orders.name end,
       email = case when zd.orders.email = '' then excluded.email else zd.orders.email end,
       phone = case when zd.orders.phone_norm = '' then excluded.phone else zd.orders.phone end,
       phone_norm = case when zd.orders.phone_norm = '' then excluded.phone_norm else zd.orders.phone_norm end,
       status = case when ${MOVE} then $19::text else zd.orders.status end,
       status_changed_at = case when ${MOVE} then now() else zd.orders.status_changed_at end,
       cb_status = excluded.cb_status -- a widget order kept aside is confirmed separately (confirmKeptAside), exactly once
     where zd.orders.shop_id = excluded.shop_id -- never another shop's order with the same number
     returning id, (xmax::text = '0') as inserted`,
    [o.cbOrderId, o.invoiceNo, o.name, o.phone, o.phoneNorm, o.email, o.deliveryType, o.courier, o.officeText, o.city, o.postCode,
      o.addressText, JSON.stringify(o.items), String(o.total), o.currency, o.paymentMethod, o.insertStatus, o.createdAt, o.updateStatus,
      o.cbStatus ?? '', o.shopId || DEFAULT_SHOP],
  );
  if (!rows.length) return { id: null, inserted: false, duplicate: false };
  const { id, inserted } = rows[0];
  return { id, inserted, duplicate: inserted ? await flagDuplicates(q, o.phoneNorm, id, o.shopId || DEFAULT_SHOP) : false };
}

export async function countRecentByIp(q, ip) {
  const rows = await q(`select count(*)::int as n from zd.orders where ip = $1 and created_at > now() - interval '10 minutes'`, [ip]);
  return rows[0].n;
}

export async function listOrders(q, { status = '', from = '', to = '', search = '', page = 1, pageSize = 50, shopId = null, shopIds = null, id = '' } = {}) {
  const where = [];
  const params = [];
  const arg = (v) => { params.push(v); return `$${params.length}`; };
  if (shopId) where.push(`shop_id = ${arg(shopId)}::uuid`);
  else if (shopIds) where.push(`shop_id = any(${arg(shopIds.map(String))}::uuid[])`); // a client's "all"; neither = every shop
  if (id) where.push(UUID.test(String(id)) ? `id = ${arg(String(id))}::uuid` : 'false'); // one order (the QR link); a bad id matches nothing
  if (STATUSES.includes(status)) where.push(`status = ${arg(status)}`);
  else if (status === 'at_office') where.push(AT_OFFICE);
  else if (status === 'to_pack') where.push(TO_PACK);
  else if (status === 'problems') where.push(PROBLEM);
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

/** Parcels waiting at the receiver's office, and how many reached the 4th day (the shop calls or writes). */
export async function atOfficeCounts(q, { shopId = null, shopIds = null } = {}) {
  const params = [];
  const scope = shopId ? (params.push(String(shopId)), ` and shop_id = $1::uuid`) : shopIds ? (params.push(shopIds.map(String)), ` and shop_id = any($1::uuid[])`) : '';
  const [r] = await q(`select count(*)::int as waiting, count(*) filter (where ${DUE})::int as due from zd.orders where ${AT_OFFICE}${scope}`, params);
  return { waiting: r.waiting, due: r.due };
}

/** How many orders wait to be packed. */
export async function toPackCount(q, { shopId = null, shopIds = null } = {}) {
  const params = [];
  const scope = shopId ? (params.push(String(shopId)), ` and shop_id = $1::uuid`) : shopIds ? (params.push(shopIds.map(String)), ` and shop_id = any($1::uuid[])`) : '';
  const [r] = await q(`select count(*)::int as n from zd.orders where ${TO_PACK}${scope}`, params);
  return r.n;
}

/** Shipped parcels that need a look (3+ days at the office or without movement). */
export async function problemCount(q, { shopId = null, shopIds = null } = {}) {
  const params = [];
  const scope = shopId ? (params.push(String(shopId)), ` and shop_id = $1::uuid`) : shopIds ? (params.push(shopIds.map(String)), ` and shop_id = any($1::uuid[])`) : '';
  const [r] = await q(`select count(*)::int as n from zd.orders where ${PROBLEM}${scope}`, params);
  return r.n;
}

/** Marks an order packed (the first time is kept) or not packed; returns the packed time, null when cleared, undefined when unknown. */
export async function setPacked(q, id, on) {
  if (!UUID.test(String(id))) return undefined;
  const [r] = await q(`update zd.orders set packed_at = case when $2 then coalesce(packed_at, now()) else null end where id = $1::uuid returning packed_at`, [id, Boolean(on)]);
  if (!r) return undefined;
  return r.packed_at ? new Date(r.packed_at).toISOString() : null;
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
    `select id, phone_norm from zd.orders where nk_status in ('pending', 'error') and phone_norm <> '' and cb_check <> 'pending' and created_at > now() - interval '30 days'
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
