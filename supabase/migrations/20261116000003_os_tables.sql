-- AutoEd OS on the shared platform (3/6): the os.* tables (docs/MAP-TABLES.md A.1, target schema os).
-- Ported from the legacy public-schema migrations: class_id -> programme_id (OQ-2), references to shared data
-- point at core (core.staff, core.sections, core.programmes ...), school_documents -> reference_documents
-- (decision 28). OS-only columns of shared rows live in side tables: os.event_plans (events, R7) and
-- os.exam_plans (exam rules and the rooms of each paper). Every table gets org_id, the standard columns
-- (os.std) and its policies in 20261116000005.

-- ---------------------------------------------------------------- config
create table os.assignment_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid references core.branches(id) on delete cascade,
  from_role_id uuid not null references os.roles(id) on delete cascade,
  to_role_id uuid not null references os.roles(id) on delete cascade,
  rule text not null check (rule in ('assign','request','none')),
  unique (org_id, from_role_id, to_role_id)
);
select os.std('assignment_rules');

-- ---------------------------------------------------------------- tasks
create table os.escalation_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid references core.branches(id) on delete cascade,
  name text not null,
  remind_before_minutes integer not null default 120,
  notify_owner_at_due boolean not null default true,
  notify_assigner_after_working_minutes integer not null default 240,
  notify_manager_after_working_days integer not null default 1,
  urgent_factor numeric(4,2) not null default 0.5
);
select os.std('escalation_rules');

create table os.task_categories (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid references core.branches(id) on delete cascade,
  key text not null,
  name text not null,
  name_i18n jsonb not null default '{}'::jsonb,
  color text not null default '#64748b',
  default_proof text not null default 'none' check (default_proof in ('none','note','photo','file')),
  default_verification boolean not null default false,
  escalation_rule_id uuid references os.escalation_rules(id) on delete set null,
  unique (org_id, key)
);
select os.std('task_categories');

create table os.task_recurrences (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid not null references core.branches(id) on delete cascade,
  template jsonb not null,
  target jsonb not null,
  frequency text not null check (frequency in ('daily','weekly','monthly','term','custom')),
  interval_n integer not null default 1,
  weekdays integer[] not null default '{}',
  month_day integer,
  custom_dates date[] not null default '{}',
  due_time time not null default '17:00',
  starts_on date not null,
  ends_on date,
  skip_holidays boolean not null default true,
  last_generated_on date,
  active boolean not null default true,
  assigner_id uuid references core.staff(id) on delete set null
);
select os.std('task_recurrences');

create table os.tasks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid not null references core.branches(id) on delete cascade,
  parent_task_id uuid references os.tasks(id) on delete cascade,
  is_group_parent boolean not null default false,
  group_mode text check (group_mode in ('each','any')),
  title text not null,
  description text,
  category_id uuid references os.task_categories(id) on delete set null,
  priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  status text not null default 'todo' check (status in ('requested','declined','todo','in_progress','blocked','done','verified','reopened','not_done','cancelled')),
  source text not null default 'assigned' check (source in ('assigned','self','recurring','sudden','request','system')),
  owner_id uuid references core.staff(id) on delete set null,
  assigner_id uuid references core.staff(id) on delete set null,
  department_id uuid references core.departments(id) on delete set null,
  wing_id uuid references core.wings(id) on delete set null,
  start_at timestamptz,
  due_at timestamptz,
  estimated_minutes integer,
  time_spent_minutes integer,
  recurrence_id uuid references os.task_recurrences(id) on delete set null,
  linked_type text,
  linked_id uuid,
  proof_required text not null default 'none' check (proof_required in ('none','note','photo','file')),
  verification_required boolean not null default false,
  unplanned boolean not null default false,
  blocked_reason text,
  not_done_reason text check (not_done_reason in ('no_time','not_possible','not_needed','other','no_response')),
  not_done_note text,
  completion_note text,
  proof_path text,
  voice_note_path text,
  completed_at timestamptz,
  verified_at timestamptz,
  verified_by uuid references core.staff(id) on delete set null,
  carried_forward_count integer not null default 0,
  last_escalation_level integer not null default 0,
  system_key text,
  custom jsonb not null default '{}'::jsonb
);
select os.std('tasks');
create index tasks_owner_status on os.tasks(org_id, owner_id, status);
create index tasks_assigner on os.tasks(org_id, assigner_id);
create index tasks_due on os.tasks(org_id, due_at);
create index tasks_parent on os.tasks(parent_task_id);
create unique index tasks_system_key on os.tasks(org_id, system_key) where system_key is not null;

