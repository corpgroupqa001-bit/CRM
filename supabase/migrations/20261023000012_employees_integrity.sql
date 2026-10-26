-- corpgroup.com · 0012 employees: complete EMP-01 … EMP-07 at the database level.
--
-- The columns themselves already exist (migration 0003): personal (EMP-03), job (EMP-04) and
-- statutory / bank (EMP-05) details, company_id on every row, RLS enabled with role policies,
-- the auto employee code (EMP-02), device mapping (EMP-06) and documents (EMP-07).
-- This migration adds what the database did not yet enforce:
--   1. tenant integrity — branch, department, designation, shift and reporting manager must belong
--      to the employee's own company (a foreign key alone allows another company's row);
--   2. format checks for statutory fields, so bad data can't arrive through bulk import (EMP-01),
--      the API or a future screen;
--   3. sensible date and self-reference rules;
--   4. case-insensitive uniqueness of email per company, and indexes for the directory filters.

-- ---------------------------------------------------------------------------
-- Make sure the table is tenant-scoped and protected (idempotent; already true since 0003)
-- ---------------------------------------------------------------------------
alter table public.employees alter column company_id set not null;
alter table public.employees enable row level security;

-- ---------------------------------------------------------------------------
-- EMP-03 personal details
-- ---------------------------------------------------------------------------
alter table public.employees
  add constraint employees_first_name_present check (length(trim(first_name)) > 0),
  add constraint employees_email_format check (email ~* '^[^\s@]+@[^\s@]+\.[^\s@]+$'),
  add constraint employees_phone_format check (phone is null or phone ~ '^\+?[0-9][0-9 ()-]{6,19}$'),
  add constraint employees_emergency_phone_format check (emergency_phone is null or emergency_phone ~ '^\+?[0-9][0-9 ()-]{6,19}$'),
  add constraint employees_gender_values check (gender is null or gender in ('Female','Male','Other')),
  add constraint employees_dob_range check (dob is null or (dob >= date '1900-01-01' and dob <= current_date));

-- ---------------------------------------------------------------------------
-- EMP-04 job details
-- ---------------------------------------------------------------------------
alter table public.employees
  add constraint employees_not_own_manager check (reporting_manager_id is null or reporting_manager_id <> id),
  add constraint employees_joined_after_birth check (dob is null or date_of_joining > dob),
  add constraint employees_probation_after_joining check (probation_end is null or probation_end >= date_of_joining),
  add constraint employees_exit_after_joining check (last_working_day is null or last_working_day >= date_of_joining),
  add constraint employees_resignation_after_joining check (resignation_date is null or resignation_date >= date_of_joining);

-- branch / department / designation / shift / manager must come from the same company
create or replace function public.employees_same_company()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.branch_id is not null and not exists (select 1 from public.branches where id = new.branch_id and company_id = new.company_id) then
    raise exception 'Branch belongs to a different company' using errcode = '23503';
  end if;
  if new.department_id is not null and not exists (select 1 from public.departments where id = new.department_id and company_id = new.company_id) then
    raise exception 'Department belongs to a different company' using errcode = '23503';
  end if;
  if new.designation_id is not null and not exists (select 1 from public.designations where id = new.designation_id and company_id = new.company_id) then
    raise exception 'Designation belongs to a different company' using errcode = '23503';
  end if;
  if new.shift_id is not null and not exists (select 1 from public.shifts where id = new.shift_id and company_id = new.company_id) then
    raise exception 'Shift belongs to a different company' using errcode = '23503';
  end if;
  if new.reporting_manager_id is not null then
    if not exists (select 1 from public.employees where id = new.reporting_manager_id and company_id = new.company_id) then
      raise exception 'Reporting manager belongs to a different company' using errcode = '23503';
    end if;
    -- no reporting loops (A → B → … → A); the org chart (EMP-08) depends on a tree
    if exists (
      with recursive chain(id, depth) as (
        select new.reporting_manager_id, 1
        union all
        select e.reporting_manager_id, c.depth + 1 from public.employees e join chain c on e.id = c.id
        where e.reporting_manager_id is not null and c.depth < 50
      )
      select 1 from chain where id = new.id
    ) then
      raise exception 'Reporting manager would create a loop in the reporting line' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists employees_same_company on public.employees;
create trigger employees_same_company
  before insert or update of company_id, branch_id, department_id, designation_id, shift_id, reporting_manager_id
  on public.employees for each row execute function public.employees_same_company();

-- ---------------------------------------------------------------------------
-- EMP-05 statutory and bank details. PAN, Aadhaar and account numbers are stored only encrypted
-- (*_enc, written by the server) plus their last 4 characters in clear for masked display.
-- ---------------------------------------------------------------------------
alter table public.employees
  add constraint employees_uan_format check (uan is null or uan ~ '^[0-9]{12}$'),
  add constraint employees_esi_format check (esi_no is null or esi_no ~ '^[0-9]{10}$'),
  add constraint employees_ifsc_format check (ifsc is null or ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  add constraint employees_pan_last4_format check (pan_last4 is null or pan_last4 ~ '^[0-9]{3}[A-Z]$'),
  add constraint employees_aadhaar_last4_format check (aadhaar_last4 is null or aadhaar_last4 ~ '^[0-9]{4}$'),
  add constraint employees_bank_last4_format check (bank_last4 is null or bank_last4 ~ '^[0-9]{4}$'),
  -- the masked digits and the encrypted value always travel together
  add constraint employees_pan_pair check ((pan_enc is null) = (pan_last4 is null)),
  add constraint employees_aadhaar_pair check ((aadhaar_enc is null) = (aadhaar_last4 is null)),
  add constraint employees_bank_pair check ((bank_account_enc is null) = (bank_last4 is null));

comment on column public.employees.pan_enc is 'AES-256-GCM ciphertext written by the server (FIELD_ENCRYPTION_KEY); never plaintext';
comment on column public.employees.aadhaar_enc is 'AES-256-GCM ciphertext written by the server; Aadhaar is shown masked only (EMP-05)';
comment on column public.employees.bank_account_enc is 'AES-256-GCM ciphertext written by the server';
comment on column public.employees.uan is 'EPFO Universal Account Number, 12 digits';
comment on column public.employees.esi_no is 'ESIC insurance (IP) number, 10 digits';

-- ---------------------------------------------------------------------------
-- Uniqueness and lookups (EMP-01 import duplicate check, EMP-12 directory filters)
-- ---------------------------------------------------------------------------
create unique index if not exists employees_company_email_ci on public.employees (company_id, lower(email));
create unique index if not exists employees_company_uan on public.employees (company_id, uan) where uan is not null;
create index if not exists employees_company_department on public.employees (company_id, department_id);
create index if not exists employees_company_branch on public.employees (company_id, branch_id);
