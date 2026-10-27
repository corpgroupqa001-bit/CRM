-- corpgroup.com · 0027 align access, retention and Leave with BRD v2.0 (26 Oct 2026)
--
--   * NFR-09 / COM-09: archiving no longer deletes a company after 90 days. "Other data" (tasks, projects,
--     announcements, notifications, documents, assets, access) goes after 90 days; payroll, attendance,
--     leave, employee master and the audit log stay for 8 years; chats keep following the chat retention
--     setting. Only then is the company row deleted.
--   * §5.3 default permission matrix: six roles (Super Admin, Owner, Company Admin, HR / Payroll, Manager,
--     Employee). The Finance role is retired (members move to HR / Payroll). HR / Payroll prepares payroll,
--     the Owner or a Company Admin approves (SAL-09); HR invites employees (AUTH-04) and manages tasks;
--     the Owner reads attendance and settings; Settings are read-only for HR; Managers update the projects
--     they manage; Employees create their own tasks and read their own payslips (SAL-12).
--   * Policies and functions that still checked role names now check permissions, so the matrix above is
--     the single source of truth. is_hr() now means "manages attendance" (Company Admin, HR / Payroll).
--   * OI-13: the Super Admin has no default access to a company's data. A Company Admin grants time-limited
--     support access (1–72 hours, with a reason); grants, revocations and every write are audited.
--   * ATT-17 to ATT-19: Leave Management is switched on (MVP Must).
--   * ATT-25: work selfies are visible to HR / Payroll, the reporting manager and the employee.

-- ===========================================================================
-- 1. Retention (NFR-09)
-- ===========================================================================
alter table public.companies add column if not exists purged_at timestamptz;

create or replace function public.purge_archived_companies()
returns integer language plpgsql security definer set search_path = public as $$
declare c record; n integer := 0;
begin
  -- statutory period over: remove the company and everything still attached to it
  for c in select id from public.companies where status = 'archived' and archived_at < now() - interval '8 years' loop
    delete from public.companies where id = c.id;
    n := n + 1;
  end loop;
  -- 90 days after archiving: purge other data, keep statutory records
  for c in select id from public.companies where status = 'archived' and purged_at is null and archived_at < now() - interval '90 days' loop
    update public.conversations set project_id = null where company_id = c.id and project_id is not null;   -- chats follow chat retention
    delete from public.tasks where company_id = c.id;
    delete from public.task_templates where company_id = c.id;
    delete from public.projects where company_id = c.id;
    delete from public.announcements where company_id = c.id;
    delete from public.notifications where company_id = c.id;
    delete from public.saved_filters where company_id = c.id;
    delete from public.report_schedules where company_id = c.id;
    delete from public.onboarding_items where company_id = c.id;
    delete from public.assets where company_id = c.id;
    delete from public.employee_documents where company_id = c.id;   -- files are removed by the retention job (Storage API)
    delete from public.device_secrets where device_id in (select id from public.devices where company_id = c.id);
    delete from public.join_requests where company_id = c.id;
    delete from public.support_access where company_id = c.id;
    delete from public.company_members where company_id = c.id;
    update public.companies set purged_at = now() where id = c.id;
    insert into public.audit_log (company_id, table_name, record_id, action, new_data)
    values (c.id, 'companies', c.id::text, 'retention_purge', jsonb_build_object('kept', 'payroll, attendance, leave, employees, audit log'));
    n := n + 1;
  end loop;
  return n;
end $$;

-- ===========================================================================
-- 2. Roles: the six BRD roles; Finance retired
-- ===========================================================================
update public.company_members set role = 'hr' where role = 'finance';
update public.employees set invite_role = 'hr' where invite_role = 'finance';
update public.join_requests set role = 'hr' where role = 'finance';
delete from public.role_permissions where role = 'finance';

alter table public.company_members drop constraint if exists company_members_role_check;
alter table public.company_members add constraint company_members_role_check
  check (role in ('owner','company_admin','hr','manager','employee'));
alter table public.employees drop constraint if exists employees_invite_role_check;
alter table public.employees add constraint employees_invite_role_check
  check (invite_role in ('company_admin','hr','manager','employee'));
alter table public.role_permissions drop constraint if exists role_permissions_role_check;
alter table public.role_permissions add constraint role_permissions_role_check
  check (role in ('owner','company_admin','hr','manager','employee'));
