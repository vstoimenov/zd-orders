-- integrations configured from the admin (per provider; secrets encrypted with INTEGRATIONS_SECRET) + orders from ConvertBuilder's API
create table if not exists zd.integrations (
  provider text primary key,
  config jsonb not null default '{}'::jsonb,
  secret_enc text,
  updated_at timestamptz not null default now()
);
alter table zd.orders drop constraint if exists orders_delivery_type_check;
alter table zd.orders add constraint orders_delivery_type_check
  check (delivery_type in ('econt_office', 'speedy_office', 'speedy_address', 'other'));
alter table zd.orders drop constraint if exists orders_courier_check;
alter table zd.orders add constraint orders_courier_check check (courier in ('econt', 'speedy', 'other'));
alter table zd.orders add column if not exists source text not null default 'widget';
alter table zd.orders add column if not exists invoice_no text not null default '';
-- production (Supabase): RLS is on for zd.integrations with policy integrations_zd_app (for all to zd_app) + grant select, insert, update, delete to zd_app
