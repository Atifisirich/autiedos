# Core master data — shared tables in `core`

Phase 2 of the unified platform, after the foundation (`docs/platform-foundation.md`). Source of the design:
`docs/MAP-TABLES.md` section B (rules R1–R12, section C order) and owner decisions 27–54 in `docs/DECISIONS.md`
(open questions OQ-1..16 use the printed recommendation, decision 54). Design choices: `docs/adr/core-master-001-audiences-and-writers.md`.

## Files

| File | What |
|---|---|
| `supabase/migrations/20261115100001_core_master_helpers.sql` | B.1/B.2 columns on `core.organizations` / `core.branches`; portal helpers `app.my_core_staff_id()`, `app.my_household_ids()`, `app.my_learner_section_ids()`; RLS wrapper `app.apply_core_rls`; `app.default_term()` |
| `…100002_core_master_structure.sql` | terminology, files, custom fields, academic years, terms, number series, wings, rooms, departments, positions, programmes, subjects, programme_subjects; `organizations.logo_file_id` |
| `…100003_core_master_people.sql` | staff, sections, households, guardians, students, student_sensitive, enrolments, student_status_events; FK `learner_links.learner_id → core.students` |
| `…100004_core_master_approvals.sql` | approval_types / flows / steps / requests / actions, delegations |
| `…100005_core_master_calendar_timetable.sql` | calendar_events, events, bell_schedules, periods, teacher_allocations, timetable_versions / entries, exam_types, exams, exam_schedules, exam_seating, question_bank, class_posts |
| `…100006_core_master_attendance_leave.sql` | attendance_rules, devices, attendance_imports, staff_attendance, leave_types / requests / balances, student_leave_requests, student_attendance_sessions / marks |
| `…100007_core_master_comms_helpdesk_compliance.sql` | message_templates, notification_rules, notifications, notification_prefs, outbox, device_tokens, integrations, api_keys, webhooks, ticket_categories, tickets, ticket_events, support_tickets, incidents, consents, data_requests, retention_rules |
| `…100008_core_master_functions.sql` | `app.term()`, `core.next_number()`, `core.change_student_status()` + status guard trigger, function grants |
| `scripts/gen-core-master.mjs` | generator of files 100002–100007 (the generated SQL is committed; edit the spec, re-run, commit both) |
| `packages/server/test-platform/fixture-core.ts`, `core-master.test.ts` | harness fixtures (one row per table for org A and B) and core tests |

They sort after the foundation (`20261115000001..6`) and before the legacy OS (`20261116*`).
`node scripts/db.mjs reset --platform-only` (and so `pnpm test:platform`) now applies `*_platform_*` **and** `*_core_master_*`.

## Rules every core master table follows

* Standard columns (R3): `id uuid pk`, `org_id uuid not null → core.organizations on delete cascade`, `branch_id`
  where listed (null = whole org; FK `(org_id, branch_id) → core.branches(org_id, id)`), `created_at`,
  `created_by uuid default app.uid()`, `updated_at` (trigger `trg_touch`), `deleted_at` (soft delete; policies do not filter it, queries must).
* `unique (org_id, id)` on every table; **every FK between core tables is composite** `(org_id, x_id) → core.t(org_id, id)`,
  so a row can never point at another client's row (tested for every FK). Login links are `(org_id, user_id) → core.org_users(org_id, user_id)`.
* Every FK column has an index `(org_id, col)`; extra indexes also start with `org_id`.
* No FK from core into `crm/os/erp` (R7): `linked_type + linked_id`, `crm_prospect_id`, `crm_contact_id`, `vendor_ref`, `job_id` are plain uuids.
* RLS through `app.apply_core_rls(table, read, product, module, extra, guard)`, which runs
  `app.apply_rls(..., 'core_master', product, module)` (writes + audit trigger) and replaces the select policy with the audience rule below.
  The harness fails for a core table that was not set up this way, has no fixture rows for org A and B, or lacks RLS/policies/audit.
* Grants: `select, insert, update, delete` to `authenticated, crm_server, os_server, erp_server`; `select` to `platform_admin_server`.

