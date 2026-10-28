-- corpgroup.com · 0043 one work-from-home session per day
--
-- Decision of 27 Oct 2026, against BRD ATT-32 ("Several sessions per day are allowed"): once a
-- work-from-home employee checks out, they can't check in again that day; the worked time stays as
-- stored. A check-out made by mistake is fixed with a correction request (ATT-13). Same function as 0030
-- with that one check added.

create or replace function public.wfh_check_in(p_company uuid, p_selfie_path text, p_device text, p_lat double precision, p_lng double precision)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_emp uuid := public.my_employee_id(p_company); e public.employees%rowtype; c public.companies%rowtype;
        v_today date := public.wfh_today(p_company); v_id uuid;
begin
  if v_emp is null or not public.is_member(p_company) then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into e from public.employees where id = v_emp;
  select * into c from public.companies where id = p_company;
  if not e.wfh_eligible then raise exception 'Work from home isn''t enabled for you' using errcode = '42501'; end if;
  if not exists (select 1 from public.wfh_days where employee_id = v_emp and date = v_today and status = 'approved') then
    raise exception 'Today isn''t an approved work-from-home day';
  end if;
  if public.is_month_locked(p_company, v_today) then raise exception 'Attendance for this month is locked'; end if;
  if exists (select 1 from public.work_sessions where employee_id = v_emp and ended_at is null) then raise exception 'You''re already checked in'; end if;
  -- decision of 27 Oct 2026: one session per work-from-home day; after check-out the day is finished
  if exists (select 1 from public.work_sessions where employee_id = v_emp and date = v_today and ended_at is not null) then
    raise exception 'You''ve already checked out today. If that was a mistake, request a correction.';
  end if;
  if p_selfie_path is not null and split_part(p_selfie_path, '/', 2) <> v_emp::text then raise exception 'Invalid photo'; end if;
  insert into public.work_sessions (company_id, employee_id, date, selfie_in, photo_missing_in, lat, lng, device, ip)
  values (p_company, v_emp, v_today, p_selfie_path, p_selfie_path is null,
          case when c.wfh_capture_gps then p_lat end, case when c.wfh_capture_gps then p_lng end,
          left(p_device, 200), public.request_ip())
  returning id into v_id;
  perform public.compute_attendance_day(v_emp, v_today);
  return v_id;
end $$;
