-- Unified staff login (decisions 35-37, docs/adr/shell-and-login.md): server-side helpers for the sign-in
-- endpoints. The servers verify OTPs and passwords with Supabase Auth (or the local dev provider); these
-- functions only resolve an identifier to a user and keep core.user_security up to date. Lockout bookkeeping
-- stays in app.record_login_event / app.login_allowed (foundation, 20261115000005).
--
-- None of these is executable by `authenticated`: a signed-in user must not look up other people's logins or
-- reset their own password bookkeeping.

-- Who is signing in? Matches an e-mail (case-insensitive) or a phone number (digits only, with or without the
-- country code 91). Returns nothing for an unknown identifier. One user belongs to one org (decision 37).
create or replace function app.login_lookup(p_identifier text)
returns table (user_id uuid, org_id uuid, member_status text, platform_admin boolean)
language sql stable security definer set search_path = '' as $$
  with ident as (
    select lower(btrim(p_identifier)) as email,
           regexp_replace(coalesce(p_identifier, ''), '\D', '', 'g') as digits
  ), hit as (
    select u.id
      from auth.users u, ident i
     where (position('@' in i.email) > 0 and lower(u.email) = i.email)
        or (position('@' in i.email) = 0 and length(i.digits) >= 10 and u.phone is not null
            and (regexp_replace(u.phone, '\D', '', 'g') = i.digits
                 or regexp_replace(u.phone, '\D', '', 'g') = '91' || i.digits
                 or '91' || regexp_replace(u.phone, '\D', '', 'g') = i.digits))
     limit 1
  )
  select h.id, ou.org_id, ou.status,
         exists (select 1 from core.platform_admins p where p.user_id = h.id and p.active)
    from hit h left join core.org_users ou on ou.user_id = h.id
$$;

-- The e-mail and phone of a user (to re-verify the current password with Supabase Auth).
create or replace function app.login_identity(p_user uuid)
returns table (email text, phone text)
language sql stable security definer set search_path = '' as $$
  select u.email, u.phone from auth.users u where u.id = p_user
$$;

-- A password was set or changed (by the user, or by an admin with p_must_change = true for a temporary one).
create or replace function app.record_password_set(p_user uuid, p_must_change boolean default false)
returns core.user_security
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid;
  v_sec core.user_security;
begin
  select u.org_id into v_org from core.org_users u where u.user_id = p_user;
  insert into core.user_security (user_id, org_id) values (p_user, v_org)
  on conflict (user_id) do update set org_id = coalesce(excluded.org_id, core.user_security.org_id);
  update core.user_security
     set password_set_at = coalesce(password_set_at, now()),
         password_changed_at = now(),
         must_change_password = coalesce(p_must_change, false),
         failed_attempts = 0,
         locked_until = null,
         updated_at = now()
   where user_id = p_user
  returning * into v_sec;
  return v_sec;
end $$;

-- A login event that must not touch the failed-attempt counter: refusals after the secret was checked (locked,
-- disabled, no product) and sign-outs. app.record_login_event counts every failed password attempt and resets the
-- counter on success, which is right for the password check itself but not for these.
create or replace function app.record_login_note(p_user uuid, p_method text, p_success boolean, p_reason text,
  p_ip inet default null, p_user_agent text default null) returns void
language sql volatile security definer set search_path = '' as $$
  insert into core.login_events (org_id, user_id, method, success, reason, ip, user_agent)
  values ((select u.org_id from core.org_users u where u.user_id = p_user), p_user, p_method, p_success, p_reason, p_ip, left(p_user_agent, 300))
$$;

revoke execute on function app.login_lookup(text), app.login_identity(uuid), app.record_password_set(uuid, boolean),
  app.record_login_note(uuid, text, boolean, text, inet, text)
  from public, anon, authenticated, job_runner;
grant execute on function app.login_lookup(text), app.login_identity(uuid), app.record_password_set(uuid, boolean),
  app.record_login_note(uuid, text, boolean, text, inet, text)
  to crm_server, os_server, erp_server, platform_admin_server, service_role;

-- Local only: the dev provider's password store (supabase/local/shim.sql). Absent on Supabase, so this is a no-op there.
do $$
begin
  if to_regprocedure('auth.dev_password_hash(uuid)') is not null then
    grant usage on schema auth to crm_server, os_server, erp_server;
    grant execute on function auth.dev_password_hash(uuid), auth.dev_set_password(uuid, text) to crm_server, os_server, erp_server;
  end if;
end $$;
