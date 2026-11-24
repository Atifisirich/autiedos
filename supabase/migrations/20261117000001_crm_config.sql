-- AutoEd CRM port (1/6): CRM modules, configuration tables, RLS helper for child tables, role matrix mapping.
-- Source: Atifisirich/autoedcrm db/schema.sql (schema `autoed`, 43 tables) mapped by docs/MAP-TABLES.md A.2.
-- Decisions: docs/adr/crm-port.md. Conventions: tenant_id -> org_id (R1), standard columns (R3), every FK between
-- org-scoped tables is composite (org_id, x) so a row can never point at another client's row, RLS only through the
-- platform generator app.apply_rls (R11) with product 'crm'.
--
-- People: CRM `users` live in core.staff + core.org_users + core.user_product_access. Every user reference in a
-- crm table (owner_id, host_id, actor_id, verified_by ...) holds the AUTH USER id, because the platform's "own"
-- scope compares owner_id with app.uid(); join core.staff on user_id for the person. FK: (org_id, user) ->
-- core.org_users(org_id, user_id).

-- ---------------------------------------------------------------- modules
insert into core.product_modules (product_key, module_key, name) values
  ('crm', 'leads',        'Leads and 360'),
  ('crm', 'tasks',        'Tasks and visits'),
  ('crm', 'applications', 'Applications and documents'),
  ('crm', 'payments',     'Payments and refunds'),
  ('crm', 'campaigns',    'Campaigns'),
  ('crm', 'workflows',    'Workflows'),
  ('crm', 'reports',      'Reports and dashboards'),
  ('crm', 'sensitive',    'Sensitive fields'),
  ('crm', 'admin',        'Admin console'),
  ('crm', 'users',        'Users and roles'),
  ('crm', 'data',         'Data management'),
  ('crm', 'wallet',       'Messaging wallet'),
  ('crm', 'secrets',      'Provider secrets')
on conflict do nothing;

-- ---------------------------------------------------------------- RLS helper for tables without owner/branch
-- Child rows (activities, visits, documents ...) are visible exactly when their parent enquiry (or household)
-- is visible to the caller, so the lead scope (own / team / branch / org) and the per-branch product switch
-- decided on crm.enquiries carry over to everything hanging off it. The caller still needs the module
-- permission at ANY scope (app.can with owner = the caller passes the "own" level; row visibility is the
-- predicate). p_visible is the row predicate, p_insert the insert predicate (defaults to p_visible).
-- Migration-only helper: not executable by request roles.
create or replace function crm.apply_rls_scoped(p_table text, p_module text, p_visible text, p_insert text default null)
returns void language plpgsql set search_path = '' as $$
declare
  t text := format('crm.%I', p_table);
  m text := quote_literal(p_module);
  v text := p_visible;
  i text := coalesce(p_insert, p_visible);
begin
  perform app.apply_rls('crm', p_table, 'product', 'crm', p_module);  -- RLS on, audit trigger, base policies
  perform app.drop_policies('crm', p_table);
  execute format('create policy sel on %s for select using (app.user_has_product(org_id, ''crm'') and app.can(''crm'', %s, ''view'', org_id, null, app.uid()) and (%s))', t, m, v);
  execute format('create policy ins on %s for insert with check (app.user_has_product(org_id, ''crm'') and app.can(''crm'', %s, ''create'', org_id, null, app.uid()) and (%s))', t, m, i);
  execute format('create policy upd on %s for update using (app.user_has_product(org_id, ''crm'') and app.can(''crm'', %s, ''edit'', org_id, null, app.uid()) and (%s)) with check (app.user_has_product(org_id, ''crm'') and app.can(''crm'', %s, ''edit'', org_id, null, app.uid()) and (%s))', t, m, v, m, v);
  execute format('create policy del on %s for delete using (app.user_has_product(org_id, ''crm'') and app.can(''crm'', %s, ''delete'', org_id, null, app.uid()) and (%s))', t, m, v);
end $$;

-- ---------------------------------------------------------------- settings (tenants.settings/flags/webhook_key/wallet)
create table crm.settings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null unique references core.organizations(id) on delete cascade,
  settings jsonb not null default '{}',          -- tenants.settings: scoring, quiet hours, closure reasons, fees, integrations (non-secret)
  flags jsonb not null default '{}',
  onboarding jsonb not null default '{}',
  webhook_key text not null unique default replace(gen_random_uuid()::text, '-', ''),
  system_user_id uuid,                            -- the org's automation actor (webhooks, cron, public forms); see crm.provision_org
  wallet_balance numeric(12,2) not null default 0, -- changed only by crm.wallet_post (guard trigger below)
  created_at timestamptz not null default now(),
  created_by uuid default app.uid(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, system_user_id) references core.org_users(org_id, user_id)
);
create trigger trg_touch before update on crm.settings for each row execute function app.touch_updated_at();
select app.apply_rls('crm', 'settings', 'product_config', 'crm', 'admin');

