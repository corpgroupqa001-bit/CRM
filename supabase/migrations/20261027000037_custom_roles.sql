-- corpgroup.com · 0037 custom roles (BRD v2.0 §5.2)
--
-- "A Company Admin can clone a default role into a custom role and adjust module-level permissions."
-- Approved 27 Oct 2026: the Owner and the Company Admin of a company manage its custom roles.
--
--   * company_roles: a company's own roles, each copied from one of the four assignable default roles
--     (Company Admin, HR / Payroll, Manager, Employee). The Owner and Super Admin roles can't be copied.
--   * company_role_permissions: the permissions ticked for that role. Only permissions that exist in the
--     default matrix (role_permissions) can be ticked.
--   * company_members.custom_role_id: a person given a custom role. Their company_members.role stays the
--     role it was copied from, so rules tied to a role name (notifications to HR, the Owner's own rules)
--     keep working; what they may DO comes from the ticked permissions only (has_perm, my_access).
--   * Changing someone's system role anywhere else (the employee's Job tab) takes them off the custom role.
--   * A custom role still held by someone can't be deleted.

-- who may manage custom roles
insert into public.role_permissions (role, permission) values ('owner', 'roles.manage'), ('company_admin', 'roles.manage')
on conflict do nothing;

create table if not exists public.company_roles (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  name        text not null check (length(trim(name)) between 2 and 60),
  base_role   text not null check (base_role in ('company_admin','hr','manager','employee')),
  description text,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists company_roles_name_key on public.company_roles (company_id, lower(trim(name)));

create table if not exists public.company_role_permissions (
  role_id     uuid not null references public.company_roles(id) on delete cascade,
  company_id  uuid not null references public.companies(id) on delete cascade,
  permission  text not null,
  primary key (role_id, permission)
);

alter table public.company_members add column if not exists custom_role_id uuid references public.company_roles(id) on delete restrict;
create index if not exists company_members_custom_role_idx on public.company_members (custom_role_id) where custom_role_id is not null;

-- the permissions a custom role may include: everything in the default matrix
create or replace function public.assignable_permissions()
returns setof text language sql stable security definer set search_path = public as $$
  select distinct permission from public.role_permissions order by 1;
$$;

-- a permission must be a real one, and belong to the same company as its role
create or replace function public.company_role_permissions_check()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.role_permissions where permission = new.permission) then
    raise exception 'Unknown permission %', new.permission;
  end if;
  select company_id into new.company_id from public.company_roles where id = new.role_id;
  return new;
end $$;
drop trigger if exists company_role_permissions_check on public.company_role_permissions;
create trigger company_role_permissions_check before insert or update on public.company_role_permissions
  for each row execute function public.company_role_permissions_check();

create or replace function public.company_roles_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' and new.base_role is distinct from old.base_role then
    raise exception 'The role a custom role was copied from can''t be changed';
  end if;
  return new;
end $$;
drop trigger if exists company_roles_touch on public.company_roles;
create trigger company_roles_touch before update on public.company_roles
  for each row execute function public.company_roles_touch();

-- a member on a custom role carries its base role; a role change made elsewhere ends the custom role
create or replace function public.company_members_custom_role()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_base text; v_company uuid;
begin
  if tg_op = 'UPDATE' and new.role is distinct from old.role and new.custom_role_id is not distinct from old.custom_role_id then
    new.custom_role_id := null;
  end if;
  if new.custom_role_id is not null then
    if new.role = 'owner' or (tg_op = 'UPDATE' and old.role = 'owner') then
      raise exception 'The Owner''s role can''t be changed';
    end if;
    select base_role, company_id into v_base, v_company from public.company_roles where id = new.custom_role_id;
    if v_company is distinct from new.company_id then raise exception 'That role belongs to another company'; end if;
    new.role := v_base;
  end if;
  return new;
end $$;
drop trigger if exists company_members_custom_role on public.company_members;
create trigger company_members_custom_role before insert or update on public.company_members
  for each row execute function public.company_members_custom_role();

-- permissions: a custom role's ticked list replaces the default role's list
create or replace function public.has_perm(cid uuid, perm text)
returns boolean language sql stable security definer set search_path = public as $$
  select (exists (
    select 1 from public.company_members m
    where m.company_id = cid and m.user_id = auth.uid() and m.active
      and case when m.custom_role_id is null
               then exists (select 1 from public.role_permissions rp where rp.role = m.role and rp.permission = perm)
               else exists (select 1 from public.company_role_permissions cp where cp.role_id = m.custom_role_id and cp.permission = perm) end
  ) and public.in_good_standing(cid))
  or (public.sa_acting(cid) and perm in (select public.sa_permissions()));
$$;

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
    when m.custom_role_id is not null then jsonb_build_object('allowed', true, 'role', m.role,
           'custom_role', (select name from public.company_roles where id = m.custom_role_id),
           'permissions', coalesce((select jsonb_agg(cp.permission order by cp.permission) from public.company_role_permissions cp where cp.role_id = m.custom_role_id), '[]')
                          || (select f from feats))
    else jsonb_build_object('allowed', true, 'role', m.role,
           'permissions', coalesce((select jsonb_agg(rp.permission order by rp.permission) from public.role_permissions rp where rp.role = m.role), '[]')
                          || (select f from feats))
  end
  from (select 1) one
  left join public.company_members m on m.company_id = cid and m.user_id = auth.uid();
