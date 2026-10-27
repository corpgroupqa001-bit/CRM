-- corpgroup.com · 0028 owners create their companies (BRD v2.0 AUTH-01, COM-01); employees are invited
--
--   * AUTH-01: an owner signs up with name, email and company name; COM-01: an owner can create several
--     companies. create_company() makes the signed-in user the Owner of a new company, with an employee
--     record, the default policies (bootstrap_company) and an audit entry. The Super Admin can still
--     create a company for an existing account (sa_create_company, 0020).
--   * AUTH-04 / §7.1 "Employees do not self-register; HR invites them": new join requests are refused.
--     Requests already waiting can still be approved or rejected.

-- the work, for a given user: called by create_company() (signed in) and by the sign-up server code
-- right after the account is created (service role only)
create or replace function public.create_company_for(p_user uuid, p_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_full text; v_email text; v_cid uuid; v_first text; v_last text;
begin
  if p_user is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Company name is required'; end if;
  if length(trim(p_name)) > 120 then raise exception 'Company name is too long'; end if;
  select full_name, email into v_full, v_email from public.profiles where id = p_user;
  if v_email is null then raise exception 'No account profile' using errcode = '42501'; end if;

  insert into public.companies (owner_id, name, legal_name) values (p_user, trim(p_name), trim(p_name)) returning id into v_cid;
  -- the owner membership comes from companies_after_insert; the owner also gets an employee record
  v_first := split_part(coalesce(nullif(trim(v_full), ''), split_part(v_email, '@', 1)), ' ', 1);
  v_last := nullif(trim(substr(coalesce(v_full, ''), length(v_first) + 1)), '');
  insert into public.employees (company_id, user_id, first_name, last_name, email, date_of_joining)
  values (v_cid, p_user, v_first, v_last, v_email, current_date);
  update public.profiles set last_company_id = v_cid where id = p_user;

  insert into public.audit_log (company_id, user_id, table_name, record_id, action, new_data)
  values (v_cid, p_user, 'companies', v_cid::text, 'create_company', jsonb_build_object('name', trim(p_name)));
  return v_cid;
end $$;
revoke execute on function public.create_company_for(uuid, text) from public, anon, authenticated;
grant execute on function public.create_company_for(uuid, text) to service_role;

create or replace function public.create_company(p_name text)
returns uuid language sql security definer set search_path = public as $$
  select public.create_company_for(auth.uid(), p_name);
$$;
revoke execute on function public.create_company(text) from public, anon;
grant execute on function public.create_company(text) to authenticated;

create or replace function public.submit_join_request(p_company uuid, p_full_name text, p_phone text, p_designation uuid, p_department uuid, p_note text)
returns uuid language plpgsql security definer set search_path = public as $$
begin
  raise exception 'Employees join by invitation: ask your HR team to add you and send an invitation' using errcode = '42501';
end $$;