-- Provider credentials (WhatsApp token, Meta app secret ...), AES-256-GCM with APP_SECRET by the server.
-- Interim home until the platform's private.org_secrets exists (MAP-TABLES A.2 #41); gated by module `secrets`.
create table crm.org_secrets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  key text not null,
  value_enc text not null,
  created_at timestamptz not null default now(),
  created_by uuid default app.uid(),
  updated_at timestamptz not null default now(),
  unique (org_id, key),
  unique (org_id, id)
);
create trigger trg_touch before update on crm.org_secrets for each row execute function app.touch_updated_at();
select app.apply_rls('crm', 'org_secrets', 'product', 'crm', 'secrets');

-- Which custom enquiry fields are sensitive (core.custom_fields has no such flag). Values of sensitive fields
-- never sit in crm.enquiries.custom: see crm.enquiry_sensitive and the trigger in 20261117000004.
create table crm.field_settings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  entity text not null default 'enquiry',
  key text not null check (key ~ '^[a-z][a-z0-9_]*$'),
  sensitive boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid default app.uid(),
  updated_at timestamptz not null default now(),
  unique (org_id, entity, key),
  unique (org_id, id)
);
create trigger trg_touch before update on crm.field_settings for each row execute function app.touch_updated_at();
select app.apply_rls('crm', 'field_settings', 'product_config', 'crm', 'admin');

create table crm.branch_settings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid not null,
  open_hour integer not null default 9 check (open_hour between 0 and 23),
  close_hour integer not null default 18 check (close_hour between 0 and 24),
  visit_capacity integer not null default 3 check (visit_capacity >= 0),
  created_at timestamptz not null default now(),
  created_by uuid default app.uid(),
  updated_at timestamptz not null default now(),
  unique (org_id, branch_id),
  unique (org_id, id),
  foreign key (org_id, branch_id) references core.branches(org_id, id) on delete cascade
);
create trigger trg_touch before update on crm.branch_settings for each row execute function app.touch_updated_at();
select app.apply_rls('crm', 'branch_settings', 'product_config', 'crm', 'admin');

create table crm.counsellor_settings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  user_id uuid not null,
  daily_capacity integer not null default 25 check (daily_capacity >= 0),
  on_leave boolean not null default false,        -- manual flag; OS leave data is not read by the CRM
  created_at timestamptz not null default now(),
  created_by uuid default app.uid(),
  updated_at timestamptz not null default now(),
  unique (org_id, user_id),
  unique (org_id, id),
  foreign key (org_id, user_id) references core.org_users(org_id, user_id) on delete cascade
);
create trigger trg_touch before update on crm.counsellor_settings for each row execute function app.touch_updated_at();
select app.apply_rls('crm', 'counsellor_settings', 'product_config', 'crm', 'admin');

-- The CRM permission matrix (PRD 12): one level per capability. The database enforces it through core.roles +
-- core.role_permissions, rebuilt from this row by crm.sync_role_permissions (trigger in 20261117000004).
-- Written with module `users` (not `admin`), so a branch admin cannot rewrite their own permissions.
create table crm.roles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  product_key text not null default 'crm' check (product_key = 'crm'),
  key text not null check (key ~ '^[a-z][a-z0-9_]*$'),
  name text not null,
  permissions jsonb not null default '{}',
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid default app.uid(),
  updated_at timestamptz not null default now(),
  unique (org_id, key),
  unique (org_id, id),
  foreign key (org_id, product_key, key) references core.roles(org_id, product_key, key) on delete cascade
);
create trigger trg_touch before update on crm.roles for each row execute function app.touch_updated_at();
select app.apply_rls('crm', 'roles', 'product_config', 'crm', 'users');

-- Per-year parameters of a programme (core.programmes holds the programme itself).
create table crm.intakes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  academic_year_id uuid not null,
  programme_id uuid not null,
  capacity integer not null default 30 check (capacity >= 0),
  min_age_years numeric(4,1),
  age_cutoff date,
  created_at timestamptz not null default now(),
  created_by uuid default app.uid(),
  updated_at timestamptz not null default now(),
  unique (org_id, academic_year_id, programme_id),
  unique (org_id, id),
  foreign key (org_id, academic_year_id) references core.academic_years(org_id, id) on delete cascade,
  foreign key (org_id, programme_id) references core.programmes(org_id, id) on delete cascade
);
create index intakes_programme on crm.intakes(org_id, programme_id);
create trigger trg_touch before update on crm.intakes for each row execute function app.touch_updated_at();
select app.apply_rls('crm', 'intakes', 'product_config', 'crm', 'admin');

