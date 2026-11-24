-- AutoEd compliance tooling (plan phase 6, section 9): data-subject rights, retention, org export and deletion,
-- consent records. Generic and catalogue-driven: the tools find tables through pg_catalog and the
-- registries below, so a new table is covered the moment it is registered (CI fails if it is not).
-- See docs/adr/compliance-tooling.md. Local Postgres only; nothing here touches a cloud project.
--
-- Roles (docs/adr/001): everything privileged is a security definer function in schema app that only
-- platform_admin_server (org and person tools), job_runner (retention purge) and service_role may EXECUTE.
-- crm_server / os_server / erp_server cannot execute them and never see another product's schema. Only the
-- consent helpers are executable by the product roles (they work on core.consent_events of the caller's own org).
--
-- Periods are DATA (core.retention_policies), never constants: docs/legal/data-retention-schedule.md is a draft
-- and every period in it is marked CONFIRM. Seeded table rules are DISABLED until counsel confirms them.

-- ================================================================ registries and configuration

-- Where personal data lives. One row per (table, person type, key column). org_id null = platform default,
-- a row with an org_id overrides it for that org (for example a school that must retain more).
create table core.pii_registry (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references core.organizations(id) on delete cascade,
  schema_name text not null check (schema_name in ('core','crm','os','erp','billing')),
  table_name text not null,
  classification text not null default 'personal' check (classification in ('personal','exempt')),
  person_type text check (person_type in ('staff','student','guardian','lead')),
  key_column text,                                   -- column holding the person's id (uuid, or uuid[] such as incidents.student_ids); null = match by contact only
  filter_column text,                                -- optional: only rows where this column is one of filter_values
  filter_values text[],
  contact_columns text[] not null default '{}',      -- phone / email columns: rows are also matched on these values
  is_subject boolean not null default false,         -- the row IS the person's profile: contact values are read from it, and link_columns give the person's other ids
  link_columns text[] not null default '{}',         -- on a subject row: other uuid columns of the same person (staff.user_id, guardians.user_id)
  pii_columns text[] not null default '{}',          -- columns removed on anonymise and stripped from audit images
  audit_columns text[] not null default '{}',        -- more columns stripped from audit images only (generated columns such as full_name)
  anonymise_values jsonb not null default '{}'::jsonb, -- column -> replacement literal (needed for NOT NULL columns)
  erasure_mode text not null default 'delete' check (erasure_mode in ('delete','anonymise','retain')),
  retain_reason text,
  erase_order integer not null default 100,          -- lower runs first (children before the profile row)
  export boolean not null default true,
  exempt_reason text,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((filter_column is null) = (filter_values is null)),
  check (classification = 'exempt' and exempt_reason is not null and length(btrim(exempt_reason)) >= 10
         or classification = 'personal' and person_type is not null and (key_column is not null or cardinality(contact_columns) > 0)),
  check (erasure_mode <> 'retain' or (retain_reason is not null and length(btrim(retain_reason)) >= 10)),
  check (classification = 'exempt' or erasure_mode = 'retain' or cardinality(pii_columns) > 0)
);
create unique index pii_registry_unique on core.pii_registry (
  coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid), schema_name, table_name,
  coalesce(person_type, ''), coalesce(key_column, ''));
create index pii_registry_org on core.pii_registry(org_id);

-- What happens to each table when a whole organisation or product is deleted, and whether it is exported.
-- No row = delete and export (client data is the default; AutoEd's own records are listed here as retain).
create table core.table_policy (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references core.organizations(id) on delete cascade,
  schema_name text not null check (schema_name in ('core','crm','os','erp','billing','audit')),
  table_name text not null,
  org_deletion text not null default 'delete' check (org_deletion in ('delete','retain')),
  retain_reason text,
  org_export boolean not null default true,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (org_deletion <> 'retain' or (retain_reason is not null and length(btrim(retain_reason)) >= 10))
);
create unique index table_policy_unique on core.table_policy (
  coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid), schema_name, table_name);
create index table_policy_org on core.table_policy(org_id);

-- Retention periods and lifecycle periods as rows. scope 'table' rules are applied by the purge job;
-- scope 'lifecycle' rows hold the contract-end periods (decision 42) and confirmation-token lifetime.
-- An org row may only SHORTEN the platform default of the same data_type (the schedule is AutoEd's maximum).
create table core.retention_policies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references core.organizations(id) on delete cascade,
  scope text not null default 'table' check (scope in ('table','lifecycle')),
  data_type text not null check (data_type ~ '^[a-z][a-z0-9_]*$'),
  description text,
  product_key text references core.products(key),   -- null on a table rule = core/platform data, run with the org's first product
  schema_name text,
  table_name text,
  date_column text,                                  -- the clock: rows older than the period are purged
  filter_column text,
  filter_values text[],
  action text check (action in ('delete','anonymise')),
  anonymise_columns text[] not null default '{}',
  anonymise_values jsonb not null default '{}'::jsonb,
  period_value integer not null check (period_value > 0),
  period_unit text not null check (period_unit in ('minutes','days','months')),
  enabled boolean not null default false,
  legal_status text not null default 'draft' check (legal_status in ('draft','confirmed')),
  legal_note text,
  enabled_override_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (scope = 'lifecycle' and period_unit in ('minutes','days')
         or scope = 'table' and schema_name is not null and table_name is not null and date_column is not null and action is not null),
  check ((filter_column is null) = (filter_values is null)),
  check (action is distinct from 'anonymise' or cardinality(anonymise_columns) > 0 or anonymise_values <> '{}'::jsonb),
  -- nothing is switched on while counsel's confirmation is open, unless someone states why
  check (not enabled or legal_status = 'confirmed' or length(btrim(coalesce(enabled_override_reason, ''))) >= 10)
);
create unique index retention_policies_unique on core.retention_policies (
  coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid), data_type);
create index retention_policies_org on core.retention_policies(org_id);

-- A legal hold suspends erasure, purge and deletion (retention schedule principle 3).
create table core.legal_holds (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  scope text not null check (scope in ('org','person','table')),
  person_type text check (person_type in ('staff','student','guardian','lead')),
  person_id uuid,
  schema_name text,
  table_name text,
  reason text not null check (length(btrim(reason)) >= 10),
  placed_by uuid,
  placed_at timestamptz not null default now(),
  released_at timestamptz,
  released_by uuid,
  release_reason text,
  check (scope <> 'person' or person_id is not null),
  check (scope <> 'table' or (schema_name is not null and table_name is not null)),
  check (released_at is null or released_at >= placed_at)
);
create index legal_holds_open on core.legal_holds(org_id) where released_at is null;

-- Request register (data-subject-rights-procedure section 7) and the two-step confirmation for destructive
-- requests. Holds no personal data once executed: identifiers are removed from params, results are counts.
create table core.compliance_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  kind text not null check (kind in ('person_export','person_erasure','org_export','org_deletion','product_deletion')),
  status text not null default 'planned' check (status in ('planned','executed','refused','failed','expired')),
  person_type text check (person_type in ('staff','student','guardian','lead')),
  subject_person_id uuid,
  product_key text references core.products(key),
  params jsonb not null default '{}'::jsonb,
  plan jsonb,
  result jsonb,
  blockers jsonb,
  reason text,
  requested_by uuid,
  data_request_id uuid,                              -- the client's own request register entry (core.data_requests), closed when this is executed
  identity_verified_at timestamptz,
  identity_verified_by uuid,
  token_hash text,
  token_expires_at timestamptz,
  confirmed_by uuid,
  confirmed_at timestamptz,
  eligible_at timestamptz,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index compliance_requests_org on core.compliance_requests(org_id, created_at desc);
alter table core.compliance_requests add constraint compliance_requests_data_request_fk
  foreign key (org_id, data_request_id) references core.data_requests(org_id, id) on delete set null (data_request_id);

-- Whole-organisation export (CSV + XLSX per table, manifest with row counts and sha256).
create table core.org_export_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  purpose text not null default 'on_demand' check (purpose in ('on_demand','exit','non_payment')),
  product_keys text[] not null default '{}',
  formats text[] not null default '{csv,xlsx}',
  status text not null default 'running' check (status in ('running','done','failed','expired')),
  requested_by uuid,
  total_rows bigint,
  row_counts jsonb,
  manifest jsonb,
  manifest_sha256 text,
  archive_sha256 text,
  archive_bytes bigint,
  storage_key text,
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  expires_at timestamptz
);
create index org_export_jobs_org on core.org_export_jobs(org_id, created_at desc);

-- Consent ledger (messaging-consent.md 2.2). Append-only: a change is a new row; the latest row per
-- (contact, channel, purpose) is the current state. purpose is 'service' or 'promotional' per row; the helper
-- expands 'both' into two rows.
create table core.consent_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  person_type text check (person_type in ('staff','student','guardian','lead')),
  person_id uuid,
  guardian_id uuid,
  guardian_relation text,
  channel text not null check (channel in ('whatsapp','sms','email','push','voice')),
  contact text not null check (length(contact) > 0),  -- normalised (app.compliance_normalise_contact)
  purpose text not null check (purpose in ('service','promotional')),
  status text not null check (status in ('opted_in','opted_out','unknown')),
  source text not null,                               -- form id, qr, missed_call, in_person, inbound_message, import, ...
  proof jsonb not null default '{}'::jsonb,           -- consent text version/url, form snapshot, ip, user agent
  recorded_by uuid,
  recorded_at timestamptz not null default now()
);
create index consent_events_lookup on core.consent_events(org_id, channel, contact, purpose, recorded_at desc);
create index consent_events_person on core.consent_events(org_id, person_id);

-- Purge log (retention schedule principle 4): what class, which org, how many rows, when. Never the data.
create table audit.purge_log (
  id bigint generated always as identity primary key,
  org_id uuid not null,                               -- no foreign key: survives the organisation
  product_key text,
  source text not null check (source in ('retention','person_erasure','org_deletion','product_deletion')),
  request_id uuid,
  rule_id uuid,
  data_type text,
  schema_name text,
  table_name text,
  action text not null check (action in ('delete','anonymise','retain','skip')),
  status text not null check (status in ('done','dry_run','skipped_no_product','skipped_disabled','skipped_legal_hold','skipped_table_missing','skipped_retained','failed')),
  rows_before bigint,
  rows_affected bigint not null default 0,
  cutoff timestamptz,
  dry_run boolean not null default false,
  actor_user_id uuid,
  detail jsonb,
  created_at timestamptz not null default now()
);
create index purge_log_org on audit.purge_log(org_id, created_at desc);

