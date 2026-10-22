-- WooCommerce and custom sites: Econt to an address, orders that came without a courier, and what the shop's own site did to an order.
alter table zd.orders drop constraint if exists orders_delivery_type_check;
alter table zd.orders add constraint orders_delivery_type_check
  check (delivery_type in ('econt_office', 'econt_address', 'speedy_office', 'speedy_address', 'boxnow_locker', 'other'));
alter table zd.orders add column if not exists external_status text not null default '';
