-- AutoEd platform admin console (docs/adr/admin-console.md): narrow, audited functions for platform staff.
--
-- Why functions and not new policies: harness test T9 requires that a platform admin WITHOUT an open support
-- session sees no client master data (core.branches, core.org_users, ...). The console still has to create a
-- client's first branch and admin, list users, lock accounts and grant product access. Each function below
-- checks app.is_platform_admin() first, touches exactly one concern, and writes through the tables that carry the
-- audit triggers, so every change lands in audit.log with the admin as actor (auth.uid() is the caller's claim,
-- also inside security definer). Executable by platform_admin_server (and service_role) only, never by PUBLIC,
-- `authenticated` or the product server roles.

create or replace function app.admin_guard() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.is_platform_admin() then
    raise exception 'platform admin only' using errcode = '42501';
  end if;
end $$;

-- Named event in audit.log for one console action (row-level changes are logged by the table triggers).
create or replace function app.admin_log_event(p_org uuid, p_action text, p_detail jsonb default '{}'::jsonb, p_row_id uuid default null)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  perform app.admin_guard();
  if p_action is null or p_action !~ '^admin\.[a-z_]+(\.[a-z_]+)*$' then
    raise exception 'admin events are named admin.<area>.<action>' using errcode = '22023';
  end if;
  insert into audit.log (org_id, actor_user_id, support_session_id, action, row_id, detail)
  values (p_org, auth.uid(), app.support_session_id(), p_action, p_row_id, coalesce(p_detail, '{}'::jsonb));
end $$;

