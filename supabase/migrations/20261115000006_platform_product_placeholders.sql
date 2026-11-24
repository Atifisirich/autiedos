-- AutoEd platform foundation (6/6): isolation-harness probe tables in crm, os, erp; function grants.
--
-- crm.harness_probe, os.harness_probe and erp.harness_probe exist ONLY so the isolation harness
-- (packages/server/test-platform) can prove product isolation before real product tables arrive. They hold
-- no product data. Drop them when the first real table of each product exists and the harness covers it.

do $$
declare s text;
begin
  foreach s in array array['crm','os','erp'] loop
    execute format($f$
      create table %1$I.harness_probe (
        id uuid primary key default gen_random_uuid(),
        org_id uuid not null references core.organizations(id) on delete cascade,
        branch_id uuid,
        owner_id uuid,
        title text not null,
        created_at timestamptz not null default now(),
        foreign key (org_id, branch_id) references core.branches(org_id, id) on delete cascade
      )$f$, s);
    execute format('create index harness_probe_org on %I.harness_probe(org_id)', s);
    perform app.apply_rls(s, 'harness_probe', 'product', s, 'harness');
  end loop;
end $$;

-- ---------------------------------------------------------------- function execute grants
-- Postgres lets PUBLIC execute every new function; take that away in the platform schemas and grant
-- explicitly. anon gets nothing.
revoke execute on all functions in schema app, private from public;

grant execute on all functions in schema app
  to authenticated, service_role, crm_server, os_server, erp_server, platform_admin_server, job_runner;

-- DDL helpers and trigger functions are for migrations only.
revoke execute on function app.apply_rls(text, text, text, text, text), app.drop_policies(text, text),
  app.enable_audit(text, text, boolean), app.platform_audit_row(), app.platform_config_history_row()
  from authenticated, crm_server, os_server, erp_server, platform_admin_server, job_runner;

-- Login bookkeeping is done by servers, never by the signed-in user.
revoke execute on function app.record_login_event(uuid, text, boolean, text, inet, text) from authenticated, job_runner;

-- The job runner reaches private only through these.
grant execute on function private.claim_jobs(text, text, integer), private.finish_job(uuid, boolean, text)
  to job_runner, service_role;
