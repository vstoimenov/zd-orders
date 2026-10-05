# Табло в админа (част 1 от 4: от поръчките)

Дата: 2026-10-05 · Статус: одобрен · Следват: 2) себестойност и печалба, 3) посещения и CR, 4) Meta реклами.

## Цел
Раздел „Табло“ в `/admin/` до „Поръчки“ с показатели от `zd.orders`, без външни услуги и без нови лични данни.

## Филтри
- Период: днес / вчера / 7 дни (по подразбиране) / 30 дни / този месец / по избор (от–до), дати по Europe/Sofia.
- Магазин: всички или един домейн (`split_part(cb_order_id, ':', 1)`), за да се изключи тестовият сайт.

## API
`GET /api/admin/stats?from=YYYY-MM-DD&to=YYYY-MM-DD&store=<host>` (админ бисквитка) →
```
{ period: {from, to}, stores: [host…],
  cards: { orders, revenue: [{currency, amount}], delivered: [{currency, amount}], aov: [{currency, amount}],
           returnRate: 0..1|null, nkFlagged, nkFlaggedPct: 0..1|null },
  daily: [{day, orders, revenue}], byDelivery: [{deliveryType, orders, revenue}], byStatus: [{status, orders}],
  topProducts: [{name, qty, revenue}], recent: [{id, createdAt, name, total, currency, status, officeText}] }
```
- Оборот = сума на всички поръчки без `cancelled`; групиран по валута (тестовият сайт е в USD).
- Реален приход = само `delivered`.
- AOV = оборот / поръчки без отказаните (по валута).
- % върнати = returned / (shipped + delivered + returned); `null` без изпратени.
- НЕкоректен = брой `nk_status = 'flagged'` и дял от всички поръчки.
- Топ 10 продукта от `items` (име, бройки, сума на редовете), без отказаните.
- Последни 10 поръчки.

## UI
Табове „Поръчки | Табло“; карти; стълбовидна графика по дни (CSS, без библиотека); таблици за доставка, статус, топ продукти, последни поръчки. Всички стойности през `esc()`.

## Тестове
PGlite: агрегати по валута, отказани изключени, % върнати, топ продукти от items, филтър по магазин и период; API: изисква админ бисквитка.