do $$
declare c text;
begin
  for c in select conname from pg_constraint where conrelid = 'public.designations'::regclass and contype = 'c'
             and pg_get_constraintdef(oid) like '%finance%' loop
    execute format('alter table public.designations drop constraint %I', c);
  end loop;
end $$;
update public.designations set access_role = 'hr' where access_role = 'finance';
alter table public.designations add constraint designations_access_role_check
  check (access_role in ('company_admin','hr','manager','employee'));

-- ===========================================================================
-- 3. Default permission matrix (BRD §5.3)
-- ===========================================================================
delete from public.role_permissions;
insert into public.role_permissions (role, permission)
-- Owner: Companies / Projects / Employees / Tasks CRUD · Attendance R · Leave R · Salaries R, A · Settings and audit R
select 'owner', p from unnest(array[
  'employees.create','employees.read_all','employees.update','employees.delete','employees.account','employees.assign_role','employees.pay_fields',
  'attendance.read_all',
  'salaries.read','salaries.approve',
  'tasks.use','tasks.read_all','tasks.manage','tasks.manage_all',
  'projects.use','projects.manage_all',
  'chat.use','company.update','settings.read','audit.read']) p
union all
-- Company Admin: everything in their company except preparing payroll (Salaries R, A)
select 'company_admin', p from unnest(array[
  'employees.create','employees.read_all','employees.update','employees.delete','employees.account','employees.assign_role','employees.pay_fields',
  'attendance.read_all','attendance.manage','attendance.approve','attendance.unlock','leave.manage',
  'salaries.read','salaries.approve',
  'tasks.use','tasks.read_all','tasks.manage','tasks.manage_all',
  'projects.use','projects.manage_all',
  'chat.use','announcements.post','company.update','settings.read','settings.manage','settings.org','audit.read']) p
union all
-- HR / Payroll: Employees, Attendance, Leave, Tasks CRUD · prepares payroll · Projects R · Settings and audit R
select 'hr', p from unnest(array[
  'employees.create','employees.read_all','employees.update','employees.delete','employees.account','employees.pay_fields',
  'attendance.read_all','attendance.manage','attendance.approve','leave.manage',
  'salaries.read','salaries.manage',
  'tasks.use','tasks.read_all','tasks.manage','tasks.manage_all',
  'projects.use','projects.read_all',
  'chat.use','announcements.post','settings.read','audit.read']) p
union all
-- Manager: team employees, attendance and leave (read, approve), team tasks, the projects they manage
select 'manager', p from unnest(array[
  'employees.read_team','attendance.read_team','attendance.approve',
  'tasks.use','tasks.read_team','tasks.manage',
  'projects.use','projects.lead','chat.use']) p
union all
-- Employee: own records, assigned tasks plus tasks they create for themselves, member projects
select 'employee', p from unnest(array['tasks.use','tasks.create_own','projects.use','chat.use']) p;

-- ===========================================================================
-- 4. Role-name checks → permissions
-- ===========================================================================
create or replace function public.is_hr(cid uuid)
returns boolean language sql stable as $$
  select public.has_perm(cid, 'attendance.manage');
$$;

-- companies, branches, devices, settings
drop policy if exists companies_update on public.companies;
create policy companies_update on public.companies for update
  using (public.has_perm(id, 'company.update')) with check (public.has_perm(id, 'company.update'));
drop policy if exists branches_write on public.branches;
create policy branches_write on public.branches for all
  using (public.has_perm(company_id, 'settings.manage')) with check (public.has_perm(company_id, 'settings.manage'));
drop policy if exists departments_write on public.departments;
create policy departments_write on public.departments for all
  using (public.has_perm(company_id, 'settings.org')) with check (public.has_perm(company_id, 'settings.org'));
drop policy if exists designations_write on public.designations;
create policy designations_write on public.designations for all
  using (public.has_perm(company_id, 'settings.org')) with check (public.has_perm(company_id, 'settings.org'));
drop policy if exists holidays_write on public.holidays;
create policy holidays_write on public.holidays for all
  using (public.has_perm(company_id, 'settings.org')) with check (public.has_perm(company_id, 'settings.org'));
drop policy if exists shifts_write on public.shifts;
create policy shifts_write on public.shifts for all
  using (public.has_perm(company_id, 'settings.manage')) with check (public.has_perm(company_id, 'settings.manage'));
