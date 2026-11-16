-- Administrative modules (section 7) and platform tables (section 8).

create table public.ticket_categories (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  key text not null,
  name text not null,
  name_i18n jsonb not null default '{}'::jsonb,
  owner_role_id uuid references public.roles(id) on delete set null,
  owner_staff_id uuid references public.staff(id) on delete set null,
  sla_hours jsonb not null default '{"low":72,"normal":48,"high":24,"urgent":4}'::jsonb,
  cost_approval_limit numeric not null default 5000,
  unique (org_id, key)
);
select app.standardize('ticket_categories');

create table public.tickets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  category_id uuid not null references public.ticket_categories(id) on delete restrict,
  room_id uuid references public.rooms(id) on delete set null,
  location_text text,
  title text not null,
  description text,
  priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  status text not null default 'open' check (status in ('open','assigned','in_progress','waiting','resolved','closed','reopened')),
  raised_by uuid references public.staff(id) on delete set null,
  owner_id uuid references public.staff(id) on delete set null,
  photo_path text,
  voice_path text,
  vendor text,
  cost numeric,
  parts text,
  asset_tag text,
  due_at timestamptz,
  resolved_at timestamptz,
  closed_at timestamptz,
  source text not null default 'manual' check (source in ('manual','checklist','qr')),
  checklist_response_id uuid references public.checklist_responses(id) on delete set null,
  approval_request_id uuid references public.approval_requests(id) on delete set null
);
select app.standardize('tickets');
create index idx_tickets_owner on public.tickets(owner_id, status);

create table public.ticket_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  actor_id uuid references public.staff(id) on delete set null,
  event text not null,
  from_status text,
  to_status text,
  note text
);
select app.standardize('ticket_events');

create table public.circulars (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  author_id uuid references public.staff(id) on delete set null,
  title text not null,
  body text not null,
  attachments jsonb not null default '[]'::jsonb,
  target jsonb not null default '{}'::jsonb,    -- {branch_ids,wing_ids,department_ids,role_ids,staff_ids}
  response_mode text not null default 'read' check (response_mode in ('read','acknowledge','reply')),
  reply_form jsonb,
  important boolean not null default false,
  tags text[] not null default '{}',
  scheduled_at timestamptz,
  sent_at timestamptz,
  reminder_after_hours integer not null default 24,
  status text not null default 'draft' check (status in ('draft','scheduled','sent'))
);
select app.standardize('circulars');

create table public.circular_receipts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  circular_id uuid not null references public.circulars(id) on delete cascade,
  staff_id uuid not null references public.staff(id) on delete cascade,
  read_at timestamptz,
  acknowledged_at timestamptz,
  reply jsonb,
  reminded_at timestamptz,
  unique (circular_id, staff_id)
);
select app.standardize('circular_receipts');

create table public.calendar_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,   -- null = group-level, applies to all branches
  layer text not null check (layer in ('holiday','exam','event','ptm','staff_meeting','training','deadline')),
  title text not null,
  starts_on date not null,
  ends_on date not null,
  starts_at time,
  ends_at time,
  is_working_day boolean not null default true,
  linked_type text,
  linked_id uuid,
  check (ends_on >= starts_on)
);
select app.standardize('calendar_events');
create index idx_calendar_events_dates on public.calendar_events(starts_on, ends_on);

create table public.meetings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  series_id uuid,
  previous_meeting_id uuid references public.meetings(id) on delete set null,
  title text not null,
  agenda text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  room_id uuid references public.rooms(id) on delete set null,
  organizer_id uuid references public.staff(id) on delete set null,
  attendee_ids uuid[] not null default '{}',
  attendance jsonb not null default '{}'::jsonb,
  recurrence jsonb,
  minutes text,
  status text not null default 'scheduled' check (status in ('scheduled','held','cancelled'))
);
select app.standardize('meetings');

create table public.meeting_actions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  meeting_id uuid not null references public.meetings(id) on delete cascade,
  description text not null,
  owner_id uuid references public.staff(id) on delete set null,
  due_on date,
  task_id uuid references public.tasks(id) on delete set null
);
select app.standardize('meeting_actions');

create table public.event_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  key text not null,
  name text not null,
  name_i18n jsonb not null default '{}'::jsonb,
  task_pack jsonb not null default '[]'::jsonb,     -- [{title, role_key, days_before, priority}]
  committees jsonb not null default '[]'::jsonb,
  checklist jsonb not null default '[]'::jsonb,
  budget_lines jsonb not null default '[]'::jsonb,
  unique (org_id, key)
);
select app.standardize('event_templates');

