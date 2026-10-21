# Packing + QR — design

Date: 2026-10-21. Owner's priority #1. Their day: an order comes in → the waybill is printed → it goes on the courier envelope. One
person, phone or computer. Mistakes to prevent: the wrong product in the parcel, a parcel never packed, a parcel packed twice.

## What the shop gets
1. **„За пакетиране“ pill** in Поръчки: orders that still have to be packed (new/confirmed, not cancelled, not kept aside, not yet
   packed), with a count. Each row has **„📦 Пакетирана“** → the order remembers when (packed_at) and shows „✓ пакетирана 20.10 14:05“.
   Un-packing is one tap too (mistakes happen). Packed orders stay in the list until shipped (status unchanged by packing).
2. **Packing slip** („Лист за пакетиране“): a print page for one order or for all orders to pack at once (one page per order):
   shop name, order number and date, recipient (name, phone), delivery (courier + office/address text), the items with quantity and
   a checkbox each, total and payment (COD or paid), waybill number if there is one, and a **QR code**.
3. **The QR code** opens the order in Ordyx on the phone (`https://app.ordyx.eu/admin/?order=<id>`): the admin scrolls to that order,
   highlights it and shows a big „Пакетирана“ button. Scanning works with the phone's own camera — no app, no library on the phone.
   The slip goes inside the parcel or on the envelope next to the waybill; later anyone can scan it to see which order it was.

## Data
- `zd.orders.packed_at timestamptz` (null = not packed). Migration 021.
- Orders API: `packedAt` in the order view; `POST orders {action:'packed', id, on:true|false}`; filter `status=to_pack`;
  counts `toPack` next to the at-office counts.
- Slip: `GET /api/admin/orders?slip=<id>` and `?slip=all` (every order to pack of the shop, newest first, max 200) → HTML page
  (admin login required, scoped to the admin's shops like everything else).
- QR as inline SVG made on the server by the `qrcode` npm package (no third-party image service, nothing leaves our domain).

## Decisions (mine — owner can overrule)
- Packing does not change the order status; shipping still happens when the waybill is created (or by hand).
- „За пакетиране“ excludes orders kept aside (`cb_check='pending'`) and cancelled ones; a packed order leaves the list once shipped.
- The QR holds only the admin link with the order id (no personal data in the code).
- Slip paper: A4 with the slip in the top half (fits an envelope when folded); print CSS hides everything else.
- Items are listed as in the order (name × qty); no barcodes per product (no SKUs in orders today).

## Non-goals
Camera scanning inside the admin, per-product barcodes, printing the courier label together with the slip, packing stations/users.

## Anti-goals
- The slip must never show the admin password/secrets or another shop's data; the `?order=` link only works for someone logged in.
