#!/usr/bin/env node
// Generates the core master-data migrations 20261115100002..7 from the spec below (docs/MAP-TABLES.md
// section B, owner decisions 27-54). The generated SQL is committed; re-run after changing the spec:
//
//   node scripts/gen-core-master.mjs            # writes supabase/migrations/20261115100002..7_core_master_*.sql
//   node scripts/gen-core-master.mjs --summary  # prints the table list used in docs/core-master-data.md
//
// Every table gets the R3 standard columns (id, org_id, [branch_id], created_at, created_by, updated_at,
// deleted_at), unique (org_id, id) so children can use composite foreign keys (no cross-org references),
// an index per foreign key starting with org_id, the updated_at trigger, grants, and RLS through
// app.apply_core_rls (20261115100001), which wraps app.apply_rls(..., 'core_master', ...).
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const q = (s) => `'${s}'`;
const inList = (...xs) => `in (${xs.map(q).join(',')})`;
const enumCol = (name, values, def, notNull = true) =>
  `${name} text${notNull ? ' not null' : ''}${def ? ` default '${def}'` : ''} check (${name} ${inList(...values)})`;

// Portal / self-service read predicates (OR-ed with the audience rule, see app.apply_core_rls).
const LEARNER = (col = 'student_id') => `${col} = any(app.my_learner_ids())`;
const OWN_STAFF = `staff_id = app.my_core_staff_id()`;

/*
 * Spec fields:
 *   branch   'null' (nullable branch_id, null = whole org) | 'req' (not null) | undefined (no branch_id)
 *   read     members | staff | permission | self   (audience of the select policy)
 *   product  owning writer product for core_master writes ('*' = any product the user holds)
 *   module   permission module for writes (and for read 'permission')
 *   extra    extra read predicate (OR) - portal / self-service rows
 *   guard    read predicate that must also hold (AND)
 *   cols     column definitions (standard columns are added)
 *   fks      [column, table, onDelete?]  composite (org_id, column) -> core.table(org_id, id|user_id)
 *   uniques  table constraints / extra checks
 *   indexes  extra index definitions "name on (cols) [where ...]" (org_id first)
 *   post     raw SQL run after RLS is applied (extra policies)
 */
const files = [];
const file = (name, title, tables, pre = '', post = '') => files.push({ name, title, tables, pre, post });

// ------------------------------------------------------------------------------------------- 2 structure
file('20261115100002_core_master_structure.sql', 'terminology, files, custom fields, years, terms, number series, wings, rooms, departments, positions, programmes, subjects', [
  {
    name: 'terminology', branch: 'null', read: 'members', module: 'setup',
    doc: 'Labels per org (and optionally branch) for neutral keys: programme, section, learner, guardian, staff, term, academic_year, subject, wing, period, admission. Defaults by organizations.kind come from app.default_term().',
    cols: [`key text not null check (key ~ '^[a-z][a-z0-9_.]*$')`, `locale text not null default 'en' check (locale ${inList('en', 'hi', 'te')})`, 'singular text not null', 'plural text'],
    uniques: ['unique nulls not distinct (org_id, branch_id, key, locale)'],
  },
  {
    name: 'files', branch: 'null', read: 'staff', module: 'files',
    doc: 'Index of every stored object (plan 4.7). storage_path always starts with "{org_id}/".',
    cols: [
      enumCol('bucket', ['core-files', 'crm-files', 'os-files', 'erp-files'], 'core-files'),
      'storage_path text not null', 'file_name text', 'mime text', 'size_bytes bigint check (size_bytes is null or size_bytes >= 0)',
      'sha256 text', 'owner_type text', 'owner_id uuid', 'product_key text references core.products(key)',
      'uploaded_by uuid default app.uid()', 'retention_until date',
    ],
    uniques: ['unique (bucket, storage_path)', `check (split_part(storage_path, '/', 1) = org_id::text)`],
    indexes: ['files_owner on (org_id, owner_type, owner_id)'],
  },
  {
    name: 'custom_fields', branch: 'null', read: 'members', module: 'setup',
    doc: 'Field definitions only; values live in the entity row\'s `custom` jsonb (OQ-12).',
    cols: [
      'product_key text references core.products(key)', `entity text not null check (entity ~ '^[a-z][a-z0-9_]*$')`,
      `key text not null check (key ~ '^[a-z][a-z0-9_]*$')`, 'label text not null', `label_i18n jsonb not null default '{}'`,
      enumCol('field_type', ['text', 'number', 'date', 'boolean', 'select', 'multiselect', 'phone', 'email', 'file'], 'text'),
      `options jsonb not null default '[]'`, 'required boolean not null default false', 'seq integer not null default 0', 'active boolean not null default true',
    ],
    uniques: ['unique nulls not distinct (org_id, branch_id, entity, key)'],
  },
  {
    name: 'academic_years', branch: 'null', read: 'members', module: 'setup',
    doc: 'branch_id null = whole org (OQ-3). One current year per (org, branch).',
    cols: ['name text not null', 'starts_on date not null', 'ends_on date not null', 'is_current boolean not null default false',
      enumCol('status', ['planning', 'active', 'closed'], 'planning'), 'seq integer not null default 0'],
    uniques: ['unique nulls not distinct (org_id, branch_id, name)', 'check (ends_on >= starts_on)'],
    indexes: [`academic_years_one_current on (org_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid)) where is_current and deleted_at is null` + '|unique'],
  },
  {
    name: 'terms', read: 'members', module: 'setup',
    cols: ['academic_year_id uuid not null', 'name text not null', 'seq integer not null default 0', 'starts_on date', 'ends_on date'],
    fks: [['academic_year_id', 'academic_years', 'cascade']],
    uniques: ['unique (org_id, academic_year_id, name)', 'check (ends_on is null or starts_on is null or ends_on >= starts_on)'],
  },
  {
    name: 'number_series', branch: 'null', read: 'staff', module: 'setup',
    doc: 'Document numbers (admission_no, employee_code, receipt, application_no, ticket...). Use core.next_number(key, branch, year).',
    cols: [`key text not null check (key ~ '^[a-z][a-z0-9_]*$')`, 'academic_year_id uuid', `prefix text not null default ''`, `suffix text not null default ''`,
      'padding integer not null default 4 check (padding between 1 and 12)', 'next_value bigint not null default 1 check (next_value > 0)',
      enumCol('reset_policy', ['never', 'yearly'], 'never'), 'product_key text references core.products(key)', 'active boolean not null default true'],
    fks: [['academic_year_id', 'academic_years']],
    uniques: ['unique nulls not distinct (org_id, branch_id, key, academic_year_id)'],
  },
  {
    name: 'wings', branch: 'null', read: 'members', module: 'setup',
    doc: 'Optional grouping of programmes (school wing, coaching division, college faculty).',
    cols: ['name text not null', 'board text', 'seq integer not null default 0',
      enumCol('student_attendance_mode', ['day', 'am_pm', 'period'], 'day'), 'homework_limit_minutes integer'],
    uniques: ['unique nulls not distinct (org_id, branch_id, name)'],
  },
  {
    name: 'rooms', branch: 'null', read: 'members', module: 'setup',
    doc: 'Rooms and facilities (O rooms + E facilities). kind is a free key (classroom, lab, hall, ground, office...).',
    cols: [`name text not null`, `kind text not null default 'classroom' check (kind ~ '^[a-z][a-z0-9_]*$')`, 'capacity integer check (capacity is null or capacity >= 0)',
      'bookable boolean not null default false', `qr_token text unique default replace(gen_random_uuid()::text, '-', '')`, 'active boolean not null default true'],
    uniques: ['unique nulls not distinct (org_id, branch_id, name)'],
  },
  {
    name: 'departments', branch: 'null', read: 'members', module: 'staff',
    cols: ['name text not null', 'head_staff_id uuid', 'active boolean not null default true'],
    uniques: ['unique nulls not distinct (org_id, branch_id, name)'],
  },
  {
    name: 'positions', read: 'members', module: 'staff',
    doc: 'Job positions; rank drives the assignment rule (decision 11).',
    cols: [`key text not null check (key ~ '^[a-z][a-z0-9_]*$')`, 'name text not null', 'rank integer not null default 100', 'is_teaching boolean not null default false', 'active boolean not null default true'],
    uniques: ['unique (org_id, key)'],
  },
  {
    name: 'programmes', branch: 'null', read: 'members', module: 'setup',
    doc: 'Neutral "class / course / year of study" (decision 28; OS classes, ERP/CRM programmes).',
    cols: ['wing_id uuid', 'name text not null', 'board text', 'stage text', 'stream text', 'level integer', 'seq integer not null default 0',
      'capacity integer check (capacity is null or capacity >= 0)', 'next_programme_id uuid', 'active boolean not null default true'],
    fks: [['wing_id', 'wings'], ['next_programme_id', 'programmes']],
    uniques: ['unique nulls not distinct (org_id, branch_id, name, board)'],
  },
  {
    name: 'subjects', branch: 'null', read: 'members', module: 'setup',
    cols: ['name text not null', 'code text', `type text check (type is null or type ${inList('scholastic', 'co_scholastic', 'language', 'elective', 'activity')})`,
      'department_id uuid', 'content_language text', 'is_core boolean not null default true', 'color text', 'active boolean not null default true'],
    fks: [['department_id', 'departments']],
    indexes: ['subjects_code on (org_id, code) where code is not null and deleted_at is null|unique'],
  },
  {
    name: 'programme_subjects', read: 'members', module: 'setup',
    cols: ['programme_id uuid not null', 'subject_id uuid not null', 'periods_per_week integer check (periods_per_week is null or periods_per_week >= 0)',
      'double_periods integer not null default 0', 'room_type text'],
    fks: [['programme_id', 'programmes', 'cascade'], ['subject_id', 'subjects', 'cascade']],
    uniques: ['unique (org_id, programme_id, subject_id)'],
  },
], '', `
-- Organisation branding / logo for the parent app (decision 46) now that core.files exists.
alter table core.organizations add column logo_file_id uuid,
  add constraint organizations_logo_file_fk foreign key (org_id, logo_file_id) references core.files(org_id, id);
`);

