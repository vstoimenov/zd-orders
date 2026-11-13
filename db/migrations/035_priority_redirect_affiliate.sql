-- Orders: a priority (1 нисък … 4 критичен); a parcel redirected on its way (to another office / address of the same courier:
-- the order stays „shipped“ and its courier statuses keep coming); „Унищожена“ = a fake, test or duplicate order (status
-- cancelled + destroyed_at: counted nowhere, its stock given back).
alter table zd.orders add column if not exists priority smallint not null default 1 check (priority between 1 and 4);
alter table zd.orders add column if not exists redirected_at timestamptz;
alter table zd.orders add column if not exists redirect_from text not null default '';
alter table zd.orders add column if not exists destroyed_at timestamptz;

-- Affiliates: every client gets a link (ref_code); a client registered through it is referred_by its owner; 50% of each
-- subscription payment of a referred client is the partner's commission; the owner records the payouts.
alter table zd.users add column if not exists ref_code text unique;
alter table zd.users add column if not exists referred_by uuid references zd.users(id) on delete set null;
create table if not exists zd.payouts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references zd.users(id) on delete cascade,
  paid_at date not null,
  amount numeric(10,2) not null check (amount > 0),
  note text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists payouts_user_idx on zd.payouts (user_id, paid_at desc);
-- production (Supabase, applied): grant select, insert, update, delete on zd.payouts to zd_app;
--   alter table zd.payouts enable row level security; create policy payouts_zd_app on zd.payouts for all to zd_app using (true) with check (true);
