# Platform foundation — schemas, roles, functions, and how to add a product table

Phase 2 of `docs/PLAN-unified-platform.md`, built and tested on **local Postgres only**. Decisions are in
`docs/adr/001`–`005`; owner decisions 27–53 in `docs/DECISIONS.md` take precedence over the plan.

## Files

| File | What |
|---|---|
| `supabase/migrations/20261115000001_platform_schemas_roles.sql` | schemas, login roles, schema grants, default privileges |
| `…000002_platform_core.sql` | `core` tables and product/module catalogue seed |
| `…000003_platform_audit_billing_private.sql` | `audit`, `billing`, `private` tables |
| `…000004_platform_security_functions.sql` | `app.*` functions, audit triggers, `app.apply_rls` |
| `…000005_platform_policies.sql` | policies + grants for core/audit/billing/private; support sessions, login security, jobs, rate limit, storage policies |
| `…000006_platform_product_placeholders.sql` | `crm/os/erp.harness_probe`, function execute grants |
| `packages/server/test-platform/*` | isolation harness (plan §8) |

They sort before the legacy OS migrations (`20261116…`, `public` schema), which still apply unchanged on top.

## Schemas

| Schema | Holds | Reached by |
|---|---|---|
| `core` | organizations, branches, products, product_modules, subscriptions, org_branch_products, org_users, user_branch_access, learner_links, roles, role_permissions, user_product_access, user_security, login_events, support_sessions, platform_admins | every server role, `authenticated` |
| `app` | functions only | every server role, `authenticated` |
| `crm` / `os` / `erp` | product tables (today only `harness_probe`) | own product role, `authenticated` |
| `audit` | `log`, `config_history` | `platform_admin_server`, `authenticated` (read; RLS) |
| `billing` | plans, accounts, razorpay_subscriptions, invoices, invoice_lines, payments, usage | `platform_admin_server` (write), `authenticated` (read; RLS) |
| `private` | jobs, rate_limits, webhook_events | `job_runner`, only through functions |

Every table has `org_id` except the reviewed global list: `core.products`, `core.product_modules`,
`core.platform_admins`, `billing.plans`. (`core.organizations` has `org_id` as a generated copy of `id`.)
`private.rate_limits` / `webhook_events` and `core.user_security` / `login_events` allow a null `org_id`
(pre-login keys, unknown identifiers, AutoEd staff accounts).

## Roles

`crm_server`, `os_server`, `erp_server`, `platform_admin_server`, `job_runner`: login, `noinherit`,
`nobypassrls`, not members of `authenticated`. A product server runs each request **as its own role** with
claims set:

```sql
begin;
select set_config('request.jwt.claims', '{"sub":"<auth user id>","role":"authenticated"}', true);
-- queries; RLS applies to crm_server like to any user
commit;
```

No `set role authenticated` (it is refused). `service_role` (bypasses RLS) is for migrations and emergencies.

## Functions (`app.*`)

| Function | Returns |
|---|---|
| `uid()` | signed-in user (wraps `auth.uid()`; policies use this) |
| `current_org_id()` / `my_org_id()` | the user's single org, or the org of an open support session |
| `my_member_kind()` | staff / guardian / parent / student / support |
| `user_branch_ids()` | branches the user acts in (no home branch and no extra rows = all) |
| `my_learner_ids()` | learners linked to a guardian/parent/student |
| `is_platform_admin()`, `support_session_id()`, `support_org_id()` | platform staff and view-as state |
| `org_has_product(org, p)` | trial/active/past_due within dates, org active |
| `branch_has_product(org, branch, p)` | + not switched off for the branch |
| `user_has_product(org, p)` | org is mine + org has p + my unrevoked access row (or support session) |
| `user_has_any_product(org)` | for core master data |
| `can(p, module, action, org, branch, owner)` / `can_any_product(module, action, org, branch)` | role/scope check (own < branch < org, `*` wildcards) |
| `start_support_session(org, reason, minutes, read_only)` / `end_support_session()` | view-as, audited |
| `record_login_event(...)` / `login_allowed(user)` | password lockout bookkeeping (server roles only) |
| `enqueue_job(p, kind, payload, run_at)`; `private.claim_jobs(p, worker, n)`, `private.finish_job(id, ok, err)` | jobs, re-checking the subscription |
| `rate_limit_hit(key, limit, window_s, org)` | fixed-window rate limit |
| `apply_rls(schema, table, kind, product, module)`, `enable_audit(...)`, `drop_policies(...)` | migration helpers (not executable by request roles) |

