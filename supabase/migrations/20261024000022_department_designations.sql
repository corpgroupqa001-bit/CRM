-- corpgroup.com · 0022 designations belong to a department; departments and designations can be deactivated
--
--   * designations.department_id: each designation sits under one department (Engineering / IT →
--     engineering roles, HR → HR roles). The same title may exist in two departments
--     ("Manager" in HR and in Engineering), so names are unique per company + department.
--   * active flags: administrators deactivate instead of deleting, so employees and past requests
--     keep their department / designation; inactive ones are no longer offered to candidates.
--   * submit_join_request() checks on the server that the chosen designation belongs to the chosen
--     department, and that both are active (filtering in the browser alone is not enough).

-- ---------------------------------------------------------------------------
-- 1. Columns and uniqueness
-- ---------------------------------------------------------------------------
alter table public.departments  add column if not exists active boolean not null default true;
alter table public.designations add column if not exists active boolean not null default true;
alter table public.designations add column if not exists department_id uuid references public.departments(id) on delete restrict;
create index if not exists designations_department on public.designations (department_id);

alter table public.designations drop constraint if exists designations_company_id_name_key;
alter table public.designations drop constraint if exists designations_company_department_name_key;
alter table public.designations add constraint designations_company_department_name_key
  unique nulls not distinct (company_id, department_id, name);

alter table public.departments  drop constraint if exists departments_name_present;
alter table public.departments  add constraint departments_name_present check (length(trim(name)) > 0);
alter table public.designations drop constraint if exists designations_name_present;
alter table public.designations add constraint designations_name_present check (length(trim(name)) > 0);

-- ---------------------------------------------------------------------------
-- 2. A designation's department must be in the same company
-- ---------------------------------------------------------------------------
create or replace function public.designations_same_company()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.department_id is not null
     and not exists (select 1 from public.departments where id = new.department_id and company_id = new.company_id) then
    raise exception 'Department belongs to a different company' using errcode = '23503';
  end if;
  return new;
end $$;
drop trigger if exists designations_same_company on public.designations;
create trigger designations_same_company before insert or update of company_id, department_id on public.designations
  for each row execute function public.designations_same_company();

-- ---------------------------------------------------------------------------
-- 3. Candidate request: department required, designation must belong to it, both active
-- ---------------------------------------------------------------------------
create or replace function public.submit_join_request(p_company uuid, p_full_name text, p_phone text,
  p_designation uuid, p_department uuid, p_note text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_email text; v_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  if not exists (select 1 from public.companies where id = p_company and status = 'active') then raise exception 'Choose a company'; end if;
  if coalesce(trim(p_full_name), '') = '' then raise exception 'Enter your full name'; end if;
  if p_department is null or not exists (select 1 from public.departments where id = p_department and company_id = p_company and active) then
    raise exception 'Choose your department';
  end if;
  if p_designation is null or not exists (select 1 from public.designations where id = p_designation and company_id = p_company and active) then
    raise exception 'Choose your designation';
  end if;
  if not exists (select 1 from public.designations where id = p_designation and department_id = p_department) then
    raise exception 'That designation is not part of the selected department' using errcode = '23514';
  end if;
  if exists (select 1 from public.company_members where company_id = p_company and user_id = auth.uid()) then
    raise exception 'You already belong to this company';
  end if;
  select email into v_email from public.profiles where id = auth.uid();
  insert into public.join_requests (company_id, user_id, full_name, email, phone, designation_id, department_id, note)
  values (p_company, auth.uid(), trim(p_full_name), v_email, nullif(trim(p_phone), ''), p_designation, p_department, nullif(trim(p_note), ''))
  on conflict (company_id, user_id) do update set full_name = excluded.full_name, phone = excluded.phone,
    designation_id = excluded.designation_id, department_id = excluded.department_id, note = excluded.note,
    status = 'pending', decided_by = null, decided_at = null, decision_note = null, created_at = now()
    where public.join_requests.status <> 'approved'
  returning id into v_id;
  if v_id is null then raise exception 'Your request was already approved'; end if;
  perform public.notify_roles(p_company, array['owner','company_admin'], 'New sign-up waiting for approval',
    trim(p_full_name) || ' (' || v_email || ')', '/c/' || p_company || '/employees/approvals');
  return v_id;
end $$;

revoke execute on function public.submit_join_request(uuid, text, text, uuid, uuid, text) from public, anon;
grant execute on function public.submit_join_request(uuid, text, text, uuid, uuid, text) to authenticated;
