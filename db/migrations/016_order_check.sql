-- Widget orders are checked against the shop's ConvertBuilder before anything automatic happens: a forged order stays aside.
alter table zd.orders add column if not exists cb_check text not null default ''; -- '' = not checked (no ConvertBuilder connection) | 'ok' | 'pending'
alter table zd.orders add column if not exists wa_auto_at timestamptz;           -- when the automatic WhatsApp confirmation went out
create index if not exists orders_wa_auto_idx on zd.orders (shop_id, wa_auto_at) where wa_auto_at is not null;