-- Per-client counters for the clients list (no personal data).
create or replace function app.admin_client_stats()
returns table (org_id uuid, branch_count integer, user_count integer, active_user_count integer, invited_count integer,
               locked_count integer, last_login_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.admin_guard();
  return query
  select o.id,
    (select count(*)::integer from core.branches b where b.org_id = o.id),
    (select count(*)::integer from core.org_users u where u.org_id = o.id),
    (select count(*)::integer from core.org_users u where u.org_id = o.id and u.status = 'active'),
    (select count(*)::integer from core.org_users u where u.org_id = o.id and u.status = 'invited'),
    (select count(*)::integer from core.user_security s where s.org_id = o.id and s.locked_until > now()),
    (select max(e.created_at) from core.login_events e where e.org_id = o.id and e.success)
  from core.organizations o;
end $$;

-- ---------------------------------------------------------------- branches
create or replace function app.admin_list_branches(p_org uuid) returns setof core.branches
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.admin_guard();
  return query select * from core.branches b where b.org_id = p_org order by b.created_at, b.code;
end $$;

-- Insert (p_id null) or update one branch of a client.
create or replace function app.admin_save_branch(p_org uuid, p_id uuid, p_name text, p_code text, p_city text,
  p_state_code text, p_time_zone text, p_active boolean default true) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform app.admin_guard();
  if not exists (select 1 from core.organizations o where o.id = p_org) then
    raise exception 'unknown organisation' using errcode = '22023';
  end if;
  if p_id is null then
    insert into core.branches (org_id, name, code, city, state_code, time_zone, active)
    values (p_org, p_name, p_code, p_city, p_state_code, p_time_zone, coalesce(p_active, true)) returning id into v_id;
  else
    update core.branches set name = p_name, code = p_code, city = p_city, state_code = p_state_code,
           time_zone = p_time_zone, active = coalesce(p_active, true)
     where id = p_id and org_id = p_org returning id into v_id;
    if v_id is null then raise exception 'unknown branch' using errcode = '22023'; end if;
  end if;
  return v_id;
end $$;

-- ---------------------------------------------------------------- roles
create or replace function app.admin_list_roles(p_org uuid)
returns table (product_key text, key text, name text, permission_count integer)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.admin_guard();
  return query
  select r.product_key, r.key, r.name, (select count(*)::integer from core.role_permissions rp where rp.role_id = r.id)
    from core.roles r where r.org_id = p_org order by r.product_key, r.key;
end $$;

-- The built-in client admin role of a product: every module and action at org scope (same shape as the harness).
create or replace function app.admin_ensure_admin_role(p_org uuid, p_product text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_role uuid;
begin
  perform app.admin_guard();
  select r.id into v_role from core.roles r where r.org_id = p_org and r.product_key = p_product and r.key = 'admin';
  if v_role is null then
    insert into core.roles (org_id, product_key, key, name) values (p_org, p_product, 'admin', 'Admin') returning id into v_role;
  end if;
  insert into core.role_permissions (org_id, role_id, module_key, action, scope)
  values (p_org, v_role, '*', '*', 'org') on conflict (role_id, module_key, action) do nothing;
end $$;

-- ---------------------------------------------------------------- users
create or replace function app.admin_list_users(p_org uuid)
returns table (user_id uuid, kind text, display_name text, status text, home_branch_id uuid, email text, phone text,
               created_at timestamptz, must_change_password boolean, locked_until timestamptz, failed_attempts integer,
               mfa_required boolean, last_login_at timestamptz, access jsonb)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.admin_guard();
  return query
  select u.user_id, u.kind, u.display_name, u.status, u.home_branch_id, a.email::text, a.phone::text, u.created_at,
         coalesce(s.must_change_password, false), s.locked_until, coalesce(s.failed_attempts, 0), coalesce(s.mfa_required, false),
         (select max(e.created_at) from core.login_events e where e.user_id = u.user_id and e.success),
         coalesce((select jsonb_agg(jsonb_build_object('product_key', x.product_key, 'role_key', x.role_key, 'granted_at', x.granted_at)
                                    order by x.product_key)
                     from core.user_product_access x where x.user_id = u.user_id and x.org_id = u.org_id and x.revoked_at is null), '[]'::jsonb)
    from core.org_users u
    left join auth.users a on a.id = u.user_id
    left join core.user_security s on s.user_id = u.user_id
   where u.org_id = p_org
   order by u.kind, u.display_name;
end $$;

-- Links an auth user (created by the invite step) to a client. A second link is refused by org_users_one_org_per_user.
create or replace function app.admin_create_org_user(p_org uuid, p_user uuid, p_kind text, p_display_name text,
  p_home_branch uuid default null, p_status text default 'invited') returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform app.admin_guard();
  insert into core.org_users (org_id, user_id, kind, display_name, status, home_branch_id)
  values (p_org, p_user, p_kind, p_display_name, coalesce(p_status, 'invited'), p_home_branch) returning id into v_id;
  insert into core.user_security (user_id, org_id) values (p_user, p_org)
  on conflict (user_id) do update set org_id = excluded.org_id;
  return v_id;
end $$;

create or replace function app.admin_set_user_status(p_user uuid, p_status text) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid;
begin
  perform app.admin_guard();
  update core.org_users set status = p_status where user_id = p_user returning org_id into v_org;
  if v_org is null then raise exception 'unknown user' using errcode = '22023'; end if;
  return v_org;
end $$;

-- Lock (until now + minutes) or unlock (also resets the failed-attempt counter). Server login code checks
-- app.login_allowed(), which reads locked_until.
create or replace function app.admin_set_user_lock(p_user uuid, p_locked boolean, p_minutes integer default 1440) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid;
begin
  perform app.admin_guard();
  select u.org_id into v_org from core.org_users u where u.user_id = p_user;
  if v_org is null then raise exception 'unknown user' using errcode = '22023'; end if;
  if p_locked and (p_minutes is null or p_minutes < 1 or p_minutes > 5256000) then
    raise exception 'lock minutes must be between 1 and 5256000' using errcode = '22023';
  end if;
  insert into core.user_security (user_id, org_id) values (p_user, v_org) on conflict (user_id) do nothing;
  if p_locked then
    update core.user_security set locked_until = now() + make_interval(mins => p_minutes), updated_at = now() where user_id = p_user;
  else
    update core.user_security set locked_until = null, failed_attempts = 0, updated_at = now() where user_id = p_user;
  end if;
  return v_org;
end $$;

create or replace function app.admin_set_must_change_password(p_user uuid, p_required boolean) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid;
begin
  perform app.admin_guard();
  select u.org_id into v_org from core.org_users u where u.user_id = p_user;
  if v_org is null then raise exception 'unknown user' using errcode = '22023'; end if;
  insert into core.user_security (user_id, org_id) values (p_user, v_org) on conflict (user_id) do nothing;
  update core.user_security set must_change_password = coalesce(p_required, false), updated_at = now() where user_id = p_user;
  return v_org;
end $$;

-- ---------------------------------------------------------------- product access (who may use which product)
create or replace function app.admin_set_product_access(p_org uuid, p_user uuid, p_product text, p_role_key text) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform app.admin_guard();
  if not exists (select 1 from core.org_users u where u.org_id = p_org and u.user_id = p_user) then
    raise exception 'user is not a member of this client' using errcode = '22023';
  end if;
  if not exists (select 1 from core.roles r where r.org_id = p_org and r.product_key = p_product and r.key = p_role_key) then
    raise exception 'unknown role % for product %', p_role_key, p_product using errcode = '22023';
  end if;
  select a.id into v_id from core.user_product_access a
   where a.org_id = p_org and a.user_id = p_user and a.product_key = p_product and a.revoked_at is null and a.role_key = p_role_key;
  if v_id is not null then return v_id; end if;
  update core.user_product_access set revoked_at = now()
   where org_id = p_org and user_id = p_user and product_key = p_product and revoked_at is null;
  insert into core.user_product_access (org_id, user_id, product_key, role_key, granted_by)
  values (p_org, p_user, p_product, p_role_key, auth.uid()) returning id into v_id;
  return v_id;
end $$;

create or replace function app.admin_revoke_product_access(p_org uuid, p_user uuid, p_product text) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare v_n integer;
begin
  perform app.admin_guard();
  update core.user_product_access set revoked_at = now()
   where org_id = p_org and user_id = p_user and product_key = p_product and revoked_at is null;
  get diagnostics v_n = row_count;
  return v_n > 0;
end $$;

-- "What can this user see": the raw facts the database gates use, for one user, as JSON. Read only.
-- org_on / branch_on call the same functions the RLS policies call.
create or replace function app.admin_entitlement_preview(p_org uuid, p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_user core.org_users;
  v_org core.organizations;
  v_all_branches boolean;
  v_visible uuid[];
begin
  perform app.admin_guard();
  select * into v_user from core.org_users u where u.org_id = p_org and u.user_id = p_user;
  if v_user.id is null then raise exception 'user is not a member of this client' using errcode = '22023'; end if;
  select * into v_org from core.organizations o where o.id = p_org;
  v_all_branches := v_user.home_branch_id is null and not exists (select 1 from core.user_branch_access a where a.user_id = p_user);
  select coalesce(array_agg(x.id), '{}') into v_visible from (
    select b.id from core.branches b where v_all_branches and b.org_id = p_org
    union select v_user.home_branch_id where v_user.home_branch_id is not null
    union select a.branch_id from core.user_branch_access a where a.user_id = p_user) x;
  return jsonb_build_object(
    'user', jsonb_build_object('user_id', v_user.user_id, 'kind', v_user.kind, 'display_name', v_user.display_name,
                               'status', v_user.status, 'home_branch_id', v_user.home_branch_id),
    'org', jsonb_build_object('id', v_org.id, 'name', v_org.name, 'status', v_org.status),
    'all_branches', v_all_branches,
    'learner_link_count', (select count(*) from core.learner_links l where l.user_id = p_user),
    'branches', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name, 'code', b.code, 'active', b.active,
                                                              'visible', b.id = any(v_visible))
                                           order by b.code) from core.branches b where b.org_id = p_org), '[]'::jsonb),
    'products', coalesce((select jsonb_agg(jsonb_build_object(
        'product_key', p.key,
        'subscription_status', (select s.status from core.subscriptions s where s.org_id = p_org and s.product_key = p.key),
        'org_on', app.org_has_product(p_org, p.key),
        'access', (select jsonb_build_object('role_key', a.role_key, 'granted_at', a.granted_at)
                     from core.user_product_access a
                    where a.org_id = p_org and a.user_id = p_user and a.product_key = p.key and a.revoked_at is null),
        'permissions', case when v_user.kind = 'staff' then coalesce((
            select jsonb_agg(jsonb_build_object('module_key', rp.module_key, 'action', rp.action, 'scope', rp.scope)
                             order by rp.module_key, rp.action)
              from core.user_product_access a
              join core.roles r on r.org_id = a.org_id and r.product_key = a.product_key and r.key = a.role_key
              join core.role_permissions rp on rp.role_id = r.id
             where a.org_id = p_org and a.user_id = p_user and a.product_key = p.key and a.revoked_at is null), '[]'::jsonb)
          else '[]'::jsonb end,
        'branches_on', coalesce((select jsonb_agg(jsonb_build_object('branch_id', b.id, 'on', app.branch_has_product(p_org, b.id, p.key)) order by b.code)
                                   from core.branches b where b.org_id = p_org), '[]'::jsonb)
      ) order by p.key) from core.products p), '[]'::jsonb)
  );