drop policy if exists devices_select on public.devices;
create policy devices_select on public.devices for select using (public.has_perm(company_id, 'attendance.read_all'));
drop policy if exists devices_update on public.devices;
create policy devices_update on public.devices for update
  using (public.has_perm(company_id, 'settings.manage')) with check (public.has_perm(company_id, 'settings.manage'));
drop policy if exists devices_delete on public.devices;
create policy devices_delete on public.devices for delete using (public.has_perm(company_id, 'settings.manage'));
drop policy if exists dum_select on public.device_user_map;
create policy dum_select on public.device_user_map for select using (public.has_perm(company_id, 'attendance.read_all'));
drop policy if exists dum_delete on public.device_user_map;
create policy dum_delete on public.device_user_map for delete using (public.has_perm(company_id, 'attendance.manage'));
drop policy if exists punches_select on public.punches_raw;
create policy punches_select on public.punches_raw for select
  using (public.has_perm(company_id, 'attendance.read_all') or (employee_id is not null and public.can_view_employee(employee_id)));
drop policy if exists rs_hr on public.report_schedules;
create policy rs_hr on public.report_schedules for all
  using (public.has_perm(company_id, 'settings.manage')) with check (public.has_perm(company_id, 'settings.manage'));
drop policy if exists dr_select on public.data_requests;
create policy dr_select on public.data_requests for select
  using (user_id = auth.uid() or public.has_perm(company_id, 'settings.manage'));
drop policy if exists dr_update on public.data_requests;
create policy dr_update on public.data_requests for update
  using (public.has_perm(company_id, 'settings.manage')) with check (public.has_perm(company_id, 'settings.manage'));
drop policy if exists audit_select on public.audit_log;
create policy audit_select on public.audit_log for select using (public.has_perm(company_id, 'audit.read'));

-- employee module
drop policy if exists assets_select on public.assets;
create policy assets_select on public.assets for select
  using (public.has_perm(company_id, 'employees.read_all') or employee_id = public.my_employee_id(company_id));
drop policy if exists assets_write on public.assets;
create policy assets_write on public.assets for all
  using (public.has_perm(company_id, 'employees.update')) with check (public.has_perm(company_id, 'employees.update'));
drop policy if exists ecr_insert on public.employee_change_requests;
create policy ecr_insert on public.employee_change_requests for insert
  with check (employee_id = public.my_employee_id(company_id) or public.has_perm(company_id, 'employees.update'));
drop policy if exists ecr_update on public.employee_change_requests;
create policy ecr_update on public.employee_change_requests for update
  using (public.has_perm(company_id, 'employees.update')) with check (public.has_perm(company_id, 'employees.update'));
drop policy if exists docs_write on public.employee_documents;
create policy docs_write on public.employee_documents for all
  using (public.has_perm(company_id, 'employees.update')) with check (public.has_perm(company_id, 'employees.update'));
drop policy if exists events_write on public.employee_events;
create policy events_write on public.employee_events for insert with check (public.has_perm(company_id, 'employees.update'));
drop policy if exists onboarding_write on public.onboarding_items;
create policy onboarding_write on public.onboarding_items for all
  using (public.has_perm(company_id, 'employees.update')) with check (public.has_perm(company_id, 'employees.update'));

-- attendance corrections
drop policy if exists reg_insert on public.regularisations;
create policy reg_insert on public.regularisations for insert
  with check (employee_id = public.my_employee_id(company_id) or public.has_perm(company_id, 'attendance.manage'));
drop policy if exists reg_update on public.regularisations;
create policy reg_update on public.regularisations for update
  using (employee_id = public.my_employee_id(company_id) or public.has_perm(company_id, 'attendance.manage')
         or (public.has_perm(company_id, 'attendance.approve') and public.is_manager_of(employee_id)))
  with check (public.is_member(company_id));

-- announcements (COMMS-08: administrators and HR only)
drop policy if exists ann_insert on public.announcements;
create policy ann_insert on public.announcements for insert with check (public.has_perm(company_id, 'announcements.post'));
drop policy if exists ann_delete on public.announcements;
create policy ann_delete on public.announcements for delete using (public.has_perm(company_id, 'announcements.post'));
drop policy if exists ack_select on public.announcement_acks;
create policy ack_select on public.announcement_acks for select
  using (user_id = auth.uid() or public.has_perm(company_id, 'announcements.post'));

