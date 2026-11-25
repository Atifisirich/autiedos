-- AI school designer for CRM and ERP (docs/designer.md, DECISIONS 56-58). Additive; no earlier migration is edited.
--
-- 1. erp.approval_rules: who approves an ERP request, configurable ("fee concession above 10% needs director approval").
--    The ERP engine (erp.submit_approval, 20261118100001_erp_ui_approvals.sql) had its chains hard-coded (principal; accounts
--    then principal for purchases from Rs 25,000). It now takes the first active rule of the request type whose thresholds
--    the request passes (amount above min_amount, a percent concession above min_percent), else the same defaults as before.
--    The ERP's own "Approval rules" link (/erp/x/approval_rules) and the designer block erp.approval_rule write this table.
-- 2. crm.workflows.stop_rules: the stop rules of a CRM workflow (stop waiting steps when the parent replies / when the record
--    leaves the stage it entered in). Both were always on in the engine; now a workflow can say so explicitly. Default: both on.

-- ---------------------------------------------------------------- 1. ERP approval rules
create table erp.approval_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default app.current_org_id() references core.organizations(id) on delete cascade,
  key text not null check (key ~ '^[a-z][a-z0-9_]*$'),
  name text not null,
  approval_type text not null check (approval_type ~ '^[a-z][a-z0-9_]*$'),
  min_amount numeric(14,2) check (min_amount is null or min_amount >= 0),
  min_percent numeric(5,2) check (min_percent is null or (min_percent >= 0 and min_percent <= 100)),
  steps jsonb not null default '[]'::jsonb check (jsonb_typeof(steps) = 'array'),
  seq integer not null default 1,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid default app.uid(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (org_id, id),
  unique (org_id, key)
);
create index approval_rules_type on erp.approval_rules(org_id, approval_type);
create trigger trg_touch before update on erp.approval_rules for each row execute function app.touch_updated_at();
select app.apply_rls(p_schema => 'erp', p_table => 'approval_rules', p_kind => 'product', p_product => 'erp', p_module => 'setup');
comment on table erp.approval_rules is 'erp product data: approval chains per request type and threshold (read by erp.submit_approval). module: setup';

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
  v_percent numeric;
begin
  if v_org is null or not app.user_has_product(v_org, 'erp') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_type !~ '^[a-z][a-z0-9_]*$' then raise exception 'bad approval type' using errcode = '22023'; end if;
  if v_kind is distinct from 'staff' then
    -- families may only raise a gate pass for their own child
    if p_type <> 'gate_pass' or p_student is null or not (p_student = any(app.my_learner_ids())) then raise exception 'not allowed' using errcode = '42501'; end if;
  end if;
  -- A configured rule wins (erp.approval_rules, set on the rules screen or by the AI designer): the first active rule of this
  -- type, by seq, whose thresholds the request passes ("concessions above 10% need the group admin").
  if p_type = 'concession' and p_object is not null then
    select case when c.kind = 'percent' then c.value end into v_percent from erp.concessions c where c.id = p_object and c.org_id = v_org;
  end if;
  v_percent := coalesce(v_percent, nullif(p_payload->>'percent', '')::numeric);
  select r.steps into v_steps from erp.approval_rules r
   where r.org_id = v_org and r.approval_type = p_type and r.active and r.deleted_at is null and jsonb_array_length(r.steps) > 0
     and (r.min_amount is null or coalesce(p_amount, 0) > r.min_amount)
     and (r.min_percent is null or coalesce(v_percent, 0) > r.min_percent)
   order by r.seq, coalesce(r.min_percent, 0) desc, coalesce(r.min_amount, 0) desc, r.created_at
   limit 1;
  v_steps := coalesce(v_steps, case
    when p_type = 'gate_pass' then '["class_teacher"]'::jsonb
    when p_type = 'attendance_regularisation' then '["hr"]'::jsonb
    when p_type in ('expense', 'purchase_request', 'purchase_order') and coalesce(p_amount, 0) >= 25000 then '["accounts", "principal"]'::jsonb
    else '["principal"]'::jsonb end);
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

-- ---------------------------------------------------------------- 2. CRM workflow stop rules
alter table crm.workflows add column if not exists stop_rules jsonb not null default '{"on_reply": true, "on_stage_change": true}'::jsonb;

-- ---------------------------------------------------------------- 3. designer AI calls of a school without the OS
-- Every OS AI feature books its core.ai_generations row as the org's OS system actor. A CRM- or ERP-only school has no
-- such actor, and its managers hold no "ai" permission, so the designer books its planner call through this narrow
-- function instead: only the action designer_plan, only for the caller's own org, only for someone app.designer_allowed
-- lets write (management or a read-write support session), and the row names the caller. The wallet charge is the
-- existing app.ai_charge (security definer, once per generation).
create or replace function app.designer_log_generation(p_row jsonb) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  v_id uuid;
begin
  if v_org is null or not app.designer_allowed(v_org, true) then raise exception 'designer only' using errcode = '42501'; end if;
  if p_row->>'action' is distinct from 'designer_plan' then raise exception 'designer_plan only' using errcode = '42501'; end if;
  if (p_row->>'product_key') not in ('os', 'crm', 'erp') or not app.user_has_product(v_org, p_row->>'product_key') then raise exception 'product not available' using errcode = '42501'; end if;
  insert into core.ai_generations (org_id, branch_id, product_key, user_id, staff_id, action, model, provider, input, output, status, attempts,
                                   input_tokens, output_tokens, provider_cost, credits, error, linked_type, linked_id)
  values (v_org, nullif(p_row->>'branch_id', '')::uuid, p_row->>'product_key', app.uid(),
          (select s.id from core.staff s where s.user_id = app.uid() and s.org_id = v_org and s.deleted_at is null limit 1),
          'designer_plan', coalesce(p_row->>'model', ''), coalesce(p_row->>'provider', ''), coalesce(p_row->'input', '{}'::jsonb), p_row->'output',
          coalesce(p_row->>'status', 'ok'), coalesce((p_row->>'attempts')::int, 1), coalesce((p_row->>'input_tokens')::int, 0), coalesce((p_row->>'output_tokens')::int, 0),
          coalesce((p_row->>'provider_cost')::numeric, 0), coalesce((p_row->>'credits')::numeric, 0), p_row->>'error', p_row->>'linked_type', nullif(p_row->>'linked_id', '')::uuid)
  returning id into v_id;
  return v_id;