// ------------------------------------------------------------------------------------------- 3 people
const GENDER = (n = 'gender') => `${n} text check (${n} is null or ${n} ${inList('female', 'male', 'other')})`;
const STUDENT_STATUS = ['admitted', 'active', 'suspended', 'withdrawn', 'transferred', 'alumni', 'archived'];
file('20261115100003_core_master_people.sql', 'staff, sections, households, guardians, students (+ restricted sensitive data), enrolments, status events', [
  {
    name: 'staff', branch: 'null', read: 'staff', module: 'staff',
    doc: 'Staff base (decision 39: OS is the source; ERP payroll/HR in erp.staff_payroll / erp.staff_hr_profiles). branch_id = home branch. One login = one staff row = one org (decision 37).',
    cols: [
      'user_id uuid unique', 'employee_code text', 'first_name text not null', 'last_name text',
      `full_name text generated always as (btrim(first_name || coalesce(' ' || last_name, ''))) stored`,
      'email text', 'phone text', GENDER(), 'dob date', 'photo_file_id uuid', 'position_id uuid', 'department_id uuid', 'wing_id uuid', 'reports_to uuid',
      enumCol('language', ['en', 'hi', 'te'], 'en'), enumCol('status', ['invited', 'active', 'on_notice', 'inactive', 'left'], 'active'),
      'joined_on date', 'left_on date',
      enumCol('staff_type', ['teaching', 'non_teaching', 'admin', 'support', 'driver', 'attendant'], 'teaching'),
      `is_teaching boolean generated always as (staff_type = 'teaching') stored`,
      'is_part_time boolean not null default false', 'max_periods_day integer', 'max_periods_week integer',
      `unavailable jsonb not null default '[]'`, `ui_prefs jsonb not null default '{}'`, `custom jsonb not null default '{}'`,
    ],
    fks: [['user_id', '@org_users'], ['photo_file_id', 'files'], ['position_id', 'positions'], ['department_id', 'departments'], ['wing_id', 'wings'], ['reports_to', 'staff']],
    indexes: ['staff_employee_code on (org_id, employee_code) where employee_code is not null and deleted_at is null|unique', 'staff_name on (org_id, full_name)'],
  },
  {
    name: 'sections', read: 'members', module: 'setup',
    doc: 'Neutral "section / batch / division" teaching group of a programme for a year.',
    cols: ['programme_id uuid not null', 'academic_year_id uuid', 'name text not null', 'class_teacher_id uuid', 'room_id uuid',
      'capacity integer check (capacity is null or capacity >= 0)', 'strength integer not null default 0', `profile jsonb not null default '{}'`, 'seq integer not null default 0'],
    fks: [['programme_id', 'programmes', 'cascade'], ['academic_year_id', 'academic_years'], ['class_teacher_id', 'staff'], ['room_id', 'rooms']],
    uniques: ['unique nulls not distinct (org_id, programme_id, academic_year_id, name)'],
  },
  {
    name: 'households', read: 'staff', module: 'students', extra: 'id = any(app.my_household_ids())',
    doc: 'Post-admission families (CRM families stay in crm until core.admit_student, OQ-4).',
    cols: ['family_name text', 'address text', 'city text', 'pincode text', 'locality text', 'phone text', 'email text', 'notes text', 'home_language text', `custom jsonb not null default '{}'`],
  },
  {
    name: 'guardians', read: 'staff', module: 'students', extra: 'household_id = any(app.my_household_ids()) or user_id = app.uid()',
    doc: 'Guardians of a household; user_id = portal login (ERP portal, decision 30). Phone unique per org.',
    cols: ['household_id uuid not null', 'name text not null', enumCol('relation', ['father', 'mother', 'guardian', 'other'], 'guardian'),
      'phone text', 'alt_phone text', 'email text', 'occupation text', 'qualification text', 'authorised_pickup boolean not null default false',
      'photo_file_id uuid', 'is_primary boolean not null default false', enumCol('language', ['en', 'hi', 'te'], 'en'), 'user_id uuid unique'],
    fks: [['household_id', 'households', 'cascade'], ['photo_file_id', 'files'], ['user_id', '@org_users']],
    indexes: ['guardians_phone on (org_id, phone) where phone is not null and deleted_at is null|unique'],
  },
  {
    name: 'students', branch: 'req', read: 'staff', module: 'students', extra: LEARNER('id'),
    doc: 'Learners. Created at status admitted (CRM core.admit_student, decision 38) or directly by ERP/OS. status changes only through core.change_student_status().',
    cols: [
      'household_id uuid', 'admission_no text', 'first_name text not null', 'last_name text',
      `full_name text generated always as (btrim(first_name || coalesce(' ' || last_name, ''))) stored`,
      'dob date', GENDER(), enumCol('status', STUDENT_STATUS, 'admitted'),
      'programme_id uuid', 'section_id uuid', 'roll_no text', 'house text', 'mother_tongue text', 'nationality text', 'apaar_id text', 'pen text',
      'rte_quota boolean not null default false', 'is_new boolean not null default true', 'joined_on date', 'left_on date', 'previous_school text',
      'photo_file_id uuid', 'user_id uuid unique', 'crm_prospect_id uuid', `custom jsonb not null default '{}'`,
    ],
    fks: [['household_id', 'households'], ['programme_id', 'programmes'], ['section_id', 'sections'], ['photo_file_id', 'files'], ['user_id', '@org_users']],
    uniques: [`check (admission_no is not null or status ${inList('admitted', 'archived')})`],
    indexes: ['students_admission_no on (org_id, branch_id, admission_no) where admission_no is not null and deleted_at is null|unique',
      'students_name on (org_id, full_name)', 'students_crm_prospect on (org_id, crm_prospect_id) where crm_prospect_id is not null'],
  },
  {
    name: 'student_sensitive', read: 'permission', module: 'student_sensitive', extra: LEARNER(),
    doc: 'RESTRICTED 1:1 health and category data. Staff need student_sensitive.view; guardians see their own learners only.',
    cols: ['student_id uuid not null', 'blood_group text', 'allergies text', 'medical_conditions text', 'medications text', 'disability text', 'special_needs text',
      `social_category text check (social_category is null or social_category ${inList('general', 'obc', 'sc', 'st', 'ews', 'other')})`,
      'religion text', 'caste text', 'emergency_notes text'],
    fks: [['student_id', 'students', 'cascade']],
    uniques: ['unique (org_id, student_id)'],
  },
  {
    name: 'enrolments', read: 'staff', product: 'erp', module: 'students', extra: LEARNER(),
    doc: 'Year-wise placement history (ERP writes, OS reads).',
    cols: ['student_id uuid not null', 'academic_year_id uuid not null', 'programme_id uuid', 'section_id uuid', 'roll_no text',
      enumCol('status', ['active', 'promoted', 'detained', 'left', 'transferred'], 'active'), 'start_date date', 'end_date date', 'result text'],
    fks: [['student_id', 'students', 'cascade'], ['academic_year_id', 'academic_years'], ['programme_id', 'programmes'], ['section_id', 'sections']],
    uniques: ['unique (org_id, student_id, academic_year_id)'],
  },
  {
    name: 'student_status_events', read: 'staff', module: 'students', extra: LEARNER(),
    doc: 'Written by core.change_student_status().',
    cols: ['student_id uuid not null', 'from_status text', `to_status text not null check (to_status ${inList(...STUDENT_STATUS)})`, 'reason text',
      'effective_date date not null default current_date', 'actor_user_id uuid default app.uid()', 'actor_name text'],
    fks: [['student_id', 'students', 'cascade']],
  },
], '', `
alter table core.departments add constraint departments_head_staff_fk foreign key (org_id, head_staff_id) references core.staff(org_id, id);
create index departments_head_staff_id on core.departments(org_id, head_staff_id);

-- Portal links now point at real learners (20261115000002 left this for the master table).
alter table core.learner_links add constraint learner_links_learner_fk foreign key (org_id, learner_id) references core.students(org_id, id) on delete cascade;
create index learner_links_learner on core.learner_links(org_id, learner_id);
`);