create table public.events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  template_id uuid references public.event_templates(id) on delete set null,
  name text not null,
  event_date date not null,
  owner_id uuid references public.staff(id) on delete set null,
  status text not null default 'planning' check (status in ('planning','ready','held','reviewed','cancelled')),
  committees jsonb not null default '[]'::jsonb,
  budget jsonb not null default '[]'::jsonb,
  budget_approval_request_id uuid references public.approval_requests(id) on delete set null,
  review jsonb
);
select app.standardize('events');

create table public.duty_types (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  key text not null,
  name text not null,
  name_i18n jsonb not null default '{}'::jsonb,
  location text,
  starts_at time not null,
  ends_at time not null,
  overlaps_period_seq integer,     -- teaching period this duty overlaps, if any
  staff_needed integer not null default 1,
  days integer[] not null default '{1,2,3,4,5,6}',
  unique (org_id, key)
);
select app.standardize('duty_types');

create table public.duty_assignments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  duty_type_id uuid not null references public.duty_types(id) on delete cascade,
  staff_id uuid not null references public.staff(id) on delete cascade,
  date date not null,
  status text not null default 'assigned' check (status in ('assigned','done','missed','swapped')),
  swap_with_id uuid references public.staff(id) on delete set null,
  swap_approval_request_id uuid references public.approval_requests(id) on delete set null,
  reminded_at timestamptz,
  manual boolean not null default false,
  unique (duty_type_id, date, staff_id)
);
select app.standardize('duty_assignments');

create table public.incidents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  type text not null check (type in ('discipline','injury','parent_complaint','safety','property','ptm_note')),
  student_ids uuid[] not null default '{}',
  staff_ids uuid[] not null default '{}',
  room_id uuid references public.rooms(id) on delete set null,
  location_text text,
  occurred_at timestamptz not null,
  description text not null,
  action_taken text,
  severity text not null default 'low' check (severity in ('low','medium','high','critical')),
  confidential boolean not null default false,
  owner_id uuid references public.staff(id) on delete set null,
  reported_by uuid references public.staff(id) on delete set null,
  status text not null default 'open' check (status in ('open','follow_up','closed'))
);
select app.standardize('incidents');

create table public.compliance_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  name text not null,
  category text not null,
  owner_id uuid references public.staff(id) on delete set null,
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
select app.standardize('compliance_items');

-- ---------------------------------------------------------------- platform: notifications, jobs, audit
create table public.notification_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  event_key text not null,
  channels text[] not null default '{inapp,push}',
  recipients text[] not null default '{target}',
  optional boolean not null default true,
  urgent boolean not null default false,
  whatsapp_template text,
  enabled boolean not null default true,
  unique (org_id, event_key)
);
select app.standardize('notification_rules');

create table public.notification_prefs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  staff_id uuid not null references public.staff(id) on delete cascade,
  event_key text not null,
  muted boolean not null default true,
  unique (staff_id, event_key)
);
select app.standardize('notification_prefs');

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  staff_id uuid not null references public.staff(id) on delete cascade,
  event_key text not null,
  title text not null,
  body text,
  link text,
  data jsonb not null default '{}'::jsonb,
  priority text not null default 'normal',
  channels text[] not null default '{inapp}',
  deliver_after timestamptz not null default now(),
  push_status text,
  whatsapp_status text,
  read_at timestamptz,
  dedupe_key text
);
select app.standardize('notifications');
create index idx_notifications_staff on public.notifications(staff_id, read_at);
create unique index uq_notifications_dedupe on public.notifications(staff_id, dedupe_key) where dedupe_key is not null;

create table public.device_tokens (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  staff_id uuid not null references public.staff(id) on delete cascade,
  token text not null unique,
  platform text not null check (platform in ('android','ios','web')),
  device_name text,
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz
);
select app.standardize('device_tokens');

create table public.message_usage (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  channel text not null default 'whatsapp',
  template_key text not null,
  notification_id uuid references public.notifications(id) on delete set null,
  status text not null,
  units integer not null default 1,
  provider_ref text
);
select app.standardize('message_usage');

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  run_at timestamptz not null default now(),
  status text not null default 'queued' check (status in ('queued','running','done','failed','dead')),
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  last_error text,
  dedupe_key text unique,
  locked_at timestamptz,
  finished_at timestamptz,
  result jsonb
);
select app.standardize('jobs');
create index idx_jobs_queue on public.jobs(status, run_at);

create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  org_id uuid,   -- no FK: audit rows must survive (and be writable during) org deletion
  branch_id uuid,
  actor_user_id uuid,
  actor_staff_id uuid,
  table_name text not null,
  row_id uuid,
  op text not null,
  before jsonb,
  after jsonb,
  device text,
  at timestamptz not null default now()
);
select app.standardize('audit_log');
create index idx_audit_log_row on public.audit_log(table_name, row_id);

