-- Delivery changed after the order (by the customer on the order page, or the shop), invoice details, how the order was
-- confirmed (link / whatsapp / voice / manual), and the order an abandoned cart turned into.
alter table zd.orders add column if not exists delivery_changed_at timestamptz;
alter table zd.orders add column if not exists delivery_changed_by text not null default '';
alter table zd.orders add column if not exists invoice jsonb not null default '{}'::jsonb;
alter table zd.orders add column if not exists confirm_channel text not null default '';
alter table zd.abandoned_carts add column if not exists order_id uuid;
