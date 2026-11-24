-- AutoEd platform foundation (5/6): policies and grants for core, audit, billing, private; support sessions,
-- login security, jobs, rate limits and storage policies.
-- Policies have no TO clause (they apply to every role); which roles reach a table at all is decided by
-- the GRANTs below. Writes to entitlement tables are granted only to platform_admin_server.

-- ---------------------------------------------------------------- core: global reference tables
select app.apply_rls('core', 'products', 'global', null, null);
select app.apply_rls('core', 'product_modules', 'global', null, null);

alter table core.platform_admins enable row level security;
create policy sel on core.platform_admins for select using (user_id = auth.uid() or app.is_platform_admin());
select app.enable_audit('core', 'platform_admins');

-- ---------------------------------------------------------------- core: tenancy
-- An org row is readable by its own users whatever their products (to show "not part of your plan" /
-- "suspended" pages and branding) and by platform admins (console). Only platform admins create or delete.
alter table core.organizations enable row level security;
create policy sel on core.organizations for select using (id = app.current_org_id() or app.is_platform_admin());
create policy ins on core.organizations for insert with check (app.is_platform_admin());
create policy upd on core.organizations for update
  using (app.is_platform_admin() or app.can_any_product('setup', 'configure', id))
  with check (app.is_platform_admin() or app.can_any_product('setup', 'configure', id));
create policy del on core.organizations for delete using (app.is_platform_admin());
select app.enable_audit('core', 'organizations', true);

-- Branches are master data: readable with any product, edited by setup.configure in any product.
select app.apply_rls('core', 'branches', 'core_master', '*', 'setup');

-- ---------------------------------------------------------------- core: entitlements
alter table core.subscriptions enable row level security;
create policy sel on core.subscriptions for select using (org_id = app.current_org_id() or app.is_platform_admin());
create policy wr on core.subscriptions for all using (app.is_platform_admin()) with check (app.is_platform_admin());
select app.enable_audit('core', 'subscriptions', true);

alter table core.org_branch_products enable row level security;
create policy sel on core.org_branch_products for select using (org_id = app.current_org_id() or app.is_platform_admin());
create policy wr on core.org_branch_products for all using (app.is_platform_admin()) with check (app.is_platform_admin());
select app.enable_audit('core', 'org_branch_products', true);

-- ---------------------------------------------------------------- core: identity and roles
-- A user sees their own link; user admins (users.view in any product) see the org's list.
alter table core.org_users enable row level security;
create policy sel on core.org_users for select using (user_id = auth.uid() or app.can_any_product('users', 'view', org_id));
create policy ins on core.org_users for insert with check (app.can_any_product('users', 'manage', org_id));
create policy upd on core.org_users for update using (app.can_any_product('users', 'manage', org_id)) with check (app.can_any_product('users', 'manage', org_id));
create policy del on core.org_users for delete using (app.can_any_product('users', 'manage', org_id));
select app.enable_audit('core', 'org_users', true);

alter table core.user_branch_access enable row level security;
create policy sel on core.user_branch_access for select using (user_id = auth.uid() or app.can_any_product('users', 'view', org_id));
create policy wr on core.user_branch_access for all using (app.can_any_product('users', 'manage', org_id)) with check (app.can_any_product('users', 'manage', org_id));
select app.enable_audit('core', 'user_branch_access', true);

alter table core.learner_links enable row level security;
create policy sel on core.learner_links for select using (user_id = auth.uid() or app.can_any_product('users', 'view', org_id));
create policy wr on core.learner_links for all using (app.can_any_product('users', 'manage', org_id)) with check (app.can_any_product('users', 'manage', org_id));
select app.enable_audit('core', 'learner_links', true);

-- Roles of a product are managed only by someone who manages users IN THAT product, so a CRM admin
-- cannot create an OS role and grant it to themselves.
alter table core.roles enable row level security;
create policy sel on core.roles for select using (org_id = app.current_org_id() and app.user_has_any_product(org_id));
create policy wr on core.roles for all using (app.can(product_key, 'users', 'manage', org_id)) with check (app.can(product_key, 'users', 'manage', org_id));
select app.enable_audit('core', 'roles', true);

