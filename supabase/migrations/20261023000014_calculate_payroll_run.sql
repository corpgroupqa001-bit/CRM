-- corpgroup.com · 0014 calculate_payroll_run(company, 'YYYY-MM') — BRD SAL-27
--
-- Runs the month's payroll inside Postgres and returns one row per employee. The calculation is
-- the single payroll engine run_payroll() (migrations 0006 / 0011), which follows BRD §9 in order:
--   1. payable and LOP days from the month's locked daily attendance (payable-day map, joiners /
--      leavers, sandwich rule);
--   2. proration ratio = payable days ÷ salary days, capped at 1.0;
--   3. every earning component prorated by that ratio, then arrears, overtime
--      (OT hours × day value ÷ shift hours × multiplier), other earnings, reimbursements;
--   4. statutory deductions on the earned wage: PF, ESI, Professional Tax, LWF — rates, ceilings
--      and slabs come from statutory_settings (placeholder values until the CA verifies them);
--   5. TDS on the projected annual income;
--   6. other deductions (loan / advance EMI, one-time deductions, earlier recoveries);
--   7. net pay never below zero — the shortfall is carried forward as a recovery balance;
--   8. rounding to the rupee once, on each final payslip line.
-- Each call stores a new draft version of the month's run (SAL-28); approval still goes through
-- approve_payroll(). The month's attendance must be locked first (SAL-22).

create or replace function public.calculate_payroll_run(p_company_id uuid, p_month varchar)
returns table (
  run_id                uuid,
  employee_id           uuid,
  emp_code              text,
  employee_name         text,
  salary_days           numeric,
  payable_days          numeric,
  lop_days              numeric,
  ratio                 numeric,
  monthly_gross         numeric,
  earned_gross          numeric,   -- prorated monthly gross, rounded to the rupee
  overtime              numeric,
  gross_payable         numeric,   -- sum of the rounded earning lines (incl. OT, bonus, arrears …)
  statutory_deductions  numeric,   -- PF + ESI + PT + LWF + TDS
  other_deductions      numeric,   -- EMI / advance / one-time / earlier recoveries actually deducted
  net_pay               numeric,
  carried_forward       numeric    -- unrecovered amount moved to next month (SAL-24)
)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_month date;
  v_run   uuid;
begin
  if p_month is null or p_month !~ '^\d{4}-(0[1-9]|1[0-2])(-\d{2})?$' then
    raise exception 'p_month must be YYYY-MM, e.g. 2026-10 (got %)', p_month using errcode = '22007';
  end if;
  v_month := to_date(left(p_month, 7) || '-01', 'YYYY-MM-DD');

  -- run_payroll() checks HR rights, the attendance lock and an already-approved run
  v_run := public.run_payroll(p_company_id, v_month);

  return query
    select p.run_id, p.employee_id, e.emp_code, trim(e.first_name || ' ' || coalesce(e.last_name, '')),
           p.salary_days, p.payable_days, p.lop_days, round(p.ratio, 6), round(p.monthly_gross),
           round(p.earned_gross),
           coalesce((select sum(l.amount) from public.payslip_lines l where l.payslip_id = p.id and l.code = 'OT'), 0),
           p.gross_payable,
           coalesce((select sum(l.amount) from public.payslip_lines l
                     where l.payslip_id = p.id and l.code in ('PF','ESI','PT','LWF','TDS')), 0),
           coalesce((select sum(l.amount) from public.payslip_lines l where l.payslip_id = p.id and l.code = 'RECOVERY'), 0),
           p.net_pay, p.recovery_carry
      from public.payslips p
      join public.employees e on e.id = p.employee_id
     where p.run_id = v_run
     order by e.emp_code;
end $$;

comment on function public.calculate_payroll_run(uuid, varchar) is
  'SAL-27: run the month''s payroll in the database (BRD §9 order) and return each employee''s result';

revoke execute on function public.calculate_payroll_run(uuid, varchar) from public, anon;
grant execute on function public.calculate_payroll_run(uuid, varchar) to authenticated, service_role;
