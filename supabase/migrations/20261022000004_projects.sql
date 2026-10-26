-- corpgroup.com · 0004 projects within a company (COM-04, COM-12, COM-13)

create table public.projects (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id) on delete cascade,
  name           text not null,
  client         text,
  description    text,
  start_date     date,
  end_date       date,
  manager_id     uuid references public.employees(id) on delete set null,
  status         text not null default 'planned' check (status in ('planned','active','on_hold','completed')),
  task_statuses  text[] not null default '{todo,in_progress,in_review,done,blocked}',
  archived       boolean not null default false,
  created_by     uuid default auth.uid(),
  created_at     timestamptz not null default now()
);
create index on public.projects (company_id, status);

create table public.project_members (
  project_id   uuid not null references public.projects(id) on delete cascade,
  employee_id  uuid not null references public.employees(id) on delete cascade,
  company_id   uuid not null references public.companies(id) on delete cascade,
  added_at     timestamptz not null default now(),
  primary key (project_id, employee_id)
);

create or replace function public.is_project_member(pid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.project_members pm
    join public.employees e on e.id = pm.employee_id
    where pm.project_id = pid and e.user_id = auth.uid()
  ) or exists (
    select 1 from public.projects p
    join public.employees e on e.id = p.manager_id
    where p.id = pid and e.user_id = auth.uid()
  );
$$;

-- who can see a project: HR/admin/owner, managers, and members
create or replace function public.can_view_project(pid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.projects p where p.id = pid and (
      public.has_role(p.company_id, array['owner','company_admin','hr','manager'])
      or public.is_project_member(p.id)
    )
  );
$$;

create or replace function public.can_manage_project(pid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.projects p
    left join public.employees e on e.id = p.manager_id
    where p.id = pid and (
      public.has_role(p.company_id, array['owner','company_admin','hr'])
      or e.user_id = auth.uid()
    )
  );
$$;

alter table public.projects        enable row level security;
alter table public.project_members enable row level security;

create policy projects_select on public.projects for select using (
  public.has_role(company_id, array['owner','company_admin','hr','manager']) or public.is_project_member(id));
create policy projects_insert on public.projects for insert
  with check (public.has_role(company_id, array['owner','company_admin','hr','manager']));
create policy projects_update on public.projects for update
  using (public.can_manage_project(id)) with check (public.is_member(company_id));
create policy projects_delete on public.projects for delete
  using (public.has_role(company_id, array['owner','company_admin']));

create policy pm_select on public.project_members for select using (public.can_view_project(project_id));
create policy pm_write on public.project_members for all
  using (public.can_manage_project(project_id)) with check (public.can_manage_project(project_id));

create trigger projects_audit after insert or update or delete on public.projects
  for each row execute function public.audit_trigger();
