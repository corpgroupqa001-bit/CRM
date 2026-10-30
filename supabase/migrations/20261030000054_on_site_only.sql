-- corpgroup.com · 0054 on-site work only: no work from home, no mobile punch
--
-- Decision of 30 Oct 2026 (against BRD v2.0 ATT-12 field punch and ATT-20 to ATT-35 work from home): every
-- employee works on site and attendance comes only from the biometric device (plus HR corrections and
-- imports). Past work-from-home days, sessions, selfies and mobile punches stay as history, so old attendance
-- and payroll are unchanged; nothing new can be added.

-- 1. nobody is allowed to work from home or punch from a phone any more
update public.employees set wfh_eligible = false where wfh_eligible;
update public.employees set mobile_attendance = false where mobile_attendance;
alter table public.employees add constraint employees_on_site_only check (not wfh_eligible and not mobile_attendance);
update public.companies set wfh_capture_gps = false where wfh_capture_gps;

-- 2. work-from-home days from today on are cancelled (days already worked are kept)
update public.wfh_days set status = 'cancelled'
where status in ('pending','approved') and date >= (now() at time zone 'Asia/Kolkata')::date
  and not exists (select 1 from public.work_sessions s where s.employee_id = wfh_days.employee_id and s.date = wfh_days.date);

-- 3. nothing new: no work-from-home days, sessions or breaks, and no mobile punches
create or replace function public.on_site_only()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_table_name = 'punches_raw' then
    if (to_jsonb(new) ->> 'source') is distinct from 'mobile' then return new; end if;
  end if;
  raise exception 'Attendance is on site only: work from home and mobile punch are switched off. Punch on the device at work.'
    using errcode = '42501';
end $$;
drop trigger if exists on_site_only on public.wfh_days;
create trigger on_site_only before insert on public.wfh_days for each row execute function public.on_site_only();
drop trigger if exists on_site_only on public.work_sessions;
create trigger on_site_only before insert on public.work_sessions for each row execute function public.on_site_only();
drop trigger if exists on_site_only on public.work_breaks;
create trigger on_site_only before insert on public.work_breaks for each row execute function public.on_site_only();
drop trigger if exists on_site_only on public.punches_raw;
create trigger on_site_only before insert on public.punches_raw for each row execute function public.on_site_only();

-- (a correction to 'work from home' is already refused for anyone not eligible, regularisations_wfh_guard
-- from 0033, and nobody can be eligible now)