end $$;
revoke execute on function app.designer_log_generation(jsonb) from public;
grant execute on function app.designer_log_generation(jsonb) to crm_server, os_server, erp_server;

-- ---------------------------------------------------------------- 4. designer history readable by CRM / ERP management
-- The read policy of the designer tables (20261127100001_core_designer.sql) asked for setup.view in some product AND
-- app.designer_allowed. The CRM's role matrix grants its group admin setup configure / create / edit / delete but no
-- setup "view" row, so a CRM school's management could write a changeset but not read it back (an insert ... returning
-- failed). app.designer_allowed alone is the rule the designer is built on (management: setup.configure at branch scope or
-- wider in any product, or an open support session) and is stricter than setup.view, so it becomes the read rule.
do $$
declare t text;
begin
  foreach t in array array['design_changesets', 'design_changeset_items'] loop
    execute format('drop policy sel on core.%I', t);
    execute format('create policy sel on core.%I for select using (org_id = app.current_org_id() and app.user_has_any_product(org_id) and app.designer_allowed(org_id, false))', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- 5. support sessions of AutoEd staff in product permission checks
-- app.can and crm.scope_of treat a caller who is not an active member as a support session (user_has_product only lets
-- such a caller through inside an open session). They tested membership of ANY org, but AutoEd relationship managers are
-- members of the AutoEd org (decision 54), so inside a read-write support session for a school they fell through to the
-- role check of the school and were refused every CRM / ERP write (an OS-only path had hidden it). The membership test is
-- now for the org being checked; nothing changes for a school's own staff.
create or replace function app.can(p_product text, p_module text, p_action text, p_org uuid,
  p_branch uuid default null, p_owner uuid default null) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_rank integer;
begin
  if auth.uid() is null or p_org is null then return false; end if;
  if not app.user_has_product(p_org, p_product) then return false; end if;
  if p_branch is not null and not app.branch_has_product(p_org, p_branch, p_product) then return false; end if;

  if not exists (select 1 from core.org_users u where u.user_id = auth.uid() and u.org_id = p_org and u.status = 'active') then
    -- only a support session reaches here (user_has_product passed)
    return p_action = 'view'
        or exists (select 1 from core.support_sessions s where s.id = app.support_session_id() and not s.read_only);
  end if;

  select max(case rp.scope when 'own' then 1 when 'branch' then 2 when 'org' then 3 end) into v_rank
  from core.org_users u
  join core.user_product_access a on a.user_id = u.user_id and a.org_id = u.org_id
       and a.product_key = p_product and a.revoked_at is null
  join core.roles r on r.org_id = a.org_id and r.product_key = a.product_key and r.key = a.role_key
  join core.role_permissions rp on rp.role_id = r.id
  where u.user_id = auth.uid() and u.org_id = p_org and u.kind = 'staff' and u.status = 'active'
    and rp.module_key in (p_module, '*') and rp.action in (p_action, '*');

  if v_rank is null then return false; end if;
  if v_rank = 3 then return true; end if;
  if p_branch is not null and not (p_branch = any(app.user_branch_ids())) then return false; end if;
  if v_rank = 2 then return true; end if;
  return p_owner is not null and p_owner = auth.uid();
end $$;

create or replace function crm.scope_of(p_module text, p_action text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  v_rank integer;
begin
  if auth.uid() is null or v_org is null or not app.user_has_product(v_org, 'crm') then return null; end if;
  if not exists (select 1 from core.org_users u where u.user_id = auth.uid() and u.org_id = v_org and u.status = 'active') then
    -- only a support session reaches here (user_has_product passed)
    return case when p_action = 'view' or exists (select 1 from core.support_sessions s where s.id = app.support_session_id() and not s.read_only) then 'org' end;
  end if;
  select max(case rp.scope when 'own' then 1 when 'branch' then 2 when 'org' then 3 end) into v_rank
  from core.org_users u
  join core.user_product_access a on a.user_id = u.user_id and a.org_id = u.org_id and a.product_key = 'crm' and a.revoked_at is null
  join core.roles r on r.org_id = a.org_id and r.product_key = a.product_key and r.key = a.role_key
  join core.role_permissions rp on rp.role_id = r.id
  where u.user_id = auth.uid() and u.org_id = v_org and u.kind = 'staff' and u.status = 'active'
    and rp.module_key in (p_module, '*') and rp.action in (p_action, '*');
  return case v_rank when 3 then 'org' when 2 then 'branch' when 1 then 'own' end;
end $$;
