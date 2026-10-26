-- corpgroup.com · 0001 core: companies (tenants), membership, org structure, audit, notifications
-- Every tenant table carries company_id and has RLS enabled (NFR-04, AUTH-10).

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Companies
-- ---------------------------------------------------------------------------
create table public.companies (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references auth.users(id),
  name               text not null,
  legal_name         text,
  logo_url           text,
  address            text,
  state              text,                       -- drives Professional Tax slab
  gstin              text,
  pan                text,
  tan                text,
  pf_reg_no          text,
  esi_reg_no         text,
  timezone           text not null default 'Asia/Kolkata',
  emp_code_prefix    text not null default 'EMP',
  next_emp_seq       integer not null default 1,
  fy_start_month     integer not null default 4 check (fy_start_month between 1 and 12),
  weekly_offs        integer[] not null default '{0}',   -- 0 = Sunday … 6 = Saturday
  -- payroll policy (SAL-17/18/19)
  salary_days_basis  text not null default 'calendar' check (salary_days_basis in ('calendar','30','26')),
  sandwich_paid      boolean not null default true,
  ot_multiplier      numeric not null default 2,
  late_marks_to_half_day integer not null default 3,      -- ATT-11; 0 disables
  payable_map        jsonb not null default '{
    "present":1,"late":1,"early_out":1,"on_duty":1,"wfh":1,
    "half_day":0.5,"holiday":1,"weekly_off":1,
    "absent":0,"missed_punch":0
  }'::jsonb,
  status             text not null default 'active' check (status in ('active','archived')),
  plan               text not null default 'pilot',
  employee_limit     integer,
  renewal_date       date,
  archived_at        timestamptz,
  created_at         timestamptz not null default now()
);

create table public.company_members (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        text not null check (role in ('owner','company_admin','hr','manager','employee')),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (company_id, user_id)
);
create index on public.company_members (user_id);

-- ---------------------------------------------------------------------------
-- RLS helpers (security definer so policies never recurse into company_members)
-- ---------------------------------------------------------------------------
create or replace function public.is_member(cid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.company_members m
    join public.companies c on c.id = m.company_id
    where m.company_id = cid and m.user_id = auth.uid() and m.active
  );
$$;

create or replace function public.has_role(cid uuid, roles text[])
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.company_members m
    where m.company_id = cid and m.user_id = auth.uid() and m.active and m.role = any(roles)
  );
$$;

create or replace function public.my_role(cid uuid)
returns text language sql stable security definer set search_path = public as $$
  select m.role from public.company_members m
  where m.company_id = cid and m.user_id = auth.uid() and m.active;
$$;

-- ---------------------------------------------------------------------------
-- Org structure
-- ---------------------------------------------------------------------------
create table public.branches (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  name        text not null,
  address     text,
  state       text,
  lat         double precision,
  lng         double precision,
  geofence_m  integer not null default 200,
  created_at  timestamptz not null default now()
);

create table public.departments (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  name        text not null,
  unique (company_id, name)
);

create table public.designations (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  name        text not null,
  unique (company_id, name)
);

create table public.holidays (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  branch_id   uuid references public.branches(id) on delete cascade,  -- null = all branches
  date        date not null,
  name        text not null
);
create index on public.holidays (company_id, date);

-- ---------------------------------------------------------------------------
-- Audit log (X-05) and notifications (X-01)
-- ---------------------------------------------------------------------------
create table public.audit_log (
  id          bigint generated always as identity primary key,
  company_id  uuid,
  user_id     uuid,
  table_name  text not null,
  record_id   text,
  action      text not null,
  old_data    jsonb,
  new_data    jsonb,
  ip          text,
  at          timestamptz not null default now()
);
create index on public.audit_log (company_id, at desc);

create or replace function public.request_ip()
returns text language sql stable as $$
  select split_part(coalesce(
    nullif(current_setting('request.headers', true), '')::json ->> 'x-forwarded-for', ''), ',', 1);
$$;

