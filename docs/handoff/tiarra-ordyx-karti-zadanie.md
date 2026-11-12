# Задача: изборът на доставка в чекаута на tiarracosmetics.com — картите на Ordyx (като в ConvertBuilder) + BOX NOW

Сега `components/cart/CourierPicker.tsx` е собствен избор (табове „До офис / До автомат / До адрес“ + падащи менюта).
Замени го с избора на Ordyx в режим „карти“: лого, срок и цена за всеки куриер, търсене на офис/автомат с „Намери ме“ и карта,
адрес с търсене на населено място. BOX NOW (вече включен за магазина в Ordyx) се появява сам. Не чупи поръчките и Ordyx sync.

## 1. Скриптът и изборът (клиент)
- Зареди веднъж: `<Script src="https://app.ordyx.eu/checkout.js" strategy="afterInteractive" />` (next/script).
- В нов клиентски компонент `OrdyxDelivery` (на мястото на `CourierPicker`):
  ```ts
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let handle: any, timer: any
    const start = () => {
      const P = (window as any).OrdyxPicker
      if (!P || !box.current) { timer = setTimeout(start, 200); return }
      handle = P.mount(box.current, {
        api: 'https://app.ordyx.eu', host: 'tiarracosmetics.com', cards: true,
        types: enabledTypes,          // само включените в настройките: econt_office, econt_address, speedy_office, speedy_address, boxnow_locker
        prices: priceTexts,           // { econt_office: '4,50 €', ... } или 'Безплатна' над прага
        onChange: (v) => onDelivery(v), // { type, officeId, officeText, city, postCode, addressText, error }
      })
    }
    start()
    return () => { clearTimeout(timer); handle?.destroy() }
  }, [])
  // при промяна на сумата (безплатна доставка): handle.setPrices({...})
  return <div ref={box} />
  ```
- `onChange` дава всичко за поръчката. Пази го в state на `CheckoutForm` и го изпращай при „Поръчай“:
  `courier` = първата дума на `type` (`econt` / `speedy` / `boxnow`); `deliveryType` = `address` за `*_address`, иначе `office`
  (за `boxnow_locker` — `automat`); `officeId` = `v.officeId`; `city`, `postCode`; адрес = `v.addressText`.
- `v.error` не е празно → изборът не е довършен: покажи текста и не изпращай поръчката.
- Махни `CourierPicker.tsx`, `/api/shipping/offices` и `lib/office-token.ts`, когато новото работи.

## 2. Сървърът
- `app/api/orders/route.ts` и `/api/orders/quote`: `courier` приема и `boxnow` (`z.enum(['econt','speedy','boxnow'])`);
  `boxnow` е само с `deliveryType = 'automat'`.
- Проверката на офиса вместо подписан token: вземи списъка от Ordyx (`lib/ordyx-offices.ts`, за `boxnow` с
  `&host=tiarracosmetics.com`) и потърси `officeId`. Няма го → 400 „Избраният офис не е намерен — изберете отново.“
  Адресът за поръчката = `${office.city}, ${office.name}, ${office.address} [${office.code}]`; `deliveryType = office.isAutomat ? 'automat' : 'office'`.
- `lib/ordyx-sync.ts`: за `boxnow` → `delivery_type: "boxnow_locker"`, `office_id: "boxnow:<код>"` (точно `officeId`),
  `office_text: "BOX NOW – автомат <име>, <адрес>"`; Еконт/Спиди както досега.

## 3. База (миграция в `supabase/migrations/`)
- `store.orders.courier` check → `('econt','speedy','boxnow')`.
- `store.commerce_settings`: `boxnow_enabled boolean not null default false`, `boxnow_price numeric(10,2) not null default 2.99 check (boxnow_price >= 0)`;
  check-а „поне един куриер“ да включва BOX NOW.
- Функциите за поръчка (последните версии, вкл. `20261109170000_promo_brands.sql`): `p_courier` приема `boxnow`; цена = `boxnow_price`
  (безплатна над прага); `COURIER_DISABLED`, ако е изключен.
- `lib/commerce-settings-schema.ts`, `lib/commerce-settings.ts`, `courierPrice()`, админ настройките (`SettingsAdmin`, `/api/admin/settings`):
  `boxnowEnabled`, `boxnowPrice`. Показвай „BOX NOW“ като име на куриер в поръчките, имейлите и благодарността.

## Проверка
- Чекаутът: карти с лога за всеки включен куриер (вкл. BOX NOW); избор на офис, автомат и адрес; цените и „Безплатна“ над прага.
- Поръчка до офис Еконт, до адрес Спиди и до автомат BOX NOW → в Ordyx всяка е с правилния начин на доставка и офис/автомат.
- `pnpm lint`, `pnpm test`, `pnpm build`. Миграцията — в Supabase преди деплоя.
