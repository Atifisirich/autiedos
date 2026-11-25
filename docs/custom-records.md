# Custom records engine

Decisions 56–59 (AI school designer), with 28 (neutral words), 37 (one person, one client) and 50 (shared data in
`core`). Design choices: `docs/adr/custom-records.md`.

When nothing AutoEd already has fits a school's need ("Hostel visitor log", "Sports Day equipment checklist", "Library
late-return register"), management — or an AutoEd relationship manager in a support session, or the AI designer on
their behalf — defines a **custom object**. It is a typed definition, not code: no migration, no new table. 500 schools
making 500 custom things share three tables.

## Files

| File | What |
|---|---|
| `supabase/migrations/20261127200001_core_custom_records.sql` | tables, validation triggers, RLS helpers and policies, workflow / approval functions, export log, reminders, compliance registry rows |
| `packages/shared/src/custom-records.ts` | the definition schema (zod) shared by server, web builder and designer adapter: `recordObjectSchema`, `RECORD_FIELD_TYPES`, … |
| `packages/server/src/custom-records/*` | `db.ts` (product roles), `service.ts`, `routes.ts` (`dispatchRecords`), `reminders.ts`, `designer-adapter.ts` |
| `apps/web/app/api/records/[...path]/route.ts` | Next.js route → `dispatchRecords` |
| `apps/web/app/records/**`, `apps/web/components/records/**`, `apps/web/lib/records/api.ts` | screens |
| `packages/shared/src/i18n/source/08-records.txt` | en / hi / te strings (hi and te **need native review**) |
| `packages/server/test-platform/{fixture-records,records.test}.ts` | isolation harness fixtures and database tests |
| `packages/server/test/records.test.ts` | server routes, export, workflow, reminders, designer adapter (demo school) |
| `apps/web/e2e/records.mjs` | browser check (builder, records, export, teacher permissions) |

`scripts/db.mjs --platform-only` now also applies `*_core_custom_*` (the harness database).

## Data model (`core`)

| Table | Holds |
|---|---|
| `core.custom_objects` | one definition: `org_id`, `product_key` (`core` = every product of the school, or `crm`/`os`/`erp`), `key` (unique per org, never changes; `new` and `approvals` are reserved), `label_singular`/`label_plural` (+ `labels_i18n`), `description`, `icon`, `fields`, `title_field`, `list_columns`, `form_layout`, `permissions`, `states`, `portal`, `schedule`, `archived`, `version` (bumped on every definition change) |
| `core.custom_records` | `org_id`, `branch_id` (null = whole school), `object_id`, `data jsonb`, `state`, `pending_state` + `pending_approval_id` (while an approval waits), `owner_id` (auth user, "own" rules), `staff_ids` / `learner_ids` (copied from person / learner fields by the trigger, for compliance and indexes), standard columns. Indexes start with `org_id`; GIN on `data` (`jsonb_path_ops`), `staff_ids`, `learner_ids` |
| `core.custom_record_events` | history: `created`, `updated` (changed fields with from/to), `state`, `approval_requested`, `approved`, `rejected`, `deleted`, `restored`, `exported` (object-level, `record_id` null); `actor_user_id`, `note` |

All three follow the core rules (R3 standard columns, `unique (org_id, id)`, composite foreign keys, `trg_touch`,
audit trigger through `app.apply_core_rls`), so the isolation harness checks them like every other core table.

### Definition (`fields`, `permissions`, `states`, `portal`, `schedule`)

