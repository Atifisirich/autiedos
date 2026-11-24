-- ERP staff UI: a small approvals engine on core.approval_requests.
-- The source ERP decided approvals in its own tables (submit_approval, decide_approval, my_approvals). On the platform the request
-- rows are core.approval_requests, but no function creates or decides them for the ERP (the OS keeps its own engine on legacy tables),
-- and a principal holds only "view" on approvals, so the Data API alone cannot let them decide. These three functions are the ERP's
-- engine: submit (chain of ERP role keys in data->'steps'), decide (advance or finish, then erp.apply_approval) and the "my approvals" list.
-- Nothing here edits an existing migration.

create or replace function erp.my_erp_role() returns text
language sql stable security definer set search_path = '' as $$
  select a.role_key from core.user_product_access a
   where a.user_id = app.uid() and a.org_id = app.current_org_id() and a.product_key = 'erp' and a.revoked_at is null limit 1
$$;

-- May the caller decide this request now? group_admin always; otherwise the holder of the current step's role (never the applicant).
create or replace function erp.can_decide_approval(a core.approval_requests) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_role text := erp.my_erp_role();
  v_step text := a.data->'steps'->>(a.current_seq - 1);
begin
  if a.status <> 'pending' or a.org_id is distinct from app.current_org_id() or not app.user_has_product(a.org_id, 'erp')
     or app.my_member_kind() is distinct from 'staff' or v_role is null then return false; end if;
  if a.branch_id is not null and not (a.branch_id = any(app.user_branch_ids())) then return false; end if;
  if v_role = 'group_admin' then return true; end if;
  if a.applicant_user_id is not distinct from app.uid() then return false; end if;
  if v_step is null or v_step <> v_role then return false; end if;
  if v_step = 'class_teacher' and a.student_id is not null then
    return exists (select 1 from core.students s join core.sections sec on sec.id = s.section_id and sec.org_id = s.org_id
                    where s.id = a.student_id and s.org_id = a.org_id and sec.class_teacher_id = app.my_core_staff_id());
  end if;
  return true;
end $$;

create or replace function erp.my_approvals() returns setof core.approval_requests
language sql stable security definer set search_path = '' as $$
  select r.* from core.approval_requests r
   where r.org_id = app.current_org_id() and r.product_key = 'erp' and r.status = 'pending' and r.deleted_at is null and erp.can_decide_approval(r)
   order by r.created_at
$$;

-- Create a request for an object of the ERP (concession, refund, receipt_reversal, expense, purchase_request, purchase_order,
-- gate_pass, marks_unlock, gallery, announcement). The chain is a list of ERP role keys; the default is the principal.
create or replace function erp.submit_approval(p_type text, p_object uuid, p_title text, p_summary text default null, p_amount numeric default null,
  p_payload jsonb default '{}', p_student uuid default null, p_impact text default null) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  v_kind text := app.my_member_kind();
  v_steps jsonb;
  v_type uuid;
  v_id uuid;
  v_staff uuid := app.my_core_staff_id();
  v_branch uuid;
  v_name text;
begin
  if v_org is null or not app.user_has_product(v_org, 'erp') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_type !~ '^[a-z][a-z0-9_]*$' then raise exception 'bad approval type' using errcode = '22023'; end if;
  if v_kind is distinct from 'staff' then
    -- families may only raise a gate pass for their own child
    if p_type <> 'gate_pass' or p_student is null or not (p_student = any(app.my_learner_ids())) then raise exception 'not allowed' using errcode = '42501'; end if;
  end if;
  v_steps := case
    when p_type = 'gate_pass' then '["class_teacher"]'::jsonb
    when p_type in ('expense', 'purchase_request', 'purchase_order') and coalesce(p_amount, 0) >= 25000 then '["accounts", "principal"]'::jsonb
    else '["principal"]'::jsonb end;
  insert into core.approval_types (org_id, key, name, product_key, is_system)
  values (v_org, p_type, initcap(replace(p_type, '_', ' ')), 'erp', true)
  on conflict (org_id, key) do nothing;
  select id into v_type from core.approval_types where org_id = v_org and key = p_type;
  select coalesce((select s.branch_id from core.students s where s.id = p_student and s.org_id = v_org), (select u.home_branch_id from core.org_users u where u.user_id = app.uid() and u.org_id = v_org)) into v_branch;
  select u.display_name into v_name from core.org_users u where u.user_id = app.uid() and u.org_id = v_org;
  insert into core.approval_requests (org_id, branch_id, approval_type_id, product_key, applicant_user_id, applicant_staff_id, requested_by_name, title, summary, impact, data, amount, student_id,
                                      status, current_seq, pending_approver_ids, step_due_at, linked_type, linked_id)
  values (v_org, v_branch, v_type, 'erp', app.uid(), v_staff, v_name, p_title, p_summary, p_impact, coalesce(p_payload, '{}') || jsonb_build_object('steps', v_steps), p_amount, p_student,
          'pending', 1, '{}', now() + interval '24 hours', p_type, p_object)
  returning id into v_id;
  -- the approvers of the first step, so they see it under "pending on me" through the core read policy
  update core.approval_requests r set pending_approver_ids = coalesce((
    select array_agg(distinct s.id) from core.staff s
      join core.user_product_access a on a.org_id = s.org_id and a.user_id = s.user_id and a.product_key = 'erp' and a.revoked_at is null
     where s.org_id = v_org and s.deleted_at is null and a.role_key = (v_steps->>0)), '{}')
   where r.id = v_id;
  insert into core.approval_actions (org_id, request_id, step_seq, actor_user_id, actor_staff_id, actor_name, action) values (v_org, v_id, 0, app.uid(), v_staff, v_name, 'submit');
  perform erp.notify_roles(v_org, array[v_steps->>0, 'group_admin'], v_branch, 'approval.pending', 'Approval needed: ' || p_title, p_summary, '/erp/approvals');
  return v_id;
