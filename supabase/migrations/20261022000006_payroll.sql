-- corpgroup.com · 0006 payroll (SAL). The calculation runs inside Postgres (SAL-27) so a full
-- company run is not bound by web-function time limits.
-- Statutory rates below are DEFAULTS ONLY and must be verified with the company's CA (SAL-03).

create table public.salary_structures (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  name         text not null,
  description  text,
  created_at   timestamptz not null default now()
);

create table public.salary_components (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  structure_id  uuid not null references public.salary_structures(id) on delete cascade,
  code          text not null,              -- BASIC is special: pct_basic components refer to it
  name          text not null,
  calc          text not null check (calc in ('fixed','pct_ctc','pct_basic','balance')),
  value         numeric not null default 0, -- amount per month, or a percentage
  taxable       boolean not null default true,
  pf            boolean not null default false,
  esi           boolean not null default true,
  sort          integer not null default 0,
  unique (structure_id, code)
);

-- annual_ctc is the annual gross; monthly gross = annual_ctc / 12
create table public.employee_ctc (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete cascade,
  employee_id      uuid not null references public.employees(id) on delete cascade,
  structure_id     uuid not null references public.salary_structures(id),
  annual_ctc       numeric not null check (annual_ctc >= 0),
  effective_from   date not null,
  arrears_settled  boolean not null default false,
  note             text,
  created_by       uuid default auth.uid(),
  created_at       timestamptz not null default now(),
  unique (employee_id, effective_from)
);

create table public.statutory_settings (
  company_id          uuid primary key references public.companies(id) on delete cascade,
  pf_enabled          boolean not null default true,
  pf_employee_rate    numeric not null default 12,
  pf_employer_rate    numeric not null default 12,
  pf_wage_ceiling     numeric not null default 15000,
  pf_cap_at_ceiling   boolean not null default true,
  esi_enabled         boolean not null default true,
  esi_employee_rate   numeric not null default 0.75,
  esi_employer_rate   numeric not null default 3.25,
  esi_wage_ceiling    numeric not null default 21000,
  pt_enabled          boolean not null default true,
  -- [{min, max (null = no upper bound), amount, feb_amount?}]
  pt_slabs            jsonb not null default '[{"min":0,"max":15000,"amount":0},{"min":15000.01,"max":20000,"amount":150},{"min":20000.01,"max":null,"amount":200}]',
  lwf_enabled         boolean not null default false,
  lwf_employee        numeric not null default 0,
  lwf_employer        numeric not null default 0,
  lwf_months          integer[] not null default '{12}',
  tds_enabled         boolean not null default true,
  -- progressive bands [{upto (null = above), rate %}]
  tds_slabs           jsonb not null default '[{"upto":400000,"rate":0},{"upto":800000,"rate":5},{"upto":1200000,"rate":10},{"upto":1600000,"rate":15},{"upto":2000000,"rate":20},{"upto":2400000,"rate":25},{"upto":null,"rate":30}]',
  standard_deduction  numeric not null default 75000,
  rebate_limit        numeric not null default 1200000,
  rebate_max          numeric not null default 60000,
  cess_pct            numeric not null default 4,
  gratuity_enabled    boolean not null default true,
  verified_on         date,           -- set once the CA has checked these values
  updated_at          timestamptz not null default now()
);

create table public.variable_inputs (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  employee_id  uuid not null references public.employees(id) on delete cascade,
  month        date not null,
  kind         text not null check (kind in ('bonus','incentive','reimbursement','deduction')),
  amount       numeric not null check (amount >= 0),
  note         text,
  created_at   timestamptz not null default now()
);
create index on public.variable_inputs (company_id, month);

create table public.loans (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  employee_id   uuid not null references public.employees(id) on delete cascade,
  kind          text not null default 'advance' check (kind in ('loan','advance')),
  principal     numeric not null check (principal > 0),
  emi           numeric not null check (emi > 0),
  balance       numeric not null,
  start_month   date not null,
  status        text not null default 'active' check (status in ('active','closed')),
  note          text,
  created_at    timestamptz not null default now()
);

create table public.recovery_balances (
  employee_id  uuid primary key references public.employees(id) on delete cascade,
  company_id   uuid not null references public.companies(id) on delete cascade,
  amount       numeric not null default 0,
  updated_at   timestamptz not null default now()
);

create table public.payroll_runs (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete cascade,
  month            date not null,
  version          integer not null,
  status           text not null default 'draft' check (status in ('draft','locked','superseded','reopened')),
  ran_by           uuid,
  ran_at           timestamptz not null default now(),
  approved_by      uuid,
  approved_at      timestamptz,
  reopened_by      uuid,
  reopened_at      timestamptz,
  reopen_reason    text,
  employee_count   integer not null default 0,
  total_gross      numeric not null default 0,
  total_deductions numeric not null default 0,
  total_net        numeric not null default 0,
  warnings         jsonb not null default '[]',
  changes          jsonb not null default '[]',   -- SAL-28: per-employee net change vs the previous version
  unique (company_id, month, version)
);

