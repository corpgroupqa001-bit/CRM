-- corpgroup.com · 0019 RBAC follow-up: decisions confirmed on 23 Oct 2026
--
--   * Super Admin acts as an Administrator in every company (employees, roles, settings, payroll view
--     and run) but cannot approve or reopen payroll. Granted only by SQL into platform_admins; it can't
--     add itself to a company. Every write it makes is audited and flagged via_super_admin.
--   * Payroll approval: Administrator or Finance / Payroll, and never the person who ran that run
--     (maker-checker). Approval is written to the audit log.
--   * Reopening a finalized run: Owner / Administrator only (not Super Admin), with a reason and the
--     run's month typed as confirmation. Finalized payslips are read-only except their payment status.
--   * Employees and Managers have no payroll access at all: no own payslips, no tax declarations,
--     until that is explicitly approved.
--   * Projects: Administrator full · Manager creates and runs the projects they lead · HR, Manager and
--     Employee read the projects they belong to · Finance none.
--   * Leave Management is off for Phase 1 at the database level (platform_features), not only in the UI.
--     Existing leave data stays; the attendance and payroll engines still read it.
--   * Staff directory: only name, code, work email, photo, department, designation, branch, reporting
--     line and status. Phone and joining date are no longer exposed to every member.
--   * Employees with attendance or payroll history can't be deleted (mark them exited / deactivate).
--   * Nobody can change their own company membership or role.

