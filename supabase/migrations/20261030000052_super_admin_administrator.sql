-- corpgroup.com · 0052 the Super Admin is an administrator in every company
--
-- Decision of 30 Oct 2026 (beyond BRD v2.0 §5.2 / OI-13, where the Super Admin has no default access to
-- company data): the platform Super Admin acts as an administrator in every company, always, without
-- the Owner granting support access first, but only for these areas:
--   employees (add, edit, remove, invite, logins, roles) · attendance (read, correct, approve corrections,
--   unlock a month) and devices · leave types and balances · settings, policies and the company profile ·
--   custom roles · projects · tasks · announcements.
-- Never: approving or rejecting leave, salaries and payroll (read, approve, reopen), bank / PAN /
-- statutory details, reading the audit log, or chat in companies where they don't work.
-- In a company where the Super Admin also works (an employee record and membership), their own employee
-- permissions are added on top. Everything they change is still in that company's audit log, flagged
-- via_super_admin (sa_write_audit), and each visit is logged (sa_log_access).

-- 1. acting in a company no longer needs a support-access grant, and works where they are a member too
create or replace function public.sa_acting(cid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select cid is not null and auth.uid() is not null
    and exists (select 1 from public.platform_admins where user_id = auth.uid())
    and exists (select 1 from public.companies where id = cid);
$$;

-- 2. exactly what the Super Admin may do in a company
create or replace function public.sa_permissions()
returns setof text language sql stable security definer set search_path = public as $$
  select unnest(array[
    'employees.create','employees.read_all','employees.update','employees.delete','employees.account','employees.assign_role',
    'attendance.read_all','attendance.manage','attendance.approve','attendance.unlock',
    'leave.manage',
    'company.update','settings.read','settings.manage','settings.org','roles.manage',
    'projects.use','projects.manage_all',
    'tasks.use','tasks.read_all','tasks.manage','tasks.manage_all',
    'announcements.post']);
$$;

-- 3. what the app is told: the Super Admin's permissions plus, where they also work, their own
create or replace function public.my_access(cid uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  with feats as (
    select coalesce(jsonb_agg('feature.' || feature order by feature), '[]') f from public.platform_features where enabled
  ), own as (
    select coalesce(array_agg(p), '{}') ps from (
      select cp.permission p from public.company_members m join public.company_role_permissions cp on cp.role_id = m.custom_role_id
       where m.company_id = cid and m.user_id = auth.uid() and m.active and public.in_good_standing(cid)
      union
      select p from public.company_members m, public.role_perms(cid, m.role) p
       where m.company_id = cid and m.user_id = auth.uid() and m.active and m.custom_role_id is null and public.in_good_standing(cid)
    ) x
  )
  select case
    when public.sa_acting(cid) then jsonb_build_object('allowed', true, 'role', 'super_admin',
           'permissions', (select coalesce(jsonb_agg(p order by p), '[]') from (
                             select public.sa_permissions() p union select unnest(ps) from own) s) || (select f from feats))
    when m.user_id is null then jsonb_build_object('allowed', false, 'reason', 'not_member')
    when not m.active then jsonb_build_object('allowed', false, 'reason', 'membership_inactive')
    when not public.in_good_standing(cid) then jsonb_build_object('allowed', false, 'reason', 'employee_inactive')
    when m.custom_role_id is not null then jsonb_build_object('allowed', true, 'role', m.role,
           'custom_role', (select name from public.company_roles where id = m.custom_role_id),
           'permissions', coalesce((select jsonb_agg(cp.permission order by cp.permission) from public.company_role_permissions cp where cp.role_id = m.custom_role_id), '[]')
                          || (select f from feats))
    else jsonb_build_object('allowed', true, 'role', m.role,
           'permissions', coalesce((select jsonb_agg(p order by p) from public.role_perms(cid, m.role) p), '[]') || (select f from feats))
  end
  from (select 1) one
  left join public.company_members m on m.company_id = cid and m.user_id = auth.uid();
$$;

-- 4. the Super Admin never approves or rejects leave (not even as someone's manager)
create or replace function public.leave_requests_no_super_admin_decision()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status and new.status in ('approved','rejected')
     and exists (select 1 from public.platform_admins where user_id = auth.uid()) then
    raise exception 'The Super Admin can''t approve or reject leave' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists leave_requests_no_super_admin_decision on public.leave_requests;
create trigger leave_requests_no_super_admin_decision before update on public.leave_requests
  for each row execute function public.leave_requests_no_super_admin_decision();
