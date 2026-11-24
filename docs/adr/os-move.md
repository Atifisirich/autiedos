# ADR: Moving AutoEd OS onto the shared platform (plan phase 3, section 5)

Status: accepted (2026-11-24). Related: ADRs 001-005, `core-master-001`, `ai-gemini.md`, `docs/platform-foundation.md`.

## Context

The OS was built as a standalone schema in `public` (6 migrations, 128 tables) with its own `app.apply_rls`,
`app.can`, `app.my_org_id`, storage policy and a server that ran `set role authenticated`. The platform now owns
identity, orgs, master data, billing, audit and jobs. The OS has to sit on it as one product among three.

## Decision

### Migrations

The 6 legacy files are deleted and replaced by an OS stream `20261116000001-5_os_*.sql`:

| File | Contents |
| --- | --- |
| `_os_foundation` | OS permission modules in `core.product_modules`; `os.roles`, `os.role_permissions`, `os.staff_roles`, `os.reporting_lines`, `os.module_flags`; permission functions (`os.check_perm`, `os.can`, `os.has_permission`, `os.my_permissions`, ...) |
| `_os_access` | derived platform roles (`os.sync_access`), the OS system actor, dev login, staff login provisioning, config history |
| `_os_tables` | every table MAP-TABLES assigns to `os` (and nothing else) |
| `_os_ai_settings_jobs` | `core.platform_settings`, `core.ai_generations`, billing AI wallet tables and `app.ai_*` functions, OS plans, `private.jobs.dedupe_key`, `os.enqueue_job` |
| `_os_policies` | all os table policies and the OS policies on shared core tables |

`20261124100000_gemini_settings.sql` now upserts the global (`org_id is null`) `ai_models` row of `core.platform_settings`.
Everything else the OS used maps to `core.*` (staff, students, programmes, sections, subjects, attendance, leave,
approvals, tickets, incidents, notifications, files, support sessions, ...), with the column renames applied in code
(e.g. `class_id` -> `programme_id`).

### Removed clashes

No OS migration defines `app.apply_rls` (6-arg), `app.can` (7-arg), `app.drop_policies(text)`, `app.my_org_id`,
`app.touch_updated_at` or the `os_files_rw` storage policy. Storage is governed only by the platform
`platform_files_*` policies (`app.user_has_product(org, product)`).

### RLS

* Every os table gets the platform baseline `app.apply_rls(schema, table, kind, 'os', module)`.
* On top, permissive OS policies `os_sel/os_ins/os_upd/os_del` call `os.can()` (port of the legacy `check_perm`:
  staff-based scopes own/team/department/wing/branch/group). Every OS policy also requires
  `app.user_has_product(org_id, 'os')`.
* Restrictive policies: `os_module_on` (module flags), question-paper confidentiality, hiding one's own appraisal
  draft, and `confidential` on `core.incidents` (applies across products).
* OS policies on core tables (staff attendance, leave, approvals, tickets, class posts, ...) go through `app.os_*`
  wrappers so the crm/erp server roles, which have no usage on `os`, can still evaluate the policies.
* Core-table quirks: an `INSERT ... RETURNING` needs the SELECT policy, and `ON CONFLICT` checks it too, so
  notifications are inserted without `RETURNING` inside a savepoint that swallows `23505`.

### Identity and access

* **Derived roles.** `os.sync_access(org)` mirrors each staff member's OS roles into one platform role
  (`os_<rolekey>`, or `os_x<md5>` for a combination) in `core.roles`/`core.role_permissions`, and grants
  `user_product_access`. Scope mapping: own/team/department/wing -> own, branch -> branch, group -> org; OS
  `configure` also grants create/edit/delete; every derived role gets files view/create at org scope. Access rows
  whose role key does not start with `os_` are left alone (CRM/ERP/admin grants survive). Statement triggers on
  `os.staff_roles`, `os.role_permissions` and `os.roles` keep it in sync.
* **System actor.** One per org, deterministic id `os.system_user_of(org)`, created by `os.system_user_id(org)`
  (auth user, org membership, core role `os_system` with `*`/`*`/org, OS product access). Server-side writes that are
  not the user's own (notifications, sweeps, scheduler, invites) run as this actor, still under RLS.

### Server

* Pools: `os_server` (default), `job_runner` (claim/finish jobs only), `platform_admin_server` (platform console),
  and an owner pool used only by the seed and tests. Passwords come from env (`OS_SERVER_DB_PASSWORD`, ...);
  `scripts/db.mjs` sets them locally when present. Migrations never store passwords.
* `run()` sets `request.jwt.claims` (sub, role, org, products) and never `set role`. `sys()` switches the claims to
  the system actor and restores them afterwards, rethrowing the original error.
* `needProduct(ctx,'os')` guards every route except `GET /me`; `/me` returns org, products and modules, and the web
  shell shows "not part of your plan" without the OS product.
* The scheduler iterates `os.active_orgs()` (orgs with an active OS subscription) and runs each as its system actor;
  dedupe keys are prefixed with the org. Outbound messages are metered into `core.outbox`.
* AI wallet: one org-level wallet per client (OQ-11) in `billing.ai_allowances` / `ai_credit_ledger`, reached only
  through security-definer `app.ai_costs`, `ai_ensure_allowance`, `ai_credit_state`, `ai_charge`, `ai_usage`,
  `ai_request_topup`; settings through `app.platform_setting(key)`.
* Auth keeps the session-token design: the HS256 token carries user id, org id, product list and device-token id;
  `AUTH_PROVIDER=dev` uses `os.dev_login_user`.

### Tests

* `packages/server/test/rls.test.ts` (24 tests) incl. OS T2 (no cross-org read/write), T3 (no product -> nothing),
  T4 (module flag off -> nothing), and system-actor isolation.
* `test-platform/fixture-os.ts` seeds two orgs' rows in every os table and every new core/billing table, so T7 covers them.

## Deviations from the legacy OS (accepted)

* `os.reporting_lines` replaces the legacy manager column; `os.exam_plans` and `os.event_plans` hold what used to be
  extra columns on exams/events; question-bank extra fields live in `content` jsonb.
* Ticket SLA uses a constant factor per priority; cost limits come from org settings.
* Config history is read from `audit.log` (no separate config-history table).
* Core timetable versions only allow draft/published/archived: generated/failed are stored as draft and mapped back on read.
* The presets table is dropped (presets are code); file paths stay in os tables next to `core.files` ids.
* Platform console: curriculum update and support-ticket close are disabled in the OS console (owned by the platform
  admin stream); the console is reduced to read and entitlement actions.
* Global rows (`org_id is null`) in `core.platform_settings` and `billing.ai_action_costs` are readable by all.
* The isolation harness probe tables are kept; help-bot articles widen the baseline read to global rows.
* The `confidential` restrictive policy on `core.incidents` applies to every product.
