# Financial calculator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** VAT, profit tax and accounting profit per shop on the dashboard, driven by four new per-shop settings.

**Architecture:** the settings live in the existing `costs:<shop>` jsonb (`lib/costs.js` DEFAULTS); `getProfit` derives the tax
figures from the numbers it already computes plus one year-to-date revenue query; the admin shows a settings panel in Финанси
and extra cards in `profitCards`.

**Tech Stack:** Node 22 ESM, Postgres (`zd`), node:test + PGlite, vanilla admin HTML.

**Spec:** `docs/superpowers/specs/2026-10-21-financial-calculator-design.md`

## Global Constraints
- Defaults: `vatRegistered: 0`, `vatRate: 20`, `costsWithVat: 1`, `profitTaxPct: 10`; `VAT_THRESHOLD = 51130` (EUR, calendar year).
- No migration, no new Vercel functions (10/12 used).
- A shop that never saves the new settings gets exactly today's `profit`, `margin`, `profitBeforeAds` (regression tests stay green with the new keys added).
- Bulgarian UI, „ориентировъчно“ on every tax card; English code/commits, trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus
1. A loss period: `profitTax` is 0 and `netProfit = accountingProfit` (no negative tax).
2. `vatRate: 0` or `costsWithVat: 0` never divides by zero / produces NaN; non-registered shops have all VAT figures 0.
3. „All shops“ sums the new fields and returns `vatRegistered: null`; the threshold card is hidden there.
4. `yearRevenue` counts the calendar year in Sofia time, excludes cancelled/returned and non-EUR orders, and does not depend on the period.
5. Saving settings merges with the stored known keys (unsent keys keep their value; unknown keys are dropped, as today) and rejects `vatRate` outside 0–100.

---

### Task 1: settings + formulas (backend)
**Files:** modify `lib/costs.js` (DEFAULTS, `saveCosts` validation for the percent fields, `getProfit`, `PROFIT_SUMS`, `getProfitAll`), tests `test/costs.test.js`.
- [ ] Tests: defaults appear in `getCosts().settings`; `saveCosts` rejects `vatRate: 120`; registered shop (20%, costs with VAT) on the existing profit fixture → `vatOnSales 6.45`, `vatOnCosts 5.64`, `vatDue 0.81`, `netRevenue 32.25`, `accountingProfit 4.06`, `profitTax 0.41`, `netProfit 3.65`; non-registered → zeros, `profitTax 0.49`, `netProfit 4.38`; loss → `profitTax 0`; `yearRevenue` ignores cancelled/returned/USD and last year's orders; `getProfitAll` sums and has `vatRegistered: null`.
- [ ] RED → implement → GREEN; commit `feat(finance): VAT, profit tax and accounting profit per shop`.

### Task 2: admin UI
**Files:** `public/admin/index.html` (Финанси panel „Данъци (ориентировъчно)“ with `cVat`, `cVatRate`, `cCostsVat`, `cTaxPct`; `cSave` sends them; `profitCards` adds the cards per spec).
- [ ] Check: script parses; local admin: settings round-trip, cards appear/disappear with the switch, threshold card only for a single non-registered shop.
- [ ] Commit `feat(finance): tax settings and cards in the admin`.

### Task 3: release
- [ ] Full suite green, deploy, open Финанси and Табло on app.ordyx.eu.
