# Order tracking (step 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the buyer's order page with a timeline and fresh courier status; the shop's „Проблемни“ list, a refresh button and a tracking message.

**Architecture:** `lib/confirm.js` grows into the order page (`confirmPage` returns a `tracking` block); a per-parcel status
refresh shares the update with the night sync in `lib/waybills.js`; `lib/orders-repo.js` gets the `problems` filter and count;
the confirm admin route gets `action: 'track'`; `/p/:t` rewrites to the confirm page.

**Spec:** `docs/superpowers/specs/2026-10-22-order-tracking-design.md`

## Global Constraints
- Freshness `REFRESH_MINUTES = 30`, `REFRESH_BUDGET_MS = 5000`; problem threshold 3 Sofia days.
- Link forms: `${PUBLIC_BASE_URL}/confirm/?t=<token>` (unchanged) and `${PUBLIC_BASE_URL}/p/<token>` for tracking.
- No new Vercel functions; migration 023 applied by hand before deploy.
- Buyer page never exposes phone, email or street. Commit trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus
1. Courier slow/down while the buyer opens the page → the page still answers within ~5 s with the last state.
2. Test (demo) waybills and `creating`/`unknown` numbers are never refreshed.
3. A token of one shop never shows another shop's data; old `/confirm/?t=` links keep working.
4. Status text unchanged → `waybill_status_changed_at` unchanged (no false „movement“).
5. Address delivery shows no office step and no office block.

---

### Task 1: tracking data + fresh status (backend)
**Files:** `db/migrations/023_tracking.sql`; `lib/waybills.js` (shared `applyCourierStatus`, `refreshOrderStatus(q, orderId)`, status-changed time); `lib/confirm.js` (`confirmPage` → `tracking`, `trackingLink`); `lib/admin/confirm.js` (GET refreshes); `lib/admin/confirm-admin.js` (`action: 'track'`); tests `test/tracking.test.js`, `test/confirm.test.js`.
- [ ] RED → implement → GREEN; commit `feat(tracking): order page data, fresh courier status, tracking message`.

### Task 2: problems filter + refresh all
**Files:** `lib/orders-repo.js` (`PROBLEM`, `status=problems`, `problemCount`, row `quietDays`), `lib/admin/orders.js` (`problems` in list, POST `refresh_statuses`); tests `test/tracking.test.js`.
- [ ] RED → implement → GREEN; commit `feat(tracking): problem parcels and a refresh button for the shop`.

### Task 3: pages
**Files:** `public/confirm/index.html` (order page), `vercel.json` (`/p/:t`), `public/admin/index.html` (pill, refresh, row badges, „💬 Проследяване“).
- [ ] Browser check (phone width, local admin + demo data); commit `feat(tracking): buyer order page and admin controls`.

### Task 4: release
- [ ] Apply 023, suite green, deploy, open a real tracking link.
