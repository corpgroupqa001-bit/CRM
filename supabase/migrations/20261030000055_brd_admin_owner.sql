-- corpgroup.com · 0055 the Super Admin is the BRD Admin; the Owner has the BRD Owner rights
--
-- BRD v2.0 (revised 30 Oct 2026) §5.2 / §5.3 and the user's decisions of 30 Oct 2026:
--   * the Super Admin and the Admin are the same person ("one administrator for all companies"): the Super
--     Admin has the BRD Admin rights in every company, without a grant: companies (R, U), projects,
--     employees (incl. bank / PAN / statutory details and system roles), attendance (incl. month unlock),
--     leave (incl. approvals), salaries (R, approve, reopen; never their own run), tasks, chat, settings and
--     the audit log, roles, announcements. This widens 0052, where payroll, bank details, the audit log,
--     chat and leave approvals were left out.
--   * the Owner goes back to the BRD Owner column: companies, projects, employees and tasks in full;
--     attendance and leave read; salaries read and approve; settings and audit log read. The Owner still
--     manages roles (decision of 27 Oct, 0039).
--   * messages that said "Only the Owner" now name who can do it.

-- 1. the Owner: the BRD Owner column (0027) plus roles.manage (0039)
delete from public.role_permissions where role = 'owner';
insert into public.role_permissions (role, permission)
select 'owner', p from unnest(array[
  'employees.create','employees.read_all','employees.update','employees.delete','employees.account','employees.assign_role','employees.pay_fields',
  'attendance.read_all',
  'salaries.read','salaries.approve',
  'tasks.use','tasks.read_all','tasks.manage','tasks.manage_all',
  'projects.use','projects.manage_all',
  'chat.use','company.update','settings.read','audit.read','roles.manage']) p;

-- 2. the Super Admin (= the Admin): the BRD Admin column in every company
create or replace function public.sa_permissions()
returns setof text language sql stable security definer set search_path = public as $$
  select unnest(array[
    'employees.create','employees.read_all','employees.update','employees.delete','employees.account','employees.assign_role','employees.pay_fields',
    'attendance.read_all','attendance.manage','attendance.approve','attendance.unlock',
    'leave.manage',
    'salaries.read','salaries.approve',
    'tasks.use','tasks.read_all','tasks.manage','tasks.manage_all',
    'projects.use','projects.manage_all',
    'chat.use','announcements.post',
    'company.update','settings.read','settings.manage','settings.org','audit.read','roles.manage']);
$$;

-- the Admin approves leave (BRD: Leave CRUD), so the 0052 block goes
drop trigger if exists leave_requests_no_super_admin_decision on public.leave_requests;
drop function if exists public.leave_requests_no_super_admin_decision();

-- 3. the permissions that exist: every company role's, plus the Admin's (settings.manage, settings.org and
--    attendance.unlock are now held only by the Admin), so custom roles can still be given them
create or replace function public.assignable_permissions()
returns setof text language sql stable security definer set search_path = public as $$
  select p from (select permission p from public.role_permissions union select public.sa_permissions()) x order by 1;
$$;

create or replace function public.company_role_permissions_check()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.assignable_permissions() a where a = new.permission) then
    raise exception 'Unknown permission %', new.permission;
  end if;
  select company_id into new.company_id from public.company_roles where id = new.role_id;
  return new;
end $$;

-- 4. messages and checks (bodies otherwise unchanged from their latest versions, 0051)

-- add_existing_person
create or replace function public.add_existing_person(p_company uuid, p_source_employee uuid, p_mode text, p_leave uuid[],
  p_role text, p_department uuid, p_designation uuid, p_manager uuid, p_joining date)