create table os.task_assignees (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid references core.branches(id) on delete cascade,
  task_id uuid not null references os.tasks(id) on delete cascade,
  staff_id uuid not null references core.staff(id) on delete cascade,
  kind text not null check (kind in ('collaborator','watcher')),
  unique (task_id, staff_id, kind)
);
select os.std('task_assignees');
create index task_assignees_staff on os.task_assignees(org_id, staff_id);

create table os.task_comments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid references core.branches(id) on delete cascade,
  task_id uuid not null references os.tasks(id) on delete cascade,
  author_id uuid references core.staff(id) on delete set null,
  kind text not null default 'comment' check (kind in ('comment','question','extension_request')),
  body text not null,
  mentions uuid[] not null default '{}',
  converted_task_id uuid references os.tasks(id) on delete set null
);
select os.std('task_comments');
create index task_comments_task on os.task_comments(task_id);

create table os.task_attachments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid references core.branches(id) on delete cascade,
  task_id uuid not null references os.tasks(id) on delete cascade,
  kind text not null check (kind in ('proof','attachment','voice')),
  storage_path text not null,
  mime text,
  size_bytes integer
);
select os.std('task_attachments');

create table os.task_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid references core.branches(id) on delete cascade,
  task_id uuid not null references os.tasks(id) on delete cascade,
  actor_id uuid references core.staff(id) on delete set null,
  event text not null,
  from_status text,
  to_status text,
  data jsonb not null default '{}'::jsonb
);
select os.std('task_events');
create index task_events_task on os.task_events(task_id);

-- ---------------------------------------------------------------- checklists
create table os.checklist_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid references core.branches(id) on delete cascade,
  key text,
  name text not null,
  name_i18n jsonb not null default '{}'::jsonb,
  schedule jsonb not null default '{"frequency":"daily","time":"08:00"}'::jsonb,
  owner_role_id uuid references os.roles(id) on delete set null,
  owner_staff_id uuid references core.staff(id) on delete set null,
  room_id uuid references core.rooms(id) on delete set null,
  location_text text,
  active boolean not null default true
);
select os.std('checklist_templates');

create table os.checklist_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid references core.branches(id) on delete cascade,
  template_id uuid not null references os.checklist_templates(id) on delete cascade,
  seq integer not null default 1,
  label text not null,
  label_i18n jsonb not null default '{}'::jsonb,
  item_type text not null check (item_type in ('tick','yesno','number','photo','text')),
  min_value numeric,
  max_value numeric,
  required boolean not null default true,
  on_fail jsonb
);
select os.std('checklist_items');

create table os.checklist_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid not null references core.branches(id) on delete cascade,
  template_id uuid not null references os.checklist_templates(id) on delete cascade,
  owner_id uuid references core.staff(id) on delete set null,
  run_date date not null,
  due_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending','in_progress','completed','missed')),
  completed_at timestamptz,
  escalated_at timestamptz,
  unique (template_id, run_date)
);
select os.std('checklist_runs');
create index checklist_runs_owner on os.checklist_runs(org_id, owner_id, run_date);

create table os.checklist_responses (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid references core.branches(id) on delete cascade,
  run_id uuid not null references os.checklist_runs(id) on delete cascade,
  item_id uuid not null references os.checklist_items(id) on delete cascade,
  value jsonb,
  passed boolean not null default true,
  photo_path text,
  note text,
  follow_up_type text,
  follow_up_id uuid,
  unique (run_id, item_id)
);
select os.std('checklist_responses');

-- ---------------------------------------------------------------- timetable generator, substitution
create table os.timetable_constraints (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid not null references core.branches(id) on delete cascade,
  kind text not null check (kind in ('teacher_unavailable','fixed_slot','section_unavailable','room_unavailable')),
  data jsonb not null
);
select os.std('timetable_constraints');

