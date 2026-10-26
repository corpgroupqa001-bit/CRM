-- corpgroup.com · 0018 role-based access control
--
--   * Super Admin: a platform-level role in its own table (platform_admins), never granted
--     automatically and never a company member. It manages companies and their administrators
--     through checked functions; it gets no access to employee, attendance or payroll data.
--   * Company roles: owner / company_admin (Administrator), hr (HR Manager), finance (new:
--     Finance / Payroll), manager, employee — stored in company_members.role.
--   * Explicit permissions: role_permissions maps each role to named permissions; has_perm()
--     is what policies and functions check. Designation never grants access.
--   * Inactive or exited employees lose all company access, even if their membership row is active.
--
-- Module matrix implemented here:
--   Employees   Administrator full · HR records (no create / invite / login / role) · Finance pay
--               fields only · Manager own team · Employee own profile
--   Attendance  all roles, scoped: Administrator / HR manage · Finance read for payroll · Manager team ·
--               Employee own
--   Salaries    Administrator + Finance full (approval stays with the Administrator) · HR view-only ·
--               Manager / Employee none (an employee still receives their own approved payslip)
--   Tasks       Administrator + Manager full · HR view-only · Employee assigned tasks · Finance none
--   Chat        every active member

-- ===========================================================================
-- 1. Roles
-- ===========================================================================
alter table public.company_members drop constraint if exists company_members_role_check;
alter table public.company_members add constraint company_members_role_check
  check (role in ('owner','company_admin','hr','finance','manager','employee'));
alter table public.employees drop constraint if exists employees_invite_role_check;
alter table public.employees add constraint employees_invite_role_check
  check (invite_role in ('company_admin','hr','finance','manager','employee'));

-- ===========================================================================
-- 2. Explicit permissions per role (read-only to the app; changed only by migrations)
-- ===========================================================================
create table if not exists public.role_permissions (
  role        text not null check (role in ('owner','company_admin','hr','finance','manager','employee')),
  permission  text not null,
  primary key (role, permission)
);
alter table public.role_permissions enable row level security;
drop policy if exists rp_read on public.role_permissions;
create policy rp_read on public.role_permissions for select to authenticated using (true);

delete from public.role_permissions;
insert into public.role_permissions (role, permission)
select r, p from (values ('owner'), ('company_admin')) roles(r),
  unnest(array[
    'employees.create','employees.read_all','employees.update','employees.delete','employees.account','employees.assign_role',
    'employees.pay_fields',
    'attendance.read_all','attendance.manage','attendance.approve','attendance.unlock',
    'salaries.read','salaries.manage','salaries.approve',
    'tasks.use','tasks.read_all','tasks.manage','tasks.manage_all',
    'chat.use','announcements.post','settings.manage','settings.org','audit.read','leave.manage'
  ]) p
union all
select 'hr', p from unnest(array[
  'employees.read_all','employees.update','employees.pay_fields',
  'attendance.read_all','attendance.manage','attendance.approve',
  'salaries.read',
  'tasks.use','tasks.read_all',
  'chat.use','announcements.post','settings.org','audit.read','leave.manage']) p
union all
select 'finance', p from unnest(array[
  'employees.pay_fields', 'attendance.read_all', 'salaries.read', 'salaries.manage', 'chat.use']) p
union all
select 'manager', p from unnest(array[
  'employees.read_team', 'attendance.read_team', 'attendance.approve', 'tasks.use', 'tasks.read_team', 'tasks.manage', 'chat.use']) p
union all
select 'employee', p from unnest(array['tasks.use', 'chat.use']) p;

-- ===========================================================================
-- 3. Membership checks: active membership AND an employee record that is not inactive / exited
-- ===========================================================================
create or replace function public.in_good_standing(cid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select not exists (
    select 1 from public.employees e
    where e.company_id = cid and e.user_id = auth.uid() and e.status in ('inactive','exited')
  );
$$;

create or replace function public.is_member(cid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.company_members m
    where m.company_id = cid and m.user_id = auth.uid() and m.active
  ) and public.in_good_standing(cid);
$$;

create or replace function public.has_role(cid uuid, roles text[])
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.company_members m
    where m.company_id = cid and m.user_id = auth.uid() and m.active and m.role = any(roles)
  ) and public.in_good_standing(cid);
$$;

create or replace function public.has_perm(cid uuid, perm text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.company_members m
    join public.role_permissions rp on rp.role = m.role
    where m.company_id = cid and m.user_id = auth.uid() and m.active and rp.permission = perm
  ) and public.in_good_standing(cid);
$$;

-- what the signed-in user may do in a company — the app loads this server-side on every request
create or replace function public.my_access(cid uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when m.user_id is null then jsonb_build_object('allowed', false, 'reason', 'not_member')
              when not m.active then jsonb_build_object('allowed', false, 'reason', 'membership_inactive')
              when not public.in_good_standing(cid) then jsonb_build_object('allowed', false, 'reason', 'employee_inactive')
              else jsonb_build_object('allowed', true, 'role', m.role,
                     'permissions', coalesce((select jsonb_agg(rp.permission order by rp.permission) from public.role_permissions rp where rp.role = m.role), '[]'))
         end
  from (select 1) one
  left join public.company_members m on m.company_id = cid and m.user_id = auth.uid();
$$;

-- ===========================================================================
-- 4. Super Admin (platform level)
-- ===========================================================================
create table if not exists public.platform_admins (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  granted_by  uuid,
  granted_at  timestamptz not null default now(),
  note        text
);
alter table public.platform_admins enable row level security;
drop policy if exists pa_self on public.platform_admins;
-- a user can see whether they are a super admin; nobody can grant it through the API
create policy pa_self on public.platform_admins for select using (user_id = auth.uid());

create or replace function public.is_super_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid());
$$;

create or replace function public.sa_companies()
returns table (id uuid, name text, status text, plan text, employee_limit integer, renewal_date date, created_at timestamptz,
               owner_email text, active_employees bigint, admins jsonb)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_super_admin() then raise exception 'Super admin only' using errcode = '42501'; end if;
  return query
    select c.id, c.name, c.status, c.plan, c.employee_limit, c.renewal_date, c.created_at,
           (select p.email from public.profiles p where p.id = c.owner_id),
           (select count(*) from public.employees e where e.company_id = c.id and e.status in ('active','notice')),
           coalesce((select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'email', p.email, 'role', m.role, 'active', m.active) order by p.email)
                     from public.company_members m join public.profiles p on p.id = m.user_id
                     where m.company_id = c.id and m.role in ('owner','company_admin')), '[]')
    from public.companies c order by c.created_at desc;
