-- corpgroup.com · 0026 tell the employee when their attendance is corrected
--
-- Same set_attendance_status() as 0025 (reason required, one audit_log row per correction), plus an
-- in-app notification (and push, via the notifications webhook) to the employee whose day was changed:
-- the date, the new status, the old one and the reason. It opens the employee's own attendance page.
-- No notification when the employee has no login, or corrects their own day (an Owner, Administrator or
-- HR Manager fixing their own record). The employee can turn it off under "attendance" in their
-- notification settings, like the other attendance notifications.

create or replace function public.set_attendance_status(p_emp uuid, p_date date, p_status text, p_remarks text)
returns void language plpgsql security definer set search_path = public as $$
declare e public.employees%rowtype; v_old text; v_reason text := nullif(trim(coalesce(p_remarks, '')), '');
  v_new_label text; v_old_label text;
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

  if e.user_id is not null and e.user_id is distinct from auth.uid() then
    v_new_label := case when p_status = 'auto' then 'set back to automatic'
                        else 'marked ' || initcap(replace(p_status, '_', ' ')) end;
    v_old_label := case when v_old is null then '' else ' (was ' || initcap(replace(v_old, '_', ' ')) || ')' end;
    perform public.notify(e.user_id, e.company_id, 'Attendance corrected',
      to_char(p_date, 'DD Mon YYYY') || ': ' || v_new_label || v_old_label || '. Reason: ' || v_reason,
      '/attendance/me');
  end if;
end $$;
