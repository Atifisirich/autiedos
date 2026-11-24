-- LOCAL ONLY. Recreates the parts of the Supabase platform that migrations rely on
-- (roles, auth.uid(), storage schema) so migrations and RLS tests run on plain Postgres.
-- Never apply this file to a Supabase project: Supabase already provides these objects.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
end $$;

grant anon, authenticated, service_role to current_user;

create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  phone text unique,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), auth.jwt() ->> 'sub'), '')::uuid
$$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), auth.jwt() ->> 'role')
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant select on auth.users to service_role;

create schema if not exists storage;
create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text not null,
  owner uuid,
  metadata jsonb,
  created_at timestamptz not null default now()
);
alter table storage.objects enable row level security;
create or replace function storage.foldername(name text) returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]
$$;
grant usage on schema storage to anon, authenticated, service_role;
grant select, insert, update, delete on storage.objects to authenticated, service_role;
grant select on storage.buckets to authenticated, service_role;

-- Local password store for AUTH_PROVIDER=dev (docs/adr/shell-and-login.md). On Supabase, GoTrue keeps password
-- hashes in auth.users and the server talks to the Auth API instead; these objects never exist there. The hash
-- format is the dev provider's own (scrypt). Execute is granted to the product server roles by the migration
-- 20261126000001_platform_shell_login.sql only when these functions exist (i.e. locally).
create table if not exists auth.dev_passwords (
  user_id uuid primary key references auth.users(id) on delete cascade,
  hash text not null,
  updated_at timestamptz not null default now()
);
create or replace function auth.dev_password_hash(p_user uuid) returns text
language sql stable security definer set search_path = '' as $$
  select hash from auth.dev_passwords where user_id = p_user
$$;
create or replace function auth.dev_set_password(p_user uuid, p_hash text) returns void
language sql volatile security definer set search_path = '' as $$
  insert into auth.dev_passwords (user_id, hash) values (p_user, p_hash)
  on conflict (user_id) do update set hash = excluded.hash, updated_at = now()
$$;
revoke execute on function auth.dev_password_hash(uuid), auth.dev_set_password(uuid, text) from public, anon, authenticated;