// ------------------------------------------------------------------------------------------- 4 approvals
const APPROVAL_STATUS = ['pending', 'approved', 'rejected', 'returned', 'cancelled'];
file('20261115100004_core_master_approvals.sql', 'one approval engine for all products (B.12) and delegations', [
  {
    name: 'approval_types', read: 'staff', module: 'approvals',
    cols: [`key text not null check (key ~ '^[a-z][a-z0-9_]*$')`, 'name text not null', `name_i18n jsonb not null default '{}'`,
      'product_key text not null references core.products(key)', `form_schema jsonb not null default '{}'`, 'task_template jsonb',
      'is_system boolean not null default false', 'active boolean not null default true'],
    uniques: ['unique (org_id, key)'],
  },
  {
    name: 'approval_flows', branch: 'null', read: 'staff', module: 'approvals',
    cols: ['approval_type_id uuid not null', 'applicant_role_key text', 'name text not null', 'min_amount numeric(14,2)', 'max_amount numeric(14,2)', 'active boolean not null default true'],
    fks: [['approval_type_id', 'approval_types', 'cascade']],
  },
  {
    name: 'approval_steps', read: 'staff', module: 'approvals',
    cols: ['flow_id uuid not null', 'seq integer not null check (seq > 0)', enumCol('approver_kind', ['role', 'manager_of_applicant', 'staff'], 'role'),
      'approver_role_key text', 'approver_staff_id uuid', 'condition jsonb', 'parallel_group integer', 'time_limit_hours integer check (time_limit_hours is null or time_limit_hours > 0)'],
    fks: [['flow_id', 'approval_flows', 'cascade'], ['approver_staff_id', 'staff']],
    uniques: [`check ((approver_kind = 'role') = (approver_role_key is not null))`, `check (approver_kind <> 'staff' or approver_staff_id is not null)`],
  },
  {
    name: 'approval_requests', branch: 'null', read: 'permission', module: 'approvals',
    extra: 'applicant_user_id = app.uid() or app.my_core_staff_id() = any(pending_approver_ids) or student_id = any(app.my_learner_ids())',
    doc: 'Requests of every product (product_key). Applicants (staff or guardians) insert their own; side effects run in the owning product on approval_decided.',
    cols: ['approval_type_id uuid not null', 'flow_id uuid', 'product_key text not null references core.products(key)',
      'applicant_user_id uuid default app.uid()', 'applicant_staff_id uuid', 'requested_by_name text', 'title text not null', 'summary text', 'impact text',
      `data jsonb not null default '{}'`, 'amount numeric(14,2)', 'student_id uuid', enumCol('status', APPROVAL_STATUS, 'pending'),
      'current_seq integer not null default 1', `pending_approver_ids uuid[] not null default '{}'`, 'step_due_at timestamptz',
      'linked_type text', 'linked_id uuid', 'decided_at timestamptz'],
    fks: [['approval_type_id', 'approval_types'], ['flow_id', 'approval_flows'], ['applicant_staff_id', 'staff'], ['student_id', 'students']],
    indexes: ['approval_requests_status on (org_id, status, step_due_at)', 'approval_requests_linked on (org_id, linked_type, linked_id)',
      'approval_requests_applicant on (org_id, applicant_user_id)'],
    post: [`create policy ins_self on core.approval_requests for insert with check (
  org_id = app.current_org_id() and app.user_has_any_product(org_id) and applicant_user_id = app.uid() and status = 'pending'
  and (student_id is null or app.my_member_kind() in ('staff','support') or student_id = any(app.my_learner_ids())));`],
  },
  {
    name: 'approval_actions', read: 'permission', module: 'approvals',
    extra: 'exists (select 1 from core.approval_requests r where r.org_id = approval_actions.org_id and r.id = approval_actions.request_id)',
    cols: ['request_id uuid not null', 'step_seq integer', 'actor_user_id uuid default app.uid()', 'actor_staff_id uuid', 'actor_name text',
      enumCol('action', ['submit', 'approve', 'reject', 'return', 'forward', 'escalate', 'resubmit', 'cancel']), 'comment text', 'forwarded_to uuid'],
    fks: [['request_id', 'approval_requests', 'cascade'], ['actor_staff_id', 'staff'], ['forwarded_to', 'staff']],
    post: [`create policy ins_self on core.approval_actions for insert with check (
  org_id = app.current_org_id() and app.user_has_any_product(org_id) and actor_user_id = app.uid()
  and exists (select 1 from core.approval_requests r where r.org_id = approval_actions.org_id and r.id = approval_actions.request_id));`],
  },
  {
    name: 'delegations', read: 'staff', module: 'approvals',
    cols: ['staff_id uuid not null', 'delegate_id uuid not null', 'starts_on date not null', 'ends_on date not null', 'reason text'],
    fks: [['staff_id', 'staff', 'cascade'], ['delegate_id', 'staff', 'cascade']],
    uniques: ['check (ends_on >= starts_on)', 'check (staff_id <> delegate_id)'],
  },
]);

