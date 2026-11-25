# AI school designer

Plain words in, validated configuration out (DECISIONS 56-59). A school's management, or an AutoEd relationship manager
inside a support session, types how the school should work; AutoEd turns it into operations on a fixed, typed catalogue
of building blocks, shows a plain-language preview, and changes nothing until someone publishes. Every published plan
is a numbered version with one-click undo. ADR: `docs/adr/designer.md`.

## Where things are

| Path | What |
|---|---|
| `packages/shared/src/designer/catalogue.ts` | block framework: `defineBlock`, `registerBlocks`, `getBlock`, `listBlocks` |
| `packages/shared/src/designer/changeset.ts` | changeset format (zod), `validateChangeset`, `repairChangeset`, `inverseOp`, `previewOps`, `changesetJsonSchema` |
| `packages/shared/src/designer/jsonSchema.ts` | small zod -> JSON schema converter (the keywords Gemini's `responseJsonSchema` takes) |
| `packages/shared/src/designer/os-blocks.ts` | the 17 OS blocks and the `core.custom_object` stub |
| `packages/shared/src/designer/templates.ts` | templates (named, parameterised changesets) and the starter library |
| `packages/shared/src/designer/mock.ts` | deterministic planner used by the mock AI provider |
| `packages/server/src/designer/actor.ts` | who is asking: `org_admin` or `relationship_manager` |
| `packages/server/src/designer/blocks/**` | server side of each block: read / write / remove through the product's own tables |
| `packages/server/src/designer/config.ts` | the configuration summary the AI sees, privacy filter, "explain my school", affected counts |
| `packages/server/src/designer/planner.ts` | system prompt + the AI call (existing pipeline in `services/ai.ts`) |
| `packages/server/src/designer/service.ts` | plan, template plan, dry run, publish, undo, discard, history, support sessions |
| `supabase/migrations/20261127100001_core_designer.sql` | `core.design_changesets`, `core.design_changeset_items`, `app.designer_allowed`, RLS, AI price, PII registry |
| `apps/web/app/designer`, `apps/web/components/designer` | the page (chat-style thread, templates, history with undo, explain my school) |
| `packages/shared/src/i18n/source/08-designer.txt` | strings (en, hi, te; Hindi and Telugu need native review) |
| Tests | `packages/shared/test/designer.test.ts`, `packages/server/test/designer.test.ts`, `packages/server/test-platform/designer.test.ts`, `apps/web/e2e/designer.mjs` |

## How it works

```
prompt ──privacy filter──► AI (Gemini; mock in dev/tests) ──► changeset JSON ──repair──► validate ──► preview
           (names → T-1, S-…; phones, e-mails removed)      (schema-constrained, ≤3 attempts)        (draft | validated)
                                                                                                         │
           undo (restore "before" of each item, newest first) ◄── published vN ◄── publish (re-validate, apply) ◄┘
```

1. **Plan** `POST /api/os/designer/plan {prompt}`. The system prompt holds the catalogue (keys, descriptions, JSON
   schema of the settings, one example each), the starter templates and the school's configuration summary (products,
   branch codes, role keys and names, every configured instance by key and name). The request and the summary go through
   the privacy filter. The call is the existing AI pipeline (`generate()`): credit check, contact-data guard, provider,
   zod validation, deterministic repair, regenerate up to 3 attempts, `core.ai_generations` row, wallet charged only on
   success (action `designer_plan`, 1 credit, a `billing.ai_action_costs` row). The result is repaired (a "create" of
   something that exists becomes an "update", keys come from the settings, stubs and products the school lacks move to
   "unsupported") and validated against the school's configuration (unknown roles, missing items, system rows, the same
   business checks as the settings screens). It is stored as `validated` or, with open issues, `draft`.
2. **Templates** `POST /api/os/designer/templates/:key/plan {params}` builds the changeset from a template without AI
   (free). The planner also sees the templates and is told to prefer them; the mock picks them for the standard requests.
3. **Preview**: each op is a title and lines as i18n keys + values (`designer.op.*`, `designer.preview.*`), the role keys
   it names, how many active staff hold those roles and, for parent notifications, how many families are reached.
   Counts only; never names.
4. **Try on sample data** `POST …/changesets/:id/dry-run` applies the whole plan for real under RLS in a transaction that
   is then rolled back, and shows what would happen (approval chain for sample form values, next run dates and holders of
   checklists and recurring tasks, notification reach).
5. **Publish** `POST …/changesets/:id/publish` locks the org's designer, re-validates against the configuration as it is
   now (refuses `plan_out_of_date`), refuses products the org lacks, applies each op through the block's server side, and
   stores per item the instance state before and after plus the inverse op. The changeset gets the org's next version.
