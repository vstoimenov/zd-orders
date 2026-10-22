# Event offer + logo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ordyx.eu/oferta` → signup with 3 months free on the unlimited plan, the owner's on/off switch, logo A everywhere, print files.

**Architecture:** offer state in `zd.settings` key `offer`; `zd.users` gains `plan`, `free_until`, `source` (migration 022); the existing
signup route accepts `offer` instead of a code; static offer page served by a host rewrite; icons redrawn by dev/icons.mjs;
print PNGs rendered with headless Chrome from dev HTML.

**Spec:** `docs/superpowers/specs/2026-10-22-event-offer-and-logo-design.md`

## Global Constraints
- `OFFER_MONTHS = 3`, `OFFER_SHOPS_MAX = 200`, `CLIENT_SHOPS_MAX = 10`; savings formula 3 × (29 + 12 × (shops − 1)).
- No new Vercel functions (10/12). Offer page and admin stay ES5-safe like the rest of the admin script.
- Bulgarian UI; English code; commit trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus
1. Offer off → GET/POST signup with `offer` answer 400 „Офертата вече не е активна“; the normal signup code still works.
2. A normal signup (code) never gets the offer, even if `offer:true` is sent alongside.
3. Offer client can add more than 10 shops; a normal client still cannot.
4. `free_until` is exactly 3 months after registration (DB time), shown in Sofia time.
5. The offer page never breaks if the status call fails (CTA stays).

---

### Task 1: offer backend
**Files:** create `db/migrations/022_offer.sql`, `lib/offer.js`; modify `lib/users.js` (registerClient offer, adminUser plan, listClients fields), `lib/admin/signup.js`, `lib/admin/users.js` (offer status + `offer_on`/`offer_off`), `lib/admin/shops.js` (cap by plan), `lib/admin/me.js` (plan, freeUntil); tests `test/signup.test.js`, `test/users.test.js`, `test/shops.test.js`.
- [ ] RED → implement → GREEN; commit `feat(offer): hidden event offer — 3 months free on the unlimited plan`.

### Task 2: logo A
**Files:** `public/brand/*.svg`, `dev/icons.mjs` (gem with facet colours; mini for small), `public/admin/*.png`, `public/admin/index.html`, `public/landing/index.html`.
- [ ] Icons regenerated, logos replaced, pages checked in the browser; commit `feat(brand): new Ordyx logo (cut gem, lowercase wordmark)`.

### Task 3: offer page + admin UI + print files
**Files:** `public/landing/oferta.html`, `vercel.json` (rewrite + noindex header), `public/admin/index.html` (signup `?offer=1`, Клиенти box/badges, client sidebar line), `dev/print.html` + `public/brand/{qr-oferta.svg,qr-oferta.png,vizitka-front.png,vizitka-back.png}`.
- [ ] Browser check (phone width), commit `feat(offer): ordyx.eu/oferta page, admin switch and print files`.

### Task 4: release
- [ ] Migration 022 applied, suite green, deploy, open ordyx.eu/oferta and scan the QR.