create or replace function public.audit_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  rec jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
begin
  insert into public.audit_log (company_id, user_id, table_name, record_id, action, old_data, new_data, ip)
  values (
    case when tg_table_name = 'companies' then (rec ->> 'id')::uuid else (rec ->> 'company_id')::uuid end,
    auth.uid(), tg_table_name, rec ->> 'id', lower(tg_op),
    case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end,
    public.request_ip());
  return null;
end $$;

create table public.notifications (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid references public.companies(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  title       text not null,
  body        text,
  link        text,
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index on public.notifications (user_id, created_at desc);

create or replace function public.notify(p_user uuid, p_company uuid, p_title text, p_body text, p_link text)
returns void language sql security definer set search_path = public as $$
  insert into public.notifications (user_id, company_id, title, body, link)
  select p_user, p_company, p_title, p_body, p_link where p_user is not null;
$$;

-- notify every active member with one of the given roles
create or replace function public.notify_roles(p_company uuid, p_roles text[], p_title text, p_body text, p_link text)
returns void language sql security definer set search_path = public as $$
  insert into public.notifications (user_id, company_id, title, body, link)
  select m.user_id, p_company, p_title, p_body, p_link
  from public.company_members m
  where m.company_id = p_company and m.active and m.role = any(p_roles);
$$;

-- ---------------------------------------------------------------------------
-- Company creation: owner membership added automatically
-- ---------------------------------------------------------------------------
create or replace function public.companies_after_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.company_members (company_id, user_id, role)
  values (new.id, new.owner_id, 'owner')
  on conflict (company_id, user_id) do update set role = 'owner', active = true;
  return null;
end $$;

create trigger companies_after_insert after insert on public.companies
  for each row execute function public.companies_after_insert();
create trigger companies_audit after insert or update or delete on public.companies
  for each row execute function public.audit_trigger();
create trigger company_members_audit after insert or update or delete on public.company_members
  for each row execute function public.audit_trigger();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.companies       enable row level security;
alter table public.company_members enable row level security;
alter table public.branches        enable row level security;
alter table public.departments     enable row level security;
alter table public.designations    enable row level security;
alter table public.holidays        enable row level security;
alter table public.audit_log       enable row level security;
alter table public.notifications   enable row level security;

create policy companies_select on public.companies for select using (owner_id = auth.uid() or public.is_member(id));
create policy companies_insert on public.companies for insert with check (owner_id = auth.uid());
create policy companies_update on public.companies for update
  using (public.has_role(id, array['owner','company_admin']))
  with check (public.has_role(id, array['owner','company_admin']));

create policy members_select on public.company_members for select using (public.is_member(company_id));
create policy members_write on public.company_members for all
  using (public.has_role(company_id, array['owner','company_admin']))
  with check (public.has_role(company_id, array['owner','company_admin']) and role <> 'owner');

-- org structure: everyone reads, admin writes; HR also maintains holidays
create policy branches_select on public.branches for select using (public.is_member(company_id));
create policy branches_write on public.branches for all
  using (public.has_role(company_id, array['owner','company_admin']))
  with check (public.has_role(company_id, array['owner','company_admin']));
create policy departments_select on public.departments for select using (public.is_member(company_id));
create policy departments_write on public.departments for all
  using (public.has_role(company_id, array['owner','company_admin','hr']))
  with check (public.has_role(company_id, array['owner','company_admin','hr']));
create policy designations_select on public.designations for select using (public.is_member(company_id));
create policy designations_write on public.designations for all
  using (public.has_role(company_id, array['owner','company_admin','hr']))
  with check (public.has_role(company_id, array['owner','company_admin','hr']));
create policy holidays_select on public.holidays for select using (public.is_member(company_id));
create policy holidays_write on public.holidays for all
  using (public.has_role(company_id, array['owner','company_admin','hr']))
  with check (public.has_role(company_id, array['owner','company_admin','hr']));

create policy audit_select on public.audit_log for select
  using (public.has_role(company_id, array['owner','company_admin','hr']));

create policy notifications_own on public.notifications for select using (user_id = auth.uid());
create policy notifications_update on public.notifications for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());