### Read audiences

Every read is also bounded by `org_id = app.current_org_id() and app.user_has_any_product(org_id)` (so a suspended
client loses master data with its last product, and support "view as" works as for the foundation).

| read | who |
|---|---|
| `members` | every member of the org (staff, guardian, parent, student) — reference data the portal needs; branch-visible rows only |
| `staff` | `app.my_member_kind() in ('staff','support')`, branch visible |
| `permission` | staff holding `<module>.view` in any product (`app.can_any_product`) — restricted tables |
| `self` | `user_id = app.uid()` only |
| + portal rows | OR-ed predicate: own learners `app.my_learner_ids()`, own households `app.my_household_ids()`, sections of own learners `app.my_learner_section_ids()`, own staff row `app.my_core_staff_id()`, own requests (`applicant_user_id`/`raised_by_user_id`/`requested_by_user_id = app.uid()`) |

### Writes ("who writes what")

Insert/update/delete need `<module>.create|edit|delete` through **any** product the user holds (`*`) — the default
writer rule (MAP-TABLES B intro, decision 50: owning product when the org has it, else the next product) is applied by
the product servers; the database guarantees org, branch and permission. Where B names **one writer with no fallback**
the policy names that product: `staff_attendance`, `leave_requests`, `leave_balances` → **os**; `enrolments`,
`student_leave_requests` → **erp**. Self-service insert policies (OR-ed): staff apply for own leave
(`leave_requests.ins_self`), guardians apply learner leave (`student_leave_requests.ins_portal`), anyone files own
approval request / ticket / ticket comment / support ticket / data request (`ins_self`); users manage their own
`notification_prefs`, `device_tokens` (`self_all`) and mark their own `notifications` read (`upd_self`).

Module keys used by the policies (give roles these in `core.role_permissions`; `*` covers all):
`setup, files, staff, students, student_sensitive, approvals, calendar, events, timetable, exams, class_posts,
staff_attendance, student_attendance, leave, notifications, integrations, helpdesk, support, incidents, compliance`.

### Restricted data

* `core.student_sensitive` (1:1 with students): blood group, allergies, medical conditions, medications, disability,
  special needs, social category, religion, caste, emergency notes. Staff need `student_sensitive.view`; a guardian sees own learners'.
  **Never add these fields to `core.students`.**
* `core.incidents` (`incidents.view`), `core.consents`/`data_requests`/`retention_rules` (`compliance.view`),
  `core.outbox` (phone numbers; `notifications.view`), `integrations`/`api_keys`/`webhooks` (`integrations.view`; secrets live in `private`).
* `core.consents` rows with `subject_type = 'crm_guardian'` (pre-admission leads) are readable only with the CRM product.

## Functions other streams call

| Function | Use |
|---|---|
| `core.change_student_status(student, to, reason, effective_date)` | the **only** way to change `students.status` (a direct update by a request role is refused by trigger); validates B.7 transitions, writes `core.student_status_events`; needs `students.edit`. `active` needs an `admission_no`. |
| `core.next_number(key, branch?, academic_year?)` | next number of a `core.number_series` row (`prefix || lpad(n, padding) || suffix`), branch/year-specific series first; staff only |
| `app.term(key, locale)` | label for a neutral key: org override in `core.terminology`, else `app.default_term(organizations.kind, key)` |
| `app.my_core_staff_id()` | the signed-in user's `core.staff.id` (OS has a legacy `app.my_staff_id()` over `public.staff`; do not confuse) |
| `app.my_household_ids()`, `app.my_learner_section_ids()` | portal helpers (besides foundation `app.my_learner_ids()`) |

Not built here (owned by other streams, see "Not in this stream"): `core.admit_student()` (CRM, decision 38),
`core.student_primary_phone()`, `core.can_contact()`, `core.upsert_staff()`.

## Naming glossary (decision 28)

The schema uses neutral words; screens show `app.term(key)`. Built-in defaults by `core.organizations.kind`
(override per org/branch/locale with a `core.terminology` row):

