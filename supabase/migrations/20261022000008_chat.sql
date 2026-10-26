-- corpgroup.com · 0008 chat (COMMS, text only in the MVP) and announcements

create table public.conversations (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id) on delete cascade,
  kind           text not null check (kind in ('dm','group','department','project')),
  name           text,
  department_id  uuid references public.departments(id) on delete cascade,
  project_id     uuid references public.projects(id) on delete cascade,
  dm_key         text,                 -- sorted pair of user ids, keeps one DM per pair
  created_by     uuid default auth.uid(),
  created_at     timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  unique (company_id, dm_key),
  unique (department_id),
  unique (project_id)
);

create table public.conversation_members (
  conversation_id  uuid not null references public.conversations(id) on delete cascade,
  user_id          uuid not null references auth.users(id) on delete cascade,
  company_id       uuid not null references public.companies(id) on delete cascade,
  role             text not null default 'member' check (role in ('admin','member')),
  last_read_at     timestamptz not null default now(),
  muted            boolean not null default false,
  joined_at        timestamptz not null default now(),
  primary key (conversation_id, user_id)
);
create index on public.conversation_members (user_id);

create table public.messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references public.conversations(id) on delete cascade,
  company_id       uuid not null references public.companies(id) on delete cascade,
  sender_id        uuid not null default auth.uid(),
  body             text,
  attachment_path  text,
  attachment_name  text,
  attachment_type  text,
  attachment_size  bigint check (attachment_size is null or attachment_size <= 26214400),   -- 25 MB
  created_at       timestamptz not null default now(),
  edited_at        timestamptz,
  deleted          boolean not null default false,
  search           tsvector generated always as (to_tsvector('simple', coalesce(body, '') || ' ' || coalesce(attachment_name, ''))) stored,
  check (body is not null or attachment_path is not null)
);
create index on public.messages (conversation_id, created_at desc);
create index messages_search_idx on public.messages using gin (search);

create table public.announcements (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  title       text not null,
  body        text not null,
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now()
);

create table public.announcement_acks (
  announcement_id  uuid not null references public.announcements(id) on delete cascade,
  user_id          uuid not null default auth.uid(),
  company_id       uuid not null references public.companies(id) on delete cascade,
  acked_at         timestamptz not null default now(),
  primary key (announcement_id, user_id)
);

create or replace function public.is_conversation_member(cid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.conversation_members where conversation_id = cid and user_id = auth.uid());
$$;

