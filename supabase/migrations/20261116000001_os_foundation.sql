-- AutoEd OS on the shared platform (1/6): OS modules, helpers and the OS permission model.
--
-- The OS stream replaces the six legacy migrations (public schema). Everything MAP-TABLES A.1 sends to `core`
-- already exists (foundation + core master data); this stream creates only the `os` tables, the OS-only side
-- tables (os.event_plans, os.exam_plans, os.reporting_lines) and the AI wallet pieces the OS needs.
-- See docs/adr/os-move.md.
--
-- Permission model (OQ-6, decision 54): the OS keeps its own roles (os.roles / os.role_permissions /
-- os.staff_roles) with the scopes own < team < department < wing < branch < group. Each OS user also gets ONE
-- platform role (core.roles, product 'os') derived from the union of their OS roles, so the platform functions
-- (app.can, app.user_has_product, core master policies, storage) work for OS users:
--   own/team/department/wing -> own (never wider than the OS rule), branch -> branch, group -> org.
-- The staff-based scopes (own row = owner staff id, team = reporting tree, department, wing) are enforced by
-- the OS policies below through os.can(), the port of the legacy check_perm().
--
-- Each OS org also has one "system actor" (an auth user that is a member of the org with the os_system role,
-- every OS module at org scope). The OS server switches to it for checked side effects (notifications to other
-- users, system tasks) and for scheduled jobs: still bounded by tenant + product, never service_role.

-- ---------------------------------------------------------------- modules of the OS product
-- MODULE_KEYS are already seeded by the foundation; these are the permission-only areas of
-- packages/shared/src/modules.ts (PERMISSION_MODULES) plus platform modules the OS uses.
insert into core.product_modules (product_key, module_key, name) values
  ('os', 'setup', 'Setup'), ('os', 'staff', 'Staff'), ('os', 'students', 'Students'), ('os', 'appraisal', 'Appraisal'),
  ('os', 'question_papers', 'Question papers'), ('os', 'incidents_confidential', 'Confidential incidents'),
  ('os', 'ai', 'AI credits'), ('os', 'audit', 'Audit'), ('os', 'files', 'Files'), ('os', 'users', 'Users'),
  ('os', 'class_posts', 'Class posts'), ('os', 'notifications', 'Notifications'), ('os', 'support', 'Support')
on conflict (product_key, module_key) do nothing;

-- os_server reaches public only for extension types (vector) and functions.
grant usage on schema public to os_server;
create extension if not exists vector;

-- ---------------------------------------------------------------- DDL helper (migrations only)
-- Standard columns (R3) for an os table: created_at, created_by, updated_at (trigger), deleted_at,
-- plus indexes starting with org_id.
create or replace function os.std(p_table text) returns void
language plpgsql set search_path = '' as $$
begin
  execute format('alter table os.%I add column if not exists created_at timestamptz not null default now()', p_table);
  execute format('alter table os.%I add column if not exists created_by uuid default app.uid()', p_table);
  execute format('alter table os.%I add column if not exists updated_at timestamptz not null default now()', p_table);
  execute format('alter table os.%I add column if not exists deleted_at timestamptz', p_table);
  execute format('drop trigger if exists trg_touch on os.%I', p_table);
  execute format('create trigger trg_touch before update on os.%I for each row execute function app.touch_updated_at()', p_table);
  execute format('create index if not exists %I on os.%I(org_id)', p_table || '_org', p_table);
  if app.has_column('os', p_table, 'branch_id') then
    execute format('create index if not exists %I on os.%I(org_id, branch_id)', p_table || '_branch', p_table);
  end if;
end $$;

-- ---------------------------------------------------------------- OS roles (OQ-6: per product)
create table os.roles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid references core.branches(id) on delete cascade,
  key text not null check (key ~ '^[a-z][a-z0-9_]*$'),
  name text not null,
  description text,
  is_preset boolean not null default false,
  unique (org_id, key)
);
select os.std('roles');

create table os.role_permissions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid references core.branches(id) on delete cascade,
  role_id uuid not null references os.roles(id) on delete cascade,
  module text not null,
  action text not null check (action in ('view','create','edit','delete','assign','approve','verify','export','configure')),
  scope text not null check (scope in ('own','team','wing','department','branch','group')),
  unique (role_id, module, action)
);
select os.std('role_permissions');

create table os.staff_roles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid references core.branches(id) on delete cascade,
  staff_id uuid not null references core.staff(id) on delete cascade,
  role_id uuid not null references os.roles(id) on delete cascade,
  unique (staff_id, role_id)
);
select os.std('staff_roles');
create index staff_roles_staff on os.staff_roles(org_id, staff_id);

