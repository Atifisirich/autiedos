-- AutoEd OS on the shared platform (2/6): keeping core identity and product access in step with OS staff/roles.
--
-- For every OS staff member with a login (core.staff.user_id):
--   core.org_users            kind 'staff', display name, home branch = staff.branch_id
--   core.roles (product os)   one derived role per distinct set of OS roles (key 'os_<role key>', or 'os_x<hash>' for
--                             several roles); access rows pointing at any other role key (set by the platform console)
--                             are left alone
--   core.role_permissions     union of the OS permissions, scope own/team/department/wing -> own, branch -> branch,
--                             group -> org; plus files view/create at org scope (uploads to os-files)
--   core.user_product_access  product 'os' with that derived role (revoked when the staff member leaves)
-- os.sync_access(org) rebuilds all of it idempotently; triggers on os.staff_roles / os.role_permissions / os.roles
-- call it, and the OS server calls it after creating or editing staff.

create or replace function os.derived_role_key(p_keys text[]) returns text
language sql immutable set search_path = '' as $$
  select case
    when p_keys is null or cardinality(p_keys) = 0 then 'os_member'
    when cardinality(p_keys) = 1 then 'os_' || p_keys[1]
    else 'os_x' || substr(md5(array_to_string(p_keys, ',')), 1, 16)
  end
$$;

create or replace function os.sync_access(p_org uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  s record;
  v_keys text[];
  v_key text;
  v_role uuid;
  v_sys uuid := os.system_user_of(p_org);
  v_cur text;
begin
  if p_org is null then return; end if;
  for s in
    select st.id, st.user_id, st.branch_id, st.full_name, st.status,
           coalesce((select array_agg(distinct r.key order by r.key) from os.staff_roles sr join os.roles r on r.id = sr.role_id
                      where sr.staff_id = st.id and sr.deleted_at is null and r.deleted_at is null), '{}') as keys,
           coalesce((select string_agg(distinct r.name, ' + ' order by r.name) from os.staff_roles sr join os.roles r on r.id = sr.role_id
                      where sr.staff_id = st.id and sr.deleted_at is null and r.deleted_at is null), 'Member') as names
      from core.staff st where st.org_id = p_org and st.user_id is not null and st.user_id <> v_sys
  loop
    v_keys := s.keys;
    v_key := os.derived_role_key(v_keys);
    insert into core.org_users (org_id, user_id, kind, display_name, home_branch_id, status)
    values (p_org, s.user_id, 'staff', s.full_name, s.branch_id, case when s.status in ('inactive','left') then 'disabled' else 'active' end)
    on conflict (user_id) do update set display_name = excluded.display_name, home_branch_id = excluded.home_branch_id,
      status = excluded.status where core.org_users.org_id = p_org;

    insert into core.roles (org_id, product_key, key, name) values (p_org, 'os', v_key, left(s.names, 200))
    on conflict (org_id, product_key, key) do update set name = excluded.name
    returning id into v_role;
    delete from core.role_permissions where role_id = v_role;
    insert into core.role_permissions (org_id, role_id, module_key, action, scope)
    select p_org, v_role, rp.module, rp.action,
           case max(os.scope_rank(rp.scope)) when 6 then 'org' when 5 then 'branch' else 'own' end
      from os.roles r join os.role_permissions rp on rp.role_id = r.id and rp.deleted_at is null
     where r.org_id = p_org and r.key = any(v_keys) and r.deleted_at is null
     group by rp.module, rp.action
    on conflict (role_id, module_key, action) do nothing;
    insert into core.role_permissions (org_id, role_id, module_key, action, scope)
    values (p_org, v_role, 'files', 'view', 'org'), (p_org, v_role, 'files', 'create', 'org')
    on conflict (role_id, module_key, action) do update set scope = 'org';

    select a.role_key into v_cur from core.user_product_access a
     where a.user_id = s.user_id and a.product_key = 'os' and a.revoked_at is null;
    if v_cur is not null and v_cur not like 'os\_%' then
      continue;   -- access managed outside the OS (platform console role)
    end if;
    if s.status in ('inactive','left') then
      update core.user_product_access set revoked_at = now()
       where user_id = s.user_id and product_key = 'os' and revoked_at is null;
    elsif exists (select 1 from core.user_product_access a where a.user_id = s.user_id and a.product_key = 'os' and a.revoked_at is null) then
      update core.user_product_access set role_key = v_key
       where user_id = s.user_id and product_key = 'os' and revoked_at is null and role_key <> v_key;
    else
      insert into core.user_product_access (org_id, user_id, product_key, role_key) values (p_org, s.user_id, 'os', v_key);
    end if;
  end loop;
  -- derived roles nobody uses any more
  delete from core.roles r where r.org_id = p_org and r.product_key = 'os' and r.key <> 'os_system'
     and r.key like 'os\_%'
     and not exists (select 1 from core.user_product_access a where a.org_id = p_org and a.product_key = 'os' and a.role_key = r.key);
end $$;

-- The org's system actor: an auth user in the org with the os_system role (every module, org scope).
-- Created on first use for an org that has the OS product; returns null otherwise.
create or replace function os.system_user_id(p_org uuid) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := os.system_user_of(p_org);
  v_role uuid;
begin
  if p_org is null or not app.org_has_product(p_org, 'os') then return null; end if;
  if exists (select 1 from core.user_product_access a where a.user_id = v_uid and a.org_id = p_org
              and a.product_key = 'os' and a.role_key = 'os_system' and a.revoked_at is null) then
    return v_uid;
  end if;
  insert into auth.users (id, raw_user_meta_data) values (v_uid, jsonb_build_object('autoed_system', 'os', 'org_id', p_org))
  on conflict (id) do nothing;
  insert into core.org_users (org_id, user_id, kind, display_name, status)
  values (p_org, v_uid, 'staff', 'AutoEd OS automation', 'active') on conflict (user_id) do nothing;
  insert into core.roles (org_id, product_key, key, name) values (p_org, 'os', 'os_system', 'AutoEd OS automation')
  on conflict (org_id, product_key, key) do update set name = excluded.name returning id into v_role;
  insert into core.role_permissions (org_id, role_id, module_key, action, scope) values (p_org, v_role, '*', '*', 'org')
  on conflict (role_id, module_key, action) do nothing;
  insert into core.user_product_access (org_id, user_id, product_key, role_key) values (p_org, v_uid, 'os', 'os_system');
  return v_uid;
end $$;

-- Orgs that currently have the OS product, with their system actor (scheduler / job loop, plan 4.10).
create or replace function os.active_orgs() returns table (org_id uuid, system_user_id uuid)
language sql volatile security definer set search_path = '' as $$
  select o.id, os.system_user_id(o.id) from core.organizations o
   where o.status = 'active' and app.org_has_product(o.id, 'os') order by o.created_at
$$;

-- Dev / test login by email (the API refuses it unless AUTH_PROVIDER=dev): an active OS staff login or a
-- platform admin. Not granted to `authenticated`.
create or replace function os.dev_login_user(p_email text) returns uuid
language sql stable security definer set search_path = '' as $$
  select u.id from auth.users u
   where lower(u.email) = lower(p_email)
     and (exists (select 1 from core.staff s where s.user_id = u.id and s.deleted_at is null and s.status in ('active','invited','on_notice'))
          or exists (select 1 from core.platform_admins p where p.user_id = u.id and p.active))
   limit 1
$$;

-- Links a login to a staff member being created by an OS user with staff.create (or the system actor), in the
-- caller's org. Creates the auth user for the email/phone if it does not exist (invite; Supabase Auth sends the
-- OTP later). Returns the auth user id.
create or replace function os.ensure_staff_login(p_email text, p_phone text, p_name text, p_branch uuid) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  v_uid uuid;
begin
  if v_org is null or not (os.is_system() or os.check_perm(auth.uid(), 'staff', 'create', v_org, p_branch, null, null, null)) then
    raise exception 'staff.create required' using errcode = '42501';
  end if;
  if p_email is null and p_phone is null then return null; end if;
  select u.id into v_uid from auth.users u
   where (p_email is not null and lower(u.email) = lower(p_email)) or (p_phone is not null and u.phone = p_phone) limit 1;
  if v_uid is null then
    insert into auth.users (email, phone) values (lower(p_email), p_phone) returning id into v_uid;
  end if;
  if exists (select 1 from core.org_users x where x.user_id = v_uid and x.org_id <> v_org) then
    raise exception 'this login already belongs to another organisation (decision 37)' using errcode = '23505';
  end if;
  insert into core.org_users (org_id, user_id, kind, display_name, home_branch_id)
  values (v_org, v_uid, 'staff', coalesce(p_name, p_email, p_phone), p_branch)
  on conflict (user_id) do update set display_name = excluded.display_name, home_branch_id = excluded.home_branch_id;
  return v_uid;