-- storage: logos, documents, selfies
drop policy if exists logos_write on storage.objects;
create policy logos_write on storage.objects for insert to authenticated
  with check (bucket_id = 'logos' and public.has_perm(public.storage_company(name), 'company.update'));
drop policy if exists logos_update on storage.objects;
create policy logos_update on storage.objects for update to authenticated
  using (bucket_id = 'logos' and public.has_perm(public.storage_company(name), 'company.update'));
drop policy if exists documents_read on storage.objects;
create policy documents_read on storage.objects for select to authenticated
  using (bucket_id = 'documents' and (public.has_perm(public.storage_company(name), 'employees.read_all')
         or public.storage_part(name, 2) = public.my_employee_id(public.storage_company(name))));
drop policy if exists documents_write on storage.objects;
create policy documents_write on storage.objects for insert to authenticated
  with check (bucket_id = 'documents' and (public.has_perm(public.storage_company(name), 'employees.update')
              or public.storage_part(name, 2) = public.my_employee_id(public.storage_company(name))));
drop policy if exists documents_delete on storage.objects;
create policy documents_delete on storage.objects for delete to authenticated
  using (bucket_id = 'documents' and public.has_perm(public.storage_company(name), 'employees.update'));
-- ATT-25: HR / Payroll and the reporting manager (and the employee themself)
drop policy if exists selfies_read on storage.objects;
create policy selfies_read on storage.objects for select to authenticated
  using (bucket_id = 'selfies' and (
    public.has_role(public.storage_company(name), array['hr'])
    or public.storage_part(name, 2) = public.my_employee_id(public.storage_company(name))
    or exists (select 1 from public.employees e where e.id = public.storage_part(name, 2)
               and e.company_id = public.storage_company(name) and public.is_manager_of(e.id))));

