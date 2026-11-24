# ADR erp-schema: the ERP on the shared platform (schema `erp`)

Status: accepted (ERP port, database part, 2026-11-24). Builds on ADR 001-005, `core-master-001`, `ai-gemini`,
`docs/MAP-TABLES.md` (section A.3, rules R1-R12, OQ-16) and owner decisions 27-54. Details and table lists: `docs/erp-port.md`.

## Context

The ERP (`hbi83701-tech/autoederp`) has 186 tables generated from one definition file, RLS on every table, a capability matrix
(`app.can(cap, need)`, levels F/B/S/O/V/R), trigger-enforced immutability and a parent/student portal. Everything lives in `public`
and the app talks to the database through the Supabase Data API as the signed-in user (decision 51), so **RLS is the only barrier**:
plan rule 8 ("a product server cannot query other schemas") does not hold for the ERP. This stream moves the 124 tables MAP-TABLES
assigns to `erp` (plus two new ones) onto the platform, with policies at least as strict as the source.

## Decisions

1. **Generated from the ERP's own DSL.** `schema/erp-tables.mjs` keeps the compact column format (`key[:type][!][=default][{a|b}]`,
   `key>table`) and the access options; `scripts/gen-erp.mjs` writes `supabase/migrations/202611180000NN_erp_*.sql`. The generated
   SQL is committed and a rerun gives no diff. Hand-written functions live in `schema/erp-sql/*.sql` and are copied verbatim.
   126 tables: 124 from the source + `erp.module_flags` + `erp.staff_hr_profiles`; `private.gate_pass_otps` is the one private table.
2. **Standard shape (R3), composite organisation keys.** Every table has `id`, `org_id` (default `app.current_org_id()`),
   `branch_id`/`academic_year_id` where the source had them, `created_at`, `created_by`, `updated_at` (trigger), `deleted_at`,
   `unique (org_id, id)`. Every foreign key, to core or to erp, is `(org_id, x) -> (org_id, id)`; a login reference is
   `(org_id, user_id) -> core.org_users`. A row cannot point at another client's row, even for the table owner (tested).
   Every foreign key has an index starting with `org_id`. Money tables use `on delete restrict`.
3. **Policies through the platform generator.** `app.apply_rls('erp', t, 'product', 'erp', module)` creates the four staff policies
   (`app.user_has_product` + `app.can('erp', module, action, org, branch)`). The ERP's family/own/read options become extra permissive
   policies; **each one repeats `app.user_has_product(org_id, 'erp')`** (harness T7 checks every policy of every product table).
   The ERP's `app.can(cap, need)` is gone: the capability list became permission modules in `core.product_modules` and the role matrix
   became `erp.seed_roles(org)` writing `core.roles` + `core.role_permissions` (F = view/create/edit/delete/configure/manage at org
   scope, B = view/create/edit/delete at branch, S = view/create/edit at branch, V = view at branch; O and R give no permission and
   are served by own-row policies). **Deviation from MAP-TABLES A.3a #3:** `erp.role_permissions` is not created, because the platform
   already owns that table (`core.role_permissions`, read by `app.can`) and two permission stores would drift.
4. **Portal (decision 30).** Parents and students are `core.org_users` of kind guardian/parent/student with ERP role `portal` (no
   permissions) and rows in `core.learner_links`. Family policies are `student_id = any(app.my_learner_ids())` (+ a state rule, e.g.
   report card published, assessment published). Child tables use the parent row (`receipt_payments` -> `receipts`). The harness
   asserts the exact list of erp tables a guardian can read and the row counts (own child only) for org A, the student login and org B.
5. **Stricter than the source** (extra strict because RLS is the only barrier): families cannot insert payment orders (they call
   `erp.create_payment_order`, which checks balances); own-row inserts need the right starting state (`status = 'requested'`,
   `ordered`, ...) and, when the table has a learner, a linked learner (the source let a parent request a gate pass for any child);
   rubric results, fee follow-ups, vendors, chart of accounts, trainings are staff-by-module, not "any staff"; PTM slots show open
   slots and the family's own bookings only; routes/stops/trips only the family's route; forms and policies by audience;
   house points only the own child's; announcement recipients can change only `status/read_at/ack_at` (column grant).
6. **Money is write-once.** `receipts`, `receipt_payments`, `receipt_allocations`, `vouchers`, `voucher_lines` have a trigger
   (`erp.immutable_rows`): no delete, and only named columns may change (cheque status, deposit batch; `receipts.status` only inside
   `erp.reverse_receipt`). The `app.allow_purge` session switch of the source is gone (any role can set a session value); deletion of
   a whole organisation is allowed through the cascade (`pg_trigger_depth() > 1` and the org no longer exists, tested). Receipts,
   payments and allocations have **no insert policy**: they exist only through `erp.post_receipts` (counter, online, CRM hand-off).
   `fee_demands.paid/concession` and `student_wallets.balance` change only inside erp functions (`erp.fn_only_columns`, decided on
   `current_user` as core does for student status). A voucher must balance (deferred constraint trigger). Marks lock after
   publication (`erp.guard_marks`, `erp.guard_assessment`); reopening is an approved `marks_unlock` request applied by
   `erp.apply_approval`.