```jsonc
{
  "fields": [
    { "key": "visitor_name", "label": "Visitor name", "type": "text", "required": true },
    { "key": "student", "label": "Student", "type": "learner", "required": true },
    { "key": "visit_date", "label": "Date", "type": "date", "default": "today" },
    { "key": "purpose", "label": "Purpose", "type": "choice", "options": ["Parent visit", "Delivery"] },
    { "key": "pass_no", "label": "Pass number", "type": "text", "unique": true }
  ],
  "permissions": [
    { "who": "role", "product": "os", "role": "os_class_teacher", "view": "own", "create": true, "edit": "own", "delete": "none", "export": false },
    { "who": "all_staff", "view": "all" }
  ],
  "states": {
    "list": [{ "key": "open", "label": "Open" }, { "key": "approved", "label": "Approved" }, { "key": "closed", "label": "Closed", "final": true }],
    "initial": "open",
    "transitions": [
      { "from": "open", "to": "approved", "label": "Approve", "approval": true, "approver_roles": ["os:os_principal"] },
      { "from": "approved", "to": "closed", "roles": ["os:os_warden"] }
    ]
  },
  "portal": { "enabled": false, "learner_field": "student" },
  "schedule": { "reminder": { "date_field": "visit_date", "days_before": 1 } }
}
```

Field types: `text`, `long_text`, `number`, `money` (two decimals), `date` (`YYYY-MM-DD`), `datetime` (ISO), `yes_no`,
`choice`, `multi_choice`, `person` (a `core.staff` id), `learner` (`core.students`), `section` (`core.sections`),
`branch`, `file` (`core.files`), `phone`, `email`, `url`. Options per field: `required`, `unique` (not for long text,
yes/no, multi-choice, file), `default` (`today` for dates, `now` for date-times, `me` for a person, a literal otherwise),
`options` (choices), `min`/`max` (numbers), `max_length` (text; default 500, long text 10 000), `help`.

## Who sees and does what (all in SQL)

| Person | Objects | Records |
|---|---|---|
| **Management**: `records.configure` or `setup.configure` in the owning product (any product for `core`) | create, change, archive, delete (only while empty) | everything, including archived objects (view/export) |
| Holder of `records.<action>` in the owning product (e.g. an admin role with `*`) | sees | that action on every record |
| Staff matched by a rule (`all_staff`, or a role key of the owning product; any product for `core`) | sees when the rule gives view or create | `view`/`edit`/`delete` = `all`, `own` (rows they own) or `none`; `create` → they own the new row; `export` |
| Staff without a rule | nothing | nothing |
| Guardian / parent / student | only objects with `portal.enabled` | read only, rows whose `portal.learner_field` is one of their learners (`app.my_learner_ids()`); never the history. **Off by default** |
| Support "view as" (AutoEd relationship manager) | as management in a read-write session (decision 57), read-only otherwise | read (and write in a read-write session) |

Always also: `org_id = app.current_org_id()`, the owning product is on for the person (`app.user_has_product`, or any
product for `core`), and branch visibility (`branch_id` null or one of `app.user_branch_ids()`). Functions:
`app.custom_records_can_manage(org, product)`, `app.custom_record_level(object, action)` → `all | own | null`,
`app.custom_record_can(object, action, branch, owner, data)` (the row check the policies call),
`app.custom_object_visible(row)`, `app.custom_record_event_visible(object, record)`.

Writes: `insert` needs `create`; `update` needs `edit` (data, branch, owner) or `delete` (setting `deleted_at`, soft
delete) — checked by the trigger per column; only management changes the owner or hard-deletes. `state` and the
pending columns can only be changed by the engine's functions (checked on the call stack; a request cannot write them).

## Validation in the database

`core.custom_objects_validate` (`app.custom_object_problems`): keys, labels, known types, choices, defaults, title /
list / layout fields, permission rules (roles of the owning product), states and transitions, portal learner field,
reminder date field. `core.custom_records_validate` (security definer, so it sees every row of the org): unknown keys
(a key of a removed field is dropped when the record is next saved), required, type checks, choices, number range and
decimals, phone / e-mail / URL shapes, **link targets must be live rows of the same org**, unique values per object
(advisory lock), size ≤ 64 KB; defaults on insert; first state; `staff_ids` / `learner_ids`. Errors are
`23514 custom_records: Visitor name is required; Purpose must be one of the choices` (the server returns 422 with the
message; the screens show it).

## Workflow and approvals

