-- courier waybills created from the admin (Econt now, Speedy later). waybill_number '' = none, 'creating' = being created right now, 'unknown' = Econt's answer was unclear
-- (a person checks e-Econt and releases it; never taken over automatically, so one order never gets two waybills).
alter table zd.orders add column if not exists waybill_number text not null default '';
alter table zd.orders add column if not exists waybill_courier text not null default '';
alter table zd.orders add column if not exists waybill_pdf text not null default '';
alter table zd.orders add column if not exists waybill_price numeric(10, 2);
alter table zd.orders add column if not exists waybill_currency text not null default '';
alter table zd.orders add column if not exists waybill_demo boolean not null default false;
alter table zd.orders add column if not exists waybill_status text not null default '';
alter table zd.orders add column if not exists waybill_created_at timestamptz;
alter table zd.orders add column if not exists waybill_prev_status text not null default ''; -- status before the waybill moved it to shipped
alter table zd.orders add column if not exists waybill_checked_at timestamptz;
create index if not exists orders_waybill_sync_idx on zd.orders (shop_id, waybill_created_at) where status = 'shipped' and waybill_number <> '';
