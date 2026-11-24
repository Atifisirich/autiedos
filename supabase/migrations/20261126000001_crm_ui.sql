-- AutoEd CRM front end (phase 5): the few things the screens need that a product role cannot do with table access.
-- Every function is security definer with an empty search_path, re-checks org, product and permission itself, and is
-- granted to crm_server only (revoked from PUBLIC in the same file, as in 20261117000006).
--   crm.audit_events          the admin console's audit log (crm_server has no grant on schema audit by design)
--   crm.set_user_active       pause / reactivate a colleague and sign their devices out
--   crm.set_user_branches     extra branches of a colleague (core.user_branch_access)
--   crm.revoke_user_sessions  sign a colleague out everywhere
--   crm.dev_user_by_email, crm.dev_create_login   local development and tests only (refuse to run on Supabase)

-- ---------------------------------------------------------------- audit log of the CRM
create or replace function crm.audit_events(p_action text default null, p_search text default null, p_limit integer default 200)
returns table (id bigint, created_at timestamptz, action text, entity text, entity_id text, summary text, user_name text, before jsonb, after jsonb)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
begin
  if v_org is null or not app.user_has_product(v_org, 'crm') or not app.can('crm', 'audit', 'view', v_org) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return query
    select l.id, l.created_at, substr(l.action, 5), l.table_name, l.detail ->> 'entity_id', coalesce(l.detail ->> 'summary', l.action || ' ' || coalesce(l.table_name, '')),
           coalesce(l.detail ->> 'user_name', (select s.full_name from core.staff s where s.org_id = v_org and s.user_id = l.actor_user_id)),
           l.before, l.after
      from audit.log l
     where l.org_id = v_org and l.action like 'crm.%' and l.detail ? 'summary'
       and (p_action is null or p_action = '' or l.action = 'crm.' || p_action)
       and (p_search is null or p_search = '' or lower(coalesce(l.detail ->> 'summary', '') || ' ' || coalesce(l.detail ->> 'user_name', '')) like '%' || lower(p_search) || '%')
     order by l.created_at desc, l.id desc
     limit least(greatest(p_limit, 1), 500);
end $$;

-- ---------------------------------------------------------------- users
create or replace function crm.revoke_user_sessions(p_user uuid) returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  n integer;
begin
  if v_org is null or not app.user_has_product(v_org, 'crm') or not app.can('crm', 'users', 'manage', v_org) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from core.org_users u where u.org_id = v_org and u.user_id = p_user) then
    raise exception 'unknown user' using errcode = '22023';
  end if;
  update core.device_tokens set revoked_at = now() where org_id = v_org and user_id = p_user and token like 'session:%' and revoked_at is null;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function crm.set_user_active(p_user uuid, p_active boolean) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
begin
  if v_org is null or not app.user_has_product(v_org, 'crm') or not app.can('crm', 'users', 'manage', v_org) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_user = auth.uid() then raise exception 'you cannot pause your own account' using errcode = '22023'; end if;
  update core.org_users set status = case when p_active then 'active' else 'disabled' end where org_id = v_org and user_id = p_user and kind = 'staff';
  if not found then raise exception 'unknown user' using errcode = '22023'; end if;
  update core.staff set status = case when p_active then 'active' else 'inactive' end where org_id = v_org and user_id = p_user;
  if not p_active then perform crm.revoke_user_sessions(p_user); end if;
end $$;

create or replace function crm.set_user_branches(p_user uuid, p_branches uuid[]) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
begin
  if v_org is null or not app.user_has_product(v_org, 'crm') or not app.can('crm', 'users', 'manage', v_org) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from core.org_users u where u.org_id = v_org and u.user_id = p_user) then
    raise exception 'unknown user' using errcode = '22023';
  end if;
  delete from core.user_branch_access where org_id = v_org and user_id = p_user;
  insert into core.user_branch_access (org_id, user_id, branch_id)
    select v_org, p_user, b.id from core.branches b where b.org_id = v_org and b.id = any (coalesce(p_branches, '{}')) on conflict do nothing;
end $$;

-- ---------------------------------------------------------------- local development only
-- Supabase's auth.users has instance_id; the local shim (supabase/local/shim.sql) does not. These two helpers exist so
-- AUTH_PROVIDER=dev can sign in and invite without a Supabase project, and refuse to do anything where auth.users is the real one.
create or replace function crm.dev_user_by_email(p_email text) returns uuid
language plpgsql stable security definer set search_path = '' as $$
begin
  if exists (select 1 from information_schema.columns c where c.table_schema = 'auth' and c.table_name = 'users' and c.column_name = 'instance_id') then
    raise exception 'dev login is not available on Supabase' using errcode = '42501';
  end if;
  return (select u.id from auth.users u where lower(u.email) = lower(p_email) limit 1);
end $$;

create or replace function crm.dev_create_login(p_email text, p_phone text default null) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  v_id uuid;
begin
  if exists (select 1 from information_schema.columns c where c.table_schema = 'auth' and c.table_name = 'users' and c.column_name = 'instance_id') then
    raise exception 'dev invites are not available on Supabase' using errcode = '42501';
  end if;
  if v_org is null or not app.user_has_product(v_org, 'crm') or not app.can('crm', 'users', 'manage', v_org) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select u.id into v_id from auth.users u where lower(u.email) = lower(p_email);
  if v_id is not null then return v_id; end if;
  insert into auth.users (email, phone) values (lower(p_email), p_phone) returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------- family merge
-- After a merge the old household has no enquiry left, so the row policies (which follow the enquiry) no longer show it to anybody
-- and it cannot be deleted through them. This removes a household that is empty, for roles that may delete or merge leads.
create or replace function crm.delete_empty_household(p_household uuid) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
begin
  if v_org is null or not app.user_has_product(v_org, 'crm')
     or not (app.can('crm', 'leads', 'delete', v_org) or app.can('crm', 'leads', 'merge', v_org)) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if exists (select 1 from crm.enquiries e where e.org_id = v_org and e.household_id = p_household)
     or exists (select 1 from crm.prospects p where p.org_id = v_org and p.household_id = p_household)
     or exists (select 1 from crm.guardians g where g.org_id = v_org and g.household_id = p_household) then
    return false;
  end if;
  delete from crm.households where org_id = v_org and id = p_household;
  return found;
end $$;

-- ---------------------------------------------------------------- saved views
-- The generated policy lets a person delete a saved view only with the lead 'delete' right, which counsellors do not have;
-- a person may always remove their own view.
drop policy if exists del on crm.saved_views;
create policy del on crm.saved_views for delete using (
  org_id = (select app.current_org_id()) and (select app.user_has_product((select app.current_org_id()), 'crm')) and user_id = (select app.uid()));

-- ---------------------------------------------------------------- grants
revoke execute on function crm.delete_empty_household(uuid), crm.audit_events(text, text, integer), crm.revoke_user_sessions(uuid), crm.set_user_active(uuid, boolean), crm.set_user_branches(uuid, uuid[]),
  crm.dev_user_by_email(text), crm.dev_create_login(text, text) from public;
grant execute on function crm.delete_empty_household(uuid), crm.audit_events(text, text, integer), crm.revoke_user_sessions(uuid), crm.set_user_active(uuid, boolean), crm.set_user_branches(uuid, uuid[]),
  crm.dev_user_by_email(text), crm.dev_create_login(text, text) to crm_server, service_role;
