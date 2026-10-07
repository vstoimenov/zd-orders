-- one product per name regardless of capitals/outer spaces (order items are matched the same way)
create unique index if not exists product_costs_name_key_uidx on zd.product_costs (lower(btrim(name)));
