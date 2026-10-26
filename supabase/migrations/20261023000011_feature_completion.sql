-- corpgroup.com · 0011 remaining BRD features
--   X-01 / COMMS-07  notification preferences per event type, do-not-disturb hours, web-push subscriptions
--   ATT-17           leave carry-forward at year end
--   TSK-03/06/08/11  sub-tasks, checklists, dependencies, recurring tasks, time logs, templates
--   COMMS-05/12      reply, forward, pin, star; cross-department DM switch, compliance export, retention
--   SAL-04           tax regime choice and investment declarations feeding the TDS projection
--   SAL-12           password-protected payslip option
--   COM-14, X-04     saved filters, scheduled report e-mails
--   NFR-06 / NFR-09  data export / deletion requests, retention purges

-- ===========================================================================
-- Notifications: per-type preferences and quiet hours
-- ===========================================================================
alter table public.notifications add column if not exists kind text not null default 'general';
alter table public.profiles add column if not exists dnd_start time;
alter table public.profiles add column if not exists dnd_end time;
alter table public.profiles add column if not exists consent_at timestamptz;

create table public.notification_prefs (
  user_id  uuid not null references auth.users(id) on delete cascade default auth.uid(),
  kind     text not null check (kind in ('leave','attendance','tasks','announcements','payroll','chat','general')),
  in_app   boolean not null default true,
  email    boolean not null default false,
  push     boolean not null default true,
  primary key (user_id, kind)
);
alter table public.notification_prefs enable row level security;
create policy np_own on public.notification_prefs for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create table public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade default auth.uid(),
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  created_at  timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
create policy ps_own on public.push_subscriptions for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- event type comes from the first path segment of the link: /leave → leave, /tasks/… → tasks
create or replace function public.notification_kind(p_link text)
returns text language sql immutable as $$
  select case split_part(coalesce(p_link, ''), '/', 2)
    when 'leave' then 'leave' when 'attendance' then 'attendance' when 'tasks' then 'tasks'
    when 'announcements' then 'announcements' when 'payroll' then 'payroll' else 'general' end;
$$;

create or replace function public.notify(p_user uuid, p_company uuid, p_title text, p_body text, p_link text)
returns void language plpgsql security definer set search_path = public as $$
declare v_kind text := public.notification_kind(p_link);
begin
  if p_user is null then return; end if;
  if exists (select 1 from public.notification_prefs where user_id = p_user and kind = v_kind and not in_app) then return; end if;
  insert into public.notifications (user_id, company_id, title, body, link, kind) values (p_user, p_company, p_title, p_body, p_link, v_kind);
end $$;

create or replace function public.notify_roles(p_company uuid, p_roles text[], p_title text, p_body text, p_link text)
returns void language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in select user_id from public.company_members where company_id = p_company and active and role = any(p_roles) loop
    perform public.notify(r.user_id, p_company, p_title, p_body, p_link);
  end loop;
end $$;

-- ===========================================================================
-- ATT-17 leave carry-forward
-- ===========================================================================
create or replace function public.carry_forward_leaves(p_company uuid, p_year int)
returns integer language plpgsql security definer set search_path = public as $$
declare r record; v_bal numeric; n integer := 0;
begin
  if not public.is_hr(p_company) then raise exception 'not allowed' using errcode = '42501'; end if;
  for r in select e.id as emp, lt.id as lt, lt.carry_forward_max as cap
           from public.employees e join public.leave_types lt on lt.company_id = e.company_id
           where e.company_id = p_company and e.status in ('active','notice') and lt.active and lt.carry_forward_max > 0 loop
    select coalesce(sum(opening + accrued - used), 0) into v_bal from public.leave_balance_view
      where employee_id = r.emp and leave_type_id = r.lt and year = p_year;
    insert into public.leave_balances (company_id, employee_id, leave_type_id, year, opening)
    values (p_company, r.emp, r.lt, p_year + 1, least(greatest(v_bal, 0), r.cap))
    on conflict (employee_id, leave_type_id, year) do update set opening = excluded.opening;
    n := n + 1;
  end loop;
  return n;
end $$;

-- ===========================================================================
-- Tasks: sub-tasks, checklists, dependencies, recurrence, time tracking, templates
-- ===========================================================================
alter table public.tasks add column if not exists parent_id uuid references public.tasks(id) on delete cascade;
alter table public.tasks add column if not exists recurrence text check (recurrence in ('daily','weekly','monthly'));
alter table public.tasks add column if not exists source_message_id uuid;
create index if not exists tasks_parent_idx on public.tasks (parent_id);

create table public.task_checklist (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references public.tasks(id) on delete cascade,
  company_id  uuid not null references public.companies(id) on delete cascade,
  item        text not null,
  done        boolean not null default false,
  position    integer not null default 0
);
create table public.task_dependencies (
  task_id     uuid not null references public.tasks(id) on delete cascade,
  blocked_by  uuid not null references public.tasks(id) on delete cascade,
  company_id  uuid not null references public.companies(id) on delete cascade,
  primary key (task_id, blocked_by),
  check (task_id <> blocked_by)
);
create table public.task_time_logs (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid not null references public.tasks(id) on delete cascade,
  company_id   uuid not null references public.companies(id) on delete cascade,
  employee_id  uuid not null references public.employees(id) on delete cascade,
  started_at   timestamptz not null default now(),
  ended_at     timestamptz,
  minutes      integer,
  note         text,
  check (ended_at is null or ended_at >= started_at)
);
create index on public.task_time_logs (task_id);
create index on public.task_time_logs (employee_id, started_at);
create table public.task_templates (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  name         text not null,
  title        text not null,
  description  text,
  priority     text not null default 'medium',
  checklist    text[] not null default '{}',
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now()
);

