-- anonymous visits (no cookies, no IP: visitor = daily-salted hash) + traffic source of checkout orders + daily ad spend
create table if not exists zd.visits (
  id bigserial primary key,
  day date not null,
  site text not null,
  visitor text not null,
  path text not null default '',
  source text not null default 'direct',
  campaign text not null default '',
  device text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists visits_site_day_idx on zd.visits (site, day);
create index if not exists visits_day_visitor_idx on zd.visits (day, visitor);
alter table zd.orders add column if not exists traffic_source text not null default '';
create table if not exists zd.ad_spend (
  platform text not null,
  account_id text not null,
  day date not null,
  spend numeric(12, 2) not null default 0,
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  purchases integer not null default 0,
  purchase_value numeric(12, 2) not null default 0,
  currency text not null default 'EUR',
  updated_at timestamptz not null default now(),
  primary key (platform, account_id, day)
);
-- production (Supabase): grant select, insert, update, delete on zd.visits, zd.ad_spend to zd_app; grant usage, select on sequence zd.visits_id_seq to zd_app
