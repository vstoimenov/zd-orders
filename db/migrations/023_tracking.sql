-- Tracking: when the courier's status text last changed (a parcel with no change for days needs a look).
alter table zd.orders add column if not exists waybill_status_changed_at timestamptz;
