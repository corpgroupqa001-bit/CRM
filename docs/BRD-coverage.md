# BRD coverage — corpgroup.com

Checked against *BRD – CRM & Workforce Management Platform* v0.1 (22 Oct 2026), 23 Oct 2026.
✅ built · ◐ built with a stated limit · ✗ not built (with reason)

Database rules marked † are covered by automated tests (`pnpm test`, 221 tests on the real migrations).

## AUTH — sign-up / login
| ID | Status | Where / note |
|---|---|---|
| AUTH-01 owner sign-up | ⛔ changed on request | `/signup` is a candidate sign-up: company + designation + details → request; an Administrator of that company approves once (role suggested by designation, confirmed by the admin). Companies are created by the Super Admin in `/admin` (0020, 0021). Switching company asks for the password again |
| AUTH-02 password rules + lockout | ✅ | 8+ chars, number, special; 5 failures in 15 min locks |
| AUTH-03 passwordless login | ✅ | `/login` → Email code (only when verification is on) |
| AUTH-04 employee invite + activation | ✅ | Employee → Send invite → `/activate`; HR can also create the login directly (Employee → Lifecycle → Login password) |
| AUTH-05 forgot password | ✅ | Emailed code when verification is on; otherwise HR/admin sets a new password |
| AUTH-06/07 OTP storage + limits | ✅† | hashed, 10 min, single use, 5 attempts, 60 s cooldown, 5/hour per email and IP; plus one-click verify link |
| AUTH-08 Nodemailer over SMTP | ◐ | built; needs SMTP credentials in `.env.local` (`pnpm email:test`) |
| AUTH-09 Supabase session | ✅ | |
| AUTH-10 RBAC in RLS | ✅† | every table; §4 matrix in `role_permissions` + `has_perm` (0018), Finance role, DB-backed Super Admin, `/denied` for direct URLs; `tests/rbac.test.ts` (10 acceptance criteria) + cross-tenant tests. Leave off at the database (`platform_features`); Super Admin acts as Administrator (audited); payroll maker-checker (0019) |
| AUTH-11 company switcher | ✅ | sidebar |
| AUTH-12 idle timeout, log out everywhere | ✅ | 30 min; Account & security |
| AUTH-13 change email | ✅ | Account & security |
| AUTH-14 2FA (TOTP) | ✅ | Account & security → authenticator app; enforced at sign-in |
| AUTH-15 login history | ✅ | Account & security |
| AUTH-16 Google sign-in | ◐ | built; set `NEXT_PUBLIC_GOOGLE_AUTH=on` after enabling Google in Supabase Auth |

## COM — companies and projects
| ID | Status | Where / note |
|---|---|---|
| COM-01 multiple companies + statutory IDs | ✅ | created by the Super Admin (`/admin`); owners see all theirs in `/owner`; Settings → Company |
| COM-02 branches + geofence | ✅ | Settings → Branches |
| COM-03 departments, designations | ✅ | Settings |
| COM-04 projects | ✅ | Projects (extra module beyond the five fixed ones): Administrator full, Manager runs projects they lead, members read, Finance none |
| COM-05 FY, weekly offs, holidays per branch | ✅ | Settings → Policies / Holidays |
| COM-06 policies | ✅ | shifts, attendance, leave, payroll settings |
| COM-07 owner consolidated dashboard | ✅ | `/owner` |
| COM-08 subscription per company | ◐ | plan, seats, renewal shown per company and edited in the Super Admin console (`/admin`); no payment gateway |
| COM-09 archive with retention | ✅† | archive → purged after 90 days |
| COM-10 project cost view | ✅ | Project → Time & cost |
| COM-11/12/13 lists and project detail | ✅ | |
| COM-14 pagination, export, saved filters | ✅ | Employees and Projects; companies export on `/owner` |

## EMP — employees
EMP-01 … EMP-13 ✅: bulk import with row errors, auto code, all profile fields, encrypted PAN/Aadhaar/bank, device ID mapping, documents with expiry **reminders** (daily job), **org chart**, self-service with HR approval, lifecycle incl. **transfer to another company**, deactivation, directory, **assets**.