6. **Undo** `POST …/changesets/:id/revert` refuses if a newer published changeset touches the same items
   (`undo_newer_first`) or if any item was changed since publishing (`changed_since_publish`: undo would overwrite
   someone's work), else restores every item's "before" state, newest first.
7. **Explain my school** `GET /api/os/designer/explain`: a plain-language summary built from the same configuration data
   (no AI call, no credits).

Other routes: `GET /designer/whoami`, `/designer/catalogue`, `/designer/templates`, `/designer/changesets`,
`/designer/changesets/:id`, `POST …/discard`; for AutoEd staff `GET /designer/clients`,
`POST /designer/support-session {org_id, reason ≥ 10 chars, minutes 5-240}`, `POST /designer/support-session/end`.

## Safety model

* **No code, no SQL from the AI.** The AI only returns a changeset: block keys from the catalogue and settings that are
  parsed by the block's zod schema. Every statement that changes configuration is fixed, parameterised server code in
  `packages/server/src/designer/blocks/**`.
* **RLS is never bypassed.** Everything runs as the `os_server` role with the actor's claims, like the settings screens:
  the product's RLS, module flags, the platform audit trigger and config history apply to every row. One exception, kept
  narrow: `core.notification_rules` is guarded by the core `notifications` permission module, which the OS role matrix
  does not have, so for school management that block writes as the org's OS system actor after the designer's own
  management check (the generic settings screen has the same gap; see "Known gaps").
* **Who.** Management = a role holding `setup.configure` at branch scope or wider in any product (the people who can use
  the setup wizard). AutoEd relationship managers = platform admins inside an open support session for the school
  (`x-view-as`), reason and time limit required, visible to the school; they act under their own identity, and the
  database records the session id on every row change (`audit.log.support_session_id`). Planning, publishing and undo
  need a read-write session (opened from the designer page); a read-only view-as session can only look. The database
  repeats the rule: `app.designer_allowed(org, write)` in the RLS of the designer tables, and a restrictive insert policy
  makes a changeset carry the signed-in person as author and their own session id. Teachers are refused.
* **No personal data to the AI** (decisions 9 and 40). The AI sees the catalogue and the configuration summary (keys and
  names of configuration rows) and the typed request. Both go through the privacy filter: staff, student and guardian
  names (full and first names) become tokens, phone numbers and e-mail addresses are removed. No staff, student or
  guardian record is put in the prompt. The server test asserts this on what the provider receives.
* **Products.** A block of a product the school has not bought is turned into an "unsupported" note at planning and
  refused at publishing (`product_not_available`).
* **Nothing is live until published, and every change can be undone** (above). Changesets are never deleted.
* **Prompts are personal data** (they can name people): registered in `core.pii_registry` (author, anonymised on erasure).

## The block catalogue (OS)

| Block | Writes | Instance key |
|---|---|---|
| `os.approval_type` | `core.approval_types` + default flow + steps | type key |
| `os.checklist` | `os.checklist_templates` + items (active branch) | key |
| `os.task_category` | `os.task_categories` | key |
| `os.recurring_task` | `os.task_recurrences` (role target, active branch) | `template.designer_key` |
| `os.escalation_rule` | `os.escalation_rules` (org level) | name |
| `os.assignment_rule` | `os.assignment_rules` | `from__to` role keys |
| `os.notification_rule` | `core.notification_rules` (product os) | `event__audience` |
| `os.leave_type` | `core.leave_types` | key |
| `os.attendance_rule` | `core.attendance_rules` (staff, active branch) | position key or `all_staff` |
| `os.module_flag` | `os.module_flags` | `module__BRANCHCODE` |
| `os.role` | `os.roles` (+ copied permissions on create) | role key |
| `os.role_permission` | `os.role_permissions` (one matrix cell; `setup` excluded) | `role__module__action` |
| `os.custom_field` | `core.custom_fields` (product os) | `entity__key` |
| `os.report_schedule` | `os.report_schedules` (recipients = role holders) | report key |
| `os.event_template` | `os.event_templates` | key |
| `os.duty_type` | `os.duty_types` | key |
| `os.plan_review_chain` | `os.plan_submission_rules` | name |
| `core.custom_object` | **stub** for the custom records stream | key |

Starter templates: standard leave policy, teacher absence and substitution, daily opening checklist (housekeeping),
lesson plan review chain, exam-week duty roster, parent absence alerts.

## Add a block (for the CRM, ERP and custom records streams)

1. **Define it** in `packages/shared/src/designer/<product>-blocks.ts`:
   ```ts
   export const leadStageBlock = defineBlock({
     key: 'crm.lead_stage', product: 'crm', title: 'Enquiry stage',
     description: 'A stage of the enquiry pipeline… (written for the AI: when to use it, what each setting means)',
     settings: z.object({ key: keySchema, name: z.string().min(2), follow_up_hours: z.number().int().min(1) }), // reuse the settings screen's schema
     keyOf: (s) => s.key,                                    // the stable instance key changesets refer to
     describe: (s) => [{ messageKey: 'designer.preview.crm.stage', vars: { hours: s.follow_up_hours } }],
     roles: (s) => [],                                       // role keys named (who is affected, checked to exist)
     check: (s, op) => [],                                   // business rules of the settings screen, as issue codes
     examples: [{ prompt: 'Follow up new enquiries within 24 hours', settings: { key: 'new', name: 'New', follow_up_hours: 24 } }],
   });
   export const CRM_BLOCKS = [leadStageBlock] as unknown as BlockDef[];
   ```
   and `registerBlocks(CRM_BLOCKS)` in `packages/shared/src/designer/index.ts`. Never rename a key once published
   (changesets store it). To replace the stub, register a block with the key `core.custom_object` (a later registration
   wins) and drop `stub`.
2. **Apply it** in `packages/server/src/designer/blocks/<product>/<area>.ts` with a `ServerBlock`:
   `read(x, key)` (current settings or null), `list(x)` (key + name of every instance: what the AI sees), `write(x, key,
   settings)` (create or update so that `read` returns them), `remove(x, key)`; add `capture` / `restore` only if `read`
   loses information needed to restore exactly. Use `x.c` (the request transaction, actor's claims) and fixed,
   parameterised SQL against your product's own tables; never `asOwner`, never `service_role`. If your product server has
   its own role, add a block runner for it the same way (the transaction must be your role with the actor's claims).
   Register it in `packages/server/src/designer/blocks/index.ts` (`registerServerBlocks`).
3. **Strings**: `designer.block.<key>.title` and every `designer.preview.*` key `describe` uses, in
   `packages/shared/src/i18n/source/08-designer.txt` (en | hi | te), then `pnpm i18n:build && pnpm lint`.
4. **Tests**: the shared test checks every example parses and every preview key exists; add a server test that plans
   (or builds a template), publishes, checks the product table and reverts to the exact previous state.
5. **Mock** (optional): teach `packages/shared/src/designer/mock.ts` your standard requests (today CRM and ERP requests
   return an "unsupported yet" note) so the feature stays demoable without Gemini.

## Add a template

Append `defineTemplate({ key, product, title, description, keywords, params, paramsSchema, build })` to
`packages/shared/src/designer/templates.ts` (or `registerTemplates([...])` from your product's file). `paramsSchema` gives
every parameter a default; `build(params)` returns a changeset and must be pure. Add `designer.template.<key>.title`,
`.description` and `designer.param.<param>` strings. Real school workflows (decision 59: Sloka) go in the same way.

## Running it

* Development and tests use the mock provider (no `GEMINI_API_KEY`): `pnpm dev`, sign in as `chairman@demo.school`,
  open `/designer` (link on the product landing page and in the OS menu for management). A production build refuses the
  mock by design (ADR ai-gemini), so the browser test runs against `next dev`:
  `BASE_URL=http://localhost:3921 CHROMIUM_PATH=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome NODE_PATH=/opt/node-tools/node_modules node apps/web/e2e/designer.mjs`.
* AutoEd staff: sign in as `admin@autoed.dev`, open `/designer`, choose the school, give a reason; the session is
  read-write, shown to the school, and ends from the banner or by time.

## Known gaps

* CRM and ERP blocks are not written yet; their requests come back as "not possible yet" notes (decision 58 asks for
  all three products; this is the framework they plug into).
* `core.notification_rules` writes for management go through the OS system actor (see the safety model); the right fix
  is a `notifications` permission in the OS matrix (or mapping `setup.configure` to it in `os.sync_access`).
* Branch-level blocks (checklists, recurring tasks, attendance rules, report schedules) apply to the active branch only.
* The roster filter catches names as written in the roster; nicknames or misspellings are not caught. Prompts are kept
  (as personal data, erasable) so they can be reviewed.
* The shared `PHONE` pattern in `packages/shared/src/rules/privacy.ts` misses `+91` numbers written without a separator;
  the designer filter adds its own digit-run rule. The shared pattern should be fixed separately (it is used by other
  AI features).
* Voice input (Hindi / Telugu) is later (decision 59). Hindi and Telugu strings need a native review.
