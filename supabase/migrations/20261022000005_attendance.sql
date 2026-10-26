-- corpgroup.com · 0005 attendance (ATT-01 … ATT-19) and leave

-- ---------------------------------------------------------------------------
-- Devices (ATT-01/03/07)
-- ---------------------------------------------------------------------------
create table public.devices (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  branch_id     uuid references public.branches(id) on delete set null,
  name          text not null,
  serial_no     text not null unique,
  vendor        text,                          -- eSSL, ZKTeco, Matrix, Realtime …
  model         text,
  ip            text,
  mode          text not null default 'push' check (mode in ('push','pull')),
  ip_allowlist  text[] not null default '{}',
  status        text not null default 'offline' check (status in ('online','offline')),
  last_seen_at  timestamptz,
  created_at    timestamptz not null default now()
);

-- secrets live in their own table with no RLS policies: only the service role reads them
create table public.device_secrets (
  device_id     uuid primary key references public.devices(id) on delete cascade,
  hmac_secret   text not null,
  api_key_hash  text not null
);

-- EMP-06: one employee ↔ one device user ID per device
create table public.device_user_map (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete cascade,
  device_id       uuid not null references public.devices(id) on delete cascade,
  device_user_id  text not null,
  employee_id     uuid not null references public.employees(id) on delete cascade,
  unique (device_id, device_user_id),
  unique (device_id, employee_id)
);

-- ---------------------------------------------------------------------------
-- Raw punches (ATT-04/05): immutable, idempotent
-- ---------------------------------------------------------------------------
create table public.punches_raw (
  id              bigint generated always as identity primary key,
  company_id      uuid not null references public.companies(id) on delete cascade,
  device_id       uuid references public.devices(id) on delete set null,
  device_user_id  text,
  employee_id     uuid references public.employees(id) on delete cascade,
  punched_at      timestamptz not null,
  verify_type     text,                         -- fingerprint / face / card / selfie / manual
  direction       text check (direction in ('in','out')),
  source          text not null default 'device' check (source in ('device','mobile','import','regularisation')),
  lat             double precision,
  lng             double precision,
  selfie_path     text,
  received_at     timestamptz not null default now()
);
create unique index punches_device_uniq on public.punches_raw (device_id, device_user_id, punched_at) where device_id is not null;
create unique index punches_emp_uniq on public.punches_raw (employee_id, punched_at, source) where device_id is null;
create index on public.punches_raw (employee_id, punched_at);
create index punches_unmapped on public.punches_raw (company_id) where employee_id is null;

create or replace function public.punches_immutable()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if coalesce(current_setting('app.allow_punch_purge', true), '') = 'on' then return old; end if;
    raise exception 'Raw punches are immutable';
  end if;
  -- the only allowed update: mapping an unmapped punch to an employee (ATT-06)
  if old.employee_id is null and new.employee_id is not null
     and (to_jsonb(new) - 'employee_id') = (to_jsonb(old) - 'employee_id') then
    return new;
  end if;
  raise exception 'Raw punches are immutable';
end $$;
create trigger punches_immutable before update or delete on public.punches_raw
  for each row execute function public.punches_immutable();

-- ---------------------------------------------------------------------------
-- Leave (ATT-17/18/19)
-- ---------------------------------------------------------------------------
create table public.leave_types (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  code              text not null,
  name              text not null,
  paid              boolean not null default true,
  annual_quota      numeric not null default 0,
  accrual           text not null default 'yearly' check (accrual in ('yearly','monthly','none')),
  carry_forward_max numeric not null default 0,
  encashable        boolean not null default false,
  allow_negative    boolean not null default false,
  active            boolean not null default true,
  unique (company_id, code)
);

-- opening balance per year (carry-forward or HR adjustment); accrual and usage are derived
create table public.leave_balances (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id) on delete cascade,
  employee_id    uuid not null references public.employees(id) on delete cascade,
  leave_type_id  uuid not null references public.leave_types(id) on delete cascade,
  year           integer not null,
  opening        numeric not null default 0,
  unique (employee_id, leave_type_id, year)
);

