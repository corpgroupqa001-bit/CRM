-- corpgroup.com · 0013 calculate_daily_attendance(company, date) — BRD ATT-09
--
-- One call that settles a whole company's attendance for a day and returns the result:
--   1. maps raw punches to employees: any punch in public.punches_raw (the raw punch store,
--      ATT-04) whose device_user_id is now linked in device_user_map (EMP-06) gets its employee;
--   2. computes each employee's daily status with the shared engine compute_attendance_day():
--      first-in vs the shift start + grace → Late, enough hours → Present, no punch → Absent,
--      plus the other ATT-09 statuses (Half-day, Early-out, On Leave, Holiday, Weekly Off,
--      On Duty, WFH, Missed punch) and overtime; employees without a shift use 09:00–18:00, 0 min grace;
--   3. returns one row per employee employed on that date.
-- Manual HR overrides and locked months are left untouched (as everywhere else).

create or replace function public.calculate_daily_attendance(p_company_id uuid, p_date date)
returns table (
  employee_id     uuid,
  emp_code        text,
  employee_name   text,
  status          text,
  first_in        timestamptz,
  last_out        timestamptz,
  late_minutes    integer,
  worked_minutes  integer
)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_tz text;
begin
  -- app users need HR rights in the company; the service role and scheduled jobs have no auth.uid()
  if auth.uid() is not null and not public.is_hr(p_company_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select c.timezone into v_tz from public.companies c where c.id = p_company_id;
  if v_tz is null then raise exception 'Unknown company %', p_company_id; end if;

  -- 1. device_user_id → employee for unmapped punches around the day (a night shift can start the
  --    evening before or end the next morning). Only employee_id is written: raw punches stay immutable.
  update public.punches_raw pr
     set employee_id = m.employee_id
    from public.device_user_map m
   where pr.company_id = p_company_id
     and pr.employee_id is null
     and m.device_id = pr.device_id
     and m.device_user_id = pr.device_user_id
     and pr.punched_at >= ((p_date - 1)::timestamp at time zone v_tz)
     and pr.punched_at <  ((p_date + 2)::timestamp at time zone v_tz);

  -- 2. status for every employee on that date
  perform public.recompute_attendance(p_company_id, p_date, p_date);

  -- 3. the result
  return query
    select e.id, e.emp_code, trim(e.first_name || ' ' || coalesce(e.last_name, '')),
           coalesce(d.status, 'absent'), d.first_in, d.last_out,
           coalesce(d.late_minutes, 0), coalesce(d.worked_minutes, 0)
      from public.employees e
      left join public.daily_attendance d on d.employee_id = e.id and d.date = p_date
     where e.company_id = p_company_id
       and e.status <> 'inactive'
       and e.date_of_joining <= p_date
       and (e.last_working_day is null or e.last_working_day >= p_date)
     order by e.emp_code;
end $$;

comment on function public.calculate_daily_attendance(uuid, date) is
  'ATT-09: map raw punches to employees, compute and return every employee''s status for one company and date';

revoke execute on function public.calculate_daily_attendance(uuid, date) from public, anon;
grant execute on function public.calculate_daily_attendance(uuid, date) to authenticated, service_role;
