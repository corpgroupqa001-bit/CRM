# BRD coverage — corpgroup.com

Checked against *BRD – CRM & Workforce Management Platform* **v2.0** (26 Oct 2026), 27 Oct 2026, after migrations 0027–0030.
✅ built · ◐ built with a stated limit · ✗ not built (with reason)

Database rules marked † are covered by automated tests (`pnpm test`, 233 tests on the real migrations).

## AUTH — sign-up / login
| ID | Status | Where / note |
|---|---|---|
| AUTH-01 owner sign-up | ✅† | `/signup`: name, email, company name → (email code when verification is on) → password; the account owns the new company (`create_company_for`, 0028) |
| AUTH-02 password rules + lockout | ✅ | 8+ chars, number, special; 5 failures in 15 min lock the login for the company's lock time (15 min default; 30 min, 1 h or 24 h in Settings → Policies, 0041), with "Try again after <time>"; administrator / HR **Unlock now** on the employee's Login & access tab (audited); the lock time has its own Sign-in security box at the top of Settings → Policies (decision of 29 Oct) |
| AUTH-03 passwordless login | ◐ | built; needs SMTP and `EMAIL_VERIFICATION=on` |
| AUTH-04 invitation + activation | ◐ | HR / Payroll and administrators invite (`employees.account`); employees no longer self-register (0028). Email needs SMTP |
| AUTH-05 forgot password | ◐ | other sessions signed out; needs SMTP |
| AUTH-06/07 OTP storage + limits | ✅† | hashed, 10 min, single use, 5 attempts, 60 s cooldown, 5/hour per email and IP |
| AUTH-08 Nodemailer over SMTP | ◐ | built. **OI-05 decided 27 Oct 2026: Brevo** (transactional SMTP). D-03 open: a sending domain with SPF + DKIM is still needed before live; until then a verified single sender is used for testing (`pnpm email:test`) |
| AUTH-09 Supabase session | ✅ | |
| AUTH-10 RBAC in RLS | ✅† | BRD §5.3 matrix in `role_permissions` + `has_perm` (0027); `tests/rbac.test.ts` checks it row by row |
| §5.2 Custom roles | ✅ | Settings → Roles: the Company Admin copies a default role, renames it and ticks module permissions; assign under Users & roles (0037). HR / Payroll view only (Settings R). **Additions by decision (27 Oct):** default roles except Owner can be edited per company, with Reset to standard (0038); the Owner manages roles too (0039). `tests/custom-roles.test.ts` |
| AUTH-11 switch company | ✅ | no new sign-in; membership checked by `my_access` |
| AUTH-12 idle timeout, log out everywhere | ✅ | |
| AUTH-13 change email | ◐ | needs SMTP |
| AUTH-14 2FA (TOTP) | ✅ | |
| AUTH-15 login history | ✅ | user: Account & security; administrators: employee → Lifecycle → Sign-in |
| AUTH-16 Google sign-in | ◐ | set `NEXT_PUBLIC_GOOGLE_AUTH=on` after enabling Google in Supabase Auth |
| AUTH-17 mobile-number OTP | ✗ | Phase 2 (OI-04) |

## COM — companies and projects
| ID | Status | Where / note |
|---|---|---|
| COM-01 owner creates companies | ✅† | sign-up, `/owner` → New company, company switcher; Super Admin can also create one |
| COM-02 … COM-07, COM-10 … COM-14 | ✅ | branches + geofence, departments and designations, projects, calendar, policies, owner dashboard, lists, project detail, exports, saved filters |
| COM-08 subscription | ◐ | plan, seats, renewal per company in `/admin`; no billing |
| COM-09 archive with retention | ✅† | statutory records kept 8 years, other data purged after 90 days (0027) |

## EMP — employees
EMP-01 … EMP-13 ✅ (HR / Payroll has Employees CRUD and invites; system roles stay with Owner / Company Admin). Rejected submits keep everything typed. **Addition by decision (27 Oct):** on Add employee an Owner / Company Admin picks someone from their other companies and adds them (kept in both) or moves them (out of chosen / all companies), copying only basic details (0036). **Addition by decision (28 Oct):** the Owner, Company Admin and HR see which other companies a person works in (Employees list column and filter, employee page), only for companies they can see in full (0047).

