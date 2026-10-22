-- A callback to the shop's own site (WooCommerce) that did not get through: the event waits here and the nightly job retries it.
alter table zd.orders add column if not exists site_notify text not null default '';
