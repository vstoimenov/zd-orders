-- costs & profit: per-product unit cost, per-order cost settings and dated one-off expenses (EUR)
create table if not exists zd.product_costs (
  name text primary key,
  unit_cost numeric(10, 2) not null default 0,
  updated_at timestamptz not null default now()
);
create table if not exists zd.settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create table if not exists zd.expenses (
  id uuid primary key default gen_random_uuid(),
  spent_on date not null,
  name text not null,
  amount numeric(10, 2) not null,
  created_at timestamptz not null default now()
);
create index if not exists expenses_spent_idx on zd.expenses (spent_on desc);
