-- corpgroup.com · 0009 platform wiring: storage buckets, realtime, scheduled jobs, function grants

-- ---------------------------------------------------------------------------
-- Storage (paths always start with the company id)
--   logos/{company}/…                      public read
--   documents/{company}/{employee}/…       HR, or the employee themself
--   selfies/{company}/{employee}/…         mobile attendance selfies
--   chat/{company}/{conversation}/…        conversation members, ≤ 25 MB
--   tasks/{company}/{task}/…               anyone who can see the task
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit) values
  ('logos', 'logos', true, 2097152),
  ('documents', 'documents', false, 52428800),
  ('selfies', 'selfies', false, 5242880),
  ('chat', 'chat', false, 26214400),
  ('tasks', 'tasks', false, 52428800)
on conflict (id) do nothing;

create or replace function public.storage_company(p_name text)
returns uuid language sql immutable as $$
  select case when (storage.foldername(p_name))[1] ~ '^[0-9a-f-]{36}$' then ((storage.foldername(p_name))[1])::uuid end;
$$;
create or replace function public.storage_part(p_name text, i int)
returns uuid language sql immutable as $$
  select case when (storage.foldername(p_name))[i] ~ '^[0-9a-f-]{36}$' then ((storage.foldername(p_name))[i])::uuid end;
$$;

create policy logos_write on storage.objects for insert to authenticated
  with check (bucket_id = 'logos' and public.has_role(public.storage_company(name), array['owner','company_admin']));
create policy logos_update on storage.objects for update to authenticated
  using (bucket_id = 'logos' and public.has_role(public.storage_company(name), array['owner','company_admin']));

create policy documents_read on storage.objects for select to authenticated
  using (bucket_id = 'documents' and (public.is_hr(public.storage_company(name))
         or public.storage_part(name, 2) = public.my_employee_id(public.storage_company(name))));
create policy documents_write on storage.objects for insert to authenticated
  with check (bucket_id = 'documents' and (public.is_hr(public.storage_company(name))
         or public.storage_part(name, 2) = public.my_employee_id(public.storage_company(name))));
create policy documents_delete on storage.objects for delete to authenticated
  using (bucket_id = 'documents' and public.is_hr(public.storage_company(name)));

create policy selfies_read on storage.objects for select to authenticated
  using (bucket_id = 'selfies' and (public.is_hr(public.storage_company(name))
         or public.storage_part(name, 2) = public.my_employee_id(public.storage_company(name))));
create policy selfies_write on storage.objects for insert to authenticated
  with check (bucket_id = 'selfies' and public.storage_part(name, 2) = public.my_employee_id(public.storage_company(name)));

create policy chat_read on storage.objects for select to authenticated
  using (bucket_id = 'chat' and public.is_conversation_member(public.storage_part(name, 2)));
create policy chat_write on storage.objects for insert to authenticated
  with check (bucket_id = 'chat' and public.is_conversation_member(public.storage_part(name, 2)));

create policy tasks_read on storage.objects for select to authenticated
  using (bucket_id = 'tasks' and public.can_view_task(public.storage_part(name, 2)));
create policy tasks_write on storage.objects for insert to authenticated
  with check (bucket_id = 'tasks' and public.can_view_task(public.storage_part(name, 2)));

-- ---------------------------------------------------------------------------
-- Realtime: live attendance dashboard, chat, notifications (RLS still applies)
-- ---------------------------------------------------------------------------
do $$
begin
  alter publication supabase_realtime add table public.daily_attendance, public.messages,
    public.notifications, public.conversation_members;
exception when undefined_object then
  raise notice 'supabase_realtime publication not present (local test database)';
end $$;

-- ---------------------------------------------------------------------------
-- Scheduled jobs (pg_cron): Vercel Hobby cron runs once a day, so frequent jobs live here
-- ---------------------------------------------------------------------------
do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule('attendance-tick', '* * * * *', 'select public.attendance_tick()');
  perform cron.schedule('task-reminders', '*/5 * * * *', 'select public.task_reminders()');
exception when others then
  raise notice 'pg_cron unavailable: %', sqlerrm;
end $$;

-- ---------------------------------------------------------------------------
-- Function grants: internal and device-facing functions are not callable by app users
-- ---------------------------------------------------------------------------
revoke execute on function public.ingest_punches(text, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.attendance_tick() from public, anon, authenticated;
revoke execute on function public.check_devices() from public, anon, authenticated;
revoke execute on function public.task_reminders() from public, anon, authenticated;
revoke execute on function public.compute_attendance_day(uuid, date) from public, anon, authenticated;
revoke execute on function public.recompute_attendance(uuid, date, date, uuid) from public, anon, authenticated;
revoke execute on function public.notify(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.notify_roles(uuid, text[], text, text, text) from public, anon, authenticated;
revoke execute on function public.sync_employee_channels(uuid) from public, anon, authenticated;
grant execute on function public.ingest_punches(text, text, text, text, text) to service_role;
