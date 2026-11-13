# Задача: наличностите на tiarracosmetics.com да отиват в Ordyx

Ordyx вече приема наличности със същия ключ, с който tiarra праща поръчките (`ORDYX_API_KEY`):
`POST https://app.ordyx.eu/api/orders` с тяло `{ "type": "stock", "source": "api", "items": [{ "name", "sku", "stock" }] }`.
Ordyx записва числото точно както е, търси първо по `sku`, после по `name` (без значение главни/малки), добавя продукт, който няма,
и спира сам да намалява наличността на този продукт с поръчките (сайтът вече го е направил). До 2000 продукта на заявка.
Отговор: `{ ok, updated, created, unchanged, skipped, unknown }`.

Имената трябва да са същите като в поръчките, които `lib/ordyx-sync.ts` праща:
вариант → `${product.title} — ${variant.name}`, продукт без варианти → `product.title`.

## 1. `lib/ordyx-stock.ts` (нов)
```ts
import { sql } from '@/lib/db'

type Row = { name: string; sku: string; stock: number }

/** Всички следени наличности (stock не е null) с имената, с които поръчките влизат в Ordyx. */
export async function stockRows(): Promise<Row[]> {
  return sql<Row[]>`
    select p.title || ' — ' || v.name as name, v.sku, v.stock
      from store.variants v join store.products p on p.id = v.product_id
     where v.stock is not null
    union all
    select p.title as name, '' as sku, p.stock
      from store.products p
     where p.stock is not null and not exists (select 1 from store.variants v where v.product_id = p.id)`
}

/** Праща всички наличности в Ordyx. Никога не хвърля: една пропусната се наваксва от следващата и от нощния cron. */
export async function pushStockToOrdyx(): Promise<boolean> {
  const key = process.env.ORDYX_API_KEY
  if (!key) return false
  try {
    const items = await stockRows()
    for (let i = 0; i < items.length; i += 2000) {
      const res = await fetch('https://app.ordyx.eu/api/orders', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Ordyx-Site': JSON.stringify({ mode: 'checkout', version: 'tiarra-1' }) },
        body: JSON.stringify({ type: 'stock', source: 'api', items: items.slice(i, i + 2000) }),
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) { console.error('Ordyx stock push failed', res.status); return false }
    }
    return true
  } catch (error) {
    console.error('Ordyx stock push failed', error)
    return false
  }
}
```

## 2. Кога се праща (винаги след отговора, с `after()` от `next/server`, за да не чака никой)
- `app/api/orders/route.ts`: в същия `after(async () => { ... })`, след `syncOrder(orderNumber)` → `await pushStockToOrdyx()`.
- `app/api/admin/orders/[orderNumber]/status/route.ts`: когато `result.stock_released` → `after(() => pushStockToOrdyx())`.
- `app/api/admin/inventory/route.ts` (PATCH): след успешния `update_inventory` → `after(() => pushStockToOrdyx())`.
- `app/api/admin/products/route.ts` (създаване и редакция на продукт): след успешния запис → `after(() => pushStockToOrdyx())`.
- `app/api/cron/ordyx/route.ts` (веднъж на ден): накрая `const stock = await pushStockToOrdyx()` и `stock` в отговора.

## 3. Тестове (`tests/unit`)
- `stockRows`: вариант → „Заглавие — Вариант“ със своето `sku`; продукт без варианти → заглавието; `stock = null` не се праща;
  продукт с варианти не се праща като отделен ред.
- `pushStockToOrdyx`: без `ORDYX_API_KEY` → `false` без заявка; тялото е `{type:'stock', source:'api', items}` с ключа в `Authorization`;
  отговор 500 или изтекло време → `false`, без да хвърля.

## Проверка
- `pnpm lint`, `pnpm test`, `pnpm build`.
- След деплоя: смени наличност в админа на tiarra → в Ordyx → Наличности (магазин tiarra) продуктът показва същото число и
  „от сайта · <час>“. Нова поръчка → числото в Ordyx следва сайта, без да се вади втори път.
