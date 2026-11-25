# AI school designer

Plain words in, validated configuration out (DECISIONS 56-59), for the OS, the CRM, the ERP and custom registers. A school's management, or an AutoEd relationship manager
inside a support session, types how the school should work; AutoEd turns it into operations on a fixed, typed catalogue
of building blocks, shows a plain-language preview, and changes nothing until someone publishes. Every published plan
is a numbered version with one-click undo. ADR: `docs/adr/designer.md`.

## Where things are

| Path | What |
|---|---|
| `packages/shared/src/designer/catalogue.ts` | block framework: `defineBlock`, `registerBlocks`, `getBlock`, `listBlocks` |
| `packages/shared/src/designer/changeset.ts` | changeset format (zod), `validateChangeset`, `repairChangeset`, `inverseOp`, `previewOps`, `changesetJsonSchema` |
| `packages/shared/src/designer/jsonSchema.ts` | small zod -> JSON schema converter (the keywords Gemini's `responseJsonSchema` takes) |
| `packages/shared/src/designer/os-blocks.ts` | the 17 OS blocks |
| `packages/shared/src/designer/crm-blocks.ts` | the 11 CRM blocks (`slugKey`, CRM phases / capabilities / triggers kept in step with `packages/crm-server`) |
| `packages/shared/src/designer/erp-blocks.ts` | the 14 ERP blocks (`erpLevelRows` / `erpLevelOf`, the ERP capability map kept in step with `apps/web/lib/erp/caps.ts`) |
| `packages/shared/src/designer/core-blocks.ts` | `core.custom_object`: the custom records engine's definition schema as a block |
| `packages/shared/src/designer/templates.ts` | templates (named, parameterised changesets) and the OS starter library |
| `packages/shared/src/designer/product-templates.ts` | CRM and ERP starter templates (`CRM_RECIPES` = copy of the CRM recipe library, checked by a server test) |
| `packages/shared/src/designer/mock.ts` | deterministic planner used by the mock AI provider |
| `packages/server/src/designer/actor.ts` | who is asking: `org_admin` or `relationship_manager` |
| `packages/server/src/designer/blocks/**` | server side of each block: read / write / remove (and `check`, `capture` / `restore`) through the product's own tables: `os/`, `crm/` (as crm_server, through the CRM's `Db` and audit trail), `erp/` (as erp_server), `core/custom-object.ts` (the custom records designer adapter) |
| `packages/server/src/designer/config.ts` | the configuration summary the AI sees, privacy filter, "explain my school", affected counts |
| `packages/server/src/designer/planner.ts` | system prompt + the AI call (existing pipeline in `services/ai.ts`) |
| `packages/server/src/designer/service.ts` | plan, template plan, dry run, publish, undo, discard, history, support sessions |
| `supabase/migrations/20261127100001_core_designer.sql` | `core.design_changesets`, `core.design_changeset_items`, `app.designer_allowed`, RLS, AI price, PII registry |
| `supabase/migrations/20261127300001_crm_erp_designer.sql` | `erp.approval_rules` (read by `erp.submit_approval`), `crm.workflows.stop_rules`, `app.designer_log_generation`, designer read rule for CRM management, support sessions in `app.can` / `crm.scope_of` |
| `apps/web/app/designer`, `apps/web/components/designer` | the page (chat-style thread, templates, history with undo, explain my school) |
| `packages/shared/src/i18n/source/08-designer.txt`, `08-designer-products.txt` | strings (en, hi, te; Hindi and Telugu need native review) |
| Tests | `packages/shared/test/designer.test.ts`, `packages/server/test/designer.test.ts` (OS), `packages/server/test/designer-products.test.ts` (CRM, ERP, custom registers), `packages/server/test-platform/designer.test.ts`, `apps/web/e2e/designer.mjs` |

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
* **One transaction per product login.** The designer's own rows run as the actor's *home* product login (OS when the
  school has it, else CRM, else ERP). Each block runs as its own product's login with the actor's claims: OS blocks as
  `os_server`, CRM blocks as `crm_server` (through the CRM server's `Db` class and `crm.audit_event`, like the CRM admin
  console), ERP blocks as `erp_server` (the same rows and policies the ERP screens reach through the Data API), the
  custom records engine inside the designer's own transaction (its adapter runs in savepoints). The per-product
  transactions (`ApplyCtx.tx(product)`) are opened on first use and committed together after everything succeeded, or all
  rolled back (a dry run rolls all of them back). A write that the row policies refuse (no row changed) is an error, never a
  silent "published".
