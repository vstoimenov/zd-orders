-- Abandoned carts: checkout details typed (with a valid phone) but no order. State is derived from zd.orders when read.
create table if not exists zd.abandoned_carts (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references zd.shops(id) on delete cascade,
  phone_norm text not null default '',
  name text not null default '',
  email text not null default '',
  items jsonb not null default '[]',
  total numeric not null default 0,
  currency text not null default 'EUR',
  delivery_text text not null default '',
  page_url text not null default '',
  ip text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  reminded_at timestamptz,            -- the first reminder ("after a reminder" is judged against it)
  reminder_channel text not null default '',
  reminder_count int not null default 0,
  hidden_at timestamptz,
  recovered_at timestamptz,           -- kept when the record is anonymised after 30 days
  anonymised_at timestamptz
);
create index if not exists abandoned_carts_shop_phone_idx on zd.abandoned_carts (shop_id, phone_norm, updated_at desc);
create index if not exists abandoned_carts_ip_idx on zd.abandoned_carts (ip, updated_at desc);
-- production (Supabase): grant select, insert, update, delete on zd.abandoned_carts to zd_app;
--   alter table zd.abandoned_carts enable row level security; create policy zd_app_all on zd.abandoned_carts for all to zd_app using (true) with check (true);
