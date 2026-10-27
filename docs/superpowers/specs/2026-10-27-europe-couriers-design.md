# Europe: local couriers and cash on delivery in 24 countries — design and roadmap

**Date:** 2026-10-27 · **Status:** announced as „скоро“; the real integration is on the roadmap.

## Why

Sellers on Ordyx want to sell beyond Bulgaria with the same model that works for them at home: cash on delivery, and the
customer picks a local courier, office or locker at checkout. The owner's decision (27.10): promise it now, because it will
come, and add it to the platform for real, country by country.

## What is live now (27.10)

- **One list:** `public/couriers-eu.js` (`window.ORDYX_EU`) — 24 countries in 4 regions, each with its COD currency and its
  couriers. A courier in a country's `live` works today: only Еконт, Спиди and BOX NOW in Bulgaria. Everything else is
  „скоро“. The landing and the admin both read this list, so moving a courier into `live` updates both.
- **Landing** (`ordyx.eu/#europe`): „Идва скоро“ section. You pick a country and see its couriers marked „работи“ or „скоро“,
  plus the COD currency. The „Не е за теб“ list and an FAQ entry („Мога ли да пращам в чужбина?“) say the same thing.
- **Admin** (Интеграции → Куриери): a country picker. Bulgaria shows the working cards (Еконт, Спиди, BOX NOW, срок за
  доставка) plus „скоро“ cards. Any other country shows a line „наложен платеж в … и местните куриери идват скоро“ and
  „скоро“ cards from the list.
- **Copy rules:** in our own words. We use no other company's name or figures (shipment counts, warehouses), and we name no
  fulfilment company. This follows [Ordyx без имена на конкуренти].

## Non-goals of this step

- No real courier integration outside Bulgaria yet. Nothing on the landing claims more than that.
- The per-country courier lists are a **draft**. Before a courier is switched to `live`, check that it offers COD in that
  country and has an API we can use.

## Roadmap for the real integration

### 1. Foundation (needed by every country)

- **Shop countries:** which countries a shop sells to; the default country is Bulgaria.
- **Orders:**
  - `country` and the COD currency on each order.
  - The amount the customer pays is in the local currency.
  - Reports convert to the shop's currency (ECB daily rate, stored with the order).
- **Delivery model:** today's `delivery_type` values (`econt_office`, `boxnow_locker`, …) become courier + kind
  (office / locker / address) for any courier. Existing values map one to one.
- **Offices and lockers:** the nightly list per courier and country. It uses the same table and the same search as
  Еконт/Спиди/BOX NOW today.
- **Checkout widget:**
  - It takes the country from the checkout's country field, or from the shop default.
  - It offers only the couriers the shop enabled for that country.
  - Its texts are in that country's language (RO / EL / …).
- **Waybills, tracking, returns:** a per-courier adapter behind the same interface as `econt` / `speedy` / `boxnow` today.
  Statuses map into the same set: shipped, delivered, returned.
- **COD settlement:** what each courier owes the shop, per currency, in Финанси.
- **Stats:** the delivery mix per country, extending the 24.10 task in the dashboard.
- **Legal:** the privacy policy names couriers abroad as recipients of the order data.

### 2. Through a fulfilment warehouse (the fastest wide coverage)

A shop whose stock sits in a warehouse that already ships with many couriers works through the fulfilment integration that is
live since 23.10. Ordyx passes the country, the chosen courier and the office or locker; the warehouse ships and reports back.
A dedicated adapter for a specific warehouse is built on request.

### 3. Direct couriers, country by country

The proposed order puts the closest markets for Bulgarian sellers first:

1. **Румъния** — Fan Courier, Cargus, Sameday (Packeta, GLS later).
2. **Гърция, Кипър** — ACS, BOX NOW (GR/CY, the same API as BG), ELTA Courier, Geniki Taxydromiki.
3. **България, rest** — Sameday, Pigeon Express.
4. **Унгария, Чехия, Словакия, Полша** — Packeta (covers all four), GLS, InPost, PPL, Express One, Slovak Parcel Service.
5. **Сърбия** — D Express, BEX, City Express.
6. **Запад и юг** — GLS, DHL, Hermes, CTT, InPost (IT/ES).
7. **Other Balkans, Baltics, Malta** — local couriers still to be chosen (today only DHL/FedEx are listed).

**Per courier, before it goes live:**

- API access and a test account.
- Office and locker sync.
- Checkout option.
- Waybill: create, cancel, PDF.
- Tracking.
- COD and its report.
- Then move it into `live` in `couriers-eu.js` and announce it to the shops.

## Open questions for the owner

- Pricing for selling abroad: the same plan, or an add-on per country.
- Which country first, if a specific client needs one sooner than the order above.
- Whether to go through a warehouse partner first (phase 2) or start with direct couriers (phase 3).
