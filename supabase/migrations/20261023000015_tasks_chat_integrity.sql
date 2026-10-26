-- corpgroup.com · 0015 tasks and chat: trustworthy company_id, attachment paths, RLS re-asserted
--
-- Every task and chat table already has company_id and RLS (0007, 0008, 0011). Policies check the
-- user's rights on the *parent* row (the task or the conversation), but the child row's own
-- company_id was taken from the client. A user who belongs to two companies could therefore write
-- a task assignee, comment or chat message whose company_id differs from its parent's. These
-- triggers make company_id always equal the parent's and check that referenced people and rows
-- belong to the same company (NFR-04). Chat attachments must live in their conversation's folder
-- (COMMS-03), which is what the storage read policy relies on.

-- ---------------------------------------------------------------------------
-- RLS on (idempotent re-assertion)
-- ---------------------------------------------------------------------------
alter table public.tasks                enable row level security;
alter table public.task_assignees       enable row level security;
alter table public.task_comments        enable row level security;
alter table public.task_attachments     enable row level security;
alter table public.task_activity        enable row level security;
alter table public.task_checklist       enable row level security;
alter table public.task_dependencies    enable row level security;
alter table public.task_time_logs       enable row level security;
alter table public.task_templates       enable row level security;
alter table public.conversations        enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages             enable row level security;
alter table public.message_stars        enable row level security;

-- ---------------------------------------------------------------------------
-- Tasks
-- ---------------------------------------------------------------------------
create or replace function public.tasks_same_company()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.project_id is not null and not exists (select 1 from public.projects where id = new.project_id and company_id = new.company_id) then
    raise exception 'Project belongs to a different company' using errcode = '23503';
  end if;
  if new.parent_id is not null and not exists (select 1 from public.tasks where id = new.parent_id and company_id = new.company_id) then
    raise exception 'Parent task belongs to a different company' using errcode = '23503';
  end if;
  if tg_op = 'UPDATE' and new.company_id <> old.company_id then
    raise exception 'A task cannot move to another company' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists tasks_same_company on public.tasks;
create trigger tasks_same_company before insert or update of company_id, project_id, parent_id on public.tasks
  for each row execute function public.tasks_same_company();

