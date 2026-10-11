-- SMS / WhatsApp campaigns (first version: compose, preview, save, export; sending comes with a provider)
create table if not exists zd.campaigns (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references zd.shops(id) on delete cascade,
  name text not null default '',
  channel text not null default 'sms' check (channel in ('sms', 'whatsapp')),
  message text not null default '',
  segment jsonb not null default '{}'::jsonb,
  consent boolean not null default false,
  status text not null default 'draft' check (status in ('draft', 'ready')),
  recipients int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists campaigns_shop_idx on zd.campaigns (shop_id, created_at desc);
-- numbers that never get a campaign (STOP)
create table if not exists zd.campaign_optouts (
  shop_id uuid not null references zd.shops(id) on delete cascade,
  phone_norm text not null,
  created_at timestamptz not null default now(),
  primary key (shop_id, phone_norm)
);
-- order confirmation by the customer through a personal link (sent by WhatsApp/SMS)
alter table zd.orders add column if not exists confirm_token text;
alter table zd.orders add column if not exists confirm_answer text not null default ''; -- '' | 'yes' | 'no'
alter table zd.orders add column if not exists confirm_answered_at timestamptz;
create unique index if not exists orders_confirm_token_uidx on zd.orders (confirm_token) where confirm_token is not null;
-- production (Supabase): grant select, insert, update, delete on zd.campaigns, zd.campaign_optouts to zd_app (+ RLS policy for zd_app)
