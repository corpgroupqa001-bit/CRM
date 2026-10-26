-- corpgroup.com · 0023 one person, several companies: Super Admin manages company assignments
--
-- The schema already models this as a normalized many-to-many between a person and companies:
--   * the person    = one login (auth.users / profiles), one password;
--   * an assignment = per company, the employees row (department, designation, reporting manager,
--                     employment status, joining date) + the company_members row (access role, active).
-- Attendance, leave, payroll and documents hang off the per-company employees row, which is what
-- keeps one company's data out of another's. So no second assignments table is created; instead:
--   1. a person can't get two employee records in the same company (unique company + user);
--   2. employee_company_assignments: a read-only view of the assignments (RLS of the base tables);
--   3. Super Admin functions to assign a person to another company, edit the company-specific details,
--      deactivate / reactivate one company only, and read the assignment history. All audited.
--      Only non-sensitive identity (name, email, phone) is copied into a new company: never PAN,
--      Aadhaar, bank, salary, payroll or permissions.

-- ---------------------------------------------------------------------------
-- 1. One employee record per person per company
-- ---------------------------------------------------------------------------
create unique index if not exists employees_company_user on public.employees (company_id, user_id) where user_id is not null;

-- ---------------------------------------------------------------------------
-- 2. The assignments, as one view (security_invoker: each caller sees only what RLS lets them see)
-- ---------------------------------------------------------------------------
create or replace view public.employee_company_assignments with (security_invoker = true) as
select e.id                    as id,              -- the company-specific employee record
       e.user_id               as user_id,         -- the person (one login across companies)
       e.id                    as employee_id,
       e.company_id,
       e.department_id,
       e.designation_id,
       e.reporting_manager_id,
       e.status                as employment_status,
       e.date_of_joining,
       m.role,
       (coalesce(m.active, false) and e.status in ('active','notice') and e.removed_at is null) as is_active,
       e.created_at,
       e.updated_at
from public.employees e
left join public.company_members m on m.company_id = e.company_id and m.user_id = e.user_id
where e.user_id is not null;
grant select on public.employee_company_assignments to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Super Admin functions
-- ---------------------------------------------------------------------------
create or replace function public.sa_assignment_log(p_company uuid, p_user uuid, p_action text, p_data jsonb)
returns void language sql security definer set search_path = public as $$
  insert into public.audit_log (company_id, user_id, table_name, record_id, action, new_data, ip)
  values (p_company, auth.uid(), 'company_assignments', p_user::text, p_action, p_data, public.request_ip());
$$;
revoke execute on function public.sa_assignment_log(uuid, uuid, text, jsonb) from public, anon, authenticated;

