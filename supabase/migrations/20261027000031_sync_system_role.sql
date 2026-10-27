-- corpgroup.com · 0031 one system role per person per company
--
-- The role can be changed in two places: the employee's Job tab ("System role", employees.invite_role)
-- and Settings → Users & roles (company_members.role). Access comes from company_members, so a change
-- made on the Job tab for someone who already has a login didn't take effect. Now each change is
-- copied to the other side (who may change it is still checked: employees.assign_role). The Owner's
-- membership is never touched, and nothing loops: each side is only written when it differs.

create or replace function public.employees_sync_role()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.user_id is not null and new.invite_role is distinct from old.invite_role then
    update public.company_members set role = new.invite_role
    where company_id = new.company_id and user_id = new.user_id and role <> 'owner' and role is distinct from new.invite_role;
  end if;
  return null;
end $$;
drop trigger if exists employees_sync_role on public.employees;
create trigger employees_sync_role after update of invite_role on public.employees
  for each row execute function public.employees_sync_role();

create or replace function public.members_sync_role()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.role <> 'owner' and new.role is distinct from old.role then
    update public.employees set invite_role = new.role
    where company_id = new.company_id and user_id = new.user_id and invite_role is distinct from new.role;
  end if;
  return null;
end $$;
drop trigger if exists members_sync_role on public.company_members;
create trigger members_sync_role after update of role on public.company_members
  for each row execute function public.members_sync_role();

-- repair: a role chosen on the Job tab that never reached the person's access
update public.company_members m set role = e.invite_role
from public.employees e
where e.company_id = m.company_id and e.user_id = m.user_id
  and m.role <> 'owner' and m.role is distinct from e.invite_role;
