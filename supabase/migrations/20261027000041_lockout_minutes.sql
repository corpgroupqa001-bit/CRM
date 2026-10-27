-- corpgroup.com · 0041 configurable lockout (BRD AUTH-02)
--
-- "Five failed attempts within 15 minutes lock the account for 15 minutes (configurable) or until an
-- administrator unlocks it." The Company Admin chooses the lock time in Settings → Policies (BRD §5.3
-- Settings CRUD). One login can belong to several companies, so the longest lock time among them applies.
-- Unlocking (Owner, Company Admin, HR: employees.account) already exists on the employee's page.

alter table public.companies add column if not exists lockout_minutes integer not null default 15
  check (lockout_minutes in (15, 30, 60, 1440));