-- Phone numbers and emails given with an erasure request live here, not in core.compliance_requests (which is audited,
-- readable by the client's compliance viewers and kept as the register). Private: RLS on, no policies, definer functions only.
create table private.compliance_request_secrets (
  request_id uuid primary key references core.compliance_requests(id) on delete cascade,
  org_id uuid not null references core.organizations(id) on delete cascade,
  identifiers text[] not null default '{}',
  created_at timestamptz not null default now()
);
alter table private.compliance_request_secrets enable row level security;
grant all on private.compliance_request_secrets to service_role;

create trigger trg_touch before update on core.pii_registry for each row execute function app.touch_updated_at();
create trigger trg_touch before update on core.table_policy for each row execute function app.touch_updated_at();
create trigger trg_touch before update on core.retention_policies for each row execute function app.touch_updated_at();

-- Used by the retention_policies policy (a policy may not select from its own table: infinite recursion).
create or replace function app._compliance_default_rule_exists(p_data_type text, p_scope text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from core.retention_policies d where d.org_id is null and d.data_type = p_data_type and d.scope = p_scope)
$$;

-- ================================================================ policies, grants, audit triggers
alter table core.pii_registry enable row level security;
alter table core.table_policy enable row level security;
alter table core.retention_policies enable row level security;
alter table core.legal_holds enable row level security;
alter table core.compliance_requests enable row level security;
alter table core.org_export_jobs enable row level security;
alter table core.consent_events enable row level security;
alter table audit.purge_log enable row level security;

-- Platform defaults (org_id null) are visible to platform admins only (the isolation harness allows no row without an org
-- to a client); clients read their effective data map through app.compliance_data_map(). Org rows: that org's compliance viewers.
create policy sel on core.pii_registry for select using (
  app.is_platform_admin() or (org_id is not null and org_id = app.current_org_id() and app.can_any_product('compliance', 'view', org_id)));
create policy wr on core.pii_registry for all using (app.is_platform_admin()) with check (app.is_platform_admin());
create policy sel on core.table_policy for select using (
  app.is_platform_admin() or (org_id is not null and org_id = app.current_org_id() and app.can_any_product('compliance', 'view', org_id)));
create policy wr on core.table_policy for all using (app.is_platform_admin()) with check (app.is_platform_admin());

create policy sel on core.retention_policies for select using (
  app.is_platform_admin() or (org_id is not null and org_id = app.current_org_id() and app.can_any_product('compliance', 'view', org_id)));
-- A client admin may only add or change a row that overrides an existing platform default of the same data_type.
create policy wr on core.retention_policies for all
  using (app.is_platform_admin()
         or (org_id is not null and org_id = app.current_org_id() and app.can_any_product('compliance', 'manage', org_id)))
  with check (app.is_platform_admin()
         or (org_id is not null and org_id = app.current_org_id() and app.can_any_product('compliance', 'manage', org_id)
             and app._compliance_default_rule_exists(data_type, scope)));

create policy sel on core.legal_holds for select using (
  app.is_platform_admin() or (org_id = app.current_org_id() and app.can_any_product('compliance', 'view', org_id)));
create policy wr on core.legal_holds for all
  using (app.is_platform_admin() or (org_id = app.current_org_id() and app.can_any_product('compliance', 'manage', org_id)))
  with check (app.is_platform_admin() or (org_id = app.current_org_id() and app.can_any_product('compliance', 'manage', org_id)));

create policy sel on core.compliance_requests for select using (
  app.is_platform_admin() or (org_id = app.current_org_id() and app.can_any_product('compliance', 'view', org_id)));
create policy sel on core.org_export_jobs for select using (
  app.is_platform_admin() or (org_id = app.current_org_id() and app.can_any_product('compliance', 'view', org_id)));
create policy sel on core.consent_events for select using (
  app.is_platform_admin() or (org_id = app.current_org_id() and app.user_has_any_product(org_id)));
create policy sel on audit.purge_log for select using (
  app.is_platform_admin() or (org_id = app.current_org_id() and app.can_any_product('audit', 'view', org_id)));

select app.enable_audit('core', 'pii_registry', true);
select app.enable_audit('core', 'table_policy', true);
select app.enable_audit('core', 'retention_policies', true);
select app.enable_audit('core', 'legal_holds', true);
select app.enable_audit('core', 'compliance_requests');
select app.enable_audit('core', 'org_export_jobs');
select app.enable_audit('core', 'consent_events');

grant select on core.pii_registry, core.table_policy, core.retention_policies, core.legal_holds, core.compliance_requests,
  core.org_export_jobs, core.consent_events to authenticated, crm_server, os_server, erp_server, platform_admin_server;
grant insert, update, delete on core.pii_registry, core.table_policy, core.retention_policies to platform_admin_server;
grant insert, update on core.legal_holds to platform_admin_server;
grant select on audit.purge_log to authenticated, platform_admin_server;
grant all on core.pii_registry, core.table_policy, core.retention_policies, core.legal_holds, core.compliance_requests,
  core.org_export_jobs, core.consent_events, audit.purge_log to service_role;
-- Org admins edit retention overrides and holds through platform_admin_server, as themselves (the policies above decide).

-- ================================================================ small internal helpers (owner only)
create or replace function app._compliance_hash(p text) returns text
language sql immutable set search_path = '' as $$ select encode(sha256(convert_to(p, 'UTF8')), 'hex') $$;

create or replace function app._compliance_interval(p_value integer, p_unit text) returns interval
language sql immutable set search_path = '' as $$
  select case p_unit when 'minutes' then make_interval(mins => p_value)
                     when 'days' then make_interval(days => p_value)
                     when 'months' then make_interval(months => p_value) end
$$;

-- email -> lower case; phone-like channels -> E.164 (10 digits are taken as Indian numbers); push -> trimmed.
create or replace function app.compliance_normalise_contact(p_channel text, p_value text) returns text
language plpgsql immutable set search_path = '' as $$
declare
  v text := btrim(coalesce(p_value, ''));
  d text;
begin
  if v = '' then return null; end if;
  if p_channel = 'email' then return lower(v); end if;
  if p_channel = 'push' then return v; end if;
  d := regexp_replace(v, '[^0-9+]', '', 'g');
  if left(d, 1) = '+' then return '+' || regexp_replace(substr(d, 2), '[^0-9]', '', 'g'); end if;
  d := regexp_replace(d, '[^0-9]', '', 'g');
  if left(d, 2) = '00' then return '+' || substr(d, 3); end if;
  if length(d) = 10 then return '+91' || d; end if;
  if length(d) = 11 and left(d, 1) = '0' then return '+91' || substr(d, 2); end if;
  return '+' || d;
end $$;

create or replace function app._compliance_count(p_schema text, p_table text, p_where text) returns bigint
language plpgsql volatile security definer set search_path = '' as $$
declare v bigint;
begin
  execute format('select count(*) from %I.%I t where %s', p_schema, p_table, p_where) into v;
  return v;
end $$;

-- Writes one purge-log row (what, where, how many; never row contents).
create or replace function app._compliance_log_purge(p_org uuid, p_product text, p_source text, p_request uuid, p_rule uuid,
  p_data_type text, p_schema text, p_table text, p_action text, p_status text, p_before bigint, p_affected bigint,
  p_cutoff timestamptz, p_dry boolean, p_detail jsonb default null) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  insert into audit.purge_log (org_id, product_key, source, request_id, rule_id, data_type, schema_name, table_name, action, status,
                               rows_before, rows_affected, cutoff, dry_run, actor_user_id, detail)
  values (p_org, p_product, p_source, p_request, p_rule, p_data_type, p_schema, p_table, p_action, p_status,
          p_before, coalesce(p_affected, 0), p_cutoff, p_dry, auth.uid(), p_detail);
end $$;

-- Who may run a compliance action: a platform admin for any org, or an org member holding compliance.<action>
-- in any product of their own org. p_platform_only is for destructive org-level work. Returns the actor.
create or replace function app.compliance_authorize(p_org uuid, p_action text, p_platform_only boolean default false) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'compliance: sign-in required' using errcode = '42501';
  end if;
  if not exists (select 1 from core.organizations o where o.id = p_org) then
    raise exception 'compliance: unknown organisation' using errcode = '22023';
  end if;
  if app.is_platform_admin() then return v_uid; end if;
  if p_platform_only then
    raise exception 'compliance: only AutoEd platform admins may do this' using errcode = '42501';
  end if;
  if p_org = app.current_org_id() and app.can_any_product('compliance', p_action, p_org) then return v_uid; end if;
  raise exception 'compliance: not allowed' using errcode = '42501';
end $$;

-- ================================================================ catalogue enumeration
-- Every table with an org_id in the platform schemas the org has a stake in: core and billing always, audit on
-- request, a product schema only if the org has (or had) a subscription for that product. Found through
-- pg_catalog, so a new table is included without any change here. Policy: core.table_policy (default delete + export).
create or replace function app._compliance_org_tables(p_org uuid, p_include_audit boolean default true)
returns table (schema_name text, table_name text, product_key text, columns text[], disposition text, retain_reason text, org_export boolean)
language sql stable security definer set search_path = '' as $$
  select n.nspname::text, c.relname::text,
         case when n.nspname in ('crm','os','erp') then n.nspname::text end,
         (select array_agg(a.attname::text order by a.attnum) from pg_catalog.pg_attribute a
           where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped),
         coalesce(pol.org_deletion, 'delete'), pol.retain_reason, coalesce(pol.org_export, true)
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  left join lateral (
    select tp.org_deletion, tp.retain_reason, tp.org_export from core.table_policy tp
     where tp.schema_name = n.nspname::text and tp.table_name = c.relname::text and (tp.org_id is null or tp.org_id = p_org)
     order by tp.org_id nulls last limit 1) pol on true
  where c.relkind in ('r', 'p')
    and n.nspname::text in ('core','billing','audit','crm','os','erp')
    and exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = c.oid and a.attname = 'org_id' and a.attnum > 0 and not a.attisdropped)
    and (n.nspname::text in ('core','billing')
         or (n.nspname::text = 'audit' and p_include_audit)
         or (n.nspname::text in ('crm','os','erp')
             and exists (select 1 from core.subscriptions s where s.org_id = p_org and s.product_key = n.nspname::text)))
  order by 1, 2
$$;

-- Row counts for an org export (and its manifest). Returns [{schema, table, rows, columns, export}].
create or replace function app.compliance_table_counts(p_org uuid, p_include_audit boolean default true) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  t record;
  v_n bigint;
  v_out jsonb := '[]'::jsonb;
begin
  perform app.compliance_authorize(p_org, 'export');
  for t in select * from app._compliance_org_tables(p_org, p_include_audit) loop
    execute format('select count(*) from %I.%I where org_id = $1', t.schema_name, t.table_name) using p_org into v_n;
    v_out := v_out || jsonb_build_object('schema', t.schema_name, 'table', t.table_name, 'rows', v_n,
                                         'columns', to_jsonb(t.columns), 'export', t.org_export,
                                         'product', t.product_key);
  end loop;
  return v_out;
end $$;

-- Keyset page of one table's rows for an org: [{c: cursor, r: row}]. Call inside one repeatable-read transaction
-- so counts and rows agree. Refuses a table that is not in the org's catalogue.
create or replace function app.compliance_read_rows(p_org uuid, p_schema text, p_table text, p_after text default null,
  p_limit integer default 5000) returns setof jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  r record;
begin
  perform app.compliance_authorize(p_org, 'export');
  if not exists (select 1 from app._compliance_org_tables(p_org, true) t
                  where t.schema_name = p_schema and t.table_name = p_table and t.org_export) then
    raise exception 'compliance: table %.% is not exportable for this organisation', p_schema, p_table using errcode = '22023';
  end if;
  for r in execute format('select t.ctid::text as c, to_jsonb(t) as r from %I.%I t where t.org_id = $1 and t.ctid > $2::tid order by t.ctid limit $3', p_schema, p_table)
           using p_org, coalesce(p_after, '(0,0)'), greatest(least(coalesce(p_limit, 5000), 20000), 1) loop
    return next jsonb_build_object('c', r.c, 'r', r.r);
  end loop;
end $$;

-- ================================================================ subscription end and deletion eligibility
-- When did access to a product end? The latest transition into suspended/cancelled (from the config history of
-- core.subscriptions), else the subscription's updated_at; or the day after ends_on. Null while the product is live.
create or replace function app.compliance_subscription_ended_at(p_org uuid, p_product text) returns timestamptz
language sql stable security definer set search_path = '' as $$
  select case
    when s.status in ('suspended','cancelled') then coalesce(
      (select max(h.created_at) from audit.config_history h
        where h.org_id = s.org_id and h.schema_name = 'core' and h.table_name = 'subscriptions' and h.row_id = s.id
          and h.after ->> 'status' in ('suspended','cancelled')
          and (h.action = 'insert' or coalesce(h.before ->> 'status', '') not in ('suspended','cancelled'))),
      s.updated_at)
    when s.ends_on is not null and s.ends_on < current_date then ((s.ends_on + 1)::timestamp at time zone 'UTC')
  end
  from core.subscriptions s where s.org_id = p_org and s.product_key = p_product
$$;

-- Lifecycle period in days for an org: the platform default (or the fallback), shortened by an org row.
create or replace function app._compliance_lifecycle_days(p_org uuid, p_type text, p_fallback integer) returns integer
language sql stable security definer set search_path = '' as $$
  select least(
    coalesce((select d.period_value from core.retention_policies d where d.org_id is null and d.scope = 'lifecycle' and d.data_type = p_type), p_fallback),
    coalesce((select o.period_value from core.retention_policies o where o.org_id = p_org and o.scope = 'lifecycle' and o.data_type = p_type),
             (select d.period_value from core.retention_policies d where d.org_id is null and d.scope = 'lifecycle' and d.data_type = p_type), p_fallback))
$$;

create or replace function app._compliance_deletion_status(p_org uuid, p_product text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_blockers jsonb := '[]'::jsonb;
  v_products text[];
  p text;
  v_ended timestamptz;
  v_max timestamptz;
  v_grace integer;
  v_eligible_at timestamptz;
  v_detail jsonb := '[]'::jsonb;
begin
  if p_product is not null and p_product not in ('crm','os','erp') then
    raise exception 'compliance: unknown product %', p_product using errcode = '22023';
  end if;
  v_products := case when p_product is not null
    then (select coalesce(array_agg(s.product_key), '{}') from core.subscriptions s where s.org_id = p_org and s.product_key = p_product)
    else (select coalesce(array_agg(s.product_key order by s.product_key), '{}') from core.subscriptions s where s.org_id = p_org) end;
  v_grace := app._compliance_lifecycle_days(p_org, case when p_product is null then 'org_exit_deletion_days' else 'product_read_only_days' end, 30);

  if cardinality(v_products) = 0 then
    v_blockers := v_blockers || jsonb_build_object('code', 'no_subscription');
  end if;
  foreach p in array v_products loop
    v_ended := app.compliance_subscription_ended_at(p_org, p);
    v_detail := v_detail || jsonb_build_object('product', p, 'ended_at', v_ended, 'has_product', app.org_has_product(p_org, p));
    if app.org_has_product(p_org, p) then
      v_blockers := v_blockers || jsonb_build_object('code', 'org_has_active_product', 'product', p);
    elsif v_ended is null then
      v_blockers := v_blockers || jsonb_build_object('code', 'access_not_ended', 'product', p);
    elsif v_max is null or v_ended > v_max then
      v_max := v_ended;
    end if;
  end loop;
  if v_max is not null then
    v_eligible_at := v_max + make_interval(days => v_grace);
    if now() < v_eligible_at then
      v_blockers := v_blockers || jsonb_build_object('code', 'grace_period_not_elapsed', 'eligible_at', v_eligible_at, 'grace_days', v_grace);
    end if;
  end if;
  if exists (select 1 from core.legal_holds h where h.org_id = p_org and h.released_at is null) then
    v_blockers := v_blockers || jsonb_build_object('code', 'legal_hold');
  end if;
  -- decision 42: export first. A finished export made after access ended covers the frozen data of every product in scope.
  if cardinality(v_products) > 0 and v_max is not null and not exists (
       select 1 from core.org_export_jobs j
        where j.org_id = p_org and j.status = 'done' and j.finished_at >= v_max and j.product_keys @> v_products) then
    v_blockers := v_blockers || jsonb_build_object('code', 'export_required');
  end if;
  return jsonb_build_object('eligible', jsonb_array_length(v_blockers) = 0, 'blockers', v_blockers,
                            'eligible_at', v_eligible_at, 'grace_days', v_grace, 'products', v_detail,
                            'scope', case when p_product is null then 'org' else 'product' end);
end $$;

create or replace function app.compliance_deletion_status(p_org uuid, p_product text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform app.compliance_authorize(p_org, 'erase', true);
  return app._compliance_deletion_status(p_org, p_product);
end $$;

-- Every subscription whose access has ended, with the dates the due list needs (platform admins only).
create or replace function app.compliance_subscription_states() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not app.is_platform_admin() then
    raise exception 'compliance: only AutoEd platform admins may do this' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'org_id', s.org_id, 'product_key', s.product_key, 'status', s.status, 'ends_on', s.ends_on,
             'ended_at', app.compliance_subscription_ended_at(s.org_id, s.product_key),
             'has_product', app.org_has_product(s.org_id, s.product_key),
             'read_only_days', app._compliance_lifecycle_days(s.org_id, 'product_read_only_days', 30),
             'org_status', o.status)
           order by s.org_id, s.product_key)
      from core.subscriptions s join core.organizations o on o.id = s.org_id), '[]'::jsonb);
