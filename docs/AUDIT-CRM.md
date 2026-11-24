# AUDIT-CRM.md — Phase 1 discovery (read-only), 2026-11-24

Read-only. Nothing was written to `autoed-crm-mumbai`, the CRM repo or Vercel. Row counts are aggregates; no personal data was read.

## 1. CRM repository (`Atifisirich/autoedcrm`, public, cloned shallow)

* Next.js 16 + React 19 app (`app/`, `lib/`, `components/`), Expo mobile app (`mobile/`), 35 tests (vitest), CI + Android APK workflows.
* **Single schema file** `db/schema.sql` (588 lines, 43 tables, all `create table if not exists`), applied on app boot. No migration history.
* **Own tenancy**: `tenants` -> `branches`; every row carries `tenant_id`. (OS uses `organizations` -> `branches`; names and column names differ.)
* **Own authentication**: its own `users` + `sessions` tables, bcrypt passwords, TOTP two-factor. It does **not** use Supabase Auth (`auth.users` has 0 rows).
* **Database access**: the server connects directly with `DATABASE_URL` as the **database owner**; RLS is enabled on every table only so the Supabase Data API exposes nothing. Tenant, branch, record and field scoping is done in application code (`lib/perm.ts`, `lib/guard.ts`). So the CRM has no database-level tenant isolation today (plan rules 1, 3, 8 do not hold for it yet).
* Env vars: `DATABASE_URL`, `APP_SECRET` (encrypts Meta tokens at rest), `APP_URL`, `CRON_SECRET`, `SEED_DEMO`, `DEMO_PAYMENTS`, `PUSH_DISABLED`, `META_GRAPH_VERSION`, `DB_POOL_MAX`, `FORCE_SCHEMA`.
* Integrations: Meta WhatsApp Cloud API and lead ads (per-tenant tokens in `tenant_secrets`), Expo push. SMS/email/payments are simulated. File storage is **not** connected (only file names are stored).
* Scheduler: `GET /api/cron` with `CRON_SECRET`, plus run-on-page-load.
* Not built in CRM (per its README): parent portal, helpdesk, fee plans/concessions, AI, file storage.

## 2. Supabase `autoed-crm-mumbai` (ap-south-1, Postgres 17, ACTIVE)

The 2026-11-16 note ("no tables") is out of date. It now has a populated **`autoed` schema** with the 43 CRM tables, RLS on, and `supabase_migrations` history empty (schema was applied by the app, not by migrations).

| Tenant | Created | Users | Students | Messages | Last activity |
|---|---|---|---|---|---|
| Greenfield Schools | 2026-11-16 | 13 | 207 | 45 | 2026-11-16 |
| Little Oaks Pre-school | 2026-11-16 | 1 | 0 | 0 | none |

Other row counts: enquiries 207, households 193, guardians 193, activities 1246, tasks 286, visits 109, applications 65, documents 325, payments 89, templates 40, workflows 32, audit_events 2, wallet_ledger 7. Both tenant names and the README's seed ("Greenfield demo group") match the **demo seed**, and nothing has happened since 2026-11-16, so this looks like demo data, not live clients. **Owner must confirm (Q2).**

Other projects: `autoedcrm` (Seoul) and `intake-by-digivate` (Mumbai) are paused/INACTIVE; not inspected.

## 3. Vercel (team `atif60002-9526s-projects`)

Projects: `autoed-crm` (Next.js, Node 22, latest production deployment READY, updated recently), `leadbricks`, `akber-khan-developers`, `v0-hothabitwebsite1` (the last three look unrelated). Plan is Hobby (per plan doc).

## 4. Consequences for the platform plan

1. CRM -> platform is a real port, not a rename: auth model (own users -> Supabase Auth + `core.memberships`), DB role (owner -> `crm_server`), tenancy (`tenant_id` -> `org_id`), schema (`autoed` -> `crm` + `core`), and RLS policies must be written (today they only block the Data API).
2. Candidates for `core`: `tenants`, `branches`, `academic_years`, `users` (staff), `students`, `guardians`/`households`, `programmes`/`phases`/`stages`. Candidates that stay in `crm`: enquiries, activities, tasks, visits, applications, documents, payments, templates, campaigns, messages, workflows, jobs, sources, forms, wallet_ledger, Meta/push tables. Table-by-table decision list comes in Phase 2 once Q1, Q13, Q14 are answered.
3. CRM `students` are created at enquiry time (207 students for 207 enquiries), whereas the plan says `core.students` are created only when admission is confirmed. This conflicts with plan §4.5 and needs a decision (Q13).
4. Because the CRM has no migration history, the data migration script (plan §6.4) can read directly from `autoed.*`.
