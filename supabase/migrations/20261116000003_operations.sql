-- Core operations modules (section 5): tasks, checklists, timetable, substitution,
-- attendance, leave, approvals.

-- ---------------------------------------------------------------- tasks (5.1)
create table public.escalation_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  name text not null,
  remind_before_minutes integer not null default 120,
  notify_owner_at_due boolean not null default true,
  notify_assigner_after_working_minutes integer not null default 240,
  notify_manager_after_working_days integer not null default 1,
  urgent_factor numeric(4,2) not null default 0.5
);
select app.standardize('escalation_rules');

create table public.task_categories (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  key text not null,
  name text not null,
  name_i18n jsonb not null default '{}'::jsonb,
  color text not null default '#64748b',
  default_proof text not null default 'none' check (default_proof in ('none','note','photo','file')),
  default_verification boolean not null default false,
  escalation_rule_id uuid references public.escalation_rules(id) on delete set null,
  unique (org_id, key)
);
select app.standardize('task_categories');

create table public.task_recurrences (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  template jsonb not null,                -- task fields
  target jsonb not null,                  -- {staff_ids, role_id, wing_id, department_id, group_mode}
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
  assigner_id uuid references public.staff(id) on delete set null
);
select app.standardize('task_recurrences');

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  parent_task_id uuid references public.tasks(id) on delete cascade,
  is_group_parent boolean not null default false,
  group_mode text check (group_mode in ('each','any')),
  title text not null,
  description text,
  category_id uuid references public.task_categories(id) on delete set null,
  priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  status text not null default 'todo' check (status in ('requested','declined','todo','in_progress','blocked','done','verified','reopened','not_done','cancelled')),
  source text not null default 'assigned' check (source in ('assigned','self','recurring','sudden','request','system')),
  owner_id uuid references public.staff(id) on delete set null,
  assigner_id uuid references public.staff(id) on delete set null,
  department_id uuid references public.departments(id) on delete set null,
  wing_id uuid references public.wings(id) on delete set null,
  start_at timestamptz,
  due_at timestamptz,
  estimated_minutes integer,
  time_spent_minutes integer,
  recurrence_id uuid references public.task_recurrences(id) on delete set null,
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
  verified_by uuid references public.staff(id) on delete set null,
  carried_forward_count integer not null default 0,
  last_escalation_level integer not null default 0,
  system_key text,
  custom jsonb not null default '{}'::jsonb
);
select app.standardize('tasks');
create index idx_tasks_owner_status on public.tasks(owner_id, status);
create index idx_tasks_assigner on public.tasks(assigner_id);
create index idx_tasks_due on public.tasks(due_at);
create index idx_tasks_parent on public.tasks(parent_task_id);
create unique index uq_tasks_system_key on public.tasks(org_id, system_key) where system_key is not null;

create table public.task_assignees (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  staff_id uuid not null references public.staff(id) on delete cascade,
  kind text not null check (kind in ('collaborator','watcher')),
  unique (task_id, staff_id, kind)
);
select app.standardize('task_assignees');
create index idx_task_assignees_staff on public.task_assignees(staff_id);

create table public.task_comments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  author_id uuid references public.staff(id) on delete set null,
  kind text not null default 'comment' check (kind in ('comment','question','extension_request')),
  body text not null,
  mentions uuid[] not null default '{}',
  converted_task_id uuid references public.tasks(id) on delete set null
);
select app.standardize('task_comments');
create index idx_task_comments_task on public.task_comments(task_id);

create table public.task_attachments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  kind text not null check (kind in ('proof','attachment','voice')),
  storage_path text not null,
  mime text,
  size_bytes integer
);
select app.standardize('task_attachments');

create table public.task_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  actor_id uuid references public.staff(id) on delete set null,
  event text not null,
  from_status text,
  to_status text,
  data jsonb not null default '{}'::jsonb
);
select app.standardize('task_events');
create index idx_task_events_task on public.task_events(task_id);

-- ---------------------------------------------------------------- checklists (5.2)
create table public.checklist_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  key text,
  name text not null,
  name_i18n jsonb not null default '{}'::jsonb,
  schedule jsonb not null default '{"frequency":"daily","time":"08:00"}'::jsonb,
  owner_role_id uuid references public.roles(id) on delete set null,
  owner_staff_id uuid references public.staff(id) on delete set null,
  room_id uuid references public.rooms(id) on delete set null,
  location_text text,
  active boolean not null default true
);
select app.standardize('checklist_templates');