// ------------------------------------------------------------------------------------------- 5 calendar, timetable, exams, posts
file('20261115100005_core_master_calendar_timetable.sql', 'calendar, events, bell schedules, timetable, exams, question bank, class posts', [
  {
    name: 'calendar_events', branch: 'null', read: 'staff', module: 'calendar', extra: `audience ${inList('families', 'all')}`,
    cols: [enumCol('layer', ['holiday', 'exam', 'event', 'ptm', 'staff_meeting', 'training', 'deadline', 'activity'], 'event'),
      'title text not null', 'description text', 'starts_on date not null', 'ends_on date', 'starts_at timestamptz', 'ends_at timestamptz',
      'is_working_day boolean not null default true', enumCol('audience', ['staff', 'families', 'all'], 'all'),
      `programme_ids uuid[] not null default '{}'`, 'linked_type text', 'linked_id uuid'],
    uniques: ['check (ends_on is null or ends_on >= starts_on)'],
    indexes: ['calendar_events_dates on (org_id, starts_on)'],
  },
  {
    name: 'events', branch: 'null', read: 'members', module: 'events',
    doc: 'Shared event row (OQ-9); OS planning fields live in os.event_plans.',
    cols: ['name text not null', enumCol('type', ['event', 'competition', 'trip', 'fundraiser', 'alumni'], 'event'), 'event_date date', 'venue text', 'description text',
      'owner_staff_id uuid', enumCol('status', ['planning', 'ready', 'held', 'reviewed', 'cancelled'], 'planning'),
      'registration_open boolean not null default false', 'fee numeric(12,2)', 'consent_required boolean not null default false', 'max_participants integer'],
    fks: [['owner_staff_id', 'staff']],
  },
  {
    name: 'bell_schedules', branch: 'null', read: 'members', module: 'timetable',
    cols: ['wing_id uuid', 'name text not null', `days integer[] not null default '{1,2,3,4,5}'`, 'active boolean not null default true'],
    fks: [['wing_id', 'wings']],
  },
  {
    name: 'periods', read: 'members', module: 'timetable',
    cols: ['bell_schedule_id uuid not null', 'seq integer not null', 'label text not null', enumCol('kind', ['period', 'break', 'assembly'], 'period'),
      'starts_at time not null', 'ends_at time not null', 'teaching_index integer'],
    fks: [['bell_schedule_id', 'bell_schedules', 'cascade']],
    uniques: ['unique (org_id, bell_schedule_id, seq)', 'check (ends_at > starts_at)'],
  },
  {
    name: 'teacher_allocations', read: 'staff', module: 'timetable',
    cols: ['academic_year_id uuid', 'staff_id uuid not null', 'section_id uuid not null', 'subject_id uuid not null', 'periods_per_week integer',
      'double_periods integer not null default 0', 'co_teacher_id uuid', 'group_key text', 'combined_key text', 'room_type text'],
    fks: [['academic_year_id', 'academic_years'], ['staff_id', 'staff', 'cascade'], ['section_id', 'sections', 'cascade'], ['subject_id', 'subjects', 'cascade'], ['co_teacher_id', 'staff']],
  },
  {
    name: 'timetable_versions', branch: 'null', read: 'members', module: 'timetable',
    doc: 'OS versions + effective_to (OQ-10). job_id points at private.jobs without a foreign key (R7).',
    cols: ['academic_year_id uuid', 'name text not null', enumCol('status', ['draft', 'generating', 'published', 'archived'], 'draft'),
      'effective_from date', 'effective_to date', 'generated_at timestamptz', `unplaced jsonb not null default '[]'`, 'score numeric', 'job_id uuid', 'based_on_version_id uuid'],
    fks: [['academic_year_id', 'academic_years'], ['based_on_version_id', 'timetable_versions']],
    uniques: ['check (effective_to is null or effective_from is null or effective_to >= effective_from)'],
  },
  {
    name: 'timetable_entries', read: 'members', module: 'timetable',
    cols: ['version_id uuid not null', 'day smallint not null check (day between 1 and 7)', 'period_seq integer not null', 'section_id uuid', 'subject_id uuid',
      'staff_id uuid', 'room_id uuid', 'locked boolean not null default false', 'group_key text', 'fixed_label text'],
    fks: [['version_id', 'timetable_versions', 'cascade'], ['section_id', 'sections', 'cascade'], ['subject_id', 'subjects'], ['staff_id', 'staff'], ['room_id', 'rooms']],
  },
  {
    name: 'exam_types', read: 'members', module: 'exams',
    cols: [`key text not null check (key ~ '^[a-z][a-z0-9_]*$')`, 'name text not null', 'weight numeric(6,2)', 'seq integer not null default 0'],
    uniques: ['unique (org_id, key)'],
  },
  {
    name: 'exams', branch: 'null', read: 'members', module: 'exams',
    cols: ['academic_year_id uuid', 'term_id uuid', 'exam_type_id uuid', 'name text not null',
      enumCol('status', ['planning', 'scheduled', 'in_progress', 'completed'], 'planning'), 'starts_on date', 'ends_on date', `programme_ids uuid[] not null default '{}'`],
    fks: [['academic_year_id', 'academic_years'], ['term_id', 'terms'], ['exam_type_id', 'exam_types']],
  },
  {
    name: 'exam_schedules', read: 'members', module: 'exams',
    cols: ['exam_id uuid not null', 'programme_id uuid', 'section_id uuid', 'subject_id uuid not null', 'exam_date date', 'starts_at time', 'ends_at time',
      'max_marks numeric(8,2)', 'pass_marks numeric(8,2)', 'room_id uuid'],
    fks: [['exam_id', 'exams', 'cascade'], ['programme_id', 'programmes'], ['section_id', 'sections'], ['subject_id', 'subjects'], ['room_id', 'rooms']],
  },
  {
    name: 'exam_seating', read: 'staff', module: 'exams', extra: LEARNER(),
    cols: ['exam_schedule_id uuid not null', 'student_id uuid not null', 'room_id uuid', 'seat_no text', 'hall_ticket_no text'],
    fks: [['exam_schedule_id', 'exam_schedules', 'cascade'], ['student_id', 'students', 'cascade'], ['room_id', 'rooms']],
    uniques: ['unique (org_id, exam_schedule_id, student_id)'],
  },
  {
    name: 'question_bank', read: 'staff', module: 'exams',
    cols: ['subject_id uuid', 'programme_id uuid', 'content jsonb not null', `difficulty text check (difficulty is null or difficulty ${inList('easy', 'medium', 'hard')})`,
      'bloom text', 'marks numeric(8,2)', enumCol('source', ['manual', 'ai', 'paper'], 'manual'), enumCol('status', ['draft', 'approved', 'archived'], 'draft')],
    fks: [['subject_id', 'subjects'], ['programme_id', 'programmes']],
  },
  {
    name: 'class_posts', read: 'staff', module: 'class_posts',
    extra: `status = 'published' and (student_id = any(app.my_learner_ids()) or (student_id is null and section_id = any(app.my_learner_section_ids())))`,
    doc: 'Homework / classwork / notes for a section or one learner (ERP posts + OS homework).',
    cols: [enumCol('type', ['homework', 'classwork', 'note', 'circular', 'resource', 'diary'], 'homework'), 'section_id uuid', 'linked_type text', 'linked_id uuid',
      'student_id uuid', 'subject_id uuid', 'staff_id uuid', 'title text not null', 'body text', 'attachment_file_id uuid', 'due_date date', 'est_minutes integer',
      enumCol('status', ['draft', 'pending', 'published', 'rejected'], 'draft'), 'allow_submission boolean not null default false', 'max_marks numeric(8,2)', 'published_at timestamptz'],
    fks: [['section_id', 'sections', 'cascade'], ['student_id', 'students', 'cascade'], ['subject_id', 'subjects'], ['staff_id', 'staff'], ['attachment_file_id', 'files']],
  },
]);