create table os.substitutions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid not null references core.branches(id) on delete cascade,
  date date not null,
  day integer not null,
  period_seq integer not null,
  section_id uuid not null references core.sections(id) on delete cascade,
  subject_id uuid references core.subjects(id) on delete set null,
  absent_staff_id uuid not null references core.staff(id) on delete cascade,
  substitute_staff_id uuid references core.staff(id) on delete set null,
  status text not null default 'suggested' check (status in ('suggested','assigned','uncovered','resolved_other','cancelled')),
  resolution text check (resolution in ('substitute','combine','library','games','supervision')),
  source text not null check (source in ('leave','absence','manual')),
  leave_request_id uuid references core.leave_requests(id) on delete set null,
  timetable_entry_id uuid references core.timetable_entries(id) on delete set null,
  ranked jsonb not null default '[]'::jsonb,
  cover_plan_id uuid,
  task_id uuid references os.tasks(id) on delete set null,
  notified_at timestamptz,
  unique (date, period_seq, section_id, absent_staff_id)
);
select os.std('substitutions');
create index substitutions_sub on os.substitutions(org_id, substitute_staff_id, date);

-- ---------------------------------------------------------------- curriculum (org_id null = AutoEd master maps)
create table os.curriculum_boards (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references core.organizations(id) on delete cascade,
  branch_id uuid references core.branches(id) on delete cascade,
  key text not null check (key ~ '^[A-Z][A-Z0-9_]*$'),
  name text not null,
  syllabus_year text not null,
  cloned_from_id uuid references os.curriculum_boards(id) on delete set null,
  is_latest boolean not null default true
);
select os.std('curriculum_boards');

create table os.curriculum_subjects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references core.organizations(id) on delete cascade,
  branch_id uuid references core.branches(id) on delete cascade,
  board_id uuid not null references os.curriculum_boards(id) on delete cascade,
  stage text not null,
  grade_level integer not null,
  name text not null,
  content_language text not null default 'en'
);
select os.std('curriculum_subjects');

create table os.curriculum_units (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references core.organizations(id) on delete cascade,
  branch_id uuid references core.branches(id) on delete cascade,
  subject_id uuid not null references os.curriculum_subjects(id) on delete cascade,
  seq integer not null,
  name text not null
);
select os.std('curriculum_units');

create table os.curriculum_topics (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references core.organizations(id) on delete cascade,
  branch_id uuid references core.branches(id) on delete cascade,
  unit_id uuid not null references os.curriculum_units(id) on delete cascade,
  parent_topic_id uuid references os.curriculum_topics(id) on delete cascade,
  kind text not null default 'topic' check (kind in ('chapter','topic')),
  seq integer not null,
  name text not null,
  weight numeric(5,2) not null default 1,
  est_periods integer not null default 1
);
select os.std('curriculum_topics');

create table os.learning_outcomes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references core.organizations(id) on delete cascade,
  branch_id uuid references core.branches(id) on delete cascade,
  topic_id uuid not null references os.curriculum_topics(id) on delete cascade,
  code text not null,
  text text not null,
  kind text not null default 'outcome' check (kind in ('outcome','competency','objective','assessment_objective')),
  bloom text
);
select os.std('learning_outcomes');

-- ---------------------------------------------------------------- planning
create table os.reference_documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid references core.branches(id) on delete cascade,
  title text not null,
  kind text not null check (kind in ('textbook','year_plan','lesson_plan','worksheet','sop','other')),
  storage_path text not null,
  mime text,
  size_bytes integer,
  subject_id uuid references core.subjects(id) on delete set null,
  programme_id uuid references core.programmes(id) on delete set null,
  status text not null default 'uploaded' check (status in ('uploaded','parsed','embedded','failed')),
  error text
);
select os.std('reference_documents');

create table os.document_chunks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid references core.branches(id) on delete cascade,
  document_id uuid not null references os.reference_documents(id) on delete cascade,
  seq integer not null,
  content text not null,
  embedding public.vector(256),
  tsv tsvector generated always as (to_tsvector('simple', content)) stored
);
select os.std('document_chunks');
create index document_chunks_tsv on os.document_chunks using gin (tsv);

create table os.lesson_plan_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid references core.branches(id) on delete cascade,
  wing_id uuid references core.wings(id) on delete cascade,
  name text not null,
  sections jsonb not null,
  header jsonb not null default '{}'::jsonb,
  default_teaching_model text not null default '5E',
  is_default boolean not null default false
);
select os.std('lesson_plan_templates');

