# ADR — Compliance tooling: export, erasure, retention, deletion, consent

Status: built and tested on local Postgres only (plan phase 6, section 9). Date: 2026-11-24.
Implements: plan §9 and §4.10; decisions 40, 42, 48; `docs/legal/data-subject-rights-procedure.md` section 5 and
`docs/legal/data-retention-schedule.md` section 3 (both drafts, "needs legal review").
Builds on ADR 001 (roles), 002 (entitlements), 004 (audit, jobs), 005 (harness).

## Decision in one paragraph

Compliance is **generic and catalogue-driven**. Tools find tables through `pg_catalog` and three registries
(`core.pii_registry`, `core.table_policy`, `core.retention_policies`), so a new table is covered by export, erasure and
deletion as soon as it exists (org export and deletion need no registration at all) or as soon as it has one registry row
(per-person tools). A CI test fails when a table with a person-identifying column is not registered. Everything privileged
is a `security definer` SQL function in schema `app` that only `platform_admin_server` (org and person tools),
`job_runner` (retention purge) and `service_role` may execute; the product roles never see another schema. Periods are
**rows, not constants**, and every seeded table rule is **disabled and marked draft** until counsel confirms it.

## Files

| File | What |
|---|---|
| `supabase/migrations/20261115200001_compliance.sql` | tables, functions, grants, seeds |
| `packages/server/src/compliance/*` | services and the route table (`dispatchCompliance`) |
| `packages/server/test-platform/compliance-*.test.ts` (+ `compliance-support.ts`) | tests against real Postgres |

## Data model (all `core`, except the purge log)