* **RLS is never bypassed.** Everything runs as a product server role with the actor's claims, like the settings screens:
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
* **Products.** The AI is only shown the blocks and templates of the products the school has (and the person was given);
  a block of another product is turned into an "unsupported" note at planning (`product_not_in_plan`), its template is
  refused (403 `product_not_available`), and publishing refuses it again. The mock planner answers a CRM request of a
  school without the CRM (and the same for the ERP) with a "not part of your plan" note.
* **The settings screens' own rules.** Besides the shared schema each server block can `check` a plan against the school
  as it is (the custom records adapter's `validate`: management rights, roles exist; CRM: a stage's phase cannot change,
  stages and sources named by a workflow or form exist; ERP: fee heads and grading scales exist; an op may rely on an
  item an earlier op of the same plan creates). Failures make the plan a draft and are re-checked on publish. The AI cannot
  widen access: CRM and ERP group admins and the admin capability are changed only on the roles screens; a cloned CRM role
  never gets the full admin level; a fee plan whose items already have demands keeps its items.
* **Nothing is live until published, and every change can be undone** (above). Changesets are never deleted.
* **Prompts are personal data** (they can name people): registered in `core.pii_registry` (author, anonymised on erasure).

## AI calls and the wallet without the OS

The planner call goes through the same AI pipeline (`generate()`: credit check against the school's wallet, contact-data
guard, the provider, validation and repair, at most 3 attempts). With the OS the generation row is booked as the OS system
actor (as every OS AI feature); a CRM- or ERP-only school has no such actor and its managers hold no `ai` permission, so
the row is booked through `app.designer_log_generation` (security definer: action `designer_plan` only, the caller's own
org, only someone `app.designer_allowed` lets write) with the school's product, and `app.ai_charge` takes the credit. A
school without an AI allowance (`billing.ai_allowances`) gets 402 `credits_exhausted`; the CRM and ERP demo seeds give their
schools 500 credits.

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

OS starter templates: standard leave policy, teacher absence and substitution, daily opening checklist (housekeeping),
lesson plan review chain, exam-week duty roster, parent absence alerts.

## The block catalogue (CRM: applied as crm_server)

