-- corpgroup.com · 0030 work from home (BRD v2.0 ATT-20 to ATT-35)
--
--   * ATT-20/21: a work-from-home day is requested by an eligible employee and approved by their manager
--     (or HR), or set by HR for an employee, department or branch over a date range (optionally only some
--     weekdays, or every other week). Eligibility is per employee (employees.wfh_eligible).
--   * ATT-23/24/27/33: check-in and check-out with a live-camera selfie, no geofence, GPS only when the
--     company enables it; a failed photo is accepted and flagged. Every time is the server's clock; the
--     phone sends no times.
--   * ATT-28/32: breaks, several sessions a day; worked time = closed sessions + the running one − breaks.
--   * ATT-22/32: the day's status comes from total worked hours against the employee's shift thresholds:
--     full day → wfh (1 payable day), half → half_day, less → absent. Late if the first check-in is after
--     shift start + grace.
--   * ATT-29/30: wfh_status() (own figure) and wfh_live() (team board) compute the live figure on the
--     server; the app refreshes it through Supabase Realtime and at least every 60 seconds.
--   * ATT-31: an open session is closed at the last recorded activity once the shift is over + the
--     company grace (missed_out_grace_hours, default 2), and the day is raised for regularisation.
--   * ATT-35: nothing else is recorded: no screenshots, keystrokes or activity.
-- All writes go through the functions below; the tables are read-only to the API (RLS).

alter table public.employees add column if not exists wfh_eligible boolean not null default false;
alter table public.companies add column if not exists wfh_capture_gps boolean not null default false;

create table if not exists public.wfh_days (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  employee_id  uuid not null references public.employees(id) on delete cascade,
  date         date not null,
  status       text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  source       text not null default 'request' check (source in ('request','hr')),
  reason       text,
  requested_by uuid references auth.users(id),
  decided_by   uuid references auth.users(id),
  decided_at   timestamptz,
  decision_note text,
  created_at   timestamptz not null default now(),
  unique (employee_id, date)
);
create index if not exists wfh_days_company_date on public.wfh_days (company_id, date);

create table if not exists public.work_sessions (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies(id) on delete cascade,
  employee_id        uuid not null references public.employees(id) on delete cascade,
  date               date not null,
  started_at         timestamptz not null default now(),
  ended_at           timestamptz,
  end_reason         text check (end_reason in ('checkout','auto')),
  selfie_in          text,
  selfie_out         text,
  photo_missing_in   boolean not null default false,
  photo_missing_out  boolean not null default false,
  lat                double precision,
  lng                double precision,
  device             text,
  ip                 text,
  check (ended_at is null or ended_at >= started_at)
);
create index if not exists work_sessions_emp_date on public.work_sessions (employee_id, date);
create unique index if not exists work_sessions_one_open on public.work_sessions (employee_id) where ended_at is null;