-- functions that named roles
create or replace function public.unlock_attendance_month(p_company uuid, p_month date, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare v_month date := date_trunc('month', p_month)::date;
begin
  if not public.has_perm(p_company, 'attendance.unlock') then
    raise exception 'Only a company administrator can unlock attendance' using errcode = '42501';
  end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required'; end if;
  if exists (select 1 from public.payroll_runs where company_id = p_company and month = v_month and status = 'locked') then
    raise exception 'Payroll for this month is approved — reopen payroll instead';
  end if;
  delete from public.attendance_locks where company_id = p_company and month = v_month;
  insert into public.audit_log (company_id, user_id, table_name, record_id, action, new_data, ip)
  values (p_company, auth.uid(), 'attendance_locks', v_month::text, 'unlock', jsonb_build_object('reason', p_reason), public.request_ip());
end $$;

create or replace function public.register_device(p_company uuid, p_branch uuid, p_name text, p_serial text, p_vendor text, p_model text, p_ip text, p_mode text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid; v_secret text; v_key text;
begin
  if not public.has_perm(p_company, 'settings.manage') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  v_secret := encode(extensions.gen_random_bytes(32), 'hex');
  v_key := encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.devices (company_id, branch_id, name, serial_no, vendor, model, ip, mode)
  values (p_company, p_branch, p_name, p_serial, p_vendor, p_model, p_ip, coalesce(p_mode, 'push'))
  returning id into v_id;
  insert into public.device_secrets (device_id, hmac_secret, api_key_hash)
  values (v_id, v_secret, encode(extensions.digest(convert_to(v_key, 'UTF8'), 'sha256'), 'hex'));
  return jsonb_build_object('device_id', v_id, 'hmac_secret', v_secret, 'api_key', v_key);
end $$;

create or replace function public.export_conversation(p_conv uuid)
returns table(sent_at timestamptz, sender text, body text, attachment text, deleted boolean)
language plpgsql security definer set search_path = public as $$
declare v_company uuid;
begin
  select company_id into v_company from public.conversations where id = p_conv;
  if v_company is null or not public.has_perm(v_company, 'settings.manage') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  insert into public.audit_log (company_id, user_id, table_name, record_id, action, ip)
  values (v_company, auth.uid(), 'conversations', p_conv::text, 'export', public.request_ip());
  return query
    select m.created_at, coalesce(p.full_name, p.email, m.sender_id::text), m.body, m.attachment_name, m.deleted
    from public.messages m left join public.profiles p on p.id = m.sender_id
    where m.conversation_id = p_conv order by m.created_at;
end $$;

create or replace function public.sa_check_assignment(p_company uuid, p_role text, p_department uuid, p_designation uuid)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if p_role is null or p_role not in ('company_admin','hr','manager','employee') then
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

-- ===========================================================================
-- 5. Payroll: HR / Payroll prepares, Owner or Company Admin approves (SAL-09)
-- ===========================================================================
create or replace function public.approve_payroll(p_run uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r public.payroll_runs%rowtype; p record; l record;
begin
  select * into r from public.payroll_runs where id = p_run;
  if r.id is null or not public.has_perm(r.company_id, 'salaries.approve') then
    raise exception 'Only the Owner or a Company Admin can approve payroll' using errcode = '42501';
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

-- SAL-12 / §5.3: every employee (managers included) reads their own payslip once the run is approved
drop policy if exists slips_select on public.payslips;
create policy slips_select on public.payslips for select using (
  public.has_perm(company_id, 'salaries.read')
  or (employee_id = public.my_employee_id(company_id) and public.is_member(company_id)
      and public.payroll_run_locked(run_id)));

-- ===========================================================================
-- 6. Tasks: employees create tasks for themselves (§5.3 Employee "C (own)")
-- ===========================================================================
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
      -- an employee's own task
      or (public.has_perm(t.company_id, 'tasks.create_own') and t.created_by = auth.uid())
      -- the assignee works on their own task (status, checklist, comments, time)
      or (public.has_perm(t.company_id, 'tasks.use') and exists (
        select 1 from public.task_assignees a join public.employees e on e.id = a.employee_id
        where a.task_id = t.id and e.user_id = auth.uid()))
    )
  );
$$;

drop policy if exists tasks_insert on public.tasks;
create policy tasks_insert on public.tasks for insert with check (
  (public.has_perm(company_id, 'tasks.manage') or public.has_perm(company_id, 'tasks.create_own'))
  and created_by = auth.uid() and (project_id is null or public.can_view_project(project_id)));

-- an employee may put only themselves on a task they created
drop policy if exists ta_insert on public.task_assignees;
create policy ta_insert on public.task_assignees for insert with check (
  (public.can_edit_task(task_id) and public.has_perm(company_id, 'tasks.manage'))
  or (public.has_perm(company_id, 'tasks.create_own') and employee_id = public.my_employee_id(company_id)
      and exists (select 1 from public.tasks t where t.id = task_id and t.created_by = auth.uid())));

-- ===========================================================================
-- 7. Projects: HR reads all; a Manager updates the projects they manage (no creating)
-- ===========================================================================
create or replace function public.can_manage_project(pid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.projects p
    left join public.employees e on e.id = p.manager_id
    where p.id = pid and (
      public.has_perm(p.company_id, 'projects.manage_all')
      or (public.has_perm(p.company_id, 'projects.lead') and e.user_id = auth.uid())
    )
  );
$$;

create or replace function public.can_view_project(pid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.projects p where p.id = pid and (
      public.has_perm(p.company_id, 'projects.manage_all')
      or public.has_perm(p.company_id, 'projects.read_all')
      or (public.has_perm(p.company_id, 'projects.use') and public.is_project_member(p.id))
      or (public.has_perm(p.company_id, 'projects.lead') and p.manager_id = public.my_employee_id(p.company_id))
    )
  );
$$;

drop policy if exists projects_select on public.projects;
create policy projects_select on public.projects for select using (
  public.has_perm(company_id, 'projects.manage_all') or public.has_perm(company_id, 'projects.read_all')
  or (public.has_perm(company_id, 'projects.use')
      and (manager_id = public.my_employee_id(company_id) or public.is_project_member(id))));
drop policy if exists projects_insert on public.projects;
create policy projects_insert on public.projects for insert with check (public.has_perm(company_id, 'projects.manage_all'));
drop policy if exists projects_update on public.projects;
create policy projects_update on public.projects for update using (public.can_manage_project(id))
  with check (public.has_perm(company_id, 'projects.manage_all')
              or (public.has_perm(company_id, 'projects.lead') and manager_id = public.my_employee_id(company_id)));

-- ===========================================================================
-- 8. Super Admin: time-limited support access granted by a Company Admin (OI-13)
-- ===========================================================================
create table if not exists public.support_access (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  granted_by  uuid not null references auth.users(id),
  reason      text not null check (length(trim(reason)) > 0),
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  revoked_by  uuid references auth.users(id),
  created_at  timestamptz not null default now()
);
create index if not exists support_access_company on public.support_access (company_id, expires_at desc);
alter table public.support_access enable row level security;
drop policy if exists support_access_read on public.support_access;
create policy support_access_read on public.support_access for select
  using (public.has_perm(company_id, 'settings.manage') or exists (select 1 from public.platform_admins where user_id = auth.uid()));
-- writes only through the functions below

create or replace function public.sa_acting(cid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select cid is not null and auth.uid() is not null
    and exists (select 1 from public.platform_admins where user_id = auth.uid())
    and exists (select 1 from public.companies where id = cid)
    and not exists (select 1 from public.company_members where company_id = cid and user_id = auth.uid())
    and exists (select 1 from public.support_access s where s.company_id = cid and s.revoked_at is null and s.expires_at > now());
$$;

create or replace function public.grant_support_access(p_company uuid, p_hours integer, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  -- a member Company Admin decides; the Super Admin can't grant access to itself
  if not exists (select 1 from public.company_members m where m.company_id = p_company and m.user_id = auth.uid()
                 and m.active and m.role = 'company_admin') or not public.in_good_standing(p_company) then
    raise exception 'Only a Company Admin can grant support access' using errcode = '42501';
  end if;
  if p_hours is null or p_hours < 1 or p_hours > 72 then raise exception 'Choose between 1 and 72 hours'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Give the support case or reason'; end if;
  insert into public.support_access (company_id, granted_by, reason, expires_at)
  values (p_company, auth.uid(), trim(p_reason), now() + make_interval(hours => p_hours)) returning id into v_id;
  insert into public.audit_log (company_id, user_id, table_name, record_id, action, new_data, ip)
  values (p_company, auth.uid(), 'support_access', v_id::text, 'grant',
          jsonb_build_object('hours', p_hours, 'reason', trim(p_reason)), public.request_ip());
  return v_id;
end $$;

create or replace function public.revoke_support_access(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare s public.support_access%rowtype;
begin
  select * into s from public.support_access where id = p_id;
  if s.id is null or not exists (select 1 from public.company_members m where m.company_id = s.company_id and m.user_id = auth.uid()
                                   and m.active and m.role = 'company_admin') then
    raise exception 'Only a Company Admin can revoke support access' using errcode = '42501';
  end if;
  update public.support_access set revoked_at = now(), revoked_by = auth.uid() where id = p_id and revoked_at is null;
  insert into public.audit_log (company_id, user_id, table_name, record_id, action, ip)
  values (s.company_id, auth.uid(), 'support_access', p_id::text, 'revoke', public.request_ip());
end $$;

revoke execute on function public.grant_support_access(uuid, integer, text) from public, anon;
revoke execute on function public.revoke_support_access(uuid) from public, anon;
grant execute on function public.grant_support_access(uuid, integer, text) to authenticated;
grant execute on function public.revoke_support_access(uuid) to authenticated;

-- ===========================================================================
-- 9. Leave Management on (ATT-17 to ATT-19, MVP Must)
-- ===========================================================================
update public.platform_features set enabled = true, note = 'Leave Management (BRD v2.0 MVP)' where feature = 'leave';

-- ===========================================================================
-- 10. Employee guards: HR / Payroll invites and links logins (AUTH-04, employees.account); only a
--     Company Admin or the Owner chooses a system role (employees.assign_role). The Super Admin's
--     account-management functions (sa_assign_company and friends) remain allowed.
-- ===========================================================================
create or replace function public.employees_insert_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_super_admin() then
    if not public.has_perm(new.company_id, 'employees.account') then
      if new.user_id is not null then
        raise exception 'Only HR or an administrator can link a login to an employee record' using errcode = '42501';
      end if;
      if new.invited_at is not null then
        raise exception 'Only HR or an administrator can send invitations' using errcode = '42501';
      end if;
      if new.status not in ('active','notice') then
        raise exception 'New employee records start as active' using errcode = '42501';
      end if;
    end if;
    if coalesce(new.invite_role, 'employee') <> 'employee' and not public.has_perm(new.company_id, 'employees.assign_role') then
      raise exception 'Only an administrator can choose the system role' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

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
        raise exception 'Only HR or an administrator can change login access or activation' using errcode = '42501';
      end if;
      if new.invite_role is distinct from old.invite_role and not public.has_perm(old.company_id, 'employees.assign_role') then
        raise exception 'Only an administrator can change the system role' using errcode = '42501';
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
