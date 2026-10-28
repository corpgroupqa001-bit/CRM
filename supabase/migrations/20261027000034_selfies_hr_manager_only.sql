-- corpgroup.com · 0034 selfies visible only to HR and the reporting manager (BRD ATT-25)
--
-- "Selfies are stored in Supabase Storage, visible only to HR and the reporting manager." 0027 also let
-- the employee read their own; uploading doesn't need that, so read access is now HR / Payroll and the
-- employee's reporting manager only. The app shows them on the employee's attendance page.

drop policy if exists selfies_read on storage.objects;
create policy selfies_read on storage.objects for select to authenticated
  using (bucket_id = 'selfies' and (
    public.has_role(public.storage_company(name), array['hr'])
    or exists (select 1 from public.employees e where e.id = public.storage_part(name, 2)
               and e.company_id = public.storage_company(name) and public.is_manager_of(e.id))));