| Block | Writes (as the CRM admin console does) | Instance key |
|---|---|---|
| `crm.stage` | `crm.stages` in a phase (prospect ... closed: the phase is the stage's mapping onto the funnel), SLA hours, required fields (closure reason, visit, expected decision), probability; remove = retire (refused while records are in it or for New / New data / Admission confirmed) | slug of the name |
| `crm.lead_source` | `crm.sources` (channel, name, monthly cost); remove = inactive | slug of the name |
| `crm.assignment_rule` | `crm.assignment_rules`: round robin or least load among the active holders of a CRM role (user ids are resolved on publish, never named in the plan), optional branch / channel / grades, `daily_capacity` written to `crm.counsellor_settings` of those people (undo restores every capacity) | slug of the name |
| `crm.follow_up_sla` | `crm.settings.first_response_mins` (the sweep tags late enquiries and runs `sla_breach` workflows) | `first_response` |
| `crm.workflow` | `crm.workflows`: trigger, conditions, steps (send a template with fallbacks, task, wait, notify owner / branch heads / **every holder of a role**, stage, tag, reassign), status, **stop rules** (`stop_rules`: stop on parent reply, stop when the stage changes) | recipe key or slug of the name |
| `crm.message_template` | `core.message_templates` (product crm); a new WhatsApp template waits for provider approval | `slug__channel` |
| `crm.enquiry_form` | `crm.forms` (public link, source by name, branch by code, optional fields); remove = off | slug of the name |
| `crm.messaging_limits` | `crm.settings` quiet hours and automated messages per family per day | `messaging` |
| `crm.scoring` | `crm.settings` scoring weights, hot / warm thresholds | `scoring` |
| `crm.role` | `core.roles` + `crm.roles` (a copy of another role's matrix, never the full admin level); remove only while nobody holds it | role key |
| `crm.role_permission` | one cell of `crm.roles.permissions` (not the group admin, not the admin capability) | `role__capability` |

CRM runtime changes that come with it: a workflow `notify` step with `who: 'role'` alerts every active holder of that CRM
role in the branch (`roleHolders` in `packages/crm-server/src/workflows.ts`), and the resume job honours the workflow's
stop rules (`jobs.ts`).

CRM starter templates (from `packages/crm-server/src/workflows.ts` RECIPES and the starter pack): enquiry follow-up time and
escalation (`crm_enquiry_follow_up`), first contact pack, visit and application nurture, quiet hours and message cap.

## The block catalogue (ERP: applied as erp_server)

| Block | Writes | Instance key |
|---|---|---|
| `erp.fee_head` | `erp.fee_heads`; remove = inactive | slug of the name |
| `erp.fee_plan` | `erp.fee_plans` + items for the current year and active branch (heads and programme by name); items with demands are never changed (`fee_plan_has_demands`) | slug of the name |
| `erp.late_fee_rule` | `core.organizations.settings.late_fee` (none, flat, per day, slabs; grace; cap) | `late_fee` |
| `erp.concession_type` | `erp.concession_types` | slug of the name |
| `erp.approval_rule` | `erp.approval_rules`: request type, `min_amount` / `min_percent`, approver chain of ERP roles; **`erp.submit_approval` now uses the first matching active rule** (else its old defaults) | key |
| `erp.automation` | `erp.automations` (recipe key, trigger, conditions such as the fee reminder ladder's `days` / `repeat_every_days`, actions, test mode, on/off) | recipe key |
| `erp.message_template` | `core.message_templates` (product erp, event key) | `slug__channel` |
| `erp.leave_type` | `core.leave_types` (ERP HR) | key |
| `erp.doc_template` | `erp.doc_templates` (certificates and letters); remove = inactive | slug of the name |
| `erp.campus_settings` | `core.organizations.settings`: library fine per day, homework approval, parent-message quiet hours | `campus` |
| `erp.grading_scale` | `erp.grading_scales` | slug of the name |
| `erp.assessment_scheme` | `erp.assessment_schemes` for the current year from a board pack (CBSE, Cambridge, ...), scale by name, pass % | slug of the name |
| `erp.role_permission` | `core.role_permissions` of an ERP role for one capability, by the ERP matrix levels F / B / S / V / - (undo restores the exact rows) | `role__capability` |
| `erp.module_flag` | `erp.module_flags` for a branch or the whole school | `module__BRANCH` or `module__ALL` |

ERP starter templates (from `apps/web/lib/erp/pack.ts` RECIPES and the board packs): fee reminder ladder, concession approval
above a limit, absence alerts to parents, CBSE grading and assessment, late fee per day.

## Custom registers (core.custom_object)

The block's settings are the custom records engine's own definition schema (`recordObjectSchema`, docs/custom-records.md),
so the AI fills exactly what the object builder offers. The server block goes through the engine's designer adapter:
`check` = `customObjectBlock.validate(config, ctx)` (management rights, existing object, roles exist), `write` =
`apply` (create or update; an archived object of that key is brought back), `remove` = `inverse` (deleted, or archived when
entries were added since, so no data is lost), `read` = the definition. The adapter's database calls run in savepoints of
the designer's transaction, so the engine's RLS, validation trigger and audit apply and a dry run keeps nothing. Records
themselves are never read or written by the designer. The mock planner turns "make a hostel visitor log with visitor
name, student, time in/out, approved by warden" into a register with typed fields (student = learner, time in / out =
date-times) and an approval step by the school's warden role (`erp:warden`), or by management when no such role exists
(the plan then asks).

## Add a block

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
   loses information needed to restore exactly, and `check` for the settings screen's own rules against the school. Use
   `await x.tx('<product>')` (that product's login with the actor's claims; `x.c` is the designer's own transaction) and
   fixed, parameterised SQL against your product's own tables; never `asOwner`, never `service_role`. Make a refused write
   an error (check the row count), never a silent no-op.
   Register it in `packages/server/src/designer/blocks/index.ts` (`registerServerBlocks`).
3. **Strings**: `designer.block.<key>.title` and every `designer.preview.*` key `describe` uses, in
   `packages/shared/src/i18n/source/08-designer.txt` (en | hi | te), then `pnpm i18n:build && pnpm lint`.
4. **Tests**: the shared test checks every example parses and every preview key exists; add a server test that plans
   (or builds a template), publishes, checks the product table and reverts to the exact previous state.
5. **Mock** (optional): teach `packages/shared/src/designer/mock.ts` your standard requests so the feature stays demoable
   without Gemini (it gets the school's products and role keys per product in its context).

## Add a template

Append `defineTemplate({ key, product, title, description, keywords, params, paramsSchema, build })` to
`packages/shared/src/designer/templates.ts` (or `registerTemplates([...])` from your product's file). `paramsSchema` gives
every parameter a default; `build(params)` returns a changeset and must be pure. Add `designer.template.<key>.title`,
`.description` and `designer.param.<param>` strings. Real school workflows (decision 59: Sloka) go in the same way.

## Running it

* Development and tests use the mock provider (no `GEMINI_API_KEY`): `pnpm dev`, sign in as `chairman@demo.school` (OS),
  `admin@demo.test` (CRM demo school, CRM only) or `admin@erp.demo.school` (ERP demo school), open `/designer` (link on
  the product landing page for management of any product, and in the OS menu). The CRM and ERP demo schools come from
  `scripts/seed-erp-demo.mjs` (with `ERP_DEMO_DOMAIN=erp.demo.school`) and `apps/web/e2e/crm-seed.mts` (docs/staging.md). A production build refuses the
  mock by design (ADR ai-gemini), so the browser test runs against `next dev`:
  `BASE_URL=http://localhost:3921 CHROMIUM_PATH=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome NODE_PATH=/opt/node-tools/node_modules DATABASE_URL=... node apps/web/e2e/designer.mjs`
  (DATABASE_URL lets it check the CRM / ERP tables directly; the database needs the three demo schools).
* AutoEd staff: sign in as `admin@autoed.dev`, open `/designer`, choose the school, give a reason; the session is
  read-write, shown to the school, and ends from the banner or by time.

## Known gaps

* The ERP fee reminder ladder, absence notice and other event recipes are stored as configuration (`erp.automations`); the
  ERP runtime still runs only its time-based recipes when an administrator presses "Run now" (docs/erp-ui.md: the fee
  reminder ladder is not ported yet), so a published ladder takes effect once that runtime exists.
* CRM stage "mapping" is the stage's phase (how it maps onto the funnel and reports); mapping of stage names from other
  CRMs on import (`mapStage`) is code, not configuration.
* A plan that touches several products is committed product by product at the end (all after every write succeeded); a
  failure in the last commit would leave the earlier ones applied (not seen in tests; there is no two-phase commit).
* CRM / ERP-only schools: a failed AI call is not logged in `core.ai_generations` (that log is written outside the request
  transaction as the OS system actor); successful plans are logged and charged.
* `core.notification_rules` writes for management go through the OS system actor (see the safety model); the right fix
  is a `notifications` permission in the OS matrix (or mapping `setup.configure` to it in `os.sync_access`).
* Branch-level blocks (checklists, recurring tasks, attendance rules, report schedules) apply to the active branch only.
* The roster filter catches names as written in the roster; nicknames or misspellings are not caught. Prompts are kept
  (as personal data, erasable) so they can be reviewed.
* The shared `PHONE` pattern in `packages/shared/src/rules/privacy.ts` now catches `+91` / `91` / `0091` / `0`-prefixed mobile
  numbers with or without separators (fixed for every AI feature, tests in `more-rules.test.ts`); the designer filter keeps
  its extra digit-run rule.
* Voice input (Hindi / Telugu) is later (decision 59). Hindi and Telugu strings need a native review.
