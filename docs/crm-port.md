# CRM port: tables, admission, server, migration

The AutoEd CRM (`Atifisirich/autoedcrm`, 43 tables in schema `autoed`) on the shared platform. Design record:
`docs/adr/crm-port.md`. Mapping source: `docs/MAP-TABLES.md` A.2, B.6, B.7, C.2. Everything here was built and tested on local
Postgres only (nothing in the cloud was touched).

## Files

| File | What |
|---|---|
| `supabase/migrations/20261117000001_crm_config.sql` | CRM modules; `crm.scope_of`, `crm.disabled_branches`, `crm.in_my_team`; RLS helpers `crm.apply_rls_scoped`, `crm.apply_rls_enquiries`; config tables (settings, org_secrets, field_settings, branch_settings, counsellor_settings, roles, intakes, phases, stages, sources, assignment_rules, forms, saved_views, wallet_ledger) |
| `…000002_crm_leads.sql` | households, guardians, prospects, enquiries, enquiry_sensitive, source_touches, activities, follow_ups, visits, applications, enquiry_documents, payments + their policies |
| `…000003_crm_messaging_ops.sql` | campaigns, messages, workflows, workflow_runs, import_batches, import_rows, meta_leads |
| `…000004_crm_functions.sql` | role matrix to `core.role_permissions`, automation user (`crm.provision_org`, trigger on `core.subscriptions`), `crm.system_actor`, `crm.resolve_public`, sensitive-field trigger and `crm.enquiries_full`, `crm.staff_v`, wallet, numbers, audit, consents, push tokens, `private.enqueue_tick_jobs`, `core.can_contact`, `core.student_primary_phone`, `core.upsert_staff` |
| `…000005_crm_admit_student.sql` | `core.admit_student(enquiry)` |
| `…000006_crm_grants.sql` | function grants (everything revoked from PUBLIC first) |
| `packages/crm-server/` | the ported business logic and API (framework-free) |
| `scripts/migrate-crm-to-platform.mjs` | data migration |
| `packages/server/test-platform/fixture-crm.ts`, `crm.test.ts` | harness fixtures (rows for orgs A and B, planted rows for C and D) and the T2/T3/T5 cases for crm |

`node scripts/db.mjs reset --platform-only` (so `pnpm db:reset:platform` and `pnpm test:platform`) applies them with the platform files.

## Table decisions (43 source tables)

| CRM table | Platform | Notes |
|---|---|---|
| tenants | `core.organizations` + `core.subscriptions(crm)` + `crm.settings` | `subdomain` is the slug, `pack` the `preset_key`; `settings`, `flags`, `onboarding`, `webhook_key` (kept, so Meta callbacks keep their key) and `wallet_balance` are in `crm.settings`; the application/receipt counters become `core.number_series` |
| roles | `crm.roles` + `core.roles` + `core.role_permissions` | matrix kept, translated by `crm.role_rows()` |
| users | `core.staff`, `core.org_users`, `core.user_branch_access`, `core.user_product_access(crm)`, `crm.counsellor_settings`, `auth.users`; platform users `core.platform_admins` | auth user id = old user id; `reports_to` = `core.staff.reports_to`; `on_leave` and `daily_capacity` in `crm.counsellor_settings`; no TOTP |
| sessions | not ported | platform sessions |
| branches | `core.branches` + `crm.branch_settings` | hours and visit capacity in the CRM table; `boards` is `text[]` |
| academic_years | `core.academic_years` | org-wide (branch null); dates from the name (Apr 1 to Mar 31) |
| programmes | `core.programmes` (one per branch, board, grade) + `crm.intakes` (per year capacity, minimum age, cut-off) | enquiries keep `board` and `grade` text and get `programme_id` when one matches |
| phases, stages, sources | `crm.phases`, `crm.stages`, `crm.sources` | "Admission confirmed" (`is_won`) is the conversion trigger |
| households, guardians | `crm.households`, `crm.guardians` | `core_household_id`, `core_guardian_id` set on admission, no FK; `mobile` is `phone` (unique per org); consent jsonb is `core.consents` |
| students | `crm.prospects` | name split into first/last, gender `female/male/other`, `core_student_id` set on admission |
| enquiries | `crm.enquiries` | `student_id` is `prospect_id`, `year_id` is `academic_year_id`; sensitive custom values in `crm.enquiry_sensitive` |
| source_touches, activities, applications, visits, payments, campaigns, messages, workflows, workflow_runs, assignment_rules, saved_views, import_batches, import_rows, forms, meta_leads | same names in `crm` | `tasks` is `crm.follow_ups`, `documents` is `crm.enquiry_documents` |
| templates | `core.message_templates` (product `crm`) | `meta_*` columns became `provider_*`; language is a code |
| custom_fields | `core.custom_fields` (product `crm`) + `crm.field_settings` (the sensitive flag) | |
| jobs | `private.jobs` (product `crm`) | queued rows only are migrated |
| audit_events | `audit.log` (`crm.<action>`, detail has `legacy_id`) | |
| notifications | `core.notifications` | `category` is `event_key` |
| api_keys | `core.api_keys` (product `crm`) | `source_id` is the scope `source:<uuid>` |
| webhooks | `core.webhooks` + secret in `crm.org_secrets` (`webhook_secret:<id>`) | non-https URLs are refused by core and reported |
| wallet_ledger | `crm.wallet_ledger` (+ balance in `crm.settings`) | interim, see ADR |
| tickets | `core.support_tickets` (product `crm`) | |
| support_access | not migrated | no `audit.support_access` table yet (reported) |
| tenant_secrets | `crm.org_secrets` | interim for `private.org_secrets`; same APP_SECRET keeps them readable |
| push_tokens | `core.device_tokens` | |