## ATT — attendance, leave, work from home
| ID | Status | Where / note |
|---|---|---|
| ATT-01 vendors | ◐ | generic push contract + CSV sync agent; vendor connectors after OI-01 |
| ATT-02 push / pull | ◐ | push ✅†; pull via the sync agent |
| ATT-03 … ATT-16 | ✅† | device registry + offline alert, immutable idempotent punches, exceptions queue, shifts, statuses, OT, late rule, field selfie + geofence, regularisation, live board, month lock (Company Admin unlocks), reports. **Addition by decision (27 Oct):** every employee sees "Who's in today" on the dashboard, Present / Not in yet only, never the reason (0042) |
| ATT-17 … ATT-19 leave | ✅† | switched on (0027) |
| ATT-20 … ATT-35 work from home | ✅† | 0030: requests / approvals / HR ranges, eligibility, live-camera selfie check-in/out, breaks, server time, live timer (home + My attendance) and team board via Realtime, auto-close, WFH report. GPS only when enabled. **Changed by decision (27 Oct), against ATT-32:** one session per WFH day; after check-out Check in is hidden and refused, a mistaken check-out is corrected by a correction request (0043). "Start your break now?" confirmation. **Addition by decision (27 Oct):** checking out before the target shows the time left and requires a reason, which the reporting manager is notified of and sees on the live board (0044) |
| ATT-25 selfie access + retention | ✅ | visible only to HR / Payroll and the reporting manager (employee attendance page → Selfies); deleted after the company retention (default 90 days) by `/api/cron/retention`. **Addition by decision (27 Oct):** they can flag a selfie (wrong person / place); the employee explains; HR or the manager accepts or upholds (0035) |
| ATT-36 missed out-punch | ✅† | after shift end + company grace (default 2 h), unpaid until regularised, employee notified (0029) |

## SAL — payroll
| ID | Status | Where / note |
|---|---|---|
| SAL-01 … SAL-03, SAL-05 … SAL-08, SAL-10, SAL-14, SAL-16 … SAL-20, SAL-22 … SAL-29 | ✅† | all four BRD scenarios tested; statutory rates are configurable placeholders to verify with the CA |
| SAL-09 approval | ✅† | HR / Payroll prepares; Owner or Company Admin approves (not their own run); reopen with reason |
| SAL-12 payslips | ✅ | PDF on demand, optional password, email (SMTP); employees and managers: **My payslips** |
| SAL-04 tax declarations | ◐ | recorded by HR / Payroll; no employee self-declaration yet |
| SAL-11 full and final | ◐ | encashment and recoveries tested; gratuity not verified |
| SAL-13 bank file | ◐ | one generic bulk NEFT CSV; bank-specific formats pending |
| SAL-15 Form 16 Part B | ◐ | Part B figures as Excel |
| SAL-21 auto-recalculate draft | ◐ | re-run with one click after corrections |

## TSK, COMMS, CRM, X
- **TSK-01 … TSK-11** ✅† (Employees create tasks for themselves; HR / Payroll has full Tasks rights).
- **COMMS-01 … 08, 12** ✅† (COMMS-07 push needs the database webhook). **COMMS-09 … 11** ✗ Phase 2. **COMMS-13** ✗ Phase 3.
- **CRM-01 … CRM-22** ✗ Phase 3, deferred under OI-09.
- **X-01** ◐ (email needs SMTP) · **X-02, X-05, X-06** ✅ · **X-03** ✅ attendance reports (day range) and Payroll → Reports (month range, locked runs; the salary register shows the SAL-20 / §7.5.2 calculation in BRD order, statutory columns following the company switches) filter by branch, department and dates; Excel, CSV and PDF downloads match the screen (PF ECR, ESI, PT and the bank file stay whole-company, by decision of 27 Oct) · **X-04** ◐ needs SMTP · **X-07** ◐ no undo · **X-08, X-09** ✗ Phase 2.

## NFR
| ID | Status | Note |
|---|---|---|
| NFR-04 tenant isolation | ✅† | |
| NFR-05 security | ◐ | column encryption, server-only service key; OWASP review to do |
| NFR-06 DPDP | ✅ | consent, privacy notice, data export and deletion requests; Super Admin access only by time-limited grant |
| NFR-07 Mumbai region | ◐ | `vercel.json` pins `bom1`; confirm the Supabase region |
| NFR-08 backups | ◐ | nightly encrypted dump; monthly restore test to record |
| NFR-09 retention | ✅† | 8-year statutory retention, 90-day purge of other data, chat retention, selfie retention |
| NFR-10 mobile PWA | ◐ | PWA, phone bottom bar, AA contrast tokens; full WCAG 2.1 AA audit to do |
| NFR-12 alerts | ◐ | offline devices, punches not saved (incl. rejected key / IP), failed payroll runs and failed background jobs are recorded and alerted in the app, hourly at most (0045); a device without credentials is refused (0046). The 5-minute uptime check is an external service (e.g. UptimeRobot), not configured yet |
| NFR-01/02/03/11 | ◐ | to be measured on the pilot |
