-- AutoEd CRM port (2/6): families, prospects, enquiries and everything that hangs off an enquiry.
-- Pre-admission families live here, NOT in core (decision 38, OQ-4): crm.households / crm.guardians / crm.prospects
-- are copied into core.households / guardians / students by core.admit_student() when the enquiry reaches the
-- stage flagged is_won ("Admission confirmed"). The *_core_* back-link columns carry no foreign key.

-- Families. Address and language are copied to core.households on admission.
create table crm.households (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  address text,
  locality text,
  pincode text,
  home_language text,
  sibling_in_school boolean not null default false,
  heard_about text,
  inbox_status text not null default 'closed' check (inbox_status in ('open','closed')),
  core_household_id uuid,                            -- set on admission, no FK (OQ-4)
  created_at timestamptz not null default now(),
  created_by uuid default app.uid(),
  updated_at timestamptz not null default now(),
  unique (org_id, id)
);
create trigger trg_touch before update on crm.households for each row execute function app.touch_updated_at();

create table crm.guardians (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  household_id uuid not null,
  name text not null,
  relation text not null default 'guardian' check (relation in ('father','mother','guardian','other')),
  phone text not null,                               -- ten-digit Indian mobile, unique per client
  alt_phone text,
  email text,
  occupation text,
  is_primary boolean not null default true,
  language text not null default 'en',               -- language code; consents are rows in core.consents (crm_guardian)
  core_guardian_id uuid,                             -- set on admission, no FK
  created_at timestamptz not null default now(),
  created_by uuid default app.uid(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, phone),
  foreign key (org_id, household_id) references crm.households(org_id, id) on delete cascade
);
create index guardians_household on crm.guardians(org_id, household_id);
create index guardians_email on crm.guardians(org_id, lower(email));
create trigger trg_touch before update on crm.guardians for each row execute function app.touch_updated_at();

-- The CRM-owned child record (CRM `students`). Never readable by OS/ERP roles; becomes core.students on admission.
create table crm.prospects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  household_id uuid not null,
  first_name text not null,
  last_name text,
  full_name text generated always as (btrim(first_name || coalesce(' ' || last_name, ''))) stored,
  dob date,
  gender text check (gender is null or gender in ('female','male','other')),
  current_school text,
  current_grade text,
  special_needs text,
  core_student_id uuid,                              -- set on admission, no FK
  created_at timestamptz not null default now(),
  created_by uuid default app.uid(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, household_id) references crm.households(org_id, id) on delete cascade
);
create index prospects_household on crm.prospects(org_id, household_id);
create index prospects_name on crm.prospects(org_id, full_name);
create trigger trg_touch before update on crm.prospects for each row execute function app.touch_updated_at();

create table crm.enquiries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  household_id uuid not null,
  prospect_id uuid not null,
  branch_id uuid not null,
  academic_year_id uuid not null,
  programme_id uuid,                                 -- core.programmes row when one matches (board + grade text kept below)
  board text,
  grade text,
  stage_id uuid not null,
  owner_id uuid not null,                            -- auth user id of the counsellor (RLS "own" scope)
  score integer not null default 0,
  engagement integer not null default 0,
  temperature text check (temperature is null or temperature in ('Hot','Warm','Cold')),
  expected_decision date,
  closure_reason text,
  custom jsonb not null default '{}',                -- sensitive values are replaced by a placeholder, see crm.enquiry_sensitive
  tags jsonb not null default '[]',
  application_no text,
  public_token text not null unique default replace(gen_random_uuid()::text, '-', ''),
  reenquired boolean not null default false,
  first_response_at timestamptz,
  last_activity_at timestamptz,
  stage_entered_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  created_by uuid default app.uid(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, prospect_id, academic_year_id, branch_id),
  foreign key (org_id, household_id) references crm.households(org_id, id) on delete cascade,
  foreign key (org_id, prospect_id) references crm.prospects(org_id, id) on delete cascade,
  foreign key (org_id, branch_id) references core.branches(org_id, id),
  foreign key (org_id, academic_year_id) references core.academic_years(org_id, id),
  foreign key (org_id, programme_id) references core.programmes(org_id, id),
  foreign key (org_id, stage_id) references crm.stages(org_id, id),
  foreign key (org_id, owner_id) references core.org_users(org_id, user_id)
);
create index enquiries_list on crm.enquiries(org_id, academic_year_id, branch_id, stage_id);
create index enquiries_owner on crm.enquiries(org_id, owner_id);
create index enquiries_household on crm.enquiries(org_id, household_id);
create index enquiries_prospect on crm.enquiries(org_id, prospect_id);
create index enquiries_programme on crm.enquiries(org_id, programme_id);
create trigger trg_touch before update on crm.enquiries for each row execute function app.touch_updated_at();