returns uuid language plpgsql security definer set search_path = public as $$
declare src public.employees%rowtype; v_new uuid; v_left text[] := '{}'; r record; v_target_name text; v_join date := coalesce(p_joining, current_date);
begin
  select * into src from public.employees where id = p_source_employee;
  if src.id is null or not public.manages_company(p_company) or not public.manages_company(src.company_id) then
    raise exception 'Only the Owner of both companies or the Admin can do this' using errcode = '42501';
  end if;
  if p_mode not in ('add','move') then raise exception 'Choose add or move'; end if;
  if exists (select 1 from public.employees where company_id = p_company and lower(email) = lower(src.email)
             and status in ('active','notice') and removed_at is null) then
    raise exception 'This person already works in this company';
  end if;
  perform public.sa_check_assignment(p_company, coalesce(p_role, 'employee'), p_department, p_designation);
  if p_manager is not null and not exists (select 1 from public.employees where id = p_manager and company_id = p_company) then
    raise exception 'Reporting manager belongs to a different company' using errcode = '23503';
  end if;

  -- the record here: basic details only (BRD §7.2). Someone who worked here before comes back on their
  -- old record (an email is unique per company), so their earlier history stays with it.
  select id into v_new from public.employees where company_id = p_company and lower(email) = lower(src.email);
  if v_new is not null then
    update public.employees set user_id = coalesce(src.user_id, user_id), first_name = src.first_name, last_name = src.last_name,
      phone = coalesce(src.phone, phone), department_id = p_department, designation_id = p_designation, reporting_manager_id = p_manager,
      date_of_joining = v_join, invite_role = coalesce(p_role, 'employee'), status = 'active', last_working_day = null,
      exit_reason = null, resignation_date = null, removed_at = null
    where id = v_new;
  else
    insert into public.employees (company_id, user_id, first_name, last_name, email, phone, department_id, designation_id,
                                  reporting_manager_id, date_of_joining, invite_role)
    values (p_company, src.user_id, src.first_name, src.last_name, lower(src.email), src.phone, p_department, p_designation,
            p_manager, v_join, coalesce(p_role, 'employee'))
    returning id into v_new;
  end if;
  if src.user_id is not null then
    insert into public.company_members (company_id, user_id, role, active) values (p_company, src.user_id, coalesce(p_role, 'employee'), true)
    on conflict (company_id, user_id) do update set role = excluded.role, active = true where public.company_members.role <> 'owner';
  end if;
  select name into v_target_name from public.companies where id = p_company;
  insert into public.employee_events (company_id, employee_id, kind, effective_date, details)
  values (p_company, v_new, case when p_mode = 'move' then 'transfer' else 'joined' end, v_join,
          jsonb_build_object('from_employee', src.id, 'mode', p_mode));

  -- move: leave the chosen companies (null = every company I manage where they work) the day before
  if p_mode = 'move' then
    for r in select e.*, c.name as company_name from public.employees e join public.companies c on c.id = e.company_id
             where lower(e.email) = lower(src.email) and e.company_id <> p_company and e.status in ('active','notice')
               and e.removed_at is null and (p_leave is null or e.company_id = any(p_leave)) loop
      if not public.manages_company(r.company_id) then
        raise exception 'You don''t manage %, so they can''t be moved out of it here', r.company_name using errcode = '42501';
      end if;
      if exists (select 1 from public.companies where id = r.company_id and owner_id = r.user_id and r.user_id is not null) then
        raise exception '% is the owner of %; an owner can''t be moved out', trim(r.first_name || ' ' || coalesce(r.last_name, '')), r.company_name;
      end if;
      update public.employees set status = 'exited', last_working_day = v_join - 1,
        exit_reason = 'Moved to ' || v_target_name where id = r.id;
      if r.user_id is not null then
        update public.company_members set active = false where company_id = r.company_id and user_id = r.user_id and role <> 'owner';
      end if;
      delete from public.device_user_map where employee_id = r.id;           -- biometric IDs released (EMP-11)
      insert into public.employee_events (company_id, employee_id, kind, effective_date, details)
      values (r.company_id, r.id, 'transfer', v_join, jsonb_build_object('to_company', p_company, 'new_employee_id', v_new));
      insert into public.audit_log (company_id, user_id, table_name, record_id, action, new_data, ip)
      values (r.company_id, auth.uid(), 'employees', r.id::text, 'moved_out', jsonb_build_object('to_company', p_company), public.request_ip());
      v_left := v_left || r.company_name;
    end loop;
    if cardinality(v_left) = 0 then raise exception 'Choose at least one company they leave'; end if;
  end if;

  insert into public.audit_log (company_id, user_id, table_name, record_id, action, new_data, ip)
  values (p_company, auth.uid(), 'employees', v_new::text, case when p_mode = 'move' then 'moved_in' else 'added_existing' end,
          jsonb_build_object('from_employee', src.id, 'left', v_left), public.request_ip());
  perform public.notify(src.user_id, p_company,
    case when p_mode = 'move' then 'You''ve moved to ' || v_target_name else 'You''ve been added to ' || v_target_name end,
    case when p_mode = 'move' then 'From ' || to_char(v_join, 'DD Mon YYYY') || '. You left: ' || array_to_string(v_left, ', ') || '.'
         else 'You now also work in ' || v_target_name || ' from ' || to_char(v_join, 'DD Mon YYYY') || '. Switch company from the sidebar.' end,
    '/dashboard');
  return v_new;
