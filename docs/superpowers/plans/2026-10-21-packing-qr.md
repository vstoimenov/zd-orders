# Packing + QR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a „За пакетиране“ list with a „Пакетирана“ mark, and a printable packing slip with a QR code that opens the order on the phone.

**Architecture:** `packed_at` on `zd.orders`; the orders admin route gains a `packed` action, a `to_pack` filter and a `slip` HTML view;
the QR is an inline SVG from the `qrcode` package; the admin page handles `?order=<id>` deep links.

**Tech Stack:** Node 22 ESM, Postgres, node:test + PGlite, vanilla admin HTML, `qrcode` npm (server only).

**Spec:** `docs/superpowers/specs/2026-10-21-packing-qr-design.md`

## Global Constraints
- Migration `021_packing.sql`: `alter table zd.orders add column if not exists packed_at timestamptz;` applied by hand before deploy.
- No new Vercel functions (10/12): everything goes through `api/admin/[route].js` → `lib/admin/orders.js`.
- Deep link: `https://app.ordyx.eu/admin/?order=<uuid>`; the QR encodes exactly that URL (PUBLIC_BASE_URL is kurier…; the admin lives on app.ordyx.eu → use `ADMIN_BASE_URL` env with fallback `https://app.ordyx.eu`).
- Bulgarian UI; English code/commits with trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus
1. A client admin can only mark/print orders of their own shops (scope like every other order action).
2. The slip HTML escapes every order field (names, items, office text come from customers).
3. `slip=all` with zero orders → a friendly page, not an error; with 200+ → capped, says so.
4. `?order=` with a foreign/unknown id → the admin shows „Няма такава поръчка“ and nothing else breaks.
5. Un-packing clears `packed_at`; packing twice keeps the first time.

---

### Task 1: packed_at + list + action + counts (backend)
**Files:** Create `db/migrations/021_packing.sql`; modify `lib/orders-repo.js` (toOrder `packedAt`, `to_pack` filter, `toPackCount`, `setPacked`), `lib/admin/orders.js` (action `packed`, `toPack` in the list response); tests `test/packing.test.js`.
- [ ] Tests: `listOrders({status:'to_pack'})` = new/confirmed, not packed, not pending, not cancelled; `setPacked(q,id,true)` sets a time (second call keeps it), `false` clears; admin POST `{action:'packed', id, on:true}` → 200 and `packedAt` in the next list; list response has `toPack: N`; a client of another shop gets 400 for a foreign id.
- [ ] RED → implement → GREEN; commit `feat(packing): mark orders as packed`.

### Task 2: packing slip with QR
**Files:** `package.json` (+ `qrcode`), create `lib/packing-slip.js` (`slipHtml(shop, orders, {adminBase})`), modify `lib/admin/orders.js` (`GET ?slip=<id>|all`), tests `test/packing.test.js`.
- [ ] Tests: `slipHtml` contains the escaped recipient, each item `name × qty`, COD total, the office text, an `<svg` QR and the link `https://app.ordyx.eu/admin/?order=<id>`; `<script>` in a customer name is escaped; GET `?slip=<id>` → 200 text/html, needs login, foreign shop → 400; `?slip=all` → one `<section class="slip">` per order to pack, zero → „Няма поръчки за пакетиране“.
- [ ] RED → implement → GREEN; commit `feat(packing): packing slip with QR code`.

### Task 3: admin UI
**Files:** `public/admin/index.html`: pill „📦 За пакетиране (N)“, row button „Пакетирана“/„✓ пакетирана … (отмени)“, „Лист“ button per row and „🖨 Листове за пакетиране“ next to the pills when the pill is active, `?order=<id>` deep link (scroll, highlight, action card with „Пакетирана“), print CSS not needed (the slip is its own page).
- [ ] Check: script parses; local admin: pill count, mark/unmark, slip opens (one and all), deep link highlights; phone width.
- [ ] Commit `feat(packing): admin — to-pack list, slip buttons, QR deep link`.

### Task 4: release
- [ ] Apply migration 021, deploy, open a real slip on app.ordyx.eu and scan the QR with the phone (owner) — the link must open the order.