create table if not exists public.work_breaks (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  session_id  uuid not null references public.work_sessions(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,
  check (ended_at is null or ended_at >= started_at)
);
create unique index if not exists work_breaks_one_open on public.work_breaks (session_id) where ended_at is null;

alter table public.wfh_days enable row level security;
alter table public.work_sessions enable row level security;
alter table public.work_breaks enable row level security;
drop policy if exists wfh_days_select on public.wfh_days;
create policy wfh_days_select on public.wfh_days for select using (public.can_view_employee(employee_id));
drop policy if exists work_sessions_select on public.work_sessions;
create policy work_sessions_select on public.work_sessions for select using (public.can_view_employee(employee_id));
drop policy if exists work_breaks_select on public.work_breaks;
create policy work_breaks_select on public.work_breaks for select using (public.can_view_employee(employee_id));

-- live figures through Supabase Realtime (ATT-29/30); not available in every environment
do $$
begin
  alter publication supabase_realtime add table public.work_sessions, public.work_breaks;
exception when others then
  raise notice 'realtime publication not changed: %', sqlerrm;
end $$;

-- ===========================================================================
-- helpers
-- ===========================================================================
-- the employee's shift window on a date, in the company's time zone (night shifts end the next day)
create or replace function public.shift_window(p_emp uuid, p_date date, out starts_at timestamptz, out ends_at timestamptz,
  out grace_min integer, out half_hours numeric, out full_hours numeric)
language plpgsql stable security definer set search_path = public as $$
declare e public.employees%rowtype; c public.companies%rowtype; s public.shifts%rowtype; v_s time; v_e time;
begin
  select * into e from public.employees where id = p_emp;
  select * into c from public.companies where id = e.company_id;
  select * into s from public.shifts where id = e.shift_id;
  if not found then
    select * into s from public.shifts where company_id = e.company_id order by is_default desc, created_at limit 1;
  end if;
  v_s := coalesce(s.start_time, '09:00'); v_e := coalesce(s.end_time, '18:00');
  starts_at := (p_date + v_s) at time zone c.timezone;
  ends_at := (case when v_e > v_s then p_date else p_date + 1 end + v_e) at time zone c.timezone;
  grace_min := coalesce(s.grace_min, 0);
  half_hours := coalesce(s.half_day_hours, 4);
  full_hours := coalesce(s.full_day_hours, 8);
end $$;

-- worked and break seconds on a date: closed sessions + the running one, breaks excluded (server clock)
create or replace function public.wfh_seconds(p_emp uuid, p_date date, out worked integer, out on_break integer)
language sql stable security definer set search_path = public as $$
  with s as (
    select id, started_at, coalesce(ended_at, now()) as ends from public.work_sessions where employee_id = p_emp and date = p_date
  ), b as (
    select sum(extract(epoch from least(coalesce(wb.ended_at, now()), s.ends) - wb.started_at)) as secs
    from public.work_breaks wb join s on s.id = wb.session_id
  )
  select greatest(0, coalesce((select sum(extract(epoch from ends - started_at)) from s), 0) - coalesce((select secs from b), 0))::int,
         coalesce((select secs from b), 0)::int;
$$;

create or replace function public.wfh_today(p_company uuid)
returns date language sql stable security definer set search_path = public as $$
  select (now() at time zone (select timezone from public.companies where id = p_company))::date;
$$;

-- ===========================================================================
-- ATT-20/21: requesting, approving and assigning work-from-home days
-- ===========================================================================
create or replace function public.request_wfh(p_company uuid, p_date date, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_emp uuid := public.my_employee_id(p_company); e public.employees%rowtype; v_id uuid; v_mgr uuid;
begin
  if v_emp is null or not public.is_member(p_company) then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into e from public.employees where id = v_emp;
  if not e.wfh_eligible then raise exception 'Work from home isn''t enabled for you. Ask HR.' using errcode = '42501'; end if;
  if p_date is null or p_date < public.wfh_today(p_company) then raise exception 'Choose today or a future date'; end if;
  if public.is_month_locked(p_company, p_date) then raise exception 'Attendance for that month is locked'; end if;
  insert into public.wfh_days (company_id, employee_id, date, status, source, reason, requested_by)
  values (p_company, v_emp, p_date, 'pending', 'request', nullif(trim(coalesce(p_reason, '')), ''), auth.uid())
  on conflict (employee_id, date) do update set status = 'pending', source = 'request', reason = excluded.reason,
    requested_by = excluded.requested_by, decided_by = null, decided_at = null, decision_note = null
    where public.wfh_days.status in ('rejected','cancelled')
  returning id into v_id;
  if v_id is null then raise exception 'You already have a work-from-home day on %', to_char(p_date, 'DD Mon'); end if;
  select user_id into v_mgr from public.employees where id = e.reporting_manager_id;
  perform public.notify(v_mgr, p_company, 'Work from home request',
    trim(e.first_name || ' ' || coalesce(e.last_name, '')) || ' asked to work from home on ' || to_char(p_date, 'DD Mon YYYY'), '/attendance/requests');
  return v_id;
end $$;

create or replace function public.decide_wfh(p_id uuid, p_approve boolean, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare d public.wfh_days%rowtype; v_user uuid;
begin
  select * into d from public.wfh_days where id = p_id;
  if d.id is null or not (public.has_perm(d.company_id, 'attendance.manage')
       or (public.has_perm(d.company_id, 'attendance.approve') and public.is_manager_of(d.employee_id))) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if d.status <> 'pending' then raise exception 'This request was already %', d.status; end if;
  if public.is_month_locked(d.company_id, d.date) then raise exception 'Attendance for that month is locked'; end if;
  update public.wfh_days set status = case when p_approve then 'approved' else 'rejected' end,
    decided_by = auth.uid(), decided_at = now(), decision_note = nullif(trim(coalesce(p_note, '')), '') where id = p_id;
  select user_id into v_user from public.employees where id = d.employee_id;
  perform public.notify(v_user, d.company_id, 'Work from home ' || case when p_approve then 'approved' else 'not approved' end,
    to_char(d.date, 'DD Mon YYYY') || coalesce(': ' || nullif(trim(coalesce(p_note, '')), ''), ''), '/attendance/me');
  perform public.compute_attendance_day(d.employee_id, d.date);
end $$;

create or replace function public.cancel_wfh(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare d public.wfh_days%rowtype;
begin
  select * into d from public.wfh_days where id = p_id;
  if d.id is null or not (d.employee_id = public.my_employee_id(d.company_id) or public.has_perm(d.company_id, 'attendance.manage')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if d.status not in ('pending','approved') then raise exception 'Nothing to cancel'; end if;
  if exists (select 1 from public.work_sessions where employee_id = d.employee_id and date = d.date) then
    raise exception 'You''ve already checked in that day';
  end if;
  update public.wfh_days set status = 'cancelled', decided_by = auth.uid(), decided_at = now() where id = p_id;
  perform public.compute_attendance_day(d.employee_id, d.date);
end $$;

-- HR sets work from home for one employee, a department or a branch over a date range
create or replace function public.assign_wfh(p_company uuid, p_from date, p_to date, p_employee uuid, p_department uuid,
  p_branch uuid, p_weekdays integer[], p_alternate_weeks boolean)
returns integer language plpgsql security definer set search_path = public as $$
declare v_n integer := 0; d date; e record;
begin
  if not public.has_perm(p_company, 'attendance.manage') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Choose a valid date range'; end if;
  if p_to - p_from > 366 then raise exception 'Choose at most a year at a time'; end if;
  if num_nonnulls(p_employee, p_department, p_branch) <> 1 then raise exception 'Choose one employee, department or branch'; end if;
  for e in select id from public.employees
           where company_id = p_company and status in ('active','notice') and removed_at is null and wfh_eligible
             and (p_employee is null or id = p_employee)
             and (p_department is null or department_id = p_department)
             and (p_branch is null or branch_id = p_branch) loop
    d := p_from;
    while d <= p_to loop
      if (p_weekdays is null or cardinality(p_weekdays) = 0 or extract(dow from d)::int = any(p_weekdays))
         and (not coalesce(p_alternate_weeks, false) or ((d - p_from) / 7) % 2 = 0)
         and not public.is_month_locked(p_company, d) then
        insert into public.wfh_days (company_id, employee_id, date, status, source, requested_by, decided_by, decided_at)
        values (p_company, e.id, d, 'approved', 'hr', auth.uid(), auth.uid(), now())
        on conflict (employee_id, date) do update set status = 'approved', source = 'hr', decided_by = auth.uid(), decided_at = now()
          where public.wfh_days.status <> 'approved';
        if found then v_n := v_n + 1; end if;
      end if;
      d := d + 1;
    end loop;
  end loop;
  insert into public.audit_log (company_id, user_id, table_name, record_id, action, new_data, ip)
  values (p_company, auth.uid(), 'wfh_days', coalesce(p_employee, p_department, p_branch)::text, 'assign',
          jsonb_build_object('from', p_from, 'to', p_to, 'weekdays', p_weekdays, 'alternate_weeks', p_alternate_weeks, 'days', v_n), public.request_ip());
  return v_n;
end $$;

-- ===========================================================================
-- ATT-23/24/27/28/32/33: check-in, breaks, check-out (server time only)
-- ===========================================================================
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
  if p_selfie_path is not null and split_part(p_selfie_path, '/', 2) <> v_emp::text then raise exception 'Invalid photo'; end if;
  insert into public.work_sessions (company_id, employee_id, date, selfie_in, photo_missing_in, lat, lng, device, ip)
  values (p_company, v_emp, v_today, p_selfie_path, p_selfie_path is null,
          case when c.wfh_capture_gps then p_lat end, case when c.wfh_capture_gps then p_lng end,
          left(p_device, 200), public.request_ip())
  returning id into v_id;
  perform public.compute_attendance_day(v_emp, v_today);
  return v_id;
end $$;

create or replace function public.wfh_break(p_company uuid, p_start boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v_emp uuid := public.my_employee_id(p_company); s public.work_sessions%rowtype;
begin
  if v_emp is null or not public.is_member(p_company) then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into s from public.work_sessions where employee_id = v_emp and ended_at is null;
  if s.id is null then raise exception 'Check in first'; end if;
  if p_start then
    if exists (select 1 from public.work_breaks where session_id = s.id and ended_at is null) then raise exception 'You''re already on a break'; end if;
    insert into public.work_breaks (company_id, session_id, employee_id) values (p_company, s.id, v_emp);
  else
    update public.work_breaks set ended_at = now() where session_id = s.id and ended_at is null;
    if not found then raise exception 'You''re not on a break'; end if;
  end if;
end $$;

create or replace function public.wfh_check_out(p_company uuid, p_selfie_path text)
returns void language plpgsql security definer set search_path = public as $$
declare v_emp uuid := public.my_employee_id(p_company); s public.work_sessions%rowtype;
begin
  if v_emp is null or not public.is_member(p_company) then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into s from public.work_sessions where employee_id = v_emp and ended_at is null;
  if s.id is null then raise exception 'You''re not checked in'; end if;
  if p_selfie_path is not null and split_part(p_selfie_path, '/', 2) <> v_emp::text then raise exception 'Invalid photo'; end if;
  update public.work_breaks set ended_at = now() where session_id = s.id and ended_at is null;
  update public.work_sessions set ended_at = now(), end_reason = 'checkout', selfie_out = p_selfie_path,
    photo_missing_out = p_selfie_path is null where id = s.id;
  perform public.compute_attendance_day(v_emp, s.date);
end $$;

-- ===========================================================================
-- ATT-29/30: live figures
-- ===========================================================================
create or replace function public.wfh_status(p_company uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_emp uuid := public.my_employee_id(p_company); e public.employees%rowtype; v_today date := public.wfh_today(p_company);
        w record; sw record; v_state text := 'out'; v_day public.wfh_days%rowtype;
begin
  if v_emp is null or not public.is_member(p_company) then return jsonb_build_object('eligible', false); end if;
  select * into e from public.employees where id = v_emp;
  select * into v_day from public.wfh_days where employee_id = v_emp and date = v_today;
  select * into w from public.wfh_seconds(v_emp, v_today);
  select * into sw from public.shift_window(v_emp, v_today);
  if exists (select 1 from public.work_sessions where employee_id = v_emp and ended_at is null) then
    v_state := case when exists (select 1 from public.work_breaks b join public.work_sessions s on s.id = b.session_id
                                 where s.employee_id = v_emp and s.ended_at is null and b.ended_at is null) then 'break' else 'in' end;
  end if;
  return jsonb_build_object(
    'eligible', e.wfh_eligible, 'today', v_today, 'day_status', v_day.status, 'state', v_state,
    'worked_seconds', w.worked, 'break_seconds', w.on_break, 'target_seconds', (sw.full_hours * 3600)::int,
    'sessions', (select count(*) from public.work_sessions where employee_id = v_emp and date = v_today),
    'server_time', now(), 'capture_gps', (select wfh_capture_gps from public.companies where id = p_company));
end $$;

create or replace function public.wfh_live(p_company uuid)
returns table(employee_id uuid, full_name text, department text, state text, worked_seconds integer, break_seconds integer, checked_in_at timestamptz, photo_missing boolean)
language plpgsql stable security definer set search_path = public as $$
declare v_today date := public.wfh_today(p_company);
begin
  if not (public.has_perm(p_company, 'attendance.read_all') or public.has_perm(p_company, 'attendance.read_team')) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return query
    select e.id, trim(e.first_name || ' ' || coalesce(e.last_name, '')), dp.name,
      case when s_open.id is null then (case when exists (select 1 from public.work_sessions x where x.employee_id = e.id and x.date = v_today) then 'out' else 'not_started' end)
           when exists (select 1 from public.work_breaks b where b.session_id = s_open.id and b.ended_at is null) then 'break' else 'in' end,
      w.worked, w.on_break,
      (select min(x.started_at) from public.work_sessions x where x.employee_id = e.id and x.date = v_today),
      exists (select 1 from public.work_sessions x where x.employee_id = e.id and x.date = v_today and (x.photo_missing_in or x.photo_missing_out))
    from public.wfh_days d
    join public.employees e on e.id = d.employee_id
    left join public.departments dp on dp.id = e.department_id
    left join public.work_sessions s_open on s_open.employee_id = e.id and s_open.ended_at is null
    cross join lateral public.wfh_seconds(e.id, v_today) w
    where d.company_id = p_company and d.date = v_today and d.status = 'approved'
      and (public.has_perm(p_company, 'attendance.read_all') or public.is_manager_of(e.id))
    order by 2;
end $$;

-- ===========================================================================
-- ATT-31: close forgotten sessions at the last recorded activity and raise the day for regularisation
-- ===========================================================================
create or replace function public.wfh_auto_close()
returns integer language plpgsql security definer set search_path = public as $$
declare s record; sw record; v_last timestamptz; v_n integer := 0; v_user uuid; v_mgr uuid; c public.companies%rowtype;
begin
  for s in select * from public.work_sessions where ended_at is null loop
    select * into c from public.companies where id = s.company_id;
    select * into sw from public.shift_window(s.employee_id, s.date);
    if now() < sw.ends_at + make_interval(hours => coalesce(c.missed_out_grace_hours, 2)) then continue; end if;
    -- last recorded activity: check-in or the latest break boundary
    select greatest(s.started_at, max(b.started_at), max(b.ended_at)) into v_last from public.work_breaks b where b.session_id = s.id;
    v_last := coalesce(v_last, s.started_at);
    update public.work_breaks set ended_at = started_at where session_id = s.id and ended_at is null;   -- a break isn't work
    update public.work_sessions set ended_at = v_last, end_reason = 'auto' where id = s.id;
    perform public.compute_attendance_day(s.employee_id, s.date);
    select e.user_id, m.user_id into v_user, v_mgr from public.employees e left join public.employees m on m.id = e.reporting_manager_id where e.id = s.employee_id;
    perform public.notify(v_user, s.company_id, 'Work from home closed automatically',
      to_char(s.date, 'DD Mon YYYY') || ': no check-out was recorded, so the day closed at your last activity. Request a correction if needed.', '/attendance/me');
    perform public.notify(v_mgr, s.company_id, 'Work from home closed automatically',
      to_char(s.date, 'DD Mon YYYY') || ': a team member didn''t check out; the day was closed at their last activity.', '/attendance/live');
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

create or replace function public.attendance_tick()
returns void language plpgsql security definer set search_path = public as $$
declare c record; v_today date;
begin
  perform public.wfh_auto_close();
  for c in select id, timezone from public.companies where status = 'active' loop
    v_today := (now() at time zone c.timezone)::date;
    perform public.recompute_attendance(c.id, v_today - 1, v_today);
  end loop;
  perform public.check_devices();
end $$;

revoke execute on function public.wfh_auto_close() from public, anon, authenticated;
revoke execute on function public.shift_window(uuid, date) from public, anon, authenticated;
revoke execute on function public.wfh_seconds(uuid, date) from public, anon, authenticated;
grant execute on function public.request_wfh(uuid, date, text) to authenticated;
grant execute on function public.decide_wfh(uuid, boolean, text) to authenticated;
grant execute on function public.cancel_wfh(uuid) to authenticated;
grant execute on function public.assign_wfh(uuid, date, date, uuid, uuid, uuid, integer[], boolean) to authenticated;
grant execute on function public.wfh_check_in(uuid, text, text, double precision, double precision) to authenticated;
grant execute on function public.wfh_break(uuid, boolean) to authenticated;
grant execute on function public.wfh_check_out(uuid, text) to authenticated;
grant execute on function public.wfh_status(uuid) to authenticated;
grant execute on function public.wfh_live(uuid) to authenticated;

-- the daily status engine with work-from-home days (0029 version + ATT-22/32)
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
  v_wfh        boolean := false; v_wfh_secs record;
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

  -- ATT-22/32: an approved work-from-home day is measured by its sessions (check-in to check-out, breaks
  -- excluded), not by device punches; the status follows total worked hours against the shift thresholds
  v_wfh := exists (select 1 from public.wfh_days where employee_id = p_emp and date = p_date and status = 'approved');
  if v_wfh then
    select min(started_at), max(ended_at), count(*) into v_first, v_last, v_count
    from public.work_sessions where employee_id = p_emp and date = p_date;
    select * into v_wfh_secs from public.wfh_seconds(p_emp, p_date);
    v_worked := coalesce(v_wfh_secs.worked, 0) / 60;
    v_late := v_count >= 1 and v_first > v_start + make_interval(mins => v_grace);
    v_late_min := case when v_count >= 1 then greatest(0, floor(extract(epoch from v_first - v_start) / 60)::int) else 0 end;
    v_early := false;
    v_in_progress := v_in_progress or exists (select 1 from public.work_sessions where employee_id = p_emp and date = p_date and ended_at is null);
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
  elsif v_wfh then
    v_status := case when v_count = 0 then 'absent'
                     when v_in_progress then 'wfh'                        -- live while the day runs
                     when v_worked >= v_full * 60 then 'wfh'
                     when v_worked >= v_half * 60 then 'half_day'
                     else 'absent' end;
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
  values (e.company_id, p_emp, p_date, v_status, v_first, case when v_wfh or v_count >= 2 then v_last end, v_count,
      v_worked, v_ot, v_late and v_status in ('late','half_day','wfh'), case when v_late then v_late_min else 0 end,
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
  if v_status = 'missed_punch' and not v_wfh and v_existing.status is distinct from 'missed_punch' and e.user_id is not null then
    perform public.notify(e.user_id, e.company_id, 'Missed check-out',
      to_char(p_date, 'DD Mon YYYY') || ': only one punch was recorded. Request a correction so the day is paid.',
      '/attendance/me');
  end if;
end $$;
