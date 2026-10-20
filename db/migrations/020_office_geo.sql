-- Coordinates and opening hours of offices/lockers: "Намери ме", the map and the hours line in the checkout.
alter table zd.offices add column if not exists lat double precision;
alter table zd.offices add column if not exists lng double precision;
alter table zd.offices add column if not exists hours text not null default '';
