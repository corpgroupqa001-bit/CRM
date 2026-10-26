-- corpgroup.com · 0021 candidate sign-up with admin approval, designation-based access, employee removal
--
--   * A candidate signs up for a company with their designation (and phone, department). They can't
--     use the app until an Owner / Administrator of that company approves them. Approval happens once.
--   * Each designation can carry an access role (set by an Administrator only). On approval that role
--     is suggested; the approving Administrator confirms or changes it. A designation the candidate
--     picks never grants access by itself.
--   * Removing an employee: exited, login revoked (by the app), hidden from lists (removed_at); their
--     attendance and payroll history stays.

-- ===========================================================================
-- 1. Designation → access role (Administrator only)
-- ===========================================================================
alter table public.designations add column if not exists access_role text
  check (access_role in ('company_admin','hr','finance','manager','employee'));

create or replace function public.designations_access_guard()
returns trigger language plpgsql as $$
begin
  if auth.uid() is not null
     and new.access_role is distinct from (case when tg_op = 'UPDATE' then old.access_role end)
     and not public.has_perm(new.company_id, 'employees.assign_role') then
    raise exception 'Only an administrator can set the access role of a designation' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists designations_access_guard on public.designations;
create trigger designations_access_guard before insert or update on public.designations
  for each row execute function public.designations_access_guard();

-- ===========================================================================
-- 2. Join requests
-- ===========================================================================
create table if not exists public.join_requests (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  full_name       text not null,
  email           text not null,
  phone           text,
  designation_id  uuid references public.designations(id) on delete set null,
  department_id   uuid references public.departments(id) on delete set null,
  note            text,
  status          text not null default 'pending' check (status in ('pending','approved','rejected')),
  role            text,
  employee_id     uuid references public.employees(id) on delete set null,
  decided_by      uuid,
  decided_at      timestamptz,
  decision_note   text,
  created_at      timestamptz not null default now(),
  unique (company_id, user_id)
);
create index if not exists join_requests_pending on public.join_requests (company_id) where status = 'pending';
alter table public.join_requests enable row level security;
drop policy if exists jr_select on public.join_requests;
-- the candidate sees their own request; the company's administrators see all of theirs.
-- No insert / update policy: only the functions below change requests.
create policy jr_select on public.join_requests for select
  using (user_id = auth.uid() or public.has_perm(company_id, 'employees.account'));

