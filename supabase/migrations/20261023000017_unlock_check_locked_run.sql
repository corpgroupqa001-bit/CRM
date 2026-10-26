-- corpgroup.com · 0017 unlock_attendance_month: check the payroll status that actually exists.
-- 0005 refused to unlock when a run was in ('approved','locked'), but payroll_runs.status only allows
-- draft / locked / superseded / reopened — approval sets 'locked'. Behaviour is unchanged; the check
-- now names only the real status so it reads correctly.

create or replace function public.unlock_attendance_month(p_company uuid, p_month date, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare v_month date := date_trunc('month', p_month)::date;
begin
  if not public.has_role(p_company, array['owner','company_admin']) then
    raise exception 'Only an admin can unlock attendance' using errcode = '42501';
  end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required'; end if;
  if exists (select 1 from public.payroll_runs where company_id = p_company and month = v_month and status = 'locked') then
    raise exception 'Payroll for this month is approved — reopen payroll instead';
  end if;
  delete from public.attendance_locks where company_id = p_company and month = v_month;
  insert into public.audit_log (company_id, user_id, table_name, record_id, action, new_data, ip)
  values (p_company, auth.uid(), 'attendance_locks', v_month::text, 'unlock', jsonb_build_object('reason', p_reason), public.request_ip());
end $$;
