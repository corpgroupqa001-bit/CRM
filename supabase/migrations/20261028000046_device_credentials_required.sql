-- corpgroup.com · 0046 a device without credentials is refused (BRD ATT-07)
--
-- Found while testing the NFR-12 alerts (0045): ingest_punches compared the key / signature with the
-- device's stored hash, and when a device had no device_secrets row the comparison was null, so the punch
-- was accepted with any key. Devices registered through the app always get credentials, so this needed a
-- device inserted some other way; it now fails closed. Same function as 0005 with that one check added.

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
  -- a device without credentials is refused (before: a missing key made the comparison null, which let it through)
  if sec.device_id is null then raise exception 'device has no credentials' using errcode = '28000'; end if;
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
