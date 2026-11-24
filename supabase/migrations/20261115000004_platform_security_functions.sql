-- AutoEd platform foundation (4/6): app.* security functions, the RLS generator and audit triggers.
--
-- Rules for every function here:
--   * stable (or volatile for writers), never cached across requests: a subscription change is seen by the
--     next statement (plan 4.2, harness T4);
--   * security definer only where it must read tables the caller cannot, always with search_path = ''
--     and fully qualified names (harness T7 checks the search_path);
--   * no dynamic SQL built from request input (only apply_rls/enable_audit build DDL, and they are run by
--     migrations, not granted to any request role).
--
-- Name clash note: the legacy OS migrations (20261116000001..6, public schema) also define
-- app.my_org_id() and app.touch_updated_at(). When both streams are applied to one database the OS
-- versions replace these two bodies. Platform policies therefore call app.current_org_id(), never
-- app.my_org_id(), so they keep working until the OS stream is rewritten onto the platform.

-- ---------------------------------------------------------------- small helpers
create or replace function app.try_uuid(p text) returns uuid
language sql immutable set search_path = '' as $$
  select case when p ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p::uuid end
$$;

create or replace function app.has_column(p_schema text, p_table text, p_column text) returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from pg_catalog.pg_attribute a
                 where a.attrelid = (pg_catalog.quote_ident(p_schema) || '.' || pg_catalog.quote_ident(p_table))::pg_catalog.regclass
                   and a.attname = p_column and a.attnum > 0 and not a.attisdropped)
$$;

-- ---------------------------------------------------------------- identity
-- The signed-in user (sub claim). Security definer so that policies evaluated by the product server roles
-- do not need USAGE on Supabase's `auth` schema: those roles are granted core + their own schema only.
-- Policies call app.uid(), never auth.uid().
create or replace function app.uid() returns uuid
language sql stable security definer set search_path = '' as $$ select auth.uid() $$;

create or replace function app.is_platform_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null
     and exists (select 1 from core.platform_admins p where p.user_id = auth.uid() and p.active)
$$;

-- The open, unexpired support session of the signed-in platform admin (null otherwise).
create or replace function app.support_session_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select s.id from core.support_sessions s
  join core.platform_admins p on p.user_id = s.platform_user_id and p.active
  where s.platform_user_id = auth.uid() and s.ended_at is null and now() < s.expires_at
  order by s.started_at desc limit 1
$$;

create or replace function app.support_org_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select s.org_id from core.support_sessions s where s.id = app.support_session_id()
$$;

-- The single org of the signed-in user (decision 37), or the org of an open support session.
create or replace function app.current_org_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select u.org_id from core.org_users u
       join core.organizations o on o.id = u.org_id and o.status = 'active'
      where u.user_id = auth.uid() and u.status = 'active'),
    app.support_org_id())
$$;

-- Public name asked for by the plan. Policies use app.current_org_id() (see the clash note above).
create or replace function app.my_org_id() returns uuid
language sql stable set search_path = '' as $$ select app.current_org_id() $$;

-- 'staff' | 'guardian' | 'parent' | 'student' | 'support' | null
create or replace function app.my_member_kind() returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select u.kind from core.org_users u where u.user_id = auth.uid() and u.status = 'active'),
    case when app.support_session_id() is not null then 'support' end)
$$;

-- Branches the signed-in user may act in. Staff with no home branch and no extra rows work at org
-- level (all branches), as in the OS. A support session sees every branch of the org.
create or replace function app.user_branch_ids() returns uuid[]
language sql stable security definer set search_path = '' as $$
  with me as (select u.* from core.org_users u where u.user_id = auth.uid() and u.status = 'active')
  select case
    when not exists (select 1 from me) then
      (select coalesce(array_agg(b.id), '{}') from core.branches b where b.org_id = app.support_org_id())
    when (select home_branch_id from me) is null
         and not exists (select 1 from core.user_branch_access a where a.user_id = auth.uid()) then
      (select coalesce(array_agg(b.id), '{}') from core.branches b where b.org_id = (select org_id from me))
    else
      (select coalesce(array_agg(distinct x.id), '{}') from (
         select home_branch_id as id from me where home_branch_id is not null
         union select a.branch_id from core.user_branch_access a where a.user_id = auth.uid()) x)
  end
$$;