create table public.checklist_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  template_id uuid not null references public.checklist_templates(id) on delete cascade,
  seq integer not null default 1,
  label text not null,
  label_i18n jsonb not null default '{}'::jsonb,
  item_type text not null check (item_type in ('tick','yesno','number','photo','text')),
  min_value numeric,
  max_value numeric,
  required boolean not null default true,
  on_fail jsonb    -- {"action":"ticket","ticket_category_key":"electrical"} | {"action":"task","role_key":"admin_officer"}
);
select app.standardize('checklist_items');

create table public.checklist_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  template_id uuid not null references public.checklist_templates(id) on delete cascade,
  owner_id uuid references public.staff(id) on delete set null,
  run_date date not null,
  due_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending','in_progress','completed','missed')),
  completed_at timestamptz,
  escalated_at timestamptz,
  unique (template_id, run_date)
);
select app.standardize('checklist_runs');
create index idx_checklist_runs_owner on public.checklist_runs(owner_id, run_date);

create table public.checklist_responses (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  run_id uuid not null references public.checklist_runs(id) on delete cascade,
  item_id uuid not null references public.checklist_items(id) on delete cascade,
  value jsonb,
  passed boolean not null default true,
  photo_path text,
  note text,
  follow_up_type text,
  follow_up_id uuid,
  unique (run_id, item_id)
);
select app.standardize('checklist_responses');

-- ---------------------------------------------------------------- timetable (5.3)
create table public.bell_schedules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  wing_id uuid references public.wings(id) on delete cascade,
  name text not null,
  days integer[] not null default '{1,2,3,4,5,6}',
  active boolean not null default true
);
select app.standardize('bell_schedules');

create table public.periods (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  bell_schedule_id uuid not null references public.bell_schedules(id) on delete cascade,
  seq integer not null,
  label text not null,
  kind text not null default 'period' check (kind in ('period','break','assembly')),
  starts_at time not null,
  ends_at time not null,
  teaching_index integer,    -- 1..n for kind = period
  unique (bell_schedule_id, seq),
  check (ends_at > starts_at)
);
select app.standardize('periods');

create table public.teacher_allocations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  academic_year_id uuid references public.academic_years(id) on delete cascade,
  staff_id uuid not null references public.staff(id) on delete cascade,
  section_id uuid not null references public.sections(id) on delete cascade,
  subject_id uuid not null references public.subjects(id) on delete cascade,
  periods_per_week integer not null check (periods_per_week between 0 and 60),
  double_periods integer not null default 0,
  co_teacher_id uuid references public.staff(id) on delete set null,
  group_key text,      -- split groups: same group_key + same section -> scheduled in parallel
  combined_key text,   -- combined sections: same combined_key -> one lesson for several sections
  room_type text,
  unique (section_id, subject_id, staff_id)
);
select app.standardize('teacher_allocations');

create table public.timetable_constraints (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  kind text not null check (kind in ('teacher_unavailable','fixed_slot','section_unavailable','room_unavailable')),
  data jsonb not null
);
select app.standardize('timetable_constraints');

create table public.timetable_versions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  academic_year_id uuid references public.academic_years(id) on delete cascade,
  name text not null,
  status text not null default 'draft' check (status in ('draft','generating','generated','published','archived','failed')),
  effective_from date,
  generated_at timestamptz,
  unplaced jsonb not null default '[]'::jsonb,
  score numeric,
  job_id uuid,
  based_on_version_id uuid references public.timetable_versions(id) on delete set null
);
select app.standardize('timetable_versions');

create table public.timetable_entries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  version_id uuid not null references public.timetable_versions(id) on delete cascade,
  day integer not null check (day between 1 and 7),
  period_seq integer not null,
  section_id uuid not null references public.sections(id) on delete cascade,
  subject_id uuid references public.subjects(id) on delete set null,
  staff_id uuid references public.staff(id) on delete set null,
  room_id uuid references public.rooms(id) on delete set null,
  locked boolean not null default false,
  group_key text,
  fixed_label text
);
select app.standardize('timetable_entries');
create index idx_tt_entries_version_day on public.timetable_entries(version_id, day, period_seq);
create index idx_tt_entries_staff on public.timetable_entries(staff_id);