-- child rows of a task take the task's company; referenced employees / tasks must be in it
create or replace function public.task_child_company()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_company uuid; v_row jsonb := to_jsonb(new);
begin
  select company_id into v_company from public.tasks where id = new.task_id;
  if v_company is null then raise exception 'Task not found' using errcode = '23503'; end if;
  new.company_id := v_company;
  if v_row ? 'employee_id' and (v_row ->> 'employee_id') is not null
     and not exists (select 1 from public.employees where id = (v_row ->> 'employee_id')::uuid and company_id = v_company) then
    raise exception 'Employee belongs to a different company' using errcode = '23503';
  end if;
  if v_row ? 'blocked_by'
     and not exists (select 1 from public.tasks where id = (v_row ->> 'blocked_by')::uuid and company_id = v_company) then
    raise exception 'Blocking task belongs to a different company' using errcode = '23503';
  end if;
  if v_row ? 'storage_path' and (v_row ->> 'storage_path') not like v_company::text || '/' || new.task_id::text || '/%' then
    raise exception 'Attachment must be stored under its task folder' using errcode = '23514';
  end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['task_assignees','task_comments','task_attachments','task_checklist','task_dependencies','task_time_logs'] loop
    execute format('drop trigger if exists %1$s_company on public.%1$s', t);
    execute format('create trigger %1$s_company before insert or update on public.%1$s for each row execute function public.task_child_company()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Chat
-- ---------------------------------------------------------------------------
-- members: company from the conversation; only active members of that company can join
create or replace function public.conversation_members_company()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_company uuid;
begin
  select company_id into v_company from public.conversations where id = new.conversation_id;
  if v_company is null then raise exception 'Conversation not found' using errcode = '23503'; end if;
  new.company_id := v_company;
  if not exists (select 1 from public.company_members where company_id = v_company and user_id = new.user_id and active) then
    raise exception 'Only members of this company can join its conversations' using errcode = '23503';
  end if;
  return new;
end $$;
drop trigger if exists conversation_members_company on public.conversation_members;
create trigger conversation_members_company before insert or update of conversation_id, user_id, company_id on public.conversation_members
  for each row execute function public.conversation_members_company();

-- messages: company from the conversation; attachments must sit in {company}/{conversation}/ (COMMS-03)
create or replace function public.messages_company_and_path()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_company uuid;
begin
  select company_id into v_company from public.conversations where id = new.conversation_id;
  if v_company is null then raise exception 'Conversation not found' using errcode = '23503'; end if;
  new.company_id := v_company;
  if new.attachment_path is not null then
    if new.attachment_path not like v_company::text || '/' || new.conversation_id::text || '/%' then
      raise exception 'Attachment must be stored in this conversation''s folder' using errcode = '23514';
    end if;
    if new.attachment_name is null then new.attachment_name := regexp_replace(new.attachment_path, '^.*/', ''); end if;
  end if;
  if new.reply_to_id is not null and not exists (select 1 from public.messages where id = new.reply_to_id and conversation_id = new.conversation_id) then
    raise exception 'A reply must quote a message from the same conversation' using errcode = '23503';
  end if;
  return new;
end $$;
drop trigger if exists messages_company_and_path on public.messages;
create trigger messages_company_and_path before insert or update of conversation_id, company_id, attachment_path, reply_to_id on public.messages
  for each row execute function public.messages_company_and_path();

-- stars: company from the starred message
create or replace function public.message_stars_company()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  select company_id into new.company_id from public.messages where id = new.message_id;
  if new.company_id is null then raise exception 'Message not found' using errcode = '23503'; end if;
  return new;
end $$;
drop trigger if exists message_stars_company on public.message_stars;
create trigger message_stars_company before insert or update on public.message_stars
  for each row execute function public.message_stars_company();

-- the 25 MB chat limit is enforced three times: in the browser, by the storage bucket
-- (file_size_limit, set again here in case the bucket pre-existed) and on the message row
update storage.buckets set file_size_limit = 26214400 where id = 'chat';

-- ---------------------------------------------------------------------------
-- Auto channels (COMMS-02) only for active company members, and synced again when membership
-- is granted — invite activation links the user to the employee before adding the membership.
-- ---------------------------------------------------------------------------
create or replace function public.sync_employee_channels(p_emp uuid)
returns void language plpgsql security definer set search_path = public as $$
declare e public.employees%rowtype; v_active boolean;
begin
  select * into e from public.employees where id = p_emp;
  if e.user_id is null then return; end if;
  -- leave department channels that are no longer theirs
  delete from public.conversation_members cm using public.conversations c
  where cm.conversation_id = c.id and c.kind = 'department' and cm.user_id = e.user_id and c.company_id = e.company_id
    and c.department_id is distinct from e.department_id;
  select coalesce(bool_or(active), false) into v_active from public.company_members where company_id = e.company_id and user_id = e.user_id;
  if e.status in ('exited','inactive') or not v_active then
    if e.status in ('exited','inactive') then
      delete from public.conversation_members where user_id = e.user_id and company_id = e.company_id;
    end if;
    return;
  end if;
  insert into public.conversation_members (conversation_id, user_id, company_id)
  select c.id, e.user_id, e.company_id from public.conversations c where c.department_id = e.department_id
  on conflict do nothing;
  insert into public.conversation_members (conversation_id, user_id, company_id)
  select c.id, e.user_id, e.company_id from public.conversations c
  join public.project_members pm on pm.project_id = c.project_id where pm.employee_id = e.id
  on conflict do nothing;
end $$;

create or replace function public.company_members_sync_channels()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_emp uuid;
begin
  if new.active and (tg_op = 'INSERT' or not old.active) then
    for v_emp in select id from public.employees where company_id = new.company_id and user_id = new.user_id loop
      perform public.sync_employee_channels(v_emp);
    end loop;
  end if;
  return null;
end $$;
drop trigger if exists company_members_sync_channels on public.company_members;
create trigger company_members_sync_channels after insert or update of active on public.company_members
  for each row execute function public.company_members_sync_channels();
