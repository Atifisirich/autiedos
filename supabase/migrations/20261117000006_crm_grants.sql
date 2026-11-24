-- AutoEd CRM port (6/6): function execute grants. Postgres grants EXECUTE to PUBLIC on every new function, so it is
-- taken away again for the schemas this stream added functions to and granted explicitly.

revoke execute on all functions in schema crm, core, private from public;

-- Called while RLS policies are evaluated (so by every role that can read crm tables) and by triggers.
grant execute on function crm.in_my_team(uuid, uuid), crm.scope_of(text, text), crm.disabled_branches(), crm.mask(), crm.role_rows(jsonb)
  to authenticated, crm_server, service_role;

-- CRM server (and users of the Data API with the CRM) - each function re-checks org, product and permission itself.
grant execute on function
  crm.sync_role_permissions(uuid, text),
  crm.set_field_sensitivity(text, boolean),
  crm.wallet_post(text, text, numeric, text, uuid),
  crm.next_number(text, uuid),
  crm.audit_event(text, text, text, text, jsonb, jsonb, text, text),
  crm.set_consent(uuid, text, boolean, text, text),
  crm.guardian_consents(uuid),
  crm.push_tokens(uuid)
  to authenticated, crm_server, service_role;

-- Pre-login lookups: only the CRM server (it decides which key it was handed) and the service role.
grant execute on function crm.system_actor(uuid), crm.resolve_public(text, text) to crm_server, service_role;

-- Onboarding: the platform console provisions the automation user (also done by the trigger on core.subscriptions).
grant execute on function crm.provision_org(uuid) to platform_admin_server, service_role;

-- Admission is a CRM action. OS and ERP servers cannot call it (and would be refused inside anyway).
grant execute on function core.admit_student(uuid) to crm_server, service_role;

-- Shared helpers for every product.
grant execute on function core.can_contact(text, uuid, text), core.student_primary_phone(uuid)
  to authenticated, crm_server, os_server, erp_server, service_role;
grant execute on function core.upsert_staff(uuid, text, text, text, text, uuid, text, text, text, text, uuid)
  to authenticated, crm_server, os_server, erp_server, service_role;

-- Recurring jobs: the worker role only.
grant execute on function private.enqueue_tick_jobs(text, text) to job_runner, service_role;

-- Migration-only helper and trigger functions: no request role.
revoke execute on function crm.apply_rls_scoped(text, text, text, text), crm.apply_rls_enquiries() from authenticated, crm_server, os_server, erp_server, platform_admin_server, job_runner;

grant select on crm.enquiries_full, crm.staff_v to authenticated, crm_server, service_role;
