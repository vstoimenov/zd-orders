# Себестойност и печалба (част 2 от 4 на таблото)

Дата: 2026-10-05 · Статус: одобрен (решения на собственика: доставката до 20 € я плаща клиентът, над 20 € — магазинът; „други разходи“ = еднократни записи с дата).

## Данни (миграция 003)
- `zd.product_costs(name pk, unit_cost numeric, updated_at)` — себестойност за брой по име на артикул (имената идват от `orders.items`).
- `zd.settings(key pk, value jsonb)` — `costs`: `{ packaging, codFeePct, freeShippingEcont, freeShippingSpeedy, returnCost }` (EUR).
- `zd.expenses(id uuid pk, spent_on date, name, amount numeric, created_at)`.

## Формула за период (само поръчки в EUR — разходите са в евро; без отказаните)
- Приход от артикули = Σ цени на редовете за поръчки без `cancelled`/`returned` (доставката, платена от клиента, е транзитна).
- Себестойност = Σ бройки × себестойност (същите поръчки).
- Опаковки = опаковка × брой поръчки без `cancelled`.
- Такса НП = % × Σ сума за поръчки без `cancelled`/`returned`.
- Безплатна доставка = за поръчки без `cancelled`, при които сума − артикули < 0,01 → цена по куриер (Еконт/Спиди).
- Връщания = цена на връщане × брой `returned`.
- Други разходи = Σ `expenses` с дата в периода.
- Печалба преди ДДС = приход от артикули − всичко горе; марж = печалба / приход от артикули.

## API (админ бисквитка)
- `GET /api/admin/costs` → `{ products: [{name, unitCost, soldQty}], settings, expenses: [...] }`
- `PUT /api/admin/costs` `{ products: [{name, unitCost}], settings }`
- `POST /api/admin/expenses` `{ spentOn, name, amount }` · `DELETE /api/admin/expenses` `{ id }`
- `GET /api/admin/stats` добавя `profit: { currency: 'EUR', itemsRevenue, productCost, packaging, codFee, freeShipping, returns, expenses, otherCosts, profit, margin }`.

## UI
Таб „Разходи“: таблица продукти (име, продадени, себестойност), полета за разходите на поръчка, „Запази“; списък „Други разходи“ с форма за добавяне и бутон за изтриване. В „Табло“: карти „Разход за продукти“, „Други разходи“, „Печалба преди ДДС“, „Марж“.
