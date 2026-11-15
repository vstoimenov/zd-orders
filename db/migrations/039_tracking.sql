-- Ordyx's own marketing (ordyx.eu): the browser ids of a client who registered with cookies accepted (Meta _fbp/_fbc, GA4 client id),
-- so the payment recorded later is reported to Meta's Conversions API and GA4 as the same person. Nothing is kept without consent.
alter table zd.users add column if not exists track jsonb;
