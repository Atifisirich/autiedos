# ADR crm-port: the CRM on the shared platform

Status: accepted (CRM port stream, 2026-11-24). Builds on ADR 001-005, core-master-001, `docs/MAP-TABLES.md` A.2/B.6/B.7/C.2,
decisions 27-54 (esp. #31 leads are the school's data, #37 one user one org, #38 `core.students` only on admission, #45 whole products).
Details and run book: `docs/crm-port.md`.

## Context

The CRM (`Atifisirich/autoedcrm`, Next.js 16, schema `autoed`, 43 tables) enforced tenancy, branch scope, record scope and
field masking in application code over an owner database connection, with its own users, passwords, TOTP and sessions.
The platform requires the database to enforce all of it (plan rules 1, 3, 8), for a product that can be sold alone.

## Decisions

1. **One `crm` schema, 33 tables, generated policies only.** Tables carry `org_id`, composite foreign keys `(org_id, x)` and the
   audit trigger; policies come from `app.apply_rls(..., 'product', 'crm', module)` (or `product_config`), with two reviewed
   deviations (7, 8). Modules added to `core.product_modules`: leads, tasks, applications, payments, campaigns, workflows,
   reports, sensitive, admin, users, data, wallet, secrets.
2. **People are `core.staff` + `core.org_users` + `core.user_product_access`; every user reference in a crm table is the
   AUTH USER id** (`owner_id`, `host_id`, `actor_id`, `sender_id`, `verified_by` ...), with a composite FK to
   `core.org_users(org_id, user_id)`. MAP-TABLES says "staff id"; the platform's "own" scope compares `owner_id` with
   `app.uid()`, so the auth id is what the generator needs. Join `core.staff` on `user_id` for the name. `crm.staff_v`
   is the old `users` table as a view.
3. **The CRM permission matrix stays the CRM's** (`crm.roles.permissions`, one level per capability) and is translated by
   `crm.role_rows()` into `core.roles` / `core.role_permissions` (trigger on `crm.roles`), so `app.can()` enforces it.
   Writing `crm.roles` needs `users.configure` (not `admin`): a branch admin cannot rewrite their own permissions.
4. **Pre-admission families stay in `crm`** (households, guardians, prospects). `core.admit_student(enquiry)` is the only door
   into `core` (decision 38): one transaction, idempotent, audited, CRM-only (`execute` for `crm_server`; it re-checks org,
   product and `applications.edit` scope inside). It queues an `erp` job `post_admission` instead of writing ERP tables.
5. **Consent of leads is `core.consents` (`crm_guardian`)**, written through `crm.set_consent` and read through
   `core.can_contact` (no record means no consent). At admission the rows are copied to the core guardian.
6. **Field-level masking in SQL.** Values of custom fields flagged sensitive (`crm.field_settings`; `core.custom_fields` has
   no such flag) never stay in `crm.enquiries.custom`: a trigger moves them to `crm.enquiry_sensitive` (module `sensitive`)
   and leaves `••••••`. A caller without `sensitive.edit` cannot change them (the write is put back); a caller without
   `sensitive.view` sees only the placeholder in any query. `crm.enquiries_full` (security invoker) overlays real values
   for those allowed. The app code no longer decides anything.
7. **Lead scope without per-row function calls.** The generator's policies call `app.user_has_product` + `app.can` per row
   (~1.4 ms each: a list of 200 enquiries took 0.3 s, 20 000 would exceed the 15 s statement timeout). The CRM policies
   on `crm.enquiries` and every child table ask the same questions once per statement (`crm.scope_of(module, action)` is
   `app.can()` without row arguments, evaluated as an InitPlan; branches via `app.user_branch_ids()`; the per-branch switch
   via `crm.disabled_branches()`): 207 enquiries in 9 ms. Reporting-line scope (RB-02) is `crm.in_my_team`. A test
   (`platform.test.ts`) proves visible and editable sets equal `app.can()` for all default roles. Every policy still contains
   `user_has_product`, so harness T7 holds.
8. **Child rows follow their parent.** Activities, visits, applications, documents, payments, messages ... are visible
   when the enquiry (or the household's enquiry) is; households/guardians/prospects likewise, plus rows the caller created.
9. **Automation user instead of an owner connection.** Webhooks, hosted forms, parent links, API keys, the cron sweep and
   the lead-capture/de-duplication path need to see the whole org. Each org with the CRM gets one automation user
   (`kind staff`, role `system` = CRM only), created by a trigger on `core.subscriptions` (`crm.provision_org`). The server sets
   `request.jwt.claims` to that user (`asSystem`); RLS still binds it to one org and to the CRM product, and
   `crm.system_actor()` refuses an org without an active CRM subscription (never cached). Public keys resolve to an org
   through `crm.resolve_public(kind, key)`. Staff actions authorise the person's own role first, check the record is visible to
   them under their own claims (`asUser`), then perform the write as the automation user, naming the person as
   `actor_id`. Limitation: `audit.log.actor_user_id` of such writes is the automation user; the person is in the CRM
   activity and `actor_id`. Rejected: giving `crm_server` BYPASSRLS or `service_role` (breaks rule 8).
10. **Jobs are `private.jobs` (product `crm`).** `private.enqueue_tick_jobs` (new, generic) queues one `crm.sweep` per org with the
    product; `private.claim_jobs` skips and logs jobs of orgs that lost the CRM. The worker logs in as `job_runner`
    and runs handlers as the org's automation user.
11. **Wallet, secrets, numbers, audit through definer functions.** `crm.wallet_post` (credit needs `wallet.create`; debit cannot
    overdraw; guard triggers refuse direct writes to the balance and the ledger), `crm.org_secrets` (module `secrets`,
    AES-256-GCM with APP_SECRET), `crm.next_number` over `core.number_series` (`crm_application` per year, `crm_receipt`),
    `crm.audit_event` into `audit.log`.
12. **Meta WhatsApp** is ported as is (templates in `core.message_templates`, product `crm`, languages en/hi/te; tokens
    in `crm.org_secrets`); the webhook is a framework-free handler, tested with a fake Graph API.
13. **Auth is the platform's.** The server only verifies the platform session token (HS256, `AUTH_JWT_SECRET`, issuer
    `AUTH_ISSUER`, claim `sid`; revocation row `session:<sid>` in `core.device_tokens`) and loads the person's CRM context.
    bcrypt login, TOTP, sessions and impersonation tables are not ported (view-as is `core.support_sessions`).
14. **`crm.harness_probe` is kept.** The foundation harness still uses it in ~30 tests; dropping it is a harness change for
    the foundation owner now that real crm tables exist.

## Consequences

* A suspended client loses the CRM entirely (`org_has_product`); the CRM's old "suspended = read-only" (PT-02, decision 42)
  is not modelled, as for every product (see ADR 002 follow-up).
* Interim homes until the platform creates them: `crm.wallet_ledger` + `crm.settings.wallet_balance` (for `billing.wallets`),
  `crm.org_secrets` (for `private.org_secrets`). Moving them is an insert-select.
* `audit.support_access` does not exist, so CRM `support_access` rows are reported and not migrated.
* Template languages other than en/hi/te cannot be stored in `core.message_templates` (loaded as en, reported as a warning).
* Policies on `crm.enquiries` and the child tables are CRM-owned code, not generated; a change of `app.can()` semantics
  must be mirrored in `crm.scope_of` (the equivalence test fails if they drift).
