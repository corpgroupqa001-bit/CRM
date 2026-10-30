-- corpgroup.com · 0056 employee self sign-up with a company code, and project join requests
--
-- Revised BRD v2.0 (30 Oct 2026): AUTH-19, AUTH-18 and COM-15. This reverses the 27 Oct rule (0028) that
-- employees only join by invitation.
--   * every company has a sign-up code (and so a sign-up link); nobody can see or join a company without it
--   * an employee signs up with the code: name, email, mobile and the projects they want to join. The account
--     stays pending, with no company access, until the Owner or the Admin approves it (approve_join_request,
--     0021/0055). HR then completes the employee record (device user ID and so on).
--   * project membership is requested and approved project by project; the person sees a project's tasks and
--     chat only once it is approved. A rejected request can be made again. Every decision is notified to the
--     person and written to the audit log. Attendance, leave and payslips don't depend on projects.

-- 1. the company's sign-up code
create or replace function public.new_join_code()
returns text language sql volatile set search_path = public as $$
  -- 8 characters without look-alikes (no 0/O, 1/I/L)
  select string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + floor(random() * 31)::int, 1), '')
  from generate_series(1, 8);
$$;
alter table public.companies add column if not exists join_code text;
update public.companies set join_code = public.new_join_code() where join_code is null;
alter table public.companies alter column join_code set default public.new_join_code();
alter table public.companies alter column join_code set not null;
create unique index if not exists companies_join_code_key on public.companies (upper(join_code));

-- the Admin (or anyone with Settings) replaces the code, e.g. after it was shared too widely
create or replace function public.regenerate_join_code(p_company uuid)
returns text language plpgsql security definer set search_path = public as $$
declare v text;
begin
  if not public.has_perm(p_company, 'settings.manage') then
    raise exception 'Only the Admin can change the sign-up code' using errcode = '42501';
  end if;
  loop
    v := public.new_join_code();
    exit when not exists (select 1 from public.companies where upper(join_code) = v);
  end loop;
  update public.companies set join_code = v where id = p_company;
  insert into public.audit_log (company_id, user_id, table_name, record_id, action, ip)
  values (p_company, auth.uid(), 'companies', p_company::text, 'new_join_code', public.request_ip());
  return v;
end $$;
revoke execute on function public.regenerate_join_code(uuid) from public, anon;
grant execute on function public.regenerate_join_code(uuid) to authenticated;

-- what the sign-up page may show for a code: the company's name and its open projects (names only)
create or replace function public.join_code_lookup(p_code text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('company_id', c.id, 'company', c.name,
    'projects', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name) order by p.name)
                          from public.projects p where p.company_id = c.id and not p.archived and p.status in ('planned','active')), '[]'))
  from public.companies c
  where upper(c.join_code) = upper(trim(p_code)) and c.status = 'active';
$$;
revoke execute on function public.join_code_lookup(text) from public;
grant execute on function public.join_code_lookup(text) to anon, authenticated;

