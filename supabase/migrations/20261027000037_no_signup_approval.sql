-- corpgroup.com · 0037 no administrator approval of sign-ups (BRD v2.0 AUTH-01, AUTH-04)
--
-- The BRD has no approval step: an owner's account is created once their email code is verified
-- (AUTH-01), and employees don't self-register — HR adds them and they activate with an email code
-- (AUTH-04). New join requests were already refused (0028); the approval functions are now closed too.
-- Old requests stay as history.

create or replace function public.approve_join_request(p_request uuid, p_role text)
returns uuid language plpgsql security definer set search_path = public as $$
begin
  raise exception 'Sign-up approval is not used: HR adds employees and they activate by email code' using errcode = '42501';
end $$;

create or replace function public.reject_join_request(p_request uuid, p_note text)
returns void language plpgsql security definer set search_path = public as $$
begin
  raise exception 'Sign-up approval is not used: HR adds employees and they activate by email code' using errcode = '42501';
end $$;
