-- AutoEd core master data (1/8): organisation/branch columns from MAP-TABLES B.1/B.2, portal helper functions
-- and app.apply_core_rls, the RLS wrapper used by every core master table (20261115100002..7).
-- See docs/core-master-data.md and docs/adr/core-master-001-audiences-and-writers.md.
--
-- Name-clash note: the legacy OS migrations (20261116*) define app.my_staff_id() over public.staff, so the
-- core version is called app.my_core_staff_id(). Nothing here reuses a legacy OS function name.

-- ---------------------------------------------------------------- B.1 core.organizations (extend, not recreate)
-- status stays active/closed (foundation functions depend on it); product status lives in core.subscriptions.
-- logo_file_id is added in 20261115100002 once core.files exists.
alter table core.organizations
  add column branding jsonb not null default '{}'::jsonb,   -- parent app (decision 46): {app_name, primary_color, secondary_color}
  add column settings jsonb not null default '{}'::jsonb,   -- shared settings only; product keys go to <product>.settings
  add column preset_key text,
  add column setup_step text,
  add column setup_completed_at timestamptz,
  add column go_live_date date,
  add column pan text,
  add column gst_no text,
  add column city text,
  add column state text,
  add column region text not null default 'ap-south-1',
  add column partner text,
  add column notes text;

-- ---------------------------------------------------------------- B.2 core.branches (extend)
alter table core.branches
  add column address text,
  add column phone text,
  add column email text,
  add column latitude numeric(9,6),
  add column longitude numeric(9,6),
  add column geofence_radius_m integer check (geofence_radius_m is null or geofence_radius_m > 0),
  add column working_days integer[] not null default '{1,2,3,4,5,6}',
  add column day_starts_at time,
  add column day_ends_at time,
  add column boards text[] not null default '{}',             -- free keys (OQ-15)
  add column gst_no text,
  add column pan text,
  add column udise_code text,
  add column is_franchise boolean not null default false,
  add column royalty_percent numeric(5,2) check (royalty_percent is null or royalty_percent between 0 and 100),
  add column settings jsonb not null default '{}'::jsonb;

-- ---------------------------------------------------------------- portal / self-service helpers
-- plpgsql so they can be created before the tables they read (bodies are checked at first call).

-- The core.staff row of the signed-in user (one login = one staff row, decision 37).
create or replace function app.my_core_staff_id() returns uuid
language plpgsql stable security definer set search_path = '' as $$
begin
  return (select s.id from core.staff s
           where s.user_id = auth.uid() and s.org_id = app.current_org_id() and s.deleted_at is null);
end $$;

-- Households of the learners linked to the signed-in guardian/parent/student, plus the guardian's own household.
create or replace function app.my_household_ids() returns uuid[]
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  v_ids uuid[];
begin
  select coalesce(array_agg(distinct x.h), '{}') into v_ids from (
    select s.household_id as h from core.students s
     where s.org_id = v_org and s.id = any(app.my_learner_ids()) and s.household_id is not null
    union
    select g.household_id from core.guardians g where g.org_id = v_org and g.user_id = auth.uid()) x;
  return v_ids;
end $$;

-- Sections of the linked learners (for class posts / timetables in the portal).
create or replace function app.my_learner_section_ids() returns uuid[]
language plpgsql stable security definer set search_path = '' as $$
begin
  return (select coalesce(array_agg(distinct s.section_id), '{}') from core.students s
           where s.org_id = app.current_org_id() and s.id = any(app.my_learner_ids()) and s.section_id is not null);
end $$;

-- ---------------------------------------------------------------- RLS for core master tables
-- app.apply_core_rls(table, read, product, module, extra, guard)
--
-- Writes (insert/update/delete) come unchanged from app.apply_rls(..., 'core_master', product, module):
--   product '*'  => app.can_any_product(module, action, org, branch)
--   product 'os' => app.can('os', module, action, org, branch)  (the map names a single writer)
-- Reads replace the core_master select policy with an audience rule:
--   members     every member of the org with any product (staff and portal users) - reference data
--   staff       staff members (and support sessions) with any product, branch visible
--   permission  staff holding <module>.view in any product (restricted: health, incidents, compliance...)
--   self        only rows where user_id = the signed-in user
-- `extra` is OR-ed (portal rows: own learners, own household, own requests); `guard` is AND-ed. Every read
-- is also bounded by org_id = app.current_org_id() and app.user_has_any_product(org_id).
create or replace function app.apply_core_rls(p_table text, p_read text, p_product text, p_module text,
  p_extra text default null, p_guard text default null) returns void
language plpgsql set search_path = '' as $$
declare
  tbl text := format('core.%I', p_table);
  b text := case when app.has_column('core', p_table, 'branch_id') then 'branch_id' else 'null::uuid' end;
  bv text;
  r text;
begin
  if p_module is null or p_module !~ '^[a-z][a-z0-9_]*$' then
    raise exception 'apply_core_rls: module key required for core.%', p_table;
  end if;
  perform app.apply_rls('core', p_table, 'core_master', p_product, p_module);
  bv := format('(%1$s is null or %1$s = any(app.user_branch_ids()))', b);
  r := case p_read
    when 'members' then bv
    when 'staff' then format('app.my_member_kind() in (''staff'',''support'') and %s', bv)
    when 'permission' then format('app.can_any_product(%L, ''view'', org_id, %s)', p_module, b)
    when 'self' then 'user_id = app.uid()'
  end;
  if r is null then raise exception 'apply_core_rls: unknown read audience %', p_read; end if;
  if p_extra is not null then r := format('(%s) or (%s)', r, p_extra); end if;
  if p_guard is not null then r := format('(%s) and (%s)', r, p_guard); end if;
  execute format('drop policy sel on %s', tbl);
  execute format('create policy sel on %s for select using (org_id = app.current_org_id() and app.user_has_any_product(org_id) and (%s))', tbl, r);
  execute format('comment on table %s is %L', tbl,
    format('core master data. read: %s%s; write: %s/%s', p_read, case when p_extra is not null then ' + portal/self rows' else '' end, p_product, p_module));
end $$;

-- ---------------------------------------------------------------- terminology defaults (decision 28)
-- Built-in labels by organisation kind; core.terminology rows override them per org (and branch).
create or replace function app.default_term(p_kind text, p_key text) returns text
language sql immutable set search_path = '' as $$
  select coalesce(
    (select v from (values
      ('coaching_centre','programme','Course'), ('coaching_centre','section','Batch'), ('coaching_centre','staff','Faculty'),
      ('coaching_centre','academic_year','Session'), ('coaching_centre','period','Slot'), ('coaching_centre','admission','Enrolment'),
      ('coaching_centre','wing','Division'),
      ('college','programme','Programme'), ('college','section','Division'), ('college','guardian','Guardian'), ('college','staff','Faculty'),
      ('college','term','Semester'), ('college','subject','Course'), ('college','period','Lecture'), ('college','wing','Faculty')
    ) d(k, key, v) where d.k = p_kind and d.key = p_key),
    (select v from (values
      ('programme','Class'), ('section','Section'), ('learner','Student'), ('guardian','Parent'), ('staff','Staff'),
      ('term','Term'), ('academic_year','Academic year'), ('subject','Subject'), ('wing','Wing'), ('period','Period'),
      ('admission','Admission'), ('household','Family'), ('room','Room')
    ) d(key, v) where d.key = p_key),
    initcap(replace(p_key, '_', ' ')))
$$;
