-- corpgroup.com · 0032 payroll runs on hosted Supabase
--
-- Hosted Supabase loads the safeupdate extension for API requests, which refuses a DELETE without a
-- WHERE clause. run_payroll() emptied its temporary working table with "delete from _comp;", so running
-- payroll through the app failed there ("DELETE requires a WHERE clause"); the test database doesn't load
-- safeupdate, so the tests passed. Same function as 0018, with "where true" on that statement.

create or replace function public.run_payroll(p_company uuid, p_month date)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
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
  v_decl       public.tax_declarations%rowtype;
  v_st         public.statutory_settings%rowtype;
begin
  if not public.has_perm(p_company, 'salaries.manage') then raise exception 'not allowed' using errcode = '42501'; end if;
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
    delete from _comp where true;   -- hosted Supabase (safeupdate) refuses a DELETE without WHERE
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
      -- SAL-04: the employee's regime; under the old regime declared investments reduce taxable income
      select * into v_decl from public.tax_declarations
        where employee_id = e.id and fy_start_year = extract(year from v_fy_start)::int;
      v_st := public.regime_settings(st, coalesce(v_decl.regime, 'new'));
      v_tds := greatest(0, (public.annual_tax(v_st, v_ytd_taxable + v_taxable + v_full_taxable * (v_months_left - 1)
                                           - v_st.standard_deduction
                                           - case when v_decl.regime = 'old' then coalesce(v_decl.declared_total, 0) else 0 end)
                            - v_ytd_tds) / greatest(v_months_left, 1));
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