7. **Restricted data and logged views.** `erp.student_sensitive` (ERP-only health/statutory fields; blood group, allergies,
   medication, category, religion live in `core.student_sensitive` and are not duplicated) and `erp.staff_payroll` (bank, PAN, UAN, ESI,
   Aadhaar last 4) have a closed select policy and no DML grants: they are read and saved only through `erp.read_*`/`erp.save_*`,
   which check the caller and write `audit.log` (`action = 'erp.view'`). Postgres cannot log a plain SELECT, so a closed table plus a
   logging function is the only way the database itself guarantees "every sensitive view logged". Other sensitive views are logged by
   `erp.open_report_card` (family opens) and `erp.log_view` (payroll file downloads). Because `audit.log` is readable with `audit.view`
   (principal, system admin), payroll amounts, health notes and safeguarding text are **redacted** in the audit row
   (`erp.audit_row_redacted`, 20 tables); changes are still recorded, with the secret columns replaced by `[redacted]`.
8. **Functions and who may call them** (`schema/erp-sql/90_grants.sql`; every function pins `search_path`, nothing is executable by
   PUBLIC or anon): user-callable (each checks the caller inside) `collect_fee`, `bounce_cheque`, `create_payment_order`,
   `apply_approval`, `apply_student_exit`, `read/save_student_sensitive`, `read/save_staff_payroll`, `open_report_card`,
   `verify_gate_pass`, `my_gate_pass_otp`, `book_ptm_slot`, test, POS, wallet and driver functions; **server-only** (`erp_server`,
   `service_role`) `settle_payment_order`, `fail_payment_order`, `post_admission_payment`, `verify_document`; internal (owner only)
   `post_receipts`, `reverse_receipt`, `apply_concession`, `seed_roles`, notification helpers. A read-only support session cannot apply approvals.
9. **CRM hand-off (OQ-16), interface only.** `erp.post_admission_payment(student, amount, mode, source, source_ref, ...)`: idempotent
   on (source, source_ref); creates the admission fee head/demand if needed, one receipt in the same `core.number_series` receipt
   series (prefix `RCPT-<branch code>-`), the payment, the allocation and the voucher; refuses a school without ERP. CRM payments stay
   in `crm.payments`; the ERP server calls this when `core.admit_student` has run and ERP is on. `crm_server` cannot reach the
   schema at all (no usage), so the call goes through the ERP server or a job. No CRM code was written.
10. **Product-side people tables (decision 39).** `erp.staff_payroll` is the 1:1 payroll record of `core.staff`;
    `erp.staff_hr_profiles` holds qualifications, background check, licence. `erp.staff_exits` drives `core.staff.status`
    (`on_notice`, `left`, `left_on`) through a security definer trigger that writes only those columns.
11. **AI (decision 40).** The ERP's Anthropic helper is not ported. `packages/shared/src/erp/ai.ts` is an interface (`ErpAiHook`) plus a
    `noAi` implementation; the platform Gemini adapter implements it on the server. The rule libraries never call a provider.
12. **Not a policy question, but decided here:** `erp.module_flags` (modules inside the ERP) is data only; `app.can` does not read it
    yet (same open item as `os.module_flags` in `docs/platform-foundation.md`).

## Consequences and known issues

* **Plan rule 8 stays an ERP exception (decision 51).** `authenticated` and `erp_server` have table privileges on `erp.*`; RLS is the
  barrier. Harness T1-T4 on all 126 tables, the exact-portal-set test and the PostgREST run are the evidence. Moving ERP reads behind
  a server API later removes the exception.
* `deleted_at` is not filtered by policies (as in core): queries must add `deleted_at is null`.
* Column-level ownership of **core** rows the ERP edits (students, guardians, staff) is still a server responsibility (MAP risk D1).
* `audit.log` keeps full before/after for erp tables not in the redaction list (e.g. fee demands, receipts: these are not secret
  from the roles that can read the log).
* `erp.apply_approval` is called by the ERP after the core engine records a decision; there is no database hook that runs it
  automatically (core never calls into a product, R7). A missed call leaves the side effect undone, never done twice.
* `erp.verify_document` is not granted to anon; the public QR page must call it from the ERP server.
* The student-exit side effects (`erp.apply_student_exit`) are a function the ERP calls after `core.change_student_status`, not a trigger.
* Decision 42 (30 days read-only after non-payment) is still not modelled by the platform; ERP data goes dark at once when the
  subscription is `suspended`/`cancelled` (tested).
* The money tables use plain `numeric(14,2)` rupees (as the source), not paise.
