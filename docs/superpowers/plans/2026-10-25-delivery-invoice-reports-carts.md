# Delivery change, invoice, delivery reports, cart → order — Implementation Plan

> Executed inline (superpowers:executing-plans), TDD per task, one opus review at the end.

**Spec:** docs/superpowers/specs/2026-10-25-delivery-invoice-reports-carts-design.md

## Global Constraints
- Migration `db/migrations/027_delivery_invoice.sql`: orders `delivery_changed_at timestamptz`, `delivery_changed_by text not null default ''`,
  `invoice jsonb not null default '{}'`, `confirm_channel text not null default ''`; abandoned_carts `order_id uuid`.
- No new `api/` files (12-function limit). Bulgarian user texts. Release each task (commit + deploy) before the next.

## Review Focus
- A customer changing the office while the shop is creating the waybill (race): the change must not land on an order that got a waybill.
- An invoice with garbage ЕИК from a checkout must not lose the order.
- Reports on a period with zero finished parcels (no division by zero; highlights absent).
- Cart → order on a cart that was meanwhile recovered by a real order: no double order link.
- The order page for an order of a shop without BOX NOW must not offer lockers.

### Task 1: Delivery change (feature 3)
Files: `db/migrations/027_delivery_invoice.sql`, `lib/delivery-change.js`, `lib/confirm.js` (page payload + action), `lib/admin/confirm.js`,
`lib/admin/orders.js` (action 'delivery'), `lib/orders-repo.js` (toOrder: `deliveryChangedBy`), `public/confirm/index.html`, `public/admin/index.html`;
test `test/delivery-change.test.js`.
Tests: office change by customer (fields + push + changed_by), address change, refusals (waybill, shipped, fulfil_sent_at, unknown office, boxnow
not enabled for customer, boxnow address), atomic guard (`where waybill_number = ''`), admin action within scope, page payload flags.

### Task 2: Invoice details (feature 4)
Files: `lib/invoice.js`, `lib/order.js` (validateOrder passes `invoice`), `lib/orders-repo.js` (insert/upsert store, toOrder), `lib/external-orders.js`,
`lib/manual-orders.js` (+CSV headers), `lib/confirm.js` (action 'invoice'), `lib/csv.js` export, `public/checkout.js`, `public/confirm/index.html`,
`public/admin/index.html`; test `test/invoice.test.js`.

### Task 3: Delivery reports (feature 7)
Files: `lib/stats.js` (deliveryMix, highlights, confirmations), confirm channel set in `lib/confirm.js`, `lib/whatsapp.js`, `lib/voice-call.js`,
`lib/admin/orders.js`; `public/admin/index.html` dashboard cards; test `test/stats-delivery.test.js`.

### Task 4: Cart → order (feature 5)
Files: `lib/manual-orders.js` (`cartId` → recovered_at + order_id, guarded), `lib/admin/orders.js`, `lib/abandoned.js` (list returns orderId),
`public/admin/index.html`; test in `test/manual-orders.test.js`.
