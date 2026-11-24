# ERP staff front end

The staff side of the ERP, ported from the original `autoederp` app onto the unified platform. Parent, student and driver portals are a separate piece of work (`apps/web/app/erp/(portal)`, `apps/web/lib/erp-portal`).

## Layout

| Path | What |
|---|---|
| `apps/web/app/erp/(staff)/**` | Every staff screen. `layout.tsx` carries the ERP's own navigation (role-aware, from `lib/erp/nav.ts`). |
| `apps/web/app/erp/login`, `verify/[code]` | Dev sign-in page and the public document verification page. |
| `apps/web/app/api/erp/**` | `dev-login`, `session`, `search`, payroll exports (`payroll/[run]/[kind]`), Tally export (`tally`). |
| `apps/web/lib/erp/**` | Data access, context, capability map, rules glue, report families, insights, automations. |
| `apps/web/components/erp/**` | `ui.tsx`, `client.tsx`, `record-form.tsx`, scoped stylesheet `erp.css` (everything under `.erp`). |
| `scripts/gen-erp-ui.mjs` | Generates `lib/erp/entities.gen.ts` (159 entities: the erp tables from `schema/erp-tables.mjs` plus hand-listed core masters). Drives `/erp/x/[entity]`. |
| `scripts/seed-erp-demo.mjs`, `seed-erp-demo-extras.mjs` | Demo school "Demo Public School" (18 logins, 48 students, fees, timetable, transport, library, store, forms, assessments). |
| `scripts/erp-dev-postgrest.mjs` | Local PostgREST on port 3400 for schemas `erp,core,audit`. |
| `apps/web/e2e/erp-smoke.mjs` | Playwright smoke test (see below). |

## How data access works (decision 51)

Every page and action talks to PostgREST as the signed-in user: `userClient(token)` in `lib/erp/db.ts`, then `core(sb)`, `erp(sb)` or `auditDb(sb)` to pick the schema. Row level security is the only barrier. There is no service key anywhere in the pages. The one exception is the public verify page, which uses a token with the `erp_server` role (`ERP_SERVER_TOKEN`, or signed from `ERP_JWT_SECRET` in development) that can only read what the verify function exposes.

Failed Data API calls are written to the server log as `[erp-data] <status> <path> <body>`, so an empty list is always traceable.

PostgREST cannot embed across schemas, so an erp row that points to a core row (student, staff, section, subject) gets its label from a batched second query: `lookup`, `look` and `options` in `lib/erp/lookup.ts`. Embeds inside one schema work (composite foreign keys).

### Identity and permissions

* One login, one organisation (`core.org_users`), staff record in `core.staff`, ERP role in `core.user_product_access` (`role_key`).
* `getCtx()` (`lib/erp/ctx.ts`) loads the user, organisation, branches, years, role permissions and module flags once per request. `ctx.can(cap, 'read' | 'write')` maps the original ERP capability names to platform permission modules through `lib/erp/caps.ts` (`CAP_MODULES`, kept in step with `schema/erp-roles.mjs`). `requireCap` stops a page for a role without the capability. These checks only decide what to show; the database enforces the same rules.
* The permission matrix editor (`/erp/admin/roles`) translates the original F/B/S/V/O/R/- levels to `core.role_permissions` rows (`levelRows`, `levelOf`) and only rewrites cells that changed. The group admin column is fixed.

### Sign-in

* Production: Supabase Auth (e-mail code, or e-mail and password); the access token is posted to `/api/erp/session`, which stores it in the `erp_token` cookie.
* Local development: `POST /api/erp/dev-login {email}` looks the user up in `auth.users` and signs an HS256 JWT with `ERP_JWT_SECRET`. It answers 404 unless `ERP_AUTH_PROVIDER=dev`. It never runs in production.

Environment variables: `ERP_AUTH_PROVIDER=dev`, `ERP_JWT_SECRET`, `ERP_DATA_API_URL` (plain PostgREST, for example `http://127.0.0.1:3400`; when unset the Supabase URL is used), `ERP_ANON_KEY`, `ERP_SERVER_TOKEN`, `DATABASE_URL` (dev shim only).

## Screens

