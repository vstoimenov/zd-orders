// Orders that come without any integration: typed in the admin („+ Нова поръчка“) or imported from a CSV file.
// Both reuse the order checks (lib/order.js) and the keyed insert (upsertExternalOrder), so everything after works as usual.
import { saveInvoice } from './invoice.js';
import { createHash, randomBytes } from 'node:crypto';
import { validateOrder } from './order.js';
import { upsertExternalOrder } from './orders-repo.js';
import { normalizePhone } from './phone.js';
import { startOrder } from './cb-sync.js';
import { syncStockSafe } from './stock.js';

export const CSV_MAX_ROWS = 500;
export const CSV_MAX_BYTES = 1024 * 1024;
const LABEL = { econt: 'ЕКОНТ', speedy: 'СПИДИ', boxnow: 'BOX NOW' };
const OFFICE_TYPE = { econt: 'econt_office', speedy: 'speedy_office', boxnow: 'boxnow_locker' };
const ADDRESS_TYPES = ['econt_address', 'speedy_address'];
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

/** The text the widget writes for an office: „ЕКОНТ – офис Плевен Център (1127), ул. Левски 5“. */
function officeText(o) {
  const kind = o.is_automat && /автомат/i.test(o.name) ? '' : o.is_automat ? 'автомат ' : 'офис ';
  return `${LABEL[o.courier]} – ${kind}${o.name} (${o.code})${o.address ? `, ${o.address}` : ''}`;
}
async function officeById(q, id) {
  const [o] = await q(`select id, courier, code, name, city, post_code, address, is_automat from zd.offices where id = $1`, [String(id || '')]);
  return o || null;
}
/** „ЕКОНТ – офис Плевен Център (1127)“ → that courier's office with that code; a number in brackets alone is not an office. */
async function officeFromText(q, text) {
  const t = String(text || '');
  const courier = /еконт|econt/i.test(t) ? 'econt' : /спиди|speedy/i.test(t) ? 'speedy' : /box\s*now|бокс\s*нау/i.test(t) ? 'boxnow' : '';
  const code = (t.match(/\((\d{1,6})\)/) || [])[1];
  if (!courier || !code) return null;
  const [o] = await q(`select id, courier, code, name, city, post_code, address, is_automat from zd.offices where courier = $1 and code = $2`, [courier, code]);
  return o || null;
}

/** The order as the admin typed it → what the checks and the insert take. Throws Bulgarian messages. */
async function fromInput(q, input) {
  const name = clean(input.name), phone = clean(input.phone);
  if (!name) throw new Error('Липсва име');
  if (!phone) throw new Error('Липсва телефон');
  if (!normalizePhone(phone)) throw new Error('Телефонът не е валиден');
  const items = (Array.isArray(input.items) ? input.items : []).map((it) => ({ name: clean(it?.name), qty: Number(it?.qty) || 1, price: Number(it?.price) || 0 })).filter((it) => it.name);
  if (!items.length) throw new Error('Добавете поне един артикул');
  const total = parseAmount(input.total);
  if (total === null) throw new Error('Невалидна сума');
  if (!(total > 0)) throw new Error('Липсва сума за плащане');
  let deliveryType = clean(input.delivery_type) || 'other';
  let officeId = '', text = clean(input.office_text), city = clean(input.city), postCode = clean(input.post_code), addressText = clean(input.address_text);
  if (input.office_id) {
    const o = await officeById(q, input.office_id);
    if (!o) throw new Error('Няма такъв офис — изберете от списъка');
    deliveryType = OFFICE_TYPE[o.courier]; officeId = o.id; text = officeText(o); city = o.city; postCode = o.post_code || postCode;
  } else if (ADDRESS_TYPES.includes(deliveryType)) {
    if (!city || !addressText) throw new Error('Въведете град и адрес');
    text = `${deliveryType === 'econt_address' ? 'ЕКОНТ' : 'СПИДИ'} – адрес: ${addressText}`;
  } else if (!['econt_office', 'speedy_office', 'boxnow_locker'].includes(deliveryType)) {
    deliveryType = 'other';
    if (!text) text = addressText || 'Доставка';
  } else throw new Error('Изберете офис от списъка');
  return { name, phone, email: clean(input.email), delivery_type: deliveryType, office_id: officeId, office_text: text, city, post_code: postCode, address_text: addressText, items, total, currency: clean(input.currency) || 'EUR', payment_method: isPaid(input.payment_method) ? 'card' : 'cod', invoice: input.invoice };
}
/** „30,30 лв“, „€1 234.50“, 30.3 → 30.3; null when it is not an amount. */
function parseAmount(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v ?? '').replace(/[^\d.,]/g, '');
  if (!s) return null;
  const n = Number(s.includes(',') && !/\.\d{1,2}$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}
