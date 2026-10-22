-- Hidden event offer: accounts registered through ordyx.eu/oferta get the unlimited plan free for a while.
alter table zd.users add column if not exists plan text not null default 'standard';
alter table zd.users add column if not exists free_until timestamptz;
alter table zd.users add column if not exists source text not null default '';
