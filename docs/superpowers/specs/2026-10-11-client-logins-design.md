# Client logins (stage 2) — design (approved 2026-10-08/11)

The owner creates a client (email, name, shops) → a one-time link (7 days) → the client sets a password → logs in with email + password
and sees only their shops. The owner keeps the current password login and sees everything.

## Data (migration 014)
- `zd.users`: email (unique, case-insensitive), name, scrypt password hash, active, session_version, invite hash + expiry,
  failed_logins + locked_until, last_login_at.
- `zd.user_shops (user_id, shop_id)`; `zd.push_subscriptions.user_id` (a client's "all shops" device = only their shops).

## Sessions
- Owner token unchanged: `<exp>.<hmac>`. Client token: `c.<user id>.<session version>.<exp>.<hmac>` (same cookie, same secret).
- Every admin request: `adminUser(req, q)` → `{ owner: true }` | `{ owner: false, id, email, name, shopIds }` | null. A client token is
  valid only while the user is active and the session version matches (password set again / access stopped → old sessions end).
- Login: 10 failed attempts lock the account for 15 minutes; every failure waits 500 ms.

## Scoping (the security core)
- `resolveShop(q, param, { allowAll, strict, user })`: for a client only their shop ids; `all` = their shops (`ids`), never others.
- Every route passes `user`: orders (list, change, delete), stats (incl. the all-shops table), costs, inventory, integrations,
  waybills (incl. PDF), push (client devices notify only for their shops), shops (list own; create → own; hide own), Meta login start.
- Owner-only: `users` route (create client, new link, shops, stop/start access).

## Routes
- `login` POST {email?, password}: no email = owner. `me` GET → role, email, name. `invite` (no login): GET ?token → email; POST {token, password} → set password, log in.
- `users` (owner): GET list · POST create {email, name, shopIds} → link · invite {id} → new link · update {id, name, shopIds, active}.

## UI
- Login form gets an email field (empty = owner). `?invite=<token>` shows "Задайте парола". Owner sees "Клиенти" (list, new client with shop
  checkboxes, copy link, new link, shops, stop/start). A client can add their own shops; "Всички магазини" summarises only theirs.

## Not now
Self-registration, emails sent by the system, per-client billing.