-- ---------------------------------------------------------------- leave, attendance (5.5, 5.6)
create table public.leave_types (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  key text not null,
  name text not null,
  name_i18n jsonb not null default '{}'::jsonb,
  unit text not null default 'day' check (unit in ('day','hour')),
  yearly_quota numeric(6,2) not null default 0,
  accrual text not null default 'yearly' check (accrual in ('yearly','monthly')),
  carry_forward boolean not null default false,
  carry_forward_max numeric(6,2) not null default 0,
  half_day_allowed boolean not null default true,
  notice_days integer not null default 0,
  doc_required_after_days integer,
  sandwich_rule boolean not null default false,
  paid boolean not null default true,
  active boolean not null default true,
  unique (org_id, key)
);
select app.standardize('leave_types');

create table public.leave_balances (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  staff_id uuid not null references public.staff(id) on delete cascade,
  leave_type_id uuid not null references public.leave_types(id) on delete cascade,
  academic_year_id uuid not null references public.academic_years(id) on delete cascade,
  opening numeric(6,2) not null default 0,
  adjusted numeric(6,2) not null default 0,
  unique (staff_id, leave_type_id, academic_year_id)
);
select app.standardize('leave_balances');

create table public.leave_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  staff_id uuid not null references public.staff(id) on delete cascade,
  leave_type_id uuid not null references public.leave_types(id) on delete restrict,
  start_date date not null,
  end_date date not null,
  half_day text not null default 'none' check (half_day in ('none','first','second')),
  hours numeric(5,2),
  days numeric(6,2) not null default 0,
  reason text,
  attachment_path text,
  handover_note text,
  status text not null default 'pending' check (status in ('pending','approved','rejected','returned','cancelled')),
  approval_request_id uuid,
  parent_request_id uuid references public.leave_requests(id) on delete set null,
  decided_at timestamptz,
  check (end_date >= start_date)
);
select app.standardize('leave_requests');
create index idx_leave_requests_staff on public.leave_requests(staff_id, start_date);

create table public.attendance_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  position_id uuid references public.positions(id) on delete cascade,
  shift_start time not null default '08:00',
  shift_end time not null default '15:30',
  grace_minutes integer not null default 10,
  half_day_after_minutes integer not null default 120,
  early_exit_minutes integer not null default 30,
  checkin_cutoff time not null default '08:30',
  selfie_retention_days integer not null default 90,
  student_cutoff time not null default '09:30',
  student_edit_window_minutes integer not null default 120,
  student_threshold_pct numeric(5,2) not null default 75,
  parent_absent_alert boolean not null default false,
  unique (branch_id, position_id)
);
select app.standardize('attendance_rules');

create table public.attendance_imports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  device_type text not null,
  mapping jsonb not null,
  file_name text,
  rows_total integer not null default 0,
  rows_merged integer not null default 0,
  conflicts jsonb not null default '[]'::jsonb,
  errors jsonb not null default '[]'::jsonb,
  status text not null default 'done'
);
select app.standardize('attendance_imports');

create table public.staff_attendance (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  staff_id uuid not null references public.staff(id) on delete cascade,
  date date not null,
  check_in_at timestamptz,
  check_out_at timestamptz,
  check_in_lat double precision,
  check_in_lng double precision,
  check_in_distance_m integer,
  selfie_path text,
  source text not null default 'app' check (source in ('app','biometric','merged','manual','regularised')),
  status text not null default 'present' check (status in ('present','late','half_day','absent','on_leave','holiday')),
  late_minutes integer not null default 0,
  early_exit boolean not null default false,
  conflict jsonb,
  import_id uuid references public.attendance_imports(id) on delete set null,
  unique (staff_id, date)
);
select app.standardize('staff_attendance');

create table public.student_attendance_sessions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  section_id uuid not null references public.sections(id) on delete cascade,
  date date not null,
  session_key text not null default 'day',   -- 'day' | 'am' | 'pm' | 'p<seq>'
  marked_by uuid references public.staff(id) on delete set null,
  status text not null default 'submitted' check (status in ('draft','submitted')),
  submitted_at timestamptz,
  edit_reason text,
  edit_approval_request_id uuid,
  client_id text,                            -- offline outbox idempotency
  unique (section_id, date, session_key)
);
select app.standardize('student_attendance_sessions');

