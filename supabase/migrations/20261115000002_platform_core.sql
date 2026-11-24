-- AutoEd platform foundation (2/6): core tables (tenancy, identity, entitlements, roles, support access).
-- Every table has org_id except the reviewed global tables: core.products, core.product_modules,
-- core.platform_admins (and billing.plans in 000004). The list is enforced by harness test T7.
-- Generic naming (decision 28): clients are schools, coaching centres and colleges.

-- ---------------------------------------------------------------- product catalogue (global)
create table core.products (
  key text primary key check (key in ('crm','os','erp')),
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table core.product_modules (
  product_key text not null references core.products(key),
  module_key text not null check (module_key ~ '^[a-z][a-z0-9_]*$'),
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (product_key, module_key)
);

-- AutoEd staff who run the platform console. They belong to no client org (decision 37) and reach a
-- client only through core.support_sessions.
create table core.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- tenancy
create table core.organizations (
  id uuid primary key default gen_random_uuid(),
  -- Same value as id, so every table (this one included) can be checked with one org_id rule.
  org_id uuid generated always as (id) stored,
  name text not null,
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]*$'),
  kind text not null default 'school' check (kind in ('school','coaching_centre','college','other')),
  legal_name text,
  time_zone text not null default 'Asia/Kolkata',
  default_locale text not null default 'en',
  status text not null default 'active' check (status in ('active','closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index organizations_org_id_key on core.organizations(org_id);

create table core.branches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  name text not null,
  code text not null,
  city text,
  state_code text check (state_code is null or state_code ~ '^[0-9]{2}$'),  -- GST state code
  time_zone text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, code),
  unique (org_id, id)
);
create index branches_org on core.branches(org_id);

-- ---------------------------------------------------------------- entitlements (plan 4.2)
create table core.subscriptions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  product_key text not null references core.products(key),
  status text not null check (status in ('trial','active','past_due','suspended','cancelled')),
  plan_key text,
  starts_on date not null default current_date,
  ends_on date,
  seats integer check (seats is null or seats > 0),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, product_key),
  check (ends_on is null or ends_on >= starts_on)
);

-- Per-branch switch (decision 34). No row = the product is on for the branch if the org has it.
create table core.org_branch_products (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid not null,
  product_key text not null references core.products(key),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (branch_id, product_key),
  foreign key (org_id, branch_id) references core.branches(org_id, id) on delete cascade
);

-- ---------------------------------------------------------------- identity (decisions 30, 36, 37)
-- One auth user belongs to exactly one client org: unique(user_id). There is no membership switcher.
create table core.org_users (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('staff','guardian','parent','student')),
  display_name text not null,
  status text not null default 'active' check (status in ('invited','active','disabled')),
  home_branch_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint org_users_one_org_per_user unique (user_id),
  unique (org_id, user_id),
  foreign key (org_id, home_branch_id) references core.branches(org_id, id)
);

-- Branches a staff user may act in beyond the home branch. A staff user with no home branch and no
-- rows here works at org level (all branches), as in the OS.
create table core.user_branch_access (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  user_id uuid not null,
  branch_id uuid not null,
  created_at timestamptz not null default now(),
  unique (user_id, branch_id),
  foreign key (org_id, user_id) references core.org_users(org_id, user_id) on delete cascade,
  foreign key (org_id, branch_id) references core.branches(org_id, id) on delete cascade
);

-- Guardian/parent/student portal users see only their own children (decision 30). learner_id gets
-- a foreign key to the learner master table when that table moves into core (OS/ERP stream).
create table core.learner_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  user_id uuid not null,
  learner_id uuid not null,
  relation text not null check (relation in ('self','mother','father','guardian','other')),
  created_at timestamptz not null default now(),
  unique (user_id, learner_id),
  foreign key (org_id, user_id) references core.org_users(org_id, user_id) on delete cascade
);

-- ---------------------------------------------------------------- roles (small port of the OS idea)
-- Roles are per org and per product. Scopes: own < branch < org. module_key/action may be '*'.
create table core.roles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  product_key text not null references core.products(key),
  key text not null check (key ~ '^[a-z][a-z0-9_]*$'),
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, product_key, key),
  unique (org_id, id)
);

