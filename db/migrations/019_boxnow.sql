-- BOX NOW parcel lockers: a third courier (lockers in zd.offices, orders to a locker).
alter table zd.offices drop constraint if exists offices_courier_check;
alter table zd.offices add constraint offices_courier_check check (courier in ('econt', 'speedy', 'boxnow'));
alter table zd.orders drop constraint if exists orders_courier_check;
alter table zd.orders add constraint orders_courier_check check (courier in ('econt', 'speedy', 'boxnow', 'other'));
alter table zd.orders drop constraint if exists orders_delivery_type_check;
alter table zd.orders add constraint orders_delivery_type_check
  check (delivery_type in ('econt_office', 'speedy_office', 'speedy_address', 'boxnow_locker', 'other'));
-- cancelled waybills of an order: BOX NOW takes each order number once, so the number is order id + attempt
alter table zd.orders add column if not exists waybill_attempt integer not null default 0;
