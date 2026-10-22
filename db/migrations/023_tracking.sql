-- Tracking: when the courier's status text last changed (a parcel with no change for days needs a look),
-- and when the buyer's order page last asked the courier (claimed before the call: one call per 30 minutes, even when it fails).
alter table zd.orders add column if not exists waybill_status_changed_at timestamptz;
alter table zd.orders add column if not exists waybill_refresh_at timestamptz;
-- parcels already on their way: start from the last check, so the first day does not flag every older parcel
update zd.orders set waybill_status_changed_at = waybill_checked_at
  where waybill_status_changed_at is null and waybill_status <> '' and waybill_checked_at is not null;
