# ERP port: database part (schema `erp`)

Phase "ERP port" of `docs/PLAN-unified-platform.md` section 7, database only. The code that wraps it (UI, server routes, `supabase-js`
calls) is the next stream. Decisions and their reasons: `docs/adr/erp-schema.md`. Source of the mapping: `docs/MAP-TABLES.md` A.3.

## What is in the repo

| File | What |
|---|---|
| `schema/erp-tables.mjs` | the ERP's compact table DSL, reduced to the 126 tables of `erp` (option list in its header) |
| `schema/erp-roles.mjs` | ERP capabilities -> permission modules, the 17 default roles + `portal` and the F/B/S/O/V/R matrix |
| `schema/erp-sql/*.sql` | hand-written SQL: helpers and guard triggers (`00`), notifications and the OTP table (`10`), guards (`20`), fees and receipts (`30`), approvals, restricted data, setup (`40`), gate/PTM/tests/POS/driver (`50`), grants (`90`) |
| `scripts/gen-erp.mjs` | generator; `node scripts/gen-erp.mjs` rewrites the migrations (no diff on a rerun), `--summary` prints the table list |
| `supabase/migrations/20261118000001..9_erp_*.sql` | generated: foundation, six table files, functions, roles + grants |
| `packages/shared/src/erp/*` | fee, grading, payroll, timetable, risk, calendar rules, board packs (data) and the AI hook interface; import `@autoed/shared/erp` |
| `packages/shared/test/erp-*.test.ts` | the ERP's golden tests ported to vitest (+ platform data-shape tests) |
| `packages/server/test-platform/fixture-erp.ts`, `erp.test.ts`, `postgrest.test.ts` | harness: rows in every erp table for orgs A and B, ERP tests, Data API test |

Build and test (platform-only schema; own database):

```bash
export DATABASE_URL=postgres://postgres@localhost:54322/erpport
node scripts/gen-erp.mjs && git diff --exit-code supabase/migrations   # generated SQL is current
pnpm db:reset:platform && pnpm test:platform                            # 114 tests, 9 skipped (PostgREST, opt in)
pnpm --filter @autoed/shared test                                       # 135 tests (24 are the ERP golden tests)
POSTGREST_BIN=/path/to/postgrest pnpm --filter @autoed/server test:platform   # adds the 8 Data API tests
```

## Table decisions (186 ERP tables + 20 `001_core`/`004` tables = 206 sources)

`schema/tables.mjs` (186): **124 -> `erp`**, 47 -> `core` (merged into tables that already exist, nothing recreated), 11 -> `os`
(duplicates dropped: `substitutions`, `curriculum_units`, `lesson_plans`, `syllabus_coverage`, `classroom_observations`,
`invigilation`, `question_papers`, `appraisals`, `trainings`, `training_attendance`, `staff_tasks`), 1 -> `crm` (`enquiries`), 2 ->
`audit` (`breach_log`, `export_log`: platform/compliance stream), 1 -> `private` (`gate_pass_secrets` -> `private.gate_pass_otps`, built here).
New in `erp`: `module_flags`, `staff_hr_profiles`. The 20 core/platform tables (`organisations`, `profiles`, `invites`, `approvals`, platform
console tables ...) belong to the core, billing and admin streams. `erp.role_permissions` is **not** created: roles are `core.roles` +
`core.role_permissions` (see the ADR).

Renames (MAP): `checklists` -> `adoption_checklists`, `prejoining_tasks` -> `post_admission_tasks`, `staff_sensitive` -> `staff_payroll`,
`wallets`/`wallet_txns` -> `student_wallets`/`student_wallet_txns`, `messages`/`message_recipients` -> `announcements`/`announcement_recipients`.
Column changes applied (R2, R5, R9, R10): `year_id` -> `academic_year_id`; every `*_path`/`photo_url` -> a `*_file_id` to `core.files`;
a real login column next to each free-text actor name (`collected_by_user_id`, `sold_by_user_id`, `issued_by_user_id`, `sent_by_user_id`,
`recorded_by_user_id`, `verified_by_user_id`, `by_user_id`); `facility_id` -> `room_id` (`core.rooms`); `post_id` -> `core.class_posts`;
enum values lowercase snake_case (`google_meet`, `half_yearly`, `bus`, `boys` ...; `assessment_schemes.pack` is free text, OQ-15);
money columns `numeric(14,2)`; every login uuid (`requested_by`, `booked_by`, `user_id`, `sender`, `parent_user`) is a composite
foreign key to `core.org_users`. `erp.student_sensitive` keeps only the ERP-only fields (medical notes, doctor, emergency contact,
vaccination, Aadhaar last 4, CWSN); blood group, allergies, medication, category and religion are in `core.student_sensitive`.

