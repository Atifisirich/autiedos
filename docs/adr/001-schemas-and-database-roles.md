# ADR 001 — Schemas and database roles for the unified platform

Status: accepted (Phase 2 foundation, local Postgres only). Date: 2026-11-24.
Implements: plan §4.1, §4.3 layer 2, rule 8. Related: decisions 35, 51.

## Context

CRM, OS and ERP share one Postgres database but are sold separately. Plan rule 8 requires that a product's
server physically cannot query another product's tables, even with a bug or SQL injection.

## Decision

* Schemas: `core`, `app` (functions only), `audit`, `billing`, `private`, `crm`, `os`, `erp`
  (`supabase/migrations/20261115000001_platform_schemas_roles.sql`). `revoke all ... from public` on all of them.
* Login roles `crm_server`, `os_server`, `erp_server`, `platform_admin_server` and `job_runner`
  (`login noinherit nobypassrls`, no password in migrations; set out of band). `statement_timeout` 15 s for
  product roles, 30 s platform admin, 120 s jobs.
* USAGE grants:

  | role | schemas |
  |---|---|
  | `crm_server` / `os_server` / `erp_server` | `core`, `app`, own product schema |
  | `platform_admin_server` | `core`, `app`, `audit`, `billing` |
  | `job_runner` | `core`, `app`, `private` (functions only, no table grants) |
  | `authenticated` | `core`, `app`, `crm`, `os`, `erp`, `audit`, `billing` (RLS decides rows) |
  | `anon` | nothing |

* **Server roles are not members of `authenticated`.** They run each request as themselves with
  `request.jwt.claims` set (the OS `run()` sets claims today; it must stop doing `set local role authenticated`
  when it moves to `os_server`). If they were members, `set role authenticated` would undo the missing grant.
* Policies have no `TO` clause: grants decide which roles reach a table, policies decide which rows.
* Policies call `app.uid()` (security definer wrapper of `auth.uid()`), so server roles need no access to the
  Supabase `auth` schema.
* Default privileges give new tables in `crm`/`os`/`erp` to `authenticated` and the product's role; the harness
  (T7) fails CI if such a table lacks RLS, a policy, the product check, `org_id` or the audit trigger.
* `authenticated` keeps usage on product schemas because decision 51 keeps the ERP on the Data API for now;
  RLS (product check) is then the only barrier for that path.

## Consequences

* Roles are cluster-wide in Postgres: migrations create them idempotently and never drop them.
* On Supabase, product servers connect through the pooler as these roles; passwords must be set per
  environment and rotated (plan §11).
* Verified by harness T5 (real logins, `permission denied for schema`, `set role` refused) and the T7 grant
  matrix test.
