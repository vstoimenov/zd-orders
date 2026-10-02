const COLUMNS = [
  ['Дата', (o) => new Date(o.createdAt).toLocaleString('sv-SE', { timeZone: 'Europe/Sofia' }).slice(0, 16)],
  ['Име', (o) => o.name],
  ['Телефон', (o) => o.phone],
  ['Имейл', (o) => o.email],
  ['Доставка', (o) => o.officeText],
  ['Град', (o) => o.city],
  ['Пощ. код', (o) => o.postCode],
  ['Артикули', (o) => o.items.map((it) => `${it.qty} × ${it.name}`).join('; ')],
  ['Сума', (o) => o.total.toFixed(2)],
  ['Валута', (o) => o.currency],
  ['Статус', (o) => o.status],
  ['Дубликат', (o) => (o.isDuplicate ? 'да' : '')],
  ['CB ID', (o) => o.cbOrderId],
];

const cell = (v) => {
  const s = String(v ?? '');
  // Escape formula injection: if starts with =, +, -, @, tab, or CR and is not a plain phone/number
  if (/^[=+\-@\t\r]/.test(s) && !/^[+-]?[\d\s().-]+$/.test(s)) {
    return `'${s}`;
  }
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Semicolon-separated with a BOM: opens correctly in Excel with Bulgarian regional settings. */
export function ordersToCsv(orders) {
  const lines = [COLUMNS.map(([h]) => cell(h)).join(';'), ...orders.map((o) => COLUMNS.map(([, f]) => cell(f(o))).join(';'))];
  return `﻿${lines.join('\r\n')}`;
}
