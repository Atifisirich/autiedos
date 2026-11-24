-- AutoEd platform foundation (1/6): extensions, schemas, database roles, schema-level grants.
-- See docs/platform-foundation.md and docs/adr/001..005.
--
-- Schemas
--   core     tenants, identity, entitlements, shared master data          (all product servers)
--   app      security helper functions only, no tables                    (executed by policies)
--   audit    audit.log, audit.config_history                              (insert by triggers only)
--   billing  plans, invoices (GST), payments (Razorpay), usage            (platform admin server)
--   private  job queue, rate limits, webhook inbox. NEVER exposed          (security definer functions only)
--   crm/os/erp  product tables                                            (own product server only)
--
-- Roles (cluster-wide in Postgres, so every create is idempotent; passwords are set out of band,
-- never in a migration). Product server roles are NOT members of `authenticated`: they run each
-- request as themselves with request.jwt.claims set, so a missing schema grant cannot be bypassed
-- with `set role authenticated`.

create extension if not exists pgcrypto;

create schema if not exists core;
create schema if not exists app;
create schema if not exists audit;
create schema if not exists billing;
create schema if not exists private;
create schema if not exists crm;
create schema if not exists os;
create schema if not exists erp;

do $$
declare r text;
begin
  -- Supabase provides these three; the local shim creates them too. Kept here so the file is self-contained.
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
  foreach r in array array['crm_server','os_server','erp_server','platform_admin_server','job_runner'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I login noinherit nobypassrls nocreatedb nocreaterole', r);
    end if;
  end loop;
end $$;

-- Noisy-neighbour guard (plan section 11): request roles are short, the job role longer.
alter role crm_server set statement_timeout = '15s';
alter role os_server set statement_timeout = '15s';
alter role erp_server set statement_timeout = '15s';
alter role platform_admin_server set statement_timeout = '30s';
alter role job_runner set statement_timeout = '120s';

-- Nobody gets anything by default on the new schemas.
revoke all on schema core, app, audit, billing, private, crm, os, erp from public;

-- Schema usage (plan 4.3 layer 2). anon gets nothing. private is reachable only by job_runner
-- (and only through security definer functions, because its tables have RLS and no policies).
grant usage on schema core to authenticated, service_role, crm_server, os_server, erp_server, platform_admin_server, job_runner;
grant usage on schema app  to authenticated, service_role, crm_server, os_server, erp_server, platform_admin_server, job_runner;
grant usage on schema crm  to authenticated, service_role, crm_server;
grant usage on schema os   to authenticated, service_role, os_server;
grant usage on schema erp  to authenticated, service_role, erp_server;
grant usage on schema audit   to authenticated, service_role, platform_admin_server;
grant usage on schema billing to authenticated, service_role, platform_admin_server;
grant usage on schema private to service_role, job_runner;

-- Tables created later in a product schema are granted to that product's roles automatically;
-- RLS (applied by app.apply_rls, enforced by harness test T7) decides which rows they reach.
alter default privileges in schema crm grant select, insert, update, delete on tables to authenticated, crm_server;
alter default privileges in schema os  grant select, insert, update, delete on tables to authenticated, os_server;
alter default privileges in schema erp grant select, insert, update, delete on tables to authenticated, erp_server;
alter default privileges in schema crm grant all on tables to service_role;
alter default privileges in schema os  grant all on tables to service_role;
alter default privileges in schema erp grant all on tables to service_role;
alter default privileges in schema core grant all on tables to service_role;
alter default privileges in schema audit grant all on tables to service_role;
alter default privileges in schema billing grant all on tables to service_role;
alter default privileges in schema private grant all on tables to service_role;
-- Functions: Postgres grants EXECUTE to PUBLIC globally and that cannot be revoked per schema with
-- default privileges, so 20261115000006 revokes it explicitly after all functions exist.

-- updated_at maintenance (same body as the OS helper of the same name).
create or replace function app.touch_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;
