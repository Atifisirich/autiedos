-- Academic modules (section 6): curriculum library, lesson planning, coverage, class log,
-- exams and question papers, observation and appraisal.

-- ---------------------------------------------------------------- curriculum library
-- org_id null = AutoEd preloaded map (read-only for schools); org_id set = school clone/upload.
create table public.curriculum_boards (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  key text not null check (key in ('CBSE','CAMBRIDGE','SCHOOL')),
  name text not null,
  syllabus_year text not null,
  cloned_from_id uuid references public.curriculum_boards(id) on delete set null,
  is_latest boolean not null default true
);
select app.standardize('curriculum_boards');

create table public.curriculum_subjects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  board_id uuid not null references public.curriculum_boards(id) on delete cascade,
  stage text not null,                 -- "Class 8", "Lower Secondary Stage 8", "IGCSE"
  grade_level integer not null,
  name text not null,
  content_language text not null default 'en'
);
select app.standardize('curriculum_subjects');

create table public.curriculum_units (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  subject_id uuid not null references public.curriculum_subjects(id) on delete cascade,
  seq integer not null,
  name text not null
);
select app.standardize('curriculum_units');

create table public.curriculum_topics (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  unit_id uuid not null references public.curriculum_units(id) on delete cascade,
  parent_topic_id uuid references public.curriculum_topics(id) on delete cascade,
  kind text not null default 'topic' check (kind in ('chapter','topic')),
  seq integer not null,
  name text not null,
  weight numeric(5,2) not null default 1,
  est_periods integer not null default 1
);
select app.standardize('curriculum_topics');

create table public.learning_outcomes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  topic_id uuid not null references public.curriculum_topics(id) on delete cascade,
  code text not null,
  text text not null,
  kind text not null default 'outcome' check (kind in ('outcome','competency','objective','assessment_objective')),
  bloom text
);
select app.standardize('learning_outcomes');

create table public.school_documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  title text not null,
  kind text not null check (kind in ('textbook','year_plan','lesson_plan','worksheet','sop','other')),
  storage_path text not null,
  mime text,
  size_bytes integer,
  subject_id uuid references public.subjects(id) on delete set null,
  class_id uuid references public.classes(id) on delete set null,
  status text not null default 'uploaded' check (status in ('uploaded','parsed','embedded','failed')),
  error text
);
select app.standardize('school_documents');

create table public.document_chunks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  document_id uuid not null references public.school_documents(id) on delete cascade,
  seq integer not null,
  content text not null,
  embedding vector(256),
  tsv tsvector generated always as (to_tsvector('simple', content)) stored
);
select app.standardize('document_chunks');
create index idx_document_chunks_tsv on public.document_chunks using gin (tsv);

create table public.lesson_plan_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  wing_id uuid references public.wings(id) on delete cascade,
  name text not null,
  sections jsonb not null,           -- [{key,name,mandatory,seq}]
  header jsonb not null default '{}'::jsonb,
  default_teaching_model text not null default '5E',
  is_default boolean not null default false
);
select app.standardize('lesson_plan_templates');

create table public.annual_plans (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  academic_year_id uuid not null references public.academic_years(id) on delete cascade,
  class_id uuid not null references public.classes(id) on delete cascade,
  subject_id uuid not null references public.subjects(id) on delete cascade,
  curriculum_subject_id uuid references public.curriculum_subjects(id) on delete set null,
  staff_id uuid references public.staff(id) on delete set null,
  status text not null default 'draft' check (status in ('draft','published')),
  ai_generation_id uuid,
  unique (academic_year_id, class_id, subject_id)
);
select app.standardize('annual_plans');

create table public.annual_plan_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  annual_plan_id uuid not null references public.annual_plans(id) on delete cascade,
  topic_id uuid not null references public.curriculum_topics(id) on delete cascade,
  seq integer not null,
  term_id uuid references public.terms(id) on delete set null,
  planned_start date not null,
  planned_end date not null,
  planned_periods integer not null
);
select app.standardize('annual_plan_items');

create table public.lesson_plans (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  level text not null default 'daily' check (level in ('unit','weekly','daily','cover')),
  staff_id uuid not null references public.staff(id) on delete cascade,
  section_id uuid references public.sections(id) on delete set null,
  section_ids uuid[] not null default '{}',
  subject_id uuid not null references public.subjects(id) on delete cascade,
  topic_id uuid references public.curriculum_topics(id) on delete set null,
  plan_date date,
  week_start date,
  period_count integer not null default 1,
  period_minutes integer not null default 40,
  teaching_model text not null default '5E',
  template_id uuid references public.lesson_plan_templates(id) on delete set null,
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
  source_plan_id uuid references public.lesson_plans(id) on delete set null,
  share_with_group boolean not null default false,
  ai_generation_id uuid
);
select app.standardize('lesson_plans');
create index idx_lesson_plans_staff on public.lesson_plans(staff_id, plan_date);
create index idx_lesson_plans_status on public.lesson_plans(status);

