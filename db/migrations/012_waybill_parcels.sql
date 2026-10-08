-- every parcel id of a Speedy shipment (comma-separated): the PDF must carry a label for each parcel
alter table zd.orders add column if not exists waybill_parcels text not null default '';