| key (table) | school | coaching_centre | college |
|---|---|---|---|
| `programme` (core.programmes) | Class | Course | Programme |
| `section` (core.sections) | Section | Batch | Division |
| `learner` (core.students) | Student | Student | Student |
| `guardian` (core.guardians) | Parent | Parent | Guardian |
| `household` (core.households) | Family | Family | Family |
| `staff` (core.staff) | Staff | Faculty | Faculty |
| `academic_year` | Academic year | Session | Academic year |
| `term` (core.terms) | Term | Term | Semester |
| `subject` (core.subjects) | Subject | Subject | Course |
| `wing` (core.wings) | Wing | Division | Faculty |
| `period` (core.periods) | Period | Slot | Lecture |
| `admission` | Admission | Enrolment | Admission |

Column names follow the same rule: `programme_id` (never `class_id`), `section_id` (never `batch_id`),
`academic_year_id` (never `year_id`, R2), `student_id` for learners, `staff_id` for people on the staff side,
`*_user_id` / `user_id` for auth users, `*_staff_id` where a staff row is meant (`owner_staff_id`, `raised_by_staff_id`, `marked_by_staff_id`).
The foundation's `owner_id` (auth user, "own" scope) is **not** used on core master tables.

### Enumerations (R10)

* student status: `admitted, active, suspended, withdrawn, transferred, alumni, archived` (no `applicant`; leads stay in crm)
* staff status: `invited, active, on_notice, inactive, left`; staff_type: `teaching, non_teaching, admin, support, driver, attendant` (`is_teaching` is generated)
* gender: `female, male, other`; guardian relation: `father, mother, guardian, other`; language: `en, hi, te`
* student attendance mark: `present, absent, late, half_day, on_leave, on_duty`; source `teacher, biometric, rfid, face, bus, hostel, mobile, import`; `session_key` `day | am | pm | p<seq>`
* staff attendance status: `present, late, half_day, absent, on_leave, holiday`; source `app, biometric, rfid, face, merged, manual, regularised, import`
* approval / leave status: `pending, approved, rejected, returned, cancelled`; `half_day`: `none, first, second`
* names (OQ-1): `first_name` (not null) + `last_name`, `full_name` generated, on staff and students; guardians keep one `name`.

## Table list (67 new tables + 2 extended)

Extended, not recreated: `core.organizations` (+ branding, settings, preset_key, setup_step, setup_completed_at,
go_live_date, pan, gst_no, city, state, region, partner, notes, logo_file_id) and `core.branches` (+ address, phone,
email, latitude, longitude, geofence_radius_m, working_days, day_starts_at, day_ends_at, boards, gst_no, pan,
udise_code, is_franchise, royalty_percent, settings). `organizations.status` stays `active|closed` (product state
is `core.subscriptions`); `core.learner_links.learner_id` now has an FK to `core.students`.

