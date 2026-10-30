-- corpgroup.com · 0057 a wrong mobile number at sign-up
--
-- Found on staging (30 Oct 2026): someone typed an email address in "Mobile number" on /join. The request was
-- accepted, and approving it then failed on employees_phone_format. Now:
--   * join_company_for refuses a mobile number that isn't one (same rule as employees_phone_format);
--   * approve_join_request never fails on the phone: an invalid number is left out and HR adds it later.
-- (Bodies otherwise unchanged from 0055 and 0056.)

-- approve_join_request
create or replace function public.approve_join_request(p_request uuid, p_role text)
returns uuid language plpgsql security definer set search_path = public as $$
declare r public.join_requests%rowtype; v_emp uuid; v_first text; v_last text; v_phone text;
begin
  select * into r from public.join_requests where id = p_request;
  if r.id is null or not (public.has_perm(r.company_id, 'employees.account') and public.has_perm(r.company_id, 'employees.assign_role')) then
    raise exception 'Only the Owner or the Admin can approve sign-ups' using errcode = '42501';
  end if;
  if r.status <> 'pending' then raise exception 'This request was already %', r.status; end if;
  if p_role is null or p_role not in ('hr','manager','employee') then raise exception 'Choose an access role'; end if;

  -- link an existing record with this email (e.g. added by HR earlier), otherwise create one
  select id into v_emp from public.employees
  where company_id = r.company_id and lower(email) = lower(r.email) and user_id is null and removed_at is null limit 1;
  -- a mobile number typed wrongly at sign-up doesn't block approval: HR adds the right one later
  v_phone := case when trim(r.phone) ~ '^\+?[0-9][0-9 ()-]{6,19}$' then trim(r.phone) end;
  v_first := split_part(r.full_name, ' ', 1);
  v_last := nullif(trim(substr(r.full_name, length(v_first) + 1)), '');
  if v_emp is null then
    insert into public.employees (company_id, user_id, first_name, last_name, email, phone, designation_id, department_id, date_of_joining, invite_role)
    values (r.company_id, r.user_id, v_first, v_last, r.email, v_phone, r.designation_id, r.department_id, current_date, p_role)
    returning id into v_emp;
  else
    update public.employees set user_id = r.user_id, phone = coalesce(phone, v_phone),
      designation_id = coalesce(r.designation_id, designation_id), department_id = coalesce(r.department_id, department_id),
      invite_role = p_role
    where id = v_emp;
  end if;
  insert into public.company_members (company_id, user_id, role, active) values (r.company_id, r.user_id, p_role, true)
  on conflict (company_id, user_id) do update set role = excluded.role, active = true;
  update public.join_requests set status = 'approved', role = p_role, employee_id = v_emp, decided_by = auth.uid(), decided_at = now()
  where id = p_request;
  insert into public.audit_log (company_id, user_id, table_name, record_id, action, new_data, ip)
  values (r.company_id, auth.uid(), 'join_requests', p_request::text, 'approve',
          jsonb_build_object('email', r.email, 'role', p_role, 'employee_id', v_emp), public.request_ip());
  perform public.notify(r.user_id, r.company_id, 'Your account was approved', 'You can now sign in.', '/c/' || r.company_id || '/dashboard');
  return v_emp;
end $$;

-- join_company_for
create or replace function public.join_company_for(p_user uuid, p_code text, p_full_name text, p_phone text, p_projects uuid[])
returns uuid language plpgsql security definer set search_path = public as $$
declare v_company uuid; v_email text; v_id uuid;
begin
  select id into v_company from public.companies where upper(join_code) = upper(trim(p_code)) and status = 'active';
  if v_company is null then raise exception 'That sign-up code is not valid. Ask your company for the current link or code.'; end if;
  if coalesce(trim(p_full_name), '') = '' then raise exception 'Enter your full name'; end if;
  if coalesce(trim(p_phone), '') = '' then raise exception 'Enter your mobile number'; end if;
  if trim(p_phone) !~ '^\+?[0-9][0-9 ()-]{6,19}$' then raise exception 'Enter a valid mobile number, e.g. 98480 22338'; end if;
  if exists (select 1 from public.company_members where company_id = v_company and user_id = p_user) then
    raise exception 'You already belong to this company. Sign in instead.';
  end if;
  select email into v_email from public.profiles where id = p_user;
  insert into public.join_requests (company_id, user_id, full_name, email, phone)
  values (v_company, p_user, trim(p_full_name), v_email, trim(p_phone))
  on conflict (company_id, user_id) do update set full_name = excluded.full_name, phone = excluded.phone,
    status = 'pending', decided_by = null, decided_at = null, decision_note = null, created_at = now()
    where public.join_requests.status <> 'approved'
  returning id into v_id;
  if v_id is null then raise exception 'Your request was already approved. Sign in instead.'; end if;
  perform public.add_project_requests(p_user, v_company, p_projects);
  perform public.notify_approvers(v_company, 'New sign-up waiting for approval',
    trim(p_full_name) || ' (' || v_email || ')' ||
    case when coalesce(array_length(p_projects, 1), 0) > 0 then ' · asks to join ' || array_length(p_projects, 1) || ' project(s)' else '' end,
    '/c/' || v_company || '/requests');
  return v_id;
end $$;
revoke execute on function public.join_company_for(uuid, text, text, text, uuid[]) from public, anon, authenticated;
