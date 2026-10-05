-- nekorekten.com check of each order's phone (registry of customers who refuse cash-on-delivery parcels)
alter table zd.orders add column if not exists nk_status text not null default 'pending'
  check (nk_status in ('pending', 'clean', 'flagged', 'error'));
alter table zd.orders add column if not exists nk_count integer;
alter table zd.orders add column if not exists nk_report_ids jsonb not null default '[]'::jsonb;
alter table zd.orders add column if not exists nk_checked_at timestamptz;
create index if not exists orders_nk_idx on zd.orders (nk_status, created_at desc);
