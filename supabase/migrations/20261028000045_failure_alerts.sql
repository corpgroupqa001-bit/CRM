-- corpgroup.com · 0045 failure alerts (BRD NFR-12)
--
-- "Alerts on failed ingestion, offline devices and failed payroll jobs." Offline devices were already
-- alerted (check_devices). Now:
--   * failed ingestion: punches a registered device sent that couldn't be stored (an error, or the
--     device's key / signature / IP rejected) are recorded, and HR and the Company Admin are notified;
--   * failed payroll: a payroll run that fails for a reason other than a normal refusal (attendance not
--     locked, payroll already locked, no permission) is recorded, and HR, the Company Admin and the Owner
--     are notified;
--   * background jobs: a company whose minute-by-minute attendance job fails is recorded and notified,
--     and the other companies' jobs carry on.
-- At most one alert per company, kind and source per hour, so a broken device can't flood anyone.

create table if not exists public.system_failures (
  id          bigint generated always as identity primary key,
  company_id  uuid references public.companies(id) on delete cascade,
  kind        text not null check (kind in ('ingestion','payroll','job')),
  source      text not null,          -- device name or serial, payroll month, job name
  detail      text,
  at          timestamptz not null default now()
);
create index if not exists system_failures_company_at on public.system_failures (company_id, at desc);
alter table public.system_failures enable row level security;
drop policy if exists system_failures_select on public.system_failures;
create policy system_failures_select on public.system_failures for select using (
  case when kind = 'payroll' then public.has_perm(company_id, 'salaries.read') else public.has_perm(company_id, 'attendance.manage') end);

-- record a failure and alert, at most once an hour per company, kind and source
create or replace function public.record_failure(p_company uuid, p_kind text, p_source text, p_detail text)
returns void language plpgsql security definer set search_path = public as $$
declare v_recent boolean;
begin
  select exists (select 1 from public.system_failures where company_id is not distinct from p_company and kind = p_kind
                   and source = p_source and at > now() - interval '1 hour') into v_recent;
  insert into public.system_failures (company_id, kind, source, detail) values (p_company, p_kind, left(p_source, 200), left(p_detail, 500));
  if v_recent or p_company is null then return; end if;
  if p_kind = 'ingestion' then
    perform public.notify_roles(p_company, array['company_admin','hr'], 'Punches not saved',
      p_source || ': punches from this device couldn''t be saved (' || left(coalesce(p_detail, 'unknown error'), 160)
        || '). Check the device''s key, IP and connection. Attendance → Devices & exceptions.', '/attendance/devices');
  elsif p_kind = 'payroll' then
    perform public.notify_roles(p_company, array['owner','company_admin','hr'], 'Payroll run failed',
      'Payroll for ' || p_source || ' failed: ' || left(coalesce(p_detail, 'unknown error'), 200)
        || '. Nothing was saved; fix the cause and run it again.', '/payroll');
  else
    perform public.notify_roles(p_company, array['company_admin','hr'], 'Background job failed',
      p_source || ' failed: ' || left(coalesce(p_detail, 'unknown error'), 200) || '. Attendance may not be up to date.', '/attendance/devices');
  end if;
end $$;

-- the punch webhooks know the device's serial number, not its company
create or replace function public.record_ingest_failure(p_serial text, p_detail text)
returns void language plpgsql security definer set search_path = public as $$
declare d public.devices%rowtype;
begin
  select * into d from public.devices where serial_no = p_serial;
  if d.id is null then return; end if;            -- unknown devices aren't ours to alert about
  perform public.record_failure(d.company_id, 'ingestion', coalesce(nullif(d.name, ''), d.serial_no), p_detail);
end $$;

revoke execute on function public.record_failure(uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.record_ingest_failure(text, text) from public, anon, authenticated;
grant execute on function public.record_failure(uuid, text, text, text) to service_role;
grant execute on function public.record_ingest_failure(text, text) to service_role;

-- the minute job: one company's failure no longer stops the others, and it is recorded and alerted
create or replace function public.attendance_tick()
returns void language plpgsql security definer set search_path = public as $$
declare c record; v_today date;
begin
  begin
    perform public.wfh_auto_close();
  exception when others then
    perform public.record_failure(null, 'job', 'Work-from-home auto check-out', sqlerrm);
  end;
  for c in select id, timezone from public.companies where status = 'active' loop
    begin
      v_today := (now() at time zone c.timezone)::date;
      perform public.recompute_attendance(c.id, v_today - 1, v_today);
    exception when others then
      perform public.record_failure(c.id, 'job', 'Attendance calculation', sqlerrm);
    end;
  end loop;
  begin
    perform public.check_devices();
  exception when others then
    perform public.record_failure(null, 'job', 'Device check', sqlerrm);
  end;
end $$;
