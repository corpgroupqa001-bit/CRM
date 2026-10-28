-- corpgroup.com · 0044 a reason for checking out early (work from home)
--
-- Decision of 27 Oct 2026 (an addition to BRD §7.4.4): a work-from-home employee who checks out before
-- reaching the day's target hours (the shift's full-day hours) is shown the time left and must give a
-- reason. The server checks it too. The reason is kept with the session, shown to the reporting manager and
-- HR on the live work-from-home board, and the reporting manager is notified.

alter table public.work_sessions add column if not exists early_reason text check (early_reason is null or length(early_reason) <= 300);

drop function if exists public.wfh_check_out(uuid, text);
create or replace function public.wfh_check_out(p_company uuid, p_selfie_path text, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_emp uuid := public.my_employee_id(p_company); s public.work_sessions%rowtype; e public.employees%rowtype;
        w record; sw record; v_left integer; v_reason text := nullif(trim(coalesce(p_reason, '')), ''); v_mgr uuid;
begin
  if v_emp is null or not public.is_member(p_company) then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into s from public.work_sessions where employee_id = v_emp and ended_at is null;
  if s.id is null then raise exception 'You''re not checked in'; end if;
  if p_selfie_path is not null and split_part(p_selfie_path, '/', 2) <> v_emp::text then raise exception 'Invalid photo'; end if;
  -- before the target: a reason is required
  select * into w from public.wfh_seconds(v_emp, s.date);
  select * into sw from public.shift_window(v_emp, s.date);
  v_left := greatest(0, (sw.full_hours * 3600)::int - w.worked);
  if v_left > 0 and (v_reason is null or length(v_reason) < 3) then
    raise exception 'You''re checking out before your target hours: give a reason for leaving early';
  end if;
  update public.work_breaks set ended_at = now() where session_id = s.id and ended_at is null;
  update public.work_sessions set ended_at = now(), end_reason = 'checkout', selfie_out = p_selfie_path,
    photo_missing_out = p_selfie_path is null, early_reason = case when v_left > 0 then left(v_reason, 300) end where id = s.id;
  perform public.compute_attendance_day(v_emp, s.date);
  if v_left > 0 then
    select * into e from public.employees where id = v_emp;
    select m.user_id into v_mgr from public.employees m where m.id = e.reporting_manager_id;
    perform public.notify(v_mgr, p_company, 'Early check-out',
      trim(e.first_name || ' ' || coalesce(e.last_name, '')) || ' checked out '
        || case when v_left >= 3600 then (v_left / 3600) || ' h ' else '' end || ((v_left % 3600) / 60) || ' min early: ' || left(v_reason, 300),
      '/attendance/live');
  end if;
end $$;
revoke execute on function public.wfh_check_out(uuid, text, text) from public, anon;
grant execute on function public.wfh_check_out(uuid, text, text) to authenticated;

-- the live board shows the reason to the manager and HR
drop function if exists public.wfh_live(uuid);
create or replace function public.wfh_live(p_company uuid)
returns table(employee_id uuid, full_name text, department text, state text, worked_seconds integer, break_seconds integer, checked_in_at timestamptz, photo_missing boolean, early_reason text)
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
      exists (select 1 from public.work_sessions x where x.employee_id = e.id and x.date = v_today and (x.photo_missing_in or x.photo_missing_out)),
      (select x.early_reason from public.work_sessions x where x.employee_id = e.id and x.date = v_today and x.early_reason is not null
       order by x.ended_at desc limit 1)
    from public.wfh_days d
    join public.employees e on e.id = d.employee_id
    left join public.departments dp on dp.id = e.department_id
    left join public.work_sessions s_open on s_open.employee_id = e.id and s_open.ended_at is null
    cross join lateral public.wfh_seconds(e.id, v_today) w
    where d.company_id = p_company and d.date = v_today and d.status = 'approved'
      and (public.has_perm(p_company, 'attendance.read_all') or public.is_manager_of(e.id))
    order by 2;
end $$;
revoke execute on function public.wfh_live(uuid) from public, anon;
grant execute on function public.wfh_live(uuid) to authenticated;