create table public.lesson_plan_versions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  plan_id uuid not null references public.lesson_plans(id) on delete cascade,
  version integer not null,
  content jsonb not null,
  note text,
  unique (plan_id, version)
);
select app.standardize('lesson_plan_versions');

create table public.lesson_plan_reviews (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  plan_id uuid not null references public.lesson_plans(id) on delete cascade,
  step_seq integer not null,
  reviewer_id uuid references public.staff(id) on delete set null,
  action text not null check (action in ('approve','return','comment')),
  section_key text,
  comment text
);
select app.standardize('lesson_plan_reviews');

create table public.plan_submission_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  wing_id uuid references public.wings(id) on delete cascade,
  level text not null check (level in ('daily','weekly','unit')),
  name text not null,
  due_weekday integer,            -- weekly: ISO weekday plans are due
  due_time time not null default '16:00',
  days_before integer not null default 1,   -- daily: due N days before plan date
  review_steps jsonb not null default '["hod","academic_coordinator"]'::jsonb,
  active boolean not null default true
);
select app.standardize('plan_submission_rules');

-- ---------------------------------------------------------------- class log (6.3)
create table public.class_logs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  section_id uuid not null references public.sections(id) on delete cascade,
  subject_id uuid not null references public.subjects(id) on delete cascade,
  staff_id uuid not null references public.staff(id) on delete cascade,
  date date not null,
  period_seq integer not null,
  topic_id uuid references public.curriculum_topics(id) on delete set null,
  lesson_plan_id uuid references public.lesson_plans(id) on delete set null,
  taught_as_planned boolean not null default true,
  topic_text text,
  classwork text,
  remarks text,
  client_id text,
  unique (section_id, date, period_seq)
);
select app.standardize('class_logs');

create table public.homework (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  class_log_id uuid references public.class_logs(id) on delete cascade,
  section_id uuid not null references public.sections(id) on delete cascade,
  subject_id uuid not null references public.subjects(id) on delete cascade,
  staff_id uuid not null references public.staff(id) on delete cascade,
  assigned_on date not null,
  due_on date not null,
  description text not null,
  est_minutes integer not null default 15
);
select app.standardize('homework');

create table public.notebook_checks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  section_id uuid not null references public.sections(id) on delete cascade,
  subject_id uuid not null references public.subjects(id) on delete cascade,
  staff_id uuid not null references public.staff(id) on delete cascade,
  kind text not null check (kind in ('cycle','spot_check')),
  checked_on date not null,
  checked_by uuid references public.staff(id) on delete set null,
  rubric jsonb not null default '{}'::jsonb,
  score numeric,
  notes text
);
select app.standardize('notebook_checks');

-- ---------------------------------------------------------------- exams (6.4)
create table public.exam_types (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  key text not null,
  name text not null,
  name_i18n jsonb not null default '{}'::jsonb,
  unique (org_id, key)
);
select app.standardize('exam_types');

create table public.exams (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  academic_year_id uuid references public.academic_years(id) on delete set null,
  term_id uuid references public.terms(id) on delete set null,
  exam_type_id uuid references public.exam_types(id) on delete set null,
  name text not null,
  starts_on date not null,
  ends_on date not null,
  class_ids uuid[] not null default '{}',
  status text not null default 'planning' check (status in ('planning','scheduled','in_progress','completed')),
  rules jsonb not null default '{"max_duties_per_day":2,"relievers_per_floor":1}'::jsonb
);
select app.standardize('exams');

create table public.exam_schedules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  exam_id uuid not null references public.exams(id) on delete cascade,
  class_id uuid not null references public.classes(id) on delete cascade,
  subject_id uuid not null references public.subjects(id) on delete cascade,
  date date not null,
  starts_at time not null,
  ends_at time not null,
  room_ids uuid[] not null default '{}'
);
select app.standardize('exam_schedules');

create table public.invigilation_duties (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  exam_schedule_id uuid not null references public.exam_schedules(id) on delete cascade,
  room_id uuid references public.rooms(id) on delete set null,
  staff_id uuid not null references public.staff(id) on delete cascade,
  role text not null default 'invigilator' check (role in ('invigilator','reliever')),
  status text not null default 'assigned' check (status in ('assigned','swap_requested','swapped','done')),
  swap_request_id uuid references public.approval_requests(id) on delete set null
);
select app.standardize('invigilation_duties');