end $$;

-- ================================================================ per-person registry resolution
create or replace function app._compliance_registry_for(p_org uuid, p_person_type text) returns setof core.pii_registry
language sql stable security definer set search_path = '' as $$
  select x.* from (
    select distinct on (r.schema_name, r.table_name, r.key_column) r.*
      from core.pii_registry r
     where r.classification = 'personal' and r.person_type = p_person_type and (r.org_id is null or r.org_id = p_org)
     order by r.schema_name, r.table_name, r.key_column, r.org_id nulls last) x
  order by x.erase_order, x.schema_name, x.table_name, x.key_column
$$;

-- The WHERE of one registry row for one person: the key column against every id of the person (uuid, uuid[] or text
-- columns), or any contact column against the person's phones/emails. Always inside the org.
create or replace function app._compliance_person_where(p_reg core.pii_registry, p_org uuid, p_keys uuid[], p_ids text[]) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_parts text[] := '{}';
  v_type text;
  c text;
  w text;
begin
  if p_reg.key_column is not null then
    select pg_catalog.format_type(a.atttypid, a.atttypmod) into v_type from pg_catalog.pg_attribute a
     where a.attrelid = (pg_catalog.quote_ident(p_reg.schema_name) || '.' || pg_catalog.quote_ident(p_reg.table_name))::pg_catalog.regclass
       and a.attname = p_reg.key_column and not a.attisdropped;
    v_parts := array_append(v_parts, case
      when v_type = 'uuid' then format('t.%I = any(%L::uuid[])', p_reg.key_column, p_keys)
      when v_type = 'uuid[]' then format('t.%I && %L::uuid[]', p_reg.key_column, p_keys)
      else format('t.%I::text = any(%L::text[])', p_reg.key_column, (select coalesce(array_agg(k::text), '{}') from unnest(p_keys) k)) end);
  end if;
  foreach c in array p_reg.contact_columns loop
    v_parts := array_append(v_parts, format('lower(btrim(t.%I::text)) = any(%L::text[])', c, coalesce(p_ids, '{}'::text[])));
  end loop;
  w := format('t.org_id = %L and (%s)', p_org, array_to_string(v_parts, ' or '));
  if p_reg.filter_column is not null then
    w := w || format(' and t.%I::text = any(%L::text[])', p_reg.filter_column, p_reg.filter_values);
  end if;
  return w;
end $$;

