-- corpgroup.com · 0025 attendance corrections need a reason, and every correction is in the audit log
--
-- HR Managers and Administrators correct a day's attendance with set_attendance_status(). The form asked
-- for a reason, but only the browser enforced it, and a correction that created a day with no previous
-- record wasn't audited (the audit trigger on daily_attendance fires on update / delete only). Now:
--   * the database refuses a correction without a reason (also when returning a day to automatic);
--   * every correction writes one audit_log row: employee, date, old → new status, reason;
--   * the check uses the attendance.manage permission (Owner, Administrator, HR Manager — as before,
--     via the role_permissions matrix of 0018) instead of the older is_hr() role list.

create or replace function public.set_attendance_status(p_emp uuid, p_date date, p_status text, p_remarks text)
returns void language plpgsql security definer set search_path = public as $$
declare e public.employees%rowtype; v_old text; v_reason text := nullif(trim(coalesce(p_remarks, '')), '');
begin
  select * into e from public.employees where id = p_emp;
  if e.id is null or not public.has_perm(e.company_id, 'attendance.manage') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_reason is null then raise exception 'Give a reason for the attendance correction' using errcode = '23514'; end if;
  if public.is_month_locked(e.company_id, p_date) then raise exception 'Attendance for that month is locked'; end if;
  select status into v_old from public.daily_attendance where employee_id = p_emp and date = p_date;

  if p_status = 'auto' then
    delete from public.daily_attendance where employee_id = p_emp and date = p_date;
    perform public.compute_attendance_day(p_emp, p_date);
  else
    insert into public.daily_attendance (company_id, employee_id, date, status, source, remarks)
    values (e.company_id, p_emp, p_date, p_status, 'manual', v_reason)
    on conflict (employee_id, date) do update set status = excluded.status, source = 'manual',
      remarks = excluded.remarks, updated_at = now();
  end if;

  insert into public.audit_log (company_id, user_id, table_name, record_id, action, old_data, new_data, ip)
  values (e.company_id, auth.uid(), 'daily_attendance', p_emp::text || ':' || p_date::text, 'attendance_correction',
          jsonb_build_object('status', v_old),
          jsonb_build_object('employee_id', p_emp, 'date', p_date, 'status', p_status, 'reason', v_reason),
          public.request_ip());
end $$;
