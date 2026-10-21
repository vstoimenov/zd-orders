# Финансов калкулатор: ДДС, данък печалба, счетоводна печалба — design

Date: 2026-10-21. Owner's priority #2 ("Финансов калкулатор: ДДС, данък печалба, счетоводна печалба"). Context: the owner sells
as a private person today (no VAT registration); clients are a mix of VAT-registered companies and small shops below the
threshold. Everything here is **orientation for planning, not accounting** — the UI says so.

## What the shop gets
1. **Tax settings per shop** (Финанси → „Данъци“): registered for VAT (yes/no), VAT rate (default 20%), "my costs include
   deductible VAT" (yes/no, default yes), profit-tax rate (default 10%; hint: 10% for a company, 15% for a sole trader/ЕТ).
   Saved with the existing „Запази разходите“ button (same settings object, same `costs:<shop>` key).
2. **Dashboard cards** next to the existing profit cards, for the selected period:
   - registered: „ДДС за внасяне“ (VAT in sales − deductible VAT in costs) and „Счетоводна печалба“ (profit without VAT);
   - always: „Данък печалба“ (rate × accounting profit, 0 when there is a loss) and „Чиста печалба“ (after VAT and profit tax);
   - not registered (single shop): „Оборот <year>“ with the registration threshold **51 130 € per calendar year** (ЗДДС 2026),
     amber when the shop is at 80% of it or above.
   Every card hint carries „ориентировъчно“.

## Formulas (EUR, registered shops; non-registered → VAT figures are 0)
- `vatOnSales = itemsRevenue × rate / (100 + rate)` — prices in the shop are gross (incl. VAT).
- `vatOnCosts = (productCost + packaging + codFee + freeShipping + returns + expenses) × rate / (100 + rate)` when costs
  include VAT, else 0. Ad spend is excluded: Meta invoices from Ireland are reverse-charged (VAT neutral).
- `vatDue = vatOnSales − vatOnCosts` (negative = VAT to be refunded).
- `netRevenue = itemsRevenue − vatOnSales`.
- `accountingProfit = profit − vatDue` (the existing profit is gross-vs-gross; removing the VAT balance gives net-vs-net).
- `profitTax = accountingProfit > 0 ? accountingProfit × profitTaxPct / 100 : 0`.
- `netProfit = accountingProfit − profitTax`.
- `yearRevenue` = Σ `total` of EUR orders of the shop since 1 January (Sofia), not cancelled/returned — independent of the period.
- „All shops“: each shop with its own settings, then summed (same as today); `vatRegistered` is `null` there, so the threshold
  card is not shown (the threshold is per legal entity, which the platform cannot know).

## Data / API
- `zd.settings` `costs:<shop>` gains `vatRegistered` (0/1), `vatRate` (20), `costsWithVat` (0/1), `profitTaxPct` (10).
  No migration (jsonb). `GET/PUT /api/admin/costs` carry them in `settings`.
- `GET /api/admin/stats` → `profit` gains `vatRegistered`, `profitTaxPct`, `vatOnSales`, `vatOnCosts`, `vatDue`,
  `netRevenue`, `accountingProfit`, `profitTax`, `netProfit`, `yearRevenue`, `vatThreshold` (51130).

## Decisions (mine — owner can overrule)
- One VAT rate per shop (books in Bulgaria are 9% — a shop selling only books sets 9).
- Deductible VAT on costs is all-or-nothing per shop; mixed cases are approximated.
- Profit tax is a plain percentage; social security contributions, dividend tax and advance payments are out of scope.
- Threshold check uses EUR order totals (incl. shipping charged), which is close to „облагаем оборот“ for a shop.

## Non-goals
Filing, VAT returns, invoices, multi-rate baskets, non-EUR shops (listed, not summed — as today).

## Anti-goals
- Never present the numbers as the tax owed: every card says „ориентировъчно“, the settings panel says it does not replace an
  accountant.
- Existing figures (print, margin, break-even) must not change for shops that never touch the new settings.
