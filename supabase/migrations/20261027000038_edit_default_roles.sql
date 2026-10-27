-- corpgroup.com · 0038 view and edit every role; roles managed by the Company Admin (BRD v2.0 §5.2, §5.3)
--
-- Decision of 27 Oct 2026:
--   * Every role can be viewed, and every role except the Owner can be edited. Editing a default role
--     (Company Admin, HR / Payroll, Manager, Employee) changes it for this company only; other companies
--     keep the standard matrix (role_permissions). "Reset to standard" removes the company's version.
--   * As per the BRD, the Company Admin manages roles ("Configure the company, roles, devices and
--     policies"; "A Company Admin can clone a default role"). The Owner and HR / Payroll have Settings R,
--     so they view roles only: roles.manage is taken away from the Owner (given in 0037).
--   * The Company Admin role always keeps "Manage roles" and "Change people's roles", so a company can't
--     lock itself out of this page.

delete from public.role_permissions where role = 'owner' and permission = 'roles.manage';

-- a company's own version of a default role
create table if not exists public.company_default_roles (
  company_id  uuid not null references public.companies(id) on delete cascade,
  role        text not null check (role in ('company_admin','hr','manager','employee')),
  permissions text[] not null,
  updated_by  uuid references auth.users(id) on delete set null,
  updated_at  timestamptz not null default now(),
  primary key (company_id, role)
);
alter table public.company_default_roles enable row level security;
drop policy if exists cdr_select on public.company_default_roles;
create policy cdr_select on public.company_default_roles for select using (public.is_member(company_id) or public.sa_acting(company_id));

-- the permissions of a default role in a company: the company's version if it has one, else the standard
create or replace function public.role_perms(cid uuid, p_role text)
returns setof text language sql stable security definer set search_path = public as $$
  select unnest(d.permissions) from public.company_default_roles d where d.company_id = cid and d.role = p_role
  union all
  select rp.permission from public.role_permissions rp
  where rp.role = p_role and not exists (select 1 from public.company_default_roles d where d.company_id = cid and d.role = p_role);
$$;

create or replace function public.has_perm(cid uuid, perm text)
returns boolean language sql stable security definer set search_path = public as $$
  select (exists (
    select 1 from public.company_members m
    where m.company_id = cid and m.user_id = auth.uid() and m.active
      and case when m.custom_role_id is not null
               then exists (select 1 from public.company_role_permissions cp where cp.role_id = m.custom_role_id and cp.permission = perm)
               when exists (select 1 from public.company_default_roles d where d.company_id = cid and d.role = m.role)
               then exists (select 1 from public.company_default_roles d where d.company_id = cid and d.role = m.role and perm = any(d.permissions))
               else exists (select 1 from public.role_permissions rp where rp.role = m.role and rp.permission = perm) end
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
           'permissions', coalesce((select jsonb_agg(p order by p) from public.role_perms(cid, m.role) p), '[]') || (select f from feats))
  end
  from (select 1) one
  left join public.company_members m on m.company_id = cid and m.user_id = auth.uid();
$$;

-- save this company's version of a default role
create or replace function public.save_default_role(p_company uuid, p_role text, p_permissions text[])
returns void language plpgsql security definer set search_path = public as $$
declare v_bad text; v_perms text[] := array(select distinct unnest(coalesce(p_permissions, '{}')) order by 1);
begin
  if not public.has_perm(p_company, 'roles.manage') then
    raise exception 'Only a Company Admin can change roles' using errcode = '42501';
  end if;
  if p_role is null or p_role not in ('company_admin','hr','manager','employee') then
    raise exception 'The Owner role can''t be changed';
  end if;
  select p into v_bad from unnest(v_perms) p where not exists (select 1 from public.role_permissions where permission = p) limit 1;
  if v_bad is not null then raise exception 'Unknown permission %', v_bad; end if;
  if p_role = 'company_admin' and not (v_perms @> array['roles.manage','employees.assign_role']) then
    raise exception 'The Company Admin role must keep "Manage roles" and "Change people''s roles", or nobody could manage roles';
  end if;
  insert into public.company_default_roles (company_id, role, permissions, updated_by, updated_at)
  values (p_company, p_role, v_perms, auth.uid(), now())
  on conflict (company_id, role) do update set permissions = excluded.permissions, updated_by = excluded.updated_by, updated_at = now();
  insert into public.audit_log (company_id, user_id, table_name, record_id, action, new_data, ip)
  values (p_company, auth.uid(), 'company_default_roles', p_role, 'permissions', jsonb_build_object('role', p_role, 'permissions', to_jsonb(v_perms)), public.request_ip());
end $$;

create or replace function public.reset_default_role(p_company uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_perm(p_company, 'roles.manage') then
    raise exception 'Only a Company Admin can change roles' using errcode = '42501';
  end if;
  delete from public.company_default_roles where company_id = p_company and role = p_role;
  insert into public.audit_log (company_id, user_id, table_name, record_id, action, ip)
  values (p_company, auth.uid(), 'company_default_roles', p_role, 'reset', public.request_ip());
end $$;

-- a copy of a default role starts from this company's version of it
create or replace function public.clone_role(p_company uuid, p_name text, p_from_role text, p_from_custom uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_base text;
begin
  if not public.has_perm(p_company, 'roles.manage') then
    raise exception 'Only a Company Admin can manage roles' using errcode = '42501';
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
    select public.role_perms(p_company, v_base) permission where p_from_custom is null
    union
    select permission from public.company_role_permissions where role_id = p_from_custom
  ) x;
  return v_id;
end $$;

-- same wording for the other custom-role functions now that only the Company Admin manages roles
create or replace function public.save_role(p_role uuid, p_name text, p_permissions text[])
returns void language plpgsql security definer set search_path = public as $$
declare r public.company_roles%rowtype; v_bad text;
begin
  select * into r from public.company_roles where id = p_role;
  if r.id is null or not public.has_perm(r.company_id, 'roles.manage') then
    raise exception 'Only a Company Admin can manage roles' using errcode = '42501';
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
    raise exception 'Only a Company Admin can manage roles' using errcode = '42501';
  end if;
  select count(*) into n from public.company_members where custom_role_id = r.id;
  if n > 0 then raise exception '% % still % this role: give them another role first', n, case when n = 1 then 'person' else 'people' end,
                                case when n = 1 then 'has' else 'have' end; end if;
  delete from public.company_roles where id = r.id;
end $$;

revoke execute on function public.save_default_role(uuid, text, text[]) from public, anon;
revoke execute on function public.reset_default_role(uuid, text) from public, anon;
revoke execute on function public.role_perms(uuid, text) from public, anon, authenticated;   -- used inside my_access / clone_role only
grant execute on function public.save_default_role(uuid, text, text[]) to authenticated;
grant execute on function public.reset_default_role(uuid, text) to authenticated;
