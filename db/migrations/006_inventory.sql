-- inventory: products (zd.product_costs) get SKU, stock (null = not tracked), low-stock threshold and the moment tracking began;
-- each order remembers what it took from stock (stock_applied); every change is logged in zd.stock_moves
alter table zd.product_costs add column if not exists sku text not null default '';
alter table zd.product_costs add column if not exists stock integer;
alter table zd.product_costs add column if not exists low_stock integer not null default 5;
alter table zd.product_costs add column if not exists tracked_since timestamptz;
alter table zd.orders add column if not exists stock_applied jsonb not null default '{}'::jsonb;
create table if not exists zd.stock_moves (
  id bigserial primary key,
  product_name text not null,
  order_id uuid references zd.orders(id) on delete set null,
  qty integer not null,
  reason text not null check (reason in ('order', 'order_restore', 'manual')),
  note text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists stock_moves_product_idx on zd.stock_moves (product_name, created_at desc);
-- production (Supabase): grant select, insert, update, delete on zd.stock_moves to zd_app; grant usage, select on sequence zd.stock_moves_id_seq to zd_app