create table public.student_attendance_marks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  session_id uuid not null references public.student_attendance_sessions(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
  status text not null default 'present' check (status in ('present','absent','late','half_day','on_duty','leave')),
  note text,
  unique (session_id, student_id)
);
select app.standardize('student_attendance_marks');

-- ---------------------------------------------------------------- approvals (5.6)
create table public.approval_types (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  key text not null,
  name text not null,
  name_i18n jsonb not null default '{}'::jsonb,
  form_schema jsonb not null default '[]'::jsonb,     -- [{key,label,type,required,options}]
  task_template jsonb,                                -- tasks created on approval
  is_system boolean not null default false,
  active boolean not null default true,
  unique (org_id, key)
);
select app.standardize('approval_types');

create table public.approval_flows (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  approval_type_id uuid not null references public.approval_types(id) on delete cascade,
  applicant_role_id uuid references public.roles(id) on delete cascade,   -- null = any role
  name text not null
);
select app.standardize('approval_flows');

create table public.approval_steps (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  flow_id uuid not null references public.approval_flows(id) on delete cascade,
  seq integer not null,
  approver_kind text not null check (approver_kind in ('role','manager_of_applicant','staff')),
  approver_role_id uuid references public.roles(id) on delete set null,
  approver_staff_id uuid references public.staff(id) on delete set null,
  condition jsonb,                 -- {"field":"amount","op":">","value":10000}
  parallel_group integer,          -- steps sharing seq + parallel_group are parallel
  time_limit_hours integer not null default 48,
  unique (flow_id, seq, approver_kind, approver_role_id)
);
select app.standardize('approval_steps');

create table public.approval_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  approval_type_id uuid not null references public.approval_types(id) on delete restrict,
  flow_id uuid references public.approval_flows(id) on delete set null,
  applicant_id uuid not null references public.staff(id) on delete cascade,
  title text not null,
  data jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending','approved','rejected','returned','cancelled')),
  current_seq integer not null default 1,
  pending_approver_ids uuid[] not null default '{}',
  step_due_at timestamptz,
  linked_type text,
  linked_id uuid,
  decided_at timestamptz
);
select app.standardize('approval_requests');
create index idx_approval_requests_pending on public.approval_requests using gin (pending_approver_ids);

create table public.approval_actions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  request_id uuid not null references public.approval_requests(id) on delete cascade,
  step_seq integer,
  actor_id uuid references public.staff(id) on delete set null,
  action text not null check (action in ('submit','approve','reject','return','forward','escalate','resubmit','cancel')),
  comment text,
  forwarded_to uuid references public.staff(id) on delete set null
);
select app.standardize('approval_actions');

alter table public.leave_requests add constraint fk_leave_approval foreign key (approval_request_id) references public.approval_requests(id) on delete set null;
alter table public.student_attendance_sessions add constraint fk_sas_approval foreign key (edit_approval_request_id) references public.approval_requests(id) on delete set null;

-- ---------------------------------------------------------------- substitution (5.4)
create table public.substitutions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  date date not null,
  day integer not null,
  period_seq integer not null,
  section_id uuid not null references public.sections(id) on delete cascade,
  subject_id uuid references public.subjects(id) on delete set null,
  absent_staff_id uuid not null references public.staff(id) on delete cascade,
  substitute_staff_id uuid references public.staff(id) on delete set null,
  status text not null default 'suggested' check (status in ('suggested','assigned','uncovered','resolved_other','cancelled')),
  resolution text check (resolution in ('substitute','combine','library','games','supervision')),
  source text not null check (source in ('leave','absence','manual')),
  leave_request_id uuid references public.leave_requests(id) on delete set null,
  timetable_entry_id uuid references public.timetable_entries(id) on delete set null,
  ranked jsonb not null default '[]'::jsonb,
  cover_plan_id uuid,
  task_id uuid references public.tasks(id) on delete set null,
  notified_at timestamptz,
  unique (date, period_seq, section_id, absent_staff_id)
);
select app.standardize('substitutions');
create index idx_substitutions_sub on public.substitutions(substitute_staff_id, date);
