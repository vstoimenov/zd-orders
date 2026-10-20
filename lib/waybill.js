const COURIER = { econt: 'Еконт', speedy: 'Спиди', boxnow: 'BOX NOW', other: 'по избор на магазина' };
const KIND = { econt_office: 'до офис', speedy_office: 'до офис', speedy_address: 'до адрес', boxnow_locker: 'до автомат', other: 'доставка' };

/** Text to paste when filling a waybill at the courier's counter or site. */
export function waybillText(o) {
  return [
    `Получател: ${o.name}`,
    `Телефон: ${o.phone}`,
    `Куриер: ${COURIER[o.courier]} – ${KIND[o.deliveryType]}`,
    `Доставка: ${o.officeText}`,
    o.city ? `Град: ${o.city}${o.postCode ? ` (${o.postCode})` : ''}` : '',
    `Наложен платеж: ${o.total.toFixed(2)} ${o.currency}`,
    `Съдържание: ${o.items.map((it) => `${it.qty} × ${it.name}`).join('; ')}`,
  ].filter(Boolean).join('\n');
}
