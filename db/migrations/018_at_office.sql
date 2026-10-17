-- Parcels waiting at the receiver's office: when they arrived (first seen by the nightly status check).
alter table zd.orders add column if not exists waybill_at_office_since timestamptz;