create table public.payslips (
  id               uuid primary key default gen_random_uuid(),
  run_id           uuid not null references public.payroll_runs(id) on delete cascade,
  company_id       uuid not null references public.companies(id) on delete cascade,
  employee_id      uuid not null references public.employees(id) on delete cascade,
  month            date not null,
  salary_days      numeric not null,
  window_days      integer not null,
  payable_days     numeric not null,
  lop_days         numeric not null,
  late_marks       integer not null default 0,
  ot_hours         numeric not null default 0,
  ratio            numeric not null,
  monthly_gross    numeric not null,
  day_value        numeric not null,
  earned_gross     numeric not null,
  taxable_income   numeric not null default 0,
  gross_payable    numeric not null,          -- sum of rounded earning lines
  total_deductions numeric not null,          -- sum of rounded deduction lines
  net_pay          numeric not null,
  employer_pf      numeric not null default 0,
  employer_esi     numeric not null default 0,
  recovery_prev    numeric not null default 0,
  recovery_carry   numeric not null default 0, -- unrecovered amount carried to next month (SAL-24)
  loan_applied     jsonb not null default '{}',
  arrears_ctc_ids  uuid[] not null default '{}',
  held             boolean not null default false,
  payment_status   text not null default 'pending' check (payment_status in ('pending','paid','failed','on_hold')),
  created_at       timestamptz not null default now(),
  unique (run_id, employee_id)
);
create index on public.payslips (employee_id, month);

create table public.payslip_lines (
  id           bigint generated always as identity primary key,
  payslip_id   uuid not null references public.payslips(id) on delete cascade,
  company_id   uuid not null references public.companies(id) on delete cascade,
  code         text not null,
  name         text not null,
  kind         text not null check (kind in ('earning','deduction')),
  full_amount  numeric,          -- monthly amount before proration, for earnings
  amount       numeric not null, -- rounded to the rupee
  sort         integer not null default 0
);
create index on public.payslip_lines (payslip_id);

-- ---------------------------------------------------------------------------
-- Calculation helpers
-- ---------------------------------------------------------------------------
-- monthly component amounts of a structure for a given monthly gross (unrounded)
create or replace function public.structure_amounts(p_structure uuid, p_monthly numeric)
returns table (code text, name text, amount numeric, taxable boolean, pf boolean, esi boolean, sort integer)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  r record;
  v_basic numeric := 0;
  v_sum numeric := 0;
begin
  -- fixed and %-of-gross first (BASIC among them), then %-of-Basic, then the balancing component
  for r in select * from public.salary_components where structure_id = p_structure order by
           case calc when 'fixed' then 1 when 'pct_ctc' then 1 when 'pct_basic' then 2 else 3 end, sort loop
    amount := case r.calc
      when 'fixed' then r.value
      when 'pct_ctc' then p_monthly * r.value / 100
      when 'pct_basic' then v_basic * r.value / 100
      else greatest(0, p_monthly - v_sum) end;
    if upper(r.code) = 'BASIC' then v_basic := amount; end if;
    v_sum := v_sum + amount;
    code := r.code; name := r.name; taxable := r.taxable; pf := r.pf; esi := r.esi; sort := r.sort;
    return next;
  end loop;
end $$;

-- progressive income tax on annual taxable income, with rebate and cess
create or replace function public.annual_tax(p_settings public.statutory_settings, p_income numeric)
returns numeric language plpgsql immutable as $$
declare b jsonb; v_prev numeric := 0; v_upto numeric; v_tax numeric := 0;
begin
  if p_income <= 0 then return 0; end if;
  for b in select * from jsonb_array_elements(p_settings.tds_slabs) loop
    v_upto := nullif(b ->> 'upto', '')::numeric;
    if v_upto is null or p_income <= v_upto then
      v_tax := v_tax + (p_income - v_prev) * (b ->> 'rate')::numeric / 100;
      exit;
    end if;
    v_tax := v_tax + (v_upto - v_prev) * (b ->> 'rate')::numeric / 100;
    v_prev := v_upto;
  end loop;
  if p_income <= p_settings.rebate_limit then v_tax := greatest(0, v_tax - p_settings.rebate_max); end if;
  return v_tax * (1 + p_settings.cess_pct / 100);
end $$;

-- latest locked payslip per employee and month (one version counts)
create or replace view public.final_payslips with (security_invoker = true) as
select p.* from public.payslips p join public.payroll_runs r on r.id = p.run_id where r.status = 'locked';

-- SAL-26 year-to-date totals per financial year
create or replace view public.payslip_ytd with (security_invoker = true) as
select p.company_id, p.employee_id,
       case when extract(month from p.month) >= c.fy_start_month then extract(year from p.month)::int
            else extract(year from p.month)::int - 1 end as fy_start_year,
       sum(p.gross_payable) as gross, sum(p.taxable_income) as taxable,
       sum(coalesce((select sum(amount) from public.payslip_lines l where l.payslip_id = p.id and l.code = 'PF'), 0)) as pf,
       sum(coalesce((select sum(amount) from public.payslip_lines l where l.payslip_id = p.id and l.code = 'ESI'), 0)) as esi,
       sum(coalesce((select sum(amount) from public.payslip_lines l where l.payslip_id = p.id and l.code = 'PT'), 0)) as pt,
       sum(coalesce((select sum(amount) from public.payslip_lines l where l.payslip_id = p.id and l.code = 'TDS'), 0)) as tds,
       sum(p.net_pay) as net
from public.final_payslips p join public.companies c on c.id = p.company_id
group by 1, 2, 3;

