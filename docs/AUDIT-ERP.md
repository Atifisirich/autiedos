# AUDIT-ERP.md — Phase 1 discovery of `hbi83701-tech/autoederp` (read-only), 2026-11-24

Source: shallow clone of the public repo (1 commit, 2026-11-16). Nothing was run or changed. Its Supabase project `autoederp` (Tokyo, `ap-northeast-1`) is **not** in the `digivate` Supabase organisation this session can see, so its database was not inspected.

## 1. What it is

* Next.js 15 + `@supabase/supabase-js` / `@supabase/ssr`, 179 files, ~100 screens, **186 tables** generated from one definition file (`schema/tables.mjs` -> `schema/gen.mjs` -> `supabase/migrations/002_tables.sql`, `003_policies.sql`), 7 migrations, golden tests for fees, grading, payroll and timetable rules, an isolation e2e script.
* Product name: "AutoED-ERP — the school operating system", built from a "School Operating System PRD v1.0". Coverage per requirement ID is in the repo's `docs/COVERAGE.md`.
* **It is much wider than "ERP"**: student information, attendance, timetable, homework, assessment and report cards, exams, fees, HR and payroll, accounting, transport, hostel, canteen, library, inventory, safety, helpdesk, communication, forms, reports, parent app, student portal, driver app, platform console.

## 2. Security model (good fit with the plan)

* `org_id` on every table; RLS policies generated from the table definition (so none is missed). Matches plan rules 1 and 4.
* One `profiles` row per auth user with a single `org_id`: **one person = one client**, as the owner decided (Q12).
* `app.can(capability, need)` reads an editable `role_permissions` matrix (levels F/B/S/O/V/R); `app.my_students()` / `app.my_households()` restrict parents and students to their own children. This is the parent/student portal model the plan needs.
* Trigger-enforced immutability for receipts, payments, vouchers; marks locked once published; separate restricted tables for health/category/bank; append-only `audit_events`; anon can call only the QR verification function.
* **Gaps against the plan:**
  1. Everything is in the `public` schema (plan: product schemas `core`, `os`, `crm`, `erp`).
  2. The app reads and writes through Supabase's Data API as the signed-in user (RLS only). The plan's layer 2 (each product's server uses its own DB role that cannot touch other schemas) does not exist here.
  3. No product/subscription check (`app.user_has_product`); "modules" are a jsonb on the organisation.
  4. Auth is Supabase email sign-up; no phone OTP, no password policy tables.
  5. AI uses the Anthropic SDK (`src/lib/ai.ts`); decision 40 says Gemini only.
  6. No job queue: time-based automations only run when an admin presses "Run now" (needs the per-minute tick).
  7. Files: links only, no upload. Data residency: Tokyo, must be Mumbai.
  8. The repo's own COVERAGE notes the build is an MVP: no native apps, no payment gateway, messages queued with no provider.

## 3. Overlap with OS and CRM (the main finding)

Plan §4.5 says: a row moves to `core` when two products need it. These areas exist in **both** the ERP repo and the OS (or the CRM) today, each with its own tables:

| Area | ERP tables | Also in | Proposed home |
|---|---|---|---|
| Organisation, branches, academic years, classes/sections, subjects | `organisations`, `branches`, `academic_years`, `programmes`, `sections`, `subjects` | OS, CRM | `core` |
| Staff and staff HR record | `staff`, `staff_sensitive` | OS `staff` | `core.staff` (OS owns, ERP adds `erp.staff_payroll`) per decision 39 |
| Students, households, guardians, enrolments | `students`, `households`, `guardians`, `enrolments`, `student_sensitive` | OS `students`, CRM `students`/`households`/`guardians` | `core` (the ERP design is the richest; CRM rows become `core` only on admission, decision 38) |
| Student attendance, staff attendance, regularisation | `attendance`, `attendance_submissions`, `attendance_regularisations` | OS | `core` (OS and ERP both need it) |
| Leave | `leave_types`, `leave_requests`, `leave_balances` | OS | `core` |
| Timetable and substitution | `bell_periods`, `teacher_assignments`, `timetable_entries`, `substitutions` | OS | `core` |
| Lesson plans, syllabus coverage, observation, appraisal | `lesson_plans`, `syllabus_coverage`, `classroom_observations`, `appraisals` | OS | `os` or `core` (decide per feature) |
| Homework, exams, question papers | `posts`, `exams`, `exam_seating`, `question_papers` | OS | `core` or `os` |
| Helpdesk, circulars/messages, calendar, events, incidents | `tickets`, `messages`, `calendar_events`, `events`, `incidents` | OS | `core` (notify) / `os` |
| Approvals, delegations, automations, audit | `approval_rules`, `approvals`, `delegations`, `automations`, `audit_events` | OS (`approvals`, `audit_log`) | `core` / `audit` |
| Admissions enquiries | `enquiries`, `prejoining_tasks` | CRM | CRM owns the pipeline; ERP keeps only post-admission checklist |
| Message templates, consents, data requests, retention | `message_templates`, `consents`, `data_requests`, `retention_rules` | CRM, OS | `core` / `notify` |

Only ERP: fees (13 tables), accounting (6), payroll and HR extras (≈15), transport (8), hostel (4), canteen (3), library (5), inventory (10), report cards and assessments (8), wellbeing/health (6), safety/gate (7), alumni, group/franchise, statutory, parent/student/driver screens.

Only OS: tasks and checklists, duty roster, AI lesson planner with credits, curriculum maps, help bot, plan bank, platform console for AI credits.

## 4. Decisions the owner must make (before Phase 2 design)

1. **Overlapping features: whose implementation survives?** Proposal: for each row above, shared data lives in `core`; the screens and rules come from whichever product is stronger (OS for staff-side work: tasks, leave, staff attendance, substitution, planner, observation; ERP for student-side data: SIS, student attendance, report cards, fees links). Phase 2 produces a table-by-table list for sign-off.
2. **ERP database access.** Keep the ERP on the Data API with RLS (fast port, but plan rule 8 "product server cannot query other schemas" does not hold for ERP) **or** rewrite its ~100 screens to call a server API with an `erp_server` role (slow, consistent). Proposal: keep Data API with RLS for ERP first, enforce the product check in RLS, and record rule 8 as an ERP exception.
3. **The ERP's Supabase project and account.** `autoederp` (Tokyo) is outside the `digivate` org. Is its data demo only? Who owns that account? The code will be ported into `autoed-crm-mumbai`; the Tokyo project is not needed afterwards.
4. **Order of work.** OS and CRM first (Phases 3-5) as planned, ERP port after. Confirm, because the ERP is far larger than the plan assumed ("weeks to months").

## 5. Effect on the plan

* Phase 1 is complete once the owner reviews this and `AUDIT-CRM.md`.
* §7 "ERP (new build)" becomes "ERP port": its schema is already generated from one definition and uses `org_id`, so most work is moving tables into `core`/`erp`, adding the product check, replacing Anthropic with Gemini, and wiring phone OTP and password login.
* Effort for the ERP is now estimated from its size (186 tables, ~100 screens) rather than "new build".