/** Cash on delivery unless the cell clearly says the order is paid („платена“, „card“, „да“ in a „Платено“ column …). */
function isPaid(v) {
  const t = clean(v).toLowerCase();
  if (!t || /\bне|наложен|при доставка|при получаване|\bcod\b|cash/.test(t)) return false;
  return /^(да|yes|платена|платено|paid|card|карта|с карта|банка|банков превод|bank|по банка|online|онлайн)$/.test(t) || /^(платена|платено|paid)\b/.test(t);
}

/** „+ Нова поръчка“: stock, nekorekten.com and the shop's phone as for any order; no automatic WhatsApp (the shop already spoke to the customer). */
export async function createManualOrder(q, { shopId, domain, currency = 'EUR', order, cartId = null }) {
  const body = await fromInput(q, { currency, ...(order || {}) });
  const v = validateOrder({ ...body, cb_order_id: `m-${randomBytes(8).toString('hex')}` });
  if (!v.ok) throw new Error(`Невалидна поръчка: ${v.error}`);
  const r = await upsertExternalOrder(q, { ...v.order, cbOrderId: `${domain}:${v.order.cbOrderId}`, shopId, source: 'manual' });
  await saveInvoice(q, r.id, v.order.invoice);
  // made from an abandoned cart („Направи поръчка“): the cart is recovered and points at this order — the first one only, same shop only
  if (cartId && /^[0-9a-f-]{36}$/i.test(String(cartId))) {
    await q(`update zd.abandoned_carts set recovered_at = coalesce(recovered_at, now()), order_id = $2::uuid where id = $1::uuid and shop_id = $3::uuid and order_id is null`, [cartId, r.id, shopId]);
  }
  await startOrder(q, { id: r.id, phoneNorm: v.order.phoneNorm }, '[manual]', { confirm: false });
  return { id: r.id };
}

/* ---- CSV ---- */
const HEADERS = {
  name: ['име', 'имена', 'клиент', 'получател', 'name', 'customer'],
  phone: ['телефон', 'тел', 'тел.', 'phone', 'gsm', 'мобилен'],
  email: ['имейл', 'email', 'e-mail', 'мейл'],
  city: ['град', 'населено място', 'city', 'town'],
  office: ['офис', 'доставка', 'адрес', 'офис/адрес', 'доставка до', 'office', 'address'],
  postCode: ['пощ. код', 'пощенски код', 'пк', 'zip', 'postcode', 'post code'],
  items: ['артикули', 'артикул', 'продукти', 'продукт', 'стоки', 'items', 'products'],
  total: ['сума', 'общо', 'стойност', 'сума за плащане', 'total', 'amount'],
  payment: ['плащане', 'начин на плащане', 'payment', 'платено'],
  company: ['фирма', 'firma', 'company', 'фирма (фактура)'],
  eik: ['еик', 'булстат', 'еик/булстат', 'eik', 'uic'],
  vat: ['ддс номер', 'ддс №', 'идентификационен номер по ддс', 'vat', 'vat number'],
  mol: ['мол', 'mol'],
  invoiceAddress: ['адрес по регистрация', 'адрес на фирмата', 'registration address'],
};
const key = (h) => clean(h).toLowerCase().replace(/^﻿/, '');

/** RFC 4180 fields: quotes, doubled quotes, delimiters and new lines inside quotes. */
function splitCsv(text, delimiter) {
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (quoted) throw new Error('Незатворени кавички в CSV файла — проверете клетка с „"“');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

/** Text or bytes (UTF-8 with/without BOM, else Windows-1251) → rows keyed by their header. */
export function parseCsv(input) {
  let text, encoding = 'utf-8';
  if (Buffer.isBuffer(input)) {
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(input); } catch { text = new TextDecoder('windows-1251').decode(input); encoding = 'windows-1251'; }
  } else text = String(input ?? '');
  text = text.replace(/^﻿/, '');
  const head = text.split(/\r?\n/)[0] || '';
  const delimiter = (head.match(/;/g) || []).length >= (head.match(/,/g) || []).length ? ';' : ',';
  const lines = splitCsv(text, delimiter);
  const headers = (lines.shift() || []).map((h) => clean(h));
  const cell = (v) => String(v ?? '').replace(/[ \t\r]+/g, ' ').replace(/ *\n */g, '\n').trim(); // new lines inside a quoted cell stay (one item per line)
  const rows = lines.map((cells) => Object.fromEntries(headers.map((h, i) => [h, cell(cells[i])])));
  return { headers, rows, delimiter, encoding };
}