## ATT — attendance and leave
| ID | Status | Where / note |
|---|---|---|
| ATT-01 vendors | ◐ | one generic push contract (JSON + HMAC / API key) and CSV import work with any device; vendor-specific connectors (eSSL, ZKTeco, Matrix protocols) wait for the launch customers' device list (BRD §18 open question) |
| ATT-02 push / pull ≤ 1 min | ◐ | push webhook ✅†; pull = on-site sync agent reading the vendor tool's CSV export, plus a per-minute job |
| ATT-03 … ATT-19 | ✅† | device registry + offline alert, immutable idempotent punches, exceptions queue, shifts incl. night, all statuses, first-in/last-out/OT, 3 lates → half-day, selfie + geofence, regularisation, live dashboard, month lock, reports (muster, summary, **late-comers, overtime**; Excel and PDF), leave types with accrual and **year-end carry-forward**, apply/approve, LOP to payroll |

## SAL — payroll
| ID | Status | Where / note |
|---|---|---|
| SAL-01 … SAL-14, SAL-17 … SAL-29 | ✅† | all four BRD scenarios tested; **password-protected payslips** (Settings → Policies); bank NEFT CSV, PF ECR, ESI, PT, TDS, CTC vs actual, department cost |
| SAL-12 / employee payslip view | ⛔ by decision | Employees and Managers have no payroll access until approved; payslips are viewed in Payroll and can be emailed by Finance / Administrator |
| SAL-04 tax regime + declarations | ◐ | Recorded and verified in Payroll → Tax by Finance / Administrator, HR views; old-regime deductions reduce TDS. Employee self-declaration is off until approved |
| SAL-15 Form 16 Part B | ◐ | Part B figures per employee as Excel (Payroll → Form 16 Part B); the signed TRACES PDF is out of scope |
| SAL-16 accounting journal | ✅ | Payroll run → Accounting journal (CSV for Tally / Zoho Books) |
| SAL-21 auto-recalculate draft | ◐ | payroll runs only on locked attendance (SAL-22), so a draft is re-run with one click after corrections |
| statutory rates | ◐ | configurable placeholders — verify with the CA before go-live |

## TSK — tasks
TSK-01 … TSK-11 ✅†: list / board / calendar, comments with @mentions, attachments, activity, reminders, reports, **sub-tasks, checklists, dependencies, recurring tasks, timer and time logs, templates**, chat message → task.

## COMMS — chat and calls
| ID | Status | Where / note |
|---|---|---|
| COMMS-01 … COMMS-06, COMMS-08 | ✅† | 1:1, groups, auto channels, files ≤ 25 MB, **voice notes, link previews**, receipts, typing, presence, **reply, forward, pin, star**, edit 15 min, delete, search, announcements with acknowledgement |
| COMMS-07 push, mute, DND | ◐ | mute and quiet hours ✅; web push built — needs the Supabase database webhook (README → Push) |
| COMMS-12 admin controls | ✅† | Settings → Chat: cross-department DMs, retention, compliance export |
| COMMS-09/10/11 voice & video calls | ✗ | Phase 2 per BRD (needs TURN service / provider SDK decision) |
| COMMS-13 click-to-call | ✗ | Phase 3 CRM add-on |

## CRM add-on
CRM-01 … CRM-22 ✗ — Phase 3 and "Could" until the add-on is confirmed (BRD §12); excluded from this build by agreement.

## Cross-module (X)
| ID | Status | Note |
|---|---|---|
| X-01 notification centre + preferences | ◐ | in-app, push and email preferences per event type; SMS / WhatsApp need a provider |
| X-02 role dashboards | ✅ | charts for attendance trend and headcount |
| X-03 filters + Excel / CSV / PDF | ✅ | PDF via "Save as PDF" print layout |
| X-04 scheduled reports | ◐ | built (Settings → Scheduled reports, daily Vercel cron); needs SMTP |
| X-05 audit log | ✅† | |
| X-06 global search | ✅ | ⌘K |
| X-07 bulk actions | ◐ | bulk approve / reject for leave and corrections; undo not provided |
| X-08 Hindi / Telugu | ✗ | Phase 2 |

## NFR
| ID | Status | Note |
|---|---|---|
| NFR-04 tenant isolation | ✅† | |
| NFR-05 security | ✅ | column encryption, service role server-only, SSRF-safe link previews, 2FA |
| NFR-06 DPDP | ✅ | consent at sign-up / activation, privacy notice, download my data, deletion requests |
| NFR-07 Mumbai region | ◐ | `vercel.json` pins `bom1`; choose Mumbai when creating the Supabase project |
| NFR-08 backups | ✅ | nightly encrypted `pg_dump` workflow |
| NFR-09 retention | ✅ | chat retention, 90-day company purge, 13-month punch archive to Storage |
| NFR-10 mobile PWA | ✅ | installable, push; full WCAG 2.1 AA audit still to do |
| NFR-01/02/03/11/12 | ◐ | to be measured on the pilot; uptime ping not configured |