-- every company, with this person's assignment there (or none)
create or replace function public.sa_person_assignments(p_user uuid)
returns table (company_id uuid, company_name text, company_status text, employee_id uuid, emp_code text,
               department_id uuid, department text, designation_id uuid, designation text,
               reporting_manager_id uuid, reporting_manager text, employment_status text, date_of_joining date,
               role text, member_active boolean, is_active boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_super_admin() then raise exception 'Super admin only' using errcode = '42501'; end if;
  return query
    select c.id, c.name, c.status, e.id, e.emp_code,
           e.department_id, d.name, e.designation_id, g.name,
           e.reporting_manager_id, trim(rm.first_name || ' ' || coalesce(rm.last_name, '')),
           e.status, e.date_of_joining, m.role, m.active,
           coalesce(m.active, false) and coalesce(e.status in ('active','notice'), false) and e.removed_at is null
    from public.companies c
    left join public.employees e on e.company_id = c.id and e.user_id = p_user
    left join public.company_members m on m.company_id = c.id and m.user_id = p_user
    left join public.departments d on d.id = e.department_id
    left join public.designations g on g.id = e.designation_id
    left join public.employees rm on rm.id = e.reporting_manager_id
    order by c.name;
end $$;

-- shared checks for the company-specific details
create or replace function public.sa_check_assignment(p_company uuid, p_role text, p_department uuid, p_designation uuid)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if p_role is null or p_role not in ('company_admin','hr','finance','manager','employee') then
    raise exception 'Choose an access role (the owner is set only when a company is created)';
  end if;
  if p_department is not null and not exists (select 1 from public.departments where id = p_department and company_id = p_company) then
    raise exception 'Department belongs to a different company' using errcode = '23503';
  end if;
  if p_designation is not null and not exists (select 1 from public.designations where id = p_designation and company_id = p_company) then
    raise exception 'Designation belongs to a different company' using errcode = '23503';
  end if;
  if p_designation is not null and p_department is not null
     and not exists (select 1 from public.designations where id = p_designation and department_id = p_department) then
    raise exception 'That designation is not part of the selected department' using errcode = '23514';
  end if;
end $$;
revoke execute on function public.sa_check_assignment(uuid, text, uuid, uuid) from public, anon, authenticated;

-- add a person to a company (or bring back a deactivated assignment), with that company's details
create or replace function public.sa_assign_company(p_user uuid, p_company uuid, p_role text, p_department uuid,
  p_designation uuid, p_manager uuid, p_joining date)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_emp uuid; v_src public.employees%rowtype; v_profile public.profiles%rowtype; v_first text; v_last text; v_owner boolean;
begin
  if not public.is_super_admin() then raise exception 'Super admin only' using errcode = '42501'; end if;
  if p_user = auth.uid() then raise exception 'You can''t change your own company access' using errcode = '42501'; end if;
  if not exists (select 1 from public.companies where id = p_company and status = 'active') then raise exception 'Choose an active company'; end if;
  select * into v_profile from public.profiles where id = p_user;
  if v_profile.id is null then raise exception 'No account for this person'; end if;
  select exists (select 1 from public.company_members where company_id = p_company and user_id = p_user and role = 'owner') into v_owner;
  if v_owner then raise exception 'This person owns the company; their access there can''t be changed here'; end if;
  perform public.sa_check_assignment(p_company, p_role, p_department, p_designation);

  -- their record in that company: linked by login, or an unlinked record HR made with the same email
  select id into v_emp from public.employees where company_id = p_company and user_id = p_user;
  if v_emp is null then
    select id into v_emp from public.employees
    where company_id = p_company and user_id is null and lower(email) = lower(v_profile.email) limit 1;
  end if;

  if v_emp is null then
    -- name and phone from their most recent record elsewhere; nothing sensitive is copied
    select * into v_src from public.employees where user_id = p_user order by updated_at desc limit 1;
    v_first := coalesce(v_src.first_name, nullif(split_part(coalesce(v_profile.full_name, ''), ' ', 1), ''), split_part(v_profile.email, '@', 1));
    v_last := case when v_src.id is not null then v_src.last_name
                   else nullif(trim(substr(coalesce(v_profile.full_name, ''), length(v_first) + 1)), '') end;
    insert into public.employees (company_id, user_id, first_name, last_name, email, phone, department_id, designation_id,
                                  reporting_manager_id, date_of_joining, invite_role)
    values (p_company, p_user, v_first, v_last, v_profile.email, v_src.phone, p_department, p_designation,
            p_manager, coalesce(p_joining, current_date), p_role)
    returning id into v_emp;
    perform public.sa_assignment_log(p_company, p_user, 'assign',
      jsonb_build_object('employee_id', v_emp, 'role', p_role, 'department_id', p_department, 'designation_id', p_designation));
  else
    update public.employees set user_id = p_user, department_id = p_department, designation_id = p_designation,
           reporting_manager_id = p_manager, invite_role = p_role,
           date_of_joining = coalesce(p_joining, date_of_joining),
           status = case when status in ('inactive','exited') or removed_at is not null then 'active' else status end,
           last_working_day = case when status in ('inactive','exited') or removed_at is not null then null else last_working_day end,
           removed_at = null
    where id = v_emp;
    perform public.sa_assignment_log(p_company, p_user, 'reassign',
      jsonb_build_object('employee_id', v_emp, 'role', p_role, 'department_id', p_department, 'designation_id', p_designation));
  end if;

  insert into public.company_members (company_id, user_id, role, active) values (p_company, p_user, p_role, true)
  on conflict (company_id, user_id) do update set role = excluded.role, active = true;
  return v_emp;
end $$;

-- edit the company-specific details of an existing assignment
create or replace function public.sa_update_assignment(p_user uuid, p_company uuid, p_role text, p_department uuid,
  p_designation uuid, p_manager uuid, p_joining date)
returns void language plpgsql security definer set search_path = public as $$
declare v_emp uuid;
begin
  if not public.is_super_admin() then raise exception 'Super admin only' using errcode = '42501'; end if;
  if p_user = auth.uid() then raise exception 'You can''t change your own company access' using errcode = '42501'; end if;
  select id into v_emp from public.employees where company_id = p_company and user_id = p_user;
  if v_emp is null then raise exception 'This person is not assigned to that company'; end if;
  if exists (select 1 from public.company_members where company_id = p_company and user_id = p_user and role = 'owner') then
    -- the owner keeps the owner role; only the job details change
    perform public.sa_check_assignment(p_company, 'employee', p_department, p_designation);
  else
    perform public.sa_check_assignment(p_company, p_role, p_department, p_designation);
    update public.company_members set role = p_role where company_id = p_company and user_id = p_user;
    update public.employees set invite_role = p_role where id = v_emp;
  end if;
  update public.employees set department_id = p_department, designation_id = p_designation, reporting_manager_id = p_manager,
         date_of_joining = coalesce(p_joining, date_of_joining)
  where id = v_emp;
  perform public.sa_assignment_log(p_company, p_user, 'update',
    jsonb_build_object('employee_id', v_emp, 'role', p_role, 'department_id', p_department, 'designation_id', p_designation,
                       'reporting_manager_id', p_manager, 'date_of_joining', p_joining));
end $$;

-- switch one company's access off or on; other companies are untouched. Returns how many active
-- companies the person has left (the app blocks the login entirely when that reaches 0).
create or replace function public.sa_set_assignment_active(p_user uuid, p_company uuid, p_active boolean, p_reason text)
returns integer language plpgsql security definer set search_path = public as $$
declare v_emp uuid; v_left integer;
begin
  if not public.is_super_admin() then raise exception 'Super admin only' using errcode = '42501'; end if;
  if p_user = auth.uid() then raise exception 'You can''t change your own company access' using errcode = '42501'; end if;
  select id into v_emp from public.employees where company_id = p_company and user_id = p_user;
  if v_emp is null then raise exception 'This person is not assigned to that company'; end if;
  if not p_active and exists (select 1 from public.company_members where company_id = p_company and user_id = p_user and role = 'owner') then
    raise exception 'The company owner''s access can''t be switched off';
  end if;
  update public.company_members set active = p_active where company_id = p_company and user_id = p_user;
  if p_active then
    update public.employees set status = 'active', last_working_day = null, removed_at = null where id = v_emp;
  else
    update public.employees set status = 'inactive' where id = v_emp;
    delete from public.device_user_map where employee_id = v_emp;     -- biometric IDs released in this company only
  end if;
  insert into public.employee_events (company_id, employee_id, kind, details)
  values (p_company, v_emp, case when p_active then 'reactivated' else 'deactivated' end,
          jsonb_build_object('note', nullif(trim(coalesce(p_reason, '')), ''), 'by_super_admin', true));
  perform public.sa_assignment_log(p_company, p_user, case when p_active then 'reactivate' else 'deactivate' end,
    jsonb_build_object('employee_id', v_emp, 'reason', p_reason));
  select count(*) into v_left from public.company_members where user_id = p_user and active;
  return v_left;
end $$;

-- assignment changes of a person across every company, newest first
create or replace function public.sa_assignment_history(p_user uuid)
returns table (at timestamptz, company_name text, action text, by_email text, details jsonb)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_super_admin() then raise exception 'Super admin only' using errcode = '42501'; end if;
  return query
    select a.at, c.name, a.action, p.email, coalesce(a.new_data, '{}'::jsonb)
    from public.audit_log a
    left join public.companies c on c.id = a.company_id
    left join public.profiles p on p.id = a.user_id
    where (a.table_name = 'company_assignments' and a.record_id = p_user::text)
       or (a.table_name = 'company_members' and (a.new_data ->> 'user_id' = p_user::text or a.old_data ->> 'user_id' = p_user::text))
    order by a.at desc
    limit 200;
end $$;

revoke execute on function public.sa_person_assignments(uuid) from public, anon;
revoke execute on function public.sa_assign_company(uuid, uuid, text, uuid, uuid, uuid, date) from public, anon;
revoke execute on function public.sa_update_assignment(uuid, uuid, text, uuid, uuid, uuid, date) from public, anon;
revoke execute on function public.sa_set_assignment_active(uuid, uuid, boolean, text) from public, anon;
revoke execute on function public.sa_assignment_history(uuid) from public, anon;
grant execute on function public.sa_person_assignments(uuid) to authenticated;
grant execute on function public.sa_assign_company(uuid, uuid, text, uuid, uuid, uuid, date) to authenticated;
grant execute on function public.sa_update_assignment(uuid, uuid, text, uuid, uuid, uuid, date) to authenticated;
grant execute on function public.sa_set_assignment_active(uuid, uuid, boolean, text) to authenticated;
grant execute on function public.sa_assignment_history(uuid) to authenticated;
