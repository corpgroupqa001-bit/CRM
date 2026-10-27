-- corpgroup.com · 0035 flagging a selfie (decision of 27 Oct 2026; extends ATT-25/27, not in BRD v2.0)
--
--   * HR / Payroll or the employee's reporting manager — the people who can see selfies (ATT-25) — can flag
--     one as "wrong person", "wrong place" or "other", with a note. The employee is notified and explains
--     (and may request a correction, ATT-13). HR or the manager then closes it: explanation accepted, or
--     flag upheld. A flag never changes attendance or pay by itself; HR corrects the day if needed
--     (set_attendance_status, with a reason). Every step is in the audit log.
--   * The employee sees their flags and the note, not the photo (ATT-25).

create table if not exists public.selfie_flags (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  employee_id   uuid not null references public.employees(id) on delete cascade,
  source        text not null check (source in ('wfh_in','wfh_out','field_punch')),
  ref_id        text not null,                      -- work_sessions.id or punches_raw.id
  date          date not null,
  reason        text not null check (reason in ('wrong_person','wrong_place','other')),
  note          text not null check (length(trim(note)) > 0),
  status        text not null default 'open' check (status in ('open','explained','accepted','upheld')),
  explanation   text,
  explained_at  timestamptz,
  flagged_by    uuid not null references auth.users(id),
  flagged_at    timestamptz not null default now(),
  closed_by     uuid references auth.users(id),
  closed_at     timestamptz,
  closing_note  text,
  unique (source, ref_id)
);
create index if not exists selfie_flags_employee on public.selfie_flags (employee_id, flagged_at desc);
alter table public.selfie_flags enable row level security;
drop policy if exists selfie_flags_select on public.selfie_flags;
create policy selfie_flags_select on public.selfie_flags for select using (
  employee_id = public.my_employee_id(company_id)
  or public.has_role(company_id, array['hr'])
  or public.is_manager_of(employee_id));
-- writes only through the functions below

-- HR / Payroll or the reporting manager of this employee (the people who see the selfie)
create or replace function public.can_review_selfie(p_emp uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.employees e where e.id = p_emp
                 and (public.has_role(e.company_id, array['hr']) or public.is_manager_of(e.id)));
$$;

create or replace function public.flag_selfie(p_source text, p_ref text, p_reason text, p_note text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_emp uuid; v_company uuid; v_date date; v_id uuid; v_user uuid;
begin
  if p_source in ('wfh_in','wfh_out') then
    select employee_id, company_id, date into v_emp, v_company, v_date from public.work_sessions
    where id = p_ref::uuid and (case when p_source = 'wfh_in' then selfie_in else selfie_out end) is not null;
  elsif p_source = 'field_punch' then
    select p.employee_id, p.company_id, (p.punched_at at time zone c.timezone)::date into v_emp, v_company, v_date
    from public.punches_raw p join public.companies c on c.id = p.company_id
    where p.id = p_ref::bigint and p.source = 'mobile' and p.selfie_path is not null;
  else
    raise exception 'Unknown selfie';
  end if;
  if v_emp is null then raise exception 'Selfie not found'; end if;
  if not public.can_review_selfie(v_emp) then raise exception 'Only HR or the reporting manager can flag a selfie' using errcode = '42501'; end if;
  if p_reason not in ('wrong_person','wrong_place','other') then raise exception 'Choose a reason'; end if;
  if coalesce(trim(p_note), '') = '' then raise exception 'Add a note saying what is wrong'; end if;
  insert into public.selfie_flags (company_id, employee_id, source, ref_id, date, reason, note, flagged_by)
  values (v_company, v_emp, p_source, p_ref, v_date, p_reason, trim(p_note), auth.uid())
  on conflict (source, ref_id) do nothing returning id into v_id;
  if v_id is null then raise exception 'This selfie is already flagged'; end if;
  select user_id into v_user from public.employees where id = v_emp;
  perform public.notify(v_user, v_company, 'Selfie flagged: please explain',
    to_char(v_date, 'DD Mon YYYY') || ' · ' || replace(p_reason, '_', ' ') || ': ' || trim(p_note), '/attendance/me');
  insert into public.audit_log (company_id, user_id, table_name, record_id, action, new_data, ip)
  values (v_company, auth.uid(), 'selfie_flags', v_id::text, 'flag', jsonb_build_object('employee_id', v_emp, 'date', v_date, 'reason', p_reason, 'note', trim(p_note)), public.request_ip());
  return v_id;
end $$;

create or replace function public.explain_selfie_flag(p_id uuid, p_text text)
returns void language plpgsql security definer set search_path = public as $$
declare f public.selfie_flags%rowtype;
begin
  select * into f from public.selfie_flags where id = p_id;
  if f.id is null or f.employee_id <> public.my_employee_id(f.company_id) then raise exception 'not allowed' using errcode = '42501'; end if;
  if f.status not in ('open','explained') then raise exception 'This flag is already closed'; end if;
  if coalesce(trim(p_text), '') = '' then raise exception 'Write your explanation'; end if;
  update public.selfie_flags set explanation = trim(p_text), explained_at = now(), status = 'explained' where id = p_id;
  perform public.notify(f.flagged_by, f.company_id, 'Selfie flag explained',
    to_char(f.date, 'DD Mon YYYY') || ': ' || left(trim(p_text), 200), '/attendance/me?employee=' || f.employee_id);
  insert into public.audit_log (company_id, user_id, table_name, record_id, action, new_data, ip)
  values (f.company_id, auth.uid(), 'selfie_flags', p_id::text, 'explain', jsonb_build_object('explanation', trim(p_text)), public.request_ip());
end $$;

create or replace function public.close_selfie_flag(p_id uuid, p_upheld boolean, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare f public.selfie_flags%rowtype; v_user uuid;
begin
  select * into f from public.selfie_flags where id = p_id;
  if f.id is null or not public.can_review_selfie(f.employee_id) then raise exception 'not allowed' using errcode = '42501'; end if;
  if f.status in ('accepted','upheld') then raise exception 'This flag is already closed'; end if;
  update public.selfie_flags set status = case when p_upheld then 'upheld' else 'accepted' end,
    closed_by = auth.uid(), closed_at = now(), closing_note = nullif(trim(coalesce(p_note, '')), '') where id = p_id;
  select user_id into v_user from public.employees where id = f.employee_id;
  perform public.notify(v_user, f.company_id, case when p_upheld then 'Selfie flag upheld' else 'Selfie flag closed' end,
    to_char(f.date, 'DD Mon YYYY') || case when p_upheld then ': the flag stands; HR may correct the day.' else ': your explanation was accepted.' end, '/attendance/me');
  insert into public.audit_log (company_id, user_id, table_name, record_id, action, new_data, ip)
  values (f.company_id, auth.uid(), 'selfie_flags', p_id::text, case when p_upheld then 'uphold' else 'accept' end,
          jsonb_build_object('note', nullif(trim(coalesce(p_note, '')), '')), public.request_ip());
end $$;

revoke execute on function public.can_review_selfie(uuid) from public, anon;
grant execute on function public.can_review_selfie(uuid) to authenticated;
grant execute on function public.flag_selfie(text, text, text, text) to authenticated;
grant execute on function public.explain_selfie_flag(uuid, text) to authenticated;
grant execute on function public.close_selfie_flag(uuid, boolean, text) to authenticated;