Role homes (management pulse, teacher My day, office), students (list, 360 with tabs, admission, bulk actions), attendance (board, roll call with offline queue, staff), timetable and substitutions, admissions, wellbeing, homework, assessments and marks grid, report cards, exams, fees (counter, receipts, cheques, dues, reconciliation, structure, concessions), receipt print, HR (staff, bank, leave, payroll, payslips), my profile and payslips, accounting, transport console and live view, driver app, gate, library, store and canteen, messages, inbox, helpdesk, parent-teacher meetings, forms, documents and certificates, approvals, reports (19 families plus CSV export with an export log), insights (rule-based cards and ask-your-data), principal's diary, group console, the admin console (set-up checklist, users and access, roles matrix, settings, rollover, import, audit, automations, adoption, data health), generic list/edit/export screens `/erp/x/[entity]` for every entity, and module hubs `/erp/m/[module]`.

Payroll exports (`/api/erp/payroll/[run]/[kind]`) and the Tally voucher export (`/api/erp/tally`) are plain routes with the same capability checks.

## Changes to the platform database

New migrations (all additive, no existing migration touched):

* `20261118100001_erp_ui_approvals.sql`: `erp.submit_approval`, `decide_approval`, `my_approvals`, `cancel_approval`, `can_decide_approval`, `my_erp_role` over `core.approval_requests` (steps in `data->'steps'`). `decide_approval` also applies leave and attendance-regularisation decisions on the core rows.
* `20261118100002_erp_ui_substitutions.sql`: `erp.substitutions` (fallback when the school has no OS timetable, MAP-TABLES B.11) and the `timetable` product module.
* `20261118100003_erp_ui_export_log.sql`: `erp.log_export` writes `audit.log` action `erp.export`.

`packages/server/test-platform/fixture-erp.ts` has a substitution row for the catalogue tests.

## Running it locally

```
DATABASE_URL=postgres://postgres@localhost:54322/erpui pnpm db:reset:platform      # or: node scripts/db.mjs migrate --platform-only
DATABASE_URL=... node scripts/seed-erp-demo.mjs && node scripts/seed-erp-demo-extras.mjs   # ERP_DEMO_DOMAIN=erp.demo.school when the OS demo school shares the database
DATABASE_URL=... node scripts/erp-dev-postgrest.mjs                                  # port 3400
ERP_AUTH_PROVIDER=dev ERP_DATA_API_URL=http://127.0.0.1:3400 ERP_JWT_SECRET=... DATABASE_URL=... pnpm --filter @autoed/web dev -p 3100
BASE_URL=http://localhost:3100 DATABASE_URL=... node apps/web/e2e/erp-smoke.mjs
```

Demo logins (`@demo.school`): admin (group admin), principal, teacher (class teacher of 1A), teacher2, teacher3, coordinator, accounts, hr, frontoffice, transport, librarian, store, security, driver, nurse, warden, counsellor, parent.

The smoke test signs in as admin and teacher, opens every staff screen the role may see (the admin list also covers every generic entity screen), and fails on page errors, console errors and 5xx. It then drives four flows through the real forms and checks the database: admit a student, mark attendance, collect a fee and open the receipt (voucher posted), run payroll and fetch the bank export.

## Decisions and deviations

* No AI provider: the AI hook (`lib/erp/ai.ts`) is an interface with a no-op implementation (decision 40). Ask-your-data falls back to keyword routing.
* English-only text (decision 55).
* Users and access manages roles and status of existing logins. Creating a login (invitation e-mail) belongs to the platform identity service; there is no invites table in the platform schema.
* Automations: time-based recipes run when an administrator presses "Run now" (attendance not marked, marks deadline, homework posting check, rollover reminder, SLA breach). Event-driven recipes run inside their own screens. Fee reminder ladder, birthday wishes and document expiry from the original are not ported (they need the portal notification channel and the vehicle expiry feed).
* Classroom observations and incidents are OS/core owned and do not appear in the diary or the conduct report.
* Rollover copies sections, moves enrolments and students, marks unpaid fee demands as carried forward and flips the current year. Fee plans, routes and timetable for the new year are created afterwards (the checklist points to them).

## Left to do

* Fee reminder ladder, birthday wishes and document-expiry automations.
* The demo and subscription pages of the original admin console (the platform admin console owns subscriptions).
* Server-action flows beyond the four in the smoke test (cheque bounce, concession approval, TC, leave approval, report-card publish) are typechecked and render, but are not exercised end to end by a script.
* Real-device checks of the geofenced check-in, offline roll call queue and driver live tracker.