-- Values of custom fields flagged sensitive (crm.field_settings). Readable only with module `sensitive` (view).
-- The FK is deferred because crm.trg_enquiry_sensitive writes this row from a BEFORE trigger of the enquiry.
create table crm.enquiry_sensitive (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid,
  enquiry_id uuid not null,
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  created_by uuid default app.uid(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, enquiry_id),
  foreign key (org_id, branch_id) references core.branches(org_id, id),
  foreign key (org_id, enquiry_id) references crm.enquiries(org_id, id) on delete cascade deferrable initially deferred
);
create trigger trg_touch before update on crm.enquiry_sensitive for each row execute function app.touch_updated_at();

create table crm.source_touches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  enquiry_id uuid not null,
  source_id uuid,
  channel text,
  source text,
  campaign text,
  utm jsonb not null default '{}',
  created_at timestamptz not null default now(),
  created_by uuid default app.uid(),
  unique (org_id, id),
  foreign key (org_id, enquiry_id) references crm.enquiries(org_id, id) on delete cascade,
  foreign key (org_id, source_id) references crm.sources(org_id, id) on delete set null (source_id)
);
create index source_touches_enquiry on crm.source_touches(org_id, enquiry_id);
create index source_touches_source on crm.source_touches(org_id, source_id);

create table crm.activities (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  household_id uuid not null,
  enquiry_id uuid,
  type text not null,
  actor_id uuid,                                     -- auth user id; null = system
  outcome text,
  content text,
  meta jsonb not null default '{}',
  created_at timestamptz not null default now(),
  created_by uuid default app.uid(),
  unique (org_id, id),
  foreign key (org_id, household_id) references crm.households(org_id, id) on delete cascade,
  foreign key (org_id, enquiry_id) references crm.enquiries(org_id, id) on delete cascade
);
create index activities_household on crm.activities(org_id, household_id, created_at desc);
create index activities_enquiry on crm.activities(org_id, enquiry_id, created_at desc);

-- CRM `tasks` (renamed: os.tasks is the OS task engine).
create table crm.follow_ups (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  enquiry_id uuid,
  household_id uuid,
  type text not null default 'call_back',
  title text not null,
  due_at timestamptz not null,
  owner_id uuid not null,
  priority text not null default 'normal' check (priority in ('low','normal','high')),
  status text not null default 'open' check (status in ('open','done','cancelled')),
  outcome text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid default app.uid(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, enquiry_id) references crm.enquiries(org_id, id) on delete cascade,
  foreign key (org_id, household_id) references crm.households(org_id, id) on delete cascade,
  foreign key (org_id, owner_id) references core.org_users(org_id, user_id)
);
create index follow_ups_owner on crm.follow_ups(org_id, owner_id, status, due_at);
create index follow_ups_enquiry on crm.follow_ups(org_id, enquiry_id, status);
create trigger trg_touch before update on crm.follow_ups for each row execute function app.touch_updated_at();

create table crm.visits (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  enquiry_id uuid not null,
  household_id uuid not null,
  branch_id uuid not null,
  type text not null default 'campus_tour',
  slot_at timestamptz not null,
  host_id uuid,
  status text not null default 'scheduled' check (status in ('scheduled','done','no_show','cancelled')),
  checked_in_at timestamptz,
  outcome text,
  created_at timestamptz not null default now(),
  created_by uuid default app.uid(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, enquiry_id) references crm.enquiries(org_id, id) on delete cascade,
  foreign key (org_id, household_id) references crm.households(org_id, id) on delete cascade,
  foreign key (org_id, branch_id) references core.branches(org_id, id),
  foreign key (org_id, host_id) references core.org_users(org_id, user_id) on delete set null (host_id)
);
create index visits_enquiry on crm.visits(org_id, enquiry_id);
create index visits_branch on crm.visits(org_id, branch_id, slot_at);
create index visits_household on crm.visits(org_id, household_id);
create index visits_host on crm.visits(org_id, host_id);
create trigger trg_touch before update on crm.visits for each row execute function app.touch_updated_at();

create table crm.applications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  enquiry_id uuid not null,
  progress integer not null default 0 check (progress between 0 and 100),
  answers jsonb not null default '{}',
  declaration boolean not null default false,
  status text not null default 'started' check (status in ('started','submitted')),
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid default app.uid(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, enquiry_id),
  foreign key (org_id, enquiry_id) references crm.enquiries(org_id, id) on delete cascade
);
create trigger trg_touch before update on crm.applications for each row execute function app.touch_updated_at();

