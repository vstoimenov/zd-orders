-- Digital products (bonuses, plans, audio): no product cost by rule (0 is the true cost, not a missing one), never in stock.
alter table zd.product_costs add column if not exists digital boolean not null default false;
