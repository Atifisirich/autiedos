# ADR — Custom records engine: typed objects in shared core tables

Status: built and tested on local Postgres only. Date: 2026-11-27.
Implements: decisions 56–59 (AI school designer: "when nothing existing fits it creates a NEW element on the spot"),
with 28, 37 and 50. Builds on ADR 001 (roles), 002 (entitlements), 005 (harness), core-master-001 (audiences) and the
compliance tooling ADR. Reference: `docs/custom-records.md`.

## Context

Schools keep many small registers that no product models: hostel visitor logs, equipment checklists, late-return
registers. The AI designer must be able to create one from plain words, safely, for hundreds of schools, without a
developer, a migration or a new table, and without ever writing SQL (decision 56).

## Decision

1. **Three shared tables in `core`** (`custom_objects`, `custom_records`, `custom_record_events`), `data jsonb` per
   record. Not one table per object (DDL at runtime, grants, RLS and harness coverage per table, migrations across 500
   schools) and not an entity-attribute-value table (no per-record validation, slow lists). `core`, not a product
   schema, because an object may belong to every product (`product_key = 'core'`) and the AI designer spans CRM, OS
   and ERP (decision 58); a product-owned object still lives in `core` with `product_key` checked by every policy.
2. **The database is the authority.** Definitions are validated by a trigger (`app.custom_object_problems`) and records
   by a security-definer trigger (types, required, choices, unique, links to live rows of the **same org**). The zod
   schema in `@autoed/shared` mirrors the rules for early messages; a second writer (Data API, designer, import) cannot
   bypass them.
3. **Permissions are data, evaluated in SQL.** An object's `permissions` are rules for `all_staff` or a product role key
   (`core.user_product_access.role_key`), with `all | own | none` for view / edit / delete and booleans for create /
   export. `app.custom_record_can` is called by the row policies, after org isolation, product entitlement and branch
   visibility. Management is `records.configure` or `setup.configure` (org admin roles, decision 57) and always has full
   access; there is no separate "custom records admin" concept to maintain. Rules name **role keys**, so the OS's
   derived keys (`os_class_teacher`, or `os_x<hash>` for combined roles) appear as-is; the builder lists the school's
   roles by name.
4. **Families are opt-in per object** (`portal.enabled` + a learner field), read only, own learners only, never history.
   Default off, because free text in a staff register is usually not meant for parents.
5. **State changes only through functions.** `state` / `pending_*` are refused for request roles unless the call stack
   shows `core.custom_record_transition` or the approval trigger (the same technique as the compliance engine's money
   guard), so the workflow and its approvals cannot be skipped through the Data API. Approvals reuse
   `core.approval_requests` (`linked_type = 'custom_record'`); the record moves in a trigger on that table, so any
   approval engine that decides the request applies it.
6. **Server as product roles.** Requests run as the owning product's role (or, for `core`, a product the person holds)
   with the person's claims, never `service_role`. Reminders run as `job_runner` through three narrow functions and a
   kind-filtered claim (`private.claim_record_jobs`) so they never take other products' jobs.
7. **Compliance through derived columns.** Person and learner link fields are copied to `staff_ids` / `learner_ids`
   (uuid arrays) by the validation trigger, so the catalogue-driven tooling finds a person's records with ordinary
   `core.pii_registry` rows (array keys are already supported). Learner → delete the record; staff → anonymise
   (`data` emptied); logins and history actors → anonymised. The validation trigger steps aside inside the compliance
   functions and the history values of an erased record are scrubbed.
8. **Designer adapter, not designer code.** `customObjectBlock` (`validate / preview / apply / inverse`) is the only
   surface the designer needs; `inverse` archives instead of deleting when entries exist, so undo never loses data.

## Consequences

* A new register is a row; lists, forms, export, history, workflow and permissions work for it at once (web screens
  under `/records`). The harness, the catalogue and coverage tests treat the tables like every other core table.
* JSON queries: list filters and sorting use `data->>'key'` with keys validated against the definition; the GIN index
  serves containment. Very large registers (hundreds of thousands of rows) may need expression indexes per hot field —
  not added automatically.
* Changing a field's type or removing a field does not rewrite old records: a removed field's value is dropped when the
  record is next saved; a changed type must be fixed in records that are edited later. The designer adapter warns.
* Row checks call a security-definer function per row (it reads the object once per call). Fine for registers of
  thousands of rows; a per-object cache or a precomputed visibility column is the next step if lists get slow.

## Not done / open

* No file upload widget: a `file` field links an existing `core.files` row (the upload service is a separate stream).
* Reminders notify the record owner in-app only (no WhatsApp / push channel, no "notify role" option, no recurring
  schedules such as "every Monday" without a date field).
* No per-field permissions (e.g. hide "phone" from teachers) and no computed fields or cross-record rules.
* The OS `x-view-as` header is not read by `/api/records`: support sessions work through the database session only.
* Labels are not translated per language yet (`labels_i18n` is stored, the screens show the base label).
* Counsel: free-text fields can name people who are not linked (a visitor). Such text is exported and erased only with
  the linked learner or staff member; retention of the whole table is a disabled draft row.
* Hindi and Telugu strings are first translations and need native review.
