-- phones/browsers that get a notification for every new order (Web Push). shop_id null = all shops.
create table if not exists zd.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  shop_id uuid references zd.shops(id) on delete cascade,
  user_agent text not null default '',
  created_at timestamptz not null default now(),
  last_sent_at timestamptz,
  failures int not null default 0
);
-- production (Supabase): grant select, insert, update, delete on zd.push_subscriptions to zd_app
