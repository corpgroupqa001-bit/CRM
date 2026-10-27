-- corpgroup.com · 0029 missed check-out (ATT-36) and storage retention (ATT-25, NFR-09)
--
--   * ATT-36: an in-punch with no out-punch becomes a missed punch at shift end + a company grace (default
--     2 hours, 0–12), counted as unpaid until regularised (payable map: missed_punch = 0). The employee is
--     notified once, with a link to request a correction (ATT-13).
--   * ATT-25: work selfies are deleted after the company's retention period (default 90 days), and
--     documents of a company purged under NFR-09 are deleted. Files go through the Storage API, so the
--     database only lists what is due (retention_storage_due, service role only); the daily retention job
--     in the app removes them.

alter table public.companies add column if not exists missed_out_grace_hours integer not null default 2
  check (missed_out_grace_hours between 0 and 12);
alter table public.companies add column if not exists selfie_retention_days integer not null default 90
  check (selfie_retention_days between 1 and 3650);

create or replace function public.compute_attendance_day(p_emp uuid, p_date date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
declare
  e            public.employees%rowtype;
  c            public.companies%rowtype;
  s            public.shifts%rowtype;
  v_existing   public.daily_attendance%rowtype;
  v_start_t    time; v_end_t time; v_grace int; v_break int; v_half numeric; v_full numeric;
  v_start      timestamptz; v_end timestamptz;
  v_first      timestamptz; v_last timestamptz; v_count int; v_regularised boolean;
  v_worked     int := 0; v_ot int := 0; v_late_min int := 0;
  v_late       boolean := false; v_early boolean := false; v_conv boolean := false;
  v_in_progress boolean;
  v_status     text;
  v_leave      record; v_reg record;
  v_holiday    boolean; v_wo boolean;
  v_late_before int;
begin
  select * into e from public.employees where id = p_emp;
  if not found then return; end if;
  if public.is_month_locked(e.company_id, p_date) then return; end if;

  -- days before joining or after exit are not attendance days at all (SAL-23)
  if p_date < e.date_of_joining or (e.last_working_day is not null and p_date > e.last_working_day) then
    delete from public.daily_attendance where employee_id = p_emp and date = p_date and source <> 'manual';
    return;
  end if;

  select * into v_existing from public.daily_attendance where employee_id = p_emp and date = p_date;
  if found and v_existing.source = 'manual' then return; end if;

  select * into c from public.companies where id = e.company_id;
  select * into s from public.shifts where id = e.shift_id;
  if not found then
    select * into s from public.shifts where company_id = e.company_id order by is_default desc, created_at limit 1;
  end if;
  v_start_t := coalesce(s.start_time, '09:00'); v_end_t := coalesce(s.end_time, '18:00');
  v_grace := coalesce(s.grace_min, 0); v_break := coalesce(s.break_min, 0);
  v_half := coalesce(s.half_day_hours, 4); v_full := coalesce(s.full_day_hours, 8);

  v_start := (p_date + v_start_t) at time zone c.timezone;
  v_end := (case when v_end_t > v_start_t then p_date else p_date + 1 end + v_end_t) at time zone c.timezone;
  -- ATT-36: a day with an in-punch and no out-punch becomes a missed punch at shift end + the company's
  -- grace (default 2 hours); until then it shows live
  v_in_progress := now() < v_end + make_interval(hours => coalesce(c.missed_out_grace_hours, 2));

  -- first-in / last-out inside the shift window (handles night shifts crossing midnight)
  select min(punched_at), max(punched_at), count(*), bool_or(source = 'regularisation')
    into v_first, v_last, v_count, v_regularised
  from public.punches_raw
  where employee_id = p_emp
    and punched_at >= v_start - interval '4 hours'
    and punched_at <  v_start + interval '20 hours';

  if v_count >= 2 then
    v_worked := greatest(0, floor(extract(epoch from v_last - v_first) / 60)::int - v_break);
  end if;

  select lr.*, lt.paid into v_leave
  from public.leave_requests lr join public.leave_types lt on lt.id = lr.leave_type_id
  where lr.employee_id = p_emp and lr.status = 'approved' and p_date between lr.from_date and lr.to_date
  limit 1;

  select * into v_reg from public.regularisations
  where employee_id = p_emp and date = p_date and status = 'approved' and kind in ('on_duty','wfh')
  limit 1;

  v_holiday := exists (select 1 from public.holidays h where h.company_id = e.company_id and h.date = p_date
                        and (h.branch_id is null or h.branch_id = e.branch_id));
  v_wo := extract(dow from p_date)::int = any(c.weekly_offs);

  if v_count >= 1 then
    v_late_min := greatest(0, floor(extract(epoch from v_first - v_start) / 60)::int);
    v_late := v_first > v_start + make_interval(mins => v_grace);
    v_early := v_count >= 2 and v_last < v_end and not v_in_progress;
  end if;

  if v_leave.id is not null and not v_leave.half_day then
    v_status := 'on_leave';
  elsif v_leave.id is not null then
    v_status := 'on_leave';                                   -- half-day leave; other half may be worked
  elsif v_reg.id is not null then
    v_status := v_reg.kind;
  elsif v_holiday then
    v_status := 'holiday';
  elsif v_wo then
    v_status := 'weekly_off';
  elsif v_count = 0 then
    v_status := 'absent';
  elsif v_in_progress then
    v_status := case when v_late then 'late' else 'present' end;   -- live view while the shift runs
  elsif v_count = 1 then
    v_status := 'missed_punch';
  elsif v_worked >= v_full * 60 then
    v_status := case when v_late then 'late' when v_early then 'early_out' else 'present' end;
  elsif v_worked >= v_half * 60 then
    v_status := 'half_day';
  else
    v_status := 'absent';
  end if;

  -- ATT-11: every Nth late mark in the month turns that day into a half-day
  if v_status = 'late' and c.late_marks_to_half_day > 0 then
    select count(*) into v_late_before from public.daily_attendance
    where employee_id = p_emp and late and date >= date_trunc('month', p_date)::date and date < p_date;
    if (v_late_before + 1) % c.late_marks_to_half_day = 0 then
      v_status := 'half_day';
      v_conv := true;
    end if;
  end if;

  -- overtime: all worked time on a holiday / weekly off, otherwise time beyond the full-day hours
  if v_status in ('holiday','weekly_off') then
    v_ot := v_worked;
  else
    v_ot := greatest(0, v_worked - (v_full * 60)::int);
  end if;

  insert into public.daily_attendance as d (company_id, employee_id, date, status, first_in, last_out, punch_count,
      worked_minutes, ot_minutes, late, late_minutes, early_out, late_conversion, leave_type_id, leave_half,
      half_present, source, updated_at)
  values (e.company_id, p_emp, p_date, v_status, v_first, case when v_count >= 2 then v_last end, v_count,
      v_worked, v_ot, v_late and v_status in ('late','half_day'), case when v_late then v_late_min else 0 end,
      v_early, v_conv, v_leave.leave_type_id, coalesce(v_leave.half_day, false),
      coalesce(v_leave.half_day, false) and v_worked >= v_half * 60,
      case when v_regularised or v_reg.id is not null then 'regularised' else 'auto' end, now())
  on conflict (employee_id, date) do update set
      status = excluded.status, first_in = excluded.first_in, last_out = excluded.last_out,
      punch_count = excluded.punch_count, worked_minutes = excluded.worked_minutes,
      ot_minutes = excluded.ot_minutes, ot_approved_minutes = least(d.ot_approved_minutes, excluded.ot_minutes),
      late = excluded.late, late_minutes = excluded.late_minutes, early_out = excluded.early_out,
      late_conversion = excluded.late_conversion, leave_type_id = excluded.leave_type_id,
      leave_half = excluded.leave_half, half_present = excluded.half_present, source = excluded.source,
      updated_at = now();

  -- ATT-36 / ATT-13: tell the employee once, when the day turns into a missed punch, so they ask for a correction
  if v_status = 'missed_punch' and v_existing.status is distinct from 'missed_punch' and e.user_id is not null then
    perform public.notify(e.user_id, e.company_id, 'Missed check-out',
      to_char(p_date, 'DD Mon YYYY') || ': only one punch was recorded. Request a correction so the day is paid.',
      '/attendance/me');
  end if;
end $$;

-- files due for deletion: selfies past retention, and documents of companies purged under NFR-09
create or replace function public.retention_storage_due(p_limit integer default 500)
returns table(bucket text, name text) language plpgsql stable security definer set search_path = public, storage as $$
begin
  return query
    select o.bucket_id::text, o.name::text from storage.objects o
    join public.companies c on c.id = public.storage_company(o.name)
    where o.bucket_id = 'selfies' and o.created_at < now() - make_interval(days => c.selfie_retention_days)
    union all
    select o.bucket_id::text, o.name::text from storage.objects o
    join public.companies c on c.id = public.storage_company(o.name)
    where o.bucket_id = 'documents' and c.purged_at is not null
    limit greatest(1, least(coalesce(p_limit, 500), 1000));
end $$;
revoke execute on function public.retention_storage_due(integer) from public, anon, authenticated;
grant execute on function public.retention_storage_due(integer) to service_role;
