-- ERP portal: a guardian's own message choices (WhatsApp, SMS, e-mail; service and promotional) on the consent ledger.
--
-- The ledger (core.consent_events) is written through app.compliance_record_consent, and the `app` schema is not on the Data API,
-- so the portal reaches it through these two wrappers. Each acts only for the caller's own guardian row (core.guardians.user_id),
-- using the phone or e-mail the school holds for that guardian; it cannot set a choice for anyone else.

create or replace function erp.portal_consents() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  g core.guardians;
  v_out jsonb := '{}'::jsonb;
  ch text;
  pu text;
  v_contact text;
begin
  if v_org is null or app.my_member_kind() not in ('guardian', 'parent') then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into g from core.guardians x where x.org_id = v_org and x.user_id = app.uid() and x.deleted_at is null limit 1;
  if not found then return v_out; end if;
  foreach ch in array array['whatsapp', 'sms', 'email'] loop
    v_contact := case when ch = 'email' then g.email else g.phone end;
    if v_contact is null or btrim(v_contact) = '' then continue; end if;
    v_out := v_out || jsonb_build_object(ch, '{}'::jsonb);
    foreach pu in array array['service', 'promotional'] loop
      v_out := jsonb_set(v_out, array[ch, pu], to_jsonb(app.compliance_consent_status(v_org, ch, v_contact, pu)), true);
    end loop;
  end loop;
  return v_out;
end $$;

create or replace function erp.portal_set_consent(p_channel text, p_purpose text, p_status text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  g core.guardians;
  v_contact text;
begin
  if v_org is null or app.my_member_kind() not in ('guardian', 'parent') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_channel not in ('whatsapp', 'sms', 'email') or p_purpose not in ('service', 'promotional') or p_status not in ('opted_in', 'opted_out') then
    raise exception 'unknown choice' using errcode = '22023';
  end if;
  select * into g from core.guardians x where x.org_id = v_org and x.user_id = app.uid() and x.deleted_at is null limit 1;
  if not found then raise exception 'Your login is not linked to a guardian record. Ask the school office.' using errcode = '22023'; end if;
  v_contact := case when p_channel = 'email' then g.email else g.phone end;
  if v_contact is null or btrim(v_contact) = '' then raise exception 'The school has no number or address on file for this.' using errcode = '22023'; end if;
  return app.compliance_record_consent(v_org, p_channel, v_contact, p_purpose, p_status, 'portal', 'guardian', g.id, '{}'::jsonb, g.id, g.relation);
end $$;

revoke execute on function erp.portal_consents(), erp.portal_set_consent(text, text, text) from public;
grant execute on function erp.portal_consents(), erp.portal_set_consent(text, text, text) to authenticated, erp_server, service_role;
