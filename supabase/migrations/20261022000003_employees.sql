-- corpgroup.com · 0003 employees (EMP) and shifts (ATT-08, needed by the employee record)

create table public.shifts (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete cascade,
  name            text not null,
  start_time      time not null,
  end_time        time not null,              -- end < start means the shift crosses midnight
  grace_min       integer not null default 0,
  break_min       integer not null default 0,
  half_day_hours  numeric not null default 4,
  full_day_hours  numeric not null default 8,
  is_default      boolean not null default false,
  created_at      timestamptz not null default now()
);

create table public.employees (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies(id) on delete cascade,
  user_id               uuid references auth.users(id) on delete set null,
  emp_code              text,
  -- personal (EMP-03)
  first_name            text not null,
  last_name             text,
  email                 text not null,
  phone                 text,
  photo_url             text,
  dob                   date,
  gender                text,
  address               text,
  emergency_name        text,
  emergency_phone       text,
  -- job (EMP-04)
  branch_id             uuid references public.branches(id) on delete set null,
  department_id         uuid references public.departments(id) on delete set null,
  designation_id        uuid references public.designations(id) on delete set null,
  reporting_manager_id  uuid references public.employees(id) on delete set null,
  date_of_joining       date not null,
  employment_type       text not null default 'full_time' check (employment_type in ('full_time','contract','intern')),
  shift_id              uuid references public.shifts(id) on delete set null,
  probation_end         date,
  mobile_attendance     boolean not null default false,   -- ATT-12
  invite_role           text not null default 'employee' check (invite_role in ('company_admin','hr','manager','employee')),
  invited_at            timestamptz,
  -- statutory and bank (EMP-05). Sensitive values are AES-256-GCM encrypted by the
  -- server before they reach the database; only the last 4 characters are stored in clear.
  uan                   text,
  esi_no                text,
  pan_enc               text,
  pan_last4             text,
  aadhaar_enc           text,
  aadhaar_last4         text,
  bank_account_enc      text,
  bank_last4            text,
  bank_name             text,
  ifsc                  text,
  -- lifecycle (EMP-10/11)
  status                text not null default 'active' check (status in ('active','notice','exited','inactive')),
  resignation_date      date,
  last_working_day      date,
  exit_reason           text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (company_id, emp_code),
  unique (company_id, email)
);
create index on public.employees (company_id, status);
create index on public.employees (user_id);
create index on public.employees (reporting_manager_id);

-- ---------------------------------------------------------------------------
-- Helpers that need the employees table
-- ---------------------------------------------------------------------------
create or replace function public.my_employee_id(cid uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select e.id from public.employees e where e.company_id = cid and e.user_id = auth.uid() limit 1;
$$;

-- true when the current user is the reporting manager of the employee
create or replace function public.is_manager_of(emp uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.employees e
    join public.employees me on me.id = e.reporting_manager_id
    where e.id = emp and me.user_id = auth.uid()
  );
$$;

-- full read on employee data: owner/admin/HR of the company, the employee themself, or their manager
create or replace function public.can_view_employee(emp uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.employees e
    where e.id = emp and (
      public.has_role(e.company_id, array['owner','company_admin','hr'])
      or e.user_id = auth.uid()
      or public.is_manager_of(e.id)
    )
  );
$$;

create or replace function public.is_hr(cid uuid)
returns boolean language sql stable as $$
  select public.has_role(cid, array['owner','company_admin','hr']);
$$;

-- ---------------------------------------------------------------------------
-- Auto employee code (EMP-02) and guarded self-service (EMP-09)
-- ---------------------------------------------------------------------------
create or replace function public.employees_before_write()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_seq integer;
  v_prefix text;
begin
  if tg_op = 'INSERT' and (new.emp_code is null or new.emp_code = '') then
    update public.companies set next_emp_seq = next_emp_seq + 1
      where id = new.company_id
      returning next_emp_seq - 1, emp_code_prefix into v_seq, v_prefix;
    new.emp_code := v_prefix || lpad(v_seq::text, 4, '0');
  end if;

  if tg_op = 'UPDATE' then
    new.updated_at := now();
    -- An employee editing their own record (not HR) may only touch these fields.
    if auth.uid() is not null and not public.is_hr(old.company_id) then
      if (to_jsonb(new) - array['phone','address','emergency_name','emergency_phone','photo_url','updated_at'])
         is distinct from
         (to_jsonb(old) - array['phone','address','emergency_name','emergency_phone','photo_url','updated_at']) then
        raise exception 'Only HR can change these fields; submit a change request instead'
          using errcode = '42501';
      end if;
    end if;
  end if;
  return new;
end $$;

create trigger employees_before_write before insert or update on public.employees
  for each row execute function public.employees_before_write();
create trigger employees_audit after insert or update or delete on public.employees
  for each row execute function public.audit_trigger();

-- ---------------------------------------------------------------------------
-- Directory view (EMP-12): non-sensitive columns of every colleague in my companies,
-- used by chat, tasks and pickers. Runs as view owner, filtered by membership.
-- ---------------------------------------------------------------------------
create or replace view public.employee_directory as
select e.id, e.company_id, e.user_id, e.emp_code, e.first_name, e.last_name,
       trim(e.first_name || ' ' || coalesce(e.last_name, '')) as full_name,
       e.email, e.phone, e.photo_url, e.branch_id, e.department_id, e.designation_id,
       e.reporting_manager_id, e.status, e.date_of_joining,
       d.name as department, g.name as designation, b.name as branch
from public.employees e
left join public.departments d on d.id = e.department_id
left join public.designations g on g.id = e.designation_id
left join public.branches b on b.id = e.branch_id
where public.is_member(e.company_id);

-- ---------------------------------------------------------------------------
-- Documents, device mapping, change requests, lifecycle events, onboarding checklist
-- ---------------------------------------------------------------------------
create table public.employee_documents (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  employee_id   uuid not null references public.employees(id) on delete cascade,
  name          text not null,
  doc_type      text not null default 'other',
  storage_path  text not null,
  expiry_date   date,
  uploaded_by   uuid,
  created_at    timestamptz not null default now()
);

create table public.employee_change_requests (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  employee_id   uuid not null references public.employees(id) on delete cascade,
  field         text not null check (field in ('pan','bank')),
  payload_enc   text not null,        -- encrypted JSON of requested values
  summary       text,                 -- masked summary for reviewers
  status        text not null default 'pending' check (status in ('pending','approved','rejected')),
  reviewed_by   uuid,
  reviewed_at   timestamptz,
  created_at    timestamptz not null default now()
);

create table public.employee_events (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id) on delete cascade,
  employee_id    uuid not null references public.employees(id) on delete cascade,
  kind           text not null check (kind in ('joined','transfer','promotion','resignation','exit','deactivated','reactivated')),
  effective_date date not null default current_date,
  details        jsonb not null default '{}',
  created_by     uuid default auth.uid(),
  created_at     timestamptz not null default now()
);