## What the ERP can no longer do directly (and what replaces it)

| Source behaviour | Now |
|---|---|
| `app.can(cap, need)` | `app.can('erp', module, action, org, branch)` over `core.role_permissions`; `erp.seed_roles(org)` / `erp.setup_org(org)` |
| `public.collect_fee`, `app.reverse_receipt`, `public.bounce_cheque`, `app.apply_concession` | `erp.collect_fee`, internal `erp.reverse_receipt` (only via an approved `receipt_reversal`), `erp.bounce_cheque`, internal `erp.apply_concession` |
| ERP approvals engine (`approvals`, `decide_approval`, `apply_approval`) | `core.approval_requests` decides; `erp.apply_approval(request)` applies concession, refund, reversal, expense, purchase, gate pass (+OTP), marks unlock, gallery, announcement |
| `change_student_status` side effects | `core.change_student_status` then `erp.apply_student_exit` (fees, transport, hostel, enrolment, alumni) |
| `gate_pass_secrets` | `private.gate_pass_otps`; `erp.my_gate_pass_otp`, `erp.verify_gate_pass` (5 tries / 15 min) |
| `log_view` | `erp.log_view`, `erp.open_report_card`, `erp.read_student_sensitive`, `erp.read_staff_payroll` |
| `pos_sale`, `driver_*`, `book_ptm_slot`, `get_test_questions`, `submit_test` | same names in `erp.*` (questions are `core.question_bank` rows) |
| `verify_document` (anon) | `erp.verify_document`, server-only (nothing is granted to anon) |
| direct insert of payment orders by the family | `erp.create_payment_order`; `erp.settle_payment_order` / `fail_payment_order` are server-only |
| admission fee from CRM | `erp.post_admission_payment` (OQ-16 interface) |
| `app.notify*` | `core.notifications` rows written by `erp.notify_*` |

## Verification results (this stream, local Postgres 16, own database `erpport`)

* `pnpm test:platform`: T1 (every erp table, 5 ERP users + both orgs + ERP server role), T2 (CRM-only and CRM+OS orgs read nothing, rows planted),
  T3 (no ERP access / revoked), T4 (suspended ERP closes all 126 tables), T7 catalogue (RLS, policy, `org_id`, product check in every policy,
  audit trigger, search_path, no PUBLIC/anon execute) all pass on the erp tables; guardian, parent and student see exactly the expected portal
  tables with own-child rows only; immutability, marks lock, restricted-data functions, fee/online/CRM hand-off and wallet tests pass.
* **PostgREST** v12.2.3 (release binary downloaded through the proxy) was started against the harness database and called with signed JWTs:
  anonymous and forged tokens get nothing, a parent reads only the own child's fees/receipts/report cards/trips and cannot write money
  or another family's rows, an org B admin reads only org B and cannot patch/delete/insert/call-with org A ids, an org A admin collects a
  fee only through the function. 8 tests, all pass. They are opt in (`POSTGREST_BIN`), so the default `test:platform` shows them as skipped.
* Not covered by the harness (as in `docs/platform-foundation.md`): T8 against the real Storage API, T12 (Supabase advisor), Supabase Auth.
  Nothing in the cloud was touched.

## Not ported (left for the next streams)

* All UI: the ~100 screens, `src/components`, `src/app`, the Next.js layout and the CSS.
* All `@supabase/supabase-js` / `@supabase/ssr` code, `src/lib/{ctx,crud,actions,automations,insights,reports,reportcards,parent,student,demo,fmt,nav,module-links}.ts`,
  `entities.gen.ts` (UI metadata; the DSL still carries titles, labels, `list`/`hide`/`hidden` for regenerating it), the Next route handlers
  (`/api/payroll/[run]/[kind]` bank/PF files, `/api/tally`, `/api/search`, CSV exports), `middleware`.
