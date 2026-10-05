-- last order status seen from ConvertBuilder: our status follows it only when it changes (keeps statuses set in the admin)
alter table zd.orders add column if not exists cb_status text not null default '';