## How to add a product table safely

1. Put it in the product's schema, with `org_id uuid not null references core.organizations(id) on delete cascade`.
   Add `branch_id` (with `foreign key (org_id, branch_id) references core.branches(org_id, id)`) if rows belong to
   a branch, and `owner_id uuid` (an auth user id) if "own" scope should apply. Index starting with `org_id`.
2. Make sure its module exists: `insert into core.product_modules (product_key, module_key, name) values ('crm', 'leads', 'Leads');`
3. In the same migration: `select app.apply_rls('crm', 'leads', 'product', 'crm', 'leads');`
   (use `'product_config'` for settings tables). This enables RLS, creates select/insert/update/delete policies
   with the product + user-access + role check, and attaches the audit trigger. Grants come from default privileges.
4. Add rows for org A and org B to `packages/server/test-platform/fixture.ts` (the harness fails until you do),
   and give the fixture roles the permissions the new module needs.
5. Run `pnpm test:platform`. A table without RLS, a policy, the product check, `org_id`, the audit trigger or
   fixture rows fails it.
6. Shared master data (needed by two products, plan §4.5) goes in `core` with kind `'core_master'` and the
   owning product (or `'*'`); moving a table to `core` is a DECISIONS entry.

Never: grant a product schema to another product's role, add a permissive policy without the product check (policies are OR-ed), use `auth.uid()`
in a policy (use `app.uid()`), write a security definer function without `set search_path = ''`, or give
`anon` anything.

## Running it

```bash
export DATABASE_URL=postgres://postgres@localhost:54322/<your db>
pnpm db:reset:platform          # empty platform only (node scripts/db.mjs reset --platform-only)
pnpm test:platform              # harness; resets the database itself
pnpm db:reset                   # platform + legacy OS + seed (what the OS server tests use)
```

`db.mjs reset` drops the schemas `public app auth storage core audit billing private crm os erp` of the target
database only. Roles are cluster-wide and are never dropped.

## What the harness does not cover

* **T8** only at policy level on the local `storage.objects` shim; the Supabase Storage API is not exercised.
* **T10** (org switching) does not apply (decision 37); replaced by "a second org link is rejected".
* **T12** (Supabase security advisor) needs a Supabase project; nothing in the cloud was touched.
* Real product tables: only probes exist; CRM/OS/ERP streams add theirs.

## Known issues for the next streams

* **Name clashes with the legacy OS migrations** when both are applied to one database: the OS files redefine
  `app.my_org_id()` (staff-based) and `app.touch_updated_at()`. Platform policies use `app.current_org_id()`, so
  they are unaffected, but `app.my_org_id()` returns the OS answer in a combined database. The OS also defines
  `app.can(text, text, uuid, uuid, uuid, uuid, uuid)` and `app.apply_rls(text, text, text, text, text, text)`;
  the platform versions have different signatures, but a 5-text-argument call to `app.apply_rls` becomes
  ambiguous once the OS one exists. The OS rewrite onto the platform must drop the legacy versions.
* The OS's `os_files_rw` storage policy (bucket `os-files`, org prefix only, no product check) coexists with
  `platform_files_*` in a combined database; policies are OR-ed, so it must be dropped by the OS rewrite.
* `app.can()` does not yet consult `os.module_flags`; the OS stream adds that after the product check.
* Decision 42 (30 days read-only after non-payment) is not modelled: `cancelled` removes access immediately.
* No enforcement that a platform admin account is not also an org user.
