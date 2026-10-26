-- corpgroup.com · 0020 companies are created only by the platform Super Admin
--
-- Before: anyone who signed up (or any signed-in user on /onboarding) created a company and became
-- its Owner. Now a new account gets no company and no role. The Super Admin creates each company
-- and names its Owner, an existing account chosen by email (possibly the operator's own); everyone
-- else joins by invitation.

drop policy if exists companies_insert on public.companies;
-- no insert policy: the API can't create companies; sa_create_company() below does it after its checks

create or replace function public.sa_create_company(p_name text, p_owner_email text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_owner uuid; v_full text; v_email text; v_cid uuid; v_first text; v_last text;
begin
  if not public.is_super_admin() then raise exception 'Super admin only' using errcode = '42501'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Company name is required'; end if;
  select id, full_name, email into v_owner, v_full, v_email from public.profiles where email = lower(trim(p_owner_email));
  if v_owner is null then
    raise exception 'No account with email %. They must create an account first.', p_owner_email;
  end if;
  -- the operator may own companies too (the group owner is also the platform admin)

  insert into public.companies (owner_id, name, legal_name) values (v_owner, trim(p_name), trim(p_name)) returning id into v_cid;
  -- the owner membership comes from companies_after_insert; the owner also gets an employee record
  v_first := split_part(coalesce(nullif(trim(v_full), ''), split_part(v_email, '@', 1)), ' ', 1);
  v_last := nullif(trim(substr(coalesce(v_full, ''), length(v_first) + 1)), '');
  insert into public.employees (company_id, user_id, first_name, last_name, email, date_of_joining)
  values (v_cid, v_owner, v_first, v_last, v_email, current_date);
  update public.profiles set last_company_id = coalesce(last_company_id, v_cid) where id = v_owner;

  insert into public.audit_log (company_id, user_id, table_name, record_id, action, new_data, ip)
  values (v_cid, auth.uid(), 'companies', v_cid::text, 'super_admin_create_company',
          jsonb_build_object('name', p_name, 'owner_email', v_email), public.request_ip());
  return v_cid;
end $$;
revoke execute on function public.sa_create_company(text, text) from public, anon;
grant execute on function public.sa_create_company(text, text) to authenticated;
