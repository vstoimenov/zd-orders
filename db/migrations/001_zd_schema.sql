create schema if not exists zd;

create table if not exists zd.cities (
  id integer primary key,
  name text not null,
  post_code text not null default '',
  region text not null default '',
  has_office boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists zd.offices (
  id text primary key,
  courier text not null check (courier in ('econt', 'speedy')),
  code text not null,
  name text not null,
  city text not null,
  city_id integer,
  post_code text not null default '',
  address text not null default '',
  is_automat boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists zd.orders (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  cb_order_id text not null unique,
  name text not null,
  phone text not null,
  phone_norm text not null,
  email text not null default '',
  delivery_type text not null check (delivery_type in ('econt_office', 'speedy_office', 'speedy_address')),
  courier text not null check (courier in ('econt', 'speedy')),
  office_id text not null default '',
  office_text text not null default '',
  city text not null default '',
  post_code text not null default '',
  address_text text not null default '',
  items jsonb not null default '[]'::jsonb,
  total numeric(10, 2) not null default 0,
  currency text not null default 'EUR',
  payment_method text not null default '',
  page_url text not null default '',
  user_agent text not null default '',
  ip text not null default '',
  status text not null default 'new'
    check (status in ('new', 'confirmed', 'shipped', 'delivered', 'returned', 'cancelled')),
  is_duplicate boolean not null default false,
  status_changed_at timestamptz
);

create index if not exists orders_created_idx on zd.orders (created_at desc);
create index if not exists orders_phone_idx on zd.orders (phone_norm, created_at desc);
create index if not exists orders_ip_idx on zd.orders (ip, created_at desc);