create table os.annual_plans (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid not null references core.branches(id) on delete cascade,
  academic_year_id uuid not null references core.academic_years(id) on delete cascade,
  programme_id uuid not null references core.programmes(id) on delete cascade,
  subject_id uuid not null references core.subjects(id) on delete cascade,
  curriculum_subject_id uuid references os.curriculum_subjects(id) on delete set null,
  staff_id uuid references core.staff(id) on delete set null,
  status text not null default 'draft' check (status in ('draft','published')),
  ai_generation_id uuid,
  unique (academic_year_id, programme_id, subject_id)
);
select os.std('annual_plans');

create table os.annual_plan_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid references core.branches(id) on delete cascade,
  annual_plan_id uuid not null references os.annual_plans(id) on delete cascade,
  topic_id uuid not null references os.curriculum_topics(id) on delete cascade,
  seq integer not null,
  term_id uuid references core.terms(id) on delete set null,
  planned_start date not null,
  planned_end date not null,
  planned_periods integer not null
);
select os.std('annual_plan_items');

create table os.lesson_plans (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid not null references core.branches(id) on delete cascade,
  level text not null default 'daily' check (level in ('unit','weekly','daily','cover')),
  staff_id uuid not null references core.staff(id) on delete cascade,
  section_id uuid references core.sections(id) on delete set null,
  section_ids uuid[] not null default '{}',
  subject_id uuid not null references core.subjects(id) on delete cascade,
  topic_id uuid references os.curriculum_topics(id) on delete set null,
  plan_date date,
  week_start date,
  period_count integer not null default 1,
  period_minutes integer not null default 40,
  teaching_model text not null default '5E',
  template_id uuid references os.lesson_plan_templates(id) on delete set null,
  inputs jsonb not null default '{}'::jsonb,
  content jsonb not null default '{}'::jsonb,
  language text not null default 'en',
  status text not null default 'draft' check (status in ('draft','submitted','in_review','approved','returned','delivered','reflected')),
  confirmed_by_teacher boolean not null default false,
  review_seq integer not null default 0,
  current_version integer not null default 1,
  due_at timestamptz,
  submitted_at timestamptz,
  approved_at timestamptz,
  delivered_at timestamptz,
  reflection text,
  in_bank boolean not null default false,
  rating_sum integer not null default 0,
  rating_count integer not null default 0,
  usage_count integer not null default 0,
  source_plan_id uuid references os.lesson_plans(id) on delete set null,
  share_with_group boolean not null default false,
  ai_generation_id uuid
);
select os.std('lesson_plans');
create index lesson_plans_staff on os.lesson_plans(org_id, staff_id, plan_date);
create index lesson_plans_status on os.lesson_plans(org_id, status);

create table os.lesson_plan_versions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid references core.branches(id) on delete cascade,
  plan_id uuid not null references os.lesson_plans(id) on delete cascade,
  version integer not null,
  content jsonb not null,
  note text,
  unique (plan_id, version)
);
select os.std('lesson_plan_versions');

create table os.lesson_plan_reviews (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid references core.branches(id) on delete cascade,
  plan_id uuid not null references os.lesson_plans(id) on delete cascade,
  step_seq integer not null,
  reviewer_id uuid references core.staff(id) on delete set null,
  action text not null check (action in ('approve','return','comment')),
  section_key text,
  comment text
);
select os.std('lesson_plan_reviews');

create table os.plan_submission_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid references core.branches(id) on delete cascade,
  wing_id uuid references core.wings(id) on delete cascade,
  level text not null check (level in ('daily','weekly','unit')),
  name text not null,
  due_weekday integer,
  due_time time not null default '16:00',
  days_before integer not null default 1,
  review_steps jsonb not null default '["hod","academic_coordinator"]'::jsonb,
  active boolean not null default true
);
select os.std('plan_submission_rules');

create table os.class_logs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid not null references core.branches(id) on delete cascade,
  section_id uuid not null references core.sections(id) on delete cascade,
  subject_id uuid not null references core.subjects(id) on delete cascade,
  staff_id uuid not null references core.staff(id) on delete cascade,
  date date not null,
  period_seq integer not null,
  topic_id uuid references os.curriculum_topics(id) on delete set null,
  lesson_plan_id uuid references os.lesson_plans(id) on delete set null,
  taught_as_planned boolean not null default true,
  topic_text text,
  classwork text,
  remarks text,
  client_id text,
  unique (section_id, date, period_seq)
);
select os.std('class_logs');

