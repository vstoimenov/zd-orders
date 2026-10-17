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
  ['НЕкоректен', (o) => (o.nkStatus === 'flagged' ? `${o.nkCount} сигнала` : o.nkStatus === 'clean' ? 'чист' : 'непроверен')],
];

export const cell = (v) => {
  const s = String(v ?? '');
  // Escape formula injection: if starts with =, +, -, @, tab, or CR and is not a plain phone/number
  const needsPrefix = /^[=+\-@\t\r]/.test(s) && !/^[+-]?[\d\s().-]+$/.test(s);
  const t = needsPrefix ? "'" + s : s;
  // Always apply quoting logic to the neutralized string
  return /[";\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
};

/** Semicolon-separated with a BOM: opens correctly in Excel with Bulgarian regional settings. */
export function ordersToCsv(orders) {
  const lines = [COLUMNS.map(([h]) => cell(h)).join(';'), ...orders.map((o) => COLUMNS.map(([, f]) => cell(f(o))).join(';'))];
  return `﻿${lines.join('\r\n')}`;
}

/** Customers export, same Excel-friendly format as orders. */
export function customersToCsv(rows) {
  const cols = [
    ['Име', (c) => c.name], ['Телефон', (c) => c.phoneNorm], ['Имейл', (c) => c.email], ['Поръчки', (c) => c.orders],
    ['Похарчено', (c) => c.spent.toFixed(2)], ['Валута', (c) => c.currency], ['Средна поръчка', (c) => c.avgOrder.toFixed(2)],
    ['Доставени', (c) => c.delivered], ['Върнати', (c) => c.returned],
    ['Първа поръчка', (c) => c.firstOrderAt.slice(0, 10)], ['Последна поръчка', (c) => c.lastOrderAt.slice(0, 10)], ['Сегменти', (c) => c.segments.join(', ')],
  ];
  return '﻿' + [cols.map((c) => c[0]).join(';'), ...rows.map((r) => cols.map((c) => cell(c[1](r))).join(';'))].join('\r\n') + '\r\n';
}
