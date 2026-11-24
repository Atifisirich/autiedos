-- Notification helpers, view logging, and the private gate-pass OTP table.
-- ERP notifications are rows of core.notifications (one inbox for all products; delivery by the outbox/job runner).

-- Gate pass OTPs live in private (decision: never exposed through the Data API; ERP gate_pass_secrets -> private.gate_pass_otps).
create table private.gate_pass_otps (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  pass_id uuid not null,
  student_id uuid not null,
  otp text not null check (otp ~ '^[0-9]{6}$'),
  created_at timestamptz not null default now(),
  unique (org_id, pass_id),
  foreign key (org_id, pass_id) references erp.gate_passes(org_id, id) on delete cascade,
  foreign key (org_id, student_id) references core.students(org_id, id) on delete cascade
);
create index gate_pass_otps_student on private.gate_pass_otps(org_id, student_id);
alter table private.gate_pass_otps enable row level security;
comment on table private.gate_pass_otps is 'OTP handed to the guardian for an approved gate pass. No policies: read only through erp.my_gate_pass_otp() and erp.verify_gate_pass().';

-- One notification for one user (no-op for a null user).
create or replace function erp.notify_user(p_org uuid, p_user uuid, p_event text, p_title text, p_body text default null, p_link text default null)
returns void language sql volatile security definer set search_path = '' as $$
  insert into core.notifications (org_id, user_id, product_key, event_key, title, body, link)
  select p_org, p_user, 'erp', p_event, p_title, p_body, p_link
  where p_user is not null and exists (select 1 from core.org_users u where u.org_id = p_org and u.user_id = p_user)
$$;

-- Every guardian with a login in the learner's household (and the learner's own login).
create or replace function erp.notify_guardians(p_student uuid, p_event text, p_title text, p_body text default null, p_link text default null)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare
  v_s core.students;
begin
  select * into v_s from core.students s where s.id = p_student;
  if not found then return; end if;
  insert into core.notifications (org_id, user_id, product_key, event_key, title, body, link)
  select v_s.org_id, g.user_id, 'erp', p_event, p_title, p_body, p_link
    from core.guardians g
   where g.org_id = v_s.org_id and g.household_id = v_s.household_id and g.user_id is not null and g.deleted_at is null;
end $$;

-- Every active user holding one of the given ERP roles (optionally within a branch).
create or replace function erp.notify_roles(p_org uuid, p_roles text[], p_branch uuid, p_event text, p_title text, p_body text default null, p_link text default null)
returns void language sql volatile security definer set search_path = '' as $$
  insert into core.notifications (org_id, user_id, product_key, event_key, title, body, link)
  select p_org, a.user_id, 'erp', p_event, p_title, p_body, p_link
    from core.user_product_access a
    join core.org_users u on u.org_id = a.org_id and u.user_id = a.user_id and u.status = 'active'
   where a.org_id = p_org and a.product_key = 'erp' and a.revoked_at is null and a.role_key = any(p_roles)
     and (p_branch is null or u.home_branch_id is null or u.home_branch_id = p_branch)
$$;

-- Every view of sensitive data is logged (DM-05). A free-text entity name is not accepted: it must be an erp table.
create or replace function erp.log_view(p_entity text, p_id uuid, p_note text default null) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
begin
  if v_org is null or not app.user_has_product(v_org, 'erp') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_entity is null or p_entity !~ '^[a-z_]+$' or to_regclass('erp.' || p_entity) is null then
    raise exception 'unknown entity' using errcode = '22023';
  end if;
  insert into audit.log (org_id, actor_user_id, support_session_id, action, schema_name, table_name, row_id, detail)
  values (v_org, app.uid(), app.support_session_id(), 'erp.view', 'erp', p_entity, p_id, jsonb_build_object('note', left(p_note, 500)));
end $$;