end $$;

-- Approve or reject the current step. The last approval (or any rejection) finishes the request and applies it to the object.
create or replace function erp.decide_approval(p_request uuid, p_ok boolean, p_comment text default null) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  a core.approval_requests;
  v_staff uuid := app.my_core_staff_id();
  v_name text;
  v_steps int;
  v_result text;
begin
  if v_org is null or not app.user_has_product(v_org, 'erp') then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into a from core.approval_requests r where r.id = p_request and r.org_id = v_org and r.product_key = 'erp' for update;
  if not found then raise exception 'approval not found' using errcode = '22023'; end if;
  if not erp.can_decide_approval(a) then raise exception 'you cannot decide this request' using errcode = '42501'; end if;
  select u.display_name into v_name from core.org_users u where u.user_id = app.uid() and u.org_id = v_org;
  insert into core.approval_actions (org_id, request_id, step_seq, actor_user_id, actor_staff_id, actor_name, action, comment)
  values (v_org, a.id, a.current_seq, app.uid(), v_staff, v_name, case when p_ok then 'approve' else 'reject' end, p_comment);
  v_steps := coalesce(jsonb_array_length(a.data->'steps'), 1);
  if p_ok and a.current_seq < v_steps then
    update core.approval_requests r set current_seq = a.current_seq + 1, step_due_at = now() + interval '24 hours',
      pending_approver_ids = coalesce((
        select array_agg(distinct s.id) from core.staff s
          join core.user_product_access x on x.org_id = s.org_id and x.user_id = s.user_id and x.product_key = 'erp' and x.revoked_at is null
         where s.org_id = v_org and s.deleted_at is null and x.role_key = (a.data->'steps'->>a.current_seq)), '{}')
     where r.id = a.id;
    perform erp.notify_roles(v_org, array[a.data->'steps'->>a.current_seq, 'group_admin'], a.branch_id, 'approval.pending', 'Approval needed: ' || a.title, a.summary, '/erp/approvals');
    return 'pending';
  end if;
  update core.approval_requests r set status = case when p_ok then 'approved' else 'rejected' end, decided_at = now(), pending_approver_ids = '{}' where r.id = a.id;
  v_result := erp.apply_approval(a.id);
  perform erp.notify_user(v_org, a.applicant_user_id, 'approval.decided', a.title || (case when p_ok then ' was approved' else ' was rejected' end), p_comment, '/erp/approvals');
  return case when p_ok then 'approved' else 'rejected' end;
end $$;

-- The applicant withdraws a pending request.
create or replace function erp.cancel_approval(p_request uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
begin
  if v_org is null or not app.user_has_product(v_org, 'erp') then raise exception 'not allowed' using errcode = '42501'; end if;
  update core.approval_requests r set status = 'cancelled', decided_at = now(), pending_approver_ids = '{}'
   where r.id = p_request and r.org_id = v_org and r.product_key = 'erp' and r.status = 'pending' and r.applicant_user_id = app.uid();
  if not found then raise exception 'nothing to cancel' using errcode = '22023'; end if;
  insert into core.approval_actions (org_id, request_id, step_seq, actor_user_id, action) values (v_org, p_request, 0, app.uid(), 'cancel');
end $$;

revoke execute on function erp.my_erp_role(), erp.can_decide_approval(core.approval_requests), erp.my_approvals(), erp.submit_approval(text, uuid, text, text, numeric, jsonb, uuid, text),
  erp.decide_approval(uuid, boolean, text), erp.cancel_approval(uuid) from public;
grant execute on function erp.my_erp_role(), erp.can_decide_approval(core.approval_requests), erp.my_approvals(), erp.submit_approval(text, uuid, text, text, numeric, jsonb, uuid, text),
  erp.decide_approval(uuid, boolean, text), erp.cancel_approval(uuid) to authenticated, erp_server, service_role;