| Table | Purpose |
|---|---|
| `core.pii_registry` | where personal data lives: `(schema, table, person_type staff\|student\|guardian\|lead, key_column)`, optional `filter_column/filter_values` (e.g. `org_users.kind`), `contact_columns` (phone/email, matched on values too), `is_subject`, `pii_columns`, `anonymise_values` (replacement literals for NOT NULL columns), `erasure_mode delete\|anonymise\|retain` (+ `retain_reason`), `erase_order`, `export`. `classification = 'exempt'` + reason for reviewed tables that only look personal (probes, AutoEd staff, billing profile). `org_id` null = platform default; an org row overrides it for that org. |
| `core.table_policy` | what a whole-org or product deletion does to a table: `delete` (default, also for tables nobody listed) or `retain` with a reason (organisation row, subscriptions, all `billing.*`, request register, holds, export jobs); `org_export`. |
| `core.retention_policies` | (named `retention_policies` because the core master data already has `core.retention_rules`, the client's own `keep_years` per data type) `scope = 'table'` (what the purge job applies: table, clock column, optional filter, `delete`/`anonymise`, `period_value` + `period_unit`, `enabled`, `legal_status draft\|confirmed`) and `scope = 'lifecycle'` (decision 42: `product_read_only_days` 30, `org_exit_deletion_days` 30, plus `confirmation_token_minutes`, `export_link_days`, `trial_unconverted_days`). A rule cannot be enabled while `draft` unless an override reason is given. An org row, and the client's own `core.retention_rules` row of the same `data_type`, can only **shorten** the default period (the schedule is AutoEd's maximum); the shortest wins. |
| `core.legal_holds` | scope `org`, `person` or `table`; open until released. |
| `core.compliance_requests` | request register and tombstone: kind, status, plan, blockers, result (counts only), token hash and expiry, who requested/verified/confirmed. |
| `core.org_export_jobs` | org export job: products, formats, row counts, manifest, sha256 of manifest and archive, storage key, expiry. |
| `core.consent_events` | append-only consent ledger per contact and channel (normalised phone/email, `service`/`promotional`, `opted_in`/`opted_out`/`unknown`, source, proof, guardian) for the send gate. The core master `core.consents` (current consent per student/guardian/staff and purpose) is a different thing and is left as it is; both are in the registry (retained on erasure as proof). |
| `audit.purge_log` | one row per rule/table touched by retention, erasure or deletion: what, which org, how many rows, dry run or not. Never the data. |
| `private.compliance_request_secrets` | phone/email given with an erasure request, kept only until the request is executed, refused or a day old, so they never sit in the audited register. |

Platform default rows (`org_id` null) are visible to platform admins only (the isolation harness allows no org-less row
to a client). A client's compliance admin reads the effective result through `app.compliance_data_map(org)` /
`GET /compliance/orgs/:orgId/data-map`.

## Who can do what

| Function (schema `app`) | Executable by | Authorisation inside |
|---|---|---|
| `compliance_person_export`, `compliance_person_erasure_plan/_execute`, `compliance_table_counts`, `compliance_read_rows`, `compliance_org_export_start/_finish`, `compliance_data_map` | `platform_admin_server`, `service_role` | platform admin, **or** a member of that org with `compliance.export` / `compliance.erase` / `compliance.view` in any product (`*` wildcards count) |
| `compliance_org_deletion_plan/_execute`, `compliance_deletion_status`, `compliance_subscription_states` | `platform_admin_server`, `service_role` | **platform admin only** |
| `compliance_retention_purge`, `compliance_enqueue_purge_jobs` | `job_runner`, `platform_admin_server`, `service_role` | grant only (the job has no user); the purge re-checks `org_has_product` |
| `compliance_record_consent`, `compliance_consent_status`, `compliance_may_send`, `compliance_normalise_contact` | product roles, `authenticated`, `platform_admin_server` | member of the org with any product, or platform admin |
| `_compliance_*` helpers | owner only | not callable by any request role |

`crm_server`, `os_server`, `erp_server` and `job_runner` cannot reach `core.pii_registry`, `audit.purge_log` or any other
product schema (tested). Product tables are reached **only inside these functions**, never by giving a role a grant.

## The flows

**Per-person export** (`exportPerson`). Registry rows for the person type give the tables; rows are matched on the key column
or on phone/email values, always `org_id = org`. Result: zip with `data.json`, one CSV per table that holds rows,
`summary.txt` and `manifest.json` (sha256 per file). A request row and an audit event (counts only) are written.
Product schemas the org has no subscription for are skipped.

**Per-person erasure** (`planPersonErasure` then `executePersonErasure`). Two steps: the plan is a dry run (counts per table,
mode, reason, retained rows) and returns a one-time token (stored as sha256, 60-minute life, a lifecycle row). Execution needs
the request id and the token, a **verified identity** (data-subject-rights-procedure step 2), no legal hold, and an actor who
may erase. Per table: `delete`, `anonymise` (`pii_columns` to null or to the registered literal) or `retain`.
Financial tables are configured as `anonymise` (the amount stays, the person goes) or `retain`. Afterwards the PII is stripped
from the audit images of the affected rows (`audit.log`, `audit.config_history`) by row id and by position: the trail (who, when,
which table and row) stays, the data does not. Tombstone: request id, class, date, counts. The Supabase Auth user
(email/phone) is not reachable from SQL and is returned as an **external action** for the server to perform.

**Org export** (`runOrgExport`). Every table with an `org_id` in `core`, `billing`, `audit` and the product schemas the org has or had a
subscription for (found through the catalogue), CSV and XLSX per table, `manifest.json` with row counts, bytes and sha256 per file.
Counts and rows are read in one repeatable-read transaction and compared; a mismatch fails the job. The archive goes to an
`ExportSink` (a folder here; Supabase Storage in production). Job row: archive and manifest sha256, expiry (`export_link_days`).

**Org / product deletion** (`planOrgDeletion` then `executeOrgDeletion`). The plan is always a dry run: it prints what would be deleted and what is kept
(`formatDeletionPlan`), and says whether deletion is allowed now. Allowed means all of: no live subscription for the scope; access ended at
least `product_read_only_days` (product) or `org_exit_deletion_days` (org) ago; a finished org export made **after** access ended
that covers the scope (decision 42: export first); no open legal hold. Only then is a confirmation token issued. Execution re-checks
everything (a hold placed or a client who came back after the plan stops it), deletes in passes until foreign keys allow, strips audit images, closes the
organisation row (it stays: invoices and the contract record need it), keeps `billing.*`, subscriptions, the request register,
holds and export records, and returns external actions (Auth users, storage prefix). When access ended is read from the config
history of `core.subscriptions` (latest transition into suspended/cancelled), falling back to `updated_at`, or the day after `ends_on`.
`listDeletionDue` maps the same dates onto `computeEntitlements` (`packages/shared`) and lists what `purgeDue` says.

**Retention purge** (`enqueueRetentionJobs`, `retentionPurgeHandler`, `runJobsOnce`). A cron tick enqueues one `compliance.retention_purge` job per
(org, product) that has the product **and** an enabled rule. The handler runs as `job_runner` and calls `compliance_retention_purge`,
which skips and logs an org that does not have the product, pauses on legal holds (org/person holds pause all rules, table holds that table), skips a rule whose
table does not exist yet, and otherwise deletes or anonymises in batches, strips the audit images of the affected rows and logs every rule (also skipped ones) in `audit.purge_log`.
Rules with no product (audit log, login events, support sessions) run once per org, with its first product. `private.claim_jobs` still skips and logs jobs of orgs without the product before any handler runs.

**Consent** (`recordConsent`, `maySend`, ...). Append-only; the latest row per (contact, channel, purpose) wins; `both` writes two rows; a STOP is `opted_out` + `both`.
`maySend(promotional)` needs `opted_in`; `maySend(service)` is allowed unless `opted_out` (lawful basis for service messages is a CONFIRM item).

## Adding a table (what a developer must do)

1. **Org export and deletion: nothing.** A table with `org_id` in `core`, `billing` or the org's product schema is exported and deleted automatically.
   Add a `core.table_policy` row (`retain` + reason, ten characters or more) only if AutoEd must keep it.
2. **Person data:** if the table has a person-identifying column (`email`, `phone`, `*_user_id`, `student_id`, `display_name`, `address`, `ip`, ... see `PERSONAL_COLUMN_PATTERN`) CI fails until it has a row in `core.pii_registry` in the same migration:
   `insert into core.pii_registry (schema_name, table_name, person_type, key_column, pii_columns, erasure_mode, ...)`; use `anonymise` + `anonymise_values` for NOT NULL columns and for financial rows,
   `retain` + reason where law requires the row, or `classification = 'exempt'` + reason when it only looks personal. A student table that is keyed by `id` uses `key_column = 'id'`, `is_subject = true`.
3. **Retention:** add a `core.retention_policies` row (disabled, `draft`) for the data type and its clock column.
4. The catalogue test (`compliance-catalogue.test.ts`) and `findRegistryProblems` check the rows against the live schema (dropped columns, NOT NULL without replacement).

## Integration notes (for whoever merges this)

* `scripts/db.mjs --platform-only` now applies the compliance migration (filter includes `_compliance`), after core master data (`20261115100001..8`). The migration **extends** core master data instead of recreating it:
  `core.retention_rules` stays the client's own rule table (our defaults live in `core.retention_policies` and the client's `keep_years` can only shorten them), `core.consents` stays as is (the send-gate ledger is `core.consent_events`),
  `core.data_requests` stays the client's request register: `core.compliance_requests.data_request_id` links the engine's work to it and the entry is closed (`status = 'done'`, evidence = request id and counts) when an export or erasure finishes.
  Org deletion nulls `core.organizations.logo_file_id` before the file rows go.
* Shared harness changes (small, in existing files): `fixture.ts` calls the new `fixture-compliance.ts` (one row per org in each compliance table) and `core-master.test.ts` lists the seven compliance tables next to the foundation tables
  (they are written only by security definer functions and hold org_id-null default rows, so they do not use `app.apply_core_rls`). With that, `pnpm db:reset:platform && pnpm test:platform` is green on platform + core master + compliance.
* The compliance tests still build a **scratch database per test file** (platform-only reset, which includes this migration, then their own destructive data: cancelled subscriptions, deleted orgs, extra tables) and drop it afterwards. This is needed, not a workaround for the migration: the shared harness database must stay pristine for the isolation tests.
* Person ids: a staff person is `core.staff.id`, a guardian `core.guardians.id`, a student `core.students.id`, a lead the CRM contact id; a login (auth user id) is accepted as well. Subject rows (`is_subject`, `link_columns`) resolve all ids of the person (staff id + `user_id`, guardian id + `user_id` + `household_id`), so tables keyed by `user_id`, `staff_id`, `guardian_id`, `student_id`
  (also uuid arrays such as `incidents.student_ids`) or only by phone/email (`outbox`) are all found.
* Erasure defaults on the core master data (all rows are in `core.pii_registry`, change one row to change the behaviour): profiles (`staff`, `guardians`, `students`) are **anonymised** and stay as pseudonymous rows because timetable, attendance, approvals and placements point at them; `student_sensitive` (health, category) and logins are **deleted**;
  free text and media on tickets, approvals, leave, attendance, messages and notifications are removed; `households` (shared), `enrolments`, `exam_seating`, `incidents`, consent records, data requests and the compliance records are **retained** with a stated reason. The Auth user is returned as an external action.
* When other streams add tables with person columns (students, guardians, leads, staff, messages), `compliance-catalogue.test.ts` will fail for them until they are registered. That is the intended gate.
* Product schemas get default privileges to their role only; nothing in this work changes a grant of an existing table.
* The Supabase Auth user and Storage objects need the admin APIs. The services return them as `external_actions` and do not call Supabase.
* `app.compliance_*` functions are plain SQL in `app`; the legacy OS migrations (`20261116*`) are untouched.

## Product coverage (os, crm, erp): `20261126000001_compliance_products.sql`

The scratch databases of the compliance tests hold platform + core master + compliance only (`SCRATCH_MIGRATIONS` in
`compliance-support.ts` matches the engine's own `_compliance.sql`), so `compliance-catalogue.test.ts` never sees a product
table. `compliance-coverage.test.ts` closes that gap: it runs on the **harness database** that `pnpm db:reset:platform` builds
(platform, core, os, crm, erp, compliance, this migration) and fails when any table with a person column is not registered,
or a registry / table-policy / retention row points at something that does not exist. A new product table with PII fails CI there.

What the migration registers (one row per table, person type and key column; change a row to change the behaviour):

| Person | Product tables | Erasure |
|---|---|---|
| **lead** = a CRM family | `crm.households`, `guardians`, `prospects`, `enquiries` (subject rows) and everything keyed by household or enquiry (activities, follow-ups, visits, messages, applications, documents, sensitive fields, source touches, workflow runs, Meta leads, import rows); `crm.payments`; `erp.visitors` and `core.outbox` / consents by phone | parents and everything said or uploaded **deleted**; household, child and enquiry stay as empty pseudonymous **stubs** (funnel counts, schedule 2.1 "keep counts"; `crm.payments` cascades from the enquiry, so the stub keeps the fee record, reference removed) |
| **student** | 51 `erp` tables by `student_id`; `crm.prospects.core_student_id` | health, Aadhaar, pickup persons, notes, documents, transport, hostel, conversations **deleted**; marks, report cards, certificates, safeguarding **retained** (academic / legal record); money rows (`fee_demands`, `receipts`, `concessions`, `refunds`, `deposits`, wallets, sales) **never deleted**: free text anonymised, amounts kept on the pseudonymous student row |
| **guardian** | `erp` logins (`announcement_recipients`, `form_responses`, `conversations`, `appointments`, `gate_passes`, `ptm_slots`, `policy_acks`), `crm.guardians.core_guardian_id`, `erp.visitors` by phone | deleted or actor removed; policy acknowledgements retained as proof |
| **staff** | `os` (26 tables: bot chats deleted, ownership anonymised, work records retained on the pseudonymous staff row), `erp` HR and payroll, actor columns (`collected_by_user_id`, `sold_by_user_id`, ...), `crm` counsellor rows, `core.ai_generations`, `billing.ai_credit_ledger` / `credit_topup_requests`, `erp.job_applications` by phone/email | `staff_payroll` bank, address, emergency contact, Aadhaar removed (PAN/UAN/ESI kept for statutory returns, CONFIRM); payslips, salary structures, loans, tax declarations **retained** (statutory payroll, ~8 years) |

Exempt (reviewed): `crm.settings` (automation login), `erp.accounts` (`parent_id` = parent account), `erp.vendors` (supplier
business contact), `os.checklist_responses` (photo of a facility item), `billing.plans`.

**Lead id resolution.** A lead is the CRM family as a whole, so `app._compliance_person_keys` resolves a lead as a closure over
the CRM subject rows (household, guardians, prospects, enquiries): any of those ids finds the whole family. Staff, students and
guardians keep the one-step resolution (a guardian's erasure must never reach the other parent or a sibling).

**Money guard.** `erp.immutable_rows` (receipts, receipt payments and allocations, vouchers, voucher lines) still refuses every
update and delete, also for the table owner, except from inside `app._compliance_erase`, `app._compliance_delete_scope` and
`app.compliance_retention_purge` (checked on the call stack; request roles cannot execute them). So a person erasure can remove
the collector or a note from a receipt, and an org / ERP product deletion (after the exit export) can remove the money tables;
`core.table_policy` notes these tables. Tested: a plain owner `delete` / `update` on `erp.receipts` is still refused.

**Retention rows** (all `enabled = false`, `legal_status = 'draft'`, CONFIRM): CRM enquiries 24 months after the last activity
(must skip admitted children before it is enabled: the rule engine filters one column), CRM messages, outbox content, ERP
conversation messages and announcement deliveries 12 months, AI prompts/answers 12 months, students after leaving 84 months
(anonymise), staff after leaving 36 months (anonymise), ERP financial records 96 months (receipts, allocations, payments,
fee demands, vouchers and lines, payslips; one rule per table, children first by `data_type` order).

**Known limits.** A staff login that still owns CRM enquiries or follow-ups cannot be erased until they are reassigned (the
login is referenced without `on delete`; the erasure fails with a foreign-key error and changes nothing). Student-related
data other than the core record (helpdesk, notes, photos: 1 year after leaving) has no retention rule yet.

## Not done (known gaps)

* **No deletion of uploaded files, embeddings, message content or AI-derived data** (`data-retention-schedule.md` 3): those tables and buckets do not exist yet. Org deletion returns the storage prefix to delete; embeddings and message tables get registry and retention rows when they land.
* **Org export is in memory** (zip built per request). Very large orgs need per-table streaming to the sink; the file index of uploaded files is not in the archive.
* No PDF summary of a person export (a text summary instead). No redaction of other people's data inside a row (docs: counsel to advise).
* **Inbound STOP webhooks** need an identity to record consent as (the helper needs a signed-in member or a platform admin); a webhook service identity is not defined yet.
* Deletion certificate is the request row plus `audit.purge_log`; there is no rendered certificate document.
* `legal_holds` placed by a client admin need the policy `compliance.manage`; a UI for holds, requests and the data map is not built.
* Free-text request reasons are stored in the register and the audit trail: operators must not type personal data into them.
* Decision 42's read-only state is still not modelled in `core.subscriptions` (ADR 002): "access ended" is derived from the config history as described above.
* The two-person verification the procedure mentions for deletion is recorded (planned by / confirmed by) but not enforced to be different people (the owner is the only admin today, decision 47).

## Open points for counsel (the numbers are configuration, none is hard-coded)

All periods in `core.retention_policies` are copied from the draft schedule and stay `draft` and disabled: audit log 36 months, config history 36 months, login events 12 months,
support sessions 36 months; lifecycle 30/30 days (fixed by decision 42, marked `confirmed`); token life and export link life are operational defaults. CRM leads (24 months), students after leaving
(7 years), staff after leaving (3 years), messages and AI logs (12 months) and financial records (about 8 years) are rows since `20261126000001` (all disabled drafts). Whether service messages need opt-in, the response deadline for requests, and the erase-versus-retain
rules per table (financial rows are anonymised here) are for counsel; each is one row to change.