-- Can this registry row be used for this org right now (table exists, columns exist, product schema in scope)?
create or replace function app._compliance_registry_usable(p_reg core.pii_registry, p_org uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare c text;
begin
  if to_regclass(format('%I.%I', p_reg.schema_name, p_reg.table_name)) is null then return 'table_missing'; end if;
  if p_reg.schema_name in ('crm','os','erp')
     and not exists (select 1 from core.subscriptions s where s.org_id = p_org and s.product_key = p_reg.schema_name) then
    return 'org_has_no_such_product';
  end if;
  if not app.has_column(p_reg.schema_name, p_reg.table_name, 'org_id')
     or (p_reg.key_column is not null and not app.has_column(p_reg.schema_name, p_reg.table_name, p_reg.key_column)) then
    return 'column_missing';
  end if;
  foreach c in array (p_reg.contact_columns || p_reg.pii_columns || p_reg.link_columns) loop
    if not app.has_column(p_reg.schema_name, p_reg.table_name, c) then return 'column_missing'; end if;
  end loop;
  if p_reg.filter_column is not null and not app.has_column(p_reg.schema_name, p_reg.table_name, p_reg.filter_column) then
    return 'column_missing';
  end if;
  return null;
end $$;

-- All ids of the person: the id the caller gave plus the other ids on the person's subject row(s)
-- (a staff id and its user id, a guardian id and its login). Found through rows flagged is_subject, so it is registry-driven.
create or replace function app._compliance_person_keys(p_org uuid, p_person_type text, p_person uuid) returns uuid[]
language plpgsql volatile security definer set search_path = '' as $$
declare
  reg core.pii_registry;
  v_cols text[];
  v_match text;
  v_found uuid[];
  v uuid[] := array[p_person];
begin
  for reg in select * from app._compliance_registry_for(p_org, p_person_type) r where r.is_subject and r.key_column is not null loop
    if app._compliance_registry_usable(reg, p_org) is not null then continue; end if;
    v_cols := array_prepend(reg.key_column, reg.link_columns);
    v_match := (select string_agg(format('t.%I = %L', x, p_person), ' or ') from unnest(v_cols) x);
    execute format('select coalesce(array_agg(distinct y) filter (where y is not null), ''{}'') from (select unnest(array[%s]) as y from %I.%I t where t.org_id = %L and (%s)) s',
                   (select string_agg(format('t.%I::uuid', x), ', ') from unnest(v_cols) x), reg.schema_name, reg.table_name, p_org, v_match) into v_found;
    v := (select coalesce(array_agg(distinct z), '{}') from unnest(v || v_found) z);
  end loop;
  return v;
end $$;

-- Phone/email values of the person, read from subject rows, plus what the caller supplied (lower-cased).
create or replace function app._compliance_identifiers(p_org uuid, p_person_type text, p_keys uuid[], p_given text[]) returns text[]
language plpgsql volatile security definer set search_path = '' as $$
declare
  reg core.pii_registry;
  c text;
  v text[] := coalesce((select array_agg(distinct lower(btrim(x))) from unnest(coalesce(p_given, '{}'::text[])) x where btrim(x) <> ''), '{}'::text[]);
  w text[];
begin
  for reg in select * from app._compliance_registry_for(p_org, p_person_type) r where r.is_subject and r.key_column is not null loop
    if app._compliance_registry_usable(reg, p_org) is not null then continue; end if;
    foreach c in array reg.contact_columns loop
      execute format('select coalesce(array_agg(distinct lower(btrim(t.%I::text))) filter (where t.%I is not null and btrim(t.%I::text) <> ''''), ''{}'') from %I.%I t where t.org_id = %L and t.%I = any(%L::uuid[])',
                     c, c, c, reg.schema_name, reg.table_name, p_org, reg.key_column, p_keys) into w;
      v := (select coalesce(array_agg(distinct y), '{}') from unnest(v || w) y);
    end loop;
  end loop;
  return v;
end $$;

-- Hold that stops everything for this org or this person (table holds are checked per table).
create or replace function app._compliance_person_hold(p_org uuid, p_person_type text, p_keys uuid[]) returns uuid
language sql stable security definer set search_path = '' as $$
  select h.id from core.legal_holds h
   where h.org_id = p_org and h.released_at is null
     and (h.scope = 'org' or (h.scope = 'person' and h.person_id = any(p_keys) and (h.person_type is null or h.person_type = p_person_type)))
   order by h.placed_at limit 1
$$;

-- The client's own request register (core.data_requests) is the front door; the engine links to it and closes it.
create or replace function app._compliance_check_data_request(p_org uuid, p_data_request uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_data_request is not null and not exists (select 1 from core.data_requests d where d.org_id = p_org and d.id = p_data_request and d.deleted_at is null) then
    raise exception 'compliance: unknown data request for this organisation' using errcode = '22023';
  end if;
end $$;

create or replace function app._compliance_close_data_request(p_org uuid, p_data_request uuid, p_request uuid, p_outcome jsonb) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_data_request is null then return; end if;
  update core.data_requests d set status = 'done',
         evidence = d.evidence || jsonb_build_object('compliance_request_id', p_request, 'completed_at', now(), 'outcome', p_outcome)
   where d.org_id = p_org and d.id = p_data_request;
end $$;

-- ================================================================ (1) per-person export
create or replace function app.compliance_person_export(p_org uuid, p_person_type text, p_person_id uuid,
  p_identifiers text[] default '{}', p_data_request uuid default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_actor uuid;
  reg core.pii_registry;
  v_ids text[];
  v_keys uuid[];
  v_why text;
  v_rows jsonb;
  v_tables jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_counts jsonb := '{}'::jsonb;
  v_n integer;
  v_req uuid;
begin
  v_actor := app.compliance_authorize(p_org, 'export');
  if p_person_type not in ('staff','student','guardian','lead') then
    raise exception 'compliance: unknown person type %', p_person_type using errcode = '22023';
  end if;
  perform app._compliance_check_data_request(p_org, p_data_request);
  v_keys := app._compliance_person_keys(p_org, p_person_type, p_person_id);
  v_ids := app._compliance_identifiers(p_org, p_person_type, v_keys, p_identifiers);
  for reg in select * from app._compliance_registry_for(p_org, p_person_type) loop
    if not reg.export then continue; end if;
    v_why := app._compliance_registry_usable(reg, p_org);
    if v_why is not null then
      v_skipped := v_skipped || jsonb_build_object('schema', reg.schema_name, 'table', reg.table_name, 'reason', v_why);
      continue;
    end if;
    execute format('select coalesce(jsonb_agg(to_jsonb(t) order by t.ctid), ''[]''::jsonb) from %I.%I t where %s',
                   reg.schema_name, reg.table_name, app._compliance_person_where(reg, p_org, v_keys, v_ids)) into v_rows;
    v_n := jsonb_array_length(v_rows);
    v_counts := v_counts || jsonb_build_object(reg.schema_name || '.' || reg.table_name || ':' || coalesce(reg.key_column, 'contact'), v_n);
    v_tables := v_tables || jsonb_build_object('schema', reg.schema_name, 'table', reg.table_name, 'key_column', coalesce(reg.key_column, 'contact'),
                                               'person_type', reg.person_type, 'rows', v_rows);
  end loop;
  insert into core.compliance_requests (org_id, kind, status, person_type, subject_person_id, requested_by, result, completed_at, data_request_id)
  values (p_org, 'person_export', 'executed', p_person_type, p_person_id, v_actor, jsonb_build_object('rows', v_counts), now(), p_data_request)
  returning id into v_req;
  perform app._compliance_close_data_request(p_org, p_data_request, v_req, jsonb_build_object('kind', 'export', 'tables', jsonb_array_length(v_tables)));
  insert into audit.log (org_id, actor_user_id, support_session_id, action, schema_name, table_name, row_id, detail)
  values (p_org, v_actor, app.support_session_id(), 'compliance.person_export', 'core', 'compliance_requests', v_req,
          jsonb_build_object('person_type', p_person_type, 'rows', v_counts));
  return jsonb_build_object('request_id', v_req, 'org_id', p_org, 'person_type', p_person_type, 'person_id', p_person_id,
                            'generated_at', now(), 'tables', v_tables, 'skipped', v_skipped);
end $$;

-- ================================================================ (2) per-person erasure / anonymisation
-- Per registry row: delete, anonymise (pii_columns -> null or the registered literal) or retain. Then the PII is
-- stripped from the audit images of the affected rows, so the trail (who, when, which row) stays and the data goes.
create or replace function app._compliance_erase(p_org uuid, p_person_type text, p_keys uuid[], p_ids text[],
  p_dry boolean, p_request uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  reg core.pii_registry;
  v_why text;
  v_where text;
  v_n bigint;
  v_ids uuid[];
  v_assign text;
  v_cols text[];
  c text;
  v_mark_log bigint := coalesce((select max(l.id) from audit.log l), 0);
  v_mark_cfg bigint := coalesce((select max(h.id) from audit.config_history h), 0);
  v_out jsonb := '[]'::jsonb;
  v_hold boolean;
  v_deleted bigint := 0;
  v_anon bigint := 0;
  v_retained bigint := 0;
  v_user_deleted boolean := false;
  v_users uuid[] := (select coalesce(array_agg(u.user_id), '{}') from core.org_users u where u.org_id = p_org and u.user_id = any(p_keys));
begin
  for reg in select * from app._compliance_registry_for(p_org, p_person_type) loop
    v_why := app._compliance_registry_usable(reg, p_org);
    if v_why is not null then
      v_out := v_out || jsonb_build_object('schema', reg.schema_name, 'table', reg.table_name, 'key_column', coalesce(reg.key_column, 'contact'),
                                           'mode', 'skip', 'rows', 0, 'reason', v_why);
      continue;
    end if;
    v_where := app._compliance_person_where(reg, p_org, p_keys, p_ids);
    v_n := app._compliance_count(reg.schema_name, reg.table_name, v_where);
    v_hold := exists (select 1 from core.legal_holds h where h.org_id = p_org and h.released_at is null and h.scope = 'table'
                       and h.schema_name = reg.schema_name and h.table_name = reg.table_name);
    if v_hold then
      v_retained := v_retained + v_n;
      v_out := v_out || jsonb_build_object('schema', reg.schema_name, 'table', reg.table_name, 'key_column', coalesce(reg.key_column, 'contact'),
                                           'mode', 'retain', 'rows', v_n, 'reason', 'legal_hold');
      perform app._compliance_log_purge(p_org, null, 'person_erasure', p_request, null, reg.person_type, reg.schema_name, reg.table_name,
                                        'retain', 'skipped_legal_hold', v_n, 0, null, p_dry);
      continue;
    end if;
    if reg.erasure_mode = 'retain' then
      v_retained := v_retained + v_n;
      v_out := v_out || jsonb_build_object('schema', reg.schema_name, 'table', reg.table_name, 'key_column', coalesce(reg.key_column, 'contact'),
                                           'mode', 'retain', 'rows', v_n, 'reason', reg.retain_reason);
      perform app._compliance_log_purge(p_org, null, 'person_erasure', p_request, null, reg.person_type, reg.schema_name, reg.table_name,
                                        'retain', case when p_dry then 'dry_run' else 'skipped_retained' end, v_n, 0, null, p_dry,
                                        jsonb_build_object('reason', reg.retain_reason));
      continue;
    end if;

    v_cols := (select coalesce(array_agg(distinct x), '{}') from unnest(
                 reg.pii_columns || reg.audit_columns || reg.contact_columns || array(select jsonb_object_keys(reg.anonymise_values))) x);
    if p_dry then
      if reg.erasure_mode = 'delete' then v_deleted := v_deleted + v_n; else v_anon := v_anon + v_n; end if;
      v_out := v_out || jsonb_build_object('schema', reg.schema_name, 'table', reg.table_name, 'key_column', coalesce(reg.key_column, 'contact'),
                                           'mode', reg.erasure_mode, 'rows', v_n);
      perform app._compliance_log_purge(p_org, null, 'person_erasure', p_request, null, reg.person_type, reg.schema_name, reg.table_name,
                                        reg.erasure_mode, 'dry_run', v_n, 0, null, true);
      continue;
    end if;

    if reg.erasure_mode = 'delete' then
      execute format('with d as (delete from %I.%I t where %s returning coalesce(app.try_uuid(to_jsonb(t) ->> ''id''), app.try_uuid(to_jsonb(t) ->> ''user_id'')) as rid) select coalesce(array_agg(rid), ''{}''), count(*) from d',
                     reg.schema_name, reg.table_name, v_where) into v_ids, v_n;
      v_deleted := v_deleted + v_n;
      if reg.schema_name = 'core' and reg.table_name = 'org_users' then v_user_deleted := v_user_deleted or v_n > 0; end if;
    else
      v_assign := '';
      foreach c in array (select coalesce(array_agg(distinct x), '{}') from unnest(reg.pii_columns || array(select jsonb_object_keys(reg.anonymise_values))) x) loop
        v_assign := v_assign || case when v_assign = '' then '' else ', ' end ||
          case when reg.anonymise_values ? c and jsonb_typeof(reg.anonymise_values -> c) <> 'null'
               then format('%I = %L', c, reg.anonymise_values ->> c) else format('%I = null', c) end;
      end loop;
      execute format('with u as (update %I.%I t set %s where %s returning coalesce(app.try_uuid(to_jsonb(t) ->> ''id''), app.try_uuid(to_jsonb(t) ->> ''user_id'')) as rid) select coalesce(array_agg(rid), ''{}''), count(*) from u',
                     reg.schema_name, reg.table_name, v_assign, v_where) into v_ids, v_n;
      v_anon := v_anon + v_n;
    end if;

    -- audit images of the affected rows: old history by row id, and everything this statement just wrote
    update audit.log l set before = case when l.before is null then null else l.before - v_cols end,
                           after = case when l.after is null then null else l.after - v_cols end
     where l.org_id = p_org and l.schema_name = reg.schema_name and l.table_name = reg.table_name
       and (l.row_id = any(v_ids) or l.id > v_mark_log);
    update audit.config_history h set before = case when h.before is null then null else h.before - v_cols end,
                                      after = case when h.after is null then null else h.after - v_cols end
     where h.org_id = p_org and h.schema_name = reg.schema_name and h.table_name = reg.table_name
       and (h.row_id = any(v_ids) or h.id > v_mark_cfg);

    v_out := v_out || jsonb_build_object('schema', reg.schema_name, 'table', reg.table_name, 'key_column', coalesce(reg.key_column, 'contact'),
                                         'mode', reg.erasure_mode, 'rows', v_n);
    perform app._compliance_log_purge(p_org, null, 'person_erasure', p_request, null, reg.person_type, reg.schema_name, reg.table_name,
                                      reg.erasure_mode, 'done', v_n, v_n, null, false);
  end loop;
  return jsonb_build_object('tables', v_out, 'deleted', v_deleted, 'anonymised', v_anon, 'retained', v_retained,
    'external_actions', case when v_user_deleted
      then jsonb_build_array(jsonb_build_object('kind', 'auth_user_delete', 'user_ids', to_jsonb(v_users),
                                                'note', 'delete the Supabase Auth user (email/phone) through the admin API; not reachable from SQL'))
      else '[]'::jsonb end);
end $$;

-- Step 1: dry-run plan + token. Nothing changes. identity_verified is the data-subject-rights step 2 outcome.
create or replace function app.compliance_person_erasure_plan(p_org uuid, p_person_type text, p_person_id uuid,
  p_identifiers text[] default '{}', p_reason text default null, p_identity_verified boolean default false,
  p_data_request uuid default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_actor uuid;
  v_ids text[];
  v_keys uuid[];
  v_hold uuid;
  v_plan jsonb;
  v_token text;
  v_req uuid;
  v_ttl integer;
begin
  v_actor := app.compliance_authorize(p_org, 'erase');
  if p_person_type not in ('staff','student','guardian','lead') then
    raise exception 'compliance: unknown person type %', p_person_type using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 10 then
    raise exception 'compliance: a reason of at least 10 characters is required' using errcode = '22023';
  end if;
  perform app._compliance_check_data_request(p_org, p_data_request);
  v_keys := app._compliance_person_keys(p_org, p_person_type, p_person_id);
  v_hold := app._compliance_person_hold(p_org, p_person_type, v_keys);
  if v_hold is not null then
    insert into core.compliance_requests (org_id, kind, status, person_type, subject_person_id, reason, requested_by, blockers, completed_at, data_request_id)
    values (p_org, 'person_erasure', 'refused', p_person_type, p_person_id, btrim(p_reason), v_actor,
            jsonb_build_array(jsonb_build_object('code', 'legal_hold', 'hold_id', v_hold)), now(), p_data_request)
    returning id into v_req;
    return jsonb_build_object('request_id', v_req, 'status', 'refused', 'eligible', false,
                              'blockers', jsonb_build_array(jsonb_build_object('code', 'legal_hold', 'hold_id', v_hold)));
  end if;
  v_ids := app._compliance_identifiers(p_org, p_person_type, v_keys, p_identifiers);
  v_req := gen_random_uuid();
  v_plan := app._compliance_erase(p_org, p_person_type, v_keys, v_ids, true, v_req);
  v_ttl := app._compliance_lifecycle_days(p_org, 'confirmation_token_minutes', 60);   -- unit is minutes for this row
  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into core.compliance_requests (id, org_id, kind, status, person_type, subject_person_id, plan, reason, requested_by,
                                        identity_verified_at, identity_verified_by, token_hash, token_expires_at, data_request_id)
  values (v_req, p_org, 'person_erasure', 'planned', p_person_type, p_person_id,
          v_plan, btrim(p_reason), v_actor,
          case when p_identity_verified then now() end, case when p_identity_verified then v_actor end,
          app._compliance_hash(v_token), now() + make_interval(mins => v_ttl), p_data_request);
  -- opportunistic housekeeping: plans nobody confirmed within a day
  delete from private.compliance_request_secrets x where x.created_at < now() - interval '1 day';
  insert into private.compliance_request_secrets (request_id, org_id, identifiers) values (v_req, p_org, v_ids);
  return jsonb_build_object('request_id', v_req, 'status', 'planned', 'eligible', true, 'confirmation_token', v_token,
                            'token_expires_at', now() + make_interval(mins => v_ttl), 'identity_verified', p_identity_verified,
                            'plan', v_plan);
end $$;

-- Step 2: needs the request id and the token from step 1, and a verified identity.
create or replace function app.compliance_person_erasure_execute(p_request uuid, p_token text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  r core.compliance_requests;
  v_actor uuid;
  v_hold uuid;
  v_keys uuid[];
  v_res jsonb;
begin
  select * into r from core.compliance_requests q where q.id = p_request for update;
  if not found or r.kind <> 'person_erasure' then
    raise exception 'compliance: unknown request' using errcode = '22023';
  end if;
  v_actor := app.compliance_authorize(r.org_id, 'erase');
  if r.status <> 'planned' then
    raise exception 'compliance: request is %, not planned', r.status using errcode = '22023';
  end if;
  if r.token_hash is distinct from app._compliance_hash(coalesce(p_token, '')) or r.token_expires_at < now() then
    raise exception 'compliance: invalid or expired confirmation token' using errcode = '42501';
  end if;
  if r.identity_verified_at is null then
    delete from private.compliance_request_secrets x where x.request_id = r.id;
    update core.compliance_requests q set status = 'refused', blockers = jsonb_build_array(jsonb_build_object('code', 'identity_not_verified')), completed_at = now() where q.id = r.id;
    return jsonb_build_object('ok', false, 'status', 'refused', 'blockers', jsonb_build_array(jsonb_build_object('code', 'identity_not_verified')));
  end if;
  v_keys := app._compliance_person_keys(r.org_id, r.person_type, r.subject_person_id);
  v_hold := app._compliance_person_hold(r.org_id, r.person_type, v_keys);
  if v_hold is not null then
    delete from private.compliance_request_secrets x where x.request_id = r.id;
    update core.compliance_requests q set status = 'refused', blockers = jsonb_build_array(jsonb_build_object('code', 'legal_hold', 'hold_id', v_hold)), completed_at = now() where q.id = r.id;
    return jsonb_build_object('ok', false, 'status', 'refused', 'blockers', jsonb_build_array(jsonb_build_object('code', 'legal_hold', 'hold_id', v_hold)));
  end if;
  v_res := app._compliance_erase(r.org_id, r.person_type, v_keys,
             coalesce((select x.identifiers from private.compliance_request_secrets x where x.request_id = r.id), '{}'::text[]), false, r.id);
  -- the tombstone: request id, class, date, counts. The identifiers are dropped.
  delete from private.compliance_request_secrets x where x.request_id = r.id;
  update core.compliance_requests q set status = 'executed', result = v_res,
         confirmed_by = v_actor, confirmed_at = now(), completed_at = now(), token_hash = null
   where q.id = r.id;
  perform app._compliance_close_data_request(r.org_id, r.data_request_id, r.id,
            jsonb_build_object('kind', 'erasure', 'deleted', v_res -> 'deleted', 'anonymised', v_res -> 'anonymised', 'retained', v_res -> 'retained'));
  insert into audit.log (org_id, actor_user_id, support_session_id, action, schema_name, table_name, row_id, detail)
  values (r.org_id, v_actor, app.support_session_id(), 'compliance.person_erased', 'core', 'compliance_requests', r.id,
          jsonb_build_object('person_type', r.person_type, 'deleted', v_res -> 'deleted', 'anonymised', v_res -> 'anonymised', 'retained', v_res -> 'retained'));
  return jsonb_build_object('ok', true, 'status', 'executed', 'request_id', r.id, 'result', v_res);
end $$;

-- ================================================================ (3) org export bookkeeping and org / product deletion
-- The files are built by the server (packages/server/src/compliance/orgExport.ts); the database tracks the job.
create or replace function app.compliance_org_export_start(p_org uuid, p_products text[] default null,
  p_purpose text default 'on_demand', p_formats text[] default '{csv,xlsx}') returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_actor uuid;
  v_products text[];
  v_id uuid;
begin
  v_actor := app.compliance_authorize(p_org, 'export');
  v_products := coalesce(p_products, (select coalesce(array_agg(s.product_key order by s.product_key), '{}') from core.subscriptions s where s.org_id = p_org));
  if exists (select 1 from unnest(v_products) x where x not in ('crm','os','erp')) then
    raise exception 'compliance: unknown product in %', v_products using errcode = '22023';
  end if;
  insert into core.org_export_jobs (org_id, purpose, product_keys, formats, requested_by)
  values (p_org, p_purpose, v_products, p_formats, v_actor) returning id into v_id;
  insert into audit.log (org_id, actor_user_id, support_session_id, action, schema_name, table_name, row_id, detail)
  values (p_org, v_actor, app.support_session_id(), 'compliance.org_export_started', 'core', 'org_export_jobs', v_id,
          jsonb_build_object('products', v_products, 'purpose', p_purpose));
  return v_id;
end $$;

create or replace function app.compliance_org_export_finish(p_job uuid, p_ok boolean, p_manifest jsonb default null,
  p_manifest_sha256 text default null, p_archive_sha256 text default null, p_archive_bytes bigint default null,
  p_storage_key text default null, p_error text default null, p_total_rows bigint default null) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  j core.org_export_jobs;
  v_actor uuid;
  v_days integer;
begin
  select * into j from core.org_export_jobs x where x.id = p_job for update;
  if not found then raise exception 'compliance: unknown export job' using errcode = '22023'; end if;
  v_actor := app.compliance_authorize(j.org_id, 'export');
  if j.status <> 'running' then raise exception 'compliance: export job is already %', j.status using errcode = '22023'; end if;
  v_days := app._compliance_lifecycle_days(j.org_id, 'export_link_days', 7);
  update core.org_export_jobs x set
    status = case when p_ok then 'done' else 'failed' end, manifest = p_manifest, manifest_sha256 = p_manifest_sha256,
    archive_sha256 = p_archive_sha256, archive_bytes = p_archive_bytes, storage_key = p_storage_key,
    error = case when p_ok then null else left(p_error, 2000) end, total_rows = p_total_rows,
    row_counts = (select coalesce(jsonb_object_agg(t ->> 'schema' || '.' || (t ->> 'table'), (t ->> 'rows')::bigint), '{}'::jsonb)
                    from jsonb_array_elements(coalesce(p_manifest -> 'tables', '[]'::jsonb)) t),
    finished_at = now(), expires_at = case when p_ok then now() + make_interval(days => v_days) end
  where x.id = p_job;
  insert into audit.log (org_id, actor_user_id, support_session_id, action, schema_name, table_name, row_id, detail)
  values (j.org_id, v_actor, app.support_session_id(),
          case when p_ok then 'compliance.org_export_done' else 'compliance.org_export_failed' end, 'core', 'org_export_jobs', j.id,
          jsonb_build_object('total_rows', p_total_rows, 'archive_sha256', p_archive_sha256));
end $$;

-- Org (p_product null) or product deletion. Counts per table; with p_dry nothing changes.
create or replace function app._compliance_delete_scope(p_org uuid, p_product text, p_dry boolean, p_request uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  t record;
  v_n bigint;
  v_pass integer := 0;
  v_left bigint;
  v_prev bigint := -1;
  v_out jsonb := '[]'::jsonb;
  v_retained jsonb := '[]'::jsonb;
  v_tables jsonb := '[]'::jsonb;
  v_rows jsonb := '{}'::jsonb;
  v_total bigint := 0;
  v_users uuid[];
  v_key text;
  v_src text := case when p_product is null then 'org_deletion' else 'product_deletion' end;
  v_scrub record;
begin
  v_users := case when p_product is null then
      (select coalesce(array_agg(u.user_id), '{}') from core.org_users u where u.org_id = p_org) else '{}'::uuid[] end;
  -- collect the in-scope tables (audit is never deleted here: it is scrubbed below and ages out by retention)
  for t in select * from app._compliance_org_tables(p_org, false)
            where (p_product is null or schema_name = p_product) loop
    v_n := app._compliance_count(t.schema_name, t.table_name, format('t.org_id = %L', p_org));
    v_key := t.schema_name || '.' || t.table_name;
    if t.disposition = 'retain' then
      v_retained := v_retained || jsonb_build_object('schema', t.schema_name, 'table', t.table_name, 'rows', v_n, 'reason', t.retain_reason);
      perform app._compliance_log_purge(p_org, p_product, v_src, p_request, null, null, t.schema_name, t.table_name, 'retain',
                                        case when p_dry then 'dry_run' else 'skipped_retained' end, v_n, 0, null, p_dry,
                                        jsonb_build_object('reason', t.retain_reason));
    else
      v_tables := v_tables || jsonb_build_object('schema', t.schema_name, 'table', t.table_name, 'rows', v_n);
      v_rows := v_rows || jsonb_build_object(v_key, v_n);
      v_total := v_total + v_n;
    end if;
  end loop;
  -- private queue/webhook rows of the org are client data too (payloads may hold phone numbers)
  for t in select 'private'::text as schema_name, x as table_name from unnest(array['jobs','webhook_events','rate_limits','compliance_request_secrets']) x loop
    execute format('select count(*) from private.%I where org_id = $1 %s', t.table_name,
                   case when p_product is not null and t.table_name = 'jobs' then 'and product_key = ' || quote_literal(p_product)
                        when p_product is not null then 'and false' else '' end) using p_org into v_n;
    v_tables := v_tables || jsonb_build_object('schema', 'private', 'table', t.table_name, 'rows', v_n);
    v_rows := v_rows || jsonb_build_object('private.' || t.table_name, v_n);
    v_total := v_total + v_n;
  end loop;

  if p_dry then
    for t in select e ->> 'schema' as s, e ->> 'table' as n, (e ->> 'rows')::bigint as r from jsonb_array_elements(v_tables) e loop
      perform app._compliance_log_purge(p_org, p_product, v_src, p_request, null, null, t.s, t.n, 'delete', 'dry_run', t.r, 0, null, true);
    end loop;
    return jsonb_build_object('tables', v_tables, 'retained', v_retained, 'total_rows', v_total, 'auth_user_ids', to_jsonb(v_users));
  end if;

  -- the retained organisation row must not point at a file row that is about to go
  if p_product is null and app.has_column('core', 'organizations', 'logo_file_id') then
    update core.organizations o set logo_file_id = null where o.id = p_org;
  end if;
  -- delete in passes: a foreign-key violation just means a child table must go first; retry until nothing is left
  loop
    v_pass := v_pass + 1;
    for t in select e ->> 'schema' as s, e ->> 'table' as n from jsonb_array_elements(v_tables) e loop
      begin
        if t.s = 'private' then
          execute format('delete from private.%I where org_id = $1 %s', t.n,
                         case when p_product is not null and t.n = 'jobs' then 'and product_key = ' || quote_literal(p_product)
                              when p_product is not null then 'and false' else '' end) using p_org;
        else
          execute format('delete from %I.%I where org_id = $1', t.s, t.n) using p_org;
        end if;
      exception when foreign_key_violation then
        null;
      end;
    end loop;
    v_left := 0;
    for t in select e ->> 'schema' as s, e ->> 'table' as n from jsonb_array_elements(v_tables) e loop
      if t.s = 'private' then
        execute format('select count(*) from private.%I where org_id = $1 %s', t.n,
                       case when p_product is not null and t.n = 'jobs' then 'and product_key = ' || quote_literal(p_product)
                            when p_product is not null then 'and false' else '' end) using p_org into v_n;
      else
        v_n := app._compliance_count(t.s, t.n, format('t.org_id = %L', p_org));
      end if;
      v_left := v_left + v_n;
    end loop;
    exit when v_left = 0;
    if v_left = v_prev or v_pass >= 12 then
      raise exception 'compliance: deletion stuck with % rows left after % passes', v_left, v_pass using errcode = '23503';
    end if;
    v_prev := v_left;
  end loop;

  -- the audit trail keeps who/when/which table/row id, never the data: strip the images of everything deleted
  for v_scrub in select e ->> 'schema' as s, e ->> 'table' as n from jsonb_array_elements(v_tables) e where e ->> 'schema' <> 'private' loop
    update audit.log l set before = null, after = null where l.org_id = p_org and l.schema_name = v_scrub.s and l.table_name = v_scrub.n
       and (l.before is not null or l.after is not null);
    update audit.config_history h set before = null, after = null where h.org_id = p_org and h.schema_name = v_scrub.s and h.table_name = v_scrub.n
       and (h.before is not null or h.after is not null);
  end loop;
  for t in select e ->> 'schema' as s, e ->> 'table' as n, (e ->> 'rows')::bigint as r from jsonb_array_elements(v_tables) e loop
    perform app._compliance_log_purge(p_org, p_product, v_src, p_request, null, null, t.s, t.n, 'delete', 'done', t.r, t.r, null, false);
  end loop;
  return jsonb_build_object('tables', v_tables, 'retained', v_retained, 'total_rows', v_total, 'auth_user_ids', to_jsonb(v_users));
end $$;

-- Step 1: dry run. Prints what would be deleted and what is retained, says why it is or is not allowed now,
-- and (only when allowed) returns the confirmation token needed for step 2.
create or replace function app.compliance_org_deletion_plan(p_org uuid, p_product text default null, p_reason text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_actor uuid;
  v_status jsonb;
  v_plan jsonb;
  v_token text;
  v_req uuid := gen_random_uuid();
  v_ttl integer;
  v_ok boolean;
begin
  v_actor := app.compliance_authorize(p_org, 'erase', true);
  if p_reason is null or length(btrim(p_reason)) < 10 then
    raise exception 'compliance: a reason of at least 10 characters is required' using errcode = '22023';
  end if;
  v_status := app._compliance_deletion_status(p_org, p_product);
  v_ok := (v_status ->> 'eligible')::boolean;
  v_plan := app._compliance_delete_scope(p_org, p_product, true, v_req);
  v_ttl := app._compliance_lifecycle_days(p_org, 'confirmation_token_minutes', 60);
  if v_ok then v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''); end if;
  insert into core.compliance_requests (id, org_id, kind, status, product_key, plan, blockers, reason, requested_by, eligible_at,
                                        token_hash, token_expires_at, completed_at)
  values (v_req, p_org, case when p_product is null then 'org_deletion' else 'product_deletion' end,
          case when v_ok then 'planned' else 'refused' end, p_product, v_plan, v_status -> 'blockers', btrim(p_reason), v_actor,
          (v_status ->> 'eligible_at')::timestamptz,
          case when v_ok then app._compliance_hash(v_token) end,
          case when v_ok then now() + make_interval(mins => v_ttl) end,
          case when v_ok then null else now() end);
  return jsonb_build_object('request_id', v_req, 'dry_run', true, 'eligible', v_ok, 'status', case when v_ok then 'planned' else 'refused' end,
                            'blockers', v_status -> 'blockers', 'eligible_at', v_status -> 'eligible_at', 'grace_days', v_status -> 'grace_days',
                            'confirmation_token', v_token, 'token_expires_at', case when v_ok then now() + make_interval(mins => v_ttl) end,
                            'plan', v_plan);
end $$;

-- Step 2: re-checks everything (grace period, subscriptions, holds, export) and refuses if anything changed.
create or replace function app.compliance_org_deletion_execute(p_request uuid, p_token text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  r core.compliance_requests;
  v_actor uuid;
  v_status jsonb;
  v_res jsonb;
begin
  select * into r from core.compliance_requests q where q.id = p_request for update;
  if not found or r.kind not in ('org_deletion','product_deletion') then
    raise exception 'compliance: unknown request' using errcode = '22023';
  end if;
  v_actor := app.compliance_authorize(r.org_id, 'erase', true);
  if r.status <> 'planned' then
    raise exception 'compliance: request is %, not planned', r.status using errcode = '22023';
  end if;
  if r.token_hash is distinct from app._compliance_hash(coalesce(p_token, '')) or r.token_expires_at < now() then
    raise exception 'compliance: invalid or expired confirmation token' using errcode = '42501';
  end if;
  v_status := app._compliance_deletion_status(r.org_id, r.product_key);
  if not (v_status ->> 'eligible')::boolean then
    update core.compliance_requests q set status = 'refused', blockers = v_status -> 'blockers', completed_at = now() where q.id = r.id;
    return jsonb_build_object('ok', false, 'status', 'refused', 'blockers', v_status -> 'blockers');
  end if;
  v_res := app._compliance_delete_scope(r.org_id, r.product_key, false, r.id);
  if r.product_key is null then
    -- the organisation row stays (invoices and the contract record need it); it is closed
    update core.organizations o set status = 'closed' where o.id = r.org_id;
  end if;
  update core.compliance_requests q set status = 'executed', result = v_res - 'auth_user_ids' ||
         jsonb_build_object('auth_users_to_delete', jsonb_array_length(coalesce(v_res -> 'auth_user_ids', '[]'::jsonb))),
         confirmed_by = v_actor, confirmed_at = now(), completed_at = now(), token_hash = null
   where q.id = r.id;
  insert into audit.log (org_id, actor_user_id, support_session_id, action, schema_name, table_name, row_id, detail)
  values (r.org_id, v_actor, app.support_session_id(),
          case when r.product_key is null then 'compliance.org_deleted' else 'compliance.product_deleted' end,
          'core', 'compliance_requests', r.id,
          jsonb_build_object('product', r.product_key, 'total_rows', v_res -> 'total_rows'));
  return jsonb_build_object('ok', true, 'status', 'executed', 'request_id', r.id, 'result', v_res,
    'external_actions', jsonb_build_array(
      jsonb_build_object('kind', 'auth_user_delete', 'user_ids', coalesce(v_res -> 'auth_user_ids', '[]'::jsonb),
                         'note', 'delete these Supabase Auth users through the admin API'),
      jsonb_build_object('kind', 'storage_prefix_delete', 'prefix', r.org_id::text || '/',
                         'buckets', case when r.product_key is null then jsonb_build_array('core-files','crm-files','os-files','erp-files')
                                         else jsonb_build_array(r.product_key || '-files') end,
                         'note', 'delete the objects through the Storage API; not reachable from SQL')));
end $$;

-- ================================================================ (4) retention purge
-- Effective rule per data_type for an org: the platform default (core.retention_policies) decides table, clock, filter and
-- action. The period is the SHORTEST of: the default, an org override row in core.retention_policies, and the client's own
-- rule of the same data_type in core.retention_rules (keep_years, the master-data table clients edit). A client may only
-- shorten. An org policy row may also switch the rule on or off.
create or replace function app._compliance_effective_rules(p_org uuid)
returns table (rule_id uuid, data_type text, product_key text, schema_name text, table_name text, date_column text,
               filter_column text, filter_values text[], action text, anonymise_columns text[], anonymise_values jsonb,
               period_value integer, period_unit text, enabled boolean, legal_status text, org_override boolean)
language sql stable security definer set search_path = '' as $$
  select d.id, d.data_type, d.product_key, d.schema_name, d.table_name, d.date_column, d.filter_column, d.filter_values, d.action,
         d.anonymise_columns, d.anonymise_values, best.v, best.u,
         coalesce(o.enabled, d.enabled), coalesce(o.legal_status, d.legal_status), (o.id is not null or c.keep_years is not null)
    from core.retention_policies d
    left join core.retention_policies o on o.org_id = p_org and o.data_type = d.data_type and o.scope = 'table'
    left join lateral (select min(r.keep_years) as keep_years from core.retention_rules r
                        where r.org_id = p_org and r.deleted_at is null and r.keep_years > 0 and r.data_type = d.data_type
                          and (r.product_key is null or r.product_key is not distinct from d.product_key)) c on true
    cross join lateral (select x.v, x.u from (values (d.period_value, d.period_unit), (o.period_value, o.period_unit), (c.keep_years * 12, 'months')) x(v, u)
                         where x.v is not null order by app._compliance_interval(x.v, x.u) limit 1) best
   where d.org_id is null and d.scope = 'table'
$$;

create or replace function app._compliance_first_product(p_org uuid) returns text
language sql stable security definer set search_path = '' as $$
  select min(p.key) from core.products p where app.org_has_product(p_org, p.key)
$$;

-- Runs the org's enabled rules for one product. Refuses (and logs) when the org does not have the product.
-- p_dry_run counts only. Every rule run, skipped or purged writes audit.purge_log.
create or replace function app.compliance_retention_purge(p_org uuid, p_product text, p_dry_run boolean default true,
  p_batch integer default 5000, p_max_batches integer default 200) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  r record;
  v_first text;
  v_hold boolean;
  v_cut timestamptz;
  v_where text;
  v_before bigint;
  v_n bigint;
  v_total bigint;
  v_b integer;
  v_assign text;
  v_guard text;
  v_cols text[];
  v_ids uuid[];
  c text;
  v_mark_log bigint;
  v_mark_cfg bigint;
  v_results jsonb := '[]'::jsonb;
  v_rows bigint := 0;
  v_status text;
  v_batch integer := greatest(coalesce(p_batch, 5000), 1);
begin
  if p_product is null or p_product not in ('crm','os','erp') then
    raise exception 'compliance: unknown product %', p_product using errcode = '22023';
  end if;
  if not exists (select 1 from core.organizations o where o.id = p_org) then
    raise exception 'compliance: unknown organisation' using errcode = '22023';
  end if;
  -- plan 4.10: the handler re-checks the subscription; an org without the product is skipped and logged
  if not app.org_has_product(p_org, p_product) then
    perform app._compliance_log_purge(p_org, p_product, 'retention', null, null, null, null, null, 'skip', 'skipped_no_product', null, 0, null, p_dry_run,
                                      jsonb_build_object('reason', 'org has no active ' || p_product || ' subscription'));
    insert into audit.log (org_id, actor_user_id, action, schema_name, table_name, detail)
    values (p_org, auth.uid(), 'compliance.purge_skipped', 'audit', 'purge_log', jsonb_build_object('product', p_product, 'reason', 'no active subscription'));
    return jsonb_build_object('org_id', p_org, 'product', p_product, 'skipped', true, 'reason', 'no_product', 'rules', '[]'::jsonb, 'rows', 0);
  end if;
  v_first := app._compliance_first_product(p_org);
  v_hold := exists (select 1 from core.legal_holds h where h.org_id = p_org and h.released_at is null and h.scope in ('org','person'));

  for r in select * from app._compliance_effective_rules(p_org) e
            where e.product_key = p_product or (e.product_key is null and p_product = v_first)
            order by e.data_type loop
    if not r.enabled and not p_dry_run then
      perform app._compliance_log_purge(p_org, p_product, 'retention', null, r.rule_id, r.data_type, r.schema_name, r.table_name, 'skip', 'skipped_disabled', null, 0, null, false);
      v_results := v_results || jsonb_build_object('data_type', r.data_type, 'status', 'skipped_disabled');
      continue;
    end if;
    if to_regclass(format('%I.%I', r.schema_name, r.table_name)) is null
       or not app.has_column(r.schema_name, r.table_name, 'org_id') or not app.has_column(r.schema_name, r.table_name, r.date_column)
       or (r.filter_column is not null and not app.has_column(r.schema_name, r.table_name, r.filter_column)) then
      perform app._compliance_log_purge(p_org, p_product, 'retention', null, r.rule_id, r.data_type, r.schema_name, r.table_name, 'skip', 'skipped_table_missing', null, 0, null, p_dry_run);
      v_results := v_results || jsonb_build_object('data_type', r.data_type, 'status', 'skipped_table_missing');
      continue;
    end if;
    if v_hold or exists (select 1 from core.legal_holds h where h.org_id = p_org and h.released_at is null and h.scope = 'table'
                          and h.schema_name = r.schema_name and h.table_name = r.table_name) then
      perform app._compliance_log_purge(p_org, p_product, 'retention', null, r.rule_id, r.data_type, r.schema_name, r.table_name, 'skip', 'skipped_legal_hold', null, 0, null, p_dry_run);
      v_results := v_results || jsonb_build_object('data_type', r.data_type, 'status', 'skipped_legal_hold');
      continue;
    end if;

    v_cut := now() - app._compliance_interval(r.period_value, r.period_unit);
    v_where := format('t.org_id = %L and t.%I < %L', p_org, r.date_column, v_cut);
    if r.filter_column is not null then
      v_where := v_where || format(' and t.%I::text = any(%L::text[])', r.filter_column, r.filter_values);
    end if;

    v_assign := '';
    v_guard := '';
    if r.action = 'anonymise' then
      foreach c in array (select coalesce(array_agg(distinct x), '{}') from unnest(r.anonymise_columns || array(select jsonb_object_keys(r.anonymise_values))) x) loop
        v_assign := v_assign || case when v_assign = '' then '' else ', ' end ||
          case when r.anonymise_values ? c and jsonb_typeof(r.anonymise_values -> c) <> 'null'
               then format('%I = %L', c, r.anonymise_values ->> c) else format('%I = null', c) end;
        v_guard := v_guard || case when v_guard = '' then '' else ' or ' end ||
          case when r.anonymise_values ? c and jsonb_typeof(r.anonymise_values -> c) <> 'null'
               then format('t.%I is distinct from %L', c, r.anonymise_values ->> c) else format('t.%I is not null', c) end;
      end loop;
      v_where := v_where || ' and (' || v_guard || ')';
    end if;

    v_before := app._compliance_count(r.schema_name, r.table_name, v_where);
    if p_dry_run then
      perform app._compliance_log_purge(p_org, p_product, 'retention', null, r.rule_id, r.data_type, r.schema_name, r.table_name, r.action, 'dry_run', v_before, 0, v_cut, true);
      v_results := v_results || jsonb_build_object('data_type', r.data_type, 'status', 'dry_run', 'would_affect', v_before, 'cutoff', v_cut, 'enabled', r.enabled);
      continue;
    end if;

    v_mark_log := coalesce((select max(l.id) from audit.log l), 0);
    v_mark_cfg := coalesce((select max(h.id) from audit.config_history h), 0);
    v_total := 0;
    v_b := 0;
    v_cols := (select coalesce(array_agg(distinct x), '{}') from unnest(r.anonymise_columns || array(select jsonb_object_keys(r.anonymise_values))) x);
    loop
      exit when v_b >= p_max_batches or v_before = 0;
      v_b := v_b + 1;
      if r.action = 'delete' then
        execute format('with d as (delete from %1$I.%2$I t where t.ctid = any(array(select t.ctid from %1$I.%2$I t where %3$s limit %4$s)) returning coalesce(app.try_uuid(to_jsonb(t) ->> ''id''), app.try_uuid(to_jsonb(t) ->> ''user_id'')) as rid) select coalesce(array_agg(rid), ''{}''), count(*) from d',
                       r.schema_name, r.table_name, v_where, v_batch) into v_ids, v_n;
      else
        execute format('with u as (update %1$I.%2$I t set %5$s where t.ctid = any(array(select t.ctid from %1$I.%2$I t where %3$s limit %4$s)) returning coalesce(app.try_uuid(to_jsonb(t) ->> ''id''), app.try_uuid(to_jsonb(t) ->> ''user_id'')) as rid) select coalesce(array_agg(rid), ''{}''), count(*) from u',
                       r.schema_name, r.table_name, v_where, v_batch, v_assign) into v_ids, v_n;
      end if;
      v_total := v_total + v_n;
      -- the purge must not leave the purged data behind in the audit images (old ones by row id, new ones by position)
      if r.schema_name <> 'audit' and v_n > 0 then
        if r.action = 'delete' then
          update audit.log l set before = null, after = null
           where l.org_id = p_org and l.schema_name = r.schema_name and l.table_name = r.table_name
             and (l.row_id = any(v_ids) or l.id > v_mark_log) and (l.before is not null or l.after is not null);
          update audit.config_history h set before = null, after = null
           where h.org_id = p_org and h.schema_name = r.schema_name and h.table_name = r.table_name
             and (h.row_id = any(v_ids) or h.id > v_mark_cfg) and (h.before is not null or h.after is not null);
        else
          update audit.log l set before = case when l.before is null then null else l.before - v_cols end,
                                 after = case when l.after is null then null else l.after - v_cols end
           where l.org_id = p_org and l.schema_name = r.schema_name and l.table_name = r.table_name and (l.row_id = any(v_ids) or l.id > v_mark_log);
          update audit.config_history h set before = case when h.before is null then null else h.before - v_cols end,
                                            after = case when h.after is null then null else h.after - v_cols end
           where h.org_id = p_org and h.schema_name = r.schema_name and h.table_name = r.table_name and (h.row_id = any(v_ids) or h.id > v_mark_cfg);
        end if;
      end if;
      exit when v_n < v_batch;
    end loop;
    v_status := 'done';
    perform app._compliance_log_purge(p_org, p_product, 'retention', null, r.rule_id, r.data_type, r.schema_name, r.table_name, r.action, v_status, v_before, v_total, v_cut, false,
                                      jsonb_build_object('batches', v_b, 'truncated', v_total < v_before));
    v_rows := v_rows + v_total;
    v_results := v_results || jsonb_build_object('data_type', r.data_type, 'status', v_status, 'affected', v_total, 'cutoff', v_cut);
  end loop;

  insert into audit.log (org_id, actor_user_id, action, schema_name, table_name, detail)
  values (p_org, auth.uid(), case when p_dry_run then 'compliance.purge_dry_run' else 'compliance.retention_purge' end, 'audit', 'purge_log',
          jsonb_build_object('product', p_product, 'rows', v_rows, 'rules', jsonb_array_length(v_results)));
  return jsonb_build_object('org_id', p_org, 'product', p_product, 'dry_run', p_dry_run, 'skipped', false, 'rules', v_results, 'rows', v_rows);
end $$;

-- Cron entry point: one retention job per (org, product) that has the product and at least one enabled rule.
create or replace function app.compliance_enqueue_purge_jobs(p_product text default null) returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_n integer;
begin
  with due as (
    select o.id as org_id, p.key as product_key
      from core.organizations o cross join core.products p
     where (p_product is null or p.key = p_product)
       and app.org_has_product(o.id, p.key)
       and exists (select 1 from app._compliance_effective_rules(o.id) e
                    where e.enabled and (e.product_key = p.key or (e.product_key is null and p.key = app._compliance_first_product(o.id))))
       and not exists (select 1 from private.jobs j where j.org_id = o.id and j.product_key = p.key
                          and j.kind = 'compliance.retention_purge' and j.status in ('queued','running'))
  ), ins as (
    insert into private.jobs (org_id, product_key, kind, payload)
    select d.org_id, d.product_key, 'compliance.retention_purge', '{}'::jsonb from due d returning 1)
  select count(*) into v_n from ins;
  return v_n;
end $$;

-- ================================================================ (5) consent helpers (callable by the product roles)
create or replace function app._compliance_consent_allowed(p_org uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'consent: sign-in required' using errcode = '42501'; end if;
  if not (app.is_platform_admin() or (p_org = app.current_org_id() and app.user_has_any_product(p_org))) then
    raise exception 'consent: not allowed' using errcode = '42501';
  end if;
end $$;

-- Appends ledger rows. p_purpose 'both' writes a service and a promotional row (a STOP is p_status opted_out + both).
create or replace function app.compliance_record_consent(p_org uuid, p_channel text, p_contact text, p_purpose text, p_status text,
  p_source text, p_person_type text default null, p_person_id uuid default null, p_proof jsonb default '{}'::jsonb,
  p_guardian_id uuid default null, p_guardian_relation text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_contact text := app.compliance_normalise_contact(p_channel, p_contact);
  v_purposes text[];
  x text;
  v_ids uuid[] := '{}';
  v_id uuid;
begin
  perform app._compliance_consent_allowed(p_org);
  if v_contact is null then raise exception 'consent: empty contact' using errcode = '22023'; end if;
  if p_purpose not in ('service','promotional','both') then raise exception 'consent: unknown purpose %', p_purpose using errcode = '22023'; end if;
  v_purposes := case when p_purpose = 'both' then array['service','promotional'] else array[p_purpose] end;
  foreach x in array v_purposes loop
    insert into core.consent_events (org_id, person_type, person_id, guardian_id, guardian_relation, channel, contact, purpose, status, source, proof, recorded_by)
    values (p_org, p_person_type, p_person_id, p_guardian_id, p_guardian_relation, p_channel, v_contact, x, p_status, p_source,
            coalesce(p_proof, '{}'::jsonb), auth.uid())
    returning id into v_id;
    v_ids := array_append(v_ids, v_id);
  end loop;
  return jsonb_build_object('ids', to_jsonb(v_ids), 'contact', v_contact);
end $$;

-- 'opted_in' | 'opted_out' | 'unknown' for one contact, channel and purpose (latest ledger row wins).
create or replace function app.compliance_consent_status(p_org uuid, p_channel text, p_contact text, p_purpose text) returns text
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app._compliance_consent_allowed(p_org);
  return coalesce((select c.status from core.consent_events c
                    where c.org_id = p_org and c.channel = p_channel and c.purpose = p_purpose
                      and c.contact = app.compliance_normalise_contact(p_channel, p_contact)
                    order by c.recorded_at desc, c.id desc limit 1), 'unknown');
end $$;

-- The send gate (messaging-consent.md 2.3): promotional needs opted_in; anything is blocked after opted_out;
-- service messages to an unknown contact are allowed (lawful basis is the school's; CONFIRM with counsel).
create or replace function app.compliance_may_send(p_org uuid, p_channel text, p_contact text, p_purpose text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_s text;
  v_p text;
begin
  perform app._compliance_consent_allowed(p_org);
  if p_purpose not in ('service','promotional') then raise exception 'consent: unknown purpose %', p_purpose using errcode = '22023'; end if;
  v_s := app.compliance_consent_status(p_org, p_channel, p_contact, 'service');
  v_p := app.compliance_consent_status(p_org, p_channel, p_contact, 'promotional');
  if p_purpose = 'promotional' then return v_p = 'opted_in'; end if;
  return v_s <> 'opted_out';
end $$;

-- ================================================================ the client's view of what AutoEd keeps
-- Effective registry, table policy and retention periods for one org (platform defaults with the org's overrides applied).
-- This is what a school's compliance admin reads; the underlying default rows are visible to platform admins only.
create or replace function app.compliance_data_map(p_org uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform app.compliance_authorize(p_org, 'view');
  return jsonb_build_object(
    'org_id', p_org,
    'personal_data', coalesce((
      select jsonb_agg(jsonb_build_object('schema', x.schema_name, 'table', x.table_name, 'person_type', x.person_type, 'key_column', x.key_column,
                                          'pii_columns', x.pii_columns, 'on_erasure', x.erasure_mode, 'retain_reason', x.retain_reason, 'exported', x.export)
                       order by x.schema_name, x.table_name, x.person_type)
        from (select distinct on (r.schema_name, r.table_name, r.person_type, r.key_column) r.*
                from core.pii_registry r
               where r.classification = 'personal' and (r.org_id is null or r.org_id = p_org)
                 and (r.schema_name not in ('crm','os','erp') or exists (select 1 from core.subscriptions s where s.org_id = p_org and s.product_key = r.schema_name))
               order by r.schema_name, r.table_name, r.person_type, r.key_column, r.org_id nulls last) x), '[]'::jsonb),
    'kept_when_org_deleted', coalesce((
      select jsonb_agg(jsonb_build_object('schema', t.schema_name, 'table', t.table_name, 'reason', t.retain_reason) order by t.schema_name, t.table_name)
        from app._compliance_org_tables(p_org, true) t where t.disposition = 'retain'), '[]'::jsonb),
    'retention', coalesce((
      select jsonb_agg(jsonb_build_object('data_type', e.data_type, 'schema', e.schema_name, 'table', e.table_name, 'action', e.action,
                                          'period_value', e.period_value, 'period_unit', e.period_unit, 'enabled', e.enabled, 'legal_status', e.legal_status,
                                          'org_override', e.org_override) order by e.data_type)
        from app._compliance_effective_rules(p_org) e), '[]'::jsonb),
    'lifecycle_days', jsonb_build_object(
      'product_read_only_days', app._compliance_lifecycle_days(p_org, 'product_read_only_days', 30),
      'org_exit_deletion_days', app._compliance_lifecycle_days(p_org, 'org_exit_deletion_days', 30)));
end $$;

-- ================================================================ seed: registry (platform defaults)
-- Person ids. A staff person is core.staff.id, a guardian core.guardians.id, a student core.students.id, a lead the CRM
-- contact id; a login (auth user id) is also accepted: the subject rows (is_subject, link_columns) resolve every id of the
-- person, so tables keyed by user_id, staff_id, guardian_id or student_id are all found.
create function pg_temp.reg(p_table text, p_key text, p_types text[], p_mode text, p_pii text[], p_ord integer, p_note text,
  p_av jsonb default '{}', p_reason text default null, p_contact text[] default '{}', p_audit text[] default '{}',
  p_subject boolean default false, p_link text[] default '{}', p_fcol text default null, p_fvals text[] default null) returns void
language plpgsql as $$
declare
  pt text;
begin
  foreach pt in array p_types loop
    insert into core.pii_registry (schema_name, table_name, person_type, key_column, filter_column, filter_values, contact_columns, is_subject, link_columns,
                                   pii_columns, audit_columns, anonymise_values, erasure_mode, retain_reason, erase_order, note)
    values ('core', p_table, pt, p_key, p_fcol, case when p_fcol = 'person_type' then array[pt] else p_fvals end, p_contact, p_subject, p_link, p_pii, p_audit, p_av, p_mode, p_reason, p_ord, p_note);
  end loop;
end $$;

do $$
declare
  logins constant text[] := array['staff','guardian','student'];
  r_keep constant text := 'Kept on purpose: ';
begin
  -- ------------------------------------------------------------ the people (subject rows)
  perform pg_temp.reg('staff', 'id', array['staff'], 'anonymise',
    array['first_name','last_name','email','phone','dob','photo_file_id','employee_code','user_id','custom','ui_prefs'], 850, 'Staff profile: kept as a pseudonymous row (timetable, attendance and approvals point at it), the person is removed.',
    '{"first_name":"Erased person","custom":"{}","ui_prefs":"{}"}', null, array['email','phone'], array['full_name'], true, array['user_id']);
  perform pg_temp.reg('guardians', 'id', array['guardian'], 'anonymise',
    array['name','phone','alt_phone','email','occupation','qualification','photo_file_id','user_id'], 850, 'Guardian profile: kept as a pseudonymous row, the person is removed.',
    '{"name":"Erased person"}', null, array['phone','alt_phone','email'], '{}', true, array['user_id','household_id']);
  perform pg_temp.reg('students', 'id', array['student'], 'anonymise',
    array['first_name','last_name','dob','apaar_id','pen','photo_file_id','previous_school','user_id','crm_prospect_id','house','mother_tongue','nationality','custom'], 850,
    'Student profile: the admission number and academic placement stay as a pseudonymous school record (transfer certificates, board rules: counsel to confirm), the person is removed.',
    '{"first_name":"Erased person","custom":"{}"}', null, '{}', array['full_name'], true, array['user_id','household_id']);
  perform pg_temp.reg('households', 'id', array['guardian','student'], 'retain',
    array['address','phone','email','family_name'], 800, 'Shared family record.', '{}',
    'The household is shared with the other guardians and children of the family; it is removed when its last member is erased (manual step) and is included in every member''s export.', array['phone','email']);
  perform pg_temp.reg('student_sensitive', 'student_id', array['student'], 'delete',
    array['student_id','blood_group','allergies','medical_conditions','medications','disability','special_needs','social_category','religion','caste','emergency_notes'], 100,
    'Health and category data: deleted.');

  -- ------------------------------------------------------------ logins (user_id keyed)
  perform pg_temp.reg('org_users', 'user_id', array['staff'], 'delete', array['display_name'], 900, 'Login link; cascades to access rows. The Auth user is deleted by the server.', '{}', null, '{}', '{}', true, '{}', 'kind', array['staff']);
  perform pg_temp.reg('org_users', 'user_id', array['guardian'], 'delete', array['display_name'], 900, 'Login link; cascades to access rows. The Auth user is deleted by the server.', '{}', null, '{}', '{}', true, '{}', 'kind', array['guardian','parent']);
  perform pg_temp.reg('org_users', 'user_id', array['student'], 'delete', array['display_name'], 900, 'Login link; cascades to access rows. The Auth user is deleted by the server.', '{}', null, '{}', '{}', true, '{}', 'kind', array['student']);
  perform pg_temp.reg('user_branch_access', 'user_id', logins, 'delete', array['user_id'], 100, 'Branch access of the user.');
  perform pg_temp.reg('user_product_access', 'user_id', logins, 'delete', array['user_id'], 100, 'Product access of the user.');
  perform pg_temp.reg('user_product_access', 'granted_by', array['staff'], 'anonymise', array['granted_by'], 100, 'Grants this staff member made: the granter is removed, the grant stays.');
  perform pg_temp.reg('user_security', 'user_id', logins, 'delete', array['user_id'], 100, 'Password and lockout bookkeeping.');
  perform pg_temp.reg('login_events', 'user_id', logins, 'anonymise', array['user_id','ip','user_agent'], 100, 'Security log: events stay for counts; the person, IP and device are removed.');
  perform pg_temp.reg('learner_links', 'user_id', array['guardian'], 'delete', array['user_id','learner_id'], 100, 'Guardian to learner link.');
  perform pg_temp.reg('learner_links', 'learner_id', array['student'], 'delete', array['user_id','learner_id'], 100, 'Learner side of the link.');

  -- ------------------------------------------------------------ notifications and messages
  perform pg_temp.reg('notifications', 'user_id', logins, 'delete', array['user_id','staff_id','title','body','data','link'], 100, 'In-app notifications of the user.');
  perform pg_temp.reg('notifications', 'staff_id', array['staff'], 'delete', array['user_id','staff_id','title','body','data','link'], 100, 'In-app notifications of the staff member.');
  perform pg_temp.reg('notification_prefs', 'user_id', logins, 'delete', array['user_id'], 100, 'Notification preferences.');
  perform pg_temp.reg('device_tokens', 'user_id', logins, 'delete', array['user_id','staff_id','token','device_name'], 100, 'Push tokens.');
  perform pg_temp.reg('device_tokens', 'staff_id', array['staff'], 'delete', array['user_id','staff_id','token','device_name'], 100, 'Push tokens.');
  perform pg_temp.reg('outbox', 'guardian_id', array['guardian'], 'anonymise', array['to_address','body','error','provider_ref','guardian_id'], 100, 'Sent messages: the address and text are removed, delivery metadata stays (retention schedule 2.1).',
    '{"to_address":"erased"}', null, array['to_address']);
  perform pg_temp.reg('outbox', 'student_id', array['student'], 'anonymise', array['to_address','body','error','provider_ref','student_id'], 100, 'Sent messages about the student.', '{"to_address":"erased"}');
  -- messages to a phone or email are also found by the person's own contact values (staff, guardian, lead)
  perform pg_temp.reg('outbox', null, array['staff','guardian','lead'], 'anonymise', array['to_address','body','error','provider_ref'], 100, 'Sent messages to the person''s phone or email.', '{"to_address":"erased"}', null, array['to_address']);

  -- ------------------------------------------------------------ helpdesk and approvals (free text may name the person)
  perform pg_temp.reg('support_tickets', 'user_id', logins, 'anonymise', array['user_id','staff_id','body','reply'], 100, 'Support tickets: text removed, ticket stays.', '{"subject":"Erased request"}');
  perform pg_temp.reg('support_tickets', 'staff_id', array['staff'], 'anonymise', array['user_id','staff_id','body','reply'], 100, 'Support tickets: text removed, ticket stays.', '{"subject":"Erased request"}');
  perform pg_temp.reg('tickets', 'raised_by_user_id', logins, 'anonymise', array['raised_by_user_id','raised_by_staff_id','raised_by_name','description','photo_file_id','voice_file_id','payload'], 100, 'Helpdesk tickets raised by the person: personal text and media removed, ticket stays.', '{"title":"Erased request","payload":"{}"}');
  perform pg_temp.reg('tickets', 'raised_by_staff_id', array['staff'], 'anonymise', array['raised_by_user_id','raised_by_staff_id','raised_by_name','description','photo_file_id','voice_file_id','payload'], 100, 'Helpdesk tickets raised by the staff member.', '{"title":"Erased request","payload":"{}"}');
  perform pg_temp.reg('tickets', 'owner_staff_id', array['staff'], 'anonymise', array['owner_staff_id'], 100, 'Tickets the staff member handled: the handler is removed.');
  perform pg_temp.reg('tickets', 'student_id', array['student'], 'anonymise', array['student_id','description','photo_file_id','voice_file_id','payload'], 100, 'Tickets about the student: personal text and media removed.', '{"title":"Erased request","payload":"{}"}');
  perform pg_temp.reg('ticket_events', 'actor_user_id', logins, 'anonymise', array['actor_user_id','actor_staff_id','actor_name','note'], 100, 'Ticket history entries by the person.');
  perform pg_temp.reg('ticket_events', 'actor_staff_id', array['staff'], 'anonymise', array['actor_user_id','actor_staff_id','actor_name','note'], 100, 'Ticket history entries by the staff member.');
  perform pg_temp.reg('approval_requests', 'applicant_user_id', logins, 'anonymise', array['applicant_user_id','applicant_staff_id','requested_by_name','summary','impact','data'], 100, 'Approval requests: applicant and text removed, decision trail stays.', '{"title":"Erased request","data":"{}"}');
  perform pg_temp.reg('approval_requests', 'applicant_staff_id', array['staff'], 'anonymise', array['applicant_user_id','applicant_staff_id','requested_by_name','summary','impact','data'], 100, 'Approval requests of the staff member.', '{"title":"Erased request","data":"{}"}');
  perform pg_temp.reg('approval_requests', 'student_id', array['student'], 'anonymise', array['student_id','requested_by_name','summary','impact','data'], 100, 'Approval requests about the student.', '{"title":"Erased request","data":"{}"}');
  perform pg_temp.reg('approval_actions', 'actor_user_id', logins, 'anonymise', array['actor_user_id','actor_staff_id','actor_name','comment'], 100, 'Approval actions by the person: name and comment removed, the action stays.');
  perform pg_temp.reg('approval_actions', 'actor_staff_id', array['staff'], 'anonymise', array['actor_user_id','actor_staff_id','actor_name','comment'], 100, 'Approval actions by the staff member.');
  perform pg_temp.reg('approval_steps', 'approver_staff_id', array['staff'], 'anonymise', array['approver_staff_id'], 100, 'A flow step that named this approver: the name is removed.');
  perform pg_temp.reg('delegations', 'staff_id', array['staff'], 'delete', array['staff_id','delegate_id','reason'], 100, 'Delegations from the staff member.');
  perform pg_temp.reg('delegations', 'delegate_id', array['staff'], 'delete', array['staff_id','delegate_id','reason'], 100, 'Delegations to the staff member.');

  -- ------------------------------------------------------------ attendance, leave, timetable, content
  perform pg_temp.reg('staff_attendance', 'staff_id', array['staff'], 'anonymise', array['check_in_lat','check_in_lng','check_in_distance_m','selfie_file_id','note'], 100, 'Staff attendance: location, selfie and notes removed; the attendance fact stays on the pseudonymous staff row.');
  perform pg_temp.reg('leave_requests', 'staff_id', array['staff'], 'anonymise', array['reason','handover_note','attachment_file_id'], 100, 'Leave requests: reasons and attachments (often medical) removed; dates and days stay.');
  perform pg_temp.reg('leave_balances', 'staff_id', array['staff'], 'retain', array['staff_id'], 100, 'Leave balances.', '{}', r_keep || 'numbers only, attached to the pseudonymous staff row.');
  perform pg_temp.reg('student_leave_requests', 'student_id', array['student'], 'anonymise', array['reason','attachment_file_id','requested_by_user_id'], 100, 'Student leave: reasons and attachments removed.');
  perform pg_temp.reg('student_leave_requests', 'requested_by_user_id', array['guardian','student'], 'anonymise', array['reason','attachment_file_id','requested_by_user_id'], 100, 'Leave applied for by this login: reasons and attachments removed.');
  perform pg_temp.reg('student_attendance_marks', 'student_id', array['student'], 'anonymise', array['note'], 100, 'Attendance marks: notes removed; the mark stays on the pseudonymous student row.');
  perform pg_temp.reg('student_attendance_sessions', 'marked_by_staff_id', array['staff'], 'anonymise', array['marked_by_staff_id','marked_by_name'], 100, 'Attendance sessions this staff member marked: the marker is removed.');
  perform pg_temp.reg('student_status_events', 'student_id', array['student'], 'anonymise', array['reason','actor_name'], 100, 'Status history: reasons removed.');
  perform pg_temp.reg('student_status_events', 'actor_user_id', array['staff'], 'anonymise', array['actor_user_id','actor_name'], 100, 'Status changes this staff member made: the actor is removed.');
  perform pg_temp.reg('enrolments', 'student_id', array['student'], 'retain', array['student_id'], 100, 'Year-wise placement.', '{}', r_keep || 'academic placement history of the pseudonymous student record (board and transfer-certificate rules, counsel to confirm).');
  perform pg_temp.reg('exam_seating', 'student_id', array['student'], 'retain', array['student_id'], 100, 'Exam seating.', '{}', r_keep || 'exam administration records of the pseudonymous student record.');
  perform pg_temp.reg('class_posts', 'student_id', array['student'], 'anonymise', array['student_id','body','attachment_file_id'], 100, 'Posts addressed to the student: text removed.', '{"title":"Erased post"}');
  perform pg_temp.reg('class_posts', 'staff_id', array['staff'], 'retain', array['staff_id'], 100, 'Posts authored by the staff member.', '{}', r_keep || 'school content authored in the course of employment; the author row is pseudonymous.');
  perform pg_temp.reg('teacher_allocations', 'staff_id', array['staff'], 'retain', array['staff_id'], 100, 'Teaching allocations.', '{}', r_keep || 'timetable history; the staff row is pseudonymous.');
  perform pg_temp.reg('timetable_entries', 'staff_id', array['staff'], 'retain', array['staff_id'], 100, 'Timetable.', '{}', r_keep || 'timetable history; the staff row is pseudonymous.');
  perform pg_temp.reg('departments', 'head_staff_id', array['staff'], 'anonymise', array['head_staff_id'], 100, 'Departments this staff member headed: the head is removed.');
  perform pg_temp.reg('events', 'owner_staff_id', array['staff'], 'anonymise', array['owner_staff_id'], 100, 'Events this staff member owned: the owner is removed.');
  perform pg_temp.reg('incidents', 'student_ids', array['student'], 'retain', array['student_ids','staff_ids','description','action_taken','follow_up'], 100, 'Incident records.', '{}',
    'Safeguarding and legal records about incidents are kept until counsel has decided the period (retention schedule 2.1 and open point 1); access exports include them.');
  perform pg_temp.reg('incidents', 'staff_ids', array['staff'], 'retain', array['student_ids','staff_ids','description','action_taken','follow_up'], 100, 'Incident records.', '{}',
    'Safeguarding and legal records about incidents are kept until counsel has decided the period (retention schedule 2.1 and open point 1); access exports include them.');
  perform pg_temp.reg('incidents', 'owner_staff_id', array['staff'], 'retain', array['owner_staff_id','reported_by_user_id','reported_by_staff_id'], 100, 'Incident records owned or reported by the staff member.', '{}',
    'Incident records are kept until counsel has decided the period (retention schedule 2.1); the staff row is pseudonymous.');
  perform pg_temp.reg('files', 'owner_id', logins, 'retain', array['owner_id','file_name','storage_path'], 100, 'File records owned by the person.', '{}',
    'File rows are removed with the record they belong to; the stored objects are deleted through the Storage API (external action) in the same request.');

  -- ------------------------------------------------------------ the client's consent and request registers, AutoEd's compliance records
  perform pg_temp.reg('consents', 'staff_id', array['staff'], 'retain', array['staff_id','user_id'], 100, 'Consent records per purpose.', '{}',
    'Consent and opt-out records are proof of lawful processing and are kept for the relationship plus 3 years (retention schedule 2.1, CONFIRM with counsel).');
  perform pg_temp.reg('consents', 'guardian_id', array['guardian'], 'retain', array['guardian_id','user_id'], 100, 'Consent records per purpose.', '{}',
    'Consent and opt-out records are proof of lawful processing and are kept for the relationship plus 3 years (retention schedule 2.1, CONFIRM with counsel).');
  perform pg_temp.reg('consents', 'student_id', array['student'], 'retain', array['student_id','user_id'], 100, 'Consent records per purpose.', '{}',
    'Consent and opt-out records are proof of lawful processing and are kept for the relationship plus 3 years (retention schedule 2.1, CONFIRM with counsel).');
  perform pg_temp.reg('consents', 'crm_contact_id', array['lead'], 'retain', array['crm_contact_id','user_id'], 100, 'Consent records of a pre-admission lead.', '{}',
    'Consent and opt-out records are proof of lawful processing and are kept for the relationship plus 3 years (retention schedule 2.1, CONFIRM with counsel).');
  perform pg_temp.reg('data_requests', 'requested_by_user_id', logins, 'retain', array['requested_by_user_id','subject','details'], 100, 'The person''s own data-subject requests.', '{}',
    'The client''s request register is proof that a right was exercised (data-subject-rights-procedure 7); it holds the request, not the exported data.');
  perform pg_temp.reg('data_requests', 'subject_id', array['staff','guardian','student','lead'], 'retain', array['subject_id','subject','details'], 100, 'Requests made about the person.', '{}',
    'The client''s request register is proof that a right was exercised (data-subject-rights-procedure 7); it holds the request, not the exported data.');
  perform pg_temp.reg('consent_events', 'person_id', array['staff','guardian','student','lead'], 'retain', array['contact','person_id','guardian_id'], 800, 'Consent ledger of contacts and channels; also matched by phone/email.', '{}',
    'Consent and opt-out records are proof of lawful processing and are kept for the relationship plus 3 years (retention schedule 2.1, CONFIRM with counsel).', array['contact'], '{}', false, '{}', 'person_type', null);
  perform pg_temp.reg('compliance_requests', 'subject_person_id', array['staff','guardian','student','lead'], 'retain', array['subject_person_id'], 800, 'Register of the person''s own requests.', '{}',
    'Request register and tombstone: proof that a right was exercised; holds an opaque id only (retention schedule 2.1).');
  perform pg_temp.reg('legal_holds', 'person_id', array['staff','guardian','student','lead'], 'retain', array['person_id'], 800, 'Legal holds on the person.', '{}',
    'A legal hold must survive until released; it is lifted by the court or counsel, not by an erasure request.');
end $$;

-- Reviewed exemptions: tables that look personal by column name but are not client personal data.
insert into core.pii_registry (schema_name, table_name, classification, exempt_reason) values
  ('core', 'pii_registry', 'exempt', 'The registry itself: it names columns (contact_columns, pii_columns) and holds no personal data.'),
  ('core', 'branches', 'exempt', 'Branch address, phone and email are the organisation''s own business contact, not a person''s data; deleted and exported with the organisation.'),
  ('core', 'platform_admins', 'exempt', 'AutoEd platform staff accounts: AutoEd is the fiduciary, outside any client organisation; handled under AutoEd''s own procedure.'),
  ('core', 'support_sessions', 'exempt', 'Access log of AutoEd platform staff (platform_user_id); evidence that is shown to the client and kept with the audit log.'),
  ('billing', 'accounts', 'exempt', 'Organisation billing profile (legal name, GSTIN, billing email): AutoEd''s own invoicing record, retained about 8 years (retention schedule 2.3).'),
  ('crm', 'harness_probe', 'exempt', 'Isolation-harness placeholder table (owner_id only); holds no personal data and is dropped when real tables arrive.'),
  ('os', 'harness_probe', 'exempt', 'Isolation-harness placeholder table (owner_id only); holds no personal data and is dropped when real tables arrive.'),
  ('erp', 'harness_probe', 'exempt', 'Isolation-harness placeholder table (owner_id only); holds no personal data and is dropped when real tables arrive.');

-- ================================================================ seed: table policy (what an org deletion keeps)
insert into core.table_policy (schema_name, table_name, org_deletion, retain_reason, org_export) values
  ('core', 'organizations', 'retain', 'The organisation row is the anchor of invoices, the contract record and the deletion certificate; it is closed, not removed.', true),
  ('core', 'subscriptions', 'retain', 'Contract and subscription history: needed to prove the grace period and for invoicing disputes (retention schedule 2.3).', true),
  ('core', 'support_sessions', 'retain', 'Access log of AutoEd staff: kept with the audit log for its retention period.', true),
  ('core', 'compliance_requests', 'retain', 'Request register and deletion certificate source; holds counts and opaque ids only.', true),
  ('core', 'legal_holds', 'retain', 'Holds are records of legal process and are released, not deleted.', true),
  ('core', 'org_export_jobs', 'retain', 'Proof that the exit export was made and what it contained (manifest and sha256).', false),
  ('billing', 'accounts', 'retain', 'AutoEd invoicing record, retained about 8 years (GST and Companies Act; retention schedule 2.3, CONFIRM).', true),
  ('billing', 'razorpay_subscriptions', 'retain', 'Payment-provider subscription record for invoices and disputes, about 8 years.', true),
  ('billing', 'invoices', 'retain', 'GST tax invoices: statutory retention about 8 years.', true),
  ('billing', 'invoice_lines', 'retain', 'GST tax invoice lines: statutory retention about 8 years.', true),
  ('billing', 'payments', 'retain', 'Payment records: statutory retention about 8 years.', true),
  ('billing', 'usage', 'retain', 'Metered usage backing invoices: kept with billing records.', true);

-- ================================================================ seed: retention rules and lifecycle periods (all CONFIRM)
insert into core.retention_policies (scope, data_type, description, period_value, period_unit, enabled, legal_status, legal_note) values
  ('lifecycle', 'product_read_only_days', 'Days a product stays read-only after the client stops paying, then export and delete (decision 42).', 30, 'days', false, 'confirmed', 'Fixed by the owner (decision 42).'),
  ('lifecycle', 'org_exit_deletion_days', 'Days between a client leaving (export delivered) and deletion of its data (decision 42).', 30, 'days', false, 'confirmed', 'Fixed by the owner (decision 42).'),
  ('lifecycle', 'trial_unconverted_days', 'Read-only days after a trial that did not convert, then deletion.', 30, 'days', false, 'draft', 'ASSUMPTION in the retention schedule 2.4.'),
  ('lifecycle', 'person_request_response_days', 'Working response period for a data-subject request.', 30, 'days', false, 'draft', 'CONFIRM against the DPDP Rules.'),
  ('lifecycle', 'export_link_days', 'Days an organisation export stays downloadable.', 7, 'days', false, 'draft', 'Operational default.'),
  ('lifecycle', 'confirmation_token_minutes', 'Lifetime of the second-step confirmation token for erasure and deletion.', 60, 'minutes', false, 'draft', 'Operational default.');

insert into core.retention_policies (scope, data_type, description, schema_name, table_name, date_column, action, period_value, period_unit, enabled, legal_status, legal_note) values
  ('table', 'audit_log', 'Audit log rows (who changed what).', 'audit', 'log', 'created_at', 'delete', 36, 'months', false, 'draft',
   'ASSUMPTION 3 years, at least 1 year in all cases; LAWYER TO CONFIRM (retention schedule 2.2).'),
  ('table', 'audit_config_history', 'Configuration and entitlement history.', 'audit', 'config_history', 'created_at', 'delete', 36, 'months', false, 'draft',
   'Same as the audit log; LAWYER TO CONFIRM.'),
  ('table', 'login_events', 'Login events (security data).', 'core', 'login_events', 'created_at', 'delete', 12, 'months', false, 'draft',
   'LAWYER TO CONFIRM (retention schedule 2.2); the Rules may require at least one year.'),
  ('table', 'support_sessions', 'Support "view as" session records.', 'core', 'support_sessions', 'started_at', 'delete', 36, 'months', false, 'draft',
   'Same as the audit log; LAWYER TO CONFIRM.');
-- Rules for CRM leads, students after leaving, messages, uploaded files etc. are added as rows when those tables exist
-- (docs/adr/compliance-tooling.md, "Adding a table").

-- ================================================================ function grants
-- Postgres lets PUBLIC execute every new function; take it away and grant explicitly (harness T7 checks this).
do $$
declare
  f record;
begin
  for f in select format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) as sig
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'app' and p.proname like '%compliance%' loop
    execute format('revoke execute on function %s from public', f.sig);
    execute format('revoke execute on function %s from anon, authenticated, crm_server, os_server, erp_server, platform_admin_server, job_runner', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;

-- the retention_policies write policy calls this as the invoker
grant execute on function app._compliance_default_rule_exists(text, text) to platform_admin_server;

-- org and person tools: platform_admin_server only (as the signed-in admin; the function authorises the actor)
grant execute on function
  app.compliance_authorize(uuid, text, boolean),
  app.compliance_table_counts(uuid, boolean),
  app.compliance_read_rows(uuid, text, text, text, integer),
  app.compliance_person_export(uuid, text, uuid, text[], uuid),
  app.compliance_person_erasure_plan(uuid, text, uuid, text[], text, boolean, uuid),
  app.compliance_person_erasure_execute(uuid, text),
  app.compliance_org_export_start(uuid, text[], text, text[]),
  app.compliance_org_export_finish(uuid, boolean, jsonb, text, text, bigint, text, text, bigint),
  app.compliance_org_deletion_plan(uuid, text, text),
  app.compliance_org_deletion_execute(uuid, text),
  app.compliance_deletion_status(uuid, text),
  app.compliance_data_map(uuid),
  app.compliance_subscription_states(),
  app.compliance_subscription_ended_at(uuid, text)
  to platform_admin_server;
-- retention purge: the job runner (and a platform admin for a manual dry run)
grant execute on function app.compliance_retention_purge(uuid, text, boolean, integer, integer) to job_runner, platform_admin_server;
grant execute on function app.compliance_enqueue_purge_jobs(text) to job_runner, platform_admin_server;
-- consent helpers: every product server and signed-in users of the org
grant execute on function
  app.compliance_normalise_contact(text, text),
  app.compliance_record_consent(uuid, text, text, text, text, text, text, uuid, jsonb, uuid, text),
  app.compliance_consent_status(uuid, text, text, text),
  app.compliance_may_send(uuid, text, text, text)
  to authenticated, crm_server, os_server, erp_server, platform_admin_server;
