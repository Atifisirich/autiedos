-- Helpers used by column defaults, policies and guard triggers of the erp tables (created before the tables).
-- Source: the ERP's app.org_id()/branch_id()/immutable_financial()/guard_student_status() (001_core, 004_logic_core),
-- rewritten on the platform helpers. Every function pins search_path; none is executable by PUBLIC or anon (see grants).

-- Home branch of the signed-in user (column default of branch_id). Null = works at org level.
create or replace function erp.my_branch_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select u.home_branch_id from core.org_users u where u.user_id = app.uid() and u.status = 'active'
$$;

-- True when the statement runs directly as a request role. Inside a security definer function current_user is the
-- migration owner, so a request role cannot reach "function only" columns by setting a session value (core uses the same test).
create or replace function erp.is_request_role() returns boolean
language sql stable set search_path = '' as $$
  select current_user in ('authenticated','anon','crm_server','os_server','erp_server','platform_admin_server','job_runner')
$$;

-- Used by guards to tell "this row is deleted because its whole organisation is being deleted" from a plain delete.
create or replace function erp.org_exists(p_org uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  return exists (select 1 from core.organizations o where o.id = p_org);
end $$;

-- Routes the signed-in guardian/student travels on (bus tracking, route list). plpgsql: erp.student_transport comes later.
create or replace function erp.my_route_ids() returns uuid[]
language plpgsql stable security definer set search_path = '' as $$
begin
  return (select coalesce(array_agg(distinct st.route_id), '{}'::uuid[]) from erp.student_transport st
           where st.org_id = app.current_org_id() and st.active and st.deleted_at is null
             and st.student_id = any(app.my_learner_ids()));
end $$;

-- Status of an assessment, readable by the marks guard whatever the caller may see.
create or replace function erp.assessment_status(p_org uuid, p_id uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
begin
  return (select a.status from erp.assessments a where a.org_id = p_org and a.id = p_id);
end $$;

-- ---------------------------------------------------------------- guard triggers
-- Money is never edited or deleted (DM-03). Arguments: columns anyone with edit rights may still change (e.g. cheque status),
-- columns only erp functions may change (receipts.status when a receipt is reversed). A whole-organisation delete cascades.
create or replace function erp.immutable_rows() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_mut text[] := string_to_array(coalesce(tg_argv[0], ''), ',');
  v_fn text[] := string_to_array(coalesce(tg_argv[1], ''), ',');
  v_k text;
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 and not erp.org_exists(old.org_id) then return old; end if;
    raise exception '% rows cannot be deleted; post a reversal instead', tg_table_name using errcode = '42501';
  end if;
  for v_k in
    select n.key from jsonb_each(to_jsonb(new) - 'updated_at') n where (to_jsonb(old) - 'updated_at') -> n.key is distinct from n.value
  loop
    if v_k = any(v_mut) then continue; end if;
    if v_k = any(v_fn) and not erp.is_request_role() then continue; end if;
    raise exception '% rows cannot be edited (column %); post a reversal instead', tg_table_name, v_k using errcode = '42501';
  end loop;
  return new;
end $$;

-- Numeric columns that only erp functions may change (fee_demands.paid, student_wallets.balance ...). Insert: must be zero.
create or replace function erp.fn_only_columns() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_cols text[] := string_to_array(coalesce(tg_argv[0], ''), ',');
  v_k text;
begin
  if not erp.is_request_role() then return new; end if;
  foreach v_k in array v_cols loop
    if tg_op = 'INSERT' then
      if coalesce((to_jsonb(new) ->> v_k)::numeric, 0) <> 0 then
        raise exception '%.% is set by the system, not by hand', tg_table_name, v_k using errcode = '42501';
      end if;
    elsif (to_jsonb(new) -> v_k) is distinct from (to_jsonb(old) -> v_k) then
      raise exception '%.% is changed only by the fee and wallet functions', tg_table_name, v_k using errcode = '42501';
    end if;
  end loop;
  return new;
end $$;

-- Marks lock after publication (DM-04): no insert/update/delete of results of a locked or published assessment by a
-- request role. Unlocking is an approved request (erp.apply_approval, type marks_unlock).
create or replace function erp.guard_marks() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_org uuid := case when tg_op = 'DELETE' then old.org_id else new.org_id end;
  v_assessment uuid := case when tg_op = 'DELETE' then old.assessment_id else new.assessment_id end;
begin
  if erp.is_request_role() and erp.assessment_status(v_org, v_assessment) in ('locked', 'published') then
    if tg_op = 'DELETE' and pg_trigger_depth() > 1 and not erp.org_exists(v_org) then return old; end if;
    raise exception 'Marks are locked after publication. Request an unlock with a reason.' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

-- Audit trigger for tables that hold restricted data: same row in audit.log, with the listed columns redacted.
create or replace function erp.audit_row_redacted() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_cols text[] := string_to_array(coalesce(tg_argv[0], ''), ',');
  v_old jsonb := case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end;
  v_k text;
  v_row jsonb;
begin
  foreach v_k in array v_cols loop
    if v_old ? v_k then v_old := jsonb_set(v_old, array[v_k], '"[redacted]"'); end if;
    if v_new ? v_k then v_new := jsonb_set(v_new, array[v_k], '"[redacted]"'); end if;
  end loop;
  if tg_op = 'UPDATE' and (v_old - 'updated_at') = (v_new - 'updated_at') then return null; end if;
  v_row := coalesce(v_new, v_old);
  insert into audit.log (org_id, branch_id, actor_user_id, support_session_id, action, schema_name, table_name, row_id, before, after)
  values (app.try_uuid(v_row->>'org_id'), app.try_uuid(v_row->>'branch_id'), app.uid(), app.support_session_id(),
          lower(tg_op), tg_table_schema, tg_table_name, app.try_uuid(v_row->>'id'), v_old, v_new);
  return null;
end $$;
