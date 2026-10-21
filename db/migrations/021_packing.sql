-- Packing: when the parcel was packed (null = not yet); the status stays what it is.
alter table zd.orders add column if not exists packed_at timestamptz;
