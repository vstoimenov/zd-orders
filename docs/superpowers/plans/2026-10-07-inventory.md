# Наличности — план

Спец: docs/superpowers/specs/2026-10-07-inventory-design.md. TDD за всяка задача; `npm test` зелено след всяка.

1. Миграция 006 (`product_costs`: sku, stock, low_stock, tracked_since; `orders.stock_applied`; `stock_moves`) + `lib/stock.js`: `syncOrderStock(q, id, {removing})`, `syncStockSafe`, `saveProduct`, `adjustStock`, `listInventory`, `productHistory`. Тестове: test/stock.test.js (еднократно приспадане, сливане чекаут+CB, отказ/връщане/обратно, изтриване, tracked_since, главни букви, едновременни повиквания, корекции, история, карти).
2. Закачане: `api/orders.js`, `lib/cb-sync.js` (уебхук + синхронизация), `lib/admin/orders.js` (PATCH статус, DELETE). Тестове през реалните входни точки.
3. `lib/admin/inventory.js` + маршрут `inventory` в `api/admin/[route].js`. Тестове: test/inventory-api.test.js.
4. Страница „Наличности“ в админа (раздел „Отчети“, #inventory) + прозорци Продукт / Корекция / История. Проверка локално (компютър + телефон).
5. Миграция в Supabase (+ права за zd_app), деплой, проверка в production.