* `src/lib/ai.ts` (Anthropic). The hook interface exists; the server implementation is the platform Gemini adapter.
* `pack.ts` installers, `RECIPES` (automation recipes) and `DOC_TEMPLATES` (certificate bodies): only the grade scales and scheme defaults were ported as data.
* Time-based automations (reminder ladder, attendance nudges, document expiry): the rules exist (`packages/shared/src/erp/fees.ts` `reminderStep` ...), the scheduler is `private.jobs`.
* Platform console tables and actions (`platform_*`, `platform_tenants()` ...), `create_organisation`, `claim_invite`, sign-up (identity is core's).
* Storage buckets and upload (files are `core.files` rows; `erp-files` bucket policy exists in the foundation).
* Data migration of the Tokyo `autoederp` database (decision 53: demo data, nothing is moved).
* Enforcement of `erp.module_flags` in policies (needs a platform hook, see the ADR).

## ERP screens and their data needs (for the UI stream)

Staff screens call tables through the Data API (RLS) and the functions named; "family" = parent/student portal. Permission module in brackets.

| Screen (source route) | Reads | Writes (table or function) |
|---|---|---|
| Home, notifications, inbox (`/`, `/inbox`) | `core.notifications`, role dashboards from reports | mark read (`core.notifications`) |
| Approvals (`/approvals`) | `core.approval_requests`, `core.approval_actions` | decide in core, then `erp.apply_approval(id)` |
| Students list/profile/new/bulk (`/students*`) | `core.students`, `core.households`, `core.guardians`, `core.enrolments`, `erp.student_groups`, `erp.stored_documents`, `erp.pickup_persons` | core writes; `erp.read_student_sensitive` / `save_student_sensitive` (logged); `core.change_student_status` + `erp.apply_student_exit` |
| Attendance, roll, staff attendance (`/attendance*`) | `core.student_attendance_*`, `core.staff_attendance` | core tables (OS owns the teacher screen, OQ-7) |
| Admissions (`/admissions`) | `erp.post_admission_tasks` (pipeline is CRM) | `erp.post_admission_tasks`; hand-off `erp.post_admission_payment` |
| Wellbeing and health (`/wellbeing`) | `erp.growth_records`, `discipline_rules`, `safeguarding_incidents`, `counselling_referrals`, `infirmary_visits`, `health_checks`, `house_points` | same tables (module `wellbeing`, `safeguarding`, `health`) |
| Timetable, substitutions (`/timetable*`) | `core.timetable_*`, `core.bell_schedules`, `core.periods` | core / OS (ERP is read-only for the portal) |
| Homework and diary (`/homework`, `/diary`) | `core.class_posts`, `erp.post_submissions` | `core.class_posts`; family: `erp.post_submissions` (`famIns`) |
| Assessment, report cards (`/assessments*`, `/report-cards*`) | `erp.grading_scales`, `assessment_schemes`, `assessments`, `assessment_results`, `rubric_results`, `remark_bank`, `report_cards`, `external_exam_results` | same tables; unlock = approval `marks_unlock`; family opens `erp.open_report_card(id)` |
| Exam cell and online tests (`/exams`, `/student/tests*`) | `core.exams`, `core.exam_schedules`, `core.exam_seating`, `core.question_bank`, `erp.online_tests`, `erp.test_attempts` | `erp.online_tests`; student: `erp.get_test_questions`, `erp.submit_test` |
| Fee counter, dues, receipts, cheques, reconciliation, structure (`/fees*`, `/receipt/[id]`) | `erp.fee_heads`, `fee_plans`, `fee_plan_items`, `fee_demands`, `receipts`, `receipt_payments`, `receipt_allocations`, `bank_lines`, `fee_followups`, `refunds`, `deposits`, `rte_claims` | `erp.collect_fee`, `erp.bounce_cheque`, `fee_demands` (generation), `concessions` (request), `refunds`, `fee_followups`, `bank_lines`; reversal = approval `receipt_reversal` |
| Concessions (`/fees/*`) | `erp.concession_types`, `erp.concessions` | `erp.concessions` (R-level requesters insert `pending`), approval `concession` |
| Accounting (`/accounting`, `/api/tally`) | `erp.accounts`, `vouchers`, `voucher_lines`, `expenses`, `budgets`, `vendors`, `contracts` | `vouchers` + `voucher_lines` (balanced), `expenses`, `budgets`, `vendors`, `contracts` |
| Staff and HR, leave, my leave/payslips (`/hr*`, `/me`) | `core.staff`, `erp.staff_hr_profiles`, `staff_exits`, `onboarding_checklists`, `staff_feedback`, `job_openings`, `job_applications`, `core.leave_*` | those tables; `erp.read_staff_payroll` / `save_staff_payroll` (logged) |
| Payroll, payslips (`/hr/payroll`, `/payslip/[id]`, `/api/payroll`) | `erp.salary_structures`, `payroll_runs`, `payslips`, `staff_loans`, `payroll_adjustments`, `tax_declarations`; LOP from `core.staff_attendance`/`core.leave_requests` | same tables; compute with `computePayslip` (`@autoed/shared/erp`); file downloads call `erp.log_view('payroll_runs', run)` |
| Transport, live map (`/transport*`) | `erp.vehicles`, `routes`, `stops`, `student_transport`, `trips`, `trip_events`, `trip_positions`, `vehicle_logs` | same tables (module `transport`); family reads own route/trip |
| Driver app (`/driver`) | functions only | `erp.driver_routes`, `driver_trip_start`, `driver_trip_students`, `driver_mark`, `driver_position`, `driver_trip_end` |
| Gate and visitors (`/gate`) | `erp.visitors`, `gate_passes`, `pickup_persons`, `emergency_broadcasts`, `core.incidents` | `erp.verify_gate_pass`, `visitors`; family: insert own `gate_passes` (`requested`), `erp.my_gate_pass_otp` |
| Library (`/library`) | `erp.books`, `book_copies`, `loans`, `book_reservations`, `reading_logs` | same tables; family inserts reservations/reading logs |
| Store and canteen (`/store`) | `erp.items`, `stock_movements`, `sales`, `store_orders`, `size_history`, `student_wallets`, `student_wallet_txns`, `meal_bookings`, `purchase_requests`, `purchase_orders`, `assets` | `erp.pos_sale`, `erp.wallet_topup`, others direct |
| Hostel (`/m/hostel`), facilities (`/m/facilities`) | `erp.hostel_*`, `mess_menus`, `core.rooms`, `erp.facility_bookings`, `maintenance_schedules`, `utility_readings` | same tables |
| Messages, announcements, conversations (`/messages`, `/parent/messages`) | `erp.announcements`, `announcement_recipients`, `conversations`, `conversation_messages`, `core.outbox`, `core.message_templates` | `announcements` (approval `announcement`), family: own conversations/messages, mark recipient read |
| Helpdesk (`/helpdesk*`) | `core.tickets`, `core.ticket_events` | core (family raises tickets through core policies) |
| Calendar, events, PTM, gallery (`/m/events`, `/ptm`) | `core.calendar_events`, `core.events`, `erp.event_registrations`, `ptm_slots`, `gallery_albums`, `gallery_photos`, `appointments` | same tables; family `erp.book_ptm_slot`, own `event_registrations` |
| Forms and surveys (`/forms*`) | `erp.forms`, `form_responses` | `forms`; family inserts own `form_responses` |
| Certificates (`/documents*`, `/verify/[code]`) | `erp.doc_templates`, `issued_documents` | `issued_documents`; public check through the ERP server -> `erp.verify_document(code)` |
| Reports, saved reports (`/reports*`) | views over all of the above | `erp.saved_reports` |
| Admin: setup, roles, users, subscription, import, audit, automations, adoption, health (`/admin/*`) | `core.*` setup tables, `core.roles`/`role_permissions`, `erp.module_flags`, `masters`, `import_jobs`, `automations`, `automation_runs`, `adoption_checklists`, `briefings`, `data_health_reports`, `audit.log` | those tables; `erp.setup_org(org)` for a new school |
| Group console, quality, disclosures (`/group`) | `erp.franchise_royalties`, `quality_audits`, `disclosures`, `principal_diary` | same tables |
| Parent app (`/parent*`) | own child: `erp.fee_demands`, `receipts`, `report_cards`, `assessment_results`, `student_transport`, `trips`, `gate_passes`, `store_orders`, `loans`, `issued_documents`, `core.student_attendance_marks`, `core.class_posts`, `core.calendar_events` | `erp.create_payment_order` (pay), leave `core.student_leave_requests`, gate pass, orders, conversations, forms |
| Student portal (`/student*`) | same set for the student's own row | tests: `erp.get_test_questions`, `erp.submit_test`; submissions |

Rule libraries for these screens: `import { computePayslip, lateFine, allocateOldestFirst, subjectResult, generate, findClashes, riskReasons, isWorking, SCALES } from '@autoed/shared/erp'`.

## Table list (generated: `node scripts/gen-erp.mjs --summary`)

| Table | Group | Module | Access |
|---|---|---|---|
| erp.module_flags | admin | setup | staff by module |
| erp.masters | admin | setup | read: staff |
| erp.import_jobs | admin | setup | staff by module |
| erp.automations | workflow | setup | staff by module |
| erp.automation_runs | workflow | setup | staff by module |
| erp.saved_reports | reports | reports | own rows (created_by) |
| erp.adoption_checklists | adoption | setup | read: staff |
| erp.briefings | adoption | setup | read: predicate |
| erp.doc_templates | documents | documents | staff by module |
| erp.policies | hr | setup | read: predicate |
| erp.policy_acks | hr | setup | own rows (user_id) |
| erp.student_sensitive | sis | student_sensitive | RPC only (erp.read_student_sensitive); family (own learners) |
| erp.student_groups | sis | students | read: members |
| erp.student_group_members | sis | students | family (own learners) |
| erp.stored_documents | documents | documents | family (own learners); own staff row |
| erp.alumni_profiles | alumni | students | family (own learners) |
| erp.pickup_persons | safety | students | family (own learners) |
| erp.post_admission_tasks | admissions | admissions | family (own learners) |
| erp.facility_bookings | facilities | facilities | read: staff; own rows (booked_by) |
| erp.content_items | learning | learning | read: members |
| erp.online_classes | learning | learning | read: predicate |
| erp.post_submissions | homework | homework | family (own learners) |
| erp.grading_scales | assessment | marks | read: staff |
| erp.assessment_schemes | assessment | marks | read: staff |
| erp.assessments | assessment | marks | staff by module |
| erp.assessment_results | assessment | marks | family (own learners) |
| erp.rubric_results | assessment | marks | staff by module |
| erp.remark_bank | assessment | marks | read: staff |
| erp.report_cards | assessment | marks | family (own learners) |
| erp.external_exam_results | assessment | marks | family (own learners) |
| erp.online_tests | exams | exams | read: predicate |
| erp.test_attempts | exams | exams | family (own learners) |
| erp.growth_records | wellbeing | wellbeing | family (own learners) |
| erp.discipline_rules | wellbeing | wellbeing | read: members |
| erp.safeguarding_incidents | wellbeing | safeguarding | staff by module |
| erp.counselling_referrals | wellbeing | safeguarding | staff by module |
| erp.infirmary_visits | health | health | family (own learners) |
| erp.health_checks | health | health | family (own learners) |
| erp.house_points | activities | activities | family (own learners) |
| erp.event_registrations | events | events | family (own learners) |
| erp.council_positions | activities | activities | read: members |
| erp.accounts | accounting | accounting | staff by module |
| erp.vendors | inventory | inventory | staff by module |
| erp.fee_heads | fees | fees | read: members |
| erp.fee_plans | fees | fees | staff by module |
| erp.fee_plan_items | fees | fees | staff by module |
| erp.fee_demands | fees | fees | family (own learners) |
| erp.concession_types | fees | concessions | staff by module |
| erp.concessions | fees | concessions | family (own learners); own rows (requested_by) |
| erp.bank_lines | fees | fees | staff by module |
| erp.receipts | fees | fees | family (own learners); immutable; written by functions |
| erp.receipt_payments | fees | fees | family (via parent row); immutable; written by functions |
| erp.receipt_allocations | fees | fees | family (own learners); immutable; written by functions |
| erp.refunds | fees | fees | family (own learners) |
| erp.fee_followups | fees | fees | staff by module |
| erp.payment_orders | fees | fees | family (own learners); written by functions |
| erp.deposits | accounting | accounting | family (own learners) |
| erp.rte_claims | statutory | fees | staff by module |
| erp.vouchers | accounting | accounting | immutable |
| erp.voucher_lines | accounting | accounting | immutable |
| erp.expenses | accounting | accounting | own rows (requested_by) |
| erp.budgets | accounting | accounting | staff by module |
| erp.contracts | inventory | inventory | staff by module |
| erp.staff_payroll | hr | payroll | RPC only (erp.read_staff_payroll); own staff row |
| erp.staff_hr_profiles | hr | staff | own staff row |
| erp.salary_structures | hr | payroll | own staff row |
| erp.payroll_runs | hr | payroll | staff by module |
| erp.payslips | hr | payroll | own staff row |
| erp.staff_loans | hr | payroll | own staff row |
| erp.payroll_adjustments | hr | payroll | own staff row |
| erp.tax_declarations | hr | payroll | own staff row |
| erp.job_openings | hr | staff | staff by module |
| erp.job_applications | hr | staff | staff by module |
| erp.staff_exits | hr | staff | own staff row |
| erp.onboarding_checklists | hr | staff | own staff row |
| erp.staff_feedback | hr | staff | staff by module |
| erp.vehicles | transport | transport | staff by module |
| erp.routes | transport | transport | read: predicate |
| erp.stops | transport | transport | read: predicate |
| erp.student_transport | transport | transport | family (own learners) |
| erp.trips | transport | transport | read: predicate |
| erp.trip_events | transport | transport | family (own learners) |
| erp.trip_positions | transport | transport | read: predicate |
| erp.vehicle_logs | transport | transport | staff by module |
| erp.visitors | safety | gate | staff by module |
| erp.gate_passes | safety | gate | family (own learners); own rows (requested_by) |
| erp.emergency_broadcasts | safety | communication | read: members |
| erp.broadcast_acks | safety | communication | own rows (user_id) |
| erp.hostel_blocks | hostel | hostel | staff by module |
| erp.hostel_rooms | hostel | hostel | staff by module |
| erp.hostel_allocations | hostel | hostel | family (own learners) |
| erp.mess_menus | hostel | hostel | read: members |
| erp.items | inventory | inventory | read: members |
| erp.stock_movements | inventory | inventory | staff by module |
| erp.sales | inventory | inventory | family (own learners); written by functions |
| erp.store_orders | inventory | inventory | family (own learners); own rows (created_by) |
| erp.size_history | inventory | inventory | family (own learners) |
| erp.purchase_requests | inventory | inventory | own rows (requested_by) |
| erp.purchase_orders | inventory | inventory | staff by module |
| erp.assets | inventory | inventory | staff by module |
| erp.student_wallets | canteen | canteen | family (own learners) |
| erp.student_wallet_txns | canteen | canteen | family (own learners); written by functions |
| erp.meal_bookings | canteen | canteen | family (own learners); own rows (created_by) |
| erp.books | library | library | read: members |
| erp.book_copies | library | library | staff by module |
| erp.loans | library | library | family (own learners); own staff row |
| erp.book_reservations | library | library | family (own learners); own rows (created_by) |
| erp.reading_logs | library | library | family (own learners) |
| erp.issued_documents | documents | documents | family (own learners); own staff row |
| erp.announcements | communication | communication | staff by module |
| erp.announcement_recipients | communication | communication | own rows (user_id) |
| erp.conversations | communication | communication | family (own learners); own rows (parent_user) |
| erp.conversation_messages | communication | communication | family (via parent row) |
| erp.ptm_slots | events | events | read: predicate |
| erp.gallery_albums | events | events | read: predicate |
| erp.gallery_photos | events | events | read: predicate |
| erp.appointments | events | events | family (own learners); own rows (requested_by) |
| erp.maintenance_schedules | facilities | facilities | staff by module |
| erp.utility_readings | facilities | facilities | staff by module |
| erp.forms | forms | forms | read: predicate |
| erp.form_responses | forms | forms | own rows (user_id) |
| erp.principal_diary | reports | reports | staff by module |
| erp.data_health_reports | admin | setup | staff by module |
| erp.franchise_royalties | group | accounting | staff by module |
| erp.quality_audits | group | setup | staff by module |
| erp.disclosures | statutory | setup | read: members |

126 tables

## Known issues and follow-ups

* Plan rule 8 does not hold for the ERP (decision 51); the evidence that RLS alone is enough is the harness + PostgREST tests above. Re-run them after every table change.
* `deleted_at` is not filtered by policies: queries must add `deleted_at is null`.
* `erp.apply_approval` and `erp.apply_student_exit` must be called by the ERP after the core decision / status change (no database hook, by design R7).
* `erp.module_flags` is not enforced by `app.can`; the UI must hide modules a school switched off, and the platform needs a hook.
* `core.usage_events`, `core.webhook_deliveries`, `audit.breach_log`, `audit.export_log` (MAP A.3b rows 10, 15, 16, 17, 24) do not exist yet: another stream owns them.
* Column-level ownership of `core` rows (students, guardians, staff) written by ERP screens is a server responsibility (MAP risk D1).
* The harness exempts `erp.trips` and `erp.trip_positions` from the audit trigger (GPS telemetry) and lists `erp.staff_payroll` / `erp.student_sensitive` as closed tables (`RPC_ONLY_TABLES` in `helpers.ts`).
