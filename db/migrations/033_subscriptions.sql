-- Subscriptions without online payment: the client picks a plan at registration (14 days free), the owner sends a payment link
-- and marks the first payment. A launch price (bought by 30.11.2026 23:59) is kept 12 months from that payment; the first 20
-- yearly payers keep it for as long as they renew the same plan. The regular price is stored next to it.
alter table zd.users add column if not exists sub_plan text;                 -- starter | growth | business
alter table zd.users add column if not exists sub_billing text;              -- monthly | yearly
alter table zd.users add column if not exists sub_price numeric(10,2);       -- what the client pays per period now
alter table zd.users add column if not exists sub_regular numeric(10,2);     -- the period's regular price (after the launch price ends)
alter table zd.users add column if not exists sub_launch boolean not null default false;
alter table zd.users add column if not exists sub_chosen_at timestamptz;
alter table zd.users add column if not exists sub_trial_until timestamptz;
alter table zd.users add column if not exists sub_paid_at timestamptz;       -- the first payment
alter table zd.users add column if not exists sub_locked_until timestamptz;  -- the launch price ends (null: founder or no launch price)
alter table zd.users add column if not exists sub_founder boolean not null default false;
alter table zd.users add column if not exists sub_founder_no integer;        -- 1..20, kept after cancelling: the first 20 who paid
