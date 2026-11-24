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

-- ---------------------------------------------------------------- per-statement permission helpers
-- The generator's policies call app.user_has_product + app.can for every row (about a millisecond each: ADR 002
-- "Performance"), which made a list of a few hundred enquiries slow and tens of thousands impossible within the
-- 15 s statement timeout. The CRM policies below ask the same questions ONCE per statement instead: a scalar
-- subquery without outer references is an InitPlan, so crm.scope_of(), app.user_branch_ids() and
-- crm.disabled_branches() are evaluated a single time and the per-row work is a comparison.
-- crm.scope_of(module, action) is app.can() without the row arguments: the widest scope ('org' | 'branch' | 'own') the
-- caller holds for module.action in the CRM, NULL when they have none or the org has no usable CRM subscription.
-- test/platform.test.ts proves the two agree for every default role.
create or replace function crm.scope_of(p_module text, p_action text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  v_rank integer;
begin
  if auth.uid() is null or v_org is null or not app.user_has_product(v_org, 'crm') then return null; end if;
  if not exists (select 1 from core.org_users u where u.user_id = auth.uid() and u.status = 'active') then
    -- only a support session reaches here (user_has_product passed)
    return case when p_action = 'view' or exists (select 1 from core.support_sessions s where s.id = app.support_session_id() and not s.read_only) then 'org' end;
  end if;
  select max(case rp.scope when 'own' then 1 when 'branch' then 2 when 'org' then 3 end) into v_rank
  from core.org_users u
  join core.user_product_access a on a.user_id = u.user_id and a.org_id = u.org_id and a.product_key = 'crm' and a.revoked_at is null
  join core.roles r on r.org_id = a.org_id and r.product_key = a.product_key and r.key = a.role_key
  join core.role_permissions rp on rp.role_id = r.id
  where u.user_id = auth.uid() and u.org_id = v_org and u.kind = 'staff' and u.status = 'active'
    and rp.module_key in (p_module, '*') and rp.action in (p_action, '*');
  return case v_rank when 3 then 'org' when 2 then 'branch' when 1 then 'own' end;
end $$;

-- Branches of the caller's org where the CRM is switched off (decision 34).
create or replace function crm.disabled_branches() returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(b.branch_id), '{}') from core.org_branch_products b
   where b.org_id = app.current_org_id() and b.product_key = 'crm' and not b.enabled
$$;

-- Reporting line (RB-02): is the signed-in user, directly or further up, the manager of this owner?
create or replace function crm.in_my_team(p_org uuid, p_owner uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  with recursive up as (
    select s.id, s.reports_to, s.user_id from core.staff s
     where s.org_id = p_org and s.user_id = p_owner and s.deleted_at is null
    union
    select m.id, m.reports_to, m.user_id from core.staff m join up on m.id = up.reports_to
     where m.org_id = p_org and m.deleted_at is null)
  select p_owner is not null and exists (select 1 from up where up.user_id = auth.uid() and up.user_id is distinct from p_owner)
$$;

-- ---------------------------------------------------------------- RLS helpers (migration-only)
-- crm.apply_rls_scoped: for tables without owner/branch. Child rows (activities, visits, documents ...) are visible
-- exactly when their parent enquiry (or household) is visible to the caller, so the lead scope (own / team / branch /
-- org) and the per-branch product switch decided on crm.enquiries carry over to everything hanging off it. The caller
-- still needs the module permission at ANY scope (crm.scope_of is not null); row visibility is the predicate.
-- p_visible is the row predicate, p_insert the insert predicate (defaults to p_visible).
create or replace function crm.apply_rls_scoped(p_table text, p_module text, p_visible text, p_insert text default null)
returns void language plpgsql set search_path = '' as $$
declare
  t text := format('crm.%I', p_table);
  m text := quote_literal(p_module);
  v text := p_visible;
  i text := coalesce(p_insert, p_visible);
  org text := 'org_id = (select app.current_org_id()) and (select app.user_has_product((select app.current_org_id()), ''crm''))';
begin
  perform app.apply_rls('crm', p_table, 'product', 'crm', p_module);  -- RLS on, audit trigger, grants
  perform app.drop_policies('crm', p_table);
  execute format('create policy sel on %s for select using (%s and (select crm.scope_of(%s, ''view'')) is not null and (%s))', t, org, m, v);
  execute format('create policy ins on %s for insert with check (%s and (select crm.scope_of(%s, ''create'')) is not null and (%s))', t, org, m, i);
  execute format('create policy upd on %s for update using (%s and (select crm.scope_of(%s, ''edit'')) is not null and (%s)) with check (%s and (select crm.scope_of(%s, ''edit'')) is not null and (%s))', t, org, m, v, org, m, v);
  execute format('create policy del on %s for delete using (%s and (select crm.scope_of(%s, ''delete'')) is not null and (%s))', t, org, m, v);
end $$;

-- crm.apply_rls_enquiries: the policies of crm.enquiries (module leads) with the lead scope of the PRD:
--   org    every enquiry of the org;  branch  those of the user's branches;
--   own    their own enquiries and those of everyone who reports to them (RB-02), inside their branches
-- and never in a branch where the CRM is switched off. Insert needs create (own scope: only as owner); edit and delete
-- follow the same scope rules as view.
create or replace function crm.apply_rls_enquiries() returns void language plpgsql set search_path = '' as $$
declare
  org text := 'org_id = (select app.current_org_id()) and (select app.user_has_product((select app.current_org_id()), ''crm'')) and not (branch_id = any (((select crm.disabled_branches())::uuid[])))';
  a text;
  sc text;
  rule text;
begin
  perform app.apply_rls('crm', 'enquiries', 'product', 'crm', 'leads');
  perform app.drop_policies('crm', 'enquiries');
  foreach a in array array['view', 'create', 'edit', 'delete'] loop
    sc := format('(select crm.scope_of(''leads'', %L))', a);
    rule := format('%s and (%s = ''org'' or (%s in (''branch'', ''own'') and branch_id = any (((select app.user_branch_ids())::uuid[])) and (%s = ''branch'' or owner_id = (select app.uid())%s)))',
                   org, sc, sc, sc, case when a = 'create' then '' else ' or crm.in_my_team(org_id, owner_id)' end);
    if a = 'view' then execute format('create policy sel on crm.enquiries for select using (%s)', rule);
    elsif a = 'create' then execute format('create policy ins on crm.enquiries for insert with check (%s)', rule);
    elsif a = 'edit' then execute format('create policy upd on crm.enquiries for update using (%s) with check (%s)', rule, rule);
    else execute format('create policy del on crm.enquiries for delete using (%s)', rule);
    end if;
  end loop;
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