create table os.notebook_checks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid not null references core.branches(id) on delete cascade,
  section_id uuid not null references core.sections(id) on delete cascade,
  subject_id uuid not null references core.subjects(id) on delete cascade,
  staff_id uuid not null references core.staff(id) on delete cascade,
  kind text not null check (kind in ('cycle','spot_check')),
  checked_on date not null,
  checked_by uuid references core.staff(id) on delete set null,
  rubric jsonb not null default '{}'::jsonb,
  score numeric,
  notes text
);
select os.std('notebook_checks');

-- ---------------------------------------------------------------- exams (shared rows in core.exams / exam_schedules)
-- OS-only exam data: duty rules and the rooms each paper uses ({"<exam_schedule_id>": [room ids]}).
create table os.exam_plans (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid references core.branches(id) on delete cascade,
  exam_id uuid not null references core.exams(id) on delete cascade,
  rules jsonb not null default '{"max_duties_per_day":2,"relievers_per_floor":1}'::jsonb,
  schedule_rooms jsonb not null default '{}'::jsonb,
  unique (exam_id)
);
select os.std('exam_plans');

create table os.invigilation_duties (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid not null references core.branches(id) on delete cascade,
  exam_schedule_id uuid not null references core.exam_schedules(id) on delete cascade,
  room_id uuid references core.rooms(id) on delete set null,
  staff_id uuid not null references core.staff(id) on delete cascade,
  role text not null default 'invigilator' check (role in ('invigilator','reliever')),
  status text not null default 'assigned' check (status in ('assigned','swap_requested','swapped','done')),
  swap_request_id uuid references core.approval_requests(id) on delete set null
);
select os.std('invigilation_duties');

create table os.paper_blueprints (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid references core.branches(id) on delete cascade,
  name text not null,
  board text not null default 'CBSE',
  programme_id uuid references core.programmes(id) on delete set null,
  subject_id uuid references core.subjects(id) on delete set null,
  total_marks integer not null,
  duration_minutes integer not null,
  sections jsonb not null,
  chapter_weightage jsonb not null default '{}'::jsonb,
  difficulty jsonb not null default '{"easy":30,"medium":50,"hard":20}'::jsonb,
  bloom jsonb not null default '{}'::jsonb,
  competency_pct numeric not null default 0,
  instructions text,
  is_template boolean not null default false
);
select os.std('paper_blueprints');

create table os.question_papers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid not null references core.branches(id) on delete cascade,
  exam_id uuid references core.exams(id) on delete set null,
  exam_schedule_id uuid references core.exam_schedules(id) on delete set null,
  blueprint_id uuid references os.paper_blueprints(id) on delete set null,
  subject_id uuid references core.subjects(id) on delete set null,
  programme_id uuid references core.programmes(id) on delete set null,
  set_no integer not null default 1,
  setter_id uuid not null references core.staff(id) on delete cascade,
  reviewer_ids uuid[] not null default '{}',
  exam_date date,
  status text not null default 'draft' check (status in ('draft','hod_review','coordinator_review','approved','returned')),
  questions jsonb not null default '[]'::jsonb,
  blueprint_table jsonb not null default '[]'::jsonb,
  review_comments jsonb not null default '[]'::jsonb,
  ai_generation_id uuid
);
select os.std('question_papers');

create table os.paper_access_log (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid references core.branches(id) on delete cascade,
  paper_id uuid not null references os.question_papers(id) on delete cascade,
  staff_id uuid references core.staff(id) on delete set null,
  action text not null check (action in ('view','download','export')),
  watermark text
);
select os.std('paper_access_log');

-- ---------------------------------------------------------------- observation and appraisal
create table os.observation_rubrics (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid references core.branches(id) on delete cascade,
  name text not null,
  domains jsonb not null,
  scale jsonb not null default '{"min":1,"max":4}'::jsonb,
  is_preset boolean not null default false
);
select os.std('observation_rubrics');