New in the platform for the CRM: `crm.enquiry_sensitive`, `crm.field_settings`, `crm.intakes`, `crm.branch_settings`,
`crm.counsellor_settings`, `crm.settings`, `crm.org_secrets`.

## `core.admit_student(enquiry uuid) returns jsonb`

* **When**: the enquiry's stage has `is_won` (the CRM calls it from `changeStage`, in the same transaction as the stage change,
  so "confirmed" always means "student exists"). Any other stage raises `22023`.
* **Who**: executable by `crm_server` (and `service_role`) only; inside it requires a signed-in staff user of the enquiry's
  org with the CRM product and `applications.edit` for that enquiry (own, team, branch or org scope as `app.can` decides).
  OS and ERP servers and users of other orgs get `42501`; ERP and OS never need the CRM to run.
* **Effect, in one transaction**: match the family (back-link, else any guardian phone in `core.guardians`) or create
  `core.households`; match guardians by phone or create them (primary flag kept, language mapped to en/hi/te); create
  `core.students` with `status 'admitted'`, no admission number (that comes from the number series later), programme matched
  by grade and board; special needs go to `core.student_sensitive`; `core.enrolments` for the enquiry's year;
  `core.student_status_events` (null to admitted); the lead's consents copied to `core.consents` (`guardian`); back-links
  `crm.prospects.core_student_id`, `crm.households.core_household_id`, `crm.guardians.core_guardian_id`; an `audit.log` event
  `crm.admit_student`; and, only if the org has the ERP, a `private.jobs` row (`erp`, `post_admission`).
* **Result**: `{student_id, household_id, guardian_ids, created, household_matched}`.
* **Idempotent**: a second call for the same child returns the same ids with `created: false` and changes nothing; calls are
  serialised per enquiry by an advisory lock. Siblings with the same parent phone land in the same core household.
* Helpers the core stream left open: `core.can_contact(subject_type, subject_id, channel)` (consent read path; no record means
  no), `core.student_primary_phone(student)`, `core.upsert_staff(user, names, email, phone, branch, product, role, ...)`.

## `packages/crm-server`

Framework-free TypeScript like `packages/server/src/api`; connects as `crm_server` (`CRM_DATABASE_URL`) and, for jobs,
`job_runner` (`JOB_DATABASE_URL`). No owner connection, no `service_role`.

| Module | Ported from | Notes |
|---|---|---|
| `db.ts` | `lib/db.ts` | `asUser`, `asSystem`, `resolvePublic`, `asJobRunner`; every request is a transaction with `request.jwt.claims` |
| `auth.ts` | `lib/auth.ts` | verifies the platform session, `loadCtx` (role matrix, branches, years), no passwords or TOTP |
| `core.ts` | `lib/core.ts` | capture and de-duplication, round robin / least load / sticky owner, stages, scoring, SLA, tasks, messages with quiet hours and daily cap, consent, wallet, outbound webhooks |
| `admissions.ts` | `lib/admissions.ts` | application, documents, payments with receipts, seat capacity, confirmation (calls `core.admit_student`) |
| `workflows.ts` | `lib/workflows.ts` | recipes, test runs, steps inside savepoints, waits as `private.jobs`, SLA and no-show sweep |
| `meta.ts`, `secrets.ts` | `lib/meta.ts`, `lib/secrets.ts` | WhatsApp Cloud API, lead ads, template sync, signature check; secrets in `crm.org_secrets` |
| `leads.ts`, `perm.ts`, `migration.ts`, `util.ts`, `totp.ts` | same | list filters over `crm.enquiries_full`; matrix helpers; Appendix B stage map; CSV; TOTP kept only for its tests |
| `jobs.ts` | `app/api/cron` | `runDueJobs` = queue per-org sweep, claim, run as the org's automation user, finish |
| `provision.ts` | `lib/seed.ts` `createTenant` | starter pack (roles, pipeline, sources, templates, recipes, form, year, programmes) |
| `api/index.ts` | `app/api/*`, parts of `app/actions/*` | `handle(req)`: Meta webhook, hosted form, parent application and demo payment links, `/v1` API-key endpoints, cron, `/me`, `/leads`, stage change, message, application, admission, payment, task, simulator |

Environment: `CRM_DATABASE_URL`, `JOB_DATABASE_URL`, `APP_SECRET` (encrypts provider tokens; keep the value the CRM used),
`AUTH_JWT_SECRET` + `AUTH_ISSUER` (platform session), `CRON_SECRET`, `META_GRAPH_VERSION`, `PUSH_DISABLED`, `DEMO_PAYMENTS`, `APP_URL`.