-- open (or create) a DM with another user of the same company
create or replace function public.open_dm(p_company uuid, p_other uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_key text; v_id uuid;
begin
  if not public.is_member(p_company) then raise exception 'not allowed' using errcode = '42501'; end if;
  if not exists (select 1 from public.company_members where company_id = p_company and user_id = p_other and active) then
    raise exception 'That person is not in this company';
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

create or replace function public.create_group(p_company uuid, p_name text, p_users uuid[])
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.is_member(p_company) then raise exception 'not allowed' using errcode = '42501'; end if;
  insert into public.conversations (company_id, kind, name) values (p_company, 'group', p_name) returning id into v_id;
  insert into public.conversation_members (conversation_id, user_id, company_id, role)
  values (v_id, auth.uid(), p_company, 'admin');
  insert into public.conversation_members (conversation_id, user_id, company_id)
  select v_id, m.user_id, p_company from public.company_members m
  where m.company_id = p_company and m.active and m.user_id = any(p_users) and m.user_id <> auth.uid()
  on conflict do nothing;
  return v_id;
end $$;

-- auto channels per department and project (COMMS-02), kept in sync with membership
create or replace function public.sync_employee_channels(p_emp uuid)
returns void language plpgsql security definer set search_path = public as $$
declare e public.employees%rowtype;
begin
  select * into e from public.employees where id = p_emp;
  if e.user_id is null then return; end if;
  -- leave department channels that are no longer theirs
  delete from public.conversation_members cm using public.conversations c
  where cm.conversation_id = c.id and c.kind = 'department' and cm.user_id = e.user_id and c.company_id = e.company_id
    and c.department_id is distinct from e.department_id;
  if e.status in ('exited','inactive') then
    delete from public.conversation_members where user_id = e.user_id and company_id = e.company_id;
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

create or replace function public.departments_after_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.conversations (company_id, kind, name, department_id) values (new.company_id, 'department', new.name, new.id);
  return null;
end $$;
create trigger departments_after_insert after insert on public.departments
  for each row execute function public.departments_after_insert();

create or replace function public.projects_after_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_conv uuid;
begin
  insert into public.conversations (company_id, kind, name, project_id) values (new.company_id, 'project', new.name, new.id)
  returning id into v_conv;
  insert into public.conversation_members (conversation_id, user_id, company_id)
  select v_conv, e.user_id, new.company_id from public.employees e where e.id = new.manager_id and e.user_id is not null
  on conflict do nothing;
  return null;
end $$;
create trigger projects_after_insert after insert on public.projects
  for each row execute function public.projects_after_insert();

create or replace function public.project_members_after_write()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_user uuid;
begin
  if tg_op = 'INSERT' then
    perform public.sync_employee_channels(new.employee_id);
  else
    select user_id into v_user from public.employees where id = old.employee_id;
    delete from public.conversation_members cm using public.conversations c
    where cm.conversation_id = c.id and c.project_id = old.project_id and cm.user_id = v_user;
  end if;
  return null;
end $$;
create trigger project_members_after_write after insert or delete on public.project_members
  for each row execute function public.project_members_after_write();

create or replace function public.employees_sync_channels()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.user_id is distinct from old.user_id or new.department_id is distinct from old.department_id
     or new.status is distinct from old.status then
    perform public.sync_employee_channels(new.id);
  end if;
  return null;
end $$;
create trigger employees_sync_channels after insert or update on public.employees
  for each row execute function public.employees_sync_channels();

create or replace function public.messages_after_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.conversations set last_message_at = new.created_at where id = new.conversation_id;
  update public.conversation_members set last_read_at = new.created_at
  where conversation_id = new.conversation_id and user_id = new.sender_id;
  return null;
end $$;
create trigger messages_after_insert after insert on public.messages
  for each row execute function public.messages_after_insert();

-- edit within 15 minutes, delete for everyone (COMMS-05)
create or replace function public.messages_before_update()
returns trigger language plpgsql as $$
begin
  if old.sender_id <> auth.uid() then raise exception 'You can only change your own messages' using errcode = '42501'; end if;
  if new.body is distinct from old.body then
    if old.created_at < now() - interval '15 minutes' then raise exception 'Messages can be edited for 15 minutes'; end if;
    new.edited_at := now();
  end if;
  if new.deleted and not old.deleted then
    new.body := null; new.attachment_path := null; new.attachment_name := null;
  end if;
  new.conversation_id := old.conversation_id; new.sender_id := old.sender_id; new.created_at := old.created_at;
  return new;
end $$;
create trigger messages_before_update before update on public.messages
  for each row execute function public.messages_before_update();

create or replace function public.announcements_after_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.notify_roles(new.company_id, array['owner','company_admin','hr','manager','employee'],
    'Announcement: ' || new.title, left(new.body, 140), '/announcements');
  return null;
end $$;
create trigger announcements_after_insert after insert on public.announcements
  for each row execute function public.announcements_after_insert();

alter table public.conversations        enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages             enable row level security;
alter table public.announcements        enable row level security;
alter table public.announcement_acks    enable row level security;

create policy conv_select on public.conversations for select using (public.is_conversation_member(id));
create policy conv_update on public.conversations for update using (public.is_conversation_member(id) and kind = 'group')
  with check (public.is_conversation_member(id));
create policy cm_select on public.conversation_members for select using (public.is_conversation_member(conversation_id));
create policy cm_update_own on public.conversation_members for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy cm_insert_group on public.conversation_members for insert with check (
  exists (select 1 from public.conversations c where c.id = conversation_id and c.kind = 'group'
          and public.is_conversation_member(c.id))
  and exists (select 1 from public.company_members m where m.company_id = conversation_members.company_id
              and m.user_id = conversation_members.user_id and m.active));
create policy cm_leave on public.conversation_members for delete using (user_id = auth.uid());

create policy msg_select on public.messages for select using (public.is_conversation_member(conversation_id));
create policy msg_insert on public.messages for insert with check (
  public.is_conversation_member(conversation_id) and sender_id = auth.uid()
  and company_id = (select c.company_id from public.conversations c where c.id = conversation_id));
create policy msg_update on public.messages for update using (sender_id = auth.uid()) with check (sender_id = auth.uid());

create policy ann_select on public.announcements for select using (public.is_member(company_id));
create policy ann_insert on public.announcements for insert with check (public.is_hr(company_id));
create policy ann_delete on public.announcements for delete using (public.is_hr(company_id));
create policy ack_select on public.announcement_acks for select using (user_id = auth.uid() or public.is_hr(company_id));
create policy ack_insert on public.announcement_acks for insert with check (user_id = auth.uid() and public.is_member(company_id));