| Table | Branch | Read | Writer product | Module | Portal / self rows |
|---|---|---|---|---|---|
| core.terminology | null | members | * | setup |  |
| core.files | null | staff | * | files |  |
| core.custom_fields | null | members | * | setup |  |
| core.academic_years | null | members | * | setup |  |
| core.terms | - | members | * | setup |  |
| core.number_series | null | staff | * | setup |  |
| core.wings | null | members | * | setup |  |
| core.rooms | null | members | * | setup |  |
| core.departments | null | members | * | staff |  |
| core.positions | - | members | * | staff |  |
| core.programmes | null | members | * | setup |  |
| core.subjects | null | members | * | setup |  |
| core.programme_subjects | - | members | * | setup |  |
| core.staff | null | staff | * | staff |  |
| core.sections | - | members | * | setup |  |
| core.households | - | staff | * | students | id = any(app.my_household_ids()) |
| core.guardians | - | staff | * | students | household_id = any(app.my_household_ids()) or user_id = app.uid() |
| core.students | req | staff | * | students | id = any(app.my_learner_ids()) |
| core.student_sensitive | - | permission | * | student_sensitive | student_id = any(app.my_learner_ids()) |
| core.enrolments | - | staff | erp | students | student_id = any(app.my_learner_ids()) |
| core.student_status_events | - | staff | * | students | student_id = any(app.my_learner_ids()) |
| core.approval_types | - | staff | * | approvals |  |
| core.approval_flows | null | staff | * | approvals |  |
| core.approval_steps | - | staff | * | approvals |  |
| core.approval_requests | null | permission | * | approvals | applicant_user_id = app.uid() or app.my_core_staff_id() = any(pending_approver_ids) or student_id = any(app.my_learner_ids()) |
| core.approval_actions | - | permission | * | approvals | exists (select 1 from core.approval_requests r where r.org_id = approval_actions.org_id and r.id = approval_actions.request_id) |
| core.delegations | - | staff | * | approvals |  |
| core.calendar_events | null | staff | * | calendar | audience in ('families','all') |
| core.events | null | members | * | events |  |
| core.bell_schedules | null | members | * | timetable |  |
| core.periods | - | members | * | timetable |  |
| core.teacher_allocations | - | staff | * | timetable |  |
| core.timetable_versions | null | members | * | timetable |  |
| core.timetable_entries | - | members | * | timetable |  |
| core.exam_types | - | members | * | exams |  |
| core.exams | null | members | * | exams |  |
| core.exam_schedules | - | members | * | exams |  |
| core.exam_seating | - | staff | * | exams | student_id = any(app.my_learner_ids()) |
| core.question_bank | - | staff | * | exams |  |
| core.class_posts | - | staff | * | class_posts | status = 'published' and (student_id = any(app.my_learner_ids()) or (student_id is null and section_id = any(app.my_learner_section_ids()))) |
| core.attendance_rules | null | staff | * | staff_attendance |  |
| core.devices | null | staff | * | staff_attendance |  |
| core.attendance_imports | null | staff | * | staff_attendance |  |
| core.staff_attendance | null | permission | os | staff_attendance | staff_id = app.my_core_staff_id() |
| core.leave_types | - | members | * | leave |  |
| core.leave_requests | null | permission | os | leave | staff_id = app.my_core_staff_id() |
| core.student_leave_requests | - | staff | erp | leave | student_id = any(app.my_learner_ids()) |
| core.leave_balances | - | permission | os | leave | staff_id = app.my_core_staff_id() |
| core.student_attendance_sessions | - | staff | * | student_attendance |  |
| core.student_attendance_marks | - | staff | * | student_attendance | student_id = any(app.my_learner_ids()) |
| core.message_templates | null | staff | * | notifications |  |
| core.notification_rules | null | staff | * | notifications |  |
| core.notifications | - | self | * | notifications |  |
| core.notification_prefs | - | self | * | notifications |  |
| core.outbox | null | permission | * | notifications |  |
| core.device_tokens | - | self | * | notifications |  |
| core.integrations | null | permission | * | integrations |  |
| core.api_keys | - | permission | * | integrations |  |
| core.webhooks | - | permission | * | integrations |  |
| core.ticket_categories | - | members | * | helpdesk |  |
| core.tickets | null | permission | * | helpdesk | raised_by_user_id = app.uid() or owner_staff_id = app.my_core_staff_id() |
| core.ticket_events | - | permission | * | helpdesk | not internal and exists (select 1 from core.tickets t where t.org_id = ticket_events.org_id and t.id = ticket_events.ticket_id) |
| core.support_tickets | - | permission | * | support | user_id = app.uid() |
| core.incidents | null | permission | * | incidents |  |
| core.consents | - | permission | * | compliance | student_id = any(app.my_learner_ids()) or guardian_id in (select g.id from core.guardians g where g.org_id = consents.org_id and g.household_id = any(app.my_household_ids())) (and: subject_type <> 'crm_guardian' or app.user_has_product(org_id, 'crm')) |
| core.data_requests | - | permission | * | compliance | requested_by_user_id = app.uid() |
| core.retention_rules | - | permission | * | compliance |  |

### Exact columns (besides id, org_id, created_at, created_by, updated_at, deleted_at)