/** Which column holds what, by header synonyms. */
function columns(headers) {
  const map = {};
  for (const h of headers) {
    const k = key(h);
    for (const [field, names] of Object.entries(HEADERS)) if (!map[field] && names.includes(k)) map[field] = h;
  }
  return map;
}

/** „Книга ×2; Стикери x1“ / „2 × Книга“ / one per line → items (prices unknown: 0). */
function parseItems(s) {
  return String(s || '').split(/[;\n]/).map((part) => {
    const t = clean(part);
    if (!t) return null;
    let m = t.match(/^(.*?)\s*[×xх\*]\s*(\d+)$/i); if (m) return { name: clean(m[1]), qty: Number(m[2]) };
    m = t.match(/^(\d+)\s*[×xх\*]\s*(.*)$/i); if (m) return { name: clean(m[2]), qty: Number(m[1]) };
    return { name: t, qty: 1 };
  }).filter((it) => it && it.name).map((it) => ({ ...it, price: 0 }));
}

async function rowToOrder(q, row, cols, currency) {
  const get = (f) => (cols[f] ? row[cols[f]] : '');
  const office = get('office');
  const o = await officeFromText(q, office);
  return fromInput(q, {
    name: get('name'), phone: get('phone'), email: get('email'), city: get('city'), post_code: get('postCode'), currency,
    office_id: o ? o.id : '', office_text: office, address_text: o ? '' : office, delivery_type: o ? OFFICE_TYPE[o.courier] : 'other',
    items: parseItems(get('items')), total: get('total'), payment_method: get('payment'),
    invoice: { company: get('company'), eik: get('eik'), vat: get('vat'), mol: get('mol'), address: get('invoiceAddress') },
  });
}

/** Every row checked, nothing written: what the import would do. */
export async function previewImport(q, { shopId, domain, currency = 'EUR', csv }) {
  const bytes = Buffer.isBuffer(csv) ? csv.length : Buffer.byteLength(String(csv ?? ''));
  if (bytes > CSV_MAX_BYTES) throw new Error('Файлът е над 1 MB — разделете го');
  const parsed = parseCsv(csv);
  if (parsed.rows.length > CSV_MAX_ROWS) throw new Error(`До ${CSV_MAX_ROWS} реда на файл — разделете го`);
  const cols = columns(parsed.headers);
  if (!cols.phone) throw new Error('Не намирам колона „Телефон“ — първият ред трябва да е заглавен (Име; Телефон; Артикули; Сума; …)');
  if (!cols.total) throw new Error('Не намирам колона „Сума“ (общо за плащане) — без нея наложеният платеж не може да се определи');
  const fileHash = createHash('sha256').update(Buffer.isBuffer(csv) ? csv : String(csv)).digest('hex').slice(0, 8);
  const rows = [];
  for (let i = 0; i < parsed.rows.length; i++) {
    try {
      const body = await rowToOrder(q, parsed.rows[i], cols, currency);
      const v = validateOrder({ ...body, cb_order_id: `c-${fileHash}-${i + 1}` });
      if (!v.ok) throw new Error(`Невалиден ред: ${v.error}`);
      rows.push({ row: i + 1, ok: true, order: { ...v.order, cbOrderId: `${domain}:${v.order.cbOrderId}` } });
    } catch (err) {
      rows.push({ row: i + 1, ok: false, error: err.message });
    }
  }
  return { rows, columns: cols, delimiter: parsed.delimiter, encoding: parsed.encoding, summary: { total: rows.length, ok: rows.filter((r) => r.ok).length, skipped: rows.filter((r) => !r.ok).length } };
}

/** Writes the good rows (the same file twice updates, never duplicates); stock is adjusted, the rest waits for the usual jobs. */
export async function importCsv(q, { shopId, domain, currency = 'EUR', csv }) {
  const p = await previewImport(q, { shopId, domain, currency, csv });
  const out = { inserted: 0, updated: 0, skipped: 0, errors: [] };
  for (const r of p.rows) {
    if (!r.ok) { out.skipped++; out.errors.push(`ред ${r.row}: ${r.error}`); continue; }
    const res = await upsertExternalOrder(q, { ...r.order, shopId, source: 'csv' });
    if (res.id && (res.inserted || res.updated)) await saveInvoice(q, res.id, r.order.invoice);
    if (res.inserted) out.inserted++; else if (res.updated) out.updated++; else { out.skipped++; out.errors.push(`ред ${r.row}: ${res.conflict ? 'номерът е зает от поръчка на друг източник' : 'поръчката вече е изпратена или затворена и не се променя'}`); continue; }
    await syncStockSafe(q, res.id);
  }
  return out;
}