create table public.leave_requests (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id) on delete cascade,
  employee_id    uuid not null references public.employees(id) on delete cascade,
  leave_type_id  uuid not null references public.leave_types(id),
  from_date      date not null,
  to_date        date not null,
  half_day       boolean not null default false,
  days           numeric not null default 0,
  reason         text,
  status         text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  approver_id    uuid,
  decided_at     timestamptz,
  created_at     timestamptz not null default now(),
  check (to_date >= from_date),
  check (not half_day or from_date = to_date)
);
create index on public.leave_requests (employee_id, from_date);

-- ---------------------------------------------------------------------------
-- Daily attendance (ATT-09/10), regularisation (ATT-13), month lock (ATT-15)
-- ---------------------------------------------------------------------------
create table public.daily_attendance (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references public.companies(id) on delete cascade,
  employee_id          uuid not null references public.employees(id) on delete cascade,
  date                 date not null,
  status               text not null check (status in ('present','absent','half_day','late','early_out',
                         'on_leave','holiday','weekly_off','on_duty','wfh','missed_punch')),
  first_in             timestamptz,
  last_out             timestamptz,
  punch_count          integer not null default 0,
  worked_minutes       integer not null default 0,
  ot_minutes           integer not null default 0,
  ot_approved_minutes  integer not null default 0,
  late                 boolean not null default false,
  late_minutes         integer not null default 0,
  early_out            boolean not null default false,
  late_conversion      boolean not null default false,  -- ATT-11 made this day a half-day
  leave_type_id        uuid references public.leave_types(id),
  leave_half           boolean not null default false,
  half_present         boolean not null default false,   -- worked the other half of a half-day leave
  source               text not null default 'auto' check (source in ('auto','regularised','manual')),
  remarks              text,
  updated_at           timestamptz not null default now(),
  unique (employee_id, date)
);
create index on public.daily_attendance (company_id, date);

create table public.regularisations (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  employee_id   uuid not null references public.employees(id) on delete cascade,
  date          date not null,
  kind          text not null default 'missed_punch' check (kind in ('missed_punch','on_duty','wfh')),
  in_time       time,
  out_time      time,
  reason        text not null,
  status        text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  approver_id   uuid,
  decided_at    timestamptz,
  created_at    timestamptz not null default now()
);

create table public.attendance_locks (
  company_id  uuid not null references public.companies(id) on delete cascade,
  month       date not null,
  locked_by   uuid,
  locked_at   timestamptz not null default now(),
  primary key (company_id, month)
);

create or replace function public.is_month_locked(cid uuid, d date)
returns boolean language sql stable as $$
  select exists (select 1 from public.attendance_locks where company_id = cid and month = date_trunc('month', d)::date);
$$;

-- ---------------------------------------------------------------------------
-- Daily status engine
-- ---------------------------------------------------------------------------
create or replace function public.compute_attendance_day(p_emp uuid, p_date date)
returns void language plpgsql security definer set search_path = public as $$
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
  v_in_progress := now() < v_end + interval '4 hours';

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
end $$;

create or replace function public.recompute_attendance(p_company uuid, p_from date, p_to date, p_emp uuid default null)
returns integer language plpgsql security definer set search_path = public as $$
declare d date; r record; n integer := 0;
begin
  for d in select generate_series(p_from, p_to, interval '1 day')::date loop
    for r in select id from public.employees
             where company_id = p_company and (p_emp is null or id = p_emp)
               and status <> 'inactive' and date_of_joining <= d
               and (last_working_day is null or last_working_day >= d) loop
      perform public.compute_attendance_day(r.id, d);
      n := n + 1;
    end loop;
  end loop;
  return n;
end $$;

-- HR-triggered recompute for a date range (manual overrides are kept)
create or replace function public.recalculate_attendance(p_company uuid, p_from date, p_to date)
returns integer language plpgsql security definer set search_path = public as $$
begin
  if not public.is_hr(p_company) then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_to < p_from or p_to - p_from > 62 then raise exception 'Choose a range of up to two months'; end if;
  return public.recompute_attendance(p_company, p_from, p_to);
