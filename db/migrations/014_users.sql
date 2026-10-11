-- client logins (stage 2): the owner creates a client with shops; the client sets a password through a one-time link.
create table if not exists zd.users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  name text not null default '',
  password_hash text,
  active boolean not null default true,
  session_version int not null default 1,
  invite_hash text,
  invite_expires_at timestamptz,
  failed_logins int not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);
create unique index if not exists users_email_uidx on zd.users (lower(email));
create unique index if not exists users_invite_uidx on zd.users (invite_hash) where invite_hash is not null;
create table if not exists zd.user_shops (
  user_id uuid not null references zd.users(id) on delete cascade,
  shop_id uuid not null references zd.shops(id) on delete cascade,
  primary key (user_id, shop_id)
);
create index if not exists user_shops_shop_idx on zd.user_shops (shop_id);
-- a shop a client added takes checkout orders/visits by its domain only after the owner approves it (owner-made shops: approved)
alter table zd.shops add column if not exists approved boolean not null default true;
-- a client's device: its "all shops" means only that client's shops
alter table zd.push_subscriptions add column if not exists user_id uuid references zd.users(id) on delete cascade;
-- production (Supabase): grant select, insert, update, delete on zd.users, zd.user_shops to zd_app (+ RLS policy for zd_app, like zd.integrations)
