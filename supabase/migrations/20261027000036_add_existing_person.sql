-- corpgroup.com · 0036 add an existing employee to another company: keep them, or move them
--
-- Decision of 27 Oct 2026 (builds on EMP-10 transfer and AUTH-11 multi-company users). On Add employee, an
-- Owner or Company Admin sees the people of their OTHER companies — only companies where they are Owner
-- or Company Admin too — and either
--   * adds the person here and keeps them where they are, or
--   * moves them: they leave the companies chosen (one, several or all of their companies) the day
--     before they join here.
-- Only name, work email and phone are copied (BRD §7.2: company data never mixes); salary, PAN, bank and
-- attendance stay in each company, and HR / Payroll sets the salary here. A login they already have
-- opens the new company too. Every change is audited in each company and the person is notified.

-- Owner or Company Admin of a company (the roles that manage people across companies)
create or replace function public.manages_company(cid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.has_role(cid, array['owner','company_admin']);
$$;

-- people in my other companies who aren't (actively) in this one yet
create or replace function public.people_from_my_companies(p_company uuid)
returns table(employee_id uuid, full_name text, email text, phone text, has_login boolean,
              companies jsonb)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.manages_company(p_company) then raise exception 'not allowed' using errcode = '42501'; end if;
  return query
    with mine as (
      select m.company_id from public.company_members m
      where m.user_id = auth.uid() and m.active and m.role in ('owner','company_admin') and m.company_id <> p_company
    ), people as (
      select e.*, c.name as company_name from public.employees e
      join mine on mine.company_id = e.company_id
      join public.companies c on c.id = e.company_id and c.status = 'active'
      where e.status in ('active','notice') and e.removed_at is null
    )
    select (array_agg(p.id order by p.updated_at desc))[1],
           (array_agg(trim(p.first_name || ' ' || coalesce(p.last_name, '')) order by p.updated_at desc))[1],
           lower(p.email),
           (array_agg(p.phone order by p.updated_at desc))[1],
           bool_or(p.user_id is not null),
           jsonb_agg(jsonb_build_object('company_id', p.company_id, 'company', p.company_name, 'employee_id', p.id,
                                        'code', p.emp_code, 'owner', exists (select 1 from public.companies oc where oc.id = p.company_id and oc.owner_id = p.user_id))
                     order by p.company_name)
    from people p
    where not exists (select 1 from public.employees t where t.company_id = p_company and lower(t.email) = lower(p.email)
                      and t.status in ('active','notice') and t.removed_at is null)
    group by lower(p.email)
    order by 2;
end $$;

create or replace function public.add_existing_person(p_company uuid, p_source_employee uuid, p_mode text, p_leave uuid[],
  p_role text, p_department uuid, p_designation uuid, p_manager uuid, p_joining date)
returns uuid language plpgsql security definer set search_path = public as $$
declare src public.employees%rowtype; v_new uuid; v_left text[] := '{}'; r record; v_target_name text; v_join date := coalesce(p_joining, current_date);
begin
  select * into src from public.employees where id = p_source_employee;
  if src.id is null or not public.manages_company(p_company) or not public.manages_company(src.company_id) then
    raise exception 'Only an Owner or Company Admin of both companies can do this' using errcode = '42501';
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

revoke execute on function public.manages_company(uuid) from public, anon;
grant execute on function public.manages_company(uuid) to authenticated;
grant execute on function public.people_from_my_companies(uuid) to authenticated;
grant execute on function public.add_existing_person(uuid, uuid, text, uuid[], text, uuid, uuid, uuid, date) to authenticated;