## Tests

* `pnpm test:platform` (harness): crm tables in T1/T7 through the catalogue and `fixture-crm.ts` (rows for orgs A and B),
  plus `crm.test.ts`: T2 (CRM-only org: own rows, zero os/erp), T3 (user granted only OS: zero rows in every crm table, no
  write, no admit, no wallet, no consents), T5 (`crm_server` denied os/erp/audit/billing/private, cannot assume roles, cannot
  call support functions), and `admit_student` across orgs/roles.
* `pnpm test:crm` (`DATABASE_URL` = a scratch database, which is rebuilt; real Postgres, real `crm_server` / `job_runner` logins): the CRM's own **39** tests
  (the task said 35; 20 core + 12 Meta + 4 stage mapping + 3 TOTP) ported unchanged in intent; `platform.test.ts` (admission
  contract, SQL masking, wallet guards, role translation, isolation, subscription-gated cron, consent, `upsert_staff`, and
  the equivalence of the row policies with `app.can()` for seven roles); `migration-script.test.ts` (needs
  `SOURCE_DATABASE_URL`, otherwise skipped).

## Migration run book

`scripts/migrate-crm-to-platform.mjs` reads the CRM schema `autoed` from a source database and loads the platform
(target). It is a migration-style script: it writes as the table owner and refuses Supabase hosts unless `--allow-remote`.

1. **Prepare the platform**: all `*_platform_`, `*_core_master_`, `*_crm_` migrations applied; roles `crm_server`, `job_runner`
   have their passwords set out of band.
2. **Source**: the CRM database (read access is enough). To reproduce the demo locally: `create database crmsource;
   create schema autoed;`, then run the CRM's own boot against it from a checkout with its dependencies installed:
   `DATABASE_URL=postgres://…/crmsource PGOPTIONS='-c search_path=autoed' SEED_DEMO=1 npx tsx scripts/setup-db.ts`
   (the schema file plus `lib/seed.ts`: 2 tenants, 16 users, 207 enquiries, 1240 activities, ...).
3. **Dry run**: `SOURCE_DATABASE_URL=… DATABASE_URL=… APP_SECRET=… node scripts/migrate-crm-to-platform.mjs --dry-run`
   loads everything in one transaction, prints the report and rolls back. Options: `--tenant <id|subdomain>[,..]`,
   `--source-schema autoed`, `--json`, `--no-admit`, `--force-settings`, `--skip-auth-users`.
4. **Run** without `--dry-run`. The report lists, per target table, source rows, new rows and existing rows, then source
   versus target checks (count and md5 of ids plus key columns, sums of payments and wallet). Any difference rolls the whole
   run back and exits 1. After a commit the script analyses the loaded tables (row security makes plans on unanalysed tables
   very slow).
5. **Re-run** any time: ids are preserved and every insert is `on conflict do nothing`, so a second run inserts nothing; settings
   and wallet balance are applied once per org (flag `crm.settings.flags.legacy_migrated_at`).
6. **After**: set the CRM server env (above); point the scheduler at `POST …/cron/crm`; change Meta's callback to
   `…/webhooks/meta/<webhook_key>` (the key is unchanged); create the sign-in for each migrated user in Supabase Auth with the
   same id (the script inserts into `auth.users` itself on local databases; on Supabase use `--skip-auth-users` and the Admin
   API, or let the script copy the bcrypt hash into `encrypted_password` where that column exists); give `crm_server` and
   `job_runner` their passwords. Won enquiries are admitted by the script into `core` (as the automation user); orgs without an
   active CRM subscription are skipped and reported.
7. **Undo (staging)**: `delete from core.organizations where id = '<org>'` cascades through every crm and core table of that client
   (audit history is kept by design).

Result on the demo seed (local): 2 organisations, 14 staff + 2 platform users, 207 enquiries, 32 students admitted into 32
families, all 41 checks OK, second run inserts 0 rows. Passwords of demo users are not usable on the platform unless the bcrypt
hashes are copied (demo: reset).

## Not done / follow-ups

* UI: the ~100 server actions and screens (`app/actions/*`, `app/(app)`, `app/platform`) are not ported; `api/index.ts` covers the
  public endpoints and the main staff actions. Reports, exports (`app/api/export`), search, dedupe merge, DSR, CSV import and
  the admin console (user invites, role editor, pipeline editor, integrations) still need API routes on top of the services
  and tables that exist. `seedDemo` (the demo school with 200 enquiries) is not ported; `seedStarterPack` is.
* Application files: `crm.enquiry_documents.file_id` exists but no upload path (the CRM stored file names only).
* `crm.wallet_ledger`/`org_secrets` move to `billing.wallets`/`private.org_secrets` when the platform creates them.
* Decision 42 (read-only after non-payment) is not modelled for any product.
* The OS leave data is not read for `on_leave` (a manual flag in `crm.counsellor_settings`).
* `crm.harness_probe` stays until the foundation harness drops it.
