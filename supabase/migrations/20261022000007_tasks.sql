-- corpgroup.com · 0007 tasks (TSK)

create table public.tasks (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  project_id    uuid references public.projects(id) on delete set null,
  title         text not null,
  description   text,
  status        text not null default 'todo',
  priority      text not null default 'medium' check (priority in ('low','medium','high','urgent')),
  due_at        timestamptz,
  labels        text[] not null default '{}',
  position      double precision not null default extract(epoch from now()),
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  completed_at  timestamptz,
  reminded_24h  boolean not null default false,
  reminded_overdue boolean not null default false
);
create index on public.tasks (company_id, status);
create index on public.tasks (project_id);

create table public.task_assignees (
  task_id      uuid not null references public.tasks(id) on delete cascade,
  employee_id  uuid not null references public.employees(id) on delete cascade,
  company_id   uuid not null references public.companies(id) on delete cascade,
  primary key (task_id, employee_id)
);
create index on public.task_assignees (employee_id);

create table public.task_comments (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references public.tasks(id) on delete cascade,
  company_id  uuid not null references public.companies(id) on delete cascade,
  author_id   uuid not null default auth.uid(),
  body        text not null,
  mentions    uuid[] not null default '{}',     -- employee ids
  created_at  timestamptz not null default now()
);

create table public.task_attachments (
  id            uuid primary key default gen_random_uuid(),
  task_id       uuid not null references public.tasks(id) on delete cascade,
  company_id    uuid not null references public.companies(id) on delete cascade,
  name          text not null,
  storage_path  text not null,
  uploaded_by   uuid default auth.uid(),
  created_at    timestamptz not null default now()
);

create table public.task_activity (
  id          bigint generated always as identity primary key,
  task_id     uuid not null references public.tasks(id) on delete cascade,
  company_id  uuid not null references public.companies(id) on delete cascade,
  actor_id    uuid,
  action      text not null,
  details     jsonb not null default '{}',
  at          timestamptz not null default now()
);

-- visibility: HR/admin/owner see all; others see tasks they created, are assigned to,
-- belong to via project, or that are assigned to someone in their team
create or replace function public.can_view_task(tid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.tasks t where t.id = tid and (
      public.is_hr(t.company_id)
      or t.created_by = auth.uid()
      or exists (select 1 from public.task_assignees a join public.employees e on e.id = a.employee_id
                 where a.task_id = t.id and (e.user_id = auth.uid() or public.is_manager_of(e.id)))
      or (t.project_id is not null and public.is_project_member(t.project_id))
    )
  );
$$;

create or replace function public.can_edit_task(tid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.tasks t where t.id = tid and (
      public.is_hr(t.company_id)
      or t.created_by = auth.uid()
      or exists (select 1 from public.task_assignees a join public.employees e on e.id = a.employee_id
                 where a.task_id = t.id and (e.user_id = auth.uid() or public.is_manager_of(e.id)))
      or (t.project_id is not null and public.can_manage_project(t.project_id))
    )
  );
$$;

create or replace function public.tasks_before_update()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  if new.status = 'done' and old.status <> 'done' then new.completed_at := now(); end if;
  if new.status <> 'done' then new.completed_at := null; end if;
  if new.due_at is distinct from old.due_at then new.reminded_24h := false; new.reminded_overdue := false; end if;
  return new;
end $$;
create trigger tasks_before_update before update on public.tasks
  for each row execute function public.tasks_before_update();

-- activity history and notifications (TSK-05/07)
create or replace function public.tasks_after_write()
returns trigger language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if tg_op = 'INSERT' then
    insert into public.task_activity (task_id, company_id, actor_id, action, details)
    values (new.id, new.company_id, auth.uid(), 'created', jsonb_build_object('title', new.title));
  elsif new.status is distinct from old.status then
    insert into public.task_activity (task_id, company_id, actor_id, action, details)
    values (new.id, new.company_id, auth.uid(), 'status', jsonb_build_object('from', old.status, 'to', new.status));
    for r in select e.user_id from public.task_assignees a join public.employees e on e.id = a.employee_id
             where a.task_id = new.id and e.user_id is distinct from auth.uid()
             union select new.created_by where new.created_by is distinct from auth.uid() loop
      perform public.notify(r.user_id, new.company_id, 'Task status changed',
        new.title || ': ' || replace(old.status, '_', ' ') || ' → ' || replace(new.status, '_', ' '), '/tasks/' || new.id);
    end loop;
  elsif row(new.title, new.description, new.priority, new.due_at, new.project_id)
        is distinct from row(old.title, old.description, old.priority, old.due_at, old.project_id) then
    insert into public.task_activity (task_id, company_id, actor_id, action, details)
    values (new.id, new.company_id, auth.uid(), 'edited', '{}');
  end if;
  return null;