create table public.onboarding_items (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  employee_id   uuid not null references public.employees(id) on delete cascade,
  item          text not null,
  done          boolean not null default false,
  done_at       timestamptz
);

create table public.assets (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  employee_id   uuid references public.employees(id) on delete set null,
  name          text not null,
  serial_no     text,
  issued_on     date,
  returned_on   date
);

-- default onboarding checklist when an employee is created
create or replace function public.employees_after_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.onboarding_items (company_id, employee_id, item)
  select new.company_id, new.id, x from unnest(array[
    'Offer letter signed', 'ID and address proof collected', 'PAN and bank details verified',
    'Biometric device ID mapped', 'Login invite accepted', 'Assets issued']) x;
  insert into public.employee_events (company_id, employee_id, kind, effective_date)
  values (new.company_id, new.id, 'joined', new.date_of_joining);
  return null;
end $$;
create trigger employees_after_insert after insert on public.employees
  for each row execute function public.employees_after_insert();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.shifts                   enable row level security;
alter table public.employees                enable row level security;
alter table public.employee_documents       enable row level security;
alter table public.employee_change_requests enable row level security;
alter table public.employee_events          enable row level security;
alter table public.onboarding_items         enable row level security;
alter table public.assets                   enable row level security;

create policy shifts_select on public.shifts for select using (public.is_member(company_id));
create policy shifts_write on public.shifts for all using (public.is_hr(company_id)) with check (public.is_hr(company_id));

create policy employees_select on public.employees for select using (
  public.is_hr(company_id) or user_id = auth.uid() or public.is_manager_of(id));
create policy employees_insert on public.employees for insert with check (public.is_hr(company_id));
create policy employees_update on public.employees for update
  using (public.is_hr(company_id) or user_id = auth.uid())
  with check (public.is_hr(company_id) or user_id = auth.uid());
create policy employees_delete on public.employees for delete using (public.has_role(company_id, array['owner','company_admin']));

create policy docs_select on public.employee_documents for select using (public.can_view_employee(employee_id));
create policy docs_write on public.employee_documents for all using (public.is_hr(company_id)) with check (public.is_hr(company_id));

create policy ecr_select on public.employee_change_requests for select using (public.can_view_employee(employee_id));
create policy ecr_insert on public.employee_change_requests for insert with check (
  employee_id = public.my_employee_id(company_id) or public.is_hr(company_id));
create policy ecr_update on public.employee_change_requests for update using (public.is_hr(company_id)) with check (public.is_hr(company_id));

create policy events_select on public.employee_events for select using (public.can_view_employee(employee_id));
create policy events_write on public.employee_events for insert with check (public.is_hr(company_id));

create policy onboarding_select on public.onboarding_items for select using (public.can_view_employee(employee_id));
create policy onboarding_write on public.onboarding_items for all using (public.is_hr(company_id)) with check (public.is_hr(company_id));

create policy assets_select on public.assets for select using (public.is_hr(company_id) or employee_id = public.my_employee_id(company_id));
create policy assets_write on public.assets for all using (public.is_hr(company_id)) with check (public.is_hr(company_id));