`core.custom_record_transition(record, to, note)` → `done` or `pending`. Needs edit access and a defined transition
(and one of its `roles`, unless management). With `approval: true` it creates a `core.approval_requests` row
(approval type `custom_record`, `linked_type = 'custom_record'`, `data.approver_roles`, approvers' staff ids in
`pending_approver_ids`) and sets `pending_state`. `core.custom_record_decide(request, ok, comment)` decides (management
or a holder of an approver role; never the applicant unless management); `core.custom_record_approvals()` lists what the
person may decide. The record moves through a trigger on `core.approval_requests`, so an approval decided by another
engine applies too. Everything lands in the history.

## Server (`@autoed/server/custom-records`)

Every call is one transaction as a **product role** (`os_server`, `erp_server`, `crm_server`: the owning product's role,
or for `core` the first product the person holds) with `request.jwt.claims` of the signed-in person — never
`service_role` or the owner. Connections: `CRM_DATABASE_URL` / `OS_DATABASE_URL` / `ERP_DATABASE_URL` /
`JOB_RUNNER_DATABASE_URL`, else `DATABASE_URL` with the user switched to the role (`<ROLE>_DB_PASSWORD`).

`dispatchRecords(req)` (framework-free; `apps/web/app/api/records/[...path]`), paths under `/api/records`:

| Route | |
|---|---|
| `GET /meta` | products the person manages objects for, roles for permission rules |
| `GET /objects` (`?archived=1`) · `POST /objects` · `GET/PATCH/DELETE /objects/:key` | definitions with `access` (`view/create/edit/delete/export` levels, `manage`) |
| `GET /objects/:key/records` | `q` (values), `state`, `mine=1`, `sort` (field / `created_at` / `updated_at` / `state`), `dir`, `page`, `pageSize` (≤200), `f.<field>=v`, `f.<field>.from/.to` (numbers, dates); returns `rows`, `total`, `labels` (names of linked staff / learners / classes) |
| `POST /objects/:key/records` · `GET/PATCH/DELETE /objects/:key/records/:id` · `POST …/restore` · `POST …/transition` | record CRUD (PATCH merges; null clears), soft delete, workflow |
| `GET /objects/:key/export.csv` | CSV of the filtered list (≤10 000 rows, link names, formula-safe), logged in `audit.log` (`records.export`, counts only) and the object history |
| `GET /approvals` · `POST /approvals/:id/decide` | custom-record approvals |
| `GET /lookup/:type?q=` | options for `person`, `learner`, `section`, `branch`, `file` fields (under RLS) |

The session is the platform session (`os_session` cookie / Bearer); `must_change_password` → 403
`password_change_required`. The `x-view-as` header of the OS API is not read here: a support session works through the
database (`app.support_session_id()`).

### Reminders

`runRecordReminders(db)` (called from `apps/web/app/api/cron/tick` after the OS tick accepted the cron secret) runs as
`job_runner`: `app.custom_records_enqueue_reminders()` adds one `private.jobs` row (`kind = 'records.reminder'`) per
record whose reminder date is due (`date − days_before = today`, state not final), only for orgs that still have the
owning product, once per record and date; `private.claim_record_jobs()` claims only these jobs (and skips + logs orgs
that lost the product, like `claim_jobs`); `app.custom_records_deliver_reminder(job)` writes an in-app
`core.notifications` row for the record owner (deduplicated).

## Designer adapter

