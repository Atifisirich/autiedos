# CRM front end and API (plan phase 5)

The AutoEd CRM screens now live in the unified web app at `/crm`, on top of `packages/crm-server`. Everything the original Next 16 app did
with server actions is an API call through one route handler; every call runs in the database as the signed-in person (`crm_server`
login plus `request.jwt.claims`, no owner connection). Design record for the back end: `docs/adr/crm-port.md`, `docs/crm-port.md`.

## How a request flows

```
browser (apps/web/app/crm/**, components/crm/**, lib/crm/api.ts)
  -> /api/crm/[...path]            apps/web/app/api/crm/[...path]/route.ts   (cookie `os_session` -> Authorization: Bearer)
     -> handle(req)                packages/crm-server/src/api  (router.ts + index.ts, session.ts, staff.ts, admin.ts, data.ts, public.ts)
        -> asUser / asSystem       packages/crm-server/src/db.ts  (transaction, request.jwt.claims, RLS decides)
```

* **Who may do what** is decided twice: the person's CRM role matrix (`perm.ts` helpers, for example `canEditLeads`) refuses with a readable
  403, and the row policies decide which records exist for them. Reads run as the person (`asMe`). A write first loads the record as the
  person (a colleague's private record is a 404) and then runs as the org's automation user with the person named as actor (`onEnquiry`
  in `staff.ts`). Edits to the family record itself (details form) and every admin write run as the person, so masking and scope are
  enforced by the database on each statement.
* **Product check**: `loadCtx` returns nothing (so `403 no_crm_access`) unless `app.user_has_product(org, 'crm')`; `asSystem` refuses
  an org without an active CRM subscription (`crm_not_active`). This is `needProduct('crm')` of the plan.
* **Session**: the platform session token (HS256, `AUTH_JWT_SECRET`, issuer `AUTH_ISSUER`, claim `sid`), the same one the OS issues.
  The cookie is the OS cookie `os_session`, so one sign-in covers both products. `POST /auth/dev-login` (only with `AUTH_PROVIDER=dev`)
  signs in by email for demos and tests; `POST /auth/session` exchanges a Supabase Auth access token (phone or email OTP) for the
  platform session; `GET /auth/provider` tells the login screen which to offer. Sessions are rows `session:<sid>` in
  `core.device_tokens` (own row, own claims), revocable per device (`/account`) or all at once when an admin pauses a user.
* The year and branch pickers travel as headers `x-crm-year` and `x-crm-branch` (stored in the browser, `lib/crm/api.ts`).

## Screens (apps/web/app/crm)

| Route | Original | Notes |
|---|---|---|
| `/crm` My day | `(app)/page.tsx` | tasks (overdue / due now / later), awaiting first response, visits today, unread replies, team table for heads |
| `/crm/leads` | `leads/*` | table (columns, dense, bulk bar with select-all-matching, CSV export), cards, **Kanban** (drag, plus a "move to" select for keyboard and touch), phase and stage tabs, chips, filters, saved views, pagination |
| `/crm/households/[id]` | `households/[id]` | 360: stage, score breakdown, next action, action bar (call, message, note, task, visit, stage, form and payment, reassign), timeline with filters, tasks, details form (masked sensitive values), visits, application, source touches, consent, add sibling |
| `/crm/inbox` | `inbox` | WhatsApp threads, 24 hour window, templates, internal notes, close and reopen, demo "parent reply" (not in production) |
| `/crm/tasks` | `tasks/*` | list tabs, mine and team, month calendar with drag to reschedule |
| `/crm/visits` | `visits` | front-desk check-in, outcomes, coming up |
| `/crm/applications`, `/[id]` | `applications/*` | queue with offline payments awaiting accounts, review page: answers, documents verify or reject, payments, decision and confirm admission |
| `/crm/campaigns` | `campaigns` | draft, audience count and cost, send, results to admissions |
| `/crm/reports` | `reports` | every number links to the filter that lists the same records; per table CSV |
| `/crm/walkin` | `walkin` | front desk mode |
| `/crm/account` | `account` | profile and devices (passwords and two-factor stay with the platform sign-in) |
| `/crm/admin` and `/crm/admin/[section]` | `admin/*` | organisation (profile, branches, years, rollover, seats), users (invite, edit, pause, sign out), roles (matrix editor, clone), fields (sensitive switch), pipeline (stages, order, retire with mapping, import stage mapping), sources, routing (rules, simulator, scoring), templates, forms, workflows (editor, test run, recipes), integrations (Meta setup, API keys, webhooks), wallet, data (CSV import, review queue, undo, duplicate families and merge, access and erasure requests), audit log, help |
| `/crm/f/[slug]`, `/crm/apply/[token]`, `/crm/pay/[token]`, `/crm/login` | `f`, `apply`, `pay`, `login` | public, no frame; the payment simulator buttons exist only when the server runs with `DEMO_PAYMENTS=1` |

The layout `app/crm/layout.tsx` is a plain wrapper (styles). The signed-in frame (menu, search, pickers, quick add, alerts) is
`app/crm/(app)/layout.tsx` and `components/crm/shell.tsx`; the lead integrating the product switcher replaces that file's chrome.

Quality: English literals (decision 55); keyboard (`n` quick add, `/` or Ctrl+K search), dialogs are native `<dialog>` (focus trap,
Escape), skip link, one `main`, names on every field and button (checked by the script below), sideways scrolling checked at 390 px.
Colours are Tailwind `teal` and `slate` pairs chosen for AA contrast; the CSS is `app/crm/crm.css` scoped under `.crm`.

## API added in this stream (packages/crm-server/src/api)

`router.ts` (router, `who`, `asMe`, `asOrg`, `need`, `fail`), `session.ts` (auth, `/shell`, notifications, `/account`), `staff.ts` (everything
the working screens need), `admin.ts` (`/admin/*`), `data.ts` (reports, export, search, duplicates and merge, import, data-subject tools),
`public.ts` (form, pay and apply page data). Ported unchanged in behaviour from `app/actions/*`; changes worth knowing:

* **Reports with drill-down**: `GET /reports?by=` and `GET /reports/export?table=` (sources, team, branches, seats, reasons, funnel; audited). New
  list filters make every KPI reproducible (`contacted`, `visited_applied`, `wait`, `reenq`) next to the existing ones.
* **CSV export** `GET /export` is permission checked (`bulk` F, T or Part), formula safe, watermarked and audited.
* **Search** `GET /search`, **duplicates** `GET /data/duplicates`, **merge** `POST /households/:id/merge` (needs `delete` F, T or Merge only; the same
  child twice keeps one open enquiry, the other is closed as duplicate; consents and history move; the empty household is removed).
* **CSV import** `POST /admin/import` (the CSV text travels in the JSON body), review queue, **undo**, failed rows as CSV, Appendix B stage mapping.
* **Data-subject tools** `GET /admin/dsr/access`, `POST /admin/dsr/erase` (group admin only, type ERASE, audited).
* **User invites** `POST /admin/users` (creates the sign-in through Supabase Auth's invite API when `SUPABASE_URL` and
  `SUPABASE_SERVICE_ROLE_KEY` are set, or a local login with `AUTH_PROVIDER=dev`; then `core.upsert_staff`, extra branches, capacity and leave),
  pause or reactivate and sign out everywhere.
* **Role editor** `/admin/roles` (the matrix is rewritten into `core.role_permissions` by the existing trigger; the Group Admin role cannot be weakened), **pipeline
  editor** `/admin/stages*`, API keys and webhooks (`core.api_keys`, `core.webhooks`, secrets in `crm.org_secrets`), templates (`core.message_templates`),
  forms, workflows editor, wallet view, audit log.

Migration `supabase/migrations/20261126000001_crm_ui.sql` adds only what a product role cannot do with table access: `crm.audit_events` (the audit
log; `crm_server` has no grant on schema `audit`), `crm.set_user_active`, `crm.set_user_branches`, `crm.revoke_user_sessions`,
`crm.delete_empty_household`, a delete policy so people can remove their own saved views, and two local-only helpers
(`crm.dev_user_by_email`, `crm.dev_create_login`) that refuse to run when `auth.users` is Supabase's. Every function re-checks org, product and permission.

### Deviations from the original, with reasons

* `crm.payments.status` has no `awaiting_verification`: an offline payment is `pending` with a non-link mode, and the queue is that.
* `crm.households.inbox_status` is `open` or `closed`: "waiting on parent" is derived from who wrote last.
* Internal notes in the inbox are `crm.messages` rows with `is_note` and status `sent` (the table has no `note` status).
* Documents: only the file name is recorded (as in the original); `crm.enquiry_documents.file_id` is unused until the platform has an upload path.
* Parent and payment links are `/crm/apply/<token>` and `/crm/pay/<token>` (`CRM_PUBLIC_PREFIX`, `APP_URL`).
* Two-factor and passwords are the platform's, so those parts of the original account and admin screens are not ported.
* Data-subject requests are done on the CRM tables. The compliance tooling (`packages/server/src/compliance`, person export and erase
  across products, run as `platform_admin_server`) is present but not wired in: the CRM server has no connection of that role. Erasing
  an admitted child's `core.students` record still goes through those tools (the erase response says so).

## Running it

```
DATABASE_URL=postgres://postgres@localhost:54322/crmui pnpm db:reset:platform        # platform-only build (platform, core master, compliance, crm, erp)
# web app, CRM environment:
DATABASE_URL=… CRM_DATABASE_URL=postgres://crm_server@localhost:54322/crmui JOB_DATABASE_URL=postgres://job_runner@localhost:54322/crmui \
  AUTH_PROVIDER=dev AUTH_JWT_SECRET=x DEMO_PAYMENTS=1 PUSH_DISABLED=1 APP_URL=http://localhost:3217 pnpm --filter @autoed/web start -- -p 3217
cd apps/web && npx tsx e2e/crm-seed.mts                      # Greenfield Demo School: admin@, meera@, rahul@, desk@, accounts@demo.test
BASE_URL=http://localhost:3217 node e2e/crm-e2e.mjs                                   # quick add, duplicates, 360, tasks, visits, stages, public form, walk-in, admin, import, reports, API key
BASE_URL=http://localhost:3217 DATABASE_URL=… node e2e/crm-e2e-admissions.mjs         # application to confirmed admission (core student), parent pages, payments, inbox, campaign, Kanban, rollover, masking
BASE_URL=http://localhost:3217 node e2e/crm-shots.mjs                                 # every screen at 1280 and 390 px: screenshots in OUT_DIR (/tmp/crm-shots), name, landmark and overflow checks
pnpm test:crm                                                                          # real Postgres: 117 server tests including api-staff and api-admin
```

Playwright is taken from the project when installed there, else from `/opt/node-tools` (`e2e/crm-lib.mjs`); no dependency was added.

## Not done

* The mobile gateway of the original (`app/api/m/[...path]`) is not ported; the mobile app keeps using the endpoints in this API where they exist.
* File upload for application documents (names only), a real payment gateway, telephony, SMS and email providers (simulated, as before).
* Scheduled jobs: the worker entry is `GET|POST /api/crm/cron/crm` with `CRON_SECRET`; a scheduler has to call it (nothing is deployed from here).
* Hindi and Telugu for the CRM screens (decision 55).
* The compliance tooling wiring described above, and the platform console's support-access request flow for the CRM (the help screen lists the
  `core.support_sessions` of the school read-only).
* `next lint` for `apps/web` does not run in this checkout (`@eslint/eslintrc` is imported by `eslint.config.mjs` but not declared); the CRM code is
  covered by `tsc` and `next build`.
