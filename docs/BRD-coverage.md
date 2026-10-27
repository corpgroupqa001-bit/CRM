# BRD coverage — corpgroup.com

Checked against *BRD – CRM & Workforce Management Platform* **v2.0** (26 Oct 2026), 27 Oct 2026, after migrations 0027–0030.
✅ built · ◐ built with a stated limit · ✗ not built (with reason)

Database rules marked † are covered by automated tests (`pnpm test`, 228 tests on the real migrations).

## AUTH — sign-up / login
| ID | Status | Where / note |
|---|---|---|
| AUTH-01 owner sign-up | ✅† | `/signup`: name, email, company name → (email code when verification is on) → password; the account owns the new company (`create_company_for`, 0028) |
| AUTH-02 password rules + lockout | ✅ | 8+ chars, number, special; 5 failures in 15 min locks; administrator / HR **Unlock now** on the employee's Lifecycle tab (audited) |
| AUTH-03 passwordless login | ◐ | built; needs SMTP and `EMAIL_VERIFICATION=on` |
| AUTH-04 invitation + activation | ◐ | HR / Payroll and administrators invite (`employees.account`); employees no longer self-register (0028). Email needs SMTP |
| AUTH-05 forgot password | ◐ | other sessions signed out; needs SMTP |
| AUTH-06/07 OTP storage + limits | ✅† | hashed, 10 min, single use, 5 attempts, 60 s cooldown, 5/hour per email and IP |
| AUTH-08 Nodemailer over SMTP | ◐ | built; needs SMTP credentials (`pnpm email:test`) |
| AUTH-09 Supabase session | ✅ | |
| AUTH-10 RBAC in RLS | ✅† | BRD §5.3 matrix in `role_permissions` + `has_perm` (0027); `tests/rbac.test.ts` checks it row by row |
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
EMP-01 … EMP-13 ✅ (HR / Payroll has Employees CRUD and invites; system roles stay with Owner / Company Admin). Rejected submits keep everything typed.

## ATT — attendance, leave, work from home
| ID | Status | Where / note |
|---|---|---|
| ATT-01 vendors | ◐ | generic push contract + CSV sync agent; vendor connectors after OI-01 |
| ATT-02 push / pull | ◐ | push ✅†; pull via the sync agent |
| ATT-03 … ATT-16 | ✅† | device registry + offline alert, immutable idempotent punches, exceptions queue, shifts, statuses, OT, late rule, field selfie + geofence, regularisation, live board, month lock (Company Admin unlocks), reports |
| ATT-17 … ATT-19 leave | ✅† | switched on (0027) |
| ATT-20 … ATT-35 work from home | ✅† | 0030: requests / approvals / HR ranges, eligibility, live-camera selfie check-in/out, breaks, server time, live timer (home + My attendance) and team board via Realtime, auto-close, WFH report. GPS only when enabled |
| ATT-25 selfie access + retention | ✅ | HR / Payroll and the reporting manager; deleted after the company retention (default 90 days) by `/api/cron/retention` |
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
- **X-01** ◐ (email needs SMTP) · **X-02, X-05, X-06** ✅ · **X-03** ◐ filters differ per report · **X-04** ◐ needs SMTP · **X-07** ◐ no undo · **X-08, X-09** ✗ Phase 2.

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
| NFR-01/02/03/11/12 | ◐ | to be measured on the pilot; uptime check not configured |