create table crm.enquiry_documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  enquiry_id uuid not null,
  type text not null,
  status text not null default 'pending' check (status in ('pending','uploaded','verified','rejected')),
  file_id uuid,                                      -- core.files row once a binary is stored (none exists in the CRM today)
  file_name text,
  reject_reason text,
  verifier_id uuid,
  created_at timestamptz not null default now(),
  created_by uuid default app.uid(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, enquiry_id) references crm.enquiries(org_id, id) on delete cascade,
  foreign key (org_id, file_id) references core.files(org_id, id),
  foreign key (org_id, verifier_id) references core.org_users(org_id, user_id) on delete set null (verifier_id)
);
create index enquiry_documents_enquiry on crm.enquiry_documents(org_id, enquiry_id);
create index enquiry_documents_file on crm.enquiry_documents(org_id, file_id);
create trigger trg_touch before update on crm.enquiry_documents for each row execute function app.touch_updated_at();

-- Registration / admission fees collected before the student exists (OQ-16: stays in the CRM).
-- receipt_no comes from core.number_series key crm_receipt (crm.next_number).
create table crm.payments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  enquiry_id uuid not null,
  purpose text not null,
  amount numeric(12,2) not null check (amount >= 0),
  mode text not null default 'link',
  reference text,
  status text not null default 'pending' check (status in ('pending','paid','failed','refunded')),
  receipt_no text,
  verified_by uuid,
  token text not null unique default replace(gen_random_uuid()::text, '-', ''),
  created_at timestamptz not null default now(),
  created_by uuid default app.uid(),
  updated_at timestamptz not null default now(),
  paid_at timestamptz,
  unique (org_id, id),
  foreign key (org_id, enquiry_id) references crm.enquiries(org_id, id) on delete cascade,
  foreign key (org_id, verified_by) references core.org_users(org_id, user_id) on delete set null (verified_by)
);
create index payments_enquiry on crm.payments(org_id, enquiry_id);
create unique index payments_receipt on crm.payments(org_id, receipt_no) where receipt_no is not null;
create trigger trg_touch before update on crm.payments for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------- RLS
-- enquiries: the lead-scope policies (own / team / branch / org, per-branch switch), see crm.apply_rls_enquiries.
select crm.apply_rls_enquiries();

-- household visible: some visible enquiry belongs to it (RLS of crm.enquiries applies inside the subquery), or the
-- caller created the row (a family is inserted before its first enquiry, and INSERT ... RETURNING needs the row visible).
select crm.apply_rls_scoped('households', 'leads',
  'crm.households.created_by = app.uid() or exists (select 1 from crm.enquiries e where e.org_id = crm.households.org_id and e.household_id = crm.households.id)');
select crm.apply_rls_scoped('guardians', 'leads',
  'crm.guardians.created_by = app.uid() or exists (select 1 from crm.enquiries e where e.org_id = crm.guardians.org_id and e.household_id = crm.guardians.household_id)');
select crm.apply_rls_scoped('prospects', 'leads',
  'crm.prospects.created_by = app.uid() or exists (select 1 from crm.enquiries e where e.org_id = crm.prospects.org_id and e.household_id = crm.prospects.household_id)');

-- rows hanging off an enquiry follow the enquiry
select crm.apply_rls_scoped('source_touches', 'leads',
  'exists (select 1 from crm.enquiries e where e.org_id = crm.source_touches.org_id and e.id = crm.source_touches.enquiry_id)');
select crm.apply_rls_scoped('activities', 'leads',
  'exists (select 1 from crm.enquiries e where e.org_id = crm.activities.org_id and e.household_id = crm.activities.household_id)');
select crm.apply_rls_scoped('follow_ups', 'tasks',
  'exists (select 1 from crm.enquiries e where e.org_id = crm.follow_ups.org_id and e.id = crm.follow_ups.enquiry_id) or (crm.follow_ups.enquiry_id is null and crm.follow_ups.owner_id = app.uid())');
select crm.apply_rls_scoped('visits', 'tasks',
  'exists (select 1 from crm.enquiries e where e.org_id = crm.visits.org_id and e.id = crm.visits.enquiry_id)');
select crm.apply_rls_scoped('applications', 'applications',
  'exists (select 1 from crm.enquiries e where e.org_id = crm.applications.org_id and e.id = crm.applications.enquiry_id)');
select crm.apply_rls_scoped('enquiry_documents', 'applications',
  'exists (select 1 from crm.enquiries e where e.org_id = crm.enquiry_documents.org_id and e.id = crm.enquiry_documents.enquiry_id)');
select crm.apply_rls_scoped('payments', 'payments',
  'exists (select 1 from crm.enquiries e where e.org_id = crm.payments.org_id and e.id = crm.payments.enquiry_id)');

-- sensitive custom-field values: permission only (module `sensitive`), branch of the enquiry
select app.apply_rls('crm', 'enquiry_sensitive', 'product', 'crm', 'sensitive');
