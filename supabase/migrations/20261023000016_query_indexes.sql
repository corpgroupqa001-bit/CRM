-- corpgroup.com · 0016 indexes for the queries that run on every dashboard load (and the pages around it).
-- Already present and kept: employees (company_id, status), employees (company_id, department_id / branch_id),
-- holidays (company_id, date), tasks (company_id, status), payslips (employee_id, month),
-- punches_raw unmapped (company_id) partial, payroll_runs unique (company_id, month, version).
--
-- Plain CREATE INDEX briefly blocks writes on the table while it builds — fine at pilot size. On a large
-- production table run each statement on its own as CREATE INDEX CONCURRENTLY (not inside a transaction).

-- daily_attendance: "Company today" and the 14-day trend read employee_id + status for a company and a date range.
-- Covering the two columns lets Postgres answer from the index alone; it replaces the plain (company_id, date) index.
create index if not exists daily_attendance_company_date_cover
  on public.daily_attendance (company_id, date) include (employee_id, status);
drop index if exists public.daily_attendance_company_id_date_idx;

-- employees: no new index. The existing (company_id, status) / (company_id, branch_id) indexes already
-- serve the dashboard's company listing; with realistic data the planner prefers them (checked in tests).

-- approvals badge: pending leave and pending attendance corrections per company
create index if not exists leave_requests_company_pending on public.leave_requests (company_id) where status = 'pending';
create index if not exists regularisations_company_pending on public.regularisations (company_id) where status = 'pending';

-- overdue tasks: open tasks with a due date, per company (also used by the reminder job)
create index if not exists tasks_company_open_due on public.tasks (company_id, due_at) where status <> 'done' and due_at is not null;

-- HR cards: offline devices, documents expiring soon
create index if not exists devices_company_status on public.devices (company_id, status);
create index if not exists employee_documents_company_expiry on public.employee_documents (company_id, expiry_date) where expiry_date is not null;

-- announcements card: latest first per company
create index if not exists announcements_company_created on public.announcements (company_id, created_at desc);

-- bell badge in the top bar on every page: unread, non-chat notifications per user
create index if not exists notifications_user_unread on public.notifications (user_id) where read_at is null and kind <> 'chat';

-- leave balance card / leave page: approved and pending leave per employee and type
create index if not exists leave_requests_employee_type_status on public.leave_requests (employee_id, leave_type_id, status);

analyze public.daily_attendance, public.employees, public.leave_requests, public.regularisations, public.tasks,
        public.devices, public.employee_documents, public.announcements, public.notifications;
