-- A client who picked the Free plan at registration: 14 days on Starter, then Free; no payment link is to be sent.
alter table zd.users add column if not exists sub_wants_free boolean not null default false;
