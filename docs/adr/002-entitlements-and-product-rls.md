# ADR 002 — Entitlements and the product check in RLS

Status: accepted (Phase 2 foundation). Date: 2026-11-24.
Implements: plan §4.2, §4.3 layer 1, rules 1, 2, 4. Related: decisions 34, 42, 45.

## Decision

Tables (`20261115000002_platform_core.sql`): `core.products` (crm/os/erp), `core.product_modules`,
`core.subscriptions` (one row per org and product; `trial|active|past_due|suspended|cancelled`, `starts_on`,
`ends_on`, `plan_key`, `seats`), `core.org_branch_products` (per-branch off switch, decision 34),
`core.user_product_access` (user, product, role; `revoked_at`), `core.roles` + `core.role_permissions`
(per org and product; scope `own|branch|org`; `*` wildcards).

Functions (`20261115000004_platform_security_functions.sql`), all `stable`, security definer with
`search_path = ''`, no caching anywhere, so a subscription change applies to the next statement:

* `app.org_has_product(org, product)`: `trial`, `active`, `past_due` → true; `suspended`, `cancelled` → false;
  also false outside `starts_on..ends_on`, if the product is inactive or the org is `closed`.
* `app.branch_has_product(org, branch, product)`: the above and no `enabled = false` row for the branch.
* `app.user_has_product(org, product)`: `org = app.current_org_id()` and `org_has_product` and an unrevoked
  `user_product_access` row (or an open support session for that org, ADR 003).
* `app.user_has_any_product(org)`: for core master data.
* `app.can(product, module, action, org, branch, owner)`: small port of the OS role/scope check. Requires
  `user_has_product` and `branch_has_product`; then the highest scope among the user's role permissions for that
  product: `org` → yes; `branch` → branch in `app.user_branch_ids()`; `own` → `owner_id = app.uid()`. Only
  `staff` users get role permissions. `app.can_any_product(module, action, org, branch)` = any product.

Generator `app.apply_rls(schema, table, kind, product, module)` with kinds `product`, `product_config`,
`core_master`, `global`. Product policies have the plan's shape:
`app.user_has_product(org_id, 'crm') and app.can('crm', module, action, org_id, branch_id, owner_id)`.
`core_master` reads need any product of the org. The generator refuses a table without `org_id`, a product table
outside its product's schema, or a module missing from `core.product_modules`, and attaches the audit trigger.

Entitlement writes: `subscriptions`, `org_branch_products`, `products`, `product_modules` are granted to
`platform_admin_server` only and their policies require `app.is_platform_admin()`. Roles and product access
of product P can be changed only by a user who has `users.manage` **in P** (a CRM admin cannot create an OS
role or give themselves OS access).

## Not decided here / follow-ups

* Decision 42 (30 days read-only after a client stops paying) needs a read-only state: today `cancelled`
  removes access at once. Proposal: add `read_only_until` and let `select` policies pass while writes fail.
* `os.module_flags` (modules inside a product) is checked by the OS stream after the product check; no
  platform hook yet.
* Performance: `user_has_product(org_id, …)` is evaluated per row. Indexes start with `org_id`; if plans show
  it hot, wrap per-statement values in `(select …)` init-plans.