create table os.observations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid not null references core.branches(id) on delete cascade,
  rubric_id uuid not null references os.observation_rubrics(id) on delete restrict,
  observer_id uuid not null references core.staff(id) on delete cascade,
  teacher_id uuid not null references core.staff(id) on delete cascade,
  section_id uuid references core.sections(id) on delete set null,
  subject_id uuid references core.subjects(id) on delete set null,
  scheduled_at timestamptz not null,
  announced boolean not null default true,
  status text not null default 'scheduled' check (status in ('scheduled','completed','shared','acknowledged')),
  scores jsonb not null default '{}'::jsonb,
  evidence jsonb not null default '{}'::jsonb,
  overall numeric,
  feedback text,
  teacher_reflection text,
  agreed_actions jsonb not null default '[]'::jsonb,
  acknowledged_at timestamptz
);
select os.std('observations');

create table os.appraisal_cycles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid references core.branches(id) on delete cascade,
  name text not null,
  starts_on date not null,
  ends_on date not null,
  weights jsonb not null,
  status text not null default 'open' check (status in ('open','closed')),
  released boolean not null default false
);
select os.std('appraisal_cycles');

create table os.appraisal_scores (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid references core.branches(id) on delete cascade,
  cycle_id uuid not null references os.appraisal_cycles(id) on delete cascade,
  staff_id uuid not null references core.staff(id) on delete cascade,
  components jsonb not null default '{}'::jsonb,
  self_appraisal numeric,
  manager_rating numeric,
  total numeric,
  computed_at timestamptz,
  unique (cycle_id, staff_id)
);
select os.std('appraisal_scores');

create table os.trainings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid references core.branches(id) on delete cascade,
  staff_id uuid not null references core.staff(id) on delete cascade,
  title text not null,
  provider text,
  attended_on date not null,
  hours numeric(6,2) not null,
  certificate_path text
);
select os.std('trainings');

-- ---------------------------------------------------------------- circulars, meetings, events, duties, compliance
create table os.circulars (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid references core.branches(id) on delete cascade,
  author_id uuid references core.staff(id) on delete set null,
  title text not null,
  body text not null,
  attachments jsonb not null default '[]'::jsonb,
  target jsonb not null default '{}'::jsonb,
  response_mode text not null default 'read' check (response_mode in ('read','acknowledge','reply')),
  reply_form jsonb,
  important boolean not null default false,
  tags text[] not null default '{}',
  scheduled_at timestamptz,
  sent_at timestamptz,
  reminder_after_hours integer not null default 24,
  status text not null default 'draft' check (status in ('draft','scheduled','sent'))
);
select os.std('circulars');

create table os.circular_receipts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid references core.branches(id) on delete cascade,
  circular_id uuid not null references os.circulars(id) on delete cascade,
  staff_id uuid not null references core.staff(id) on delete cascade,
  read_at timestamptz,
  acknowledged_at timestamptz,
  reply jsonb,
  reminded_at timestamptz,
  unique (circular_id, staff_id)
);
select os.std('circular_receipts');

create table os.meetings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid not null references core.branches(id) on delete cascade,
  series_id uuid,
  previous_meeting_id uuid references os.meetings(id) on delete set null,
  title text not null,
  agenda text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  room_id uuid references core.rooms(id) on delete set null,
  organizer_id uuid references core.staff(id) on delete set null,
  attendee_ids uuid[] not null default '{}',
  attendance jsonb not null default '{}'::jsonb,
  recurrence jsonb,
  minutes text,
  status text not null default 'scheduled' check (status in ('scheduled','held','cancelled'))
);
select os.std('meetings');

create table os.meeting_actions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid references core.branches(id) on delete cascade,
  meeting_id uuid not null references os.meetings(id) on delete cascade,
  description text not null,
  owner_id uuid references core.staff(id) on delete set null,
  due_on date,
  task_id uuid references os.tasks(id) on delete set null
);
select os.std('meeting_actions');

create table os.event_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid references core.branches(id) on delete cascade,
  key text not null,
  name text not null,
  name_i18n jsonb not null default '{}'::jsonb,
  task_pack jsonb not null default '[]'::jsonb,
  committees jsonb not null default '[]'::jsonb,
  checklist jsonb not null default '[]'::jsonb,
  budget_lines jsonb not null default '[]'::jsonb,
  unique (org_id, key)
);
select os.std('event_templates');

-- OS planning columns of a shared core.events row (R7, OQ-9).
create table os.event_plans (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid references core.branches(id) on delete cascade,
  event_id uuid not null references core.events(id) on delete cascade,
  template_id uuid references os.event_templates(id) on delete set null,
  committees jsonb not null default '[]'::jsonb,
  budget jsonb not null default '[]'::jsonb,
  budget_approval_request_id uuid references core.approval_requests(id) on delete set null,
  review jsonb,
  unique (event_id)
);
select os.std('event_plans');

