-- corpgroup.com · 0010 one-click verify link next to the 6-digit code.
-- The link carries a separate 32-byte random token; only its hash is stored, like the code.
alter table public.otp_codes add column if not exists link_hash text;
