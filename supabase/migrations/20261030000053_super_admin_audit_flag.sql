-- corpgroup.com · 0053 every change by the Super Admin is flagged in the audit log
--
-- Follows 0052 (decision of 30 Oct 2026): the Super Admin is an administrator in every company, including
-- companies where they also work. The audit flag used to be set only where they were not a member, so their
-- changes there looked like an ordinary employee's. Now every audit row written by a Super Admin is flagged
-- via_super_admin, so the Owner always sees it (Settings → Audit log shows a "Super Admin" badge).

create or replace function public.audit_log_flag_sa()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and exists (select 1 from public.platform_admins where user_id = auth.uid()) then
    new.via_super_admin := true;
  end if;
  return new;
end $$;