create table crm.phases (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  key text not null,
  name text not null,
  seq integer not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid default app.uid(),
  updated_at timestamptz not null default now(),
  unique (org_id, key),
  unique (org_id, id)
);
create trigger trg_touch before update on crm.phases for each row execute function app.touch_updated_at();
select app.apply_rls('crm', 'phases', 'product_config', 'crm', 'admin');

-- "Admission confirmed" (is_won) is the conversion trigger for core.admit_student (decision 38).
create table crm.stages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  phase_id uuid not null,
  name text not null,
  seq integer not null default 0,
  color text not null default 'slate',
  probability integer not null default 0 check (probability between 0 and 100),
  sla_hours integer,
  required_fields jsonb not null default '[]',
  exempt_next_action boolean not null default false,
  is_closed boolean not null default false,
  is_won boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid default app.uid(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, phase_id) references crm.phases(org_id, id) on delete cascade
);
create index stages_phase on crm.stages(org_id, phase_id);
create trigger trg_touch before update on crm.stages for each row execute function app.touch_updated_at();
select app.apply_rls('crm', 'stages', 'product_config', 'crm', 'admin');

create table crm.sources (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  channel text not null,
  name text not null,
  cost numeric(12,2) not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid default app.uid(),
  updated_at timestamptz not null default now(),
  unique (org_id, id)
);
create trigger trg_touch before update on crm.sources for each row execute function app.touch_updated_at();
select app.apply_rls('crm', 'sources', 'product_config', 'crm', 'admin');

-- Lead routing (not os.assignment_rules). user_ids: auth user ids in round-robin order.
create table crm.assignment_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  name text not null,
  seq integer not null default 0,
  conditions jsonb not null default '{}',
  method text not null default 'round_robin' check (method in ('round_robin','least_load')),
  user_ids jsonb not null default '[]',
  pointer integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid default app.uid(),
  updated_at timestamptz not null default now(),
  unique (org_id, id)
);
create trigger trg_touch before update on crm.assignment_rules for each row execute function app.touch_updated_at();
select app.apply_rls('crm', 'assignment_rules', 'product_config', 'crm', 'admin');

create table crm.forms (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  slug text not null unique,                       -- public URL key, globally unique
  name text not null,
  branch_id uuid,
  source_id uuid,
  fields jsonb not null default '[]',
  thank_you text not null default 'Thank you. Our admissions team will call you shortly.',
  active boolean not null default true,
  submissions integer not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid default app.uid(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, branch_id) references core.branches(org_id, id),
  foreign key (org_id, source_id) references crm.sources(org_id, id) on delete set null (source_id)
);
create index forms_branch on crm.forms(org_id, branch_id);
create index forms_source on crm.forms(org_id, source_id);
create trigger trg_touch before update on crm.forms for each row execute function app.touch_updated_at();
select app.apply_rls('crm', 'forms', 'product_config', 'crm', 'admin');

create table crm.saved_views (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  user_id uuid not null,
  name text not null,
  shared boolean not null default false,
  query text not null,
  created_at timestamptz not null default now(),
  created_by uuid default app.uid(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, user_id) references core.org_users(org_id, user_id) on delete cascade
);
create index saved_views_user on crm.saved_views(org_id, user_id);
create trigger trg_touch before update on crm.saved_views for each row execute function app.touch_updated_at();
select crm.apply_rls_scoped('saved_views', 'leads', 'user_id = app.uid() or shared');

-- Messaging wallet ledger (interim: billing.wallet_ledger does not exist yet, MAP-TABLES A.2 #35). Append-only,
-- written only by crm.wallet_post (guard trigger in 20261117000004).
create table crm.wallet_ledger (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid,
  wallet_kind text not null default 'messaging' check (wallet_kind in ('messaging')),
  type text not null check (type in ('credit','debit')),
  category text not null,
  amount numeric(12,2) not null check (amount > 0),
  balance_after numeric(12,2),
  note text,
  created_at timestamptz not null default now(),
  created_by uuid default app.uid(),
  unique (org_id, id),
  foreign key (org_id, branch_id) references core.branches(org_id, id)
);
create index wallet_ledger_org on crm.wallet_ledger(org_id, created_at desc);
select app.apply_rls('crm', 'wallet_ledger', 'product', 'crm', 'wallet');