`packages/server/src/custom-records/designer-adapter.ts` exports `customObjectBlock`; the AI designer uses it for its
`core.custom_object` block (`packages/server/src/designer/blocks/core/custom-object.ts`, docs/designer.md "Custom
registers"), running the adapter's database calls in savepoints of the designer's transaction. Block type `'custom_object'`; its settings are a custom
object definition (`RecordObjectInput` from `@autoed/shared`, the JSON above plus `key`, `product_key`, labels).

```ts
import { customObjectBlock, type CustomObjectBlockContext } from '@autoed/server/custom-records';

const ctx: CustomObjectBlockContext = { db, userId, products };   // db: RecordsDb (defaultRecordsDb() in production)

const v = await customObjectBlock.validate(config, ctx);  // { ok, issues: [{path, message, severity}], config?, mode?: 'create'|'update' }
const p = await customObjectBlock.preview(config, ctx);   // { mode, title, summary, changes: string[], affects: string[], warnings: string[] }
const r = await customObjectBlock.apply(config, ctx);     // { type: 'custom_object', mode, objectId, key, version, before }  (store it in the changeset)
await customObjectBlock.inverse(r, ctx);                  // { undone: 'restored' | 'deleted' | 'archived' }
```

* `validate(config, ctx?)`: the shared schema; with `ctx` also: may this person manage the owning product, does the key
  already exist (→ `mode: 'update'`, owning product must match), do the role keys exist, warnings for removed fields and
  type changes. Without `ctx` it is a pure check (the AI's draft before anything is shown).
* `preview`: plain language for the publish screen ("Creates a new list … with 5 fields", "Class Teacher: see their own
  entries, add entries", "Open → Approved needs approval by Principal", "Parents and students: …", reminder).
* `apply`: creates or updates as the publishing person, under RLS (management only, a support session must be
  read-write). Returns `before` = the previous definition (null when created).
* `inverse`: undo of a published changeset: restores `before`; a created object is deleted, or **archived** when
  entries were added since (no data is lost).
* The AI and the adapter only ever handle definitions; records (personal data) are never read (decision 56).

## Compliance

`core.pii_registry` rows (migration): `custom_records` by `learner_ids` (student: **delete** — the entry is about the
learner; its history goes with it), by `staff_ids` (staff: **anonymise** — `data`, links emptied, the dated row stays),
by `owner_id` (staff login: ownership removed); `custom_record_events.actor_user_id` (staff / guardian / student:
actor and note removed). Person export (`exportPerson`) therefore includes a learner's or staff member's entries; org
export and deletion need nothing (catalogue-driven). When the compliance engine changes a record, the validation
trigger steps aside and the values kept in its history are scrubbed. A draft retention row
`custom_records_inactive` (84 months after the last change, disabled, CONFIRM) is in `core.retention_policies`.
Free-text fields can hold personal data about people who are not linked (a visitor's name): they are exported and
erased only with the linked person's records — counsel to confirm (see the ADR).

## Screens (`/records`)

Linked from the landing page and the product switcher ("Custom registers").

* `/records` — registers the person can use; management: "New register", show archived.
* `/records/new`, `/records/:key/edit` — object builder: name, owning product, fields (type, required, no duplicates,
  defaults, choices, order), title and list columns, rules per role, workflow (steps, moves, approval and approvers),
  family visibility, reminder; archive / bring back.
* `/records/:key` — list: search, state and choice / yes-no filters, sortable columns, paging, "Only mine", Export CSV,
  Add.
* `/records/:key/new`, `/records/:key/:id` — form (link fields search the school's staff, students, classes), detail with
  workflow buttons, edit, delete / restore, history.
* `/records/approvals` — approve / reject.

Strings: `records.*`, `shell.switcher.records`, `shell.landing.records` in en / hi / te (hi and te need native review).

## Running the checks

```bash
export DATABASE_URL=postgres://postgres@localhost:54322/records AUTH_PROVIDER=dev AUTH_JWT_SECRET=x
pnpm i18n:build && pnpm db:reset
pnpm --filter @autoed/server test -- test/records.test.ts
POSTGREST_PORT=4011 pnpm test:platform           # resets DATABASE_URL to the platform-only harness world
pnpm db:reset && NEXT_PUBLIC_AUTH_PROVIDER=dev pnpm --filter @autoed/web build
(cd apps/web && PORT=4301 npx next start -p 4301 &) ; BASE_URL=http://localhost:4301 CHROMIUM_PATH=/opt/pw-browsers/chromium node apps/web/e2e/records.mjs
```
