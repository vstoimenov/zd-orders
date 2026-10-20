# Nearest offices + map + hours Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** „Намери ме“ (nearest points with distance), a map and opening hours in the checkout widget for Econt, Speedy and BOX NOW.

**Architecture:** coordinates + hours are stored on `zd.offices` by the nightly refresh and served by `/api/offices`; the ES5 widget computes
distance in the browser (haversine) and lazy-loads MapLibre GL only when the customer opens the map.

**Tech Stack:** Node 22 ESM, Postgres (`zd`), node:test + PGlite, ES5 widget, MapLibre GL 5.6.0 (cdnjs) + OpenFreeMap style.

**Spec:** `docs/superpowers/specs/2026-10-20-nearest-offices-map-design.md`

## Global Constraints
- `zd.offices`: `lat double precision`, `lng double precision`, `hours text not null default ''` (migration 020, applied by hand).
- Hours string format: `пн–пт HH:MM–HH:MM` + optional ` · сб HH:MM–HH:MM`; `24/7` for 00:00–23:59; '' when unknown. Sofia time.
- Distance text: `< 1000 m` → `"650 m"` (rounded to 50 m), else `"2,3 km"` (one decimal, comma).
- Widget stays ES5 (no arrow functions, let/const, template literals); geolocation only on tap; location never sent to the server.
- Map script: `https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/5.6.0/maplibre-gl.js` (+ `.css`), style `https://tiles.openfreemap.org/styles/liberty`.
- Bulgarian user-facing text; English code/commits with trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus
1. A point without coordinates never breaks sorting or the map (skipped, listed last when searching).
2. Location denied / timeout / insecure context → the note, search unchanged, no console error loop.
3. Map script fails to load (offline, CDN blocked) → a note and the overlay closes; the checkout still works.
4. Hours at the 24/7 Econt lockers and at offices with no Saturday hours (halfDay missing) render correctly.
5. The existing office/locker selection text written into ConvertBuilder is unchanged (hours never leak into the address).

---

### Task 1: Coordinates and hours in the office data
**Files:** Create `db/migrations/020_office_geo.sql`; modify `lib/econt.js` (normalizeOffices: lat/lng/hours), `lib/speedy.js` (keep lat/lng; hours ''), `lib/boxnow.js` (lat/lng, hours '24/7' when note has it), `lib/catalog-repo.js` (replaceOffices/listOffices with lat/lng/hours), `api/offices.js` (passes through); tests `test/econt.test.js` (or the existing Econt normalise test file), `test/speedy.test.js`, `test/boxnow.test.js`, `test/catalog-repo.test.js`, `test/api.test.js`.
- [ ] Tests: `normalizeOffices` gives `lat: 44.1009…, lng: 27.195…, hours: 'пн–пт 09:00–18:00 · сб 09:00–15:00'` for the sample office, `'24/7'` for 00:00–23:59, `'пн–пт 09:00–18:00'` when halfDay hours are null; Speedy office keeps `lat/lng`, `hours: ''`; BOX NOW `hours: '24/7'` / `''`; `listOffices` returns `{…, lat, lng, hours}`; `/api/offices` JSON contains them.
- [ ] RED → implement → GREEN; commit `feat(offices): coordinates and opening hours`.

### Task 2: „Намери ме“ + distance + hours in the widget
**Files:** `public/checkout.js` (core: `distanceM(a, b)`, `distanceText(m)`, `nearestOffices(offices, point, limit)`, `hoursLine(o)`; UI: button in `officePanel`, `state.geo`, `locate(courier)`, list rows with distance/hours, `pickedHtml` with hours), `test/checkout-core.test.js`, `dev/harness.html` (fixture lat/lng/hours; fake `navigator.geolocation` via `?geo=sofia|deny`).
- [ ] Tests: `distanceM` Sofia→Plovdiv ≈ 132 km (±2 km); `distanceText(650)='650 m'`, `(1234)='1,2 km'`, `(40)='50 m'`; `nearestOffices` sorts by distance, points without coordinates last, limit respected; `officeLabel`/`formatSelection` unchanged (hours not in the address).
- [ ] RED → implement → GREEN; browser check in the harness (locate → nearest 8 with metres; deny → note); commit `feat(checkout): find me — nearest offices with distance and hours`.

### Task 3: Map
**Files:** `public/checkout.js` (lazy loader `loadMap()`, overlay `openMap(courier)`, markers within bounds, popup with „Избери“, close), CSS for the overlay; `test/checkout-core.test.js` (constants + `markerPoints(offices, bounds, max)`), `dev/harness.html` (real CDN load in the browser check).
- [ ] Tests: `MAP_SCRIPT`/`MAP_STYLE` constants pinned; `markerPoints` filters to bounds and caps at 400, skips points without coordinates.
- [ ] RED → implement → GREEN; browser check: open map, tap marker, „Избери“ writes the point into ConvertBuilder fields; CDN failure (harness `?map=fail`) shows the note; commit `feat(checkout): map of the courier's points`.

### Task 4: Release
- [ ] Apply migration 020 on production, deploy, run the refresh cron once, check `/api/offices?courier=econt` has `lat`/`hours`, check on the live harness page on a phone-sized viewport.