// ------------------------------------------------------------------------------------------- 6 attendance and leave
const HALF = enumCol('half_day', ['none', 'first', 'second'], 'none');
file('20261115100006_core_master_attendance_leave.sql', 'attendance rules, devices, imports, staff attendance, leave, student attendance', [
  {
    name: 'attendance_rules', branch: 'null', read: 'staff', module: 'staff_attendance',
    cols: [enumCol('applies_to', ['staff', 'student'], 'staff'), 'position_id uuid', 'grace_minutes integer not null default 10',
      'half_day_after_minutes integer not null default 120', 'student_cutoff time', 'edit_window_hours integer', `settings jsonb not null default '{}'`],
    fks: [['position_id', 'positions']],
  },
  {
    name: 'devices', branch: 'null', read: 'staff', module: 'staff_attendance',
    cols: [enumCol('kind', ['biometric', 'rfid', 'face', 'tablet', 'gps_beacon', 'other'], 'other'), 'name text not null', 'serial_no text', 'location_text text',
      'room_id uuid', 'active boolean not null default true', 'last_seen_at timestamptz'],
    fks: [['room_id', 'rooms']],
  },
  {
    name: 'attendance_imports', branch: 'null', read: 'staff', module: 'staff_attendance',
    cols: [enumCol('kind', ['staff', 'student'], 'staff'), 'source text', 'file_id uuid', enumCol('status', ['pending', 'processing', 'done', 'failed'], 'pending'),
      'row_count integer', 'error_count integer', `summary jsonb not null default '{}'`],
    fks: [['file_id', 'files']],
  },
  {
    name: 'staff_attendance', branch: 'null', read: 'permission', product: 'os', module: 'staff_attendance', extra: OWN_STAFF,
    doc: 'Writer OS; ERP reads for payroll LOP. ERP regularisations are approvals of type attendance_regularisation (regularisation_request_id).',
    cols: ['staff_id uuid not null', 'date date not null', 'check_in_at timestamptz', 'check_out_at timestamptz', 'check_in_lat numeric(9,6)', 'check_in_lng numeric(9,6)',
      'check_in_distance_m integer', 'selfie_file_id uuid',
      enumCol('source', ['app', 'biometric', 'rfid', 'face', 'merged', 'manual', 'regularised', 'import'], 'app'),
      enumCol('status', ['present', 'late', 'half_day', 'absent', 'on_leave', 'holiday'], 'present'),
      'late_minutes integer not null default 0', 'early_exit boolean not null default false', 'conflict boolean not null default false',
      'import_id uuid', 'device_id uuid', 'regularisation_request_id uuid', 'note text'],
    fks: [['staff_id', 'staff', 'cascade'], ['selfie_file_id', 'files'], ['import_id', 'attendance_imports'], ['device_id', 'devices'], ['regularisation_request_id', 'approval_requests']],
    uniques: ['unique (org_id, staff_id, date)'],
    indexes: ['staff_attendance_date on (org_id, date)'],
  },
  {
    name: 'leave_types', read: 'members', module: 'leave',
    cols: [`key text not null check (key ~ '^[a-z][a-z0-9_]*$')`, 'name text not null', `name_i18n jsonb not null default '{}'`,
      enumCol('applies_to', ['staff', 'student'], 'staff'), enumCol('unit', ['day', 'hour'], 'day'), enumCol('accrual', ['none', 'monthly', 'yearly'], 'yearly'),
      'carry_forward_max numeric(6,2)', 'half_day_allowed boolean not null default true', 'notice_days integer not null default 0', 'doc_required_after_days integer',
      'sandwich_rule boolean not null default false', 'yearly_quota numeric(6,2)', 'carry_forward boolean not null default false', 'paid boolean not null default true',
      'active boolean not null default true', 'encashable boolean not null default false'],
    uniques: ['unique (org_id, key)'],
  },
  {
    name: 'leave_requests', branch: 'null', read: 'permission', product: 'os', module: 'leave', extra: OWN_STAFF,
    doc: 'Staff leave (OS writes; staff apply for themselves through ins_self).',
    cols: ['staff_id uuid not null', 'leave_type_id uuid not null', 'start_date date not null', 'end_date date not null', HALF, 'hours numeric(6,2)', 'days numeric(6,2)',
      'reason text', 'attachment_file_id uuid', 'handover_note text', enumCol('status', APPROVAL_STATUS, 'pending'), 'approval_request_id uuid', 'parent_request_id uuid', 'decided_at timestamptz'],
    fks: [['staff_id', 'staff', 'cascade'], ['leave_type_id', 'leave_types'], ['attachment_file_id', 'files'], ['approval_request_id', 'approval_requests'], ['parent_request_id', 'leave_requests']],
    uniques: ['check (end_date >= start_date)'],
    post: [`create policy ins_self on core.leave_requests for insert with check (
  org_id = app.current_org_id() and app.user_has_product(org_id, 'os') and staff_id = app.my_core_staff_id() and status = 'pending');`],
  },
  {
    name: 'student_leave_requests', read: 'staff', product: 'erp', module: 'leave', extra: LEARNER(),
    doc: 'New (OQ-8): guardian-applied learner leave (ERP portal); approved rows pre-mark on_leave.',
    cols: ['student_id uuid not null', 'leave_type_id uuid', 'start_date date not null', 'end_date date not null', HALF, 'days numeric(6,2)', 'reason text',
      'attachment_file_id uuid', enumCol('status', ['pending', 'approved', 'rejected', 'cancelled'], 'pending'), 'requested_by_user_id uuid default app.uid()',
      'decided_by uuid', 'decided_at timestamptz', 'approval_request_id uuid'],
    fks: [['student_id', 'students', 'cascade'], ['leave_type_id', 'leave_types'], ['attachment_file_id', 'files'], ['decided_by', 'staff'], ['approval_request_id', 'approval_requests']],
    uniques: ['check (end_date >= start_date)'],
    post: [`create policy ins_portal on core.student_leave_requests for insert with check (
  org_id = app.current_org_id() and app.user_has_any_product(org_id) and requested_by_user_id = app.uid()
  and student_id = any(app.my_learner_ids()) and status = 'pending');`],
  },
  {
    name: 'leave_balances', read: 'permission', product: 'os', module: 'leave', extra: OWN_STAFF,
    cols: ['staff_id uuid not null', 'leave_type_id uuid not null', 'academic_year_id uuid not null', 'opening numeric(6,2) not null default 0',
      'carried_forward numeric(6,2) not null default 0', 'adjusted numeric(6,2) not null default 0'],
    fks: [['staff_id', 'staff', 'cascade'], ['leave_type_id', 'leave_types'], ['academic_year_id', 'academic_years']],
    uniques: ['unique (org_id, staff_id, leave_type_id, academic_year_id)'],
  },
  {
    name: 'student_attendance_sessions', read: 'staff', module: 'student_attendance',
    doc: 'One marking session per section, date and session_key (day | am | pm | p<seq>). OS teacher screen and ERP both write (OQ-7).',
    cols: ['section_id uuid not null', 'date date not null', `session_key text not null default 'day' check (session_key ~ '^(day|am|pm|p[0-9]+)$')`,
      'marked_by_staff_id uuid', 'marked_by_name text', enumCol('status', ['draft', 'submitted'], 'draft'), 'submitted_at timestamptz', 'edit_reason text',
      'edit_approval_request_id uuid', 'client_id text'],
    fks: [['section_id', 'sections', 'cascade'], ['marked_by_staff_id', 'staff'], ['edit_approval_request_id', 'approval_requests']],
    uniques: ['unique (org_id, section_id, date, session_key)'],
  },
  {
    name: 'student_attendance_marks', read: 'staff', module: 'student_attendance', extra: LEARNER(),
    cols: ['session_id uuid', 'student_id uuid not null', 'date date not null', `session_key text not null default 'day' check (session_key ~ '^(day|am|pm|p[0-9]+)$')`,
      enumCol('status', ['present', 'absent', 'late', 'half_day', 'on_leave', 'on_duty']),
      enumCol('source', ['teacher', 'biometric', 'rfid', 'face', 'bus', 'hostel', 'mobile', 'import'], 'teacher'),
      'note text', 'check_in_at timestamptz', 'check_out_at timestamptz', 'student_leave_request_id uuid'],
    fks: [['session_id', 'student_attendance_sessions', 'cascade'], ['student_id', 'students', 'cascade'], ['student_leave_request_id', 'student_leave_requests']],
    uniques: ['unique (org_id, student_id, date, session_key)'],
    indexes: ['student_attendance_marks_date on (org_id, date)'],
  },
]);