| Table | Columns |
|---|---|
| core.terminology | branch_id, key, locale, singular, plural |
| core.files | branch_id, bucket, storage_path, file_name, mime, size_bytes, sha256, owner_type, owner_id, product_key, uploaded_by, retention_until |
| core.custom_fields | branch_id, product_key, entity, key, label, label_i18n, field_type, options, required, seq, active |
| core.academic_years | branch_id, name, starts_on, ends_on, is_current, status, seq |
| core.terms | academic_year_id, name, seq, starts_on, ends_on |
| core.number_series | branch_id, key, academic_year_id, prefix, suffix, padding, next_value, reset_policy, product_key, active |
| core.wings | branch_id, name, board, seq, student_attendance_mode, homework_limit_minutes |
| core.rooms | branch_id, name, kind, capacity, bookable, qr_token, active |
| core.departments | branch_id, name, head_staff_id, active |
| core.positions | key, name, rank, is_teaching, active |
| core.programmes | branch_id, wing_id, name, board, stage, stream, level, seq, capacity, next_programme_id, active |
| core.subjects | branch_id, name, code, type, department_id, content_language, is_core, color, active |
| core.programme_subjects | programme_id, subject_id, periods_per_week, double_periods, room_type |
| core.staff | branch_id, user_id, employee_code, first_name, last_name, full_name, email, phone, gender, dob, photo_file_id, position_id, department_id, wing_id, reports_to, language, status, joined_on, left_on, staff_type, is_teaching, is_part_time, max_periods_day, max_periods_week, unavailable, ui_prefs, custom |
| core.sections | programme_id, academic_year_id, name, class_teacher_id, room_id, capacity, strength, profile, seq |
| core.households | family_name, address, city, pincode, locality, phone, email, notes, home_language, custom |
| core.guardians | household_id, name, relation, phone, alt_phone, email, occupation, qualification, authorised_pickup, photo_file_id, is_primary, language, user_id |
| core.students | branch_id, household_id, admission_no, first_name, last_name, full_name, dob, gender, status, programme_id, section_id, roll_no, house, mother_tongue, nationality, apaar_id, pen, rte_quota, is_new, joined_on, left_on, previous_school, photo_file_id, user_id, crm_prospect_id, custom |
| core.student_sensitive | student_id, blood_group, allergies, medical_conditions, medications, disability, special_needs, social_category, religion, caste, emergency_notes |
| core.enrolments | student_id, academic_year_id, programme_id, section_id, roll_no, status, start_date, end_date, result |
| core.student_status_events | student_id, from_status, to_status, reason, effective_date, actor_user_id, actor_name |
| core.approval_types | key, name, name_i18n, product_key, form_schema, task_template, is_system, active |
| core.approval_flows | branch_id, approval_type_id, applicant_role_key, name, min_amount, max_amount, active |
| core.approval_steps | flow_id, seq, approver_kind, approver_role_key, approver_staff_id, condition, parallel_group, time_limit_hours |
| core.approval_requests | branch_id, approval_type_id, flow_id, product_key, applicant_user_id, applicant_staff_id, requested_by_name, title, summary, impact, data, amount, student_id, status, current_seq, pending_approver_ids, step_due_at, linked_type, linked_id, decided_at |
| core.approval_actions | request_id, step_seq, actor_user_id, actor_staff_id, actor_name, action, comment, forwarded_to |
| core.delegations | staff_id, delegate_id, starts_on, ends_on, reason |
| core.calendar_events | branch_id, layer, title, description, starts_on, ends_on, starts_at, ends_at, is_working_day, audience, programme_ids, linked_type, linked_id |
| core.events | branch_id, name, type, event_date, venue, description, owner_staff_id, status, registration_open, fee, consent_required, max_participants |
| core.bell_schedules | branch_id, wing_id, name, days, active |
| core.periods | bell_schedule_id, seq, label, kind, starts_at, ends_at, teaching_index |
| core.teacher_allocations | academic_year_id, staff_id, section_id, subject_id, periods_per_week, double_periods, co_teacher_id, group_key, combined_key, room_type |
| core.timetable_versions | branch_id, academic_year_id, name, status, effective_from, effective_to, generated_at, unplaced, score, job_id, based_on_version_id |
| core.timetable_entries | version_id, day, period_seq, section_id, subject_id, staff_id, room_id, locked, group_key, fixed_label |
| core.exam_types | key, name, weight, seq |
| core.exams | branch_id, academic_year_id, term_id, exam_type_id, name, status, starts_on, ends_on, programme_ids |
| core.exam_schedules | exam_id, programme_id, section_id, subject_id, exam_date, starts_at, ends_at, max_marks, pass_marks, room_id |
| core.exam_seating | exam_schedule_id, student_id, room_id, seat_no, hall_ticket_no |
| core.question_bank | subject_id, programme_id, content, difficulty, bloom, marks, source, status |
| core.class_posts | type, section_id, linked_type, linked_id, student_id, subject_id, staff_id, title, body, attachment_file_id, due_date, est_minutes, status, allow_submission, max_marks, published_at |
| core.attendance_rules | branch_id, applies_to, position_id, grace_minutes, half_day_after_minutes, student_cutoff, edit_window_hours, settings |
| core.devices | branch_id, kind, name, serial_no, location_text, room_id, active, last_seen_at |
| core.attendance_imports | branch_id, kind, source, file_id, status, row_count, error_count, summary |
| core.staff_attendance | branch_id, staff_id, date, check_in_at, check_out_at, check_in_lat, check_in_lng, check_in_distance_m, selfie_file_id, source, status, late_minutes, early_exit, conflict, import_id, device_id, regularisation_request_id, note |
| core.leave_types | key, name, name_i18n, applies_to, unit, accrual, carry_forward_max, half_day_allowed, notice_days, doc_required_after_days, sandwich_rule, yearly_quota, carry_forward, paid, active, encashable |
| core.leave_requests | branch_id, staff_id, leave_type_id, start_date, end_date, half_day, hours, days, reason, attachment_file_id, handover_note, status, approval_request_id, parent_request_id, decided_at |
| core.student_leave_requests | student_id, leave_type_id, start_date, end_date, half_day, days, reason, attachment_file_id, status, requested_by_user_id, decided_by, decided_at, approval_request_id |
| core.leave_balances | staff_id, leave_type_id, academic_year_id, opening, carried_forward, adjusted |
| core.student_attendance_sessions | section_id, date, session_key, marked_by_staff_id, marked_by_name, status, submitted_at, edit_reason, edit_approval_request_id, client_id |
| core.student_attendance_marks | session_id, student_id, date, session_key, status, source, note, check_in_at, check_out_at, student_leave_request_id |
| core.message_templates | branch_id, product_key, event_key, name, channel, language, category, body, enabled, status, dlt_template_id, provider_template_name, provider_status, provider_vars, provider_reason |
| core.notification_rules | branch_id, product_key, event_key, audience, role_keys, channels, template_id, active, settings |
| core.notifications | user_id, staff_id, product_key, event_key, title, body, link, data, priority, channels, deliver_after, push_status, whatsapp_status, read_at, dedupe_key |
| core.notification_prefs | user_id, event_key, channel, muted |
| core.outbox | branch_id, product_key, channel, to_address, event_key, template_id, body, status, provider, provider_ref, units, cost, student_id, guardian_id, notification_id, dedupe_key, send_after, sent_at, delivered_at, error |
| core.device_tokens | user_id, staff_id, token, platform, device_name, last_seen_at, revoked_at |
| core.integrations | branch_id, product_key, type, name, provider, provider_owner, enabled, config, status |
| core.api_keys | product_key, name, prefix, key_hash, scopes, last_used_at, expires_at, revoked_at |
| core.webhooks | product_key, url, events, active, secret_ref, last_status, last_delivery_at |
| core.ticket_categories | key, name, name_i18n, product_key, owner_role_key, sla_hours, active |
| core.tickets | branch_id, category_id, product_key, title, description, priority, status, raised_by_user_id, raised_by_staff_id, raised_by_name, student_id, owner_staff_id, owner_role_key, room_id, location_text, asset_tag, parts, vendor, vendor_ref, cost, due_at, resolved_at, closed_at, resolution, rating, rating_comment, source, photo_file_id, voice_file_id, payload, linked_type, linked_id, approval_request_id |
| core.ticket_events | ticket_id, actor_user_id, actor_staff_id, actor_name, event, from_status, to_status, note, internal |
| core.support_tickets | product_key, user_id, staff_id, kind, subject, body, priority, status, reply, linked_id |
| core.incidents | branch_id, type, student_ids, staff_ids, room_id, location_text, occurred_at, description, action_taken, follow_up, severity, confidential, owner_staff_id, reported_by_user_id, reported_by_staff_id, status |
| core.consents | subject_type, guardian_id, student_id, staff_id, crm_contact_id, purpose, granted, wording_version, source, granted_at, withdrawn_at, user_id, product_key |
| core.data_requests | type, subject_type, subject_id, subject, details, status, due_date, evidence, requested_by_user_id, product_key |
| core.retention_rules | data_type, keep_years, action, notes, product_key |

