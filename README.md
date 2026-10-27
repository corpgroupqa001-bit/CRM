# corpgroup.com

Multi-company workforce platform built from the *BRD – CRM & Workforce Management Platform* (v0.1, 22 Oct 2026).
This is the **MVP scope**: sign-up/login (AUTH), companies and projects (COM), employees (EMP), biometric attendance and leave (ATT), payroll (SAL), tasks (TSK) and text chat with announcements (COMMS). Voice/video calls (Phase 2) and the CRM add-on (Phase 3) are not built yet.

**Stack:** Next.js 15 (App Router) · Tailwind 4 · Supabase (Postgres + RLS, Auth, Realtime, Storage, Edge Functions, pg_cron) · Nodemailer · react-pdf · SheetJS.

## Setup

1. **Create a Supabase project** in the Mumbai region (`ap-south-1`, NFR-07).
2. **Env vars:** copy `.env.example` to `.env.local` and fill it in.
   ```bash
   openssl rand -hex 32        # OTP_PEPPER
   openssl rand -base64 32     # FIELD_ENCRYPTION_KEY (encrypts PAN / Aadhaar / bank account)
   ```
   Leave `SMTP_HOST` empty in development. OTP and invite emails are then printed to the terminal running `pnpm dev`.
3. **Install and apply the schema:**
   ```bash
   pnpm install
   npx supabase login
   npx supabase link --project-ref <your-project-ref>
   pnpm db:push                # applies supabase/migrations/*
   pnpm functions:deploy       # device webhook Edge Function
   ```
4. In Supabase → **Database → Extensions**, enable `pg_cron`, then run `pnpm db:push` again. This schedules the per-minute attendance job and task reminders.
5. **Optional demo data:** `pnpm seed`, then sign in as `demo@corpgroup.com` / `Demo@1234`.
6. `pnpm dev` → http://localhost:3000

## Switches and extra setup

| Setting (`.env.local`) | What it does |
|---|---|
| `EMAIL_VERIFICATION=off` | Current default. Accounts are created with a password and no verification email (sign-up never creates a company; the Super Admin does, in `/admin`). Because these emails are unverified, sign-up never links to an invited employee record. HR can set or reset any employee's password (Employee → Lifecycle). Set `on` once SMTP works to require emailed codes / verify links |
| `NEXT_PUBLIC_GOOGLE_AUTH=on` | Shows "Continue with Google" (enable the Google provider in Supabase → Authentication first; redirect URL `<app>/auth/callback`) |
| VAPID keys + `PUSH_WEBHOOK_SECRET` | Web push. In Supabase → Database → Webhooks, add a webhook on **INSERT into `notifications`** → POST `<app>/api/push/dispatch` with header `x-webhook-secret: <PUSH_WEBHOOK_SECRET>` |
| `CRON_SECRET` | Protects `/api/cron/reports` (scheduled report emails, run daily by `vercel.json`) |

Other jobs: `pnpm archive:punches --apply` moves raw punches older than 13 months to Storage (also monthly in `.github/workflows/archive.yml`).
Full requirement-by-requirement status: [`docs/BRD-coverage.md`](docs/BRD-coverage.md).
How the system fits together: [`docs/system.md`](docs/system.md). Database schema, RLS, triggers and engines: [`docs/Database Architecture.md`](docs/Database%20Architecture.md).

## Roles and Super Admin

Company roles (one per company, `company_members.role`): **Owner / Administrator**, **HR Manager**, **Finance / Payroll**, **Manager**, **Employee**. What each role can do is the `role_permissions` table (migrations `0018_rbac`, `0019_rbac_decisions`), enforced by RLS and database functions; the app only hides what the database would refuse anyway. Designation and department never grant access. An inactive or exited employee is denied.

**Super Admin** is platform-level and is never granted automatically. Grant it in the Supabase SQL Editor:

```sql
insert into platform_admins (user_id) select id from profiles where email = 'operator@example.com';
-- revoke: delete from platform_admins where user_id = (select id from profiles where email = 'operator@example.com');
```

A super admin opens `/admin` to manage companies (plan, seats, renewal, status) and their administrators, and can **Open** any company to act as its Administrator (employees, roles, settings, payroll view and run). It can't approve or reopen payroll, and it can't make itself a company member. Every company it opens and every change it makes is in that company's audit log, flagged `via_super_admin`.

**Joining a company:** a candidate signs up at `/signup`, choosing their company, designation, department and mobile number. They can't sign in until an Owner / Administrator of that company approves them in **Employees → Sign-up approvals**; approval happens once. The access role starts from the designation's mapping (**Settings → Departments & designations → Access by designation**, Administrators only) and the approver confirms or changes it.

**Switching company** asks for the password again. The first company opened within 10 minutes of signing in opens straight away. The signed cookie uses `COMPANY_LOCK_SECRET` (falls back to `OTP_PEPPER`).

**Removing an employee** (Employee → Lifecycle → Remove employee) ends their access at once and hides them from lists; their attendance and payroll history is kept. A record created by mistake is deleted completely.

