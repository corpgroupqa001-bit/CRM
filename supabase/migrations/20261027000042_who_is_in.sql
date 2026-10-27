-- corpgroup.com · 0042 "Who's in today" for every employee
--
-- Decision of 27 Oct 2026 (beyond BRD §5.3, where an employee reads only their own attendance): every
-- member of a company sees which colleagues are in today, as Present or Not in yet and nothing more. The
-- reason someone isn't in (absent, on leave, late and not arrived, missed punch) is never sent, and nobody
-- can read another person's attendance records through this. Present = today's status is Present, Late,
-- Early-out, Half-day, On Duty or Work From Home (a checked-in WFH day).

create or replace function public.who_is_in(p_company uuid)
returns table (employee_id uuid, full_name text, emp_code text, photo_url text, present boolean, me boolean)
language sql stable security definer set search_path = public as $$
  select e.id, trim(e.first_name || ' ' || coalesce(e.last_name, '')), e.emp_code, e.photo_url,
         exists (select 1 from public.daily_attendance d
                 where d.employee_id = e.id and d.date = (now() at time zone c.timezone)::date
                   and d.status in ('present','late','early_out','half_day','on_duty','wfh')),
         e.user_id is not distinct from auth.uid()
  from public.employees e
  join public.companies c on c.id = e.company_id
  where e.company_id = p_company
    and public.is_member(p_company) and public.in_good_standing(p_company)
    and e.status in ('active','notice') and e.removed_at is null
  order by 5 desc, 2;
$$;

revoke execute on function public.who_is_in(uuid) from public, anon;
grant execute on function public.who_is_in(uuid) to authenticated;