-- 2. project join requests
create table if not exists public.project_requests (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  project_id    uuid not null references public.projects(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  status        text not null default 'pending' check (status in ('pending','approved','rejected')),
  decided_by    uuid,
  decided_at    timestamptz,
  decision_note text,
  created_at    timestamptz not null default now()
);
create unique index if not exists project_requests_one_pending on public.project_requests (project_id, user_id) where status = 'pending';
create index if not exists project_requests_company on public.project_requests (company_id, status);
alter table public.project_requests enable row level security;
drop policy if exists pr_select on public.project_requests;
create policy pr_select on public.project_requests for select
  using (user_id = auth.uid() or public.has_perm(company_id, 'projects.manage_all'));
-- no direct writes: request_projects / decide_project_request only

-- the people who approve: the Owner (and the old Company Admin, read as the Owner) and the Admin
create or replace function public.notify_approvers(p_company uuid, p_title text, p_body text, p_link text)
returns void language plpgsql security definer set search_path = public as $$
declare r record;
begin
  perform public.notify_roles(p_company, array['owner'], p_title, p_body, p_link);
  for r in select user_id from public.platform_admins
           where user_id not in (select user_id from public.company_members where company_id = p_company and role = 'owner') loop
    perform public.notify(r.user_id, p_company, p_title, p_body, p_link);
  end loop;
end $$;
revoke execute on function public.notify_approvers(uuid, text, text, text) from public, anon, authenticated;

-- adds pending requests for projects of one company (skips ones already joined or already waiting)
create or replace function public.add_project_requests(p_user uuid, p_company uuid, p_projects uuid[])
returns integer language plpgsql security definer set search_path = public as $$
declare v_pid uuid; n integer := 0;
begin
  foreach v_pid in array coalesce(p_projects, '{}') loop
    if not exists (select 1 from public.projects where id = v_pid and company_id = p_company and not archived) then
      raise exception 'That project is not part of this company';
    end if;
    if exists (select 1 from public.project_members pm join public.employees e on e.id = pm.employee_id
               where pm.project_id = v_pid and e.user_id = p_user) then continue; end if;
    insert into public.project_requests (company_id, project_id, user_id) values (p_company, v_pid, p_user)
    on conflict do nothing;
    if found then n := n + 1; end if;
  end loop;
  return n;
end $$;
revoke execute on function public.add_project_requests(uuid, uuid, uuid[]) from public, anon, authenticated;

-- 3. AUTH-19: sign up with the company code. Called by the server for the new account (service role only).
create or replace function public.join_company_for(p_user uuid, p_code text, p_full_name text, p_phone text, p_projects uuid[])
returns uuid language plpgsql security definer set search_path = public as $$
declare v_company uuid; v_email text; v_id uuid;
begin
  select id into v_company from public.companies where upper(join_code) = upper(trim(p_code)) and status = 'active';
  if v_company is null then raise exception 'That sign-up code is not valid. Ask your company for the current link or code.'; end if;
  if coalesce(trim(p_full_name), '') = '' then raise exception 'Enter your full name'; end if;
  if coalesce(trim(p_phone), '') = '' then raise exception 'Enter your mobile number'; end if;
  if exists (select 1 from public.company_members where company_id = v_company and user_id = p_user) then
    raise exception 'You already belong to this company. Sign in instead.';
  end if;
  select email into v_email from public.profiles where id = p_user;
  insert into public.join_requests (company_id, user_id, full_name, email, phone)
  values (v_company, p_user, trim(p_full_name), v_email, trim(p_phone))
  on conflict (company_id, user_id) do update set full_name = excluded.full_name, phone = excluded.phone,
    status = 'pending', decided_by = null, decided_at = null, decision_note = null, created_at = now()
    where public.join_requests.status <> 'approved'
  returning id into v_id;
  if v_id is null then raise exception 'Your request was already approved. Sign in instead.'; end if;
  perform public.add_project_requests(p_user, v_company, p_projects);
  perform public.notify_approvers(v_company, 'New sign-up waiting for approval',
    trim(p_full_name) || ' (' || v_email || ')' ||
    case when coalesce(array_length(p_projects, 1), 0) > 0 then ' · asks to join ' || array_length(p_projects, 1) || ' project(s)' else '' end,
    '/c/' || v_company || '/requests');
  return v_id;
end $$;
revoke execute on function public.join_company_for(uuid, text, text, text, uuid[]) from public, anon, authenticated;

-- the old form (choose a company from a list) stays closed: only the code works
create or replace function public.submit_join_request(p_company uuid, p_full_name text, p_phone text, p_designation uuid, p_department uuid, p_note text)
returns uuid language plpgsql security definer set search_path = public as $$
begin
  raise exception 'Use your company''s sign-up link or code' using errcode = '42501';
end $$;

-- 4. AUTH-18 / COM-15: an employee (approved, or invited by HR) asks to join more projects later
create or replace function public.request_projects(p_company uuid, p_projects uuid[])
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not exists (select 1 from public.employees where company_id = p_company and user_id = auth.uid() and status in ('active','notice')) then
    raise exception 'Only people working in this company can ask to join its projects' using errcode = '42501';
  end if;
  n := public.add_project_requests(auth.uid(), p_company, p_projects);
  if n > 0 then
    perform public.notify_approvers(p_company, 'Project request waiting',
      coalesce((select full_name from public.profiles where id = auth.uid()), 'Someone') || ' asks to join ' || n || ' project(s)',
      '/c/' || p_company || '/requests');
  end if;
  return n;
end $$;
revoke execute on function public.request_projects(uuid, uuid[]) from public, anon;
grant execute on function public.request_projects(uuid, uuid[]) to authenticated;

-- the Owner or the Admin decides each project request
create or replace function public.decide_project_request(p_id uuid, p_approve boolean, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare r public.project_requests%rowtype; v_emp uuid; v_project text;
begin
  select * into r from public.project_requests where id = p_id;
  if r.id is null or not public.has_perm(r.company_id, 'projects.manage_all') then
    raise exception 'Only the Owner or the Admin can decide project requests' using errcode = '42501';
  end if;
  if r.status <> 'pending' then raise exception 'This request was already %', r.status; end if;
  select name into v_project from public.projects where id = r.project_id;
  if p_approve then
    select id into v_emp from public.employees
    where company_id = r.company_id and user_id = r.user_id and status in ('active','notice') and removed_at is null;
    if v_emp is null then raise exception 'Approve their account first, then the project'; end if;
    insert into public.project_members (project_id, employee_id, company_id) values (r.project_id, v_emp, r.company_id)
    on conflict do nothing;
  end if;
  update public.project_requests set status = case when p_approve then 'approved' else 'rejected' end,
    decided_by = auth.uid(), decided_at = now(), decision_note = nullif(trim(p_note), '')
  where id = p_id;
  insert into public.audit_log (company_id, user_id, table_name, record_id, action, new_data, ip)
  values (r.company_id, auth.uid(), 'project_requests', p_id::text, case when p_approve then 'approve' else 'reject' end,
          jsonb_build_object('project', v_project, 'user_id', r.user_id, 'note', nullif(trim(p_note), '')), public.request_ip());
  perform public.notify(r.user_id, r.company_id,
    case when p_approve then 'Project request approved' else 'Project request not approved' end,
    v_project || case when p_approve then ': you can now see its tasks and chat.'
                      else coalesce(': ' || nullif(trim(p_note), ''), '.') || ' You can ask again later.' end,
    '/c/' || r.company_id || '/projects');
end $$;
revoke execute on function public.decide_project_request(uuid, boolean, text) from public, anon;
grant execute on function public.decide_project_request(uuid, boolean, text) to authenticated;

-- what an employee may ask to join: the company's open projects they are not in, with any request status
create or replace function public.joinable_projects(p_company uuid)
returns table (id uuid, name text, client text, request_status text) language sql stable security definer set search_path = public as $$
  select p.id, p.name, p.client,
    (select pr.status from public.project_requests pr where pr.project_id = p.id and pr.user_id = auth.uid()
     order by pr.created_at desc limit 1)
  from public.projects p
  where p.company_id = p_company and not p.archived and p.status in ('planned','active')
    and exists (select 1 from public.employees where company_id = p_company and user_id = auth.uid() and status in ('active','notice'))
    and not public.is_project_member(p.id)
  order by p.name;
$$;
revoke execute on function public.joinable_projects(uuid) from public, anon;
grant execute on function public.joinable_projects(uuid) to authenticated;


-- 5. the email code for an employee signing up with a company code
do $$
declare c text;
begin
  for c in select conname from pg_constraint where conrelid = 'public.otp_codes'::regclass and contype = 'c'
             and pg_get_constraintdef(oid) like '%purpose%' loop
    execute format('alter table public.otp_codes drop constraint %I', c);
  end loop;
end $$;
alter table public.otp_codes add constraint otp_codes_purpose_check
  check (purpose in ('signup','login','reset','invite','change_email','join'));
