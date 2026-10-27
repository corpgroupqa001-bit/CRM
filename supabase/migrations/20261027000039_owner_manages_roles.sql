-- corpgroup.com · 0039 the Owner also manages roles
--
-- Decision of 27 Oct 2026 (option A), beyond BRD §5.3 where the Owner has Settings R: the Owner manages roles
-- alongside the Company Admin. The Owner can already make anyone a Company Admin, and a small company may
-- have no Company Admin at all. The Owner role itself still can't be edited, the Company Admin role still
-- keeps "Manage roles", and every change is in the audit log. HR / Payroll keep viewing only.

insert into public.role_permissions (role, permission) values ('owner', 'roles.manage') on conflict do nothing;

create or replace function public.save_default_role(p_company uuid, p_role text, p_permissions text[])
returns void language plpgsql security definer set search_path = public as $$
declare v_bad text; v_perms text[] := array(select distinct unnest(coalesce(p_permissions, '{}')) order by 1);
begin
  if not public.has_perm(p_company, 'roles.manage') then
    raise exception 'Only the Owner or a Company Admin can change roles' using errcode = '42501';
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
    raise exception 'Only the Owner or a Company Admin can change roles' using errcode = '42501';
  end if;
  delete from public.company_default_roles where company_id = p_company and role = p_role;
  insert into public.audit_log (company_id, user_id, table_name, record_id, action, ip)
  values (p_company, auth.uid(), 'company_default_roles', p_role, 'reset', public.request_ip());
end $$;

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
    select public.role_perms(p_company, v_base) permission where p_from_custom is null
    union
    select permission from public.company_role_permissions where role_id = p_from_custom
  ) x;
  return v_id;
end $$;

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