-- Learners a guardian / parent / student user is linked to (decision 30).
create or replace function app.my_learner_ids() returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(l.learner_id), '{}') from core.learner_links l
  where l.user_id = auth.uid() and l.org_id = app.current_org_id()
$$;

-- ---------------------------------------------------------------- entitlements (plan 4.2)
-- trial / active / past_due => on; suspended / cancelled => off; outside starts_on..ends_on => off.
create or replace function app.org_has_product(p_org uuid, p_product text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from core.subscriptions s
    join core.products p on p.key = s.product_key and p.active
    join core.organizations o on o.id = s.org_id and o.status = 'active'
    where s.org_id = p_org and s.product_key = p_product
      and s.status in ('trial','active','past_due')
      and s.starts_on <= current_date
      and (s.ends_on is null or s.ends_on >= current_date))
$$;

-- Per-branch switch (decision 34): a row with enabled = false turns the product off for that branch.
create or replace function app.branch_has_product(p_org uuid, p_branch uuid, p_product text) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.org_has_product(p_org, p_product)
     and (p_branch is null or not exists (
       select 1 from core.org_branch_products b
       where b.org_id = p_org and b.branch_id = p_branch and b.product_key = p_product and not b.enabled))
$$;

-- Tenant + product + user access in one check. A platform admin in an open support session for the org
-- counts as having every product the org has.
create or replace function app.user_has_product(p_org uuid, p_product text) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_org is not null
     and p_org = app.current_org_id()
     and app.org_has_product(p_org, p_product)
     and (exists (select 1 from core.user_product_access a
                  join core.org_users u on u.user_id = a.user_id and u.org_id = a.org_id and u.status = 'active'
                  where a.user_id = auth.uid() and a.org_id = p_org and a.product_key = p_product
                    and a.revoked_at is null)
          or app.support_org_id() is not distinct from p_org)
$$;

-- Core master data is readable with ANY product of the org (plan 4.3).
create or replace function app.user_has_any_product(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from core.products p where app.user_has_product(p_org, p.key))
$$;

-- ---------------------------------------------------------------- permissions (small port of the OS)
-- can(product, module, action, org, branch, owner): user has the product, the branch has the product,
-- and one of the user's roles for that product grants module.action at a wide enough scope:
--   org    => any row of the org
--   branch => rows of the user's branches (and org-level rows)
--   own    => rows whose owner_id is the user
-- module_key / action '*' are wildcards. Only staff users get role permissions; guardian/parent/student
-- users are served by portal policies built on app.my_learner_ids(). A support session may 'view' only,
-- unless it was opened with read_only = false.
create or replace function app.can(p_product text, p_module text, p_action text, p_org uuid,
  p_branch uuid default null, p_owner uuid default null) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_rank integer;
begin
  if auth.uid() is null or p_org is null then return false; end if;
  if not app.user_has_product(p_org, p_product) then return false; end if;
  if p_branch is not null and not app.branch_has_product(p_org, p_branch, p_product) then return false; end if;

  if not exists (select 1 from core.org_users u where u.user_id = auth.uid() and u.status = 'active') then
    -- only a support session reaches here (user_has_product passed)
    return p_action = 'view'
        or exists (select 1 from core.support_sessions s where s.id = app.support_session_id() and not s.read_only);
  end if;

  select max(case rp.scope when 'own' then 1 when 'branch' then 2 when 'org' then 3 end) into v_rank
  from core.org_users u
  join core.user_product_access a on a.user_id = u.user_id and a.org_id = u.org_id
       and a.product_key = p_product and a.revoked_at is null
  join core.roles r on r.org_id = a.org_id and r.product_key = a.product_key and r.key = a.role_key
  join core.role_permissions rp on rp.role_id = r.id
  where u.user_id = auth.uid() and u.org_id = p_org and u.kind = 'staff' and u.status = 'active'
    and rp.module_key in (p_module, '*') and rp.action in (p_action, '*');

  if v_rank is null then return false; end if;
  if v_rank = 3 then return true; end if;
  if p_branch is not null and not (p_branch = any(app.user_branch_ids())) then return false; end if;
  if v_rank = 2 then return true; end if;
  return p_owner is not null and p_owner = auth.uid();
end $$;

