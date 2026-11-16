-- Tenancy, structure, people and configuration (sections 4.1 – 4.4).

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  logo_url text,
  branding jsonb not null default '{}'::jsonb,   -- header, footer, colours for exports
  settings jsonb not null default '{}'::jsonb,   -- plan bank sharing, etc.
  preset_key text,
  setup_step integer not null default 0,
  setup_completed_at timestamptz
);
select app.standardize('organizations');

create table public.branches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  code text not null,
  address text,
  timezone text not null default 'Asia/Kolkata',
  latitude double precision,
  longitude double precision,
  geofence_radius_m integer not null default 200,
  working_days integer[] not null default '{1,2,3,4,5,6}',   -- ISO weekday 1=Mon
  settings jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  unique (org_id, code)
);
select app.standardize('branches');

create table public.academic_years (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  name text not null,
  starts_on date not null,
  ends_on date not null,
  is_current boolean not null default false,
  archived boolean not null default false,
  check (ends_on > starts_on)
);
select app.standardize('academic_years');
create unique index uq_academic_years_current on public.academic_years(branch_id) where is_current and deleted_at is null;

create table public.terms (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  academic_year_id uuid not null references public.academic_years(id) on delete cascade,
  name text not null,
  seq integer not null default 1,
  starts_on date not null,
  ends_on date not null
);
select app.standardize('terms');

create table public.wings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  name text not null,
  board text not null default 'CBSE' check (board in ('CBSE','CAMBRIDGE','BOTH')),
  seq integer not null default 1,
  student_attendance_mode text not null default 'daily_once' check (student_attendance_mode in ('daily_once','daily_twice','period')),
  homework_limit_minutes integer not null default 90
);
select app.standardize('wings');

create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  name text not null,
  room_type text not null default 'classroom',
  capacity integer not null default 40,
  qr_token text unique default encode(gen_random_bytes(9), 'hex')
);
select app.standardize('rooms');

create table public.departments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  name text not null,
  head_staff_id uuid
);
select app.standardize('departments');

create table public.classes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  wing_id uuid not null references public.wings(id) on delete cascade,
  name text not null,
  grade_level integer not null,
  seq integer not null default 1
);
select app.standardize('classes');

create table public.subjects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  name text not null,
  code text not null,
  department_id uuid references public.departments(id) on delete set null,
  content_language text not null default 'en' check (content_language in ('en','hi','te','other')),
  is_core boolean not null default true
);
select app.standardize('subjects');

create table public.class_subjects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  class_id uuid not null references public.classes(id) on delete cascade,
  subject_id uuid not null references public.subjects(id) on delete cascade,
  periods_per_week integer not null default 5 check (periods_per_week between 0 and 60),
  double_periods integer not null default 0,
  room_type text,
  unique (class_id, subject_id)
);
select app.standardize('class_subjects');

create table public.module_flags (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  module_key text not null,
  enabled boolean not null default true,
  unique (branch_id, module_key)
);
select app.standardize('module_flags');

-- ---------------------------------------------------------------- people and access
create table public.roles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  key text not null,
  name text not null,
  description text,
  is_preset boolean not null default false,
  unique (org_id, key)
);
select app.standardize('roles');

create table public.role_permissions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  role_id uuid not null references public.roles(id) on delete cascade,
  module text not null,
  action text not null check (action in ('view','create','edit','delete','assign','approve','verify','export','configure')),
  scope text not null check (scope in ('own','team','wing','department','branch','group')),
  unique (role_id, module, action)
);
select app.standardize('role_permissions');

create table public.positions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  key text not null,
  name text not null,
  rank integer not null default 50,          -- lower = more senior
  default_role_id uuid references public.roles(id) on delete set null,
  unique (org_id, key)
);
select app.standardize('positions');

