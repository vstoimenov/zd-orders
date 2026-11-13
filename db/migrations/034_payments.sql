-- A client's subscription payments: the owner records each one (date, amount, the period it pays, the invoice); the client sees
-- them in „Профил“. The first one also marks the subscription paid (the launch price is kept 12 months from it).
create table if not exists zd.payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references zd.users(id) on delete cascade,
  paid_at date not null,
  amount numeric(10,2) not null check (amount >= 0),
  period_from date,
  period_to date,
  invoice_no text not null default '',
  invoice_url text not null default '',
  note text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists payments_user_idx on zd.payments (user_id, paid_at desc);
-- production (Supabase, applied): grant select, insert, update, delete on zd.payments to zd_app;
--   alter table zd.payments enable row level security; create policy payments_zd_app on zd.payments for all to zd_app using (true) with check (true);
