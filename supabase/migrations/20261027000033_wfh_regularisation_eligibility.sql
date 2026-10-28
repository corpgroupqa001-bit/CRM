-- corpgroup.com · 0033 only work-from-home employees can have a day corrected to "work from home" (ATT-21)
--
-- Eligibility is per employee: on-site and field staff record attendance by device punches (or the
-- geofenced mobile punch), so a correction request of kind 'wfh' is refused for anyone who isn't
-- allowed to work from home. Missed-punch and on-duty corrections are unchanged.

create or replace function public.regularisations_wfh_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.kind = 'wfh' and not coalesce((select wfh_eligible from public.employees where id = new.employee_id), false) then
    raise exception 'Work from home isn''t enabled for this employee; ask HR' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists regularisations_wfh_guard on public.regularisations;
create trigger regularisations_wfh_guard before insert on public.regularisations
  for each row execute function public.regularisations_wfh_guard();