-- Secondary reporting lines (team scope follows reports_to + these). OS-only (core keeps staff.reports_to).
create table os.reporting_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid references core.branches(id) on delete cascade,
  staff_id uuid not null references core.staff(id) on delete cascade,
  manager_id uuid not null references core.staff(id) on delete cascade,
  kind text not null default 'secondary' check (kind in ('secondary')),
  unique (staff_id, manager_id),
  check (staff_id <> manager_id)
);
select os.std('reporting_lines');

create table os.module_flags (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  branch_id uuid not null references core.branches(id) on delete cascade,
  module_key text not null,
  enabled boolean not null default true,
  unique (branch_id, module_key)
);
select os.std('module_flags');

-- ---------------------------------------------------------------- identity helpers
-- The signed-in user's core.staff row (one login = one staff row, decision 37).
create or replace function os.my_staff() returns core.staff
language sql stable security definer set search_path = '' as $$
  select s.* from core.staff s
  where s.user_id = auth.uid() and s.org_id = app.current_org_id() and s.deleted_at is null
    and s.status in ('active','invited','on_notice')
  limit 1
$$;

create or replace function os.my_staff_id() returns uuid
language sql stable security definer set search_path = '' as $$ select (os.my_staff()).id $$;

-- The org's OS system actor (see header). Deterministic id per org.
create or replace function os.system_user_of(p_org uuid) returns uuid
language sql immutable set search_path = '' as $$
  select (substr(md5('autoed-os-system:' || p_org::text), 1, 8) || '-' || substr(md5('autoed-os-system:' || p_org::text), 9, 4) || '-4'
       || substr(md5('autoed-os-system:' || p_org::text), 14, 3) || '-a' || substr(md5('autoed-os-system:' || p_org::text), 18, 3) || '-'
       || substr(md5('autoed-os-system:' || p_org::text), 21, 12))::uuid
$$;

create or replace function os.is_system() returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and app.current_org_id() is not null
     and auth.uid() = os.system_user_of(app.current_org_id())
     and app.user_has_product(app.current_org_id(), 'os')
$$;

-- Branches a staff user acts in (home branch + extra branches; no home branch and no rows = all).
create or replace function os.branch_ids_of(p_uid uuid) returns uuid[]
language sql stable security definer set search_path = '' as $$
  with me as (select u.* from core.org_users u where u.user_id = p_uid and u.status = 'active')
  select case
    when not exists (select 1 from me) then '{}'::uuid[]
    when (select home_branch_id from me) is null
         and not exists (select 1 from core.user_branch_access a where a.user_id = p_uid) then
      (select coalesce(array_agg(b.id), '{}') from core.branches b where b.org_id = (select org_id from me))
    else
      (select coalesce(array_agg(distinct x.id), '{}') from (
         select home_branch_id as id from me where home_branch_id is not null
         union select a.branch_id from core.user_branch_access a where a.user_id = p_uid) x)
  end
$$;

-- Everyone below a staff member in the reporting tree (primary reports_to + secondary lines).
create or replace function os.subordinates_of(p_staff uuid) returns uuid[]
language sql stable security definer set search_path = '' as $$
  with recursive edges(staff_id, manager_id) as (
    select s.id, s.reports_to from core.staff s
     where s.reports_to is not null and s.deleted_at is null
       and s.org_id = (select o.org_id from core.staff o where o.id = p_staff)
    union
    select r.staff_id, r.manager_id from os.reporting_lines r
     where r.deleted_at is null and r.org_id = (select o.org_id from core.staff o where o.id = p_staff)
  ),
  tree(id) as (
    select e.staff_id from edges e where e.manager_id = p_staff
    union
    select e.staff_id from edges e join tree t on e.manager_id = t.id
  )
  select coalesce(array_agg(distinct id), '{}') from tree where id <> p_staff
$$;

create or replace function os.scope_rank(p_scope text) returns integer
language sql immutable set search_path = '' as $$
  select case p_scope when 'own' then 1 when 'team' then 2 when 'department' then 3
    when 'wing' then 4 when 'branch' then 5 when 'group' then 6 else 0 end
$$;

-- Highest scope a staff member holds for module.action across their OS roles (0 = none).
create or replace function os.staff_perm_rank(p_staff uuid, p_module text, p_action text) returns integer
language sql stable security definer set search_path = '' as $$
  select coalesce(max(os.scope_rank(rp.scope)), 0)
  from os.staff_roles sr
  join os.role_permissions rp on rp.role_id = sr.role_id and rp.deleted_at is null
  where sr.staff_id = p_staff and sr.deleted_at is null and rp.module = p_module and rp.action = p_action
$$;

create or replace function os.module_on(p_branch uuid, p_module text) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_branch is null or p_module is null or coalesce((select f.enabled from os.module_flags f
                   where f.branch_id = p_branch and f.module_key = p_module and f.deleted_at is null), true)
$$;