// ------------------------------------------------------------------------------------------- 7 comms, helpdesk, compliance
const PRIORITY = enumCol('priority', ['low', 'normal', 'high', 'urgent'], 'normal');
const SELF_ALL = (t) => `create policy self_all on core.${t} for all
  using (org_id = app.current_org_id() and app.user_has_any_product(org_id) and user_id = app.uid())
  with check (org_id = app.current_org_id() and app.user_has_any_product(org_id) and user_id = app.uid());`;
file('20261115100007_core_master_comms_helpdesk_compliance.sql', 'notifications, templates, outbox, integrations, helpdesk, incidents, consents, data requests', [
  {
    name: 'message_templates', branch: 'null', read: 'staff', module: 'notifications',
    cols: ['product_key text not null references core.products(key)', 'event_key text', 'name text not null',
      enumCol('channel', ['app', 'whatsapp', 'sms', 'email', 'voice', 'push']), enumCol('language', ['en', 'hi', 'te'], 'en'), 'category text', 'body text not null',
      'enabled boolean not null default true', enumCol('status', ['draft', 'submitted', 'approved', 'rejected', 'paused'], 'draft'), 'dlt_template_id text',
      'provider_template_name text', 'provider_status text', `provider_vars jsonb not null default '[]'`, 'provider_reason text'],
  },
  {
    name: 'notification_rules', branch: 'null', read: 'staff', module: 'notifications',
    cols: ['product_key text not null references core.products(key)', 'event_key text not null', enumCol('audience', ['staff', 'family', 'student'], 'staff'),
      `role_keys text[] not null default '{}'`, `channels text[] not null default '{app}'`, 'template_id uuid', 'active boolean not null default true', `settings jsonb not null default '{}'`],
    fks: [['template_id', 'message_templates']],
  },
  {
    name: 'notifications', read: 'self', module: 'notifications',
    doc: 'In-app notifications; user_id required (parents have no staff row, OQ-13). A user reads and marks read only their own.',
    cols: ['user_id uuid not null', 'staff_id uuid', 'product_key text references core.products(key)', 'event_key text not null', 'title text not null', 'body text', 'link text',
      `data jsonb not null default '{}'`, PRIORITY, `channels text[] not null default '{app}'`, 'deliver_after timestamptz', 'push_status text', 'whatsapp_status text',
      'read_at timestamptz', 'dedupe_key text'],
    fks: [['user_id', '@org_users_cascade'], ['staff_id', 'staff']],
    uniques: ['unique (org_id, user_id, dedupe_key)'],
    indexes: ['notifications_inbox on (org_id, user_id, created_at desc)'],
    post: [`create policy upd_self on core.notifications for update
  using (org_id = app.current_org_id() and user_id = app.uid()) with check (org_id = app.current_org_id() and user_id = app.uid());`],
  },
  {
    name: 'notification_prefs', read: 'self', module: 'notifications',
    cols: ['user_id uuid not null', 'event_key text not null', 'channel text', 'muted boolean not null default true'],
    fks: [['user_id', '@org_users_cascade']],
    uniques: ['unique nulls not distinct (org_id, user_id, event_key, channel)'],
    post: [SELF_ALL('notification_prefs')],
  },
  {
    name: 'outbox', branch: 'null', read: 'permission', module: 'notifications',
    doc: 'Outgoing messages of every channel; sent by the job runner (security definer functions).',
    cols: ['product_key text not null references core.products(key)', enumCol('channel', ['app', 'whatsapp', 'sms', 'email', 'voice', 'push']), 'to_address text not null',
      'event_key text', 'template_id uuid', 'body text', enumCol('status', ['queued', 'sent', 'delivered', 'read', 'failed', 'skipped'], 'queued'), 'provider text',
      'provider_ref text', 'units integer not null default 1', 'cost numeric(12,4)', 'student_id uuid', 'guardian_id uuid', 'notification_id uuid', 'dedupe_key text',
      'send_after timestamptz not null default now()', 'sent_at timestamptz', 'delivered_at timestamptz', 'error text'],
    fks: [['template_id', 'message_templates'], ['student_id', 'students'], ['guardian_id', 'guardians'], ['notification_id', 'notifications']],
    indexes: ['outbox_queue on (org_id, status, send_after)'],
  },
  {
    name: 'device_tokens', read: 'self', module: 'notifications',
    cols: ['user_id uuid not null', 'staff_id uuid', 'token text not null unique', `platform text check (platform is null or platform ${inList('ios', 'android', 'web')})`,
      'device_name text', 'last_seen_at timestamptz', 'revoked_at timestamptz'],
    fks: [['user_id', '@org_users_cascade'], ['staff_id', 'staff']],
    post: [SELF_ALL('device_tokens')],
  },
  {
    name: 'integrations', branch: 'null', read: 'permission', module: 'integrations',
    doc: 'Provider config without secrets (decision 41; secrets in private.org_secrets).',
    cols: ['product_key text references core.products(key)', `type text not null check (type ~ '^[a-z][a-z0-9_]*$')`, 'name text not null', 'provider text',
      enumCol('provider_owner', ['client', 'autoed'], 'client'), 'enabled boolean not null default false', `config jsonb not null default '{}'`, 'status text'],
  },
  {
    name: 'api_keys', read: 'permission', module: 'integrations',
    cols: ['product_key text not null references core.products(key)', 'name text not null', 'prefix text not null', 'key_hash text not null unique',
      `scopes text[] not null default '{}'`, 'last_used_at timestamptz', 'expires_at timestamptz', 'revoked_at timestamptz'],
  },
  {
    name: 'webhooks', read: 'permission', module: 'integrations',
    cols: ['product_key text not null references core.products(key)', `url text not null check (url ~ '^https://')`, `events text[] not null default '{}'`,
      'active boolean not null default true', 'secret_ref text', 'last_status integer', 'last_delivery_at timestamptz'],
  },
  {
    name: 'ticket_categories', read: 'members', module: 'helpdesk',
    cols: [`key text not null check (key ~ '^[a-z][a-z0-9_]*$')`, 'name text not null', `name_i18n jsonb not null default '{}'`, 'product_key text references core.products(key)',
      'owner_role_key text', 'sla_hours integer', 'active boolean not null default true'],
    uniques: ['unique (org_id, key)'],
  },
  {
    name: 'tickets', branch: 'null', read: 'permission', module: 'helpdesk',
    extra: 'raised_by_user_id = app.uid() or owner_staff_id = app.my_core_staff_id()',
    doc: 'Helpdesk tickets raised by staff (OS) or families (ERP portal).',
    cols: ['category_id uuid', 'product_key text references core.products(key)', 'title text not null', 'description text', PRIORITY,
      enumCol('status', ['open', 'assigned', 'in_progress', 'waiting', 'resolved', 'closed', 'reopened'], 'open'),
      'raised_by_user_id uuid default app.uid()', 'raised_by_staff_id uuid', 'raised_by_name text', 'student_id uuid', 'owner_staff_id uuid', 'owner_role_key text',
      'room_id uuid', 'location_text text', 'asset_tag text', 'parts jsonb', 'vendor text', 'vendor_ref uuid', 'cost numeric(12,2)', 'due_at timestamptz',
      'resolved_at timestamptz', 'closed_at timestamptz', 'resolution text', 'rating smallint check (rating is null or rating between 1 and 5)', 'rating_comment text',
      enumCol('source', ['manual', 'checklist', 'qr', 'portal'], 'manual'), 'photo_file_id uuid', 'voice_file_id uuid', `payload jsonb not null default '{}'`,
      'linked_type text', 'linked_id uuid', 'approval_request_id uuid'],
    fks: [['category_id', 'ticket_categories'], ['raised_by_staff_id', 'staff'], ['student_id', 'students'], ['owner_staff_id', 'staff'], ['room_id', 'rooms'],
      ['photo_file_id', 'files'], ['voice_file_id', 'files'], ['approval_request_id', 'approval_requests']],
    indexes: ['tickets_status on (org_id, status, due_at)'],
    post: [`create policy ins_self on core.tickets for insert with check (
  org_id = app.current_org_id() and app.user_has_any_product(org_id) and raised_by_user_id = app.uid()
  and (student_id is null or app.my_member_kind() in ('staff','support') or student_id = any(app.my_learner_ids())));`],
  },
  {
    name: 'ticket_events', read: 'permission', module: 'helpdesk',
    extra: 'not internal and exists (select 1 from core.tickets t where t.org_id = ticket_events.org_id and t.id = ticket_events.ticket_id)',
    doc: 'internal rows are never shown to families.',
    cols: ['ticket_id uuid not null', 'actor_user_id uuid default app.uid()', 'actor_staff_id uuid', 'actor_name text', 'event text not null', 'from_status text', 'to_status text',
      'note text', 'internal boolean not null default false'],
    fks: [['ticket_id', 'tickets', 'cascade'], ['actor_staff_id', 'staff']],
    post: [`create policy ins_self on core.ticket_events for insert with check (
  org_id = app.current_org_id() and app.user_has_any_product(org_id) and actor_user_id = app.uid() and not internal
  and exists (select 1 from core.tickets t where t.org_id = ticket_events.org_id and t.id = ticket_events.ticket_id));`],
  },
  {
    name: 'support_tickets', read: 'permission', module: 'support', extra: 'user_id = app.uid()',
    doc: 'Tickets from a client to AutoEd.',
    cols: ['product_key text references core.products(key)', 'user_id uuid default app.uid()', 'staff_id uuid', enumCol('kind', ['ticket', 'feature'], 'ticket'),
      'subject text not null', 'body text', PRIORITY, enumCol('status', ['open', 'in_progress', 'resolved', 'closed'], 'open'), 'reply text', 'linked_id uuid'],
    fks: [['staff_id', 'staff']],
    post: [`create policy ins_self on core.support_tickets for insert with check (
  org_id = app.current_org_id() and app.user_has_any_product(org_id) and user_id = app.uid());`],
  },
  {
    name: 'incidents', branch: 'null', read: 'permission', module: 'incidents',
    doc: 'RESTRICTED (incidents.view). student_ids / staff_ids are arrays without foreign keys. ERP safeguarding stays in erp.',
    cols: [enumCol('type', ['discipline', 'injury', 'parent_complaint', 'safety', 'property', 'ptm_note', 'other'], 'other'),
      `student_ids uuid[] not null default '{}'`, `staff_ids uuid[] not null default '{}'`, 'room_id uuid', 'location_text text', 'occurred_at timestamptz not null default now()',
      'description text not null', 'action_taken text', 'follow_up text', enumCol('severity', ['low', 'medium', 'high', 'critical'], 'low'),
      'confidential boolean not null default false', 'owner_staff_id uuid', 'reported_by_user_id uuid default app.uid()', 'reported_by_staff_id uuid',
      enumCol('status', ['open', 'follow_up', 'closed'], 'open')],
    fks: [['room_id', 'rooms'], ['owner_staff_id', 'staff'], ['reported_by_staff_id', 'staff']],
    indexes: ['incidents_students on core.incidents using gin (student_ids)|raw'],
  },
  {
    name: 'consents', read: 'permission', module: 'compliance',
    extra: 'student_id = any(app.my_learner_ids()) or guardian_id in (select g.id from core.guardians g where g.org_id = consents.org_id and g.household_id = any(app.my_household_ids()))',
    guard: `subject_type <> 'crm_guardian' or app.user_has_product(org_id, 'crm')`,
    doc: 'Consent per subject and purpose. crm_guardian rows (pre-admission leads) are readable with CRM only.',
    cols: [enumCol('subject_type', ['guardian', 'student', 'staff', 'crm_guardian']), 'guardian_id uuid', 'student_id uuid', 'staff_id uuid', 'crm_contact_id uuid',
      enumCol('purpose', ['photos', 'marketing', 'analytics', 'whatsapp', 'sms', 'email', 'call', 'biometric', 'face_recognition', 'trip', 'other']),
      'granted boolean not null', 'wording_version text', 'source text', 'granted_at timestamptz not null default now()', 'withdrawn_at timestamptz',
      'user_id uuid default app.uid()', 'product_key text references core.products(key)'],
    fks: [['guardian_id', 'guardians', 'cascade'], ['student_id', 'students', 'cascade'], ['staff_id', 'staff', 'cascade']],
    uniques: [`check ((subject_type = 'guardian') = (guardian_id is not null) and (subject_type = 'student') = (student_id is not null)
    and (subject_type = 'staff') = (staff_id is not null) and (subject_type = 'crm_guardian') = (crm_contact_id is not null))`],
  },
  {
    name: 'data_requests', read: 'permission', module: 'compliance', extra: 'requested_by_user_id = app.uid()',
    cols: [enumCol('type', ['access', 'correction', 'erasure', 'export']), 'subject_type text', 'subject_id uuid', 'subject text', 'details text',
      enumCol('status', ['open', 'in_progress', 'done', 'rejected'], 'open'), 'due_date date', `evidence jsonb not null default '{}'`,
      'requested_by_user_id uuid default app.uid()', 'product_key text references core.products(key)'],
    post: [`create policy ins_self on core.data_requests for insert with check (
  org_id = app.current_org_id() and app.user_has_any_product(org_id) and requested_by_user_id = app.uid() and status = 'open');`],
  },
  {
    name: 'retention_rules', read: 'permission', module: 'compliance',
    cols: ['data_type text not null', 'keep_years integer not null check (keep_years >= 0)', enumCol('action', ['anonymise', 'delete'], 'anonymise'), 'notes text',
      'product_key text references core.products(key)'],
    uniques: ['unique nulls not distinct (org_id, data_type, product_key)'],
  },
]);