**Companies** are created only by the Super Admin (`/admin` → Create a company), with an existing account as Owner. Signing up gives an account with no company access.

**Payroll approval:** an Administrator or Finance / Payroll approves, never the person who ran that version. Finalized payroll is read-only apart from payment status. Only the owner or a company administrator can reopen it, with a reason and the month typed to confirm.

**Leave Management** is outside Phase 1 and is switched off in the database (it is blocked in the API too, not only hidden). To enable it later, once the BRD includes it:

```sql
update platform_features set enabled = true where feature = 'leave';
```

## Email (verification codes and links)

Every verification email (sign-up, login, reset, invite, change of email) contains **a 6-digit code and a one-click "Verify email" button**. Both come from one record: valid 10 minutes, single use, and a resend replaces them. The button opens `/verify/confirm`, and the user confirms with one click there, so link scanners in mail clients can't use up the token.

Sending uses Nodemailer over SMTP. With `SMTP_HOST` empty, emails are printed in the `pnpm dev` terminal. To send real mail, fill `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and `MAIL_FROM` in `.env.local`. For example, Gmail uses `smtp.gmail.com` / port 587 with an App Password, and Brevo uses `smtp-relay.brevo.com` / port 587 with an SMTP key. Then check the settings:

```bash
pnpm email:test you@example.com   # connects, logs in, sends a test email, explains any failure
```

## Trying the main flow

1. Sign up at **/signup**. The 6-digit code appears in the server console; enter it, then set a password.
2. Go to **Settings**: add a branch (with lat/lng if you want mobile punch) and check the **Policies** tab.
3. Go to **Employees → Add employee** (or **Bulk import**). The invite link is printed in the console.
4. Go to **Attendance → Devices** and register a device. Copy the HMAC secret, map the device user ID on the employee, then send a punch:
   ```bash
   BODY='{"punches":[{"device_user_id":"17","timestamp":"2026-10-22 09:02:00"}]}'
   SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "<hmac secret>" | cut -d' ' -f2)
   curl -X POST http://localhost:3000/api/punch -H "x-device-serial: <serial>" -H "x-signature: $SIG" -d "$BODY"
   ```
   The punch shows up on **Attendance → Live** in real time.
5. **Attendance → Month lock** → lock the month. Then **Payroll → Run payroll** → **Approve & lock** → payslip PDF, bank file and statutory exports.

## Tests

```bash
pnpm test        # 225 tests, no Docker or hosted database needed
pnpm lint && pnpm typecheck && pnpm build
```
The tests load the **real migrations** into PGlite (Postgres compiled to WASM). They cover:
- **Payroll:** the four BRD §9 scenarios, the sandwich rule, negative net pay capped at zero with carry-forward (SAL-24), and the lock and reopen guards.
- **Attendance:** device ingestion (HMAC / API key, idempotency, exceptions queue), late marking, 3 lates → half-day, night shifts, regularisation, month lock, mobile geofence, and leave balances.
- **RLS:** tenant isolation and the §4 role matrix.
- **OTP rules:** 10-minute expiry, single use, 5 attempts, 60 s cooldown, 5 per hour.

## Layout

| Path | What |
|---|---|
| `supabase/migrations/` | Schema, RLS policies, attendance engine (`compute_attendance_day`), payroll engine (`run_payroll`), storage, realtime, cron |
| `supabase/functions/punch-webhook` | Device webhook (Edge Function). `src/app/api/punch` is the same thing on Vercel |
| `agent/sync-agent.mjs` | On-site agent for LAN-only devices. Buffers punches and retries |
| `src/app/(auth)` | OTP sign-up, login (password and code), invite activation, reset |
| `src/app/c/[cid]/…` | Company-scoped modules |
| `src/app/owner` | Consolidated view across companies (COM-07/11) |
| `src/lib/auth/otp.ts` | OTP rules (AUTH-06/07) |
| `src/lib/payslip-pdf.tsx` | Payslip PDF, generated on demand |
| `.github/workflows` | CI, migrate on merge, nightly encrypted `pg_dump` backup (NFR-08) |

## Things to settle before go-live

- **Statutory values are placeholders.** PF/ESI rates, Telangana-style PT slabs and the new-regime TDS slabs must be checked with the CA (Payroll → Structures & statutory → "Verified with CA on").
- **CTC is treated as annual gross.** Employer PF/ESI are calculated and reported on top of it, not carved out of it.
- **Rounding:** the BRD rounds each payslip line, which can differ by ₹1 from rounding the total. For scenario 2 that is ₹28,548 vs the BRD's ₹28,549.
- **OTP attempts:** AUTH-07 says 5 wrong attempts invalidate the code; the acceptance example says the 6th. The code follows AUTH-07.
- **Bank file** uses a generic bulk NEFT CSV. Adjust the columns to each bank's upload template.
- **Plans:** Vercel Hobby is non-commercial and Supabase Free has no backups. Upgrade before paying customers (BRD §16).
