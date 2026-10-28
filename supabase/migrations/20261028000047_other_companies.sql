-- corpgroup.com · 0047 which other companies an employee works in
--
-- Decision of 28 Oct 2026 (AUTH-11 people in several companies, EMP-10 transfers, COM-07 the Owner's view
-- across their companies): on the Employees list and an employee's page, the Owner, Company Admin and HR
-- see the other companies the same person works in: company name, their employee code and status there.
-- Isolation (NFR-04, §7.2): only companies where the viewer can also see all employees (employees.read_all)
-- are listed, so nobody learns about a company they don't belong to, and nothing else crosses over.
-- The same person = the same login, or the same work email (as "Add existing employee", 0036).

create or replace function public.employee_other_companies(p_company uuid)
returns table (employee_id uuid, company_id uuid, company_name text, emp_code text, status text)
language sql stable security definer set search_path = public as $$
  select e.id, o.company_id, c.name, o.emp_code, o.status
  from public.employees e
  join public.employees o on o.company_id <> e.company_id and o.removed_at is null
       and ((e.user_id is not null and o.user_id = e.user_id) or lower(o.email) = lower(e.email))
  join public.companies c on c.id = o.company_id and c.status = 'active'
  where e.company_id = p_company and e.removed_at is null
    and public.has_perm(p_company, 'employees.read_all')
    and public.has_perm(o.company_id, 'employees.read_all')
  order by c.name;
$$;

revoke execute on function public.employee_other_companies(uuid) from public, anon;
grant execute on function public.employee_other_companies(uuid) to authenticated;
