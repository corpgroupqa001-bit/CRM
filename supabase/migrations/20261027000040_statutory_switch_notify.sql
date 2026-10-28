-- corpgroup.com · 0040 tell the approvers when a statutory deduction is switched on or off
--
-- Decision of 27 Oct 2026: as per BRD §5.3, HR / Payroll keeps the PF, ESI, PT, LWF and TDS switches
-- (Payroll → Structures & statutory) and the Owner / Company Admin approve payroll. So that the approver
-- sees such a change before approving, every active Owner and Company Admin is notified when one of the
-- switches changes (the change itself was already in the audit log). The app also asks for confirmation
-- before a switch is turned off.

create or replace function public.statutory_switch_notify()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_who text; v_changes text[] := '{}';
begin
  if new.pf_enabled is distinct from old.pf_enabled then v_changes := v_changes || ('PF ' || case when new.pf_enabled then 'on' else 'off' end); end if;
  if new.esi_enabled is distinct from old.esi_enabled then v_changes := v_changes || ('ESI ' || case when new.esi_enabled then 'on' else 'off' end); end if;
  if new.pt_enabled is distinct from old.pt_enabled then v_changes := v_changes || ('Professional Tax ' || case when new.pt_enabled then 'on' else 'off' end); end if;
  if new.lwf_enabled is distinct from old.lwf_enabled then v_changes := v_changes || ('Labour Welfare Fund ' || case when new.lwf_enabled then 'on' else 'off' end); end if;
  if new.tds_enabled is distinct from old.tds_enabled then v_changes := v_changes || ('TDS ' || case when new.tds_enabled then 'on' else 'off' end); end if;
  if cardinality(v_changes) = 0 then return null; end if;
  select coalesce(nullif(trim(full_name), ''), email) into v_who from public.profiles where id = auth.uid();
  perform public.notify_roles(new.company_id, array['owner','company_admin'], 'Statutory deduction switched',
    coalesce(v_who, 'Someone') || ' switched ' || array_to_string(v_changes, ', ') || '. It applies from the next payroll run; check it before you approve.',
    '/payroll/setup');
  return null;
end $$;

drop trigger if exists statutory_switch_notify on public.statutory_settings;
create trigger statutory_switch_notify after update on public.statutory_settings
  for each row execute function public.statutory_switch_notify();