create table core.role_permissions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  role_id uuid not null,
  module_key text not null,
  action text not null,
  scope text not null check (scope in ('own','branch','org')),
  created_at timestamptz not null default now(),
  unique (role_id, module_key, action),
  foreign key (org_id, role_id) references core.roles(org_id, id) on delete cascade
);

-- Product access per user (plan 4.2). The composite keys make it impossible to grant a user of one
-- org access in another org, or to point at another org's role.
create table core.user_product_access (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  user_id uuid not null,
  product_key text not null references core.products(key),
  role_key text not null,
  granted_by uuid,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  foreign key (org_id, user_id) references core.org_users(org_id, user_id) on delete cascade,
  foreign key (org_id, product_key, role_key) references core.roles(org_id, product_key, key)
);
create unique index user_product_access_live on core.user_product_access(user_id, product_key) where revoked_at is null;
create index user_product_access_org on core.user_product_access(org_id);

-- ---------------------------------------------------------------- login security (decision 36)
-- What Supabase Auth does not store. Written only by app.record_login_event (security definer).
-- org_id is null only for AutoEd platform staff accounts.
create table core.user_security (
  user_id uuid primary key references auth.users(id) on delete cascade,
  org_id uuid references core.organizations(id) on delete cascade,
  password_set_at timestamptz,
  password_changed_at timestamptz,
  must_change_password boolean not null default false,
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  locked_until timestamptz,
  mfa_required boolean not null default false,
  mfa_enrolled_at timestamptz,
  updated_at timestamptz not null default now()
);
create index user_security_org on core.user_security(org_id);

-- org_id/user_id are null for attempts on an unknown identifier (only platform admins see those).
create table core.login_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references core.organizations(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  method text not null check (method in ('otp_phone','otp_email','password','refresh','logout')),
  success boolean not null,
  reason text,
  ip inet,
  user_agent text,
  created_at timestamptz not null default now()
);
create index login_events_org on core.login_events(org_id, created_at desc);
create index login_events_user on core.login_events(user_id, created_at desc);

-- ---------------------------------------------------------------- support access ("view as")
-- Time-limited (max 4 hours), reason required, read-only by default, opened and closed only through
-- app.start_support_session / app.end_support_session, which write audit.log.
create table core.support_sessions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  platform_user_id uuid not null references core.platform_admins(user_id),
  reason text not null check (length(btrim(reason)) >= 10),
  read_only boolean not null default true,
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz,
  check (expires_at > started_at and expires_at <= started_at + interval '4 hours'),
  check (ended_at is null or ended_at >= started_at)
);
create unique index support_sessions_one_open on core.support_sessions(platform_user_id) where ended_at is null;
create index support_sessions_org on core.support_sessions(org_id, started_at desc);

-- updated_at triggers
do $$
declare t text;
begin
  foreach t in array array['organizations','branches','subscriptions','org_branch_products','org_users','roles'] loop
    execute format('create trigger trg_touch before update on core.%I for each row execute function app.touch_updated_at()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- catalogue seed
insert into core.products (key, name) values ('crm', 'AutoEd CRM'), ('os', 'AutoEd OS'), ('erp', 'AutoEd ERP');

-- OS modules from packages/shared/src/modules.ts (MODULE_KEYS). CRM and ERP module lists are added
-- by their streams once their tables are mapped (docs/MAP-TABLES.md). 'harness' backs the isolation
-- probe tables in 000006.
insert into core.product_modules (product_key, module_key, name)
select 'os', m, initcap(replace(m, '_', ' ')) from unnest(array[
  'tasks','checklists','timetable','substitution','staff_attendance','student_attendance','leave','approvals',
  'lesson_planner','syllabus_coverage','class_log','exams','observation','helpdesk','circulars','calendar',
  'meetings','events','duty_roster','incidents','compliance','reports','help_bot']) m;
insert into core.product_modules (product_key, module_key, name) values
  ('crm', 'harness', 'Isolation harness probe'),
  ('os',  'harness', 'Isolation harness probe'),
  ('erp', 'harness', 'Isolation harness probe');
