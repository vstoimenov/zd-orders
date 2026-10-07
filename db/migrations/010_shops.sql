-- several shops in one admin (stage 1: the owner's own shops). Every shop-owned row gets shop_id; existing data → the default shop.
create table if not exists zd.shops (
  id uuid primary key default gen_random_uuid(),
  name text not null default '',
  domain text not null unique,
  url text not null default '',
  email text not null default '',
  phone text not null default '',
  currency text not null default 'EUR',
  hidden boolean not null default false,
  created_at timestamptz not null default now()
);

-- the default shop: from the saved shop data, the ConvertBuilder domain, or the most common order prefix
insert into zd.shops (id, name, domain, url, email, phone, currency)
select '00000000-0000-4000-8000-000000000001',
  coalesce((select value->>'name' from zd.settings where key = 'shop'), ''),
  coalesce(
    nullif((select config->>'store' from zd.integrations where provider = 'convertbuilder'), ''),
    (select split_part(cb_order_id, ':', 1) from zd.orders where position(':' in cb_order_id) > 0 group by 1 order by count(*) desc, 1 limit 1),
    'shop.local'),
  coalesce((select value->>'url' from zd.settings where key = 'shop'), ''),
  coalesce((select value->>'email' from zd.settings where key = 'shop'), ''),
  coalesce((select value->>'phone' from zd.settings where key = 'shop'), ''),
  coalesce(nullif((select value->>'currency' from zd.settings where key = 'shop'), ''), 'EUR')
on conflict do nothing;

-- every other store prefix found in orders becomes its own shop (e.g. a test site)
insert into zd.shops (name, domain)
select split_part(cb_order_id, ':', 1), split_part(cb_order_id, ':', 1)
from zd.orders where position(':' in cb_order_id) > 0 group by 1
on conflict (domain) do nothing;

alter table zd.orders add column if not exists shop_id uuid not null default '00000000-0000-4000-8000-000000000001' references zd.shops(id);
update zd.orders o set shop_id = s.id from zd.shops s where s.domain = split_part(o.cb_order_id, ':', 1) and o.shop_id <> s.id;
create index if not exists orders_shop_created_idx on zd.orders (shop_id, created_at desc);

alter table zd.product_costs add column if not exists shop_id uuid not null default '00000000-0000-4000-8000-000000000001' references zd.shops(id);
alter table zd.product_costs drop constraint if exists product_costs_pkey;
alter table zd.product_costs add primary key (shop_id, name);
drop index if exists zd.product_costs_name_key_uidx;
create unique index if not exists product_costs_shop_name_key_uidx on zd.product_costs (shop_id, lower(btrim(name)));

alter table zd.stock_moves add column if not exists shop_id uuid not null default '00000000-0000-4000-8000-000000000001' references zd.shops(id);
drop index if exists zd.stock_moves_product_idx;
create index if not exists stock_moves_shop_product_idx on zd.stock_moves (shop_id, product_name, created_at desc);

alter table zd.expenses add column if not exists shop_id uuid not null default '00000000-0000-4000-8000-000000000001' references zd.shops(id);

alter table zd.integrations add column if not exists shop_id uuid not null default '00000000-0000-4000-8000-000000000001' references zd.shops(id);
alter table zd.integrations drop constraint if exists integrations_pkey;
alter table zd.integrations add primary key (shop_id, provider);

alter table zd.ad_spend add column if not exists shop_id uuid not null default '00000000-0000-4000-8000-000000000001' references zd.shops(id);
alter table zd.ad_spend drop constraint if exists ad_spend_pkey;
alter table zd.ad_spend add primary key (shop_id, platform, account_id, day);

alter table zd.visits add column if not exists shop_id uuid not null default '00000000-0000-4000-8000-000000000001' references zd.shops(id);
update zd.visits v set shop_id = s.id from zd.shops s where s.domain = v.site and v.shop_id <> s.id;

-- per-shop cost settings
insert into zd.settings (key, value) select 'costs:00000000-0000-4000-8000-000000000001', value from zd.settings where key = 'costs'
on conflict (key) do nothing;
-- production (Supabase): grant select, insert, update, delete on zd.shops to zd_app