create table public.seating_plans (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  exam_id uuid not null references public.exams(id) on delete cascade,
  date date not null,
  room_id uuid not null references public.rooms(id) on delete cascade,
  layout jsonb not null    -- [{seat, student_id, class_id}]
);
select app.standardize('seating_plans');

create table public.paper_blueprints (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  name text not null,
  board text not null default 'CBSE',
  class_id uuid references public.classes(id) on delete set null,
  subject_id uuid references public.subjects(id) on delete set null,
  total_marks integer not null,
  duration_minutes integer not null,
  sections jsonb not null,           -- [{name, question_type, count, marks_each}]
  chapter_weightage jsonb not null default '{}'::jsonb,   -- {topic_id: marks}
  difficulty jsonb not null default '{"easy":30,"medium":50,"hard":20}'::jsonb,
  bloom jsonb not null default '{}'::jsonb,
  competency_pct numeric not null default 0,
  instructions text,
  is_template boolean not null default false
);
select app.standardize('paper_blueprints');

create table public.question_bank (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  subject_id uuid references public.subjects(id) on delete set null,
  class_id uuid references public.classes(id) on delete set null,
  topic_id uuid references public.curriculum_topics(id) on delete set null,
  question_type text not null,
  difficulty text not null check (difficulty in ('easy','medium','hard')),
  bloom text,
  competency boolean not null default false,
  marks numeric not null,
  content jsonb not null,           -- {text, options, answer, marking}
  status text not null default 'approved' check (status in ('draft','approved')),
  source text not null default 'manual' check (source in ('manual','ai','paper')),
  tags text[] not null default '{}'
);
select app.standardize('question_bank');

create table public.question_papers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  exam_id uuid references public.exams(id) on delete set null,
  exam_schedule_id uuid references public.exam_schedules(id) on delete set null,
  blueprint_id uuid references public.paper_blueprints(id) on delete set null,
  subject_id uuid references public.subjects(id) on delete set null,
  class_id uuid references public.classes(id) on delete set null,
  set_no integer not null default 1,
  setter_id uuid not null references public.staff(id) on delete cascade,
  reviewer_ids uuid[] not null default '{}',
  exam_date date,
  status text not null default 'draft' check (status in ('draft','hod_review','coordinator_review','approved','returned')),
  questions jsonb not null default '[]'::jsonb,
  blueprint_table jsonb not null default '[]'::jsonb,
  review_comments jsonb not null default '[]'::jsonb,
  ai_generation_id uuid
);
select app.standardize('question_papers');

create table public.paper_access_log (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  paper_id uuid not null references public.question_papers(id) on delete cascade,
  staff_id uuid references public.staff(id) on delete set null,
  action text not null check (action in ('view','download','export')),
  watermark text
);
select app.standardize('paper_access_log');

-- ---------------------------------------------------------------- observation & appraisal (6.5)
create table public.observation_rubrics (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  name text not null,
  domains jsonb not null,     -- [{key,name,weight,indicators:[{key,text}]}]
  scale jsonb not null default '{"min":1,"max":4}'::jsonb,
  is_preset boolean not null default false
);
select app.standardize('observation_rubrics');

create table public.observations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  rubric_id uuid not null references public.observation_rubrics(id) on delete restrict,
  observer_id uuid not null references public.staff(id) on delete cascade,
  teacher_id uuid not null references public.staff(id) on delete cascade,
  section_id uuid references public.sections(id) on delete set null,
  subject_id uuid references public.subjects(id) on delete set null,
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
select app.standardize('observations');

create table public.appraisal_cycles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  name text not null,
  starts_on date not null,
  ends_on date not null,
  weights jsonb not null,
  status text not null default 'open' check (status in ('open','closed')),
  released boolean not null default false
);
select app.standardize('appraisal_cycles');

create table public.appraisal_scores (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  cycle_id uuid not null references public.appraisal_cycles(id) on delete cascade,
  staff_id uuid not null references public.staff(id) on delete cascade,
  components jsonb not null default '{}'::jsonb,
  self_appraisal numeric,
  manager_rating numeric,
  total numeric,
  computed_at timestamptz,
  unique (cycle_id, staff_id)
);
select app.standardize('appraisal_scores');

create table public.trainings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  staff_id uuid not null references public.staff(id) on delete cascade,
  title text not null,
  provider text,
  attended_on date not null,
  hours numeric(6,2) not null,
  certificate_path text
);
select app.standardize('trainings');