end $$;

-- recompute after any punch lands or is mapped (real-time path, ATT-02)
create or replace function public.punches_after_write()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_local date;
begin
  if new.employee_id is null then return null; end if;
  select (new.punched_at at time zone c.timezone)::date into v_local from public.companies c where c.id = new.company_id;
  perform public.compute_attendance_day(new.employee_id, v_local - 1);   -- night shift from yesterday
  perform public.compute_attendance_day(new.employee_id, v_local);
  return null;
end $$;
create trigger punches_after_write after insert or update on public.punches_raw
  for each row execute function public.punches_after_write();

-- ---------------------------------------------------------------------------
-- Device ingestion (ATT-02/05/07): called by the Edge Function / API route with the service role
-- ---------------------------------------------------------------------------
create or replace function public.ingest_punches(p_serial text, p_body text, p_signature text,
                                                 p_api_key text default null, p_ip text default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  d       public.devices%rowtype;
  sec     public.device_secrets%rowtype;
  c       public.companies%rowtype;
  body    jsonb;
  items   jsonb;
  it      jsonb;
  ts_text text;
  ts      timestamptz;
  n_total integer := 0;
  n_new   integer := 0;
  n_unmapped integer := 0;
  v_emp   uuid;
  v_rows  integer;
begin
  select * into d from public.devices where serial_no = p_serial;
  if not found then raise exception 'unknown device' using errcode = '28000'; end if;
  select * into sec from public.device_secrets where device_id = d.id;
  select * into c from public.companies where id = d.company_id;

  if coalesce(array_length(d.ip_allowlist, 1), 0) > 0 and (p_ip is null or not p_ip = any(d.ip_allowlist)) then
    raise exception 'ip not allowed' using errcode = '28000';
  end if;
  if p_signature is not null and p_signature <> '' then
    if encode(extensions.hmac(convert_to(p_body, 'UTF8'), convert_to(sec.hmac_secret, 'UTF8'), 'sha256'), 'hex')
       <> lower(regexp_replace(p_signature, '^sha256=', '')) then
      raise exception 'bad signature' using errcode = '28000';
    end if;
  elsif p_api_key is not null and p_api_key <> '' then
    if encode(extensions.digest(convert_to(p_api_key, 'UTF8'), 'sha256'), 'hex') <> sec.api_key_hash then
      raise exception 'bad api key' using errcode = '28000';
    end if;
  else
    raise exception 'missing credentials' using errcode = '28000';
  end if;

  body := p_body::jsonb;
  items := case when jsonb_typeof(body) = 'array' then body
                when body ? 'punches' then body -> 'punches'
                else jsonb_build_array(body) end;

  for it in select * from jsonb_array_elements(items) loop
    n_total := n_total + 1;
    ts_text := coalesce(it ->> 'timestamp', it ->> 'punched_at', it ->> 'time');
    -- timestamps without an offset are device-local time in the company timezone
    ts := case when ts_text ~ '(Z|[+-]\d\d:?\d\d)$' then ts_text::timestamptz
               else ts_text::timestamp at time zone c.timezone end;
    select employee_id into v_emp from public.device_user_map
      where device_id = d.id and device_user_id = (it ->> 'device_user_id');
    insert into public.punches_raw (company_id, device_id, device_user_id, employee_id, punched_at, verify_type, direction, source)
    values (d.company_id, d.id, it ->> 'device_user_id', v_emp, ts, it ->> 'verify_type',
            nullif(lower(it ->> 'direction'), ''), 'device')
    on conflict do nothing;
    get diagnostics v_rows = row_count;
    n_new := n_new + v_rows;
    if v_rows > 0 and v_emp is null then n_unmapped := n_unmapped + 1; end if;
  end loop;

  update public.devices set last_seen_at = now(), status = 'online' where id = d.id;
  return jsonb_build_object('received', n_total, 'accepted', n_new, 'duplicates', n_total - n_new, 'unmapped', n_unmapped);
end $$;

-- register a device; returns the secrets once so the admin can configure the device
create or replace function public.register_device(p_company uuid, p_branch uuid, p_name text, p_serial text,
                                                  p_vendor text, p_model text, p_ip text, p_mode text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid; v_secret text; v_key text;
begin
  if not public.has_role(p_company, array['owner','company_admin']) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  v_secret := encode(extensions.gen_random_bytes(32), 'hex');
  v_key := encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.devices (company_id, branch_id, name, serial_no, vendor, model, ip, mode)
  values (p_company, p_branch, p_name, p_serial, p_vendor, p_model, p_ip, coalesce(p_mode, 'push'))
  returning id into v_id;
  insert into public.device_secrets (device_id, hmac_secret, api_key_hash)
  values (v_id, v_secret, encode(extensions.digest(convert_to(v_key, 'UTF8'), 'sha256'), 'hex'));
  return jsonb_build_object('device_id', v_id, 'hmac_secret', v_secret, 'api_key', v_key);
end $$;

-- ATT-06: map a device user ID and attach every waiting punch to the employee
create or replace function public.map_device_user(p_device uuid, p_device_user_id text, p_emp uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare d public.devices%rowtype; n integer;
begin
  select * into d from public.devices where id = p_device;
  if not found or not public.is_hr(d.company_id) then raise exception 'not allowed' using errcode = '42501'; end if;
  if not exists (select 1 from public.employees where id = p_emp and company_id = d.company_id) then
    raise exception 'employee not in this company';
  end if;
  insert into public.device_user_map (company_id, device_id, device_user_id, employee_id)
  values (d.company_id, p_device, p_device_user_id, p_emp)
  on conflict (device_id, device_user_id) do update set employee_id = excluded.employee_id;
  update public.punches_raw set employee_id = p_emp
  where device_id = p_device and device_user_id = p_device_user_id and employee_id is null;
  get diagnostics n = row_count;
  return n;
end $$;

-- ATT-12: mobile punch with selfie + GPS, geofence checked in the database
create or replace function public.mobile_punch(p_company uuid, p_lat double precision, p_lng double precision,
                                               p_selfie_path text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare e public.employees%rowtype; b public.branches%rowtype; v_dist double precision; v_now timestamptz := now();
begin
  select * into e from public.employees where company_id = p_company and user_id = auth.uid() and status in ('active','notice');
  if not found then raise exception 'no active employee record' using errcode = '42501'; end if;
  if not e.mobile_attendance then raise exception 'Mobile attendance is not enabled for you'; end if;
  select * into b from public.branches where id = e.branch_id;
  if b.lat is null or b.lng is null then raise exception 'Your branch has no location set'; end if;
  -- haversine distance in metres
  v_dist := 2 * 6371000 * asin(sqrt(
    power(sin(radians(p_lat - b.lat) / 2), 2) +
    cos(radians(b.lat)) * cos(radians(p_lat)) * power(sin(radians(p_lng - b.lng) / 2), 2)));
  if v_dist > b.geofence_m then
    raise exception 'You are % m from %, outside the % m geofence', round(v_dist::numeric), b.name, b.geofence_m;
  end if;
  insert into public.punches_raw (company_id, employee_id, punched_at, verify_type, source, lat, lng, selfie_path)
  values (p_company, e.id, date_trunc('second', v_now), 'selfie', 'mobile', p_lat, p_lng, p_selfie_path);
  return jsonb_build_object('punched_at', date_trunc('second', v_now), 'distance_m', round(v_dist::numeric));
end $$;

-- CSV / Excel punch import fallback (risk mitigation for devices without an API)
create or replace function public.import_punches(p_company uuid, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare it jsonb; v_emp uuid; n integer := 0; skipped integer := 0; v_rows integer; c public.companies%rowtype;
begin
  if not public.is_hr(p_company) then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into c from public.companies where id = p_company;
  for it in select * from jsonb_array_elements(p_rows) loop
    select id into v_emp from public.employees where company_id = p_company and emp_code = it ->> 'emp_code';
    if v_emp is null then skipped := skipped + 1; continue; end if;
    insert into public.punches_raw (company_id, employee_id, punched_at, verify_type, source)
    values (p_company, v_emp, (it ->> 'timestamp')::timestamp at time zone c.timezone, 'import', 'import')
    on conflict do nothing;
    get diagnostics v_rows = row_count;
    n := n + v_rows;
  end loop;
  return jsonb_build_object('imported', n, 'skipped', skipped);
end $$;

-- ---------------------------------------------------------------------------
-- Leave logic
-- ---------------------------------------------------------------------------
-- working days in a range: excludes weekly offs and holidays
create or replace function public.leave_days(p_emp uuid, p_from date, p_to date, p_half boolean)
returns numeric language sql stable security definer set search_path = public as $$
  select case when p_half then 0.5 else count(*)::numeric end
  from public.employees e
  join public.companies c on c.id = e.company_id,
  generate_series(p_from, p_to, interval '1 day') g(d)
  where e.id = p_emp
    and not (extract(dow from g.d)::int = any(c.weekly_offs))
    and not exists (select 1 from public.holidays h where h.company_id = e.company_id and h.date = g.d::date
                    and (h.branch_id is null or h.branch_id = e.branch_id));
$$;

create or replace view public.leave_balance_view with (security_invoker = true) as
select e.company_id, e.id as employee_id, lt.id as leave_type_id, lt.code, lt.name, lt.paid, lt.encashable,
       y.year,
       coalesce(b.opening, 0) as opening,
       case lt.accrual
         when 'yearly' then lt.annual_quota
         when 'monthly' then round(lt.annual_quota / 12 *
              least(12, greatest(0, case when y.year < extract(year from current_date) then 12
                                         when y.year > extract(year from current_date) then 0
                                         else extract(month from current_date) end)), 2)
         else 0 end as accrued,
       coalesce((select sum(r.days) from public.leave_requests r
                 where r.employee_id = e.id and r.leave_type_id = lt.id and r.status = 'approved'
                   and extract(year from r.from_date) = y.year), 0) as used,
       coalesce((select sum(r.days) from public.leave_requests r
                 where r.employee_id = e.id and r.leave_type_id = lt.id and r.status = 'pending'
                   and extract(year from r.from_date) = y.year), 0) as pending
from public.employees e
join public.leave_types lt on lt.company_id = e.company_id and lt.active
cross join (select extract(year from current_date)::int as year
            union select extract(year from current_date)::int - 1) y
left join public.leave_balances b on b.employee_id = e.id and b.leave_type_id = lt.id and b.year = y.year;

create or replace function public.leave_available(p_emp uuid, p_type uuid, p_year int)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(opening + accrued - used - pending), 0) from public.leave_balance_view
  where employee_id = p_emp and leave_type_id = p_type and year = p_year;
$$;

create or replace function public.leave_requests_before_write()
returns trigger language plpgsql security definer set search_path = public as $$
declare lt public.leave_types%rowtype; v_is_approver boolean;
begin
  if tg_op = 'INSERT' then
    new.days := public.leave_days(new.employee_id, new.from_date, new.to_date, new.half_day);
    if new.days <= 0 then raise exception 'The selected dates have no working days'; end if;
    if exists (select 1 from public.leave_requests r where r.employee_id = new.employee_id
               and r.status in ('pending','approved') and daterange(r.from_date, r.to_date, '[]') && daterange(new.from_date, new.to_date, '[]')) then
      raise exception 'You already have leave on these dates';
    end if;
    select * into lt from public.leave_types where id = new.leave_type_id;
    if lt.paid and not lt.allow_negative
       and public.leave_available(new.employee_id, new.leave_type_id, extract(year from new.from_date)::int) < new.days then
      raise exception 'Insufficient % balance', lt.code;
    end if;
    new.status := 'pending';
    return new;
  end if;

  if new.status is distinct from old.status then
    v_is_approver := auth.uid() is null or public.is_hr(old.company_id) or public.is_manager_of(old.employee_id);
    if new.status in ('approved','rejected') then
      if not v_is_approver then raise exception 'Only the manager or HR can decide on leave' using errcode = '42501'; end if;
      if old.status <> 'pending' then raise exception 'Only pending leave can be decided'; end if;
      new.approver_id := auth.uid(); new.decided_at := now();
    elsif new.status = 'cancelled' then
      if old.status = 'approved' and public.is_month_locked(old.company_id, old.from_date) then
        raise exception 'Attendance for that month is locked';
      end if;
    end if;
  end if;
  return new;
end $$;
create trigger leave_requests_before_write before insert or update on public.leave_requests
  for each row execute function public.leave_requests_before_write();

create or replace function public.leave_requests_after_write()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_mgr uuid; v_user uuid;
begin
  if tg_op = 'INSERT' then
    select m.user_id into v_mgr from public.employees e join public.employees m on m.id = e.reporting_manager_id where e.id = new.employee_id;
    perform public.notify(v_mgr, new.company_id, 'Leave request', 'A leave request is waiting for your approval', '/leave');
  elsif new.status is distinct from old.status then
    if new.status = 'approved' or old.status = 'approved' then
      perform public.recompute_attendance(new.company_id, new.from_date, new.to_date, new.employee_id);
    end if;
    select user_id into v_user from public.employees where id = new.employee_id;
    if new.status in ('approved','rejected') then
      perform public.notify(v_user, new.company_id, 'Leave ' || new.status, to_char(new.from_date, 'DD Mon') || ' – ' || to_char(new.to_date, 'DD Mon'), '/leave');
    end if;
  end if;
  return null;
end $$;
create trigger leave_requests_after_write after insert or update on public.leave_requests
  for each row execute function public.leave_requests_after_write();

-- ---------------------------------------------------------------------------
-- Regularisation (ATT-13): approval adds regularisation punches; originals stay untouched
-- ---------------------------------------------------------------------------
create or replace function public.regularisations_before_write()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if public.is_month_locked(new.company_id, new.date) then raise exception 'Attendance for that month is locked'; end if;
    if new.kind = 'missed_punch' and new.in_time is null and new.out_time is null then
      raise exception 'Give the missed in or out time';
    end if;
    new.status := 'pending';
    return new;
  end if;
  if new.status is distinct from old.status and new.status in ('approved','rejected') then
    if not (auth.uid() is null or public.is_hr(old.company_id) or public.is_manager_of(old.employee_id)) then
      raise exception 'Only the manager or HR can decide' using errcode = '42501';
    end if;
    if old.status <> 'pending' then raise exception 'Only pending requests can be decided'; end if;
    new.approver_id := auth.uid(); new.decided_at := now();
  end if;
  return new;
end $$;
create trigger regularisations_before_write before insert or update on public.regularisations
  for each row execute function public.regularisations_before_write();

create or replace function public.regularisations_after_write()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_tz text; v_mgr uuid; v_user uuid;
begin
  if tg_op = 'INSERT' then
    select m.user_id into v_mgr from public.employees e join public.employees m on m.id = e.reporting_manager_id where e.id = new.employee_id;
    perform public.notify(v_mgr, new.company_id, 'Regularisation request', 'An attendance correction is waiting for approval', '/attendance/requests');
    return null;
  end if;
  if new.status = 'approved' and old.status <> 'approved' then
    select timezone into v_tz from public.companies where id = new.company_id;
    if new.kind = 'missed_punch' then
      insert into public.punches_raw (company_id, employee_id, punched_at, verify_type, direction, source)
      select new.company_id, new.employee_id, (new.date + t.tm) at time zone v_tz, 'manual', t.dir, 'regularisation'
      from (values (new.in_time, 'in'), (new.out_time, 'out')) t(tm, dir)
      where t.tm is not null
      on conflict do nothing;
    end if;
    perform public.compute_attendance_day(new.employee_id, new.date);
  end if;
  if new.status in ('approved','rejected') and new.status is distinct from old.status then
    select user_id into v_user from public.employees where id = new.employee_id;
    perform public.notify(v_user, new.company_id, 'Regularisation ' || new.status, to_char(new.date, 'DD Mon YYYY'), '/attendance/me');
  end if;
  return null;
end $$;
create trigger regularisations_after_write after insert or update on public.regularisations
  for each row execute function public.regularisations_after_write();

-- ---------------------------------------------------------------------------
-- HR overrides, OT approval, month lock / unlock
-- ---------------------------------------------------------------------------
create or replace function public.set_attendance_status(p_emp uuid, p_date date, p_status text, p_remarks text)
returns void language plpgsql security definer set search_path = public as $$
declare e public.employees%rowtype;
begin
  select * into e from public.employees where id = p_emp;
  if not public.is_hr(e.company_id) then raise exception 'not allowed' using errcode = '42501'; end if;
  if public.is_month_locked(e.company_id, p_date) then raise exception 'Attendance for that month is locked'; end if;
  if p_status = 'auto' then
    delete from public.daily_attendance where employee_id = p_emp and date = p_date;
    perform public.compute_attendance_day(p_emp, p_date);
    return;
  end if;
  insert into public.daily_attendance (company_id, employee_id, date, status, source, remarks)
  values (e.company_id, p_emp, p_date, p_status, 'manual', p_remarks)
  on conflict (employee_id, date) do update set status = excluded.status, source = 'manual',
    remarks = excluded.remarks, updated_at = now();
end $$;

create or replace function public.approve_overtime(p_attendance uuid, p_minutes integer)
returns void language plpgsql security definer set search_path = public as $$
declare a public.daily_attendance%rowtype;
begin
  select * into a from public.daily_attendance where id = p_attendance;
  if not (public.is_hr(a.company_id) or public.is_manager_of(a.employee_id)) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if public.is_month_locked(a.company_id, a.date) then raise exception 'Attendance for that month is locked'; end if;
  update public.daily_attendance set ot_approved_minutes = least(greatest(p_minutes, 0), ot_minutes), updated_at = now()
  where id = p_attendance;
end $$;

create or replace function public.lock_attendance_month(p_company uuid, p_month date)
returns void language plpgsql security definer set search_path = public as $$
declare v_month date := date_trunc('month', p_month)::date; v_end date; v_unmapped integer;
begin
  if not public.is_hr(p_company) then raise exception 'not allowed' using errcode = '42501'; end if;
  v_end := (v_month + interval '1 month - 1 day')::date;
  select count(*) into v_unmapped from public.punches_raw
  where company_id = p_company and employee_id is null
    and punched_at >= v_month - interval '1 day' and punched_at < v_end + interval '2 days';
  if v_unmapped > 0 then
    raise exception '% unmapped punches in this month — map them in the exceptions queue before locking', v_unmapped;
  end if;
  perform public.recompute_attendance(p_company, v_month, least(v_end, current_date));
  insert into public.attendance_locks (company_id, month, locked_by) values (p_company, v_month, auth.uid())
  on conflict do nothing;
end $$;

create or replace function public.unlock_attendance_month(p_company uuid, p_month date, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare v_month date := date_trunc('month', p_month)::date;
begin
  if not public.has_role(p_company, array['owner','company_admin']) then
    raise exception 'Only an admin can unlock attendance' using errcode = '42501';
  end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required'; end if;
  if exists (select 1 from public.payroll_runs where company_id = p_company and month = v_month and status in ('approved','locked')) then
    raise exception 'Payroll for this month is approved — reopen payroll instead';
  end if;
  delete from public.attendance_locks where company_id = p_company and month = v_month;
  insert into public.audit_log (company_id, user_id, table_name, record_id, action, new_data, ip)
  values (p_company, auth.uid(), 'attendance_locks', v_month::text, 'unlock', jsonb_build_object('reason', p_reason), public.request_ip());
end $$;

-- ---------------------------------------------------------------------------
-- Scheduled jobs (pg_cron): per-minute recompute of today and device offline alerts (ATT-03)
-- ---------------------------------------------------------------------------
create or replace function public.check_devices()
returns integer language plpgsql security definer set search_path = public as $$
declare r record; n integer := 0;
begin
  for r in update public.devices set status = 'offline'
           where status = 'online' and last_seen_at < now() - interval '15 minutes'
           returning id, company_id, name loop
    perform public.notify_roles(r.company_id, array['owner','company_admin'], 'Device offline',
      r.name || ' has not synced for 15 minutes', '/attendance/devices');
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function public.attendance_tick()
returns void language plpgsql security definer set search_path = public as $$
declare c record; v_today date;
begin
  for c in select id, timezone from public.companies where status = 'active' loop
    v_today := (now() at time zone c.timezone)::date;
    perform public.recompute_attendance(c.id, v_today - 1, v_today);
  end loop;
  perform public.check_devices();
end $$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.devices          enable row level security;
alter table public.device_secrets   enable row level security;
alter table public.device_user_map  enable row level security;
alter table public.punches_raw      enable row level security;
alter table public.leave_types      enable row level security;
alter table public.leave_balances   enable row level security;
alter table public.leave_requests   enable row level security;
alter table public.daily_attendance enable row level security;
alter table public.regularisations  enable row level security;
alter table public.attendance_locks enable row level security;

create policy devices_select on public.devices for select using (public.is_hr(company_id));
create policy devices_update on public.devices for update
  using (public.has_role(company_id, array['owner','company_admin']))
  with check (public.has_role(company_id, array['owner','company_admin']));
create policy devices_delete on public.devices for delete using (public.has_role(company_id, array['owner','company_admin']));

create policy dum_select on public.device_user_map for select using (public.is_hr(company_id));
create policy dum_delete on public.device_user_map for delete using (public.is_hr(company_id));

create policy punches_select on public.punches_raw for select using (
  public.is_hr(company_id) or (employee_id is not null and public.can_view_employee(employee_id)));

create policy leave_types_select on public.leave_types for select using (public.is_member(company_id));
create policy leave_types_write on public.leave_types for all using (public.is_hr(company_id)) with check (public.is_hr(company_id));

create policy leave_bal_select on public.leave_balances for select using (public.can_view_employee(employee_id));
create policy leave_bal_write on public.leave_balances for all using (public.is_hr(company_id)) with check (public.is_hr(company_id));

create policy leave_req_select on public.leave_requests for select using (public.can_view_employee(employee_id));
create policy leave_req_insert on public.leave_requests for insert with check (
  employee_id = public.my_employee_id(company_id) or public.is_hr(company_id));
create policy leave_req_update on public.leave_requests for update using (
  employee_id = public.my_employee_id(company_id) or public.is_hr(company_id) or public.is_manager_of(employee_id))
  with check (public.is_member(company_id));

create policy att_select on public.daily_attendance for select using (public.can_view_employee(employee_id));

create policy reg_select on public.regularisations for select using (public.can_view_employee(employee_id));
create policy reg_insert on public.regularisations for insert with check (
  employee_id = public.my_employee_id(company_id) or public.is_hr(company_id));
create policy reg_update on public.regularisations for update using (
  employee_id = public.my_employee_id(company_id) or public.is_hr(company_id) or public.is_manager_of(employee_id))
  with check (public.is_member(company_id));

create policy locks_select on public.attendance_locks for select using (public.is_member(company_id));

-- audit human changes to attendance (manual overrides and OT approvals), not the automatic recompute
create trigger daily_attendance_audit_upd after update on public.daily_attendance
  for each row when (new.source = 'manual' or old.source = 'manual'
                     or old.ot_approved_minutes is distinct from new.ot_approved_minutes)
  execute function public.audit_trigger();
create trigger daily_attendance_audit_del after delete on public.daily_attendance
  for each row when (old.source = 'manual') execute function public.audit_trigger();
create trigger leave_types_audit after insert or update or delete on public.leave_types
  for each row execute function public.audit_trigger();
create trigger attendance_locks_audit after insert on public.attendance_locks
  for each row execute function public.audit_trigger();