create table os.duty_types (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid references core.branches(id) on delete cascade,
  key text not null,
  name text not null,
  name_i18n jsonb not null default '{}'::jsonb,
  location text,
  starts_at time not null,
  ends_at time not null,
  overlaps_period_seq integer,
  staff_needed integer not null default 1,
  days integer[] not null default '{1,2,3,4,5,6}',
  unique (org_id, key)
);
select os.std('duty_types');

create table os.duty_assignments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid not null references core.branches(id) on delete cascade,
  duty_type_id uuid not null references os.duty_types(id) on delete cascade,
  staff_id uuid not null references core.staff(id) on delete cascade,
  date date not null,
  status text not null default 'assigned' check (status in ('assigned','done','missed','swapped')),
  swap_with_id uuid references core.staff(id) on delete set null,
  swap_approval_request_id uuid references core.approval_requests(id) on delete set null,
  reminded_at timestamptz,
  manual boolean not null default false,
  unique (duty_type_id, date, staff_id)
);
select os.std('duty_assignments');

create table os.compliance_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid not null references core.branches(id) on delete cascade,
  name text not null,
  category text not null,
  owner_id uuid references core.staff(id) on delete set null,
  issued_on date,
  expires_on date,
  documents jsonb not null default '[]'::jsonb,
  status text not null default 'valid' check (status in ('valid','expiring','overdue','missing')),
  reminders_sent integer[] not null default '{}',
  escalated_at timestamptz,
  preset_key text,
  verify_note text,
  notes text
);
select os.std('compliance_items');

-- ---------------------------------------------------------------- reports
create table os.saved_reports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid references core.branches(id) on delete cascade,
  owner_id uuid references core.staff(id) on delete set null,
  name text not null,
  dataset text not null,
  config jsonb not null,
  shared_role_ids uuid[] not null default '{}'
);
select os.std('saved_reports');

create table os.report_schedules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid references core.branches(id) on delete cascade,
  report_key text not null,
  saved_report_id uuid references os.saved_reports(id) on delete cascade,
  frequency text not null default 'daily' check (frequency in ('daily','weekly','monthly')),
  send_time time not null default '07:30',
  weekday integer,
  recipient_ids uuid[] not null default '{}',
  channel text not null default 'inapp' check (channel in ('inapp','email','whatsapp_link')),
  last_run_at timestamptz,
  active boolean not null default true
);
select os.std('report_schedules');

-- ---------------------------------------------------------------- help bot (org_id null = AutoEd articles)
create table os.kb_articles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references core.organizations(id) on delete cascade,
  branch_id uuid references core.branches(id) on delete cascade,
  slug text not null,
  language text not null check (language in ('en','hi','te')),
  title text not null,
  body text not null,
  screen_path text,
  module_key text,
  role_keys text[] not null default '{}',
  tags text[] not null default '{}'
);
select os.std('kb_articles');
create unique index kb_articles_slug on os.kb_articles(coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid), slug, language);

create table os.kb_chunks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references core.organizations(id) on delete cascade,
  branch_id uuid references core.branches(id) on delete cascade,
  article_id uuid not null references os.kb_articles(id) on delete cascade,
  language text not null,
  seq integer not null,
  content text not null,
  embedding public.vector(256),
  tsv tsvector generated always as (to_tsvector('simple', content)) stored
);
select os.std('kb_chunks');
create index kb_chunks_tsv on os.kb_chunks using gin (tsv);

create table os.bot_conversations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid references core.branches(id) on delete cascade,
  staff_id uuid not null references core.staff(id) on delete cascade,
  language text not null default 'en',
  screen_path text,
  messages jsonb not null default '[]'::jsonb,
  status text not null default 'open' check (status in ('open','answered','unanswered','escalated'))
);
select os.std('bot_conversations');

create table os.bot_feedback (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid references core.branches(id) on delete cascade,
  conversation_id uuid not null references os.bot_conversations(id) on delete cascade,
  staff_id uuid references core.staff(id) on delete set null,
  message_index integer not null,
  rating integer not null check (rating in (-1, 1)),
  question text,
  comment text
);
select os.std('bot_feedback');
