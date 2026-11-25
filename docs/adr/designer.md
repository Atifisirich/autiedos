# ADR: AI school designer (plain words -> validated configuration)

Status: accepted (2026-11-25). Implements DECISIONS 56-59; respects 9, 35-37, 40, 50. Guide: `docs/designer.md`.

## Context

Schools differ in how they run approvals, checklists, duties and messages. Configuring that through many settings screens
is slow, so management (and AutoEd relationship managers on a visit) should be able to describe it in plain words. The
owner's decisions: the AI turns text into configuration built from a fixed catalogue of blocks, never code; AutoEd
validates with the same rules as the settings screens and previews in plain language; nothing is live until an
authorised person publishes; every published change is versioned with one-click undo; the AI sees only the catalogue and
the school's configuration, never personal data; Gemini only (mock in development); cost from the school's AI wallet.

## Decision

1. **Typed block catalogue in `@autoed/shared`.** A block = key (`<product>.<name>`), product, title, description for
   the AI, zod settings schema (reusing the settings screens' schemas), stable instance key, plain-language preview (i18n
   keys), roles named, business checks, examples. Blocks register themselves; CRM, ERP and the custom-records stream add
   theirs the same way. A stub (`core.custom_object`) keeps the catalogue complete while its engine is built elsewhere.
2. **Changeset** = summary + ordered ops (create / update / delete of one block instance, by stable key) + "unsupported"
   notes + questions + optional template key. Its JSON schema (one `anyOf` variant per block) is the constrained output
   format sent to Gemini; zod validates the answer again, deterministic repair fixes op kinds and keys, and the existing
   pipeline regenerates up to 3 times on fixable issues.
3. **Server blocks apply through the product's own tables** in the request transaction, as `os_server` with the actor's
   claims, so RLS, module flags, audit and config history are exactly those of the settings screens. Each block
   implements read / list / write / remove (and capture / restore where read is lossy). Before and after states are
   stored per item; undo restores "before" and refuses when the item changed since (no silent overwrite) or when a newer
   published plan touches it.
4. **Two tables in `core`** (`design_changesets`, `design_changeset_items`), org-scoped, RLS through
   `app.apply_core_rls` plus `app.designer_allowed(org, write)`: management (a role with `setup.configure` at branch
   scope or wider, any product) or platform staff in an open support session for the org (writing only in a read-write
   session). Restrictive insert policy: author = signed-in person, session id = their own open session. No delete.
5. **Relationship managers** use their own identity inside a support session opened from the designer with a reason and
   a time limit (`app.start_support_session(..., read_only => false)`); the OS dispatcher lets only `/designer/*` routes
   write under `x-view-as` (every other OS route stays read-only for support). Audit rows carry the session id.
6. **Privacy filter** before the AI: roster names (staff, students, guardians; full and first names) become tokens,
   phones and e-mails are removed; the summary contains configuration keys and names only.
7. **Mock planner** (`mockDesignerPlan`) covers the standard requests deterministically so the feature is demoable and
   testable without Gemini; ERP and CRM requests return "not supported yet" until their blocks exist.
8. **Explain my school** is deterministic (no AI, no credits) from the same configuration summary.

## Consequences

* Adding a configurable area to a product means adding a block (shared definition + server apply + strings), not
  teaching the AI SQL. The catalogue is also documentation of what is configurable.
* The AI can only produce what a settings screen could; it cannot widen access (`setup` permissions are excluded from
  the role-permission block, preset roles and system approval types cannot be deleted).
* `core.notification_rules` needs the core `notifications` permission that OS roles do not carry, so for management
  that one block writes as the OS system actor after the designer's management check (documented gap; fix in the OS
  role mapping).
* A production build never uses the mock (ADR ai-gemini); browser tests of the designer run against `next dev`.
* The platform-only migration filter (`scripts/db.mjs`) includes `_core_designer` so the isolation harness covers the
  new tables (fixture rows for orgs A and B; `test-platform/designer.test.ts` checks the access rule).

## Alternatives rejected

* **Let the AI write SQL or code** (decision 56 forbids it; unreviewable, bypass risk).
* **Free-form JSON patches of config tables** (no stable keys, no preview semantics, no per-area business rules).
* **Impersonating the school's director for RMs** (as the read-only view-as does): the audit would show the director,
  not AutoEd staff; decision 57 asks for an audited RM identity.
* **Undo by re-running the inverse op through write()** for every block: lossy for areas whose settings do not capture
  every column (report recipients, notification settings keys); capture / restore of the raw state is exact.