end $$;

-- Extra branches of a staff login (was public.staff_branch_access; now core.user_branch_access).
create or replace function os.set_staff_branches(p_staff uuid, p_branches uuid[]) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  st core.staff;
begin
  select * into st from core.staff where id = p_staff and org_id = app.current_org_id();
  if st.id is null or not (os.is_system() or os.check_perm(auth.uid(), 'staff', 'edit', st.org_id, st.branch_id, st.id, st.department_id, st.wing_id)) then
    raise exception 'staff.edit required' using errcode = '42501';
  end if;
  if st.user_id is null then return; end if;
  delete from core.user_branch_access where user_id = st.user_id and not (branch_id = any(coalesce(p_branches, '{}')));
  insert into core.user_branch_access (org_id, user_id, branch_id)
  select st.org_id, st.user_id, b from unnest(coalesce(p_branches, '{}')) b
   where exists (select 1 from core.branches x where x.id = b and x.org_id = st.org_id)
  on conflict (user_id, branch_id) do nothing;
end $$;

-- Re-sync after a change to OS roles (statement level: one rebuild per org per statement).
create or replace function os.trg_sync_access() returns trigger
language plpgsql security definer set search_path = '' as $$
declare o uuid;
begin
  for o in select distinct x.org_id from (
             select n.org_id from new_rows n union all select d.org_id from old_rows d) x loop
    perform os.sync_access(o);
  end loop;
  return null;
end $$;

create or replace function os.trg_sync_access_ins() returns trigger
language plpgsql security definer set search_path = '' as $$
declare o uuid;
begin
  for o in select distinct n.org_id from new_rows n loop perform os.sync_access(o); end loop;
  return null;
end $$;

create or replace function os.trg_sync_access_del() returns trigger
language plpgsql security definer set search_path = '' as $$
declare o uuid;
begin
  for o in select distinct d.org_id from old_rows d loop perform os.sync_access(o); end loop;
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array['staff_roles','role_permissions','roles'] loop
    execute format('create trigger trg_sync_ins after insert on os.%I referencing new table as new_rows for each statement execute function os.trg_sync_access_ins()', t);
    execute format('create trigger trg_sync_upd after update on os.%I referencing new table as new_rows old table as old_rows for each statement execute function os.trg_sync_access()', t);
    execute format('create trigger trg_sync_del after delete on os.%I referencing old table as old_rows for each statement execute function os.trg_sync_access_del()', t);
  end loop;
end $$;
