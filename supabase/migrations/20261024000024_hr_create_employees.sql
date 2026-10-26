-- corpgroup.com · 0024 HR Managers create employee records (decision of 24 Oct 2026)
--
-- HR (role 'hr') may now add employee records — one by one or by bulk import. Everything that gives a
-- person access stays with the Administrator (employees.account / employees.assign_role): login,
-- invitation, activation and the system role. The rest of the approved matrix is unchanged: HR keeps
-- view-only salaries and the statutory / bank fields, and can't approve payroll.
--
-- Updates were already guarded (0018: login, role and activation need employees.account). Inserts had
-- no such guard because only Administrators could insert; now that HR can, a record created by someone
-- without employees.account must start with no login, no invitation, the plain 'employee' role and an
-- active status. Otherwise a record created with invite_role 'company_admin' would make that person an
-- Administrator when they activate their account.

insert into public.role_permissions (role, permission) values ('hr', 'employees.create') on conflict do nothing;

create or replace function public.employees_insert_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.has_perm(new.company_id, 'employees.account') then
    if new.user_id is not null then
      raise exception 'Only an administrator can link a login to an employee record' using errcode = '42501';
    end if;
    if coalesce(new.invite_role, 'employee') <> 'employee' then
      raise exception 'Only an administrator can choose the system role' using errcode = '42501';
    end if;
    if new.invited_at is not null then
      raise exception 'Only an administrator can send invitations' using errcode = '42501';
    end if;
    if new.status not in ('active','notice') then
      raise exception 'New employee records start as active' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists employees_insert_guard on public.employees;
create trigger employees_insert_guard before insert on public.employees
  for each row execute function public.employees_insert_guard();