-- Same check through any product the user holds (core tables shared by all products).
create or replace function app.can_any_product(p_module text, p_action text, p_org uuid, p_branch uuid default null)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from core.products p where app.can(p.key, p_module, p_action, p_org, p_branch, null))
$$;

-- ---------------------------------------------------------------- audit triggers (plan rule 6)
create or replace function app.platform_audit_row() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end;
  v_row jsonb;
begin
  if tg_op = 'UPDATE' and (v_old - 'updated_at') = (v_new - 'updated_at') then
    return null;  -- no-op update
  end if;
  v_row := coalesce(v_new, v_old);
  insert into audit.log (org_id, branch_id, actor_user_id, support_session_id, action, schema_name, table_name, row_id, before, after)
  values (
    app.try_uuid(v_row->>'org_id'),
    case when tg_table_schema = 'core' and tg_table_name = 'branches' then app.try_uuid(v_row->>'id')
         else app.try_uuid(v_row->>'branch_id') end,
    auth.uid(),
    app.support_session_id(),
    lower(tg_op), tg_table_schema, tg_table_name,
    coalesce(app.try_uuid(v_row->>'id'), app.try_uuid(v_row->>'user_id')),
    v_old, v_new);
  return null;
end $$;

create or replace function app.platform_config_history_row() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_row jsonb := coalesce(to_jsonb(new), to_jsonb(old));
begin
  if app.try_uuid(v_row->>'org_id') is null then return null; end if;
  insert into audit.config_history (org_id, branch_id, schema_name, table_name, row_id, action, before, after, actor_user_id, support_session_id)
  values (app.try_uuid(v_row->>'org_id'), app.try_uuid(v_row->>'branch_id'), tg_table_schema, tg_table_name,
          app.try_uuid(v_row->>'id'), lower(tg_op),
          case when tg_op <> 'INSERT' then to_jsonb(old) end,
          case when tg_op <> 'DELETE' then to_jsonb(new) end,
          auth.uid(), app.support_session_id());
  return null;
end $$;

-- Attach the audit trigger (and optionally config history) to a table. Run by migrations only.
create or replace function app.enable_audit(p_schema text, p_table text, p_config boolean default false) returns void
language plpgsql set search_path = '' as $$
begin
  execute format('drop trigger if exists trg_platform_audit on %I.%I', p_schema, p_table);
  execute format('create trigger trg_platform_audit after insert or update or delete on %I.%I for each row execute function app.platform_audit_row()', p_schema, p_table);
  execute format('drop trigger if exists trg_platform_config on %I.%I', p_schema, p_table);
  if p_config then
    execute format('create trigger trg_platform_config after insert or update or delete on %I.%I for each row execute function app.platform_config_history_row()', p_schema, p_table);
  end if;
end $$;

-- ---------------------------------------------------------------- policy generator (plan 4.3, 5.2)
create or replace function app.drop_policies(p_schema text, p_table text) returns void
language plpgsql set search_path = '' as $$
declare pol record;
begin
  for pol in select policyname from pg_catalog.pg_policies where schemaname = p_schema and tablename = p_table loop
    execute format('drop policy %I on %I.%I', pol.policyname, p_schema, p_table);
  end loop;
end $$;

-- app.apply_rls(schema, table, kind, product, module)
--
-- kind 'product'        product data. read/write = user_has_product(org, product) AND can(product, module, action,
--                       org, branch_id?, owner_id?). branch_id / owner_id are used when the table has them.
-- kind 'product_config' product settings. read = user_has_product + branch has the product + branch visible;
--                       write = can(product, module, 'configure').
-- kind 'core_master'    shared master data in core. read = member of the org with ANY product (+ branch visible);
--                       write = can(product, module, action) of the owning product, or of any product when
--                       product is '*'.
-- kind 'global'         reviewed global reference table without org_id. read = everyone signed in; write =
--                       platform admin.
--
-- Also enables RLS and attaches the audit trigger (config history for 'product_config'). Product tables must
-- live in their product's schema, and the module must exist in core.product_modules.
create or replace function app.apply_rls(p_schema text, p_table text, p_kind text, p_product text, p_module text)
returns void language plpgsql set search_path = '' as $$
declare
  tbl text := format('%I.%I', p_schema, p_table);
  b text := case when app.has_column(p_schema, p_table, 'branch_id') then 'branch_id' else 'null::uuid' end;
  o text := case when app.has_column(p_schema, p_table, 'owner_id') then 'owner_id' else 'null::uuid' end;
  p text := quote_literal(coalesce(p_product, ''));
  m text := quote_literal(coalesce(p_module, ''));
  bv text;
  r text;
  w text;