-- Port of the legacy check_perm() for any user (the API's has_permission and the policies).
-- Always requires the OS product for the target org.
create or replace function os.check_perm(p_uid uuid, p_module text, p_action text,
  p_org uuid, p_branch uuid, p_owner uuid, p_department uuid, p_wing uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  me core.staff;
  r integer;
begin
  if p_uid is null or p_org is null then return false; end if;
  if p_uid = os.system_user_of(p_org) then
    return app.org_has_product(p_org, 'os');
  end if;
  select s.* into me from core.staff s
   where s.user_id = p_uid and s.org_id = p_org and s.deleted_at is null and s.status in ('active','invited','on_notice');
  if me.id is null then return false; end if;
  if not app.org_has_product(p_org, 'os') then return false; end if;
  if p_branch is not null and not os.module_on(p_branch, p_module) then return false; end if;
  r := os.staff_perm_rank(me.id, p_module, p_action);
  if r = 0 then return false; end if;
  if r >= 6 then return true; end if;
  if p_branch is not null and not (p_branch = any(os.branch_ids_of(p_uid))) then return false; end if;
  if r = 5 then return true; end if;
  if p_owner is not null and p_owner = me.id then return true; end if;
  if r = 4 then
    return (p_wing is not null and p_wing = me.wing_id)
        or (p_owner is not null and exists (select 1 from core.staff o where o.id = p_owner and o.wing_id = me.wing_id and me.wing_id is not null));
  end if;
  if r = 3 then
    return (p_department is not null and p_department = me.department_id)
        or (p_owner is not null and exists (select 1 from core.staff o where o.id = p_owner and o.department_id = me.department_id and me.department_id is not null));
  end if;
  if r = 2 then
    return p_owner is not null and p_owner = any(os.subordinates_of(me.id));
  end if;
  return false;
end $$;

-- Policies: the signed-in user, with the product check of the current org.
create or replace function os.can(p_module text, p_action text, p_org uuid, p_branch uuid,
  p_owner uuid default null, p_department uuid default null, p_wing uuid default null) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_org = app.current_org_id() and app.user_has_product(p_org, 'os')
     and os.check_perm(auth.uid(), p_module, p_action, p_org, p_branch, p_owner, p_department, p_wing)
$$;

-- API: has_permission(user, module, action, target_row) with target keys org_id, branch_id, owner_id,
-- department_id, wing_id (section 9.1 of the PRD). Only for the signed-in user or the org's system actor.
create or replace function os.has_permission(p_user uuid, p_module text, p_action text, p_target jsonb) returns boolean
language sql stable security definer set search_path = '' as $$
  select (p_user = auth.uid() or os.is_system())
     and app.try_uuid(p_target->>'org_id') = app.current_org_id()
     and os.check_perm(p_user, p_module, p_action,
           app.try_uuid(p_target->>'org_id'), app.try_uuid(p_target->>'branch_id'), app.try_uuid(p_target->>'owner_id'),
           app.try_uuid(p_target->>'department_id'), app.try_uuid(p_target->>'wing_id'))
$$;

-- Member of the org, branch visible, any view permission on the module (legacy can_see).
create or replace function os.can_see(p_module text, p_org uuid, p_branch uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_org = app.current_org_id() and app.user_has_product(p_org, 'os')
     and (os.is_system() or (
           (p_branch is null or p_branch = any(os.branch_ids_of(auth.uid())))
       and os.module_on(p_branch, p_module)
       and os.staff_perm_rank(os.my_staff_id(), p_module, 'view') > 0))
$$;

-- Member of org/branch with any create/edit permission on the module (legacy can_write_child).
create or replace function os.can_write_child(p_module text, p_org uuid, p_branch uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_org = app.current_org_id() and app.user_has_product(p_org, 'os')
     and (os.is_system() or (
           (p_branch is null or p_branch = any(os.branch_ids_of(auth.uid())))
       and os.module_on(p_branch, p_module)
       and (os.staff_perm_rank(os.my_staff_id(), p_module, 'create') > 0 or os.staff_perm_rank(os.my_staff_id(), p_module, 'edit') > 0)))
$$;

-- Member of the org with the OS product and the branch visible (legacy config/member reads).
create or replace function os.member(p_org uuid, p_branch uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_org = app.current_org_id() and app.user_has_product(p_org, 'os')
     and (os.is_system() or p_branch is null or p_branch = any(os.branch_ids_of(auth.uid())))
$$;

-- 'module.action' -> highest rank for the signed-in user (loads the request context).
create or replace function os.my_permissions() returns table (module text, action text, r integer)
language sql stable security definer set search_path = '' as $$
  select rp.module, rp.action, max(os.scope_rank(rp.scope))::integer
  from os.staff_roles sr join os.role_permissions rp on rp.role_id = sr.role_id and rp.deleted_at is null
  where sr.staff_id = os.my_staff_id() and sr.deleted_at is null and app.user_has_product(app.current_org_id(), 'os')
  group by 1, 2
$$;