alter table core.role_permissions enable row level security;
create policy sel on core.role_permissions for select using (org_id = app.current_org_id() and app.user_has_any_product(org_id));
create policy wr on core.role_permissions for all
  using (exists (select 1 from core.roles r where r.id = role_id and r.org_id = role_permissions.org_id and app.can(r.product_key, 'users', 'manage', r.org_id)))
  with check (exists (select 1 from core.roles r where r.id = role_id and r.org_id = role_permissions.org_id and app.can(r.product_key, 'users', 'manage', r.org_id)));
select app.enable_audit('core', 'role_permissions', true);

alter table core.user_product_access enable row level security;
create policy sel on core.user_product_access for select using (user_id = auth.uid() or app.can_any_product('users', 'view', org_id));
create policy wr on core.user_product_access for all
  using (app.can(product_key, 'users', 'manage', org_id)) with check (app.can(product_key, 'users', 'manage', org_id));
select app.enable_audit('core', 'user_product_access', true);

-- ---------------------------------------------------------------- core: login security (read-only to users)
alter table core.user_security enable row level security;
create policy sel on core.user_security for select using (
  user_id = auth.uid() or app.is_platform_admin() or (org_id is not null and app.can_any_product('users', 'view', org_id)));
select app.enable_audit('core', 'user_security');

alter table core.login_events enable row level security;
create policy sel on core.login_events for select using (
  user_id = auth.uid() or app.is_platform_admin() or (org_id is not null and app.can_any_product('users', 'view', org_id)));
-- login_events is itself a log: no audit trigger (reviewed exception in harness T7).

alter table core.support_sessions enable row level security;
-- The client's admins see the support-access log of their org (plan 4.4).
create policy sel on core.support_sessions for select using (
  app.is_platform_admin() or (org_id = app.current_org_id() and app.can_any_product('audit', 'view', org_id)));
select app.enable_audit('core', 'support_sessions');

-- ---------------------------------------------------------------- audit
alter table audit.log enable row level security;
create policy sel on audit.log for select using (
  app.is_platform_admin() or (org_id = app.current_org_id() and app.can_any_product('audit', 'view', org_id)));
alter table audit.config_history enable row level security;
create policy sel on audit.config_history for select using (
  app.is_platform_admin() or (org_id = app.current_org_id() and app.can_any_product('audit', 'view', org_id)));

