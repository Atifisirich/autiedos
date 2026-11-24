-- ERP staff UI: export log.
-- The source ERP wrote every CSV export to export_log (PRV-04). docs/erp-port.md lists audit.export_log as owned by the compliance stream and it
-- does not exist yet, so exports are written to audit.log (action 'erp.export') through this function, the same way erp.log_view logs views.
-- Readable by users holding audit.view, like the rest of audit.log.

create or replace function erp.log_export(p_report text, p_rows integer, p_detail jsonb default '{}') returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
begin
  if v_org is null or not app.user_has_product(v_org, 'erp') or app.my_member_kind() is distinct from 'staff' then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  insert into audit.log (org_id, actor_user_id, support_session_id, action, schema_name, table_name, detail)
  values (v_org, app.uid(), app.support_session_id(), 'erp.export', 'erp', null, jsonb_build_object('report', left(p_report, 200), 'rows', p_rows) || coalesce(p_detail, '{}'));
end $$;

revoke execute on function erp.log_export(text, integer, jsonb) from public;
grant execute on function erp.log_export(text, integer, jsonb) to authenticated, erp_server, service_role;
