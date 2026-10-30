-- corpgroup.com · 0058 a rejected sign-up closes that person's project requests
--
-- Found on staging (30 Oct 2026): after the Owner rejected a sign-up, the person's project requests stayed in
-- Requests → Project requests with an Approve button. If someone isn't let into the company, their project
-- requests there are closed with it: "Not approved: account rejected" (shown under Recently decided). If they
-- sign up again later with the code, they can ask for projects again.

create or replace function public.reject_join_request(p_request uuid, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare r public.join_requests%rowtype; n integer;
begin
  select * into r from public.join_requests where id = p_request;
  if r.id is null or not public.has_perm(r.company_id, 'employees.account') then
    raise exception 'Only the Owner or the Admin can reject sign-ups' using errcode = '42501';
  end if;
  if r.status <> 'pending' then raise exception 'This request was already %', r.status; end if;
  update public.join_requests set status = 'rejected', decided_by = auth.uid(), decided_at = now(), decision_note = nullif(trim(p_note), '')
  where id = p_request;
  -- their project requests in this company go with the account
  update public.project_requests set status = 'rejected', decided_by = auth.uid(), decided_at = now(),
    decision_note = 'Not approved: account rejected'
  where company_id = r.company_id and user_id = r.user_id and status = 'pending';
  get diagnostics n = row_count;
  insert into public.audit_log (company_id, user_id, table_name, record_id, action, new_data, ip)
  values (r.company_id, auth.uid(), 'join_requests', p_request::text, 'reject',
          jsonb_build_object('email', r.email, 'note', p_note, 'project_requests_closed', n), public.request_ip());
end $$;

-- requests left behind by sign-ups rejected before this change
update public.project_requests pr set status = 'rejected', decided_by = jr.decided_by, decided_at = coalesce(jr.decided_at, now()),
  decision_note = 'Not approved: account rejected'
from public.join_requests jr
where pr.status = 'pending' and jr.company_id = pr.company_id and jr.user_id = pr.user_id and jr.status = 'rejected'
  and not exists (select 1 from public.company_members m where m.company_id = pr.company_id and m.user_id = pr.user_id);
