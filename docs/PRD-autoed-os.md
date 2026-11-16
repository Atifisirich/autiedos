# AutoEd OS — Product Requirements Document

> Source: AutoEd-OS-PRD.pdf (Nov 16, 2026, @atif). Text transcribed verbatim from the PDF; tables keep their column layout.

```text
AutoEd OS — Product Requirements
Document
  Nov 16, 2026     ·   @atif

1. How to use this PRD in Claude Code
AutoEd OS is built as a new module inside the existing AutoEd CRM/ERP app (Next.js on
Vercel, Supabase Postgres in Mumbai). Save this document in the repo as docs/PRD-
autoed-os.md and start Claude Code with the prompt in 1.1.

1.1 Start prompt

  Read docs/PRD-autoed-os.md fully. Build AutoEd OS exactly as specified, phase
  by phase (section 10), inside this repo. Follow the build rules in section
  1.2. Do not stop for confirmation between phases unless you hit a blocker
  listed in section 1.3. After each phase, run typecheck, lint and tests, fix
  failures, then append a summary to docs/BUILD-LOG.md and continue.

1.2 Build rules (mandatory)
   1. Audit first. Before writing code, read the existing repo and database. List existing
      tables for organisations, users, staff, classes and students. Reuse them. Never create
      a duplicate of something that exists.
   2. One app, modular. All OS routes live under /os . Every module in sections 5 to 8 has a
      feature flag per branch in module_flags . A disabled module is hidden in navigation
      and blocked at the API.
   3. Database changes only through migrations committed to the repo. No manual
      schema edits.
   4. Row Level Security on every table. A user reads and writes only rows of their own
      organisation, limited further by branch and permission. Write an RLS test for every
      table.
   5. No hard-coded school structure. Roles, wings, classes, periods, categories, statuses
      labels, templates and approval chains come from configuration tables (section 4.4).
   6. Three languages from the first screen. All interface text goes through the translation
      layer (English, Hindi, Telugu). No literal strings in components.
   7. AI calls are server-side only. Keys never reach the browser or the mobile app. Every AI
      call is recorded in ai_generations and charged to ai_credit_ledger (section 8.5).

   8. Never send student names, phone numbers or staff personal data to the AI
      provider. Use class, subject and topic context only.
   9. Every state change is audited in audit_log (who, what, before, after, when, device).
10. Mobile and web share one API and one set of validation schemas
      ( packages/shared ).
11. Seed data. Maintain a seed script that creates "Demo International School" with 2
    branches, 40 staff, 20 sections, a timetable and sample tasks, so every screen can be
      opened and tested.
12. Tests. Unit tests for every rules engine (assignment rules, escalation, leave balance,
    substitution ranking, timetable clash detection, credit metering). End-to-end tests for
    the flows listed in section 10.
13. If something in this PRD is ambiguous, choose the option that keeps the school able
    to configure it, record the choice in docs/DECISIONS.md , and continue.

1.3 Blockers that need Atif
Stop and ask only for these. Everything else: decide, record, continue.

  Needed                                       Used for

  Anthropic API key                            Lesson planner, paper generator, insights,
                                               help bot

  WhatsApp provider credentials and            WhatsApp alerts
  approved templates (same provider as the
  CRM)

  Expo (EAS) account, Firebase project         Mobile builds and Android push

  Google Play Console and Apple Developer      Store release
  accounts

  Sentry DSN                                   Error monitoring

Until a key is provided, build against a mock adapter behind the same interface so that
work continues.

1.4 A note on "one go"
This is a large product: 10 phases and roughly 90 database tables. Claude Code can run it
as one continuous job, but each phase must pass its acceptance checks before the next
begins. Expect to open the app and test at each phase gate; a single unreviewed run of
this size will carry defects forward.

2. Product overview
AutoEd OS is the daily operating system for a school's staff: one place where every
employee sees what they must do today, every senior sees whether it was done, and
management gets reports to run the school on facts.

2.1 Problem
Indian K-12 schools run operations on WhatsApp groups, paper registers and verbal
instructions. Tasks are forgotten, nobody knows who was told what, lesson plans are
copied from last year, substitutions are arranged in a panic at 8 am, and the principal has
no single view of the day.

2.2 Target customer
      Private K-12 schools in India following CBSE or Cambridge (Primary, Lower Secondary,
      IGCSE), including dual-curriculum schools.
      Single schools and school groups with several branches.
      30 to 300 staff per branch.

2.3 Users (staff only)

  Persona                                       What they need from AutoEd OS

  Chairman / Director (group)                   Branch comparison, exceptions, monthly
                                                decision reports

  Principal / Head of school                    Daily digest, approvals, staff performance,
                                                compliance status

  Vice Principal / Academic Coordinator         Lesson plan review, syllabus coverage,
                                                substitutions, observations

  Head of Department                            Subject-level planning, question paper
                                                review, teacher support

  Class teacher / Subject teacher               My Day, tasks, lesson plans, attendance,
                                                class log

  Admin officer / Front office                  Staff attendance, circulars, approvals,
                                                helpdesk routing

  Non-teaching supervisors (transport,          Checklists, tickets, duty tasks
  housekeeping, IT, lab, library, security)

  Persona                                                  What they need from AutoEd OS

  Support staff (drivers, attenders,                       Simple task list and checklists in Hindi or
  housekeeping)                                            Telugu, voice notes instead of typing

  AutoEd super admin (Digivate)                            Tenants, plans, modules, AI credits, support

2.4 Goals and success measures

  Goal                                      Measure (per branch, after 60 days of use)

  Staff use it daily                        80% of staff open the app on working days

  Tasks are tracked                         90% of assigned tasks reach a final status; on-time
                                            rate is visible per person

  Planning time drops                       Daily lesson plan drafted in under 3 minutes; 85%
                                            of plans submitted before deadline

  No uncovered classes                      100% of absent teachers' periods have a substitute
                                            assigned before the period starts

  Management decides on data                Principal opens the daily digest on 90% of working
                                            days

  Easy to set up                            A school completes setup in under 1 working day
                                            using the wizard and Excel import

2.5 Out of scope for this build
      Parent and student logins.
      Marks entry, result analysis, report cards (stay in the ERP).
      Fees, payroll calculation, accounting.
      Bus GPS tracking.
      Face recognition. The check-in selfie is stored as proof only.
      The e-note taker device integration.

2.6 Decisions already locked

  Topic                                     Decision

  Architecture                              New module inside the existing AutoEd app; one
                                            codebase, one database, one login; modules
                                            switchable per branch

  Stack                                     Next.js (Vercel) + Supabase; mobile in React Native
                                            with Expo

  Logins                                    Staff only

  Tenancy                                   School groups with branches; single schools are a
                                            group with one branch

  Task assignment                           Each school defines who can assign to whom;
                                            default is top-down along the reporting line

  Task completion                           Assigner chooses per task: self-mark, or proof plus
                                            verification

  Attendance                                Staff (app check-in plus biometric import) and
                                            student (marked by teachers)

  Lesson planner syllabus                   Preloaded CBSE and Cambridge maps plus the
                                            school's own uploads

  Exams                                     Exam planning, invigilation and AI question paper
                                            generator; no marks

  Notifications                             App push plus WhatsApp for important items,
                                            WhatsApp cost billed to the school

  Languages                                 English, Hindi, Telugu at launch

  AI usage                                  Monthly AI credits per branch by plan, with top-ups

3. Architecture and tech stack
AutoEd OS extends the existing app; it does not introduce a second backend. Checked on
16 Nov 2026: the Vercel project autoed-crm is Next.js on Node 22, and the Supabase
project autoed-crm-mumbai (region ap-south-1) had no public tables yet, so the audit in
rule 1 decides what is reused.

  Layer                      Choice                               Notes

  Web app                    Next.js App Router, TypeScript,      Routes under /os ; responsive down
                             existing UI kit of the CRM           to tablet width

  Mobile app                 React Native with Expo,              Shares types and validation from
                             TypeScript, in /mobile               packages/shared

  Database                   Supabase Postgres, Mumbai            RLS on all tables; pgvector for
                             region                               search over curriculum, uploads and
                                                                  help articles

  Auth                       Supabase Auth                        Phone OTP and email login; staff are
                                                                  invited by the school, no self sign-up

  Files                      Supabase Storage                     Private buckets per organisation,
                                                                  signed URLs, size limits per file type

  Realtime                   Supabase Realtime                    Task updates, substitution alerts,
                                                                  dashboards

  Background                  jobs queue table processed by       Recurring tasks, escalations,
  jobs                       scheduled functions (Supabase        digests, timetable generation,
                             cron or Vercel cron)                 imports, embeddings

  Push                       Expo Notifications (FCM for          Device tokens in device_tokens
                             Android, APNs for iOS)

  WhatsApp                   The CRM's existing messaging         Template messages only; usage
                             adapter                              metered per branch

  AI                         Anthropic API, server-side           Model IDs in config: a stronger
                                                                  model for lesson plans and question
                                                                  papers, a faster model for the help
                                                                  bot and short rewrites

  Translations               One translation library across web   Language chosen per user
                             and mobile, JSON catalogues per
                             language

  Monitoring                 Sentry, structured logs,
                              audit_log

3.1 Structure rules
       API. All writes go through server actions or route handlers that validate with shared
       schemas, check permission, write, audit, and enqueue notifications. The mobile app
       calls the same endpoints.

      Rules engines as pure functions in packages/shared/rules : canAssign ,
       nextEscalation , leaveBalance , rankSubstitutes , detectClashes , creditCost .
      They are unit-tested and used by both web and mobile.
      Timetable generator runs as a background job: greedy placement with backtracking
      in TypeScript, most-constrained class-subject first. It returns the best timetable
      found plus a list of unplaced periods with reasons.
      AI output is structured. Every generator returns JSON matching a schema, is
      validated, then rendered into the school's template. Free-text output is never stored
      directly.
      Offline. The mobile app keeps a local store and an outbox for tasks, checklists,
      student attendance and class log (section 9.2).
      Module flags. module_flags(branch_id, module_key, enabled) ; navigation, API
      and jobs all check it.

3.2 Module keys
 tasks , checklists , timetable , substitution , staff_attendance ,
 student_attendance , leave , approvals , lesson_planner , syllabus_coverage ,
 class_log , exams , observation , helpdesk , circulars , calendar , meetings ,
 events , duty_roster , incidents , compliance , reports , help_bot .

4. Tenancy, hierarchy, permissions and customisation
Every school defines its own structure, roles and rules without code; AutoEd ships
sensible presets so a school is usable on day one.

4.1 Tenancy
      Organisation (school group) → Branch (one school campus) → Wing (Pre-primary,
      Primary, Middle, Secondary, Senior Secondary; editable) → Class → Section.
      A branch has a board setting per wing: CBSE, Cambridge, or both.
      Academic year and terms are per branch. Year rollover copies structure, promotes
      sections, archives the old year read-only.
      A staff member belongs to one home branch and can be given access to others.
      Group-level users see all branches; branch users see only theirs.

4.2 Hierarchy
      Each staff member has a position (for example "Middle School Coordinator"), a
      department, one primary manager ( reports_to ) and optional secondary managers
      (for example a subject HOD).
      The org chart is edited on a drag-and-drop tree and by Excel import.
      Preset positions shipped: Chairman, Director, Principal, Vice Principal, Academic
      Coordinator (per wing), Head of Department, Class Teacher, Subject Teacher, Admin
      Officer, Front Office Executive, Accountant, Transport In-charge, Housekeeping
      Supervisor, IT Administrator, Lab Assistant, Librarian, Security Supervisor, Support
      Staff.
      When a manager is on leave, a named delegate receives their approvals and
      escalations for those dates.

4.3 Roles and permissions
      A role is a named set of permissions. A staff member can hold several roles (a teacher
      who is also an HOD).
      Permission format: module.action.scope . Actions: view , create , edit , delete ,
       assign , approve , verify , export , configure . Scopes: own , team (everyone
      below in the reporting tree), wing , department , branch , group .
      The school edits roles on a matrix screen (modules as rows, actions as columns, scope
      as a dropdown). Preset roles match the preset positions.
      Assignment rules ( assignment_rules ): for each pair of roles, one of assign ,
       request , none .
             Default: a user can assign to anyone below them in the reporting tree.
             Default: peers and upward are request ; the receiver must accept before it
             becomes their task.
             The school can override any pair, for example allow the Admin Officer to assign to
             all teachers.
      Sensitive data has its own permissions: appraisal scores, incidents marked
      confidential, question papers before the exam date.

4.4 What a school can customise

  Area                     Customisable items

  Structure                Branches, wings, classes, sections, subjects,
                           departments, rooms, terminology ("Class" or
                           "Grade", "Period" or "Block")

  Area                     Customisable items

  Time                     Academic year, terms, working days, bell schedule
                           per wing, holidays

  People                   Positions, roles, permission matrix, assignment
                           rules, delegates

  Tasks                    Categories, priorities, custom fields, escalation
                           timings, proof rules per category

  Workflows                Approval chains per request type, leave types and
                           balances, lesson plan review steps

  Templates                Checklists, lesson plan formats, observation
                           rubrics, question paper blueprints, event task
                           packs, circular formats

  Reports                  Branding (logo, header, footer), saved custom
                           reports, scheduled digests

  Notifications            Which events notify whom, on which channel,
                           quiet hours

  Modules                  Switch any module on or off per branch

      Custom fields: text, number, date, dropdown, yes/no, file. Attachable to tasks, tickets,
      incidents, approvals, staff profiles.
      Setup wizard (8 steps): school profile and board → academic year and bell schedule →
      wings, classes, sections → subjects → staff import → org chart → roles check →
      modules. Each step has an Excel template download and upload with row-level error
      messages.
      Presets: "CBSE school", "Cambridge school", "Dual curriculum school". A preset fills
      wings, subjects, positions, roles, task categories, leave types, checklists and rubrics.
      Everything remains editable.
      Every configuration screen has a Reset to preset action and a change history.

5. Core operations modules
These six modules run the school day: tasks, checklists, timetable, substitution,
attendance, and leave with approvals.

5.1 Task management
Task sources

  Source                              How it is created

  Assigned                            A senior assigns to one person, several people, a
                                      role, a wing or a department

  Self-planned                        A staff member plans their own work

  Recurring                           A rule creates the task daily, weekly, monthly, per
                                      term or on custom days; skips holidays

  Sudden (unplanned)                  "Quick add" in two taps: title, optional voice note,
                                      time spent. Flagged unplanned so reports show
                                      how much of a person's day was unplanned

  Request                             From a peer or junior; becomes a task only after the
                                      receiver accepts

  System                              Created by other modules: substitution period,
                                      lesson plan due, attendance not marked, approval
                                      pending, checklist issue, meeting action,
                                      observation follow-up

Fields. Title, description, category, priority (Low, Normal, High, Urgent), owner,
collaborators, watchers, assigner, start and due date-time, estimated minutes, recurrence,
linked item (class, subject, event, ticket, lesson plan), subtasks, attachments, voice note,
custom fields, proof_required (none, note, photo, file), verification_required
(yes/no).

Group assignment. When assigning to many people the assigner picks: "each person
completes it" (one child task per person, with a completion tracker) or "any one person
completes it".

Statuses

  Status                Meaning                                                   Who sets it

  To do                 Not started                                               System

  In                    Started                                                   Owner
  progress

  Blocked               Cannot proceed; reason required                           Owner

  Done                  Completed; if verification is required it waits           Owner
                        here as "Awaiting verification"

  Verified              Assigner confirmed                                        Assigner

  Status                Meaning                                       Who sets it

  Reopened              Sent back with a comment                      Assigner

  Not done              Was not done; reason required (no time, not   Owner or system at day
                        possible, not needed, other)                  close

  Cancelled             Withdrawn                                     Assigner

 Overdue is a derived flag, not a status. Delegated is recorded as an event; the chain of
delegation stays visible.

Actions. Accept, ask a question, start, mark done with proof, mark not done with reason,
request extension (goes to assigner), delegate (if the role allows), comment with
@mention, attach, reopen, verify, cancel, convert a comment into a subtask.

Views

      My Day (home screen): one timeline merging today's periods, duties, tasks,
      checklists, meetings and substitutions. Free periods are shown as slots where tasks
      can be dropped.
      Plan my week: drag tasks onto days and free periods.
      List, Board (by status), Calendar.
      Team (for anyone with juniors): per-person workload, overdue count, on-time rate,
      unplanned share; drill into any person's day.
      Assigned by me: everything I gave out, grouped by status.

Day close. At a configurable time the app asks each staff member to close the day: each
open task due today is marked done, not done with reason, or carried forward.
Unanswered items are marked Not done – no response the next morning.

Escalation. Configurable per category. Default: reminder 2 hours before due; at due time
notify owner; 4 working hours overdue notify assigner; 1 working day overdue notify the
assigner's manager. Urgent tasks escalate at half those intervals.

Rules

      Only the assigner or someone above them can change the due date or cancel.
      A task with verification_required counts as complete in reports only after
       Verified .
      Editing after completion is blocked; reopening is the only route.
      Every change is written to task_events .
      Bulk actions: assign, reschedule, reassign when a staff member leaves.

5.2 Recurring checklists and SOPs
      A template has items of type tick, yes/no, number with allowed range, photo, text, and
      a schedule, an owner role or person, and a location.
      Presets shipped: morning opening, closing, bus safety (per bus), washroom
      inspection, lab safety, kitchen and water hygiene, CCTV check, classroom readiness,
      fire equipment monthly.
      A scheduled template creates a run. The owner completes it on mobile, offline if
      needed.
      A "No" or out-of-range answer can be set to auto-create a helpdesk ticket or a task for
      a named role.
      A missed run escalates to the owner's manager.
      Reports: completion rate per checklist, repeated failures per item, photo evidence
      gallery.

5.3 Timetable
Inputs. Bell schedule per wing (periods, breaks, assembly, different days allowed), weekly
periods per subject per class, teacher allocation (teacher-subject-section), teacher limits
(max periods per day and per week, unavailable slots, part-time days), rooms and labs
with capacity, double periods, fixed slots (assembly, library, games, clubs), split groups
(second and third language, electives, IGCSE option blocks), combined sections, co-
teaching.

Generation. Background job (section 3.1). Hard constraints: no teacher, section or room
clash; limits respected; fixed slots kept. Soft goals: core subjects earlier in the day, no
subject twice a day unless a double period, spread across the week, balanced teacher
days, class teacher takes period 1 where possible. Output shows unplaced periods with
the reason and a suggested fix.

Editing. Drag and drop with live clash warnings, swap two periods, lock a cell, undo.
Changes after publishing are versioned with an effective date.

Outputs. Views by section, teacher, room; teacher workload table; free-teacher finder for
any period; PDF and Excel export with school branding; today's periods on the teacher's
My Day.

5.4 Substitution
      Trigger: approved leave, or a teacher marked absent by the check-in cut-off time.
      The system lists each affected period and ranks free teachers with rankSubstitutes :
      same subject and wing, then teaches that section, then fewest substitutions this
      week and month, then lowest teaching load today. Teachers on duty, in exams or over

      their daily limit are excluded.
      Modes per branch: coordinator confirms each suggestion with one tap, or auto-assign
      with coordinator override.
      The substitute gets a push and WhatsApp alert, a system task, and the period's lesson
      plan or a one-period cover plan (section 6.1).
      If no teacher is free the period is flagged to the coordinator with options: combine
      sections, library or games period, assign non-teaching supervision.
      Reports: substitution register, fairness table (substitutions per teacher), periods lost
      per class and subject.

5.5 Attendance
Staff

      App check-in and check-out inside the branch location boundary (latitude, longitude,
      radius set by admin) with a selfie stored as proof. Location is read only at the moment
      of check-in. No background tracking.
      Biometric import: upload CSV or Excel from the school's device software; a column-
      mapping screen saves the mapping per device type. The import and the app records
      are merged; conflicts are listed for the admin.
      Shifts per position, grace minutes, late and half-day rules, early-exit rule, all
      configurable.
      Regularisation request ("forgot to check in") goes through approval.
      Monthly register export in Excel for payroll: present, absent, late count, half days,
      leave by type, loss of pay days.

Students

      Student roster: reuse the ERP's student table if present; otherwise a minimal
       students roster (name, admission number, class, section, roll number, status)
      imported from Excel. No student or parent accounts.
      Mode per wing: once daily, twice daily, or period-wise.
      Marking screen: all present by default, tap to change to Absent, Late, Half day, On
      duty, Leave. Works offline.
      If attendance is not marked by the cut-off, a system task and reminder go to the
      teacher, then to the coordinator.
      Edits after submission need a reason; edits after the edit window need approval.
      Reports: daily summary by class, absentee list, students below a set percentage,
      consecutive absences, monthly register in the format schools print.

      Optional per branch: absent alert to parents over WhatsApp through the CRM
      messaging adapter, using the parent phone on the roster.

5.6 Leave and approvals
Leave

      Leave types configurable. Presets: Casual, Sick, Earned, Loss of pay, On duty, Short
      permission (hours), Compensatory off, Maternity.
      Per type: yearly quota, accrual (yearly or monthly), carry forward, half-day allowed,
      notice days, document required after N days, sandwich rule on or off.
      Apply with dates, half-day, reason, attachment, and a hand-over note. Balance and
      clashes ("3 others from your department are on leave that day") are shown before
      submitting.
      Approval follows the chain set for the applicant's role. Approval triggers substitution
      for affected periods.
      Leave calendar by department and branch. Cancellation and extension flows.

General approvals

      The school builds request types with a form builder: purchase, reimbursement, event
      proposal, field trip, gate pass, room booking, stock request, and its own.
      Each type has an approval chain: steps by role or by "manager of applicant",
      conditions (for example amount above a limit adds the Director), parallel or
      sequential, time limit per step, auto-escalation.
      Approver actions: approve, reject, return for changes, forward. All with comments, all
      audited.
      An approved request can create tasks from a template (for example an approved field
      trip creates the trip checklist).

6. Academic modules
The AI lesson planner is the headline feature: it plans from the school's real calendar,
timetable and syllabus, in the school's own format, and feeds coverage tracking, the class
log and substitution.

6.1 AI lesson planner
Curriculum library

      Structure: Board → Stage or Grade → Subject → Unit → Chapter → Topic → Learning
      outcomes.

      Preloaded maps: CBSE Classes 1 to 12 (NCERT-aligned chapter and topic outlines with
      learning outcomes and competencies) and Cambridge Primary, Lower Secondary and
      IGCSE (strands, topics, learning objectives, assessment objectives).
      Stored as outlines written for AutoEd, tagged with the syllabus year. Textbook text
      and board documents are not copied into the library.
      A school can clone a map and edit it: reorder chapters, add its own textbook, remove
      topics, add school-specific outcomes.
      School uploads: textbooks, year plans, existing lesson plans, worksheets (PDF, DOCX,
      images). Files are parsed, split, embedded and searchable only within that
      organisation. The planner draws on them when generating.
      A super admin screen updates the preloaded maps each year; schools are told when a
      newer syllabus year is available and choose when to move.

Plan levels

  Level                      What it produces                       Built from

  Annual plan                Chapters placed across months and      Working days, holidays, exam
                             terms for each class-subject           dates, periods per week from the
                                                                    timetable, chapter weight

  Unit plan                  Objectives, period-by-period           Annual plan, curriculum map
                             outline, assessments for one
                             chapter

  Weekly plan                The week's periods for one teacher     Unit plans, timetable
                             with topics

  Daily (period)             Full plan for one period or a double   Unit plan, period length, class
  plan                       period                                 profile

Inputs for a daily plan. Section(s), subject, chapter and topic (picked from the library),
number and length of periods (prefilled from the timetable), teaching model, resources
available (smart board, lab, projector, none), class profile (size, ability mix, medium of
instruction), and free-text notes from the teacher.

Content of a daily plan

   1. Learning objectives, each tagged with a Bloom's level and mapped to curriculum
      learning outcomes.
   2. For CBSE: competencies and NEP 2020 aligned elements (experiential learning, art
      integration, sports integration, life skills) where they fit naturally. For Cambridge:
      learning objectives, assessment objectives, key vocabulary, success criteria.
   3. Prior knowledge check.

   4. Teaching aids and materials.
   5. Timed lesson flow that adds up exactly to the period length: opening, teaching,
      guided practice, independent practice, closure.
   6. Differentiation in three tiers: support, core, extension.
   7. Questions to ask, including higher-order and competency-based questions.
   8. Formative check or exit ticket with answers.
   9. Homework with estimated minutes.
10. Cross-curricular and real-life links (Indian context examples).
11. Board-work summary.
12. Teacher reflection (filled after the class).

Teaching models selectable per plan and as a school default: 5E, Gradual Release (I do, we
do, you do), Experiential Learning Cycle, Inquiry-based, Direct Instruction, Flipped, and
the school's own format built in the template editor.

Template editor. The school defines its lesson plan format: which sections appear, their
names, order, mandatory or optional, header with logo. Output always renders in this
format. A school can keep different formats per wing.

Generation pipeline

   1. Collect context: curriculum topic and outcomes, relevant passages from school
      uploads, the unit plan, what was actually covered last period (from the class log),
      period length.
   2. Generate structured JSON against the plan schema.
   3. Validate: timings sum to the period length, every objective maps to an outcome, all
      mandatory template sections are filled. Regenerate failed parts automatically, at most
      twice.
   4. Render in the school template in a rich editor. The teacher edits anything.
   5. Section-level AI actions: regenerate this section, make it more hands-on, simplify, add
      an activity without technology, shorten to N minutes, add questions, translate.

Languages. Plans for Hindi, Telugu and other language subjects are generated in that
language. Any plan can carry bilingual teacher notes.

Companion generators (one tap from a plan): worksheet with answer key, quiz, exit
ticket, homework sheet, slide outline, activity ideas, assessment rubric, remedial plan for
weak learners, enrichment task, one-period cover plan for a substitute.

Workflow

       Draft → Submitted → In review → Approved or Returned → Delivered →
       Reflected .

      Review steps are configurable (for example HOD then Coordinator). Reviewers
      comment per section.
      Submission deadlines are school rules, for example "weekly plans due Friday 4 pm".
      The rule creates system tasks and reminders; late and missing plans appear in reports.
      A plan cannot be submitted until the teacher has opened and confirmed it. AI output
      is always marked as a draft until then.

Plan bank. Approved plans are saved to a searchable bank by class, subject and topic.
Teachers reuse and adapt them across sections, years and, if the group allows, branches.
The bank shows usage count and rating.

Export. PDF and DOCX with school header; print-friendly; weekly plan as one document.

Quality rules

      Output is original text; it must not reproduce textbook passages.
      Facts, formulas and answers are generated with the answer key, and the teacher is
      responsible for final checking; the screen says so.
      Mathematics and science notation render correctly (LaTeX).
      Each generation shows its credit cost before running (section 8.5).

6.2 Syllabus coverage tracker
      Planned comes from the annual plan; actual comes from class log entries and
      delivered lesson plans.
      Per class-subject: percentage covered, periods ahead or behind, projected
      completion date against the next exam date.
      Colour status: on track, at risk (behind by more than a configurable number of
      periods), critical.
      Alerts to the teacher, HOD and coordinator when a class moves to at risk.
      "Recovery plan" AI action: re-spreads remaining chapters across remaining periods
      and shows what must be compressed.
      Views: by teacher, by class, by subject, by wing; branch comparison for groups.

6.3 Class log (classwork and homework)
      After each period the teacher logs: topic taught (prefilled from the plan), classwork,
      homework with due date, remarks. "Taught as planned" is one tap.
      Missing logs create a reminder at day close; repeated misses go to the coordinator.
      Homework load view per section per day, so coordinators can see overload before it
      happens. A configurable daily limit in minutes per wing shows a warning.

      Notebook correction tracker: teacher records each correction cycle per section and
      subject; coordinators record spot checks with a short rubric.
      Coordinators can audit any section's log by date.

6.4 Exam planning and question paper generator
Exam planning

      Exam types configurable. Presets: periodic test, unit test, term exam, pre-board,
      practical, Cambridge progression or checkpoint practice, mock.
      Exam timetable builder with clash checks against the calendar.
      Invigilation duty allocation: automatic and fair, with rules (not the subject teacher,
      maximum duties per day, relievers); swap requests through approval.
      Seating plan generator by room capacity, mixing classes.
      Each exam creates its task pack: paper submission deadline, review, printing, answer
      script collection, correction deadline.

Question paper generator

      Blueprint: total marks, duration, sections, question types and counts, marks per type,
      chapter weightage, difficulty mix (easy, medium, hard), Bloom's distribution, share of
      competency-based questions. All editable; schools save blueprints as templates.
      Preset question types for CBSE: MCQ, assertion-reason, case or source-based, very
      short, short, long answer, map and diagram questions. For Cambridge: multiple choice,
      structured, extended response, practical or alternative-to-practical style, tagged by
      assessment objective.
      Output: question paper, marking scheme with step marks, and a blueprint table
      showing each question's chapter, type, level and marks.
      Up to 3 parallel sets of equal difficulty.
      Questions can be pulled from the school's question bank (approved questions saved
      with tags), AI-generated, or mixed. Each question can be replaced individually.
      Review workflow: setter → HOD → coordinator. Returned with comments or approved.
      Confidentiality: papers are visible only to the setter and named reviewers until the
      exam date; every view and download is logged; downloads carry a watermark with the
      user's name and time.
      Export DOCX and PDF in the school's paper format, with general instructions block.

6.5 Classroom observation and appraisal
      Rubric builder: domains, indicators, rating scale, weights. Presets: lesson delivery,
      classroom management, student engagement, assessment practice, professional
      conduct.
      Schedule observations (announced or unannounced) from the timetable; the
      observer fills the form on mobile with evidence notes.
      Feedback is shared with the teacher, who acknowledges and adds a reflection.
      Agreed actions become tasks.
      Appraisal scorecard per cycle with school-set weights across: observation scores,
      task on-time rate, lesson plan timeliness, syllabus coverage, class log compliance,
      punctuality, training hours, self-appraisal, manager rating.
      Training log: workshops and courses attended, hours, certificates; yearly target hours
      per staff member.
      Scorecards are decision support. Visibility is restricted by permission; the teacher
      sees their own only when the school releases it.

7. Administrative modules
These modules cover everything outside the classroom. Sections 7.5 to 7.8 are additions
recommended beyond the original brief.

7.1 Maintenance helpdesk
      Any staff member raises a ticket in three taps: category, location, photo or voice note.
      Categories (editable): IT, electrical, plumbing, furniture, housekeeping, transport, lab,
      security, other. Each has an owner role and a time limit by priority.
      Locations come from the rooms list. Optional printed QR code per room opens the
      ticket form with the location filled in.
      Statuses: Open, Assigned, In progress, Waiting (parts or vendor), Resolved, Closed
      (confirmed by the person who raised it), Reopened.
      Fields for vendor, cost and parts. A cost above a limit starts a purchase approval.
      Reports: tickets by category and location, time to resolve, breaches, repeat issues for
      the same room or asset.

7.2 Circulars and announcements
      Compose with attachments; target by branch, wing, department, role or named
      people; send now or schedule.

      Options: read receipt, "acknowledge" button, or a short reply form (for example
      yes/no with comment).
      Non-readers get a reminder after a set time; the sender sees who has not read.
      Important circulars also go by WhatsApp with a link.
      Searchable archive by date and tag.

7.3 School calendar
      Layers: holidays, exams, events, parent-teacher meetings, staff meetings, training
      days, deadlines. Per branch, with group-level entries pushed to all branches.
      The calendar is the single source of working days for timetable, lesson planning,
      recurring tasks and leave.
      Month, week and agenda views; export to phone calendar by subscription link.

7.4 Meetings
      Schedule with agenda, attendees and room; recurring meetings supported (weekly
      staff meeting, HOD meeting).
      Minutes are typed or dictated during the meeting. Each action item is given an owner
      and due date and becomes a task linked to the meeting.
      The next meeting in the series opens with the status of the previous action items.
      Attendance at the meeting is recorded.

7.5 Event planner
      Event templates with a ready task pack, committees and checklist: Annual Day, Sports
      Day, parent-teacher meeting, field trip, science exhibition, Independence Day,
      admissions open day. Schools edit and create their own.
      Creating an event from a template creates all tasks with owners by role and dates
      counted back from the event date.
      Budget lines with approval; an event dashboard shows readiness percentage.
      After the event: a short review form, saved for next year.

7.6 Duty roster
      Duty types (editable): gate, bus bay, assembly, corridor, lunch, playground, dispersal,
      exam relief.
      Automatic rotation that respects the timetable and spreads duties fairly; manual
      override.
      Swap requests between staff with coordinator approval.

      Duties appear on My Day and send a reminder before they start. Missed duties are
      recorded.

7.7 Incident and concern log
      Staff record: student discipline incidents, injuries and first aid given, parent
      complaints, safety concerns, property damage.
      Fields: type, people involved (from the roster), location, time, description, action
      taken, severity, confidentiality level.
      Each record has an owner and follow-up tasks; serious types notify the principal
      immediately.
      Parent-teacher meeting notes can be logged against a student with follow-up tasks.
      Reports: incidents by type, class, location and time of day; open follow-ups; repeat
      students (visible to permitted roles only).

7.8 Compliance and document tracker
      A register of items with expiry or renewal dates: affiliation papers, fire safety
      certificate, building safety certificate, water test report, bus fitness and permits,
      driver licences, insurance, staff verification, mandatory committees and their meeting
      dates.
      Each item has an owner, stored documents, and reminders at 60, 30 and 7 days before
      expiry; an overdue item escalates to the principal.
      A readiness percentage per branch for inspection preparation.
      Preset item lists for CBSE and Cambridge schools are starting points and are labelled
      "verify against current board and state rules"; the school edits them.

8. Reports, notifications, help bot and AI credits
Reports are the reason management pays: every module writes data that rolls up into
role-based dashboards, a daily digest and a custom report builder.

8.1 Dashboards by role

  Role                               Dashboard shows

  Chairman / Director                Branch comparison on staff attendance, task on-
                                     time rate, syllabus coverage, lesson plan
                                     compliance, open tickets, compliance readiness;
                                     exceptions list

  Role                               Dashboard shows

  Principal                          Today: staff present, late, on leave; substitutions;
                                     student attendance; unmarked classes; overdue
                                     tasks; pending approvals; critical tickets; expiring
                                     compliance items

  Coordinator                        Lesson plans awaiting review, coverage status by
                                     class, missing class logs, observations due,
                                     substitution board

  HOD                                Subject coverage across sections, question papers
                                     in review, department task status

  Teacher                            My Day, my on-time rate, my coverage, my pending
                                     plans and logs, leave balance

  Admin officer                      Attendance exceptions, regularisation requests,
                                     tickets by owner, checklist misses

Every dashboard number opens the list behind it.

8.2 Report catalogue

  Report                                    Key contents

  Daily operations digest                   Sent automatically at a set time to the principal and
                                            management: attendance, substitutions, unmarked
                                            classes, tasks due and overdue, missed checklists,
                                            open tickets, pending approvals, plans pending

  Task performance                          Completion rate, on-time rate, overdue ageing, not-
                                            done reasons, unplanned work share; by person,
                                            department, category, assigner

  Workload                                  Teaching periods, substitutions, duties, tasks and
                                            meetings per staff member per week

  Lesson plan compliance                    Submitted on time, late, missing, returned; by
                                            teacher and wing; review turnaround

  Syllabus coverage                         Planned against actual by class and subject;
                                            projection against exam dates

  Class log and homework                    Log compliance; homework minutes per section
                                            per day; notebook correction cycles

  Report                                    Key contents

  Substitution                              Register, periods lost by class and subject, fairness
                                            by teacher

  Staff attendance                          Monthly register, late trends, leave use by type,
                                            absence patterns by weekday

  Student attendance                        Daily and monthly registers, students below
                                            threshold, class trends

  Observation and appraisal                 Scores by domain, teacher growth over cycles,
                                            scorecards

  Helpdesk                                  Tickets by category and location, time to resolve,
                                            breaches, cost

  Checklist compliance                      Completion by checklist, repeated failed items

  Approvals                                 Turnaround by type and approver, pending ageing

  Compliance                                Items expiring, overdue, readiness percentage

  AI usage                                  Credits used by module and teacher, balance

All reports: filters for date range, branch, wing, department and person; chart and table;
export to Excel and PDF with school branding; schedule by email or WhatsApp link.

8.3 Custom reports and AI insights
      Report builder: choose a dataset (tasks, attendance, plans, tickets, and so on),
      columns, filters, grouping, chart type; save, share by role, schedule.
      Weekly insight summary for the principal and management, written in plain language:
      what improved, what worsened, the five items needing a decision, with links.
      Example: "Class 8 Science is 9 periods behind and will miss the term exam date by 6
      working days."
      Ask a question box: "Which teachers have the most overdue tasks this month?" The
      AI may only call predefined, permission-checked query functions. It never writes SQL
      directly and never sees data outside the asker's scope.
      Personal details sent to the AI for insights are limited to staff names needed for the
      answer; student names are replaced with roster IDs and restored on screen.

8.4 Notifications
      Channels: in-app inbox, push, WhatsApp. Email for scheduled reports only.

      A matrix screen sets, for each event, who is notified and on which channels. Presets
      shipped.
      Push for everything by default. WhatsApp by default for: urgent task assigned,
      substitution assigned, leave decision, escalation, daily digest, circular needing
      acknowledgement, critical incident.
      WhatsApp uses approved templates only; each send is metered per branch and billed
      to the school.
      Quiet hours per branch (default 8 pm to 6:30 am) hold non-urgent notifications. Low-
      priority items are batched into a morning and afternoon summary.
      Each user can mute categories the school marks as optional.

8.5 AI credits and plans
      Each branch has a monthly credit allowance set by its plan. Unused credits do not
      carry forward unless the plan allows it.
      Default cost table (editable by super admin):

  Action                                           Credits

  Daily lesson plan                                1

  Section regenerate or rewrite                    0.2

  Companion item (worksheet, quiz, cover           1
  plan)

  Unit plan                                        3

  Annual plan for one class-subject                5

  Question paper with marking scheme (per          5
  set)

  Recovery plan                                    2

  Weekly insight summary                           Included

  Help bot                                         Included, with a fair-use cap per user per
                                                   day

      Every generation writes to ai_credit_ledger with user, action, tokens, provider cost
      and credits.
      Warnings at 80% and 95% to the branch admin. At 100% generation stops with a clear
      message; the admin can request a top-up; the super admin adds credits.
      Optional per-teacher monthly cap set by the school.

      Super admin console (Digivate only): organisations, branches, plans, module flags,
      credit top-ups, AI cost against credits sold, WhatsApp usage, curriculum library
      updates, help articles, support tickets, and time-limited "view as" access that is
      logged and visible to the school.

8.6 AI help bot
Built last (phase 8), once screens are final.

      Knowledge base: help articles in the repo under /kb , one per screen and one per
      common job ("How do I assign a task to all class teachers?"), written for each role, in
      English, Hindi and Telugu. Claude Code writes these from the finished interface and
      keeps a checklist so no screen is left without an article.
      Articles are embedded for search. Schools can add their own SOP documents, visible
      only to their staff.
      Behaviour: answers from the knowledge base only, in the user's language, in
      numbered steps, limited to features the user's role and enabled modules allow. Each
      answer has a "Take me there" button that opens the right screen.
      Text and voice input.
      The bot explains and navigates. It does not change data in this build.
      If it cannot answer, it says so and offers to raise a support ticket to AutoEd support
      with the conversation attached.
      Thumbs up or down on every answer. Unanswered and poorly rated questions are
      listed in the super admin console to improve the articles.
      A floating help button on every screen opens the bot with that screen's context.

9. Data model, mobile app and non-functional requirements

9.1 Data model
Conventions for every table: id uuid primary key, org_id , branch_id (null for group-
level rows), created_at , created_by , updated_at , deleted_at (soft delete), RLS
enabled, indexes on org_id , branch_id and the main foreign keys. Reuse existing
CRM/ERP tables where the audit finds them.

  Area                                      Tables

  Tenancy and structure                     organizations , branches , academic_years ,
                                            terms , wings , classes , sections , subjects ,
                                            class_subjects , departments , rooms ,
                                            module_flags

  People and access                         staff , positions , roles , role_permissions ,
                                            staff_roles , reporting_lines ,
                                            assignment_rules , delegations , students
                                            (roster only)

  Configuration                             custom_fields , custom_field_values ,
                                            terminology , presets , config_history

  Tasks                                     tasks , task_assignees , task_recurrences ,
                                            task_comments , task_attachments ,
                                            task_events , escalation_rules ,
                                            task_categories

  Checklists                                checklist_templates , checklist_items ,
                                            checklist_runs , checklist_responses

  Timetable                                 bell_schedules , periods ,
                                            teacher_allocations , timetable_constraints ,
                                            timetable_versions , timetable_entries ,
                                            substitutions

  Attendance and leave                      staff_attendance , attendance_imports ,
                                            attendance_rules ,
                                            student_attendance_sessions ,
                                            student_attendance_marks , leave_types ,
                                            leave_balances , leave_requests

  Approvals                                 approval_types , approval_flows ,
                                            approval_steps , approval_requests ,
                                            approval_actions

  Curriculum and planning                   curriculum_boards , curriculum_subjects ,
                                            curriculum_units , curriculum_topics ,
                                            learning_outcomes , school_documents ,
                                            document_chunks (vector),
                                            lesson_plan_templates , annual_plans ,
                                            annual_plan_items , lesson_plans ,
                                            lesson_plan_versions , lesson_plan_reviews ,
                                            plan_submission_rules

  Area                                      Tables

  Class log                                 class_logs , homework , notebook_checks

  Exams                                     exams , exam_schedules , invigilation_duties ,
                                            seating_plans , paper_blueprints ,
                                            question_bank , question_papers ,
                                            paper_access_log

  Observation                               observation_rubrics , observations ,
                                            appraisal_cycles , appraisal_scores ,
                                            trainings

  Admin modules                             tickets , ticket_events , ticket_categories ,
                                            circulars , circular_receipts ,
                                            calendar_events , meetings , meeting_actions ,
                                            events , event_templates , duty_types ,
                                            duty_assignments , incidents ,
                                            compliance_items

  Platform                                  notifications , notification_rules ,
                                            notification_prefs , device_tokens ,
                                            message_usage , jobs , audit_log ,
                                            saved_reports , report_schedules

  AI                                        ai_generations , ai_credit_ledger , plans ,
                                            branch_subscriptions , kb_articles ,
                                            kb_chunks , bot_conversations , bot_feedback

Permission checks use one SQL function, has_permission(user, module, action,
target_row) , called from RLS policies and from the API, so both agree.

9.2 Mobile app (Android and iOS)
       One Expo codebase. Minimum Android 8, iOS 15. Must run smoothly on a 3 GB RAM
       Android phone.
       Bottom tabs: My Day, Tasks, Classes (attendance, class log, lesson plans), Inbox,
       More.
       Full on mobile: My Day, tasks, checklists, staff check-in, student attendance, class log,
       lesson plan view and generation, leave, approvals, substitution alerts, helpdesk,
       circulars, calendar, duty roster, incident entry, observation form, help bot, personal
       dashboard.
       Web only: setup wizard, org chart, permission matrix, timetable generation and
       editing, annual plan editing, question paper editing, report builder, super admin.

      Offline: tasks, checklists, student attendance and class log work without network.
      Changes queue in an outbox and sync when online, with a visible "pending sync"
      count. Conflict rule: a record already closed on the server wins; otherwise the latest
      edit wins and both versions are kept in the audit log.
      Push notifications open the exact item.
      Camera for proof photos (compressed before upload), microphone for voice notes,
      location only at check-in.
      App lock with fingerprint or face unlock, optional per branch.
      Language switch, large-text mode, and a simplified home screen for support staff
      showing only tasks and checklists with icons and voice.
      Release: app name "AutoEd OS", store listings, privacy policy page, data safety forms,
      and a test build through Expo before store submission.

9.3 Non-functional requirements

  Area                    Requirement

  Performance             Common screens load in under 2 seconds on 4G;
                          lists paginate; dashboards use pre-aggregated
                          tables refreshed by jobs; timetable generation for
                          60 sections finishes within 3 minutes

  Scale                   200 branches, 300 staff each, without redesign

  Security                RLS everywhere, permission function shared by
                          API and database, signed URLs, rate limits on login
                          and AI endpoints, session expiry, device list with
                          remote sign-out

  Audit                   All state changes in audit_log ; question paper
                          access separately logged

  Privacy                 Data stored in the Mumbai region. Collect the
                          minimum student data. No student names or
                          contact details sent to the AI provider. Check-in
                          selfies deleted after a configurable period (default
                          90 days). On contract end the school gets a full
                          export and deletion. Have the privacy policy and
                          school agreement reviewed by a lawyer against the
                          Digital Personal Data Protection Act, 2023 and its
                          rules, since student data is children's data

  Area                    Requirement

  Reliability             Daily backups with point-in-time recovery on the
                          paid Supabase plan; jobs are retried and
                          idempotent

  Accessibility           Readable contrast, large touch targets, screen-
                          reader labels

  Quality                 TypeScript strict mode, lint clean, unit and end-to-
                          end tests in CI, Sentry on web and mobile

  Translation             No untranslated strings in release; Hindi and Telugu
                          reviewed by native speakers before launch

10. Build phases, acceptance checks and open items
Build in this order. A phase is complete only when its checks pass, tests are green and
 docs/BUILD-LOG.md is updated.

  Phase                                     Scope                               Acceptance checks

  0. Audit and foundations                  Repo and database audit,            Seed runs clean; a user of
                                             docs/AUDIT.md , shared             org A cannot read any row of
                                            package, module flags,              org B (automated test on
                                            permission function, audit log,     every table); language
                                            jobs queue, translation layer,      switch works on the shell
                                            seed script, /os shell

  1. Organisation setup                     Tenancy, academic year, wings       A new school completes the
                                            to sections, subjects, staff, org   wizard with the sample Excel
                                            chart, positions, roles,            files; changing a role's
                                            permission matrix, assignment       permission takes effect
                                            rules, custom fields, presets,      immediately; presets load
                                            setup wizard, Excel imports         and reset

  Phase                                     Scope                              Acceptance checks

  2. Tasks, checklists,                     Sections 5.1, 5.2, 8.4; Expo app   Principal assigns to a
  notifications, mobile shell               with login, My Day, Tasks,         coordinator who delegates
                                            Inbox, offline outbox, push        to a teacher; proof and
                                                                               verification flow works; peer
                                                                               request needs acceptance;
                                                                               sudden task logged in two
                                                                               taps; escalation fires on
                                                                               schedule; recurring tasks
                                                                               skip holidays; a task
                                                                               completed offline syncs

  3. School day                             Timetable, substitution, staff     Timetable generates for the
                                            and student attendance, leave,     seed school with zero
                                            approvals, duty roster,            clashes; approved leave
                                            calendar                           produces ranked substitutes
                                                                               and notifies them; check-in
                                                                               refused outside the
                                                                               boundary; biometric file
                                                                               import merges; leave
                                                                               balance correct across
                                                                               accrual cases; unmarked
                                                                               attendance creates a
                                                                               reminder task

  4. Lesson planning                        Curriculum library with CBSE       A daily plan for a CBSE and a
                                            and Cambridge maps, school         Cambridge topic renders in
                                            uploads and search, template       the school template with
                                            editor, annual to daily plans,     timings equal to the period
                                            companions, review workflow,       length; a Hindi subject plan
                                            plan bank, coverage tracker,       is in Hindi; late plans appear
                                            class log                          in the compliance report;
                                                                               logging a class updates
                                                                               coverage

  5. Exams and appraisal                    Exam planning, invigilation,       Generated paper matches
                                            seating, blueprints, paper         its blueprint exactly on
                                            generator, question bank,          marks, types and chapter
                                            confidentiality, observation,      weight; a non-reviewer
                                            appraisal, training log            cannot open a paper before
                                                                               the exam date; every
                                                                               download is logged;
                                                                               scorecard reflects changed
                                                                               weights

  Phase                                     Scope                             Acceptance checks

  6. Admin modules                          Helpdesk, circulars, meetings,    A failed checklist item opens
                                            event planner, incident log,      a ticket routed to the right
                                            compliance tracker                owner; circular shows read
                                                                              and unread staff; meeting
                                                                              actions become tasks; an
                                                                              expiry reminder fires at 60,
                                                                              30 and 7 days

  7. Reports                                Dashboards, report catalogue,     Every dashboard number
                                            daily digest, report builder,     matches its drill-down list;
                                            weekly insights, ask-a-           digest sends at the set time;
                                            question                          a teacher asking a question
                                                                              cannot get another
                                                                              department's data; exports
                                                                              open correctly in Excel

  8. AI credits, super admin,               Plans, ledger, limits, top-ups,   Generation stops at 100%
  help bot                                  super admin console, help         credits and resumes after
                                            articles for every screen in      top-up; ledger total equals
                                            three languages, bot              sum of generations; bot
                                                                              answers the 30 most
                                                                              common jobs correctly in
                                                                              each language and refuses
                                                                              out-of-scope questions

  9. Hardening and release                  Full end-to-end suite,            All end-to-end flows pass on
                                            performance pass, security        web and mobile; no
                                            review, low-end Android test,     untranslated strings; no
                                            store assets and builds           critical errors in monitoring
                                                                              during a 3-day pilot with the
                                                                              seed school

10.1 End-to-end flows that must be automated
   1. School setup through the wizard to first login of a teacher.
   2. Assign → delegate → complete with photo proof → verify → appears in the task report.
   3. Teacher applies for leave → approval → substitutes assigned → substitute sees the
      period and cover plan.
   4. Generate, edit, submit, return, resubmit and approve a lesson plan → deliver →
      coverage updates.
   5. Mark student attendance offline → sync → daily summary correct.
   6. Create blueprint → generate paper → review → approve → restricted access verified.

   7. Checklist failure → ticket → resolve → close.
   8. Credits exhausted → blocked → top-up → unblocked.

10.2 Assumptions made in this PRD
      Marks, fees and payroll calculation stay outside AutoEd OS.
      The check-in selfie is proof only; there is no face matching.
      Absent alerts to parents are optional and use the CRM's WhatsApp adapter.
      The help bot explains and navigates but does not change data.
      Credit costs in section 8.5 are starting values, to be tuned against real AI cost in the
      first month.
      Hindi and Telugu are interface and help languages; lesson content language follows
      the subject.

10.3 Open items for Atif
      Plan tiers: price per branch or per staff member, and monthly credits in each tier.
      Who checks the preloaded CBSE and Cambridge maps for accuracy each year. They
      need a subject expert's review before schools rely on them; both boards revise their
      syllabus.
      Confirm the WhatsApp provider used by the CRM and submit the OS message
      templates for approval.
      Create Google Play, Apple Developer, Expo and Firebase accounts under the company
      name.
      Lawyer review of the privacy policy and school agreement.
      Native-speaker review of Hindi and Telugu text.
      A pilot school for phase 9, with one coordinator as the internal champion.
      Confirm with Claude Code what the current CRM repo already contains for
      organisations, staff and classes, so phase 0 reuses it.
```
