-- E-mail campaigns: the third channel of zd.campaigns, sent by Ordyx itself (Resend). Every message is a row in zd.email_sends with
-- what the provider reported back (delivered, opened, clicked, bounced); an address that unsubscribed, bounced or complained goes to
-- zd.email_optouts and never gets another campaign of that shop.
alter table zd.campaigns drop constraint if exists campaigns_channel_check;
alter table zd.campaigns add constraint campaigns_channel_check check (channel in ('sms', 'whatsapp', 'email'));
alter table zd.campaigns drop constraint if exists campaigns_status_check;
alter table zd.campaigns add constraint campaigns_status_check check (status in ('draft', 'ready', 'sending', 'sent'));
alter table zd.campaigns add column if not exists subject text not null default '';
alter table zd.campaigns add column if not exists button_text text not null default '';
alter table zd.campaigns add column if not exists button_url text not null default '';
alter table zd.campaigns add column if not exists image_url text not null default '';
alter table zd.campaigns add column if not exists sent_at timestamptz;
alter table zd.campaigns add column if not exists sent_count int not null default 0;

create table if not exists zd.email_sends (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references zd.campaigns(id) on delete cascade,
  shop_id uuid not null references zd.shops(id) on delete cascade,
  email text not null,
  name text not null default '',
  status text not null default 'queued' check (status in ('queued', 'sent', 'delivered', 'bounced', 'complained', 'failed')),
  provider_id text,
  error text not null default '',
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  delivered_at timestamptz,
  opened_at timestamptz,
  clicked_at timestamptz,
  unique (campaign_id, email)
);
create index if not exists email_sends_provider_idx on zd.email_sends (provider_id) where provider_id is not null;
create index if not exists email_sends_campaign_status_idx on zd.email_sends (campaign_id, status);

create table if not exists zd.email_optouts (
  shop_id uuid not null references zd.shops(id) on delete cascade,
  email text not null,
  reason text not null default '',
  created_at timestamptz not null default now(),
  primary key (shop_id, email)
);
-- production (Supabase): grant select, insert, update, delete on zd.email_sends, zd.email_optouts to zd_app
