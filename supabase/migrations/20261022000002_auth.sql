-- corpgroup.com · 0002 auth: OTP store (AUTH-06/07), login attempts (AUTH-02), login history (AUTH-15)
-- These tables have RLS enabled. otp_codes and login_attempts have NO policies, so only
-- server code using the service-role key can read or write them.

create table public.otp_codes (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  purpose     text not null check (purpose in ('signup','login','reset','invite','change_email')),
  code_hash   text not null,
  expires_at  timestamptz not null,
  attempts    integer not null default 0,
  used_at     timestamptz,
  invalidated_at timestamptz,
  ip          text,
  payload     jsonb,                 -- e.g. sign-up name/company, new email for change_email
  created_at  timestamptz not null default now()
);
create index on public.otp_codes (email, purpose, created_at desc);
create index on public.otp_codes (ip, created_at desc);

create table public.login_attempts (
  id          bigint generated always as identity primary key,
  email       text not null,
  ip          text,
  success     boolean not null,
  at          timestamptz not null default now()
);
create index on public.login_attempts (email, at desc);

create table public.login_history (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  ip          text,
  user_agent  text,
  method      text,
  at          timestamptz not null default now()
);
create index on public.login_history (user_id, at desc);

create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text,
  email       text,
  last_company_id uuid references public.companies(id) on delete set null,
  idle_timeout_min integer not null default 30,
  created_at  timestamptz not null default now()
);

alter table public.otp_codes      enable row level security;
alter table public.login_attempts enable row level security;
alter table public.login_history  enable row level security;
alter table public.profiles       enable row level security;

create policy login_history_own on public.login_history for select using (
  user_id = auth.uid()
  or exists (   -- company admins see history of their members
    select 1 from public.company_members m
    where m.user_id = login_history.user_id
      and public.has_role(m.company_id, array['owner','company_admin'])
  )
);

create policy profiles_select on public.profiles for select using (
  id = auth.uid()
  or exists (
    select 1 from public.company_members a
    join public.company_members b on b.company_id = a.company_id
    where a.user_id = auth.uid() and b.user_id = profiles.id
  )
);
create policy profiles_update on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());

-- every auth user gets a profile row (lets server code look users up by email)
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, lower(new.email), coalesce(new.raw_user_meta_data ->> 'full_name', null))
  on conflict (id) do update set email = excluded.email;
  return new;
end $$;
create trigger on_auth_user_created after insert or update of email on auth.users
  for each row execute function public.handle_new_user();