begin
  if p_kind <> 'global' and not app.has_column(p_schema, p_table, 'org_id') then
    raise exception 'apply_rls: %.% has no org_id (only reviewed global tables may omit it)', p_schema, p_table;
  end if;
  if p_kind in ('product','product_config') then
    if p_schema not in ('crm','os','erp') or p_product is distinct from p_schema then
      raise exception 'apply_rls: product table %.% must live in its product schema (got product %)', p_schema, p_table, p_product;
    end if;
    if not exists (select 1 from core.product_modules pm where pm.product_key = p_product and pm.module_key = p_module) then
      raise exception 'apply_rls: module %.% is not in core.product_modules', p_product, p_module;
    end if;
  elsif p_kind = 'core_master' then
    if p_schema <> 'core' then raise exception 'apply_rls: core_master tables live in core'; end if;
    if p_product is null or (p_product <> '*' and not exists (select 1 from core.products x where x.key = p_product)) then
      raise exception 'apply_rls: core_master needs an owning product key or *';
    end if;
  elsif p_kind <> 'global' then
    raise exception 'apply_rls: unknown kind %', p_kind;
  end if;

  perform app.drop_policies(p_schema, p_table);
  execute format('alter table %s enable row level security', tbl);
  bv := format('(%1$s is null or %1$s = any(app.user_branch_ids()))', b);

  if p_kind = 'product' then
    execute format('create policy sel on %s for select using (app.user_has_product(org_id, %s) and app.can(%s, %s, ''view'', org_id, %s, %s))', tbl, p, p, m, b, o);
    execute format('create policy ins on %s for insert with check (app.user_has_product(org_id, %s) and app.can(%s, %s, ''create'', org_id, %s, %s))', tbl, p, p, m, b, o);
    execute format('create policy upd on %s for update using (app.user_has_product(org_id, %2$s) and app.can(%2$s, %3$s, ''edit'', org_id, %4$s, %5$s)) with check (app.user_has_product(org_id, %2$s) and app.can(%2$s, %3$s, ''edit'', org_id, %4$s, %5$s))', tbl, p, m, b, o);
    execute format('create policy del on %s for delete using (app.user_has_product(org_id, %s) and app.can(%s, %s, ''delete'', org_id, %s, %s))', tbl, p, p, m, b, o);
  elsif p_kind = 'product_config' then
    execute format('create policy sel on %s for select using (app.user_has_product(org_id, %s) and app.branch_has_product(org_id, %s, %s) and %s)', tbl, p, b, p, bv);
    w := format('app.user_has_product(org_id, %s) and app.can(%s, %s, ''configure'', org_id, %s)', p, p, m, b);
    execute format('create policy ins on %s for insert with check (%s)', tbl, w);
    execute format('create policy upd on %s for update using (%s) with check (%s)', tbl, w, w);
    execute format('create policy del on %s for delete using (%s)', tbl, w);
  elsif p_kind = 'core_master' then
    execute format('create policy sel on %s for select using (org_id = app.current_org_id() and app.user_has_any_product(org_id) and %s)', tbl, bv);
    foreach r in array array['create','edit','delete'] loop
      w := case when p_product = '*' then format('app.can_any_product(%s, %L, org_id, %s)', m, r, b)
                else format('app.can(%s, %s, %L, org_id, %s, %s)', p, m, r, b, o) end;
      if r = 'create' then execute format('create policy ins on %s for insert with check (%s)', tbl, w);
      elsif r = 'edit' then execute format('create policy upd on %s for update using (%s) with check (%s)', tbl, w, w);
      else execute format('create policy del on %s for delete using (%s)', tbl, w);
      end if;
    end loop;
  else -- global
    execute format('create policy sel on %s for select using (true)', tbl);
    execute format('create policy ins on %s for insert with check (app.is_platform_admin())', tbl);
    execute format('create policy upd on %s for update using (app.is_platform_admin()) with check (app.is_platform_admin())', tbl);
    execute format('create policy del on %s for delete using (app.is_platform_admin())', tbl);
  end if;

  perform app.enable_audit(p_schema, p_table, p_kind = 'product_config');
end $$;