-- SAL-08 pre-run checks
create or replace function public.payroll_precheck(p_company uuid, p_month date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_month date := date_trunc('month', p_month)::date; v_end date; out jsonb := '[]';
begin
  if not public.is_hr(p_company) then raise exception 'not allowed' using errcode = '42501'; end if;
  v_end := (v_month + interval '1 month - 1 day')::date;
  if not public.is_month_locked(p_company, v_month) then
    out := out || jsonb_build_object('level','error','code','attendance_unlocked','message','Attendance for this month is not locked');
  end if;
  out := out || coalesce((select jsonb_agg(jsonb_build_object('level','warning','code','missing_bank','employee_id',id,
            'message', emp_code || ' ' || first_name || ': bank account or IFSC missing'))
          from public.employees where company_id = p_company and status <> 'inactive' and date_of_joining <= v_end
            and (last_working_day is null or last_working_day >= v_month) and (bank_account_enc is null or ifsc is null)), '[]');
  out := out || coalesce((select jsonb_agg(jsonb_build_object('level','error','code','missing_ctc','employee_id',e.id,
            'message', e.emp_code || ' ' || e.first_name || ': no salary assigned'))
          from public.employees e where e.company_id = p_company and e.status <> 'inactive' and e.date_of_joining <= v_end
            and (e.last_working_day is null or e.last_working_day >= v_month)
            and not exists (select 1 from public.employee_ctc x where x.employee_id = e.id and x.effective_from <= v_end)), '[]');
  out := out || coalesce((select jsonb_build_array(jsonb_build_object('level','error','code','unmapped_punches',
            'message', count(*) || ' unmapped device punches')) from public.punches_raw
          where company_id = p_company and employee_id is null and punched_at >= v_month and punched_at < v_end + 1
          having count(*) > 0), '[]');
  out := out || coalesce((select jsonb_build_array(jsonb_build_object('level','warning','code','missed_punch',
            'message', count(*) || ' days with a missed punch will be paid as LOP unless regularised'))
          from public.daily_attendance where company_id = p_company and status = 'missed_punch'
            and date between v_month and v_end having count(*) > 0), '[]');
  return out;
end $$;

-- ---------------------------------------------------------------------------
-- The payroll run (SAL-05, SAL-17 … SAL-27). Order of operations follows BRD §9 exactly.
-- ---------------------------------------------------------------------------
create or replace function public.run_payroll(p_company uuid, p_month date)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  c            public.companies%rowtype;
  st           public.statutory_settings%rowtype;
  e            record;
  v_month      date := date_trunc('month', p_month)::date;
  v_end        date;
  v_dim        integer;
  v_salary_days numeric;
  v_run        uuid;
  v_version    integer;
  v_prev_run   uuid;
  -- per employee
  v_ws date; v_we date; v_window integer;
  v_days       date[]; v_vals numeric[]; v_stats text[];
  d            date; i integer; j integer; k integer;
  a            public.daily_attendance%rowtype;
  v_val        numeric; v_paid boolean;
  v_payable    numeric; v_late integer; v_ot_min integer;
  v_ratio      numeric;
  ctc_old      public.employee_ctc%rowtype; ctc_new public.employee_ctc%rowtype;
  v_w_old      numeric; v_monthly numeric; v_day_value numeric; v_shift_hours numeric;
  comp         record;
  v_slip       uuid;
  v_earned     numeric; v_pf_wage numeric; v_esi_wage numeric; v_taxable numeric; v_basic_full numeric;
  v_ot_amt     numeric; v_bonus numeric; v_incent numeric; v_reimb numeric; v_onetime numeric;
  v_arrears    numeric; v_arrear_ids uuid[]; ar record; v_frac numeric;
  v_encash     numeric; v_gratuity numeric; v_years numeric;
  v_pf numeric; v_esi numeric; v_pt numeric; v_lwf numeric; v_tds numeric;
  v_er_pf numeric; v_er_esi numeric;
  v_fy_start   date; v_months_left integer; v_ytd_taxable numeric; v_ytd_tds numeric; v_full_taxable numeric;
  v_loans      jsonb; v_loan_total numeric; v_recov_prev numeric;
  v_gross_r    numeric; v_stat_r numeric; v_avail numeric; v_other_need numeric; v_other_applied numeric;
  v_ded_r      numeric; v_net numeric; v_carry numeric;
  v_slab       jsonb; v_pt_base numeric;
  v_count integer := 0; v_tot_gross numeric := 0; v_tot_ded numeric := 0; v_tot_net numeric := 0;
  v_warnings   jsonb;
  v_sort       integer;
begin
  if not public.is_hr(p_company) then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into c from public.companies where id = p_company;
  select * into st from public.statutory_settings where company_id = p_company;
  if not found then raise exception 'Statutory settings are missing for this company'; end if;

  -- SAL-22: payroll only on a locked attendance month
  if not public.is_month_locked(p_company, v_month) then
    raise exception 'Lock attendance for % before running payroll', to_char(v_month, 'Mon YYYY');
  end if;
  if exists (select 1 from public.payroll_runs where company_id = p_company and month = v_month and status = 'locked') then
    raise exception 'Payroll for % is locked — reopen it first', to_char(v_month, 'Mon YYYY');
  end if;

  v_end := (v_month + interval '1 month - 1 day')::date;
  v_dim := extract(day from v_end)::int;
  v_salary_days := case c.salary_days_basis when '30' then 30 when '26' then 26 else v_dim end;

  select id into v_prev_run from public.payroll_runs where company_id = p_company and month = v_month
    order by version desc limit 1;
  update public.payroll_runs set status = 'superseded' where company_id = p_company and month = v_month and status = 'draft';
  select coalesce(max(version), 0) + 1 into v_version from public.payroll_runs where company_id = p_company and month = v_month;
  v_warnings := public.payroll_precheck(p_company, v_month);

  insert into public.payroll_runs (company_id, month, version, status, ran_by, warnings)
  values (p_company, v_month, v_version, 'draft', auth.uid(), v_warnings) returning id into v_run;

  -- financial year bounds for TDS
  v_fy_start := make_date(case when extract(month from v_month) >= c.fy_start_month then extract(year from v_month)::int
                               else extract(year from v_month)::int - 1 end, c.fy_start_month, 1);

  for e in
    select emp.*, coalesce(sh.full_day_hours, 8) as shift_hours
    from public.employees emp left join public.shifts sh on sh.id = emp.shift_id
    where emp.company_id = p_company and emp.date_of_joining <= v_end
      and (emp.last_working_day is null or emp.last_working_day >= v_month)
      and exists (select 1 from public.employee_ctc x where x.employee_id = emp.id and x.effective_from <= v_end)
    order by emp.emp_code
  loop
    -- ---- Step 1: payable and LOP days from locked attendance (SAL-05/17/23) ----
    v_ws := greatest(v_month, e.date_of_joining);
    v_we := least(v_end, coalesce(e.last_working_day, v_end));
    v_window := v_we - v_ws + 1;
    v_days := '{}'; v_vals := '{}'; v_stats := '{}';
    v_late := 0; v_ot_min := 0;
    for d in select generate_series(v_ws, v_we, interval '1 day')::date loop
      select * into a from public.daily_attendance where employee_id = e.id and date = d;
      if not found then
        a.status := 'absent'; a.late := false; a.ot_approved_minutes := 0; a.leave_type_id := null;
        a.leave_half := false; a.half_present := false;
      end if;
      if a.status = 'on_leave' then
        select lt.paid into v_paid from public.leave_types lt where lt.id = a.leave_type_id;
        v_val := (case when coalesce(v_paid, false) then (case when a.leave_half then 0.5 else 1 end) else 0 end)
               + (case when a.leave_half and a.half_present then 0.5 else 0 end);
      else
        v_val := coalesce((c.payable_map ->> a.status)::numeric, 0);
      end if;
      v_days := v_days || d; v_vals := v_vals || v_val; v_stats := v_stats || a.status;
      if a.late then v_late := v_late + 1; end if;
      v_ot_min := v_ot_min + coalesce(a.ot_approved_minutes, 0);
    end loop;

    -- sandwich rule (SAL-19): an off day between two LOP days is unpaid when the company says so
    if not c.sandwich_paid then
      for i in 1 .. coalesce(array_length(v_days, 1), 0) loop
        if v_stats[i] in ('holiday','weekly_off') then
          j := i - 1; while j >= 1 and v_stats[j] in ('holiday','weekly_off') loop j := j - 1; end loop;
          k := i + 1; while k <= array_length(v_days, 1) and v_stats[k] in ('holiday','weekly_off') loop k := k + 1; end loop;
          if j >= 1 and k <= array_length(v_days, 1) and v_vals[j] = 0 and v_vals[k] = 0 then
            v_vals[i] := 0;
          end if;
        end if;
      end loop;
    end if;

    v_payable := 0;
    for i in 1 .. coalesce(array_length(v_vals, 1), 0) loop v_payable := v_payable + v_vals[i]; end loop;

    -- ---- Step 2: proration ratio, capped at 1.0 (SAL-18) ----
    v_ratio := least(v_payable / v_salary_days, 1);

    -- salary in force; a mid-month revision is weighted by its effective date (SAL-25)
    select * into ctc_old from public.employee_ctc where employee_id = e.id and effective_from <= v_month
      order by effective_from desc limit 1;
    select * into ctc_new from public.employee_ctc where employee_id = e.id and effective_from > v_month
      and effective_from <= v_end order by effective_from desc limit 1;
    if ctc_old.id is null then ctc_old := ctc_new; ctc_new := null; end if;
    if ctc_new.id is not null then
      v_w_old := (ctc_new.effective_from - v_month)::numeric / v_dim;
    else
      v_w_old := 1;
    end if;

    create temp table if not exists _comp (code text, name text, full_amount numeric, taxable boolean, pf boolean, esi boolean, sort integer) on commit drop;
    delete from _comp;
    insert into _comp
    select coalesce(o.code, n.code), coalesce(o.name, n.name),
           coalesce(o.amount, 0) * v_w_old + coalesce(n.amount, 0) * (1 - v_w_old),
           coalesce(o.taxable, n.taxable), coalesce(o.pf, n.pf), coalesce(o.esi, n.esi), coalesce(o.sort, n.sort)
    from public.structure_amounts(ctc_old.structure_id, ctc_old.annual_ctc / 12) o
    full outer join (select * from public.structure_amounts(ctc_new.structure_id, ctc_new.annual_ctc / 12)
                     where ctc_new.id is not null) n on n.code = o.code;

    select coalesce(sum(full_amount), 0) into v_monthly from _comp;
    select coalesce(sum(full_amount) filter (where upper(code) = 'BASIC'), 0) into v_basic_full from _comp;
    v_day_value := v_monthly / v_salary_days;

    insert into public.payslips (run_id, company_id, employee_id, month, salary_days, window_days, payable_days,
        lop_days, late_marks, ot_hours, ratio, monthly_gross, day_value, earned_gross, gross_payable, total_deductions, net_pay)
    values (v_run, p_company, e.id, v_month, v_salary_days, v_window, v_payable, v_window - v_payable, v_late,
        round(v_ot_min / 60.0, 2), v_ratio, v_monthly, v_day_value, 0, 0, 0, 0)
    returning id into v_slip;

    -- every earning component prorated by the same ratio
    v_earned := 0; v_pf_wage := 0; v_esi_wage := 0; v_taxable := 0; v_sort := 0;
    for comp in select * from _comp order by sort loop
      insert into public.payslip_lines (payslip_id, company_id, code, name, kind, full_amount, amount, sort)
      values (v_slip, p_company, comp.code, comp.name, 'earning', comp.full_amount, round(comp.full_amount * v_ratio), comp.sort);
      v_earned := v_earned + comp.full_amount * v_ratio;
      if comp.pf then v_pf_wage := v_pf_wage + comp.full_amount * v_ratio; end if;
      if comp.esi then v_esi_wage := v_esi_wage + comp.full_amount * v_ratio; end if;
      if comp.taxable then v_taxable := v_taxable + comp.full_amount * v_ratio; end if;
      v_sort := greatest(v_sort, comp.sort);
    end loop;

    -- ---- Step 3: arrears, overtime, other earnings, reimbursements ----
    v_arrears := 0; v_arrear_ids := '{}';
    for ar in select x.* from public.employee_ctc x
              where x.employee_id = e.id and not x.arrears_settled and x.effective_from < v_month loop
      for comp in select fp.month, fp.ratio, fp.monthly_gross from public.final_payslips fp
                  where fp.employee_id = e.id and fp.month >= date_trunc('month', ar.effective_from) and fp.month < v_month loop
        v_frac := case when ar.effective_from > comp.month
                       then ((comp.month + interval '1 month')::date - ar.effective_from)::numeric
                            / extract(day from (comp.month + interval '1 month - 1 day'))
                       else 1 end;
        v_arrears := v_arrears + greatest(0, (ar.annual_ctc / 12 - comp.monthly_gross) * comp.ratio * v_frac);
      end loop;
      v_arrear_ids := v_arrear_ids || ar.id;
    end loop;
    if v_arrears > 0 then
      v_sort := v_sort + 1;
      insert into public.payslip_lines (payslip_id, company_id, code, name, kind, amount, sort)
      values (v_slip, p_company, 'ARREARS', 'Arrears (salary revision)', 'earning', round(v_arrears), v_sort);
      v_taxable := v_taxable + v_arrears; v_esi_wage := v_esi_wage + v_arrears;
    end if;

    v_ot_amt := (v_ot_min / 60.0) * v_day_value / e.shift_hours * c.ot_multiplier;
    if v_ot_amt > 0 then
      v_sort := v_sort + 1;
      insert into public.payslip_lines (payslip_id, company_id, code, name, kind, amount, sort)
      values (v_slip, p_company, 'OT', 'Overtime ' || round(v_ot_min / 60.0, 2) || ' h', 'earning', round(v_ot_amt), v_sort);
      v_taxable := v_taxable + v_ot_amt; v_esi_wage := v_esi_wage + v_ot_amt;
    end if;

    select coalesce(sum(amount) filter (where kind = 'bonus'), 0),
           coalesce(sum(amount) filter (where kind = 'incentive'), 0),
           coalesce(sum(amount) filter (where kind = 'reimbursement'), 0),
           coalesce(sum(amount) filter (where kind = 'deduction'), 0)
      into v_bonus, v_incent, v_reimb, v_onetime
    from public.variable_inputs where employee_id = e.id and month = v_month;
    if v_bonus > 0 then
      v_sort := v_sort + 1;
      insert into public.payslip_lines (payslip_id, company_id, code, name, kind, amount, sort)
      values (v_slip, p_company, 'BONUS', 'Bonus', 'earning', round(v_bonus), v_sort);
      v_taxable := v_taxable + v_bonus;
    end if;
    if v_incent > 0 then
      v_sort := v_sort + 1;
      insert into public.payslip_lines (payslip_id, company_id, code, name, kind, amount, sort)
      values (v_slip, p_company, 'INCENTIVE', 'Incentive', 'earning', round(v_incent), v_sort);
      v_taxable := v_taxable + v_incent; v_esi_wage := v_esi_wage + v_incent;
    end if;

    -- exit in this month: leave encashment and gratuity (SAL-11)
    v_encash := 0; v_gratuity := 0;
    if e.last_working_day is not null and e.last_working_day <= v_end then
      select coalesce(sum(greatest(0, opening + accrued - used)), 0) * v_day_value into v_encash
      from public.leave_balance_view where employee_id = e.id and encashable
        and year = extract(year from e.last_working_day)::int;
      if v_encash > 0 then
        v_sort := v_sort + 1;
        insert into public.payslip_lines (payslip_id, company_id, code, name, kind, amount, sort)
        values (v_slip, p_company, 'ENCASH', 'Leave encashment', 'earning', round(v_encash), v_sort);
        v_taxable := v_taxable + v_encash;
      end if;
      v_years := (e.last_working_day - e.date_of_joining)::numeric / 365.25;
      if st.gratuity_enabled and v_years >= 5 then
        v_gratuity := 15.0 / 26 * v_basic_full * round(v_years);
        v_sort := v_sort + 1;
        insert into public.payslip_lines (payslip_id, company_id, code, name, kind, amount, sort)
        values (v_slip, p_company, 'GRATUITY', 'Gratuity', 'earning', round(v_gratuity), v_sort);
      end if;
    end if;

    if v_reimb > 0 then  -- non-taxable, excluded from PF / ESI / TDS
      v_sort := v_sort + 1;
      insert into public.payslip_lines (payslip_id, company_id, code, name, kind, amount, sort)
      values (v_slip, p_company, 'REIMB', 'Reimbursements (non-taxable)', 'earning', round(v_reimb), v_sort);
    end if;

    -- ---- Step 4: statutory deductions on the earned wage ----
    v_pf := 0; v_esi := 0; v_pt := 0; v_lwf := 0; v_er_pf := 0; v_er_esi := 0;
    if st.pf_enabled and v_pf_wage > 0 then
      if st.pf_cap_at_ceiling then v_pf_wage := least(v_pf_wage, st.pf_wage_ceiling); end if;
      v_pf := v_pf_wage * st.pf_employee_rate / 100;
      v_er_pf := v_pf_wage * st.pf_employer_rate / 100;
    end if;
    if st.esi_enabled and v_esi_wage > 0 and v_esi_wage <= st.esi_wage_ceiling then
      v_esi := v_esi_wage * st.esi_employee_rate / 100;
      v_er_esi := v_esi_wage * st.esi_employer_rate / 100;
    end if;
    if st.pt_enabled then
      v_pt_base := v_taxable;
      for v_slab in select * from jsonb_array_elements(st.pt_slabs) loop
        if v_pt_base >= (v_slab ->> 'min')::numeric
           and (v_slab ->> 'max' is null or v_pt_base <= (v_slab ->> 'max')::numeric) then
          v_pt := case when extract(month from v_month) = 2 and v_slab ? 'feb_amount'
                       then (v_slab ->> 'feb_amount')::numeric else (v_slab ->> 'amount')::numeric end;
          exit;
        end if;
      end loop;
    end if;
    if st.lwf_enabled and extract(month from v_month)::int = any(st.lwf_months) then
      v_lwf := st.lwf_employee;
    end if;

    -- ---- Step 5: TDS on projected annual taxable income less tax already deducted ----
    v_tds := 0;
    if st.tds_enabled then
      select coalesce(sum(fp.taxable_income), 0) into v_ytd_taxable from public.final_payslips fp
        where fp.employee_id = e.id and fp.month >= v_fy_start and fp.month < v_month;
      select coalesce(sum(l.amount), 0) into v_ytd_tds from public.final_payslips fp
        join public.payslip_lines l on l.payslip_id = fp.id and l.code = 'TDS'
        where fp.employee_id = e.id and fp.month >= v_fy_start and fp.month < v_month;
      v_months_left := (extract(year from age((v_fy_start + interval '1 year')::date, v_month)) * 12
                        + extract(month from age((v_fy_start + interval '1 year')::date, v_month)))::int;
      if e.last_working_day is not null and e.last_working_day <= v_end then v_months_left := 1; end if;
      select coalesce(sum(full_amount) filter (where taxable), 0) into v_full_taxable from _comp;
      v_tds := greatest(0, (public.annual_tax(st, v_ytd_taxable + v_taxable + v_full_taxable * (v_months_left - 1)
                                           - st.standard_deduction) - v_ytd_tds) / greatest(v_months_left, 1));
    end if;

    -- ---- Step 6: other deductions — loan / advance EMI, one-time deductions, earlier recoveries ----
    select coalesce(jsonb_object_agg(id, least(emi, balance)), '{}'), coalesce(sum(least(emi, balance)), 0)
      into v_loans, v_loan_total
    from public.loans where employee_id = e.id and status = 'active' and balance > 0 and start_month <= v_month;
    select coalesce(amount, 0) into v_recov_prev from public.recovery_balances where employee_id = e.id;
    v_recov_prev := coalesce(v_recov_prev, 0);

    -- ---- Steps 7–8: rounding per line, net never below zero, shortfall carried forward ----
    select coalesce(sum(amount), 0) into v_gross_r from public.payslip_lines where payslip_id = v_slip and kind = 'earning';
    v_pf := round(v_pf); v_esi := round(v_esi); v_pt := round(v_pt); v_lwf := round(v_lwf);
    v_tds := round(least(v_tds, greatest(0, v_gross_r - v_pf - v_esi - v_pt - v_lwf)));
    v_stat_r := v_pf + v_esi + v_pt + v_lwf + v_tds;
    v_avail := greatest(0, v_gross_r - v_stat_r);
    v_other_need := round(v_loan_total) + round(v_onetime) + round(v_recov_prev);
    v_other_applied := least(v_other_need, v_avail);
    v_carry := v_other_need - v_other_applied;

    v_sort := 100;
    if v_pf > 0 then insert into public.payslip_lines (payslip_id, company_id, code, name, kind, amount, sort)
      values (v_slip, p_company, 'PF', 'Provident Fund', 'deduction', v_pf, 101); end if;
    if v_esi > 0 then insert into public.payslip_lines (payslip_id, company_id, code, name, kind, amount, sort)
      values (v_slip, p_company, 'ESI', 'ESI', 'deduction', v_esi, 102); end if;
    if v_pt > 0 then insert into public.payslip_lines (payslip_id, company_id, code, name, kind, amount, sort)
      values (v_slip, p_company, 'PT', 'Professional Tax', 'deduction', v_pt, 103); end if;
    if v_lwf > 0 then insert into public.payslip_lines (payslip_id, company_id, code, name, kind, amount, sort)
      values (v_slip, p_company, 'LWF', 'Labour Welfare Fund', 'deduction', v_lwf, 104); end if;
    if v_tds > 0 then insert into public.payslip_lines (payslip_id, company_id, code, name, kind, amount, sort)
      values (v_slip, p_company, 'TDS', 'Income Tax (TDS)', 'deduction', v_tds, 105); end if;
    if v_other_applied > 0 then
      insert into public.payslip_lines (payslip_id, company_id, code, name, kind, amount, sort)
      values (v_slip, p_company, 'RECOVERY', 'Loan / advance EMI and recoveries', 'deduction', v_other_applied, 110);
    end if;

    v_ded_r := v_stat_r + v_other_applied;
    v_net := v_gross_r - v_ded_r;

    update public.payslips set
      earned_gross = v_earned, taxable_income = v_taxable, gross_payable = v_gross_r, total_deductions = v_ded_r,
      net_pay = v_net, employer_pf = round(v_er_pf), employer_esi = round(v_er_esi),
      recovery_prev = v_recov_prev, recovery_carry = v_carry, loan_applied = v_loans, arrears_ctc_ids = v_arrear_ids
    where id = v_slip;

    v_count := v_count + 1; v_tot_gross := v_tot_gross + v_gross_r; v_tot_ded := v_tot_ded + v_ded_r; v_tot_net := v_tot_net + v_net;
  end loop;

  update public.payroll_runs set employee_count = v_count, total_gross = v_tot_gross, total_deductions = v_tot_ded,
    total_net = v_tot_net,
    warnings = v_warnings || coalesce((select jsonb_agg(jsonb_build_object('level','warning','code','recovery_carry',
                 'employee_id', p.employee_id, 'message', 'Net pay capped at zero; ₹' || p.recovery_carry || ' carried forward'))
               from public.payslips p where p.run_id = v_run and p.recovery_carry > 0), '[]'),
    changes = coalesce((select jsonb_agg(jsonb_build_object('employee_id', n.employee_id, 'old_net', o.net_pay, 'new_net', n.net_pay))
               from public.payslips n left join public.payslips o on o.run_id = v_prev_run and o.employee_id = n.employee_id
               where n.run_id = v_run and v_prev_run is not null and o.net_pay is distinct from n.net_pay), '[]')
  where id = v_run;
  return v_run;
end $$;

-- SAL-09: approve = lock; applies loan EMIs and carry-forward recoveries
create or replace function public.approve_payroll(p_run uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r public.payroll_runs%rowtype; p record; l record;
begin
  select * into r from public.payroll_runs where id = p_run;
  if not public.has_role(r.company_id, array['owner','company_admin']) then
    raise exception 'Only the owner or a company admin can approve payroll' using errcode = '42501';
  end if;
  if r.status <> 'draft' then raise exception 'Only a draft run can be approved'; end if;
  if exists (select 1 from jsonb_array_elements(r.warnings) w where w ->> 'level' = 'error') then
    raise exception 'Resolve the pre-run errors before approving';
  end if;
  for p in select * from public.payslips where run_id = p_run loop
    for l in select key::uuid as loan_id, value::numeric as amt from jsonb_each_text(p.loan_applied) loop
      update public.loans set balance = balance - l.amt,
        status = case when balance - l.amt <= 0 then 'closed' else status end where id = l.loan_id;
    end loop;
    insert into public.recovery_balances (employee_id, company_id, amount) values (p.employee_id, p.company_id, p.recovery_carry)
    on conflict (employee_id) do update set amount = excluded.amount, updated_at = now();
    update public.employee_ctc set arrears_settled = true where id = any(p.arrears_ctc_ids);
  end loop;
  update public.payroll_runs set status = 'locked', approved_by = auth.uid(), approved_at = now() where id = p_run;
  update public.payslips set payment_status = case when held then 'on_hold' else 'pending' end where run_id = p_run;
end $$;

-- reopening payroll also reopens attendance for that month (SAL-22); effects are reversed
create or replace function public.reopen_payroll(p_run uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare r public.payroll_runs%rowtype; p record; l record;
begin
  select * into r from public.payroll_runs where id = p_run;
  if not public.has_role(r.company_id, array['owner','company_admin']) then
    raise exception 'Only the owner or a company admin can reopen payroll' using errcode = '42501';
  end if;
  if r.status <> 'locked' then raise exception 'Only a locked run can be reopened'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required'; end if;
  for p in select * from public.payslips where run_id = p_run loop
    for l in select key::uuid as loan_id, value::numeric as amt from jsonb_each_text(p.loan_applied) loop
      update public.loans set balance = balance + l.amt, status = 'active' where id = l.loan_id;
    end loop;
    update public.recovery_balances set amount = p.recovery_prev, updated_at = now() where employee_id = p.employee_id;
    update public.employee_ctc set arrears_settled = false where id = any(p.arrears_ctc_ids);
  end loop;
  update public.payroll_runs set status = 'reopened', reopened_by = auth.uid(), reopened_at = now(), reopen_reason = p_reason
  where id = p_run;
  delete from public.attendance_locks where company_id = r.company_id and month = r.month;
  insert into public.audit_log (company_id, user_id, table_name, record_id, action, new_data, ip)
  values (r.company_id, auth.uid(), 'payroll_runs', p_run::text, 'reopen',
          jsonb_build_object('reason', p_reason, 'month', r.month), public.request_ip());
end $$;

-- ---------------------------------------------------------------------------
-- Company bootstrap: sensible defaults for a new tenant
-- ---------------------------------------------------------------------------
create or replace function public.bootstrap_company()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_struct uuid;
begin
  insert into public.statutory_settings (company_id) values (new.id) on conflict do nothing;
  insert into public.shifts (company_id, name, start_time, end_time, grace_min, break_min, half_day_hours, full_day_hours, is_default)
  values (new.id, 'General (09:00–18:00)', '09:00', '18:00', 10, 60, 4, 8, true);
  insert into public.leave_types (company_id, code, name, paid, annual_quota, accrual, carry_forward_max, encashable) values
    (new.id, 'CL', 'Casual Leave', true, 12, 'yearly', 0, false),
    (new.id, 'SL', 'Sick Leave', true, 6, 'yearly', 0, false),
    (new.id, 'EL', 'Earned Leave', true, 15, 'monthly', 30, true),
    (new.id, 'LOP', 'Loss of Pay', false, 0, 'none', 0, false);
  insert into public.salary_structures (company_id, name, description)
  values (new.id, 'Standard', 'Basic 50% of gross, HRA 40% of Basic, Conveyance ₹1,600, Special = balance')
  returning id into v_struct;
  insert into public.salary_components (company_id, structure_id, code, name, calc, value, pf, sort) values
    (new.id, v_struct, 'BASIC', 'Basic', 'pct_ctc', 50, true, 1),
    (new.id, v_struct, 'HRA', 'House Rent Allowance', 'pct_basic', 40, false, 2),
    (new.id, v_struct, 'CONV', 'Conveyance', 'fixed', 1600, false, 3),
    (new.id, v_struct, 'SPECIAL', 'Special Allowance', 'balance', 0, false, 4);
  insert into public.departments (company_id, name) values (new.id, 'Administration'), (new.id, 'Operations');
  return null;
end $$;
create trigger companies_bootstrap after insert on public.companies
  for each row execute function public.bootstrap_company();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.salary_structures  enable row level security;
alter table public.salary_components  enable row level security;
alter table public.employee_ctc       enable row level security;
alter table public.statutory_settings enable row level security;
alter table public.variable_inputs    enable row level security;
alter table public.loans              enable row level security;
alter table public.recovery_balances  enable row level security;
alter table public.payroll_runs       enable row level security;
alter table public.payslips           enable row level security;
alter table public.payslip_lines      enable row level security;

-- HR/Payroll CRUD, Owner and Company Admin read (+ approve via function), Employee reads own payslip
create policy ss_select on public.salary_structures for select using (public.is_hr(company_id));
create policy ss_write on public.salary_structures for all using (public.has_role(company_id, array['hr','company_admin']))
  with check (public.has_role(company_id, array['hr','company_admin']));
create policy sc_select on public.salary_components for select using (public.is_hr(company_id));
create policy sc_write on public.salary_components for all using (public.has_role(company_id, array['hr','company_admin']))
  with check (public.has_role(company_id, array['hr','company_admin']));
create policy ctc_select on public.employee_ctc for select using (public.is_hr(company_id) or employee_id = public.my_employee_id(company_id));
create policy ctc_write on public.employee_ctc for all using (public.has_role(company_id, array['hr','company_admin']))
  with check (public.has_role(company_id, array['hr','company_admin']));
create policy stat_select on public.statutory_settings for select using (public.is_hr(company_id));
create policy stat_write on public.statutory_settings for update using (public.has_role(company_id, array['hr','company_admin']))
  with check (public.has_role(company_id, array['hr','company_admin']));
create policy vi_select on public.variable_inputs for select using (public.is_hr(company_id));
create policy vi_write on public.variable_inputs for all using (public.has_role(company_id, array['hr','company_admin']))
  with check (public.has_role(company_id, array['hr','company_admin']));
create policy loans_select on public.loans for select using (public.is_hr(company_id) or employee_id = public.my_employee_id(company_id));
create policy loans_write on public.loans for all using (public.has_role(company_id, array['hr','company_admin']))
  with check (public.has_role(company_id, array['hr','company_admin']));
create policy rb_select on public.recovery_balances for select using (public.is_hr(company_id) or employee_id = public.my_employee_id(company_id));
create policy runs_select on public.payroll_runs for select using (public.is_hr(company_id));
create policy slips_select on public.payslips for select using (
  public.is_hr(company_id)
  or (employee_id = public.my_employee_id(company_id)
      and exists (select 1 from public.payroll_runs r where r.id = run_id and r.status = 'locked')));
create policy slips_update on public.payslips for update using (public.has_role(company_id, array['hr','company_admin','owner']))
  with check (public.has_role(company_id, array['hr','company_admin','owner']));
create policy lines_select on public.payslip_lines for select using (
  exists (select 1 from public.payslips p where p.id = payslip_id));   -- inherits payslip visibility

create trigger employee_ctc_audit after insert or update or delete on public.employee_ctc
  for each row execute function public.audit_trigger();
create trigger statutory_audit after update on public.statutory_settings
  for each row execute function public.audit_trigger();
create trigger salary_components_audit after insert or update or delete on public.salary_components
  for each row execute function public.audit_trigger();
create trigger payroll_runs_audit after insert or update on public.payroll_runs
  for each row execute function public.audit_trigger();