create or replace function public.submit_join_request(p_company uuid, p_full_name text, p_phone text,
  p_designation uuid, p_department uuid, p_note text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_email text; v_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  if not exists (select 1 from public.companies where id = p_company and status = 'active') then raise exception 'Choose a company'; end if;
  if coalesce(trim(p_full_name), '') = '' then raise exception 'Enter your full name'; end if;
  if p_designation is null or not exists (select 1 from public.designations where id = p_designation and company_id = p_company) then
    raise exception 'Choose your designation';
  end if;
  if p_department is not null and not exists (select 1 from public.departments where id = p_department and company_id = p_company) then
    raise exception 'Unknown department';
  end if;
  if exists (select 1 from public.company_members where company_id = p_company and user_id = auth.uid()) then
    raise exception 'You already belong to this company';
  end if;
  select email into v_email from public.profiles where id = auth.uid();
  insert into public.join_requests (company_id, user_id, full_name, email, phone, designation_id, department_id, note)
  values (p_company, auth.uid(), trim(p_full_name), v_email, nullif(trim(p_phone), ''), p_designation, p_department, nullif(trim(p_note), ''))
  on conflict (company_id, user_id) do update set full_name = excluded.full_name, phone = excluded.phone,
    designation_id = excluded.designation_id, department_id = excluded.department_id, note = excluded.note,
    status = 'pending', decided_by = null, decided_at = null, decision_note = null, created_at = now()
    where public.join_requests.status <> 'approved'
  returning id into v_id;
  if v_id is null then raise exception 'Your request was already approved'; end if;
  perform public.notify_roles(p_company, array['owner','company_admin'], 'New sign-up waiting for approval',
    trim(p_full_name) || ' (' || v_email || ')', '/c/' || p_company || '/employees/approvals');
  return v_id;
end $$;

create or replace function public.approve_join_request(p_request uuid, p_role text)
returns uuid language plpgsql security definer set search_path = public as $$
declare r public.join_requests%rowtype; v_emp uuid; v_first text; v_last text;
begin
  select * into r from public.join_requests where id = p_request;
  if r.id is null or not (public.has_perm(r.company_id, 'employees.account') and public.has_perm(r.company_id, 'employees.assign_role')) then
    raise exception 'Only an administrator can approve sign-ups' using errcode = '42501';
  end if;
  if r.status <> 'pending' then raise exception 'This request was already %', r.status; end if;
  if p_role is null or p_role not in ('company_admin','hr','finance','manager','employee') then raise exception 'Choose an access role'; end if;

  -- link an existing record with this email (e.g. added by HR earlier), otherwise create one
  select id into v_emp from public.employees
  where company_id = r.company_id and lower(email) = lower(r.email) and user_id is null and removed_at is null limit 1;
  v_first := split_part(r.full_name, ' ', 1);
  v_last := nullif(trim(substr(r.full_name, length(v_first) + 1)), '');
  if v_emp is null then
    insert into public.employees (company_id, user_id, first_name, last_name, email, phone, designation_id, department_id, date_of_joining, invite_role)
    values (r.company_id, r.user_id, v_first, v_last, r.email, r.phone, r.designation_id, r.department_id, current_date, p_role)
    returning id into v_emp;
  else
    update public.employees set user_id = r.user_id, phone = coalesce(phone, r.phone),
      designation_id = coalesce(r.designation_id, designation_id), department_id = coalesce(r.department_id, department_id),
      invite_role = p_role
    where id = v_emp;
  end if;
  insert into public.company_members (company_id, user_id, role, active) values (r.company_id, r.user_id, p_role, true)
  on conflict (company_id, user_id) do update set role = excluded.role, active = true;
  update public.join_requests set status = 'approved', role = p_role, employee_id = v_emp, decided_by = auth.uid(), decided_at = now()
  where id = p_request;
  insert into public.audit_log (company_id, user_id, table_name, record_id, action, new_data, ip)
  values (r.company_id, auth.uid(), 'join_requests', p_request::text, 'approve',
          jsonb_build_object('email', r.email, 'role', p_role, 'employee_id', v_emp), public.request_ip());
  perform public.notify(r.user_id, r.company_id, 'Your account was approved', 'You can now sign in.', '/c/' || r.company_id || '/dashboard');
  return v_emp;
end $$;

create or replace function public.reject_join_request(p_request uuid, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare r public.join_requests%rowtype;
begin
  select * into r from public.join_requests where id = p_request;
  if r.id is null or not public.has_perm(r.company_id, 'employees.account') then
    raise exception 'Only an administrator can reject sign-ups' using errcode = '42501';
  end if;
  if r.status <> 'pending' then raise exception 'This request was already %', r.status; end if;
  update public.join_requests set status = 'rejected', decided_by = auth.uid(), decided_at = now(), decision_note = nullif(trim(p_note), '')
  where id = p_request;
  insert into public.audit_log (company_id, user_id, table_name, record_id, action, new_data, ip)
  values (r.company_id, auth.uid(), 'join_requests', p_request::text, 'reject', jsonb_build_object('email', r.email, 'note', p_note), public.request_ip());
end $$;

revoke execute on function public.submit_join_request(uuid, text, text, uuid, uuid, text) from public, anon;
revoke execute on function public.approve_join_request(uuid, text) from public, anon;
revoke execute on function public.reject_join_request(uuid, text) from public, anon;
grant execute on function public.submit_join_request(uuid, text, text, uuid, uuid, text) to authenticated;
grant execute on function public.approve_join_request(uuid, text) to authenticated;
grant execute on function public.reject_join_request(uuid, text) to authenticated;

-- ===========================================================================
-- 3. Removed employees are hidden (history kept)
-- ===========================================================================
alter table public.employees add column if not exists removed_at timestamptz;

drop view if exists public.employee_directory;
create view public.employee_directory as
select e.id, e.company_id, e.user_id, e.emp_code, e.first_name, e.last_name,
       trim(e.first_name || ' ' || coalesce(e.last_name, '')) as full_name,
       e.email, e.photo_url, e.branch_id, e.department_id, e.designation_id, e.reporting_manager_id, e.status,
       d.name as department, g.name as designation, b.name as branch
from public.employees e
left join public.departments d on d.id = e.department_id
left join public.designations g on g.id = e.designation_id
left join public.branches b on b.id = e.branch_id
where public.is_member(e.company_id) and e.removed_at is null;
grant select on public.employee_directory to authenticated;
