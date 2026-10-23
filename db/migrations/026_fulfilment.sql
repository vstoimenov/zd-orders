-- Fulfilment warehouse: when the order was sent to the shop's warehouse, which event still waits to be sent ('order' / 'cancelled'),
-- and a waybill the warehouse made with its own courier account (not refreshed or cancelled here; its own tracking link).
alter table zd.orders add column if not exists fulfil_sent_at timestamptz;
alter table zd.orders add column if not exists fulfil_notify text not null default '';
alter table zd.orders add column if not exists waybill_external boolean not null default false;
alter table zd.orders add column if not exists waybill_track_url text not null default '';