-- a task cannot be closed while a task it depends on is still open
create or replace function public.tasks_check_blockers()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_open text;
begin
  if new.status = 'done' and old.status <> 'done' then
    select string_agg(b.title, ', ') into v_open from public.task_dependencies d join public.tasks b on b.id = d.blocked_by
      where d.task_id = new.id and b.status <> 'done';
    if v_open is not null then raise exception 'Still blocked by: %', v_open; end if;
  end if;
  return new;
end $$;
create trigger tasks_check_blockers before update on public.tasks for each row execute function public.tasks_check_blockers();

-- TSK-06: closing a recurring task creates the next occurrence
create or replace function public.tasks_recur()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_new uuid; v_step interval;
begin
  if new.recurrence is null or new.status <> 'done' or old.status = 'done' then return null; end if;
  v_step := case new.recurrence when 'daily' then interval '1 day' when 'weekly' then interval '7 days' else interval '1 month' end;
  insert into public.tasks (company_id, project_id, parent_id, title, description, priority, labels, recurrence, created_by, due_at, status)
  values (new.company_id, new.project_id, new.parent_id, new.title, new.description, new.priority, new.labels, new.recurrence,
          new.created_by, coalesce(new.due_at, now()) + v_step, 'todo')
  returning id into v_new;
  insert into public.task_assignees (task_id, employee_id, company_id) select v_new, employee_id, company_id from public.task_assignees where task_id = new.id;
  insert into public.task_checklist (task_id, company_id, item, position) select v_new, company_id, item, position from public.task_checklist where task_id = new.id;
  return null;
end $$;
create trigger tasks_recur after update on public.tasks for each row execute function public.tasks_recur();

create or replace function public.time_logs_before_write()
returns trigger language plpgsql as $$
begin
  if new.ended_at is not null then new.minutes := greatest(0, round(extract(epoch from new.ended_at - new.started_at) / 60))::int; end if;
  return new;
end $$;
create trigger time_logs_before_write before insert or update on public.task_time_logs for each row execute function public.time_logs_before_write();

alter table public.task_checklist    enable row level security;
alter table public.task_dependencies enable row level security;
alter table public.task_time_logs    enable row level security;
alter table public.task_templates    enable row level security;
create policy tcl_select on public.task_checklist for select using (public.can_view_task(task_id));
create policy tcl_write on public.task_checklist for all using (public.can_edit_task(task_id)) with check (public.can_edit_task(task_id));
create policy tdep_select on public.task_dependencies for select using (public.can_view_task(task_id));
create policy tdep_write on public.task_dependencies for all using (public.can_edit_task(task_id))
  with check (public.can_edit_task(task_id) and public.can_view_task(blocked_by));
create policy ttl_select on public.task_time_logs for select using (public.is_hr(company_id) or public.can_view_task(task_id));
create policy ttl_write on public.task_time_logs for all using (employee_id = public.my_employee_id(company_id))
  with check (employee_id = public.my_employee_id(company_id) and public.can_view_task(task_id));
create policy tt_select on public.task_templates for select using (public.is_member(company_id));
create policy tt_write on public.task_templates for all using (public.has_role(company_id, array['owner','company_admin','hr','manager']))
  with check (public.has_role(company_id, array['owner','company_admin','hr','manager']));

-- ===========================================================================
-- Chat: reply / forward / pin / star, admin controls
-- ===========================================================================
alter table public.messages add column if not exists reply_to_id uuid references public.messages(id) on delete set null;
alter table public.messages add column if not exists forwarded boolean not null default false;
alter table public.messages add column if not exists pinned_at timestamptz;
alter table public.messages add column if not exists pinned_by uuid;
alter table public.companies add column if not exists chat_cross_dept boolean not null default true;
alter table public.companies add column if not exists chat_retention_days integer not null default 730 check (chat_retention_days >= 30);
alter table public.companies add column if not exists payslip_password boolean not null default false;

