-- 📞 automatic call an hour after the order: a switch per shop (off by default) and when the agent's server took the order.
alter table zd.shops add column if not exists voice_auto boolean not null default false;
alter table zd.orders add column if not exists voice_auto_at timestamptz;
create index if not exists orders_voice_due_idx on zd.orders (created_at) where status = 'new' and voice_auto_at is null;