create table public.saved_reports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  owner_id uuid references public.staff(id) on delete cascade,
  name text not null,
  dataset text not null,
  config jsonb not null,
  shared_role_ids uuid[] not null default '{}'
);
select app.standardize('saved_reports');

create table public.report_schedules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  report_key text not null,             -- catalogue key or 'saved:<id>'
  saved_report_id uuid references public.saved_reports(id) on delete cascade,
  frequency text not null default 'daily' check (frequency in ('daily','weekly','monthly')),
  send_time time not null default '07:30',
  weekday integer,
  recipient_ids uuid[] not null default '{}',
  channel text not null default 'inapp' check (channel in ('inapp','email','whatsapp_link')),
  last_run_at timestamptz,
  active boolean not null default true
);
select app.standardize('report_schedules');

-- ---------------------------------------------------------------- AI, plans, help bot
create table public.branch_subscriptions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  plan_id uuid not null references public.plans(id) on delete restrict,
  starts_on date not null,
  ends_on date,
  monthly_credits_override numeric(12,2),
  teacher_monthly_cap numeric(10,2),
  status text not null default 'active' check (status in ('active','paused','ended'))
);
select app.standardize('branch_subscriptions');

create table public.ai_generations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  staff_id uuid references public.staff(id) on delete set null,
  action text not null,
  model text not null,
  provider text not null,
  input jsonb not null,
  output jsonb,
  status text not null check (status in ('ok','invalid','failed','blocked')),
  attempts integer not null default 1,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  provider_cost numeric(12,6) not null default 0,
  credits numeric(10,2) not null default 0,
  error text,
  linked_type text,
  linked_id uuid
);
select app.standardize('ai_generations');

create table public.ai_credit_ledger (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  staff_id uuid references public.staff(id) on delete set null,
  kind text not null check (kind in ('allowance','usage','topup','adjustment','expiry')),
  action text,
  period text not null,            -- YYYY-MM
  credits numeric(10,2) not null,  -- positive adds, negative consumes
  generation_id uuid references public.ai_generations(id) on delete set null,
  tokens integer not null default 0,
  provider_cost numeric(12,6) not null default 0,
  note text
);
select app.standardize('ai_credit_ledger');
create index idx_ai_credit_ledger_period on public.ai_credit_ledger(branch_id, period);
create unique index uq_ai_allowance_period on public.ai_credit_ledger(branch_id, period) where kind = 'allowance';

create table public.credit_topup_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  requested_by uuid references public.staff(id) on delete set null,
  credits numeric(10,2) not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  note text
);
select app.standardize('credit_topup_requests');

create table public.kb_articles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations(id) on delete cascade,   -- null = AutoEd article
  branch_id uuid references public.branches(id) on delete cascade,
  slug text not null,
  language text not null check (language in ('en','hi','te')),
  title text not null,
  body text not null,
  screen_path text,
  module_key text,
  role_keys text[] not null default '{}',
  tags text[] not null default '{}'
);
select app.standardize('kb_articles');
create unique index uq_kb_articles on public.kb_articles(coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid), slug, language);

create table public.kb_chunks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  article_id uuid not null references public.kb_articles(id) on delete cascade,
  language text not null,
  seq integer not null,
  content text not null,
  embedding vector(256),
  tsv tsvector generated always as (to_tsvector('simple', content)) stored
);
select app.standardize('kb_chunks');
create index idx_kb_chunks_tsv on public.kb_chunks using gin (tsv);

create table public.bot_conversations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  staff_id uuid not null references public.staff(id) on delete cascade,
  language text not null default 'en',
  screen_path text,
  messages jsonb not null default '[]'::jsonb,
  status text not null default 'open' check (status in ('open','answered','unanswered','escalated'))
);
select app.standardize('bot_conversations');

create table public.bot_feedback (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  conversation_id uuid not null references public.bot_conversations(id) on delete cascade,
  staff_id uuid references public.staff(id) on delete set null,
  message_index integer not null,
  rating integer not null check (rating in (-1, 1)),
  question text,
  comment text
);
select app.standardize('bot_feedback');

create table public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  staff_id uuid references public.staff(id) on delete set null,
  subject text not null,
  body text,
  conversation_id uuid references public.bot_conversations(id) on delete set null,
  status text not null default 'open' check (status in ('open','in_progress','closed'))
);
select app.standardize('support_tickets');

create table public.view_as_sessions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  admin_user_id uuid not null,
  reason text not null,
  starts_at timestamptz not null default now(),
  expires_at timestamptz not null
);
select app.standardize('view_as_sessions');