create table public.message_stars (
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  message_id  uuid not null references public.messages(id) on delete cascade,
  company_id  uuid not null references public.companies(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (user_id, message_id)
);
alter table public.message_stars enable row level security;
create policy ms_own on public.message_stars for all using (user_id = auth.uid()) with check (user_id = auth.uid() and public.is_member(company_id));

-- senders edit / delete their own messages; any member may pin or unpin
create or replace function public.messages_before_update()
returns trigger language plpgsql as $$
begin
  if auth.uid() is null then return new; end if;   -- system jobs
  if (to_jsonb(new) - array['pinned_at','pinned_by','search']) = (to_jsonb(old) - array['pinned_at','pinned_by','search']) then
    if not public.is_conversation_member(old.conversation_id) then raise exception 'not allowed' using errcode = '42501'; end if;
    new.pinned_by := case when new.pinned_at is null then null else auth.uid() end;
    return new;
  end if;
  if old.sender_id <> auth.uid() then raise exception 'You can only change your own messages' using errcode = '42501'; end if;
  if new.body is distinct from old.body then
    if old.created_at < now() - interval '15 minutes' then raise exception 'Messages can be edited for 15 minutes'; end if;
    new.edited_at := now();
  end if;
  if new.deleted and not old.deleted then
    new.body := null; new.attachment_path := null; new.attachment_name := null; new.pinned_at := null;
  end if;
  new.conversation_id := old.conversation_id; new.sender_id := old.sender_id; new.created_at := old.created_at;
  return new;
end $$;

drop policy if exists msg_update on public.messages;
create policy msg_update on public.messages for update using (public.is_conversation_member(conversation_id))
  with check (public.is_conversation_member(conversation_id));

-- COMMS-12: optionally keep 1:1 chat inside departments (HR and admins are exempt)
create or replace function public.open_dm(p_company uuid, p_other uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_key text; v_id uuid; v_cross boolean; v_mine uuid; v_theirs uuid;
begin
  if not public.is_member(p_company) then raise exception 'not allowed' using errcode = '42501'; end if;
  if not exists (select 1 from public.company_members where company_id = p_company and user_id = p_other and active) then
    raise exception 'That person is not in this company';
  end if;
  select chat_cross_dept into v_cross from public.companies where id = p_company;
  if not v_cross and not public.is_hr(p_company)
     and not exists (select 1 from public.company_members where company_id = p_company and user_id = p_other and role in ('owner','company_admin','hr')) then
    select department_id into v_mine from public.employees where company_id = p_company and user_id = auth.uid();
    select department_id into v_theirs from public.employees where company_id = p_company and user_id = p_other;
    if v_mine is distinct from v_theirs then raise exception 'Direct messages across departments are turned off in this company'; end if;
  end if;
  v_key := least(auth.uid()::text, p_other::text) || ':' || greatest(auth.uid()::text, p_other::text);
  select id into v_id from public.conversations where company_id = p_company and dm_key = v_key;
  if v_id is null then
    insert into public.conversations (company_id, kind, dm_key) values (p_company, 'dm', v_key) returning id into v_id;
    insert into public.conversation_members (conversation_id, user_id, company_id)
    select v_id, u, p_company from unnest(array[auth.uid(), p_other]) u on conflict do nothing;
  end if;
  return v_id;
end $$;

-- compliance export of any conversation, for the owner / company admin only (logged)
create or replace function public.export_conversation(p_conv uuid)
returns table (sent_at timestamptz, sender text, body text, attachment text, deleted boolean)
language plpgsql security definer set search_path = public as $$
declare v_company uuid;
begin
  select company_id into v_company from public.conversations where id = p_conv;
  if v_company is null or not public.has_role(v_company, array['owner','company_admin']) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  insert into public.audit_log (company_id, user_id, table_name, record_id, action, ip)
  values (v_company, auth.uid(), 'conversations', p_conv::text, 'export', public.request_ip());
  return query
    select m.created_at, coalesce(p.full_name, p.email, m.sender_id::text), m.body, m.attachment_name, m.deleted
    from public.messages m left join public.profiles p on p.id = m.sender_id
    where m.conversation_id = p_conv order by m.created_at;
end $$;

create or replace function public.purge_chat()
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  delete from public.messages m using public.companies c
  where c.id = m.company_id and m.created_at < now() - make_interval(days => c.chat_retention_days);
  get diagnostics n = row_count;
  return n;
end $$;

-- ===========================================================================
-- SAL-04 tax regime and investment declarations
-- ===========================================================================
alter table public.statutory_settings add column if not exists tds_slabs_old jsonb not null
  default '[{"upto":250000,"rate":0},{"upto":500000,"rate":5},{"upto":1000000,"rate":20},{"upto":null,"rate":30}]';
alter table public.statutory_settings add column if not exists standard_deduction_old numeric not null default 50000;
alter table public.statutory_settings add column if not exists rebate_limit_old numeric not null default 500000;
alter table public.statutory_settings add column if not exists rebate_max_old numeric not null default 12500;

create table public.tax_declarations (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete cascade,
  employee_id     uuid not null references public.employees(id) on delete cascade,
  fy_start_year   integer not null,
  regime          text not null default 'new' check (regime in ('new','old')),
  items           jsonb not null default '{}',     -- {"80C":150000,"80D":25000,"HRA":120000,"other":0}
  declared_total  numeric not null default 0,
  verified        boolean not null default false,
  verified_by     uuid,
  updated_at      timestamptz not null default now(),
  unique (employee_id, fy_start_year)
);
alter table public.tax_declarations enable row level security;
create policy td_select on public.tax_declarations for select using (public.is_hr(company_id) or employee_id = public.my_employee_id(company_id));
create policy td_insert on public.tax_declarations for insert with check (public.is_hr(company_id) or employee_id = public.my_employee_id(company_id));
create policy td_update on public.tax_declarations for update
  using (public.is_hr(company_id) or (employee_id = public.my_employee_id(company_id) and not verified))
  with check (public.is_hr(company_id) or (employee_id = public.my_employee_id(company_id) and not verified));

create or replace function public.tax_declarations_before_write()
returns trigger language plpgsql as $$
begin
  new.declared_total := coalesce((select sum(greatest(0, value::numeric)) from jsonb_each_text(new.items)), 0);
  new.updated_at := now();
  if not public.is_hr(new.company_id) and auth.uid() is not null then new.verified := false; end if;
  return new;
end $$;
create trigger tax_declarations_before_write before insert or update on public.tax_declarations
  for each row execute function public.tax_declarations_before_write();
create trigger tax_declarations_audit after insert or update on public.tax_declarations
  for each row execute function public.audit_trigger();

-- the regime's slabs, standard deduction and rebate, as a settings row annual_tax() understands
create or replace function public.regime_settings(p_settings public.statutory_settings, p_regime text)
returns public.statutory_settings language plpgsql immutable as $$
declare s public.statutory_settings := p_settings;
begin
  if p_regime = 'old' then
    s.tds_slabs := p_settings.tds_slabs_old; s.standard_deduction := p_settings.standard_deduction_old;
    s.rebate_limit := p_settings.rebate_limit_old; s.rebate_max := p_settings.rebate_max_old;
  end if;
  return s;
end $$;

-- ===========================================================================
-- Saved filters (COM-14), scheduled reports (X-04), data requests (NFR-06)
-- ===========================================================================
create table public.saved_filters (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  company_id  uuid not null references public.companies(id) on delete cascade,
  page        text not null,
  name        text not null,
  query       text not null,
  created_at  timestamptz not null default now()
);
alter table public.saved_filters enable row level security;
create policy sf_own on public.saved_filters for all using (user_id = auth.uid()) with check (user_id = auth.uid() and public.is_member(company_id));

create table public.report_schedules (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  report       text not null check (report in ('attendance','employees','projects')),
  frequency    text not null check (frequency in ('daily','weekly','monthly')),
  recipients   text[] not null,
  last_sent_at timestamptz,
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now()
);
alter table public.report_schedules enable row level security;
create policy rs_hr on public.report_schedules for all using (public.is_hr(company_id)) with check (public.is_hr(company_id));

create table public.data_requests (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind         text not null check (kind in ('export','delete')),
  note         text,
  status       text not null default 'open' check (status in ('open','done','rejected')),
  resolved_by  uuid,
  resolved_at  timestamptz,
  created_at   timestamptz not null default now()
);
alter table public.data_requests enable row level security;
create policy dr_select on public.data_requests for select using (user_id = auth.uid() or public.has_role(company_id, array['owner','company_admin']));
create policy dr_insert on public.data_requests for insert with check (user_id = auth.uid() and public.is_member(company_id));
create policy dr_update on public.data_requests for update using (public.has_role(company_id, array['owner','company_admin']))
  with check (public.has_role(company_id, array['owner','company_admin']));

create or replace function public.data_requests_after_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.notify_roles(new.company_id, array['owner','company_admin'],
    case new.kind when 'delete' then 'Data deletion request' else 'Data export request' end,
    'An employee asked for their personal data to be ' || case new.kind when 'delete' then 'deleted' else 'exported' end, '/settings?tab=privacy');
  return null;
end $$;
create trigger data_requests_after_insert after insert on public.data_requests for each row execute function public.data_requests_after_insert();

-- NFR-09: archived companies are purged 90 days after archiving
create or replace function public.purge_archived_companies()
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  delete from public.companies where status = 'archived' and archived_at < now() - interval '90 days';
  get diagnostics n = row_count;
  return n;
end $$;

do $$
begin
  perform cron.schedule('purge-chat', '15 2 * * *', 'select public.purge_chat()');
  perform cron.schedule('purge-archived-companies', '30 2 * * *', 'select public.purge_archived_companies()');
exception when others then
  raise notice 'pg_cron unavailable: %', sqlerrm;
end $$;

revoke execute on function public.purge_chat() from public, anon, authenticated;
revoke execute on function public.purge_archived_companies() from public, anon, authenticated;
revoke execute on function public.notify(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.notify_roles(uuid, text[], text, text, text) from public, anon, authenticated;


-- ===========================================================================
-- run_payroll with the SAL-04 regime-aware TDS step (everything else unchanged from 0006)
-- ===========================================================================
create or replace function public.run_payroll(p_company uuid, p_month date)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  c            public.companies%rowtype;
  st           public.statutory_settings%rowtype;
  e            record;
  v_month      date := date_trunc('month', p_month)::date;
  v_end        date;
  v_dim        integer;
  v_salary_days numeric;
  v_run        uuid;
  v_version    integer;
  v_prev_run   uuid;
  -- per employee
  v_ws date; v_we date; v_window integer;
  v_days       date[]; v_vals numeric[]; v_stats text[];
  d            date; i integer; j integer; k integer;
  a            public.daily_attendance%rowtype;
  v_val        numeric; v_paid boolean;
  v_payable    numeric; v_late integer; v_ot_min integer;
  v_ratio      numeric;
  ctc_old      public.employee_ctc%rowtype; ctc_new public.employee_ctc%rowtype;
  v_w_old      numeric; v_monthly numeric; v_day_value numeric; v_shift_hours numeric;
  comp         record;
  v_slip       uuid;
  v_earned     numeric; v_pf_wage numeric; v_esi_wage numeric; v_taxable numeric; v_basic_full numeric;
  v_ot_amt     numeric; v_bonus numeric; v_incent numeric; v_reimb numeric; v_onetime numeric;
  v_arrears    numeric; v_arrear_ids uuid[]; ar record; v_frac numeric;
  v_encash     numeric; v_gratuity numeric; v_years numeric;
  v_pf numeric; v_esi numeric; v_pt numeric; v_lwf numeric; v_tds numeric;
  v_er_pf numeric; v_er_esi numeric;
  v_fy_start   date; v_months_left integer; v_ytd_taxable numeric; v_ytd_tds numeric; v_full_taxable numeric;
  v_loans      jsonb; v_loan_total numeric; v_recov_prev numeric;
  v_gross_r    numeric; v_stat_r numeric; v_avail numeric; v_other_need numeric; v_other_applied numeric;
  v_ded_r      numeric; v_net numeric; v_carry numeric;
  v_slab       jsonb; v_pt_base numeric;
  v_count integer := 0; v_tot_gross numeric := 0; v_tot_ded numeric := 0; v_tot_net numeric := 0;
  v_warnings   jsonb;
  v_sort       integer;
  v_decl       public.tax_declarations%rowtype;
  v_st         public.statutory_settings%rowtype;
begin
  if not public.is_hr(p_company) then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into c from public.companies where id = p_company;
  select * into st from public.statutory_settings where company_id = p_company;
  if not found then raise exception 'Statutory settings are missing for this company'; end if;

  -- SAL-22: payroll only on a locked attendance month
  if not public.is_month_locked(p_company, v_month) then
    raise exception 'Lock attendance for % before running payroll', to_char(v_month, 'Mon YYYY');
  end if;
  if exists (select 1 from public.payroll_runs where company_id = p_company and month = v_month and status = 'locked') then
    raise exception 'Payroll for % is locked — reopen it first', to_char(v_month, 'Mon YYYY');
  end if;

  v_end := (v_month + interval '1 month - 1 day')::date;
  v_dim := extract(day from v_end)::int;
  v_salary_days := case c.salary_days_basis when '30' then 30 when '26' then 26 else v_dim end;

  select id into v_prev_run from public.payroll_runs where company_id = p_company and month = v_month
    order by version desc limit 1;
  update public.payroll_runs set status = 'superseded' where company_id = p_company and month = v_month and status = 'draft';
  select coalesce(max(version), 0) + 1 into v_version from public.payroll_runs where company_id = p_company and month = v_month;
  v_warnings := public.payroll_precheck(p_company, v_month);

  insert into public.payroll_runs (company_id, month, version, status, ran_by, warnings)
  values (p_company, v_month, v_version, 'draft', auth.uid(), v_warnings) returning id into v_run;

  -- financial year bounds for TDS
  v_fy_start := make_date(case when extract(month from v_month) >= c.fy_start_month then extract(year from v_month)::int
                               else extract(year from v_month)::int - 1 end, c.fy_start_month, 1);

  for e in
    select emp.*, coalesce(sh.full_day_hours, 8) as shift_hours
    from public.employees emp left join public.shifts sh on sh.id = emp.shift_id
    where emp.company_id = p_company and emp.date_of_joining <= v_end
      and (emp.last_working_day is null or emp.last_working_day >= v_month)
      and exists (select 1 from public.employee_ctc x where x.employee_id = emp.id and x.effective_from <= v_end)
    order by emp.emp_code
  loop
    -- ---- Step 1: payable and LOP days from locked attendance (SAL-05/17/23) ----
    v_ws := greatest(v_month, e.date_of_joining);
    v_we := least(v_end, coalesce(e.last_working_day, v_end));
    v_window := v_we - v_ws + 1;
    v_days := '{}'; v_vals := '{}'; v_stats := '{}';
    v_late := 0; v_ot_min := 0;
    for d in select generate_series(v_ws, v_we, interval '1 day')::date loop
      select * into a from public.daily_attendance where employee_id = e.id and date = d;
      if not found then
        a.status := 'absent'; a.late := false; a.ot_approved_minutes := 0; a.leave_type_id := null;
        a.leave_half := false; a.half_present := false;
      end if;
      if a.status = 'on_leave' then
        select lt.paid into v_paid from public.leave_types lt where lt.id = a.leave_type_id;
        v_val := (case when coalesce(v_paid, false) then (case when a.leave_half then 0.5 else 1 end) else 0 end)
               + (case when a.leave_half and a.half_present then 0.5 else 0 end);
      else
        v_val := coalesce((c.payable_map ->> a.status)::numeric, 0);
      end if;
      v_days := v_days || d; v_vals := v_vals || v_val; v_stats := v_stats || a.status;
      if a.late then v_late := v_late + 1; end if;
      v_ot_min := v_ot_min + coalesce(a.ot_approved_minutes, 0);
    end loop;

    -- sandwich rule (SAL-19): an off day between two LOP days is unpaid when the company says so
    if not c.sandwich_paid then
      for i in 1 .. coalesce(array_length(v_days, 1), 0) loop
        if v_stats[i] in ('holiday','weekly_off') then
          j := i - 1; while j >= 1 and v_stats[j] in ('holiday','weekly_off') loop j := j - 1; end loop;
          k := i + 1; while k <= array_length(v_days, 1) and v_stats[k] in ('holiday','weekly_off') loop k := k + 1; end loop;
          if j >= 1 and k <= array_length(v_days, 1) and v_vals[j] = 0 and v_vals[k] = 0 then
            v_vals[i] := 0;
          end if;
        end if;
      end loop;
    end if;

    v_payable := 0;
    for i in 1 .. coalesce(array_length(v_vals, 1), 0) loop v_payable := v_payable + v_vals[i]; end loop;

    -- ---- Step 2: proration ratio, capped at 1.0 (SAL-18) ----
    v_ratio := least(v_payable / v_salary_days, 1);

    -- salary in force; a mid-month revision is weighted by its effective date (SAL-25)
    select * into ctc_old from public.employee_ctc where employee_id = e.id and effective_from <= v_month
      order by effective_from desc limit 1;
    select * into ctc_new from public.employee_ctc where employee_id = e.id and effective_from > v_month
      and effective_from <= v_end order by effective_from desc limit 1;
    if ctc_old.id is null then ctc_old := ctc_new; ctc_new := null; end if;
    if ctc_new.id is not null then
      v_w_old := (ctc_new.effective_from - v_month)::numeric / v_dim;
    else
      v_w_old := 1;
    end if;

    create temp table if not exists _comp (code text, name text, full_amount numeric, taxable boolean, pf boolean, esi boolean, sort integer) on commit drop;
    delete from _comp;
    insert into _comp
    select coalesce(o.code, n.code), coalesce(o.name, n.name),
           coalesce(o.amount, 0) * v_w_old + coalesce(n.amount, 0) * (1 - v_w_old),
           coalesce(o.taxable, n.taxable), coalesce(o.pf, n.pf), coalesce(o.esi, n.esi), coalesce(o.sort, n.sort)
    from public.structure_amounts(ctc_old.structure_id, ctc_old.annual_ctc / 12) o
    full outer join (select * from public.structure_amounts(ctc_new.structure_id, ctc_new.annual_ctc / 12)
                     where ctc_new.id is not null) n on n.code = o.code;

    select coalesce(sum(full_amount), 0) into v_monthly from _comp;
    select coalesce(sum(full_amount) filter (where upper(code) = 'BASIC'), 0) into v_basic_full from _comp;
    v_day_value := v_monthly / v_salary_days;

    insert into public.payslips (run_id, company_id, employee_id, month, salary_days, window_days, payable_days,
        lop_days, late_marks, ot_hours, ratio, monthly_gross, day_value, earned_gross, gross_payable, total_deductions, net_pay)
    values (v_run, p_company, e.id, v_month, v_salary_days, v_window, v_payable, v_window - v_payable, v_late,
        round(v_ot_min / 60.0, 2), v_ratio, v_monthly, v_day_value, 0, 0, 0, 0)
    returning id into v_slip;

    -- every earning component prorated by the same ratio
    v_earned := 0; v_pf_wage := 0; v_esi_wage := 0; v_taxable := 0; v_sort := 0;
    for comp in select * from _comp order by sort loop
      insert into public.payslip_lines (payslip_id, company_id, code, name, kind, full_amount, amount, sort)
      values (v_slip, p_company, comp.code, comp.name, 'earning', comp.full_amount, round(comp.full_amount * v_ratio), comp.sort);
      v_earned := v_earned + comp.full_amount * v_ratio;
      if comp.pf then v_pf_wage := v_pf_wage + comp.full_amount * v_ratio; end if;
      if comp.esi then v_esi_wage := v_esi_wage + comp.full_amount * v_ratio; end if;
      if comp.taxable then v_taxable := v_taxable + comp.full_amount * v_ratio; end if;
      v_sort := greatest(v_sort, comp.sort);
    end loop;

    -- ---- Step 3: arrears, overtime, other earnings, reimbursements ----
    v_arrears := 0; v_arrear_ids := '{}';
    for ar in select x.* from public.employee_ctc x
              where x.employee_id = e.id and not x.arrears_settled and x.effective_from < v_month loop
      for comp in select fp.month, fp.ratio, fp.monthly_gross from public.final_payslips fp
                  where fp.employee_id = e.id and fp.month >= date_trunc('month', ar.effective_from) and fp.month < v_month loop
        v_frac := case when ar.effective_from > comp.month
                       then ((comp.month + interval '1 month')::date - ar.effective_from)::numeric
                            / extract(day from (comp.month + interval '1 month - 1 day'))
                       else 1 end;
        v_arrears := v_arrears + greatest(0, (ar.annual_ctc / 12 - comp.monthly_gross) * comp.ratio * v_frac);
      end loop;
      v_arrear_ids := v_arrear_ids || ar.id;
    end loop;
    if v_arrears > 0 then
      v_sort := v_sort + 1;
      insert into public.payslip_lines (payslip_id, company_id, code, name, kind, amount, sort)
      values (v_slip, p_company, 'ARREARS', 'Arrears (salary revision)', 'earning', round(v_arrears), v_sort);
      v_taxable := v_taxable + v_arrears; v_esi_wage := v_esi_wage + v_arrears;
    end if;

    v_ot_amt := (v_ot_min / 60.0) * v_day_value / e.shift_hours * c.ot_multiplier;
    if v_ot_amt > 0 then
      v_sort := v_sort + 1;
      insert into public.payslip_lines (payslip_id, company_id, code, name, kind, amount, sort)
      values (v_slip, p_company, 'OT', 'Overtime ' || round(v_ot_min / 60.0, 2) || ' h', 'earning', round(v_ot_amt), v_sort);
      v_taxable := v_taxable + v_ot_amt; v_esi_wage := v_esi_wage + v_ot_amt;
    end if;

    select coalesce(sum(amount) filter (where kind = 'bonus'), 0),
           coalesce(sum(amount) filter (where kind = 'incentive'), 0),
           coalesce(sum(amount) filter (where kind = 'reimbursement'), 0),
           coalesce(sum(amount) filter (where kind = 'deduction'), 0)
      into v_bonus, v_incent, v_reimb, v_onetime
    from public.variable_inputs where employee_id = e.id and month = v_month;
    if v_bonus > 0 then
      v_sort := v_sort + 1;
      insert into public.payslip_lines (payslip_id, company_id, code, name, kind, amount, sort)
      values (v_slip, p_company, 'BONUS', 'Bonus', 'earning', round(v_bonus), v_sort);
      v_taxable := v_taxable + v_bonus;
    end if;
    if v_incent > 0 then
      v_sort := v_sort + 1;
      insert into public.payslip_lines (payslip_id, company_id, code, name, kind, amount, sort)
      values (v_slip, p_company, 'INCENTIVE', 'Incentive', 'earning', round(v_incent), v_sort);
      v_taxable := v_taxable + v_incent; v_esi_wage := v_esi_wage + v_incent;
    end if;

    -- exit in this month: leave encashment and gratuity (SAL-11)
    v_encash := 0; v_gratuity := 0;
    if e.last_working_day is not null and e.last_working_day <= v_end then
      select coalesce(sum(greatest(0, opening + accrued - used)), 0) * v_day_value into v_encash
      from public.leave_balance_view where employee_id = e.id and encashable
        and year = extract(year from e.last_working_day)::int;
      if v_encash > 0 then
        v_sort := v_sort + 1;
        insert into public.payslip_lines (payslip_id, company_id, code, name, kind, amount, sort)
        values (v_slip, p_company, 'ENCASH', 'Leave encashment', 'earning', round(v_encash), v_sort);
        v_taxable := v_taxable + v_encash;
      end if;
      v_years := (e.last_working_day - e.date_of_joining)::numeric / 365.25;
      if st.gratuity_enabled and v_years >= 5 then
        v_gratuity := 15.0 / 26 * v_basic_full * round(v_years);
        v_sort := v_sort + 1;
        insert into public.payslip_lines (payslip_id, company_id, code, name, kind, amount, sort)
        values (v_slip, p_company, 'GRATUITY', 'Gratuity', 'earning', round(v_gratuity), v_sort);
      end if;
    end if;

    if v_reimb > 0 then  -- non-taxable, excluded from PF / ESI / TDS
      v_sort := v_sort + 1;
      insert into public.payslip_lines (payslip_id, company_id, code, name, kind, amount, sort)
      values (v_slip, p_company, 'REIMB', 'Reimbursements (non-taxable)', 'earning', round(v_reimb), v_sort);
    end if;

    -- ---- Step 4: statutory deductions on the earned wage ----
    v_pf := 0; v_esi := 0; v_pt := 0; v_lwf := 0; v_er_pf := 0; v_er_esi := 0;
    if st.pf_enabled and v_pf_wage > 0 then
      if st.pf_cap_at_ceiling then v_pf_wage := least(v_pf_wage, st.pf_wage_ceiling); end if;
      v_pf := v_pf_wage * st.pf_employee_rate / 100;
      v_er_pf := v_pf_wage * st.pf_employer_rate / 100;
    end if;
    if st.esi_enabled and v_esi_wage > 0 and v_esi_wage <= st.esi_wage_ceiling then
      v_esi := v_esi_wage * st.esi_employee_rate / 100;
      v_er_esi := v_esi_wage * st.esi_employer_rate / 100;
    end if;
    if st.pt_enabled then
      v_pt_base := v_taxable;
      for v_slab in select * from jsonb_array_elements(st.pt_slabs) loop
        if v_pt_base >= (v_slab ->> 'min')::numeric
           and (v_slab ->> 'max' is null or v_pt_base <= (v_slab ->> 'max')::numeric) then
          v_pt := case when extract(month from v_month) = 2 and v_slab ? 'feb_amount'
                       then (v_slab ->> 'feb_amount')::numeric else (v_slab ->> 'amount')::numeric end;
          exit;
        end if;
      end loop;
    end if;
    if st.lwf_enabled and extract(month from v_month)::int = any(st.lwf_months) then
      v_lwf := st.lwf_employee;
    end if;

    -- ---- Step 5: TDS on projected annual taxable income less tax already deducted ----
    v_tds := 0;
    if st.tds_enabled then
      select coalesce(sum(fp.taxable_income), 0) into v_ytd_taxable from public.final_payslips fp
        where fp.employee_id = e.id and fp.month >= v_fy_start and fp.month < v_month;
      select coalesce(sum(l.amount), 0) into v_ytd_tds from public.final_payslips fp
        join public.payslip_lines l on l.payslip_id = fp.id and l.code = 'TDS'
        where fp.employee_id = e.id and fp.month >= v_fy_start and fp.month < v_month;
      v_months_left := (extract(year from age((v_fy_start + interval '1 year')::date, v_month)) * 12
                        + extract(month from age((v_fy_start + interval '1 year')::date, v_month)))::int;
      if e.last_working_day is not null and e.last_working_day <= v_end then v_months_left := 1; end if;
      select coalesce(sum(full_amount) filter (where taxable), 0) into v_full_taxable from _comp;
      -- SAL-04: the employee's regime; under the old regime declared investments reduce taxable income
      select * into v_decl from public.tax_declarations
        where employee_id = e.id and fy_start_year = extract(year from v_fy_start)::int;
      v_st := public.regime_settings(st, coalesce(v_decl.regime, 'new'));
      v_tds := greatest(0, (public.annual_tax(v_st, v_ytd_taxable + v_taxable + v_full_taxable * (v_months_left - 1)
                                           - v_st.standard_deduction
                                           - case when v_decl.regime = 'old' then coalesce(v_decl.declared_total, 0) else 0 end)
                            - v_ytd_tds) / greatest(v_months_left, 1));
    end if;

    -- ---- Step 6: other deductions — loan / advance EMI, one-time deductions, earlier recoveries ----
    select coalesce(jsonb_object_agg(id, least(emi, balance)), '{}'), coalesce(sum(least(emi, balance)), 0)
      into v_loans, v_loan_total
    from public.loans where employee_id = e.id and status = 'active' and balance > 0 and start_month <= v_month;
    select coalesce(amount, 0) into v_recov_prev from public.recovery_balances where employee_id = e.id;
    v_recov_prev := coalesce(v_recov_prev, 0);

    -- ---- Steps 7–8: rounding per line, net never below zero, shortfall carried forward ----
    select coalesce(sum(amount), 0) into v_gross_r from public.payslip_lines where payslip_id = v_slip and kind = 'earning';
    v_pf := round(v_pf); v_esi := round(v_esi); v_pt := round(v_pt); v_lwf := round(v_lwf);
    v_tds := round(least(v_tds, greatest(0, v_gross_r - v_pf - v_esi - v_pt - v_lwf)));
    v_stat_r := v_pf + v_esi + v_pt + v_lwf + v_tds;
    v_avail := greatest(0, v_gross_r - v_stat_r);
    v_other_need := round(v_loan_total) + round(v_onetime) + round(v_recov_prev);
    v_other_applied := least(v_other_need, v_avail);
    v_carry := v_other_need - v_other_applied;

    v_sort := 100;
    if v_pf > 0 then insert into public.payslip_lines (payslip_id, company_id, code, name, kind, amount, sort)
      values (v_slip, p_company, 'PF', 'Provident Fund', 'deduction', v_pf, 101); end if;
    if v_esi > 0 then insert into public.payslip_lines (payslip_id, company_id, code, name, kind, amount, sort)
      values (v_slip, p_company, 'ESI', 'ESI', 'deduction', v_esi, 102); end if;
    if v_pt > 0 then insert into public.payslip_lines (payslip_id, company_id, code, name, kind, amount, sort)
      values (v_slip, p_company, 'PT', 'Professional Tax', 'deduction', v_pt, 103); end if;
    if v_lwf > 0 then insert into public.payslip_lines (payslip_id, company_id, code, name, kind, amount, sort)
      values (v_slip, p_company, 'LWF', 'Labour Welfare Fund', 'deduction', v_lwf, 104); end if;
    if v_tds > 0 then insert into public.payslip_lines (payslip_id, company_id, code, name, kind, amount, sort)
      values (v_slip, p_company, 'TDS', 'Income Tax (TDS)', 'deduction', v_tds, 105); end if;
    if v_other_applied > 0 then
      insert into public.payslip_lines (payslip_id, company_id, code, name, kind, amount, sort)
      values (v_slip, p_company, 'RECOVERY', 'Loan / advance EMI and recoveries', 'deduction', v_other_applied, 110);
    end if;

    v_ded_r := v_stat_r + v_other_applied;
    v_net := v_gross_r - v_ded_r;

    update public.payslips set
      earned_gross = v_earned, taxable_income = v_taxable, gross_payable = v_gross_r, total_deductions = v_ded_r,
      net_pay = v_net, employer_pf = round(v_er_pf), employer_esi = round(v_er_esi),
      recovery_prev = v_recov_prev, recovery_carry = v_carry, loan_applied = v_loans, arrears_ctc_ids = v_arrear_ids
    where id = v_slip;

    v_count := v_count + 1; v_tot_gross := v_tot_gross + v_gross_r; v_tot_ded := v_tot_ded + v_ded_r; v_tot_net := v_tot_net + v_net;
  end loop;

  update public.payroll_runs set employee_count = v_count, total_gross = v_tot_gross, total_deductions = v_tot_ded,
    total_net = v_tot_net,
    warnings = v_warnings || coalesce((select jsonb_agg(jsonb_build_object('level','warning','code','recovery_carry',
                 'employee_id', p.employee_id, 'message', 'Net pay capped at zero; ₹' || p.recovery_carry || ' carried forward'))
               from public.payslips p where p.run_id = v_run and p.recovery_carry > 0), '[]'),
    changes = coalesce((select jsonb_agg(jsonb_build_object('employee_id', n.employee_id, 'old_net', o.net_pay, 'new_net', n.net_pay))
               from public.payslips n left join public.payslips o on o.run_id = v_prev_run and o.employee_id = n.employee_id
               where n.run_id = v_run and v_prev_run is not null and o.net_pay is distinct from n.net_pay), '[]')
  where id = v_run;
  return v_run;
end $$;

-- ===========================================================================
-- NFR-09: raw punches older than 13 months are archived to Storage (scripts/archive-punches.ts)
-- and then removed here, keeping the free-tier database small. Daily attendance stays.
-- ===========================================================================
insert into storage.buckets (id, name, public) values ('archives', 'archives', false) on conflict (id) do nothing;

create or replace function public.purge_punches_before(p_company uuid, p_before timestamptz)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if p_before > now() - interval '13 months' then raise exception 'Only punches older than 13 months can be purged'; end if;
  perform set_config('app.allow_punch_purge', 'on', true);
  delete from public.punches_raw where company_id = p_company and punched_at < p_before;
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.purge_punches_before(uuid, timestamptz) from public, anon, authenticated;

-- ===========================================================================
-- COMMS-07: a new chat message notifies the other members (kind 'chat') unless they muted the chat.
-- These rows drive push only; the in-app bell skips them because chat has its own unread counts.
-- ===========================================================================
create or replace function public.messages_notify()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_name text; v_conv public.conversations%rowtype;
begin
  select * into v_conv from public.conversations where id = new.conversation_id;
  select coalesce(full_name, email) into v_name from public.profiles where id = new.sender_id;
  insert into public.notifications (user_id, company_id, title, body, link, kind)
  select cm.user_id, new.company_id,
         case when v_conv.kind = 'dm' then coalesce(v_name, 'New message') else coalesce(v_conv.name, 'Group') || ' · ' || coalesce(v_name, '') end,
         coalesce(left(new.body, 120), '📎 ' || coalesce(new.attachment_name, 'Attachment')),
         '/chat/' || new.conversation_id, 'chat'
  from public.conversation_members cm
  where cm.conversation_id = new.conversation_id and cm.user_id <> new.sender_id and not cm.muted;
  return null;
end $$;
create trigger messages_notify after insert on public.messages for each row execute function public.messages_notify();

-- chat notification rows are only a delivery vehicle: keep a week
create or replace function public.purge_chat()
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  delete from public.messages m using public.companies c
  where c.id = m.company_id and m.created_at < now() - make_interval(days => c.chat_retention_days);
  get diagnostics n = row_count;
  delete from public.notifications where kind = 'chat' and created_at < now() - interval '7 days';
  return n;
end $$;

-- ===========================================================================
-- EMP-07: remind HR 30 days before an employee document expires (once per document)
-- ===========================================================================
alter table public.employee_documents add column if not exists reminded_at timestamptz;

create or replace function public.document_expiry_reminders()
returns integer language plpgsql security definer set search_path = public as $$
declare r record; n integer := 0;
begin
  for r in update public.employee_documents d set reminded_at = now()
           where d.reminded_at is null and d.expiry_date is not null and d.expiry_date <= current_date + 30
           returning d.company_id, d.employee_id, d.name, d.expiry_date loop
    perform public.notify_roles(r.company_id, array['owner','company_admin','hr'], 'Document expiring',
      (select first_name || ' ' || coalesce(last_name, '') from public.employees where id = r.employee_id) || ': ' || r.name
        || ' expires ' || to_char(r.expiry_date, 'DD Mon YYYY'), '/employees/' || r.employee_id || '?tab=documents');
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.document_expiry_reminders() from public, anon, authenticated;

do $$
begin
  perform cron.schedule('document-expiry', '0 3 * * *', 'select public.document_expiry_reminders()');
exception when others then
  raise notice 'pg_cron unavailable: %', sqlerrm;
end $$;