end $$;

-- approve_join_request
create or replace function public.approve_join_request(p_request uuid, p_role text)
returns uuid language plpgsql security definer set search_path = public as $$
declare r public.join_requests%rowtype; v_emp uuid; v_first text; v_last text;
begin
  select * into r from public.join_requests where id = p_request;
  if r.id is null or not (public.has_perm(r.company_id, 'employees.account') and public.has_perm(r.company_id, 'employees.assign_role')) then
    raise exception 'Only the Owner or the Admin can approve sign-ups' using errcode = '42501';
  end if;
  if r.status <> 'pending' then raise exception 'This request was already %', r.status; end if;
  if p_role is null or p_role not in ('hr','manager','employee') then raise exception 'Choose an access role'; end if;

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

-- reject_join_request
create or replace function public.reject_join_request(p_request uuid, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare r public.join_requests%rowtype;
begin
  select * into r from public.join_requests where id = p_request;
  if r.id is null or not public.has_perm(r.company_id, 'employees.account') then
    raise exception 'Only the Owner or the Admin can reject sign-ups' using errcode = '42501';
  end if;
  if r.status <> 'pending' then raise exception 'This request was already %', r.status; end if;
  update public.join_requests set status = 'rejected', decided_by = auth.uid(), decided_at = now(), decision_note = nullif(trim(p_note), '')
  where id = p_request;
  insert into public.audit_log (company_id, user_id, table_name, record_id, action, new_data, ip)
  values (r.company_id, auth.uid(), 'join_requests', p_request::text, 'reject', jsonb_build_object('email', r.email, 'note', p_note), public.request_ip());
end $$;

-- approve_payroll
create or replace function public.approve_payroll(p_run uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r public.payroll_runs%rowtype; p record; l record;
begin
  select * into r from public.payroll_runs where id = p_run;
  if r.id is null or not public.has_perm(r.company_id, 'salaries.approve') then
    raise exception 'Only the Owner or the Admin can approve payroll' using errcode = '42501';
  end if;
  if r.ran_by = auth.uid() then
    raise exception 'You ran this payroll, so someone else must approve it' using errcode = '42501';
  end if;
  if r.status <> 'draft' then raise exception 'Only a draft run can be approved'; end if;
  if exists (select 1 from jsonb_array_elements(r.warnings) w where w ->> 'level' = 'error') then
    raise exception 'Resolve the pre-run errors before approving';
  end if;
  for p in select * from public.payslips where run_id = p_run loop
    for l in select key::uuid as loan_id, value::numeric as amt from jsonb_each_text(p.loan_applied) loop
      update public.loans set balance = balance - l.amt,
        status = case when balance - l.amt <= 0 then 'closed' else status end where id = l.loan_id;
    end loop;
    insert into public.recovery_balances (employee_id, company_id, amount) values (p.employee_id, p.company_id, p.recovery_carry)
    on conflict (employee_id) do update set amount = excluded.amount, updated_at = now();
    update public.employee_ctc set arrears_settled = true where id = any(p.arrears_ctc_ids);
  end loop;
  update public.payroll_runs set status = 'locked', approved_by = auth.uid(), approved_at = now() where id = p_run;
  update public.payslips set payment_status = case when held then 'on_hold' else 'pending' end where run_id = p_run;
  insert into public.audit_log (company_id, user_id, table_name, record_id, action, new_data, ip)
  values (r.company_id, auth.uid(), 'payroll_runs', p_run::text, 'approve',
          jsonb_build_object('month', r.month, 'version', r.version, 'ran_by', r.ran_by, 'total_net', r.total_net), public.request_ip());
end $$;

-- clone_role
create or replace function public.clone_role(p_company uuid, p_name text, p_from_role text, p_from_custom uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_base text;
begin
  if not public.has_perm(p_company, 'roles.manage') then
    raise exception 'Only the Owner or the Admin can manage roles' using errcode = '42501';
  end if;
  if p_from_custom is not null then
    select base_role into v_base from public.company_roles where id = p_from_custom and company_id = p_company;
    if v_base is null then raise exception 'Choose a role to copy'; end if;
  else
    if p_from_role is null or p_from_role not in ('hr','manager','employee') then raise exception 'Choose a role to copy'; end if;
    v_base := p_from_role;
  end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Give the new role a name'; end if;
  if exists (select 1 from public.company_roles where company_id = p_company and lower(trim(name)) = lower(trim(p_name))) then
    raise exception 'A role called "%" already exists', trim(p_name);
  end if;
  insert into public.company_roles (company_id, name, base_role, created_by)
  values (p_company, trim(p_name), v_base, auth.uid()) returning id into v_id;
  insert into public.company_role_permissions (role_id, company_id, permission)
  select v_id, p_company, permission from (
    select public.role_perms(p_company, v_base) permission where p_from_custom is null
    union
    select permission from public.company_role_permissions where role_id = p_from_custom
  ) x;
  return v_id;
end $$;

-- delete_role
create or replace function public.delete_role(p_role uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r public.company_roles%rowtype; n integer;
begin
  select * into r from public.company_roles where id = p_role;
  if r.id is null or not public.has_perm(r.company_id, 'roles.manage') then
    raise exception 'Only the Owner or the Admin can manage roles' using errcode = '42501';
  end if;
  select count(*) into n from public.company_members where custom_role_id = r.id;
  if n > 0 then raise exception '% % still % this role: give them another role first', n, case when n = 1 then 'person' else 'people' end,
                                case when n = 1 then 'has' else 'have' end; end if;
  delete from public.company_roles where id = r.id;
end $$;

-- save_role
create or replace function public.save_role(p_role uuid, p_name text, p_permissions text[])
returns void language plpgsql security definer set search_path = public as $$
declare r public.company_roles%rowtype; v_bad text;
begin
  select * into r from public.company_roles where id = p_role;
  if r.id is null or not public.has_perm(r.company_id, 'roles.manage') then
    raise exception 'Only the Owner or the Admin can manage roles' using errcode = '42501';
  end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Give the role a name'; end if;
  if exists (select 1 from public.company_roles where company_id = r.company_id and id <> r.id and lower(trim(name)) = lower(trim(p_name))) then
    raise exception 'A role called "%" already exists', trim(p_name);
  end if;
  select p into v_bad from unnest(coalesce(p_permissions, '{}')) p
  where not exists (select 1 from public.assignable_permissions() a where a = p) limit 1;
  if v_bad is not null then raise exception 'Unknown permission %', v_bad; end if;
  -- whoever saves keeps the right to manage roles: don't let them lock themselves out
  if r.id = (select custom_role_id from public.company_members where company_id = r.company_id and user_id = auth.uid())
     and not ('roles.manage' = any(coalesce(p_permissions, '{}'))) then
    raise exception 'You hold this role: keep "Manage roles" ticked, or you''d lose access to this page';
  end if;
  update public.company_roles set name = trim(p_name) where id = r.id;
  delete from public.company_role_permissions where role_id = r.id and permission <> all(coalesce(p_permissions, '{}'));
  insert into public.company_role_permissions (role_id, company_id, permission)
  select r.id, r.company_id, p from unnest(coalesce(p_permissions, '{}')) p
  on conflict do nothing;
  insert into public.audit_log (company_id, user_id, table_name, record_id, action, new_data, ip)
  values (r.company_id, auth.uid(), 'company_roles', r.id::text, 'permissions',
          jsonb_build_object('name', trim(p_name), 'permissions', to_jsonb(coalesce(p_permissions, '{}'))), public.request_ip());
end $$;

-- save_default_role
create or replace function public.save_default_role(p_company uuid, p_role text, p_permissions text[])
returns void language plpgsql security definer set search_path = public as $$
declare v_bad text; v_perms text[] := array(select distinct unnest(coalesce(p_permissions, '{}')) order by 1);
begin
  if not public.has_perm(p_company, 'roles.manage') then
    raise exception 'Only the Owner or the Admin can change roles' using errcode = '42501';
  end if;
  if p_role is null or p_role not in ('hr','manager','employee') then
    raise exception 'The Owner role can''t be changed';
  end if;
  select p into v_bad from unnest(v_perms) p where not exists (select 1 from public.assignable_permissions() a where a = p) limit 1;
  if v_bad is not null then raise exception 'Unknown permission %', v_bad; end if;
  insert into public.company_default_roles (company_id, role, permissions, updated_by, updated_at)
  values (p_company, p_role, v_perms, auth.uid(), now())
  on conflict (company_id, role) do update set permissions = excluded.permissions, updated_by = excluded.updated_by, updated_at = now();
  insert into public.audit_log (company_id, user_id, table_name, record_id, action, new_data, ip)
  values (p_company, auth.uid(), 'company_default_roles', p_role, 'permissions', jsonb_build_object('role', p_role, 'permissions', to_jsonb(v_perms)), public.request_ip());
end $$;

-- reset_default_role
create or replace function public.reset_default_role(p_company uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_perm(p_company, 'roles.manage') then
    raise exception 'Only the Owner or the Admin can change roles' using errcode = '42501';
  end if;
  delete from public.company_default_roles where company_id = p_company and role = p_role;
  insert into public.audit_log (company_id, user_id, table_name, record_id, action, ip)
  values (p_company, auth.uid(), 'company_default_roles', p_role, 'reset', public.request_ip());
end $$;

-- designations_access_guard
create or replace function public.designations_access_guard()
returns trigger language plpgsql as $$
begin
  if auth.uid() is not null
     and new.access_role is distinct from (case when tg_op = 'UPDATE' then old.access_role end)
     and not public.has_perm(new.company_id, 'employees.assign_role') then
    raise exception 'Only the Owner or the Admin can set the access role of a designation' using errcode = '42501';
  end if;
  return new;
end $$;

-- employees_before_write
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
    if auth.uid() is not null and not public.is_super_admin() then   -- server jobs and admin-client actions check permissions themselves
      if new.company_id <> old.company_id then
        raise exception 'An employee record cannot move to another company' using errcode = '42501';
      end if;
      if (new.user_id is distinct from old.user_id
          or (new.status is distinct from old.status and 'inactive' in (new.status, old.status)))
         and not public.has_perm(old.company_id, 'employees.account') then
        raise exception 'Only HR, the Owner or the Admin can change login access or activation' using errcode = '42501';
      end if;
      if new.invite_role is distinct from old.invite_role and not public.has_perm(old.company_id, 'employees.assign_role') then
        raise exception 'Only the Owner or the Admin can change the system role' using errcode = '42501';
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

-- employees_insert_guard
create or replace function public.employees_insert_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_super_admin() then
    if not public.has_perm(new.company_id, 'employees.account') then
      if new.user_id is not null then
        raise exception 'Only HR, the Owner or the Admin can link a login to an employee record' using errcode = '42501';
      end if;
      if new.invited_at is not null then
        raise exception 'Only HR, the Owner or the Admin can send invitations' using errcode = '42501';
      end if;
      if new.status not in ('active','notice') then
        raise exception 'New employee records start as active' using errcode = '42501';
      end if;
    end if;
    if coalesce(new.invite_role, 'employee') <> 'employee' and not public.has_perm(new.company_id, 'employees.assign_role') then
      raise exception 'Only the Owner or the Admin can choose the system role' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

-- unlock_attendance_month
create or replace function public.unlock_attendance_month(p_company uuid, p_month date, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare v_month date := date_trunc('month', p_month)::date;
begin
  if not public.has_perm(p_company, 'attendance.unlock') then
    raise exception 'Only the Admin can unlock attendance' using errcode = '42501';
  end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required'; end if;
  if exists (select 1 from public.payroll_runs where company_id = p_company and month = v_month and status = 'locked') then
    raise exception 'Payroll for this month is approved — reopen payroll instead';
  end if;
  delete from public.attendance_locks where company_id = p_company and month = v_month;
  insert into public.audit_log (company_id, user_id, table_name, record_id, action, new_data, ip)
  values (p_company, auth.uid(), 'attendance_locks', v_month::text, 'unlock', jsonb_build_object('reason', p_reason), public.request_ip());
end $$;

-- reopen_payroll
create or replace function public.reopen_payroll(p_run uuid, p_reason text, p_confirm text)
returns void language plpgsql security definer set search_path = public as $$
declare r public.payroll_runs%rowtype; p record; l record;
begin
  select * into r from public.payroll_runs where id = p_run;
  if r.id is null or not (public.sa_acting(r.company_id) or (exists (
       select 1 from public.company_members m
       where m.company_id = r.company_id and m.user_id = auth.uid() and m.active and m.role = 'owner')
     and public.in_good_standing(r.company_id))) then
    raise exception 'Only the Owner or the Admin can reopen payroll' using errcode = '42501';
  end if;
  if r.status <> 'locked' then raise exception 'Only a finalized run can be reopened'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required'; end if;
  if coalesce(trim(p_confirm), '') <> to_char(r.month, 'YYYY-MM') then
    raise exception 'Type % to confirm reopening this payroll', to_char(r.month, 'YYYY-MM');
  end if;
  for p in select * from public.payslips where run_id = p_run loop
    for l in select key::uuid as loan_id, value::numeric as amt from jsonb_each_text(p.loan_applied) loop
      update public.loans set balance = balance + l.amt, status = 'active' where id = l.loan_id;
    end loop;
    update public.recovery_balances set amount = p.recovery_prev, updated_at = now() where employee_id = p.employee_id;
    update public.employee_ctc set arrears_settled = false where id = any(p.arrears_ctc_ids);
  end loop;
  update public.payroll_runs set status = 'reopened', reopened_by = auth.uid(), reopened_at = now(), reopen_reason = p_reason
  where id = p_run;
  delete from public.attendance_locks where company_id = r.company_id and month = r.month;
  insert into public.audit_log (company_id, user_id, table_name, record_id, action, new_data, ip)
  values (r.company_id, auth.uid(), 'payroll_runs', p_run::text, 'reopen',
          jsonb_build_object('reason', p_reason, 'month', r.month), public.request_ip());
end $$;