end $$;

create or replace function public.sa_update_company(p_company uuid, p_plan text, p_employee_limit integer, p_renewal date, p_status text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_super_admin() then raise exception 'Super admin only' using errcode = '42501'; end if;
  if p_status not in ('active','archived') then raise exception 'Unknown status %', p_status; end if;
  update public.companies set plan = coalesce(p_plan, plan), employee_limit = p_employee_limit, renewal_date = p_renewal,
    status = p_status, archived_at = case when p_status = 'archived' then coalesce(archived_at, now()) else null end
  where id = p_company;
  insert into public.audit_log (company_id, user_id, table_name, record_id, action, new_data, ip)
  values (p_company, auth.uid(), 'companies', p_company::text, 'super_admin_update',
          jsonb_build_object('plan', p_plan, 'employee_limit', p_employee_limit, 'renewal_date', p_renewal, 'status', p_status), public.request_ip());
end $$;

-- make an existing user a company administrator. Only the membership is created: no employee record,
-- and super admins never become members by doing this.
create or replace function public.sa_set_company_admin(p_company uuid, p_email text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_user uuid; v_role text;
begin
  if not public.is_super_admin() then raise exception 'Super admin only' using errcode = '42501'; end if;
  select id into v_user from public.profiles where email = lower(trim(p_email));
  if v_user is null then raise exception 'No account with email %. They must sign up or be invited first.', p_email; end if;
  select role into v_role from public.company_members where company_id = p_company and user_id = v_user;
  if v_role = 'owner' then raise exception 'That user is the company owner already'; end if;
  insert into public.company_members (company_id, user_id, role, active) values (p_company, v_user, 'company_admin', true)
  on conflict (company_id, user_id) do update set role = 'company_admin', active = true;
  insert into public.audit_log (company_id, user_id, table_name, record_id, action, new_data, ip)
  values (p_company, auth.uid(), 'company_members', v_user::text, 'super_admin_grant_admin', jsonb_build_object('email', p_email), public.request_ip());
  return v_user;
end $$;

create or replace function public.sa_remove_company_admin(p_company uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_has_employee boolean;
begin
  if not public.is_super_admin() then raise exception 'Super admin only' using errcode = '42501'; end if;
  if exists (select 1 from public.company_members where company_id = p_company and user_id = p_user and role = 'owner') then
    raise exception 'The owner cannot be removed';
  end if;
  select exists (select 1 from public.employees where company_id = p_company and user_id = p_user) into v_has_employee;
  -- staff keep their place in the company as an employee; an outside administrator loses access
  update public.company_members set role = 'employee', active = v_has_employee
  where company_id = p_company and user_id = p_user and role = 'company_admin';
  insert into public.audit_log (company_id, user_id, table_name, record_id, action, ip)
  values (p_company, auth.uid(), 'company_members', p_user::text, 'super_admin_remove_admin', public.request_ip());
end $$;

revoke execute on function public.sa_companies() from public, anon;
revoke execute on function public.sa_update_company(uuid, text, integer, date, text) from public, anon;
revoke execute on function public.sa_set_company_admin(uuid, text) from public, anon;
revoke execute on function public.sa_remove_company_admin(uuid, uuid) from public, anon;
grant execute on function public.sa_companies() to authenticated;
grant execute on function public.sa_update_company(uuid, text, integer, date, text) to authenticated;
grant execute on function public.sa_set_company_admin(uuid, text) to authenticated;
grant execute on function public.sa_remove_company_admin(uuid, uuid) to authenticated;

-- ===========================================================================
-- 5. Members and system roles: administrators only; the owner row cannot be changed through the API
-- ===========================================================================
drop policy if exists members_write on public.company_members;
create policy members_write on public.company_members for all
  using (public.has_perm(company_id, 'employees.assign_role') and role <> 'owner')
  with check (public.has_perm(company_id, 'employees.assign_role') and role <> 'owner');

-- ===========================================================================
-- 6. Employees
-- ===========================================================================
create or replace function public.can_view_employee(emp uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.employees e
    where e.id = emp and (
      public.has_perm(e.company_id, 'employees.read_all')
      or (e.user_id = auth.uid() and public.in_good_standing(e.company_id))
      or (public.has_perm(e.company_id, 'employees.read_team') and public.is_manager_of(e.id))
    )
  );
$$;

drop policy if exists employees_select on public.employees;
drop policy if exists employees_insert on public.employees;
drop policy if exists employees_update on public.employees;
drop policy if exists employees_delete on public.employees;
create policy employees_select on public.employees for select using (
  public.has_perm(company_id, 'employees.read_all')
  or (user_id = auth.uid() and public.is_member(company_id))
  or (public.has_perm(company_id, 'employees.read_team') and public.is_manager_of(id)));
create policy employees_insert on public.employees for insert with check (public.has_perm(company_id, 'employees.create'));
create policy employees_update on public.employees for update
  using (public.has_perm(company_id, 'employees.update') or (user_id = auth.uid() and public.is_member(company_id)))
  with check (public.has_perm(company_id, 'employees.update') or (user_id = auth.uid() and public.is_member(company_id)));
create policy employees_delete on public.employees for delete using (public.has_perm(company_id, 'employees.delete'));

-- column rules on update: login / role / activation need employees.account; pay fields need
-- employees.pay_fields; everything else needs employees.update; people may edit their own contact details
create or replace function public.employees_before_write()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_seq integer;
  v_prefix text;
  v_allowed text[];
  c_contact constant text[] := array['phone','address','emergency_name','emergency_phone','photo_url'];
  c_pay constant text[] := array['uan','esi_no','pan_enc','pan_last4','bank_account_enc','bank_last4','bank_name','ifsc'];
begin
  if tg_op = 'INSERT' and (new.emp_code is null or new.emp_code = '') then
    update public.companies set next_emp_seq = next_emp_seq + 1
      where id = new.company_id
      returning next_emp_seq - 1, emp_code_prefix into v_seq, v_prefix;
    new.emp_code := v_prefix || lpad(v_seq::text, 4, '0');
  end if;

  if tg_op = 'UPDATE' then
    new.updated_at := now();
    if auth.uid() is not null then              -- server jobs and admin-client actions check permissions themselves
      if new.company_id <> old.company_id then
        raise exception 'An employee record cannot move to another company' using errcode = '42501';
      end if;
      if (new.user_id is distinct from old.user_id or new.invite_role is distinct from old.invite_role
          or (new.status is distinct from old.status and 'inactive' in (new.status, old.status)))
         and not public.has_perm(old.company_id, 'employees.account') then
        raise exception 'Only an administrator can change login access, activation or system role' using errcode = '42501';
      end if;
      if not public.has_perm(old.company_id, 'employees.update') then
        v_allowed := array['updated_at']
          || case when old.user_id = auth.uid() then c_contact else '{}'::text[] end
          || case when public.has_perm(old.company_id, 'employees.pay_fields') then c_pay else '{}'::text[] end;
        if (to_jsonb(new) - v_allowed) is distinct from (to_jsonb(old) - v_allowed) then
          raise exception 'You can''t change these fields; ask HR or submit a change request' using errcode = '42501';
        end if;
      end if;
    end if;
  end if;
  return new;
end $$;

-- Finance works with pay-related fields only: identity + statutory + bank, for its company
create or replace view public.employee_pay_fields as
select e.id, e.company_id, e.emp_code, e.first_name, e.last_name, e.email, e.status, e.date_of_joining, e.last_working_day,
       e.department_id, e.designation_id, e.uan, e.esi_no, e.pan_last4, e.bank_last4, e.bank_name, e.ifsc, e.bank_account_enc
from public.employees e
where public.has_perm(e.company_id, 'employees.pay_fields');

create or replace function public.update_employee_pay_fields(p_emp uuid, p_fields jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_company uuid;
begin
  select company_id into v_company from public.employees where id = p_emp;
  if v_company is null or not public.has_perm(v_company, 'employees.pay_fields') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if exists (select 1 from jsonb_object_keys(p_fields) k
             where k not in ('uan','esi_no','pan_enc','pan_last4','bank_account_enc','bank_last4','bank_name','ifsc')) then
    raise exception 'Only pay-related fields can be changed here';
  end if;
  update public.employees set
    uan = case when p_fields ? 'uan' then p_fields ->> 'uan' else uan end,
    esi_no = case when p_fields ? 'esi_no' then p_fields ->> 'esi_no' else esi_no end,
    pan_enc = case when p_fields ? 'pan_enc' then p_fields ->> 'pan_enc' else pan_enc end,
    pan_last4 = case when p_fields ? 'pan_last4' then p_fields ->> 'pan_last4' else pan_last4 end,
    bank_account_enc = case when p_fields ? 'bank_account_enc' then p_fields ->> 'bank_account_enc' else bank_account_enc end,
    bank_last4 = case when p_fields ? 'bank_last4' then p_fields ->> 'bank_last4' else bank_last4 end,
    bank_name = case when p_fields ? 'bank_name' then p_fields ->> 'bank_name' else bank_name end,
    ifsc = case when p_fields ? 'ifsc' then p_fields ->> 'ifsc' else ifsc end
  where id = p_emp;
end $$;
revoke execute on function public.update_employee_pay_fields(uuid, jsonb) from public, anon;
grant execute on function public.update_employee_pay_fields(uuid, jsonb) to authenticated;

-- ===========================================================================
-- 7. Attendance: Finance reads the company's daily attendance (payroll needs it)
-- ===========================================================================
drop policy if exists att_select on public.daily_attendance;
create policy att_select on public.daily_attendance for select using (
  public.can_view_employee(employee_id) or public.has_perm(company_id, 'attendance.read_all'));

-- ===========================================================================
-- 8. Salaries
-- ===========================================================================
drop policy if exists ss_select on public.salary_structures;
drop policy if exists ss_write on public.salary_structures;
create policy ss_select on public.salary_structures for select using (public.has_perm(company_id, 'salaries.read'));
create policy ss_write on public.salary_structures for all using (public.has_perm(company_id, 'salaries.manage'))
  with check (public.has_perm(company_id, 'salaries.manage'));

drop policy if exists sc_select on public.salary_components;
drop policy if exists sc_write on public.salary_components;
create policy sc_select on public.salary_components for select using (public.has_perm(company_id, 'salaries.read'));
create policy sc_write on public.salary_components for all using (public.has_perm(company_id, 'salaries.manage'))
  with check (public.has_perm(company_id, 'salaries.manage'));

-- an employee no longer reads their own CTC, loans or recovery balance through the API
drop policy if exists ctc_select on public.employee_ctc;
drop policy if exists ctc_write on public.employee_ctc;
create policy ctc_select on public.employee_ctc for select using (public.has_perm(company_id, 'salaries.read'));
create policy ctc_write on public.employee_ctc for all using (public.has_perm(company_id, 'salaries.manage'))
  with check (public.has_perm(company_id, 'salaries.manage'));

drop policy if exists stat_select on public.statutory_settings;
drop policy if exists stat_write on public.statutory_settings;
create policy stat_select on public.statutory_settings for select using (public.has_perm(company_id, 'salaries.read'));
create policy stat_write on public.statutory_settings for update using (public.has_perm(company_id, 'salaries.manage'))
  with check (public.has_perm(company_id, 'salaries.manage'));

drop policy if exists vi_select on public.variable_inputs;
drop policy if exists vi_write on public.variable_inputs;
create policy vi_select on public.variable_inputs for select using (public.has_perm(company_id, 'salaries.read'));
create policy vi_write on public.variable_inputs for all using (public.has_perm(company_id, 'salaries.manage'))
  with check (public.has_perm(company_id, 'salaries.manage'));

drop policy if exists loans_select on public.loans;
drop policy if exists loans_write on public.loans;
create policy loans_select on public.loans for select using (public.has_perm(company_id, 'salaries.read'));
create policy loans_write on public.loans for all using (public.has_perm(company_id, 'salaries.manage'))
  with check (public.has_perm(company_id, 'salaries.manage'));

drop policy if exists rb_select on public.recovery_balances;
create policy rb_select on public.recovery_balances for select using (public.has_perm(company_id, 'salaries.read'));

drop policy if exists runs_select on public.payroll_runs;
create policy runs_select on public.payroll_runs for select using (public.has_perm(company_id, 'salaries.read'));

-- payslips: the Salaries module, plus each employee's own payslip once the run is approved (BRD SAL-12).
-- The run's status is read through a definer helper: employees cannot read payroll_runs themselves.
create or replace function public.payroll_run_locked(p_run uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.payroll_runs where id = p_run and status = 'locked');
$$;
drop policy if exists slips_select on public.payslips;
drop policy if exists slips_update on public.payslips;
-- approved payslips (used by My payslips, the dashboard, YTD and TDS): no join on payroll_runs, which
-- employees cannot read, so an employee sees their own approved payslips here too
create or replace view public.final_payslips with (security_invoker = true) as
select p.* from public.payslips p where public.payroll_run_locked(p.run_id);
create policy slips_select on public.payslips for select using (
  public.has_perm(company_id, 'salaries.read')
  or (employee_id = public.my_employee_id(company_id) and public.is_member(company_id)
      and public.payroll_run_locked(run_id)));
create policy slips_update on public.payslips for update using (public.has_perm(company_id, 'salaries.manage'))
  with check (public.has_perm(company_id, 'salaries.manage'));

-- tax declarations: the employee's own (they declare investments), Finance verifies, HR reads
drop policy if exists td_select on public.tax_declarations;
drop policy if exists td_insert on public.tax_declarations;
drop policy if exists td_update on public.tax_declarations;
create policy td_select on public.tax_declarations for select using (
  public.has_perm(company_id, 'salaries.read') or (employee_id = public.my_employee_id(company_id) and public.is_member(company_id)));
create policy td_insert on public.tax_declarations for insert with check (
  public.has_perm(company_id, 'salaries.manage') or (employee_id = public.my_employee_id(company_id) and public.is_member(company_id)));
create policy td_update on public.tax_declarations for update
  using (public.has_perm(company_id, 'salaries.manage') or (employee_id = public.my_employee_id(company_id) and public.is_member(company_id) and not verified))
  with check (public.has_perm(company_id, 'salaries.manage') or (employee_id = public.my_employee_id(company_id) and public.is_member(company_id) and not verified));

create or replace function public.tax_declarations_before_write()
returns trigger language plpgsql as $$
begin
  new.declared_total := coalesce((select sum(greatest(0, value::numeric)) from jsonb_each_text(new.items)), 0);
  new.updated_at := now();
  if auth.uid() is not null and not public.has_perm(new.company_id, 'salaries.manage') then new.verified := false; end if;
  return new;
end $$;

-- approval of payroll stays with the Administrator (BRD SAL-09); same rule, now as a permission
-- (approve_payroll / reopen_payroll check has_role owner/company_admin, which is the salaries.approve set)

-- ===========================================================================
-- 9. Tasks
-- ===========================================================================
create or replace function public.can_view_task(tid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.tasks t where t.id = tid and (
      public.has_perm(t.company_id, 'tasks.read_all')
      or (public.has_perm(t.company_id, 'tasks.use') and (
        t.created_by = auth.uid()
        or exists (select 1 from public.task_assignees a join public.employees e on e.id = a.employee_id
                   where a.task_id = t.id and (e.user_id = auth.uid()
                     or (public.has_perm(t.company_id, 'tasks.read_team') and public.is_manager_of(e.id))))
        or (t.project_id is not null and public.is_project_member(t.project_id))
      ))
    )
  );
$$;

create or replace function public.can_edit_task(tid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.tasks t where t.id = tid and (
      public.has_perm(t.company_id, 'tasks.manage_all')
      or (public.has_perm(t.company_id, 'tasks.manage') and (
        t.created_by = auth.uid()
        or exists (select 1 from public.task_assignees a join public.employees e on e.id = a.employee_id
                   where a.task_id = t.id and (e.user_id = auth.uid() or public.is_manager_of(e.id)))
        or (t.project_id is not null and public.can_manage_project(t.project_id))))
      -- the assignee works on their own task (status, checklist, comments, time)
      or (public.has_perm(t.company_id, 'tasks.use') and exists (
        select 1 from public.task_assignees a join public.employees e on e.id = a.employee_id
        where a.task_id = t.id and e.user_id = auth.uid()))
    )
  );
$$;

create or replace function public.can_manage_project(pid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.projects p
    left join public.employees e on e.id = p.manager_id
    where p.id = pid and (
      public.has_perm(p.company_id, 'tasks.manage_all')
      or (e.user_id = auth.uid() and public.has_perm(p.company_id, 'tasks.manage'))
    )
  );
$$;

drop policy if exists tasks_select on public.tasks;
drop policy if exists tasks_insert on public.tasks;
drop policy if exists tasks_update on public.tasks;
drop policy if exists tasks_delete on public.tasks;
create policy tasks_select on public.tasks for select using (
  (created_by = auth.uid() and public.has_perm(company_id, 'tasks.use')) or public.can_view_task(id));
create policy tasks_insert on public.tasks for insert with check (
  public.has_perm(company_id, 'tasks.manage') and created_by = auth.uid()
  and (project_id is null or public.can_view_project(project_id)));
create policy tasks_update on public.tasks for update using (public.can_edit_task(id)) with check (public.has_perm(company_id, 'tasks.use'));
create policy tasks_delete on public.tasks for delete using (
  public.has_perm(company_id, 'tasks.manage_all') or (created_by = auth.uid() and public.has_perm(company_id, 'tasks.manage')));

drop policy if exists ta_insert on public.task_assignees;
create policy ta_insert on public.task_assignees for insert with check (
  public.can_edit_task(task_id) and public.has_perm(company_id, 'tasks.manage'));
drop policy if exists ta_delete on public.task_assignees;
create policy ta_delete on public.task_assignees for delete using (public.can_edit_task(task_id) and public.has_perm(company_id, 'tasks.manage'));

-- view-only roles (HR) read tasks but don't comment, attach or log time
drop policy if exists tc_insert on public.task_comments;
create policy tc_insert on public.task_comments for insert with check (public.can_edit_task(task_id) and author_id = auth.uid());
drop policy if exists tat_insert on public.task_attachments;
create policy tat_insert on public.task_attachments for insert with check (public.can_edit_task(task_id));
drop policy if exists ttl_select on public.task_time_logs;
drop policy if exists ttl_write on public.task_time_logs;
create policy ttl_select on public.task_time_logs for select using (public.can_view_task(task_id));
create policy ttl_write on public.task_time_logs for all using (employee_id = public.my_employee_id(company_id) and public.can_edit_task(task_id))
  with check (employee_id = public.my_employee_id(company_id) and public.can_edit_task(task_id));
drop policy if exists tt_write on public.task_templates;
create policy tt_write on public.task_templates for all using (public.has_perm(company_id, 'tasks.manage'))
  with check (public.has_perm(company_id, 'tasks.manage'));
drop policy if exists tt_select on public.task_templates;
create policy tt_select on public.task_templates for select using (public.has_perm(company_id, 'tasks.use') or public.has_perm(company_id, 'tasks.read_all'));

drop policy if exists tasks_write on storage.objects;
create policy tasks_write on storage.objects for insert to authenticated
  with check (bucket_id = 'tasks' and public.can_edit_task(public.storage_part(name, 2)));

-- projects follow tasks: Administrator / Manager create and run them, HR reads, Finance has none
drop policy if exists projects_select on public.projects;
drop policy if exists projects_insert on public.projects;
create policy projects_select on public.projects for select using (
  public.has_perm(company_id, 'tasks.read_all') or (public.has_perm(company_id, 'tasks.manage') and public.is_member(company_id))
  or (public.has_perm(company_id, 'tasks.use') and public.is_project_member(id)));
create policy projects_insert on public.projects for insert with check (public.has_perm(company_id, 'tasks.manage'));

create or replace function public.can_view_project(pid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.projects p where p.id = pid and (
      public.has_perm(p.company_id, 'tasks.read_all') or public.has_perm(p.company_id, 'tasks.manage')
      or (public.has_perm(p.company_id, 'tasks.use') and public.is_project_member(p.id))
    )
  );
$$;

-- ===========================================================================
-- 10. Payroll engine guards: Finance and the Administrator run payroll; HR may view the pre-checks.
--     (bodies unchanged from 0011 / 0006 apart from the permission check)
-- ===========================================================================
create or replace function public.payroll_precheck(p_company uuid, p_month date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_month date := date_trunc('month', p_month)::date; v_end date; out jsonb := '[]';
begin
  if not public.has_perm(p_company, 'salaries.read') then raise exception 'not allowed' using errcode = '42501'; end if;
  v_end := (v_month + interval '1 month - 1 day')::date;
  if not public.is_month_locked(p_company, v_month) then
    out := out || jsonb_build_object('level','error','code','attendance_unlocked','message','Attendance for this month is not locked');
  end if;
  out := out || coalesce((select jsonb_agg(jsonb_build_object('level','warning','code','missing_bank','employee_id',id,
            'message', emp_code || ' ' || first_name || ': bank account or IFSC missing'))
          from public.employees where company_id = p_company and status <> 'inactive' and date_of_joining <= v_end
            and (last_working_day is null or last_working_day >= v_month) and (bank_account_enc is null or ifsc is null)), '[]');
  out := out || coalesce((select jsonb_agg(jsonb_build_object('level','error','code','missing_ctc','employee_id',e.id,
            'message', e.emp_code || ' ' || e.first_name || ': no salary assigned'))
          from public.employees e where e.company_id = p_company and e.status <> 'inactive' and e.date_of_joining <= v_end
            and (e.last_working_day is null or e.last_working_day >= v_month)
            and not exists (select 1 from public.employee_ctc x where x.employee_id = e.id and x.effective_from <= v_end)), '[]');
  out := out || coalesce((select jsonb_build_array(jsonb_build_object('level','error','code','unmapped_punches',
            'message', count(*) || ' unmapped device punches')) from public.punches_raw
          where company_id = p_company and employee_id is null and punched_at >= v_month and punched_at < v_end + 1
          having count(*) > 0), '[]');
  out := out || coalesce((select jsonb_build_array(jsonb_build_object('level','warning','code','missed_punch',
            'message', count(*) || ' days with a missed punch will be paid as LOP unless regularised'))
          from public.daily_attendance where company_id = p_company and status = 'missed_punch'
            and date between v_month and v_end having count(*) > 0), '[]');
  return out;
end $$;

create or replace function public.run_payroll(p_company uuid, p_month date)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  c            public.companies%rowtype;
  st           public.statutory_settings%rowtype;
  e            record;
  v_month      date := date_trunc('month', p_month)::date;
  v_end        date;
  v_dim        integer;
  v_salary_days numeric;
  v_run        uuid;
  v_version    integer;
  v_prev_run   uuid;
  -- per employee
  v_ws date; v_we date; v_window integer;
  v_days       date[]; v_vals numeric[]; v_stats text[];
  d            date; i integer; j integer; k integer;
  a            public.daily_attendance%rowtype;
  v_val        numeric; v_paid boolean;
  v_payable    numeric; v_late integer; v_ot_min integer;
  v_ratio      numeric;
  ctc_old      public.employee_ctc%rowtype; ctc_new public.employee_ctc%rowtype;
  v_w_old      numeric; v_monthly numeric; v_day_value numeric; v_shift_hours numeric;
  comp         record;
  v_slip       uuid;
  v_earned     numeric; v_pf_wage numeric; v_esi_wage numeric; v_taxable numeric; v_basic_full numeric;
  v_ot_amt     numeric; v_bonus numeric; v_incent numeric; v_reimb numeric; v_onetime numeric;
  v_arrears    numeric; v_arrear_ids uuid[]; ar record; v_frac numeric;
  v_encash     numeric; v_gratuity numeric; v_years numeric;
  v_pf numeric; v_esi numeric; v_pt numeric; v_lwf numeric; v_tds numeric;
  v_er_pf numeric; v_er_esi numeric;
  v_fy_start   date; v_months_left integer; v_ytd_taxable numeric; v_ytd_tds numeric; v_full_taxable numeric;
  v_loans      jsonb; v_loan_total numeric; v_recov_prev numeric;
  v_gross_r    numeric; v_stat_r numeric; v_avail numeric; v_other_need numeric; v_other_applied numeric;
  v_ded_r      numeric; v_net numeric; v_carry numeric;
  v_slab       jsonb; v_pt_base numeric;
  v_count integer := 0; v_tot_gross numeric := 0; v_tot_ded numeric := 0; v_tot_net numeric := 0;
  v_warnings   jsonb;
  v_sort       integer;
  v_decl       public.tax_declarations%rowtype;
  v_st         public.statutory_settings%rowtype;
begin
  if not public.has_perm(p_company, 'salaries.manage') then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into c from public.companies where id = p_company;
  select * into st from public.statutory_settings where company_id = p_company;
  if not found then raise exception 'Statutory settings are missing for this company'; end if;

  -- SAL-22: payroll only on a locked attendance month
  if not public.is_month_locked(p_company, v_month) then
    raise exception 'Lock attendance for % before running payroll', to_char(v_month, 'Mon YYYY');
  end if;
  if exists (select 1 from public.payroll_runs where company_id = p_company and month = v_month and status = 'locked') then
    raise exception 'Payroll for % is locked — reopen it first', to_char(v_month, 'Mon YYYY');
  end if;

  v_end := (v_month + interval '1 month - 1 day')::date;
  v_dim := extract(day from v_end)::int;
  v_salary_days := case c.salary_days_basis when '30' then 30 when '26' then 26 else v_dim end;

  select id into v_prev_run from public.payroll_runs where company_id = p_company and month = v_month
    order by version desc limit 1;
  update public.payroll_runs set status = 'superseded' where company_id = p_company and month = v_month and status = 'draft';
  select coalesce(max(version), 0) + 1 into v_version from public.payroll_runs where company_id = p_company and month = v_month;
  v_warnings := public.payroll_precheck(p_company, v_month);

  insert into public.payroll_runs (company_id, month, version, status, ran_by, warnings)
  values (p_company, v_month, v_version, 'draft', auth.uid(), v_warnings) returning id into v_run;

  -- financial year bounds for TDS
  v_fy_start := make_date(case when extract(month from v_month) >= c.fy_start_month then extract(year from v_month)::int
                               else extract(year from v_month)::int - 1 end, c.fy_start_month, 1);

  for e in
    select emp.*, coalesce(sh.full_day_hours, 8) as shift_hours
    from public.employees emp left join public.shifts sh on sh.id = emp.shift_id
    where emp.company_id = p_company and emp.date_of_joining <= v_end
      and (emp.last_working_day is null or emp.last_working_day >= v_month)
      and exists (select 1 from public.employee_ctc x where x.employee_id = emp.id and x.effective_from <= v_end)
    order by emp.emp_code
  loop
    -- ---- Step 1: payable and LOP days from locked attendance (SAL-05/17/23) ----
    v_ws := greatest(v_month, e.date_of_joining);
    v_we := least(v_end, coalesce(e.last_working_day, v_end));
    v_window := v_we - v_ws + 1;
    v_days := '{}'; v_vals := '{}'; v_stats := '{}';
    v_late := 0; v_ot_min := 0;
    for d in select generate_series(v_ws, v_we, interval '1 day')::date loop
      select * into a from public.daily_attendance where employee_id = e.id and date = d;
      if not found then
        a.status := 'absent'; a.late := false; a.ot_approved_minutes := 0; a.leave_type_id := null;
        a.leave_half := false; a.half_present := false;
      end if;
      if a.status = 'on_leave' then
        select lt.paid into v_paid from public.leave_types lt where lt.id = a.leave_type_id;
        v_val := (case when coalesce(v_paid, false) then (case when a.leave_half then 0.5 else 1 end) else 0 end)
               + (case when a.leave_half and a.half_present then 0.5 else 0 end);
      else
        v_val := coalesce((c.payable_map ->> a.status)::numeric, 0);
      end if;
      v_days := v_days || d; v_vals := v_vals || v_val; v_stats := v_stats || a.status;
      if a.late then v_late := v_late + 1; end if;
      v_ot_min := v_ot_min + coalesce(a.ot_approved_minutes, 0);
    end loop;

    -- sandwich rule (SAL-19): an off day between two LOP days is unpaid when the company says so
    if not c.sandwich_paid then
      for i in 1 .. coalesce(array_length(v_days, 1), 0) loop
        if v_stats[i] in ('holiday','weekly_off') then
          j := i - 1; while j >= 1 and v_stats[j] in ('holiday','weekly_off') loop j := j - 1; end loop;
          k := i + 1; while k <= array_length(v_days, 1) and v_stats[k] in ('holiday','weekly_off') loop k := k + 1; end loop;
          if j >= 1 and k <= array_length(v_days, 1) and v_vals[j] = 0 and v_vals[k] = 0 then
            v_vals[i] := 0;
          end if;
        end if;
      end loop;
    end if;

    v_payable := 0;
    for i in 1 .. coalesce(array_length(v_vals, 1), 0) loop v_payable := v_payable + v_vals[i]; end loop;

    -- ---- Step 2: proration ratio, capped at 1.0 (SAL-18) ----
    v_ratio := least(v_payable / v_salary_days, 1);

    -- salary in force; a mid-month revision is weighted by its effective date (SAL-25)
    select * into ctc_old from public.employee_ctc where employee_id = e.id and effective_from <= v_month
      order by effective_from desc limit 1;
    select * into ctc_new from public.employee_ctc where employee_id = e.id and effective_from > v_month
      and effective_from <= v_end order by effective_from desc limit 1;
    if ctc_old.id is null then ctc_old := ctc_new; ctc_new := null; end if;
    if ctc_new.id is not null then
      v_w_old := (ctc_new.effective_from - v_month)::numeric / v_dim;
    else
      v_w_old := 1;
    end if;

    create temp table if not exists _comp (code text, name text, full_amount numeric, taxable boolean, pf boolean, esi boolean, sort integer) on commit drop;
    delete from _comp;
    insert into _comp
    select coalesce(o.code, n.code), coalesce(o.name, n.name),
           coalesce(o.amount, 0) * v_w_old + coalesce(n.amount, 0) * (1 - v_w_old),
           coalesce(o.taxable, n.taxable), coalesce(o.pf, n.pf), coalesce(o.esi, n.esi), coalesce(o.sort, n.sort)
    from public.structure_amounts(ctc_old.structure_id, ctc_old.annual_ctc / 12) o
    full outer join (select * from public.structure_amounts(ctc_new.structure_id, ctc_new.annual_ctc / 12)
                     where ctc_new.id is not null) n on n.code = o.code;

    select coalesce(sum(full_amount), 0) into v_monthly from _comp;
    select coalesce(sum(full_amount) filter (where upper(code) = 'BASIC'), 0) into v_basic_full from _comp;
    v_day_value := v_monthly / v_salary_days;

    insert into public.payslips (run_id, company_id, employee_id, month, salary_days, window_days, payable_days,
        lop_days, late_marks, ot_hours, ratio, monthly_gross, day_value, earned_gross, gross_payable, total_deductions, net_pay)
    values (v_run, p_company, e.id, v_month, v_salary_days, v_window, v_payable, v_window - v_payable, v_late,
        round(v_ot_min / 60.0, 2), v_ratio, v_monthly, v_day_value, 0, 0, 0, 0)
    returning id into v_slip;

    -- every earning component prorated by the same ratio
    v_earned := 0; v_pf_wage := 0; v_esi_wage := 0; v_taxable := 0; v_sort := 0;
    for comp in select * from _comp order by sort loop
      insert into public.payslip_lines (payslip_id, company_id, code, name, kind, full_amount, amount, sort)
      values (v_slip, p_company, comp.code, comp.name, 'earning', comp.full_amount, round(comp.full_amount * v_ratio), comp.sort);
      v_earned := v_earned + comp.full_amount * v_ratio;
      if comp.pf then v_pf_wage := v_pf_wage + comp.full_amount * v_ratio; end if;
      if comp.esi then v_esi_wage := v_esi_wage + comp.full_amount * v_ratio; end if;
      if comp.taxable then v_taxable := v_taxable + comp.full_amount * v_ratio; end if;
      v_sort := greatest(v_sort, comp.sort);
    end loop;

    -- ---- Step 3: arrears, overtime, other earnings, reimbursements ----
    v_arrears := 0; v_arrear_ids := '{}';
    for ar in select x.* from public.employee_ctc x
              where x.employee_id = e.id and not x.arrears_settled and x.effective_from < v_month loop
      for comp in select fp.month, fp.ratio, fp.monthly_gross from public.final_payslips fp
                  where fp.employee_id = e.id and fp.month >= date_trunc('month', ar.effective_from) and fp.month < v_month loop
        v_frac := case when ar.effective_from > comp.month
                       then ((comp.month + interval '1 month')::date - ar.effective_from)::numeric
                            / extract(day from (comp.month + interval '1 month - 1 day'))
                       else 1 end;
        v_arrears := v_arrears + greatest(0, (ar.annual_ctc / 12 - comp.monthly_gross) * comp.ratio * v_frac);
      end loop;
      v_arrear_ids := v_arrear_ids || ar.id;
    end loop;
    if v_arrears > 0 then
      v_sort := v_sort + 1;
      insert into public.payslip_lines (payslip_id, company_id, code, name, kind, amount, sort)
      values (v_slip, p_company, 'ARREARS', 'Arrears (salary revision)', 'earning', round(v_arrears), v_sort);
      v_taxable := v_taxable + v_arrears; v_esi_wage := v_esi_wage + v_arrears;
    end if;

    v_ot_amt := (v_ot_min / 60.0) * v_day_value / e.shift_hours * c.ot_multiplier;
    if v_ot_amt > 0 then
      v_sort := v_sort + 1;
      insert into public.payslip_lines (payslip_id, company_id, code, name, kind, amount, sort)
      values (v_slip, p_company, 'OT', 'Overtime ' || round(v_ot_min / 60.0, 2) || ' h', 'earning', round(v_ot_amt), v_sort);
      v_taxable := v_taxable + v_ot_amt; v_esi_wage := v_esi_wage + v_ot_amt;
    end if;

    select coalesce(sum(amount) filter (where kind = 'bonus'), 0),
           coalesce(sum(amount) filter (where kind = 'incentive'), 0),
           coalesce(sum(amount) filter (where kind = 'reimbursement'), 0),
           coalesce(sum(amount) filter (where kind = 'deduction'), 0)
      into v_bonus, v_incent, v_reimb, v_onetime
    from public.variable_inputs where employee_id = e.id and month = v_month;
    if v_bonus > 0 then
      v_sort := v_sort + 1;
      insert into public.payslip_lines (payslip_id, company_id, code, name, kind, amount, sort)
      values (v_slip, p_company, 'BONUS', 'Bonus', 'earning', round(v_bonus), v_sort);
      v_taxable := v_taxable + v_bonus;
    end if;
    if v_incent > 0 then
      v_sort := v_sort + 1;
      insert into public.payslip_lines (payslip_id, company_id, code, name, kind, amount, sort)
      values (v_slip, p_company, 'INCENTIVE', 'Incentive', 'earning', round(v_incent), v_sort);
      v_taxable := v_taxable + v_incent; v_esi_wage := v_esi_wage + v_incent;
    end if;

    -- exit in this month: leave encashment and gratuity (SAL-11)
    v_encash := 0; v_gratuity := 0;
    if e.last_working_day is not null and e.last_working_day <= v_end then
      select coalesce(sum(greatest(0, opening + accrued - used)), 0) * v_day_value into v_encash
      from public.leave_balance_view where employee_id = e.id and encashable
        and year = extract(year from e.last_working_day)::int;
      if v_encash > 0 then
        v_sort := v_sort + 1;
        insert into public.payslip_lines (payslip_id, company_id, code, name, kind, amount, sort)
        values (v_slip, p_company, 'ENCASH', 'Leave encashment', 'earning', round(v_encash), v_sort);
        v_taxable := v_taxable + v_encash;
      end if;
      v_years := (e.last_working_day - e.date_of_joining)::numeric / 365.25;
      if st.gratuity_enabled and v_years >= 5 then
        v_gratuity := 15.0 / 26 * v_basic_full * round(v_years);
        v_sort := v_sort + 1;
        insert into public.payslip_lines (payslip_id, company_id, code, name, kind, amount, sort)
        values (v_slip, p_company, 'GRATUITY', 'Gratuity', 'earning', round(v_gratuity), v_sort);
      end if;
    end if;

    if v_reimb > 0 then  -- non-taxable, excluded from PF / ESI / TDS
      v_sort := v_sort + 1;
      insert into public.payslip_lines (payslip_id, company_id, code, name, kind, amount, sort)
      values (v_slip, p_company, 'REIMB', 'Reimbursements (non-taxable)', 'earning', round(v_reimb), v_sort);
    end if;

    -- ---- Step 4: statutory deductions on the earned wage ----
    v_pf := 0; v_esi := 0; v_pt := 0; v_lwf := 0; v_er_pf := 0; v_er_esi := 0;
    if st.pf_enabled and v_pf_wage > 0 then
      if st.pf_cap_at_ceiling then v_pf_wage := least(v_pf_wage, st.pf_wage_ceiling); end if;
      v_pf := v_pf_wage * st.pf_employee_rate / 100;
      v_er_pf := v_pf_wage * st.pf_employer_rate / 100;
    end if;
    if st.esi_enabled and v_esi_wage > 0 and v_esi_wage <= st.esi_wage_ceiling then
      v_esi := v_esi_wage * st.esi_employee_rate / 100;
      v_er_esi := v_esi_wage * st.esi_employer_rate / 100;
    end if;
    if st.pt_enabled then
      v_pt_base := v_taxable;
      for v_slab in select * from jsonb_array_elements(st.pt_slabs) loop
        if v_pt_base >= (v_slab ->> 'min')::numeric
           and (v_slab ->> 'max' is null or v_pt_base <= (v_slab ->> 'max')::numeric) then
          v_pt := case when extract(month from v_month) = 2 and v_slab ? 'feb_amount'
                       then (v_slab ->> 'feb_amount')::numeric else (v_slab ->> 'amount')::numeric end;
          exit;
        end if;
      end loop;
    end if;
    if st.lwf_enabled and extract(month from v_month)::int = any(st.lwf_months) then
      v_lwf := st.lwf_employee;
    end if;

    -- ---- Step 5: TDS on projected annual taxable income less tax already deducted ----
    v_tds := 0;
    if st.tds_enabled then
      select coalesce(sum(fp.taxable_income), 0) into v_ytd_taxable from public.final_payslips fp
        where fp.employee_id = e.id and fp.month >= v_fy_start and fp.month < v_month;
      select coalesce(sum(l.amount), 0) into v_ytd_tds from public.final_payslips fp
        join public.payslip_lines l on l.payslip_id = fp.id and l.code = 'TDS'
        where fp.employee_id = e.id and fp.month >= v_fy_start and fp.month < v_month;
      v_months_left := (extract(year from age((v_fy_start + interval '1 year')::date, v_month)) * 12
                        + extract(month from age((v_fy_start + interval '1 year')::date, v_month)))::int;
      if e.last_working_day is not null and e.last_working_day <= v_end then v_months_left := 1; end if;
      select coalesce(sum(full_amount) filter (where taxable), 0) into v_full_taxable from _comp;
      -- SAL-04: the employee's regime; under the old regime declared investments reduce taxable income
      select * into v_decl from public.tax_declarations
        where employee_id = e.id and fy_start_year = extract(year from v_fy_start)::int;
      v_st := public.regime_settings(st, coalesce(v_decl.regime, 'new'));
      v_tds := greatest(0, (public.annual_tax(v_st, v_ytd_taxable + v_taxable + v_full_taxable * (v_months_left - 1)
                                           - v_st.standard_deduction
                                           - case when v_decl.regime = 'old' then coalesce(v_decl.declared_total, 0) else 0 end)
                            - v_ytd_tds) / greatest(v_months_left, 1));
    end if;

    -- ---- Step 6: other deductions — loan / advance EMI, one-time deductions, earlier recoveries ----
    select coalesce(jsonb_object_agg(id, least(emi, balance)), '{}'), coalesce(sum(least(emi, balance)), 0)
      into v_loans, v_loan_total
    from public.loans where employee_id = e.id and status = 'active' and balance > 0 and start_month <= v_month;
    select coalesce(amount, 0) into v_recov_prev from public.recovery_balances where employee_id = e.id;
    v_recov_prev := coalesce(v_recov_prev, 0);

    -- ---- Steps 7–8: rounding per line, net never below zero, shortfall carried forward ----
    select coalesce(sum(amount), 0) into v_gross_r from public.payslip_lines where payslip_id = v_slip and kind = 'earning';
    v_pf := round(v_pf); v_esi := round(v_esi); v_pt := round(v_pt); v_lwf := round(v_lwf);
    v_tds := round(least(v_tds, greatest(0, v_gross_r - v_pf - v_esi - v_pt - v_lwf)));
    v_stat_r := v_pf + v_esi + v_pt + v_lwf + v_tds;
    v_avail := greatest(0, v_gross_r - v_stat_r);
    v_other_need := round(v_loan_total) + round(v_onetime) + round(v_recov_prev);
    v_other_applied := least(v_other_need, v_avail);
    v_carry := v_other_need - v_other_applied;

    v_sort := 100;
    if v_pf > 0 then insert into public.payslip_lines (payslip_id, company_id, code, name, kind, amount, sort)
      values (v_slip, p_company, 'PF', 'Provident Fund', 'deduction', v_pf, 101); end if;
    if v_esi > 0 then insert into public.payslip_lines (payslip_id, company_id, code, name, kind, amount, sort)
      values (v_slip, p_company, 'ESI', 'ESI', 'deduction', v_esi, 102); end if;
    if v_pt > 0 then insert into public.payslip_lines (payslip_id, company_id, code, name, kind, amount, sort)
      values (v_slip, p_company, 'PT', 'Professional Tax', 'deduction', v_pt, 103); end if;
    if v_lwf > 0 then insert into public.payslip_lines (payslip_id, company_id, code, name, kind, amount, sort)
      values (v_slip, p_company, 'LWF', 'Labour Welfare Fund', 'deduction', v_lwf, 104); end if;
    if v_tds > 0 then insert into public.payslip_lines (payslip_id, company_id, code, name, kind, amount, sort)
      values (v_slip, p_company, 'TDS', 'Income Tax (TDS)', 'deduction', v_tds, 105); end if;
    if v_other_applied > 0 then
      insert into public.payslip_lines (payslip_id, company_id, code, name, kind, amount, sort)
      values (v_slip, p_company, 'RECOVERY', 'Loan / advance EMI and recoveries', 'deduction', v_other_applied, 110);
    end if;

    v_ded_r := v_stat_r + v_other_applied;
    v_net := v_gross_r - v_ded_r;

    update public.payslips set
      earned_gross = v_earned, taxable_income = v_taxable, gross_payable = v_gross_r, total_deductions = v_ded_r,
      net_pay = v_net, employer_pf = round(v_er_pf), employer_esi = round(v_er_esi),
      recovery_prev = v_recov_prev, recovery_carry = v_carry, loan_applied = v_loans, arrears_ctc_ids = v_arrear_ids
    where id = v_slip;

    v_count := v_count + 1; v_tot_gross := v_tot_gross + v_gross_r; v_tot_ded := v_tot_ded + v_ded_r; v_tot_net := v_tot_net + v_net;
  end loop;

  update public.payroll_runs set employee_count = v_count, total_gross = v_tot_gross, total_deductions = v_tot_ded,
    total_net = v_tot_net,
    warnings = v_warnings || coalesce((select jsonb_agg(jsonb_build_object('level','warning','code','recovery_carry',
                 'employee_id', p.employee_id, 'message', 'Net pay capped at zero; ₹' || p.recovery_carry || ' carried forward'))
               from public.payslips p where p.run_id = v_run and p.recovery_carry > 0), '[]'),
    changes = coalesce((select jsonb_agg(jsonb_build_object('employee_id', n.employee_id, 'old_net', o.net_pay, 'new_net', n.net_pay))
               from public.payslips n left join public.payslips o on o.run_id = v_prev_run and o.employee_id = n.employee_id
               where n.run_id = v_run and v_prev_run is not null and o.net_pay is distinct from n.net_pay), '[]')
  where id = v_run;
  return v_run;
end $$;