$$;

-- rules that named the Company Admin role also need the permission behind them, so a custom role copied
-- from Company Admin with that permission unticked can't use them
create or replace function public.manages_company(cid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.has_role(cid, array['owner','company_admin']) and public.has_perm(cid, 'employees.create');
$$;

create or replace function public.grant_support_access(p_company uuid, p_hours integer, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  -- a member Company Admin decides; the Super Admin can't grant access to itself
  if not exists (select 1 from public.company_members m where m.company_id = p_company and m.user_id = auth.uid()
                 and m.active and m.role = 'company_admin') or not public.has_perm(p_company, 'settings.manage') then
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
                                   and m.active and m.role = 'company_admin') or not public.has_perm(s.company_id, 'settings.manage') then
    raise exception 'Only a Company Admin can revoke support access' using errcode = '42501';
  end if;
  update public.support_access set revoked_at = now(), revoked_by = auth.uid() where id = p_id and revoked_at is null;
  insert into public.audit_log (company_id, user_id, table_name, record_id, action, ip)
  values (s.company_id, auth.uid(), 'support_access', p_id::text, 'revoke', public.request_ip());
end $$;

-- create a custom role by copying a default role (or another custom role) with its permissions
create or replace function public.clone_role(p_company uuid, p_name text, p_from_role text, p_from_custom uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_base text;
begin
  if not public.has_perm(p_company, 'roles.manage') then
    raise exception 'Only the Owner or a Company Admin can manage roles' using errcode = '42501';
  end if;
  if p_from_custom is not null then
    select base_role into v_base from public.company_roles where id = p_from_custom and company_id = p_company;
    if v_base is null then raise exception 'Choose a role to copy'; end if;
  else
    if p_from_role is null or p_from_role not in ('company_admin','hr','manager','employee') then raise exception 'Choose a role to copy'; end if;
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
    select permission from public.role_permissions where p_from_custom is null and role = v_base
    union
    select permission from public.company_role_permissions where role_id = p_from_custom
  ) x;
  return v_id;
end $$;

-- replace a custom role's name and ticked permissions in one step
create or replace function public.save_role(p_role uuid, p_name text, p_permissions text[])
returns void language plpgsql security definer set search_path = public as $$
declare r public.company_roles%rowtype; v_bad text;
begin
  select * into r from public.company_roles where id = p_role;
  if r.id is null or not public.has_perm(r.company_id, 'roles.manage') then
    raise exception 'Only the Owner or a Company Admin can manage roles' using errcode = '42501';
  end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Give the role a name'; end if;
  if exists (select 1 from public.company_roles where company_id = r.company_id and id <> r.id and lower(trim(name)) = lower(trim(p_name))) then
    raise exception 'A role called "%" already exists', trim(p_name);
  end if;
  select p into v_bad from unnest(coalesce(p_permissions, '{}')) p
  where not exists (select 1 from public.role_permissions where permission = p) limit 1;
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

create or replace function public.delete_role(p_role uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r public.company_roles%rowtype; n integer;
begin
  select * into r from public.company_roles where id = p_role;
  if r.id is null or not public.has_perm(r.company_id, 'roles.manage') then
    raise exception 'Only the Owner or a Company Admin can manage roles' using errcode = '42501';
  end if;
  select count(*) into n from public.company_members where custom_role_id = r.id;
  if n > 0 then raise exception '% % still % this role: give them another role first', n, case when n = 1 then 'person' else 'people' end,
                                case when n = 1 then 'has' else 'have' end; end if;
  delete from public.company_roles where id = r.id;
end $$;

-- RLS: members of the company read its roles (to see role names); writes go through the functions above
alter table public.company_roles enable row level security;
alter table public.company_role_permissions enable row level security;
drop policy if exists company_roles_select on public.company_roles;
create policy company_roles_select on public.company_roles for select using (public.is_member(company_id) or public.sa_acting(company_id));
drop policy if exists crp_select on public.company_role_permissions;
create policy crp_select on public.company_role_permissions for select using (public.is_member(company_id) or public.sa_acting(company_id));

drop trigger if exists company_roles_audit on public.company_roles;
create trigger company_roles_audit after insert or update or delete on public.company_roles
  for each row execute function public.audit_trigger();

revoke execute on function public.clone_role(uuid, text, text, uuid) from public, anon;
revoke execute on function public.save_role(uuid, text, text[]) from public, anon;
revoke execute on function public.delete_role(uuid) from public, anon;
revoke execute on function public.assignable_permissions() from public, anon;
grant execute on function public.clone_role(uuid, text, text, uuid) to authenticated;
grant execute on function public.save_role(uuid, text, text[]) to authenticated;
grant execute on function public.delete_role(uuid) to authenticated;
grant execute on function public.assignable_permissions() to authenticated;

-- the role is now also set by company_members_custom_role (a BEFORE trigger), which an "update of role"
-- trigger doesn't see: copy every role change to the Job tab
drop trigger if exists members_sync_role on public.company_members;
create trigger members_sync_role after update on public.company_members
  for each row execute function public.members_sync_role();