// ------------------------------------------------------------------------------------------- emit
function tableSql(t) {
  const lines = [
    'id uuid primary key default gen_random_uuid()',
    'org_id uuid not null references core.organizations(id) on delete cascade',
  ];
  if (t.branch) lines.push(`branch_id uuid${t.branch === 'req' ? ' not null' : ''}`);
  lines.push(...t.cols);
  lines.push('created_at timestamptz not null default now()', 'created_by uuid default app.uid()',
    'updated_at timestamptz not null default now()', 'deleted_at timestamptz');
  const cons = ['unique (org_id, id)'];
  if (t.branch) cons.push('foreign key (org_id, branch_id) references core.branches(org_id, id)');
  const idx = [];
  if (t.branch) idx.push(`create index ${t.name}_branch on core.${t.name}(org_id, branch_id);`);
  for (const [col, ref, del] of t.fks ?? []) {
    if (ref.startsWith('@org_users')) {
      const act = ref.endsWith('_cascade') ? 'on delete cascade' : `on delete set null (${col})`;
      cons.push(`foreign key (org_id, ${col}) references core.org_users(org_id, user_id) ${act}`);
    } else {
      cons.push(`foreign key (org_id, ${col}) references core.${ref}(org_id, id)${del === 'cascade' ? ' on delete cascade' : ''}`);
    }
    idx.push(`create index ${t.name}_${col} on core.${t.name}(org_id, ${col});`);
  }
  cons.push(...(t.uniques ?? []));
  for (const i of t.indexes ?? []) {
    const [def, flag] = i.split('|');
    if (flag === 'raw') idx.push(`create index ${def};`);
    else {
      const sp = def.indexOf(' on ');
      idx.push(`create ${flag === 'unique' ? 'unique ' : ''}index ${def.slice(0, sp)} on core.${t.name}${def.slice(sp + 4)};`);
    }
  }
  const product = t.product ?? '*';
  const lit = (s) => (s == null ? 'null' : `'${s.replace(/'/g, "''")}'`);
  return [
    t.doc ? `-- ${t.doc}` : null,
    `create table core.${t.name} (\n  ${[...lines, ...cons].join(',\n  ')}\n);`,
    ...idx,
    `create trigger trg_touch before update on core.${t.name} for each row execute function app.touch_updated_at();`,
    `grant select, insert, update, delete on core.${t.name} to authenticated, crm_server, os_server, erp_server;`,
    `grant select on core.${t.name} to platform_admin_server;`,
    `select app.apply_core_rls(${lit(t.name)}, ${lit(t.read)}, ${lit(product)}, ${lit(t.module)}, ${lit(t.extra ?? null)}, ${lit(t.guard ?? null)});`,
    ...(t.post ?? []),
  ].filter(Boolean).join('\n');
}

if (process.argv.includes('--summary')) {
  console.log('| Table | Branch | Read | Writer product | Module | Portal / self rows |');
  console.log('|---|---|---|---|---|---|');
  for (const f of files) for (const t of f.tables) {
    console.log(`| core.${t.name} | ${t.branch ?? '-'} | ${t.read} | ${t.product ?? '*'} | ${t.module} | ${(t.extra ?? '').replace(/\|/g, '\\|')}${t.guard ? ` (and: ${t.guard})` : ''} |`);
  }
  console.log(`\n${files.reduce((n, f) => n + f.tables.length, 0)} tables`);
} else {
  for (const f of files) {
    const body = [
      `-- AutoEd core master data: ${f.title}.`,
      '-- GENERATED by scripts/gen-core-master.mjs from docs/MAP-TABLES.md section B. Edit the generator, not this file.',
      f.pre,
      ...f.tables.map(tableSql),
      f.post,
    ].filter((x) => x !== '').join('\n\n');
    writeFileSync(join(root, 'supabase/migrations', f.name), body.trimEnd() + '\n');
    console.log('wrote', f.name, `(${f.tables.length} tables)`);
  }
}