-- ===========================================================================
-- 1. Super Admin acting inside a company
-- ===========================================================================
-- true when the user is a super admin who is not a member of this company: they act as an
-- Administrator there. A super admin who is also a member keeps their membership role.
create or replace function public.sa_acting(cid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select cid is not null and auth.uid() is not null
    and exists (select 1 from public.platform_admins where user_id = auth.uid())
    and exists (select 1 from public.companies where id = cid)
    and not exists (select 1 from public.company_members where company_id = cid and user_id = auth.uid());
$$;

create or replace function public.is_member(cid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select (exists (
    select 1 from public.company_members m
    where m.company_id = cid and m.user_id = auth.uid() and m.active
  ) and public.in_good_standing(cid)) or public.sa_acting(cid);
$$;

create or replace function public.has_role(cid uuid, roles text[])
returns boolean language sql stable security definer set search_path = public as $$
  select (exists (
    select 1 from public.company_members m
    where m.company_id = cid and m.user_id = auth.uid() and m.active and m.role = any(roles)
  ) and public.in_good_standing(cid))
  or ('company_admin' = any(roles) and public.sa_acting(cid));
$$;

-- permissions a super admin gets in a company: the Administrator's, minus payroll approval
create or replace function public.sa_permissions()
returns setof text language sql stable security definer set search_path = public as $$
  select permission from public.role_permissions where role = 'company_admin' and permission <> 'salaries.approve';
$$;

create or replace function public.has_perm(cid uuid, perm text)
returns boolean language sql stable security definer set search_path = public as $$
  select (exists (
    select 1 from public.company_members m
    join public.role_permissions rp on rp.role = m.role
    where m.company_id = cid and m.user_id = auth.uid() and m.active and rp.permission = perm
  ) and public.in_good_standing(cid))
  or (public.sa_acting(cid) and perm in (select public.sa_permissions()));
$$;

-- ===========================================================================
-- 2. Platform features (Leave is off in Phase 1). Changed only by SQL.
-- ===========================================================================
create table if not exists public.platform_features (
  feature  text primary key,
  enabled  boolean not null default false,
  note     text
);
alter table public.platform_features enable row level security;
drop policy if exists pf_read on public.platform_features;
create policy pf_read on public.platform_features for select to authenticated using (true);
insert into public.platform_features (feature, enabled, note)
values ('leave', false, 'Leave Management and approvals: outside the Phase 1 BRD')
on conflict (feature) do nothing;

create or replace function public.feature_enabled(f text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select enabled from public.platform_features where feature = f), false);
$$;

-- what the signed-in user may do; features are reported as 'feature.<name>' permissions
create or replace function public.my_access(cid uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  with feats as (
    select coalesce(jsonb_agg('feature.' || feature order by feature), '[]') f from public.platform_features where enabled
  )
  select case
    when m.user_id is null and public.sa_acting(cid) then jsonb_build_object('allowed', true, 'role', 'super_admin',
           'permissions', (select coalesce(jsonb_agg(p order by p), '[]') from public.sa_permissions() p) || (select f from feats))
    when m.user_id is null then jsonb_build_object('allowed', false, 'reason', 'not_member')
    when not m.active then jsonb_build_object('allowed', false, 'reason', 'membership_inactive')
    when not public.in_good_standing(cid) then jsonb_build_object('allowed', false, 'reason', 'employee_inactive')
    else jsonb_build_object('allowed', true, 'role', m.role,
           'permissions', coalesce((select jsonb_agg(rp.permission order by rp.permission) from public.role_permissions rp where rp.role = m.role), '[]')
                          || (select f from feats))
  end
  from (select 1) one
  left join public.company_members m on m.company_id = cid and m.user_id = auth.uid();
$$;

-- ===========================================================================
-- 3. Audit: flag what a super admin does, and audit every write it makes
-- ===========================================================================
alter table public.audit_log add column if not exists via_super_admin boolean not null default false;

create or replace function public.audit_log_flag_sa()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and exists (select 1 from public.platform_admins where user_id = auth.uid())
     and (new.company_id is null or not exists (
       select 1 from public.company_members where company_id = new.company_id and user_id = auth.uid())) then
    new.via_super_admin := true;
  end if;
  return new;
end $$;
drop trigger if exists audit_log_flag_sa on public.audit_log;
create trigger audit_log_flag_sa before insert on public.audit_log for each row execute function public.audit_log_flag_sa();

-- tables that have no row audit of their own get one that fires only for a super admin
create or replace function public.sa_write_audit()
returns trigger language plpgsql security definer set search_path = public as $$
declare rec jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
begin
  if auth.uid() is null or not public.sa_acting((rec ->> 'company_id')::uuid) then return null; end if;
  insert into public.audit_log (company_id, user_id, table_name, record_id, action, old_data, new_data, ip)
  values ((rec ->> 'company_id')::uuid, auth.uid(), tg_table_name, rec ->> 'id', lower(tg_op),
          case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
          case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end, public.request_ip());
  return null;
end $$;

do $$
declare t record;
begin
  for t in
    select c.relname from pg_class c
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    where c.relkind = 'r' and c.relname not in ('audit_log', 'notifications')
      and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'company_id' and not a.attisdropped)
      and not exists (select 1 from pg_trigger g join pg_proc p on p.oid = g.tgfoid
                      where g.tgrelid = c.oid and p.proname = 'audit_trigger')
  loop
    execute format('drop trigger if exists zz_sa_audit on public.%I', t.relname);
    execute format('create trigger zz_sa_audit after insert or update or delete on public.%I
                    for each row execute function public.sa_write_audit()', t.relname);
  end loop;
end $$;

-- reads can't be audited by triggers: the app records each company a super admin opens (once an hour)
create or replace function public.sa_log_access(cid uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.sa_acting(cid) then return; end if;
  if exists (select 1 from public.audit_log where company_id = cid and user_id = auth.uid()
             and action = 'super_admin_access' and at > now() - interval '1 hour') then return; end if;
  insert into public.audit_log (company_id, user_id, table_name, record_id, action, ip)
  values (cid, auth.uid(), 'companies', cid::text, 'super_admin_access', public.request_ip());
end $$;
revoke execute on function public.sa_log_access(uuid) from public, anon;
grant execute on function public.sa_log_access(uuid) to authenticated;

-- a super admin can't make itself a company administrator
create or replace function public.sa_set_company_admin(p_company uuid, p_email text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_user uuid; v_role text;
begin
  if not public.is_super_admin() then raise exception 'Super admin only' using errcode = '42501'; end if;
  select id into v_user from public.profiles where email = lower(trim(p_email));
  if v_user is null then raise exception 'No account with email %. They must sign up or be invited first.', p_email; end if;
  if v_user = auth.uid() then raise exception 'You can''t make yourself a company administrator' using errcode = '42501'; end if;
  select role into v_role from public.company_members where company_id = p_company and user_id = v_user;
  if v_role = 'owner' then raise exception 'That user is the company owner already'; end if;
  insert into public.company_members (company_id, user_id, role, active) values (p_company, v_user, 'company_admin', true)
  on conflict (company_id, user_id) do update set role = 'company_admin', active = true;
  insert into public.audit_log (company_id, user_id, table_name, record_id, action, new_data, ip)
  values (p_company, auth.uid(), 'company_members', v_user::text, 'super_admin_grant_admin', jsonb_build_object('email', p_email), public.request_ip());
  return v_user;
end $$;

-- ===========================================================================
-- 4. Memberships: nobody changes their own (no self-promotion, no self-lockout)
-- ===========================================================================
drop policy if exists members_write on public.company_members;
create policy members_write on public.company_members for all
  using (public.has_perm(company_id, 'employees.assign_role') and role <> 'owner' and user_id <> auth.uid())
  with check (public.has_perm(company_id, 'employees.assign_role') and role <> 'owner' and user_id <> auth.uid());

-- ===========================================================================
-- 5. Payroll approval, reopen and finalized payslips
-- ===========================================================================
insert into public.role_permissions (role, permission) values ('finance', 'salaries.approve') on conflict do nothing;

create or replace function public.approve_payroll(p_run uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r public.payroll_runs%rowtype; p record; l record;
begin
  select * into r from public.payroll_runs where id = p_run;
  if r.id is null or not public.has_perm(r.company_id, 'salaries.approve') then
    raise exception 'Only an Administrator or Finance / Payroll can approve payroll' using errcode = '42501';
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

-- reopening needs the run's month typed back ('YYYY-MM') as confirmation; members only (not Super Admin)
drop function if exists public.reopen_payroll(uuid, text);
create or replace function public.reopen_payroll(p_run uuid, p_reason text, p_confirm text)
returns void language plpgsql security definer set search_path = public as $$
declare r public.payroll_runs%rowtype; p record; l record;
begin
  select * into r from public.payroll_runs where id = p_run;
  if r.id is null or not exists (
       select 1 from public.company_members m
       where m.company_id = r.company_id and m.user_id = auth.uid() and m.active and m.role in ('owner','company_admin'))
     or not public.in_good_standing(r.company_id) then
    raise exception 'Only the owner or a company administrator can reopen payroll' using errcode = '42501';
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
revoke execute on function public.reopen_payroll(uuid, text, text) from public, anon;
grant execute on function public.reopen_payroll(uuid, text, text) to authenticated;

-- finalized payroll is read-only: only the payment status of a payslip may still change
create or replace function public.payslips_locked_guard()
returns trigger language plpgsql as $$
begin
  if public.payroll_run_locked(old.run_id)
     and (to_jsonb(new) - 'payment_status') is distinct from (to_jsonb(old) - 'payment_status') then
    raise exception 'This payroll is finalized; payslips are read-only' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists payslips_locked_guard on public.payslips;
create trigger payslips_locked_guard before update on public.payslips for each row execute function public.payslips_locked_guard();

-- ===========================================================================
-- 6. Payroll is not visible to Employees or Managers (own payslips / tax declarations not approved)
-- ===========================================================================
drop policy if exists slips_select on public.payslips;
create policy slips_select on public.payslips for select using (public.has_perm(company_id, 'salaries.read'));

drop policy if exists td_select on public.tax_declarations;
drop policy if exists td_insert on public.tax_declarations;
drop policy if exists td_update on public.tax_declarations;
create policy td_select on public.tax_declarations for select using (public.has_perm(company_id, 'salaries.read'));
create policy td_insert on public.tax_declarations for insert with check (public.has_perm(company_id, 'salaries.manage'));
create policy td_update on public.tax_declarations for update using (public.has_perm(company_id, 'salaries.manage'))
  with check (public.has_perm(company_id, 'salaries.manage'));

-- ===========================================================================
-- 7. Projects (confirmed mapping)
-- ===========================================================================
insert into public.role_permissions (role, permission)
select r, p from (values ('owner'), ('company_admin')) roles(r), unnest(array['projects.manage_all', 'projects.create', 'projects.use']) p
union all select 'manager', p from unnest(array['projects.create', 'projects.use']) p
union all select 'hr', 'projects.use'
union all select 'employee', 'projects.use'
on conflict do nothing;

create or replace function public.can_view_project(pid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.projects p where p.id = pid and (
      public.has_perm(p.company_id, 'projects.manage_all')
      or (public.has_perm(p.company_id, 'projects.use') and public.is_project_member(p.id))
    )
  );
$$;

-- is_project_member covers the project's manager, so a Manager runs the projects they lead
create or replace function public.can_manage_project(pid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.projects p
    left join public.employees e on e.id = p.manager_id
    where p.id = pid and (
      public.has_perm(p.company_id, 'projects.manage_all')
      or (public.has_perm(p.company_id, 'projects.create') and e.user_id = auth.uid())
    )
  );
$$;

drop policy if exists projects_select on public.projects;
drop policy if exists projects_insert on public.projects;
drop policy if exists projects_update on public.projects;
drop policy if exists projects_delete on public.projects;
-- written out on the row (not via can_view_project) so a project is visible to its creator in
-- insert ... returning, before the row exists for a lookup
create policy projects_select on public.projects for select using (
  public.has_perm(company_id, 'projects.manage_all')
  or (public.has_perm(company_id, 'projects.use')
      and (manager_id = public.my_employee_id(company_id) or public.is_project_member(id))));
-- a Manager creates projects that they lead
create policy projects_insert on public.projects for insert with check (
  public.has_perm(company_id, 'projects.manage_all')
  or (public.has_perm(company_id, 'projects.create') and manager_id = public.my_employee_id(company_id)));
create policy projects_update on public.projects for update using (public.can_manage_project(id))
  with check (public.has_perm(company_id, 'projects.manage_all')
              or (public.has_perm(company_id, 'projects.create') and manager_id = public.my_employee_id(company_id)));
create policy projects_delete on public.projects for delete using (public.has_perm(company_id, 'projects.manage_all'));

-- tasks in a project: project members see them only if they also hold the Tasks permission (unchanged),
-- and a task can be filed under a project only by someone who can see that project (unchanged)

-- ===========================================================================
-- 8. Leave Management: blocked at the database while the feature is off
-- ===========================================================================
drop policy if exists leave_types_select on public.leave_types;
drop policy if exists leave_types_write on public.leave_types;
create policy leave_types_select on public.leave_types for select using (public.feature_enabled('leave') and public.is_member(company_id));
create policy leave_types_write on public.leave_types for all using (public.feature_enabled('leave') and public.has_perm(company_id, 'leave.manage'))
  with check (public.feature_enabled('leave') and public.has_perm(company_id, 'leave.manage'));

drop policy if exists leave_bal_select on public.leave_balances;
drop policy if exists leave_bal_write on public.leave_balances;
create policy leave_bal_select on public.leave_balances for select using (public.feature_enabled('leave') and public.can_view_employee(employee_id));
create policy leave_bal_write on public.leave_balances for all using (public.feature_enabled('leave') and public.has_perm(company_id, 'leave.manage'))
  with check (public.feature_enabled('leave') and public.has_perm(company_id, 'leave.manage'));

drop policy if exists leave_req_select on public.leave_requests;
drop policy if exists leave_req_insert on public.leave_requests;
drop policy if exists leave_req_update on public.leave_requests;
create policy leave_req_select on public.leave_requests for select using (public.feature_enabled('leave') and public.can_view_employee(employee_id));
create policy leave_req_insert on public.leave_requests for insert with check (
  public.feature_enabled('leave') and (employee_id = public.my_employee_id(company_id) or public.has_perm(company_id, 'leave.manage')));
create policy leave_req_update on public.leave_requests for update using (
  public.feature_enabled('leave') and (employee_id = public.my_employee_id(company_id) or public.has_perm(company_id, 'leave.manage')
                                       or public.is_manager_of(employee_id)))
  with check (public.feature_enabled('leave') and public.is_member(company_id));

-- ===========================================================================
-- 9. Staff directory: basic details only
-- ===========================================================================
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
where public.is_member(e.company_id);
grant select on public.employee_directory to authenticated;

-- ===========================================================================
-- 10. Removing employees keeps history: a record with attendance or payroll history can't be deleted
-- ===========================================================================
create or replace function public.employees_before_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- the company itself is being deleted (retention purge cascades here): allow
  if not exists (select 1 from public.companies where id = old.company_id) then return old; end if;
  if exists (select 1 from public.payslips where employee_id = old.id)
     or exists (select 1 from public.daily_attendance where employee_id = old.id)
     or exists (select 1 from public.punches_raw where employee_id = old.id)
     or exists (select 1 from public.employee_ctc where employee_id = old.id)
     or exists (select 1 from public.leave_requests where employee_id = old.id) then
    raise exception 'This employee has attendance or payroll history, so the record is kept. Mark them exited or deactivate them instead.'
      using errcode = '23503';
  end if;
  return old;
end $$;
drop trigger if exists employees_before_delete on public.employees;
create trigger employees_before_delete before delete on public.employees for each row execute function public.employees_before_delete();