create table public.staff (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete set null,   -- home branch; null = group-level
  user_id uuid unique,
  employee_code text,
  full_name text not null,
  email text,
  phone text,
  position_id uuid references public.positions(id) on delete set null,
  department_id uuid references public.departments(id) on delete set null,
  wing_id uuid references public.wings(id) on delete set null,
  reports_to uuid references public.staff(id) on delete set null,
  language text not null default 'en' check (language in ('en','hi','te')),
  status text not null default 'active' check (status in ('invited','active','inactive','left')),
  joined_on date,
  is_teaching boolean not null default true,
  is_part_time boolean not null default false,
  max_periods_day integer not null default 7,
  max_periods_week integer not null default 36,
  unavailable jsonb not null default '[]'::jsonb,       -- [{day, period_seq}]
  ui_prefs jsonb not null default '{}'::jsonb,          -- large_text, simplified_home
  custom jsonb not null default '{}'::jsonb,
  unique (org_id, employee_code)
);
select app.standardize('staff');
create index idx_staff_reports_to on public.staff(reports_to);
create index idx_staff_user on public.staff(user_id);
alter table public.departments add constraint fk_departments_head foreign key (head_staff_id) references public.staff(id) on delete set null;

create table public.staff_branch_access (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  staff_id uuid not null references public.staff(id) on delete cascade,
  unique (staff_id, branch_id)
);
select app.standardize('staff_branch_access');

create table public.staff_roles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  staff_id uuid not null references public.staff(id) on delete cascade,
  role_id uuid not null references public.roles(id) on delete cascade,
  unique (staff_id, role_id)
);
select app.standardize('staff_roles');

create table public.reporting_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  staff_id uuid not null references public.staff(id) on delete cascade,
  manager_id uuid not null references public.staff(id) on delete cascade,
  kind text not null default 'secondary' check (kind in ('secondary')),
  unique (staff_id, manager_id),
  check (staff_id <> manager_id)
);
select app.standardize('reporting_lines');

create table public.assignment_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  from_role_id uuid not null references public.roles(id) on delete cascade,
  to_role_id uuid not null references public.roles(id) on delete cascade,
  rule text not null check (rule in ('assign','request','none')),
  unique (org_id, from_role_id, to_role_id)
);
select app.standardize('assignment_rules');

create table public.delegations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  staff_id uuid not null references public.staff(id) on delete cascade,
  delegate_id uuid not null references public.staff(id) on delete cascade,
  starts_on date not null,
  ends_on date not null,
  reason text,
  check (ends_on >= starts_on),
  check (staff_id <> delegate_id)
);
select app.standardize('delegations');

create table public.sections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  class_id uuid not null references public.classes(id) on delete cascade,
  academic_year_id uuid references public.academic_years(id) on delete set null,
  name text not null,
  class_teacher_id uuid references public.staff(id) on delete set null,
  room_id uuid references public.rooms(id) on delete set null,
  strength integer not null default 0,
  profile jsonb not null default '{}'::jsonb   -- ability mix, medium of instruction
);
select app.standardize('sections');

create table public.students (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  class_id uuid references public.classes(id) on delete set null,
  section_id uuid references public.sections(id) on delete set null,
  full_name text not null,
  admission_no text not null,
  roll_no integer,
  status text not null default 'active' check (status in ('active','left','transferred')),
  parent_phone text,
  unique (branch_id, admission_no)
);
select app.standardize('students');
create index idx_students_section on public.students(section_id);

-- ---------------------------------------------------------------- configuration
create table public.custom_fields (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  entity text not null check (entity in ('task','ticket','incident','approval','staff')),
  key text not null,
  label jsonb not null,                               -- {en,hi,te}
  field_type text not null check (field_type in ('text','number','date','dropdown','yesno','file')),
  options jsonb not null default '[]'::jsonb,
  required boolean not null default false,
  seq integer not null default 1,
  unique (org_id, entity, key)
);
select app.standardize('custom_fields');

create table public.custom_field_values (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  field_id uuid not null references public.custom_fields(id) on delete cascade,
  entity text not null,
  entity_id uuid not null,
  value jsonb,
  unique (field_id, entity_id)
);
select app.standardize('custom_field_values');

create table public.terminology (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  term_key text not null,
  value jsonb not null,                               -- {en,hi,te}
  unique (org_id, branch_id, term_key)
);
select app.standardize('terminology');

-- Global presets (org_id null) shipped by AutoEd; org rows are school-saved presets.
create table public.presets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  key text not null,
  area text not null,
  name text not null,
  payload jsonb not null,
  unique (org_id, key, area)
);
select app.standardize('presets');

create table public.config_history (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,      -- no FK: history is written while rows cascade-delete
  branch_id uuid,
  entity text not null,
  entity_id uuid,
  action text not null,
  before jsonb,
  after jsonb,
  actor_user_id uuid
);
select app.standardize('config_history');
create index idx_config_history_entity on public.config_history(entity, entity_id);
