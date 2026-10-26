-- A shop a client added is theirs: the owner's shop menu and "all shops" leave it out (the owner sees it under Клиенти).
alter table zd.shops add column if not exists by_client boolean not null default false;
update zd.shops set by_client = true where not approved;