## Not in this stream (deliberately)

| Item | Where it goes | Why |
|---|---|---|
| `os.substitutions` | OS stream | B.11 maps substitutions to `os` (ERP's are dropped as duplicate) |
| ERP `attendance_regularisations` | approval type `attendance_regularisation` (per org, in `core.approval_types`) + `staff_attendance.regularisation_request_id` | B.9: no separate table |
| `core.profiles`, `core.staff_branch_access`, `core.reporting_lines`, `core.invites` | not created | foundation `core.org_users` (display name, kind, home branch) and `core.user_branch_access` already cover them; reporting = `staff.reports_to` |
| `core.presets`, `core.platform_settings`, `core.feature_flags`, `core.platform_content`, `core.platform_releases`, `core.org_onboarding`, `core.usage_events`, `core.ai_generations`, `core.webhook_deliveries` | platform/admin stream | platform console tables, not client master data |
| `erp.staff_payroll`, `erp.staff_hr_profiles`, `crm.counsellor_settings`, `os.event_plans`, `crm.prospects/households/guardians` | product streams | product-side 1:1 / pre-admission tables |
| `core.admit_student()`, `core.student_primary_phone()`, `core.can_contact()`, `core.upsert_staff()` | CRM / ERP / OS streams (C.1 step 17) | depend on product tables |

## Known issues

* **Clashes with the legacy OS migrations** in a combined database (`pnpm db:reset`): none of the new tables or
  function names clash (`core.*` vs `public.*`; the core staff helper is `app.my_core_staff_id`, not the OS
  `app.my_staff_id`). Inherited from the foundation: `app.apply_rls` and `app.can` get a second (OS) overload, and
  `app.drop_policies(text)`; `app.touch_updated_at()` and `app.my_org_id()` bodies are replaced by the OS versions
  (same body / OS answer). Policies were bound when created, so they are unaffected; but calling
  `app.apply_core_rls` (which calls the 5-argument `app.apply_rls`) after the legacy OS migrations have run fails
  as ambiguous. The OS rewrite must drop the legacy overloads before adding core tables later.
* Single-writer tables (`staff_attendance`, `leave_requests`, `leave_balances` = OS; `enrolments`,
  `student_leave_requests` = ERP) cannot be written by an org without that product (e.g. ERP-only client staff
  leave). This follows MAP-TABLES B literally; switching one to `'*'` is a one-line generator change.
* Column-level ownership (risk D1: one product overwriting another's columns on shared rows) is not enforced in the
  database; product servers must only write the columns B assigns to them.
* `deleted_at` is not filtered by policies; queries must add `deleted_at is null`.
* `members` tables (rooms, departments, positions, custom_fields, …) are readable by portal users too, including `rooms.qr_token`.
* `incidents.student_ids` / `staff_ids` are arrays without foreign keys (B.16).
* Write performance: `'*'` writes evaluate `app.can` once per product; fine for screens, consider security definer
  write functions for bulk imports.