-- ---------------------------------------------------------------- billing
select app.apply_rls('billing', 'plans', 'global', null, null);
do $$
declare t text;
begin
  foreach t in array array['accounts','razorpay_subscriptions','invoices','invoice_lines','payments','usage'] loop
    execute format('alter table billing.%I enable row level security', t);
    execute format('create policy sel on billing.%I for select using (app.is_platform_admin() or (org_id = app.current_org_id() and app.can_any_product(''billing'', ''view'', org_id)))', t);
    execute format('create policy wr on billing.%I for all using (app.is_platform_admin()) with check (app.is_platform_admin())', t);
    perform app.enable_audit('billing', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- private: RLS on, no policies
-- Only security definer functions (owned by the migration role) read or write these tables.
alter table private.jobs enable row level security;
alter table private.rate_limits enable row level security;
alter table private.webhook_events enable row level security;

-- ---------------------------------------------------------------- grants
grant select on all tables in schema core to authenticated, crm_server, os_server, erp_server, platform_admin_server;
grant insert, update, delete on core.branches, core.org_users, core.user_branch_access, core.learner_links,
  core.roles, core.role_permissions, core.user_product_access
  to authenticated, crm_server, os_server, erp_server, platform_admin_server;
grant update on core.organizations to authenticated, crm_server, os_server, erp_server, platform_admin_server;
grant insert, delete on core.organizations to platform_admin_server;
grant insert, update, delete on core.subscriptions, core.org_branch_products, core.products, core.product_modules
  to platform_admin_server;
grant select on all tables in schema audit to authenticated, platform_admin_server;
grant select on all tables in schema billing to authenticated, platform_admin_server;
grant insert, update, delete on all tables in schema billing to platform_admin_server;
grant all on all tables in schema core, audit, billing, private to service_role;

-- ---------------------------------------------------------------- support sessions ("view as", test T9)
create or replace function app.start_support_session(p_org uuid, p_reason text, p_minutes integer default 60,
  p_read_only boolean default true) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id uuid;
  v_exp timestamptz;
begin
  if not app.is_platform_admin() then
    raise exception 'only platform admins can open a support session' using errcode = '42501';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 10 then
    raise exception 'a reason of at least 10 characters is required' using errcode = '22023';
  end if;
  if p_minutes is null or p_minutes < 1 or p_minutes > 240 then
    raise exception 'support sessions last 1 to 240 minutes' using errcode = '22023';
  end if;
  if not exists (select 1 from core.organizations o where o.id = p_org) then
    raise exception 'unknown organisation' using errcode = '22023';
  end if;
  -- one open session per admin: close any previous one first
  update core.support_sessions set ended_at = greatest(now(), started_at)
   where platform_user_id = auth.uid() and ended_at is null;
  v_exp := now() + make_interval(mins => p_minutes);
  insert into core.support_sessions (org_id, platform_user_id, reason, read_only, started_at, expires_at)
  values (p_org, auth.uid(), btrim(p_reason), p_read_only, now(), v_exp)
  returning id into v_id;
  insert into audit.log (org_id, actor_user_id, support_session_id, action, schema_name, table_name, row_id, detail)
  values (p_org, auth.uid(), v_id, 'support_session.start', 'core', 'support_sessions', v_id,
          jsonb_build_object('reason', btrim(p_reason), 'expires_at', v_exp, 'read_only', p_read_only));
  return v_id;
end $$;

create or replace function app.end_support_session() returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  s record;
begin
  for s in update core.support_sessions set ended_at = greatest(now(), started_at)
            where platform_user_id = auth.uid() and ended_at is null returning id, org_id loop
    insert into audit.log (org_id, actor_user_id, support_session_id, action, schema_name, table_name, row_id)
    values (s.org_id, auth.uid(), s.id, 'support_session.end', 'core', 'support_sessions', s.id);
  end loop;
end $$;

-- ---------------------------------------------------------------- login security (decision 36)
-- Called by the auth endpoint of a product server after each attempt. Five failed password attempts
-- lock the account for 15 minutes. Not granted to `authenticated`: a user must not reset their own counter.
create or replace function app.record_login_event(p_user uuid, p_method text, p_success boolean,
  p_reason text default null, p_ip inet default null, p_user_agent text default null) returns core.user_security
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid;
  v_sec core.user_security;
begin
  select u.org_id into v_org from core.org_users u where u.user_id = p_user;
  insert into core.login_events (org_id, user_id, method, success, reason, ip, user_agent)
  values (v_org, p_user, p_method, p_success, p_reason, p_ip, p_user_agent);
  if p_user is null then return null; end if;
  insert into core.user_security (user_id, org_id) values (p_user, v_org)
  on conflict (user_id) do update set org_id = excluded.org_id;
  if p_success then
    update core.user_security set failed_attempts = 0, locked_until = null, updated_at = now()
     where user_id = p_user returning * into v_sec;
  elsif p_method = 'password' then
    update core.user_security
       set failed_attempts = failed_attempts + 1,
           locked_until = case when failed_attempts + 1 >= 5 then now() + interval '15 minutes' else locked_until end,
           updated_at = now()
     where user_id = p_user returning * into v_sec;
  else
    select * into v_sec from core.user_security where user_id = p_user;
  end if;
  return v_sec;
end $$;

create or replace function app.login_allowed(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select not exists (select 1 from core.user_security s where s.user_id = p_user and s.locked_until > now())
$$;

-- ---------------------------------------------------------------- jobs (plan 4.10, test T11)
-- Enqueue for the signed-in user's org; refused when the user does not have the product.
create or replace function app.enqueue_job(p_product text, p_kind text, p_payload jsonb default '{}'::jsonb,
  p_run_at timestamptz default now()) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  v_id uuid;
begin
  if not app.user_has_product(v_org, p_product) then
    raise exception 'product % is not available' , p_product using errcode = '42501';
  end if;
  insert into private.jobs (org_id, product_key, kind, payload, run_at)
  values (v_org, p_product, p_kind, coalesce(p_payload, '{}'::jsonb), p_run_at) returning id into v_id;
  return v_id;
end $$;

-- Claim due jobs of one product. Jobs of orgs that no longer have the product are marked 'skipped' and
-- logged in audit.log instead of running.
create or replace function private.claim_jobs(p_product text, p_worker text, p_limit integer default 10)
returns setof private.jobs
language plpgsql volatile security definer set search_path = '' as $$
declare
  j record;
begin
  for j in update private.jobs
              set status = 'skipped', skip_reason = 'org has no active ' || p_product || ' subscription', finished_at = now()
            where status = 'queued' and product_key = p_product and run_at <= now()
              and not app.org_has_product(org_id, p_product)
           returning id, org_id, kind loop
    insert into audit.log (org_id, action, schema_name, table_name, row_id, detail)
    values (j.org_id, 'job.skipped', 'private', 'jobs', j.id,
            jsonb_build_object('product', p_product, 'kind', j.kind, 'reason', 'no active subscription'));
  end loop;
  return query
    update private.jobs t set status = 'running', locked_at = now(), locked_by = p_worker, attempts = t.attempts + 1
     where t.id in (select q.id from private.jobs q
                     where q.status = 'queued' and q.product_key = p_product and q.run_at <= now()
                     order by q.run_at limit greatest(p_limit, 0) for update skip locked)
    returning t.*;
end $$;

create or replace function private.finish_job(p_id uuid, p_ok boolean, p_error text default null) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  update private.jobs
     set status = case when p_ok then 'done' when attempts >= max_attempts then 'failed' else 'queued' end,
         last_error = case when p_ok then null else p_error end,
         finished_at = case when p_ok or attempts >= max_attempts then now() end,
         run_at = case when p_ok then run_at else now() + make_interval(secs => 30 * power(2, least(attempts, 8))) end,
         locked_at = null, locked_by = null
   where id = p_id and status = 'running';
end $$;

-- ---------------------------------------------------------------- rate limits
-- Fixed window. Returns true when the call is allowed (and counts it).
create or replace function app.rate_limit_hit(p_key text, p_limit integer, p_window_seconds integer, p_org uuid default null)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare
  v_start timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_hits integer;
begin
  insert into private.rate_limits (key, window_start, org_id, hits) values (p_key, v_start, p_org, 1)
  on conflict (key, window_start) do update set hits = private.rate_limits.hits + 1
  returning hits into v_hits;
  return v_hits <= p_limit;
end $$;

-- ---------------------------------------------------------------- storage (plan 4.7, test T8 policy level)
-- One private bucket per product plus core-files. Object paths start with '{org_id}/'.
insert into storage.buckets (id, name, public, file_size_limit) values
  ('core-files', 'core-files', false, 26214400),
  ('crm-files', 'crm-files', false, 26214400),
  ('erp-files', 'erp-files', false, 26214400)
on conflict (id) do nothing;
insert into storage.buckets (id, name, public, file_size_limit) values ('os-files', 'os-files', false, 26214400)
on conflict (id) do nothing;

create or replace function app.storage_allowed(p_bucket text, p_name text, p_write boolean) returns boolean
language sql stable security definer set search_path = '' as $$
  with t as (select app.try_uuid(split_part(p_name, '/', 1)) as org,
                    case p_bucket when 'crm-files' then 'crm' when 'os-files' then 'os' when 'erp-files' then 'erp' end as product)
  select case
    when t.org is null then false
    when p_bucket = 'core-files' then
      case when p_write then app.can_any_product('files', 'create', t.org) else app.user_has_any_product(t.org) end
    when t.product is null then false
    when p_write then app.can(t.product, 'files', 'create', t.org)
    else app.user_has_product(t.org, t.product)
  end from t
$$;

drop policy if exists platform_files_sel on storage.objects;
drop policy if exists platform_files_ins on storage.objects;
drop policy if exists platform_files_upd on storage.objects;
drop policy if exists platform_files_del on storage.objects;
create policy platform_files_sel on storage.objects for select to authenticated
  using (bucket_id in ('core-files','crm-files','os-files','erp-files') and app.storage_allowed(bucket_id, name, false));
create policy platform_files_ins on storage.objects for insert to authenticated
  with check (bucket_id in ('core-files','crm-files','os-files','erp-files') and app.storage_allowed(bucket_id, name, true));
create policy platform_files_upd on storage.objects for update to authenticated
  using (bucket_id in ('core-files','crm-files','os-files','erp-files') and app.storage_allowed(bucket_id, name, true))
  with check (bucket_id in ('core-files','crm-files','os-files','erp-files') and app.storage_allowed(bucket_id, name, true));
create policy platform_files_del on storage.objects for delete to authenticated
  using (bucket_id in ('core-files','crm-files','os-files','erp-files') and app.storage_allowed(bucket_id, name, true));