end $$;
create trigger tasks_after_write after insert or update on public.tasks
  for each row execute function public.tasks_after_write();

create or replace function public.task_assignees_after_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_user uuid; v_title text;
begin
  select user_id into v_user from public.employees where id = new.employee_id;
  select title into v_title from public.tasks where id = new.task_id;
  insert into public.task_activity (task_id, company_id, actor_id, action, details)
  values (new.task_id, new.company_id, auth.uid(), 'assigned', jsonb_build_object('employee_id', new.employee_id));
  if v_user is distinct from auth.uid() then
    perform public.notify(v_user, new.company_id, 'New task assigned', v_title, '/tasks/' || new.task_id);
  end if;
  return null;
end $$;
create trigger task_assignees_after_insert after insert on public.task_assignees
  for each row execute function public.task_assignees_after_insert();

create or replace function public.task_comments_after_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_title text; m uuid; v_user uuid;
begin
  select title into v_title from public.tasks where id = new.task_id;
  insert into public.task_activity (task_id, company_id, actor_id, action, details)
  values (new.task_id, new.company_id, new.author_id, 'commented', '{}');
  foreach m in array new.mentions loop
    select user_id into v_user from public.employees where id = m and company_id = new.company_id;
    perform public.notify(v_user, new.company_id, 'You were mentioned', v_title, '/tasks/' || new.task_id);
  end loop;
  return null;
end $$;
create trigger task_comments_after_insert after insert on public.task_comments
  for each row execute function public.task_comments_after_insert();

-- reminders: due in 24 h and overdue (run by pg_cron)
create or replace function public.task_reminders()
returns integer language plpgsql security definer set search_path = public as $$
declare r record; n integer := 0;
begin
  for r in update public.tasks set reminded_24h = true
           where status not in ('done') and not reminded_24h and due_at between now() and now() + interval '24 hours'
           returning id, company_id, title loop
    perform public.notify(e.user_id, r.company_id, 'Task due within 24 h', r.title, '/tasks/' || r.id)
    from public.task_assignees a join public.employees e on e.id = a.employee_id where a.task_id = r.id;
    n := n + 1;
  end loop;
  for r in update public.tasks set reminded_overdue = true
           where status not in ('done') and not reminded_overdue and due_at < now()
           returning id, company_id, title loop
    perform public.notify(e.user_id, r.company_id, 'Task overdue', r.title, '/tasks/' || r.id)
    from public.task_assignees a join public.employees e on e.id = a.employee_id where a.task_id = r.id;
    n := n + 1;
  end loop;
  return n;
end $$;

alter table public.tasks            enable row level security;
alter table public.task_assignees   enable row level security;
alter table public.task_comments    enable row level security;
alter table public.task_attachments enable row level security;
alter table public.task_activity    enable row level security;

create policy tasks_select on public.tasks for select using (
  created_by = auth.uid() or public.is_hr(company_id) or public.can_view_task(id));
create policy tasks_insert on public.tasks for insert with check (
  public.is_member(company_id) and created_by = auth.uid()
  and (project_id is null or public.can_view_project(project_id)));
create policy tasks_update on public.tasks for update using (public.can_edit_task(id)) with check (public.is_member(company_id));
create policy tasks_delete on public.tasks for delete using (public.is_hr(company_id) or created_by = auth.uid());

-- assigning: task editors; employees (non-managers) may only assign to themselves
create policy ta_select on public.task_assignees for select using (public.can_view_task(task_id));
create policy ta_insert on public.task_assignees for insert with check (
  public.can_edit_task(task_id) and (
    public.has_role(company_id, array['owner','company_admin','hr','manager'])
    or employee_id = public.my_employee_id(company_id)));
create policy ta_delete on public.task_assignees for delete using (public.can_edit_task(task_id));

create policy tc_select on public.task_comments for select using (public.can_view_task(task_id));
create policy tc_insert on public.task_comments for insert with check (public.can_view_task(task_id) and author_id = auth.uid());
create policy tat_select on public.task_attachments for select using (public.can_view_task(task_id));
create policy tat_insert on public.task_attachments for insert with check (public.can_view_task(task_id));
create policy tact_select on public.task_activity for select using (public.can_view_task(task_id));
