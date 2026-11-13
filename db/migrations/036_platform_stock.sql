-- Stock that comes from the shop's own platform (WooCommerce, ConvertBuilder, a custom site through the API): the platform is the
-- source of truth for such a product, so Ordyx no longer takes its orders from it (the platform already did) and only writes the
-- number the platform sends. Every change is logged in zd.stock_moves with reason 'sync'.
alter table zd.product_costs add column if not exists stock_source text;
alter table zd.product_costs add column if not exists stock_synced_at timestamptz;
alter table zd.stock_moves drop constraint if exists stock_moves_reason_check;
alter table zd.stock_moves add constraint stock_moves_reason_check check (reason in ('order', 'order_restore', 'manual', 'sync'));