end $$;

-- Local development only: resolves an active platform admin's e-mail to its auth user id, so the dev login of the
-- console works without Supabase Auth. Returns null for everyone who is not an active platform admin. The route that
-- calls it exists only when AUTH_PROVIDER=dev.
create or replace function app.admin_dev_login_user(p_email text) returns uuid
language sql stable security definer set search_path = '' as $$
  select a.id from auth.users a join core.platform_admins p on p.user_id = a.id and p.active
   where lower(a.email) = lower(p_email) limit 1
$$;

-- ---------------------------------------------------------------- grants
revoke execute on function
  app.admin_guard(), app.admin_log_event(uuid, text, jsonb, uuid), app.admin_client_stats(), app.admin_list_branches(uuid),
  app.admin_save_branch(uuid, uuid, text, text, text, text, text, boolean), app.admin_list_roles(uuid),
  app.admin_ensure_admin_role(uuid, text), app.admin_list_users(uuid), app.admin_create_org_user(uuid, uuid, text, text, uuid, text),
  app.admin_set_user_status(uuid, text), app.admin_set_user_lock(uuid, boolean, integer),
  app.admin_set_must_change_password(uuid, boolean), app.admin_set_product_access(uuid, uuid, text, text),
  app.admin_revoke_product_access(uuid, uuid, text), app.admin_entitlement_preview(uuid, uuid), app.admin_dev_login_user(text)
  from public;
grant execute on function
  app.admin_guard(), app.admin_log_event(uuid, text, jsonb, uuid), app.admin_client_stats(), app.admin_list_branches(uuid),
  app.admin_save_branch(uuid, uuid, text, text, text, text, text, boolean), app.admin_list_roles(uuid),
  app.admin_ensure_admin_role(uuid, text), app.admin_list_users(uuid), app.admin_create_org_user(uuid, uuid, text, text, uuid, text),
  app.admin_set_user_status(uuid, text), app.admin_set_user_lock(uuid, boolean, integer),
  app.admin_set_must_change_password(uuid, boolean), app.admin_set_product_access(uuid, uuid, text, text),
  app.admin_revoke_product_access(uuid, uuid, text), app.admin_entitlement_preview(uuid, uuid), app.admin_dev_login_user(text)
  to platform_admin_server, service_role;
