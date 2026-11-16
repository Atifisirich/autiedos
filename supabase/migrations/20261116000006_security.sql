-- Security: permission function, RLS on every table, audit log, config history, storage.
-- has_permission() is the single source of truth used by RLS policies and the API (rule 9.1).

-- ---------------------------------------------------------------- identity helpers
create or replace function app.staff_of(p_uid uuid) returns public.staff
language sql stable security definer set search_path = public as $$
  select s.* from public.staff s
  where s.user_id = p_uid and s.deleted_at is null and s.status in ('active','invited')
  limit 1
$$;

create or replace function app.my_staff_id() returns uuid
language sql stable security definer set search_path = public as $$
  select (app.staff_of(auth.uid())).id
$$;

create or replace function app.my_org_id() returns uuid
language sql stable security definer set search_path = public as $$
  select (app.staff_of(auth.uid())).org_id
$$;

create or replace function app.is_super_admin(p_uid uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.platform_admins where user_id = p_uid and deleted_at is null)
$$;

-- Branches a user can see: home branch + granted branches; group-level staff (no home branch) see all.
create or replace function app.branch_ids_of(p_uid uuid) returns uuid[]
language sql stable security definer set search_path = public as $$
  with me as (select * from app.staff_of(p_uid))
  select coalesce(array_agg(distinct b.id), '{}')
  from public.branches b, me
  where b.org_id = me.org_id and b.deleted_at is null and (
    me.branch_id is null
    or b.id = me.branch_id
    or b.id in (select a.branch_id from public.staff_branch_access a where a.staff_id = me.id and a.deleted_at is null)
  )
$$;

create or replace function app.my_branch_ids() returns uuid[]
language sql stable as $$ select app.branch_ids_of(auth.uid()) $$;

-- Everyone below a staff member in the reporting tree (primary reports_to + secondary lines).
create or replace function app.subordinates_of(p_staff uuid) returns uuid[]
language sql stable security definer set search_path = public as $$
  with recursive edges(staff_id, manager_id) as (
    select s.id, s.reports_to from public.staff s where s.reports_to is not null and s.deleted_at is null
    union
    select r.staff_id, r.manager_id from public.reporting_lines r where r.deleted_at is null
  ),
  tree(id) as (
    select e.staff_id from edges e where e.manager_id = p_staff
    union
    select e.staff_id from edges e join tree t on e.manager_id = t.id
  )
  select coalesce(array_agg(distinct id), '{}') from tree where id <> p_staff
$$;

create or replace function app.scope_rank(p_scope text) returns integer
language sql immutable as $$
  select case p_scope when 'own' then 1 when 'team' then 2 when 'department' then 3
    when 'wing' then 4 when 'branch' then 5 when 'group' then 6 else 0 end
$$;

-- Highest scope the user holds for module.action across all roles (0 = none).
create or replace function app.perm_rank(p_uid uuid, p_module text, p_action text) returns integer
language sql stable security definer set search_path = public as $$
  select coalesce(max(app.scope_rank(rp.scope)), 0)
  from app.staff_of(p_uid) me
  join public.staff_roles sr on sr.staff_id = me.id and sr.deleted_at is null
  join public.role_permissions rp on rp.role_id = sr.role_id and rp.deleted_at is null
  where rp.module = p_module and rp.action = p_action
$$;

create or replace function app.module_enabled(p_branch uuid, p_module text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select enabled from public.module_flags
                   where branch_id = p_branch and module_key = p_module and deleted_at is null), true)
$$;

-- Core permission check with explicit target attributes.
create or replace function app.check_perm(
  p_uid uuid, p_module text, p_action text,
  p_org uuid, p_branch uuid, p_owner uuid, p_department uuid, p_wing uuid
) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  me public.staff;
  r integer;
begin
  if p_uid is null then return false; end if;
  me := app.staff_of(p_uid);
  if me.id is null or me.org_id is distinct from p_org then return false; end if;
  if p_branch is not null and not app.module_enabled(p_branch, p_module) then return false; end if;
  r := app.perm_rank(p_uid, p_module, p_action);
  if r = 0 then return false; end if;
  if r >= 6 then return true; end if;
  if p_branch is not null and not (p_branch = any(app.branch_ids_of(p_uid))) then return false; end if;
  if r = 5 then return true; end if;
  if p_owner is not null and p_owner = me.id then return true; end if;
  if r = 4 then
    return (p_wing is not null and p_wing = me.wing_id)
        or (p_owner is not null and exists (select 1 from public.staff o where o.id = p_owner and o.wing_id = me.wing_id and me.wing_id is not null));
  end if;
  if r = 3 then
    return (p_department is not null and p_department = me.department_id)
        or (p_owner is not null and exists (select 1 from public.staff o where o.id = p_owner and o.department_id = me.department_id and me.department_id is not null));
  end if;
  if r = 2 then
    return p_owner is not null and p_owner = any(app.subordinates_of(me.id));
  end if;
  return false;  -- own scope and not owner
end $$;

-- Public API (section 9.1): has_permission(user, module, action, target_row)
-- target_row keys: org_id, branch_id, owner_id, department_id, wing_id.
create or replace function public.has_permission(p_user uuid, p_module text, p_action text, p_target jsonb)
returns boolean language sql stable security definer set search_path = public as $$
  select app.check_perm(
    p_user, p_module, p_action,
    nullif(p_target->>'org_id','')::uuid,
    nullif(p_target->>'branch_id','')::uuid,
    nullif(p_target->>'owner_id','')::uuid,
    nullif(p_target->>'department_id','')::uuid,
    nullif(p_target->>'wing_id','')::uuid)
$$;

-- Shorthand used in policies (current user).
create or replace function app.can(p_module text, p_action text, p_org uuid, p_branch uuid,
  p_owner uuid default null, p_department uuid default null, p_wing uuid default null)
returns boolean language sql stable as $$
  select app.check_perm(auth.uid(), p_module, p_action, p_org, p_branch, p_owner, p_department, p_wing)
$$;

-- Member of org and (for branch rows) of the branch; module enabled; any view permission.
create or replace function app.can_see(p_module text, p_org uuid, p_branch uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select p_org = app.my_org_id()
     and (p_branch is null or p_branch = any(app.my_branch_ids()))
     and (p_module is null or p_branch is null or app.module_enabled(p_branch, p_module))
     and (p_module is null or app.perm_rank(auth.uid(), p_module, 'view') > 0)
$$;

-- Member of org/branch, any create/edit permission on the module (child rows; API enforces details).
create or replace function app.can_write_child(p_module text, p_org uuid, p_branch uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select p_org = app.my_org_id()
     and (p_branch is null or p_branch = any(app.my_branch_ids()))
     and (p_branch is null or app.module_enabled(p_branch, p_module))
     and (app.perm_rank(auth.uid(), p_module, 'create') > 0 or app.perm_rank(auth.uid(), p_module, 'edit') > 0)
$$;

grant execute on all functions in schema app to authenticated, service_role;
grant execute on function public.has_permission(uuid, text, text, jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------- policy builders
create or replace function app.drop_policies(p_table text) returns void language plpgsql as $$
declare pol record;
begin
  for pol in select policyname from pg_policies where schemaname = 'public' and tablename = p_table loop
    execute format('drop policy %I on public.%I', pol.policyname, p_table);
  end loop;
end $$;

-- kind:
--   config  : read = org/branch member; write = module.configure
--   entity  : scope-checked with owner/department/wing columns
--   child   : read = can_see(module); write = can_write_child(module)
--   member  : read = org/branch member (no module permission needed); write = module.edit
--   global  : rows with org_id null are AutoEd content (read by all, write super admin)
create or replace function app.apply_rls(p_table text, p_kind text, p_module text,
  p_owner text default null, p_dept text default null, p_wing text default null) returns void
language plpgsql as $$
declare
  o text := coalesce(p_owner, 'null::uuid');
  d text := coalesce(p_dept, 'null::uuid');
  w text := coalesce(p_wing, 'null::uuid');
  m text := quote_literal(p_module);
begin
  perform app.drop_policies(p_table);
  execute format('alter table public.%I enable row level security', p_table);

  if p_kind = 'config' then
    execute format('create policy sel on public.%I for select to authenticated using (org_id = app.my_org_id() and (branch_id is null or branch_id = any(app.my_branch_ids())))', p_table);
    execute format('create policy ins on public.%I for insert to authenticated with check (app.can(%s, ''configure'', org_id, branch_id))', p_table, m);
    execute format('create policy upd on public.%I for update to authenticated using (app.can(%s, ''configure'', org_id, branch_id)) with check (app.can(%s, ''configure'', org_id, branch_id))', p_table, m, m);
    execute format('create policy del on public.%I for delete to authenticated using (app.can(%s, ''configure'', org_id, branch_id))', p_table, m);
  elsif p_kind = 'entity' then
    execute format('create policy sel on public.%I for select to authenticated using (app.can(%s, ''view'', org_id, branch_id, %s, %s, %s))', p_table, m, o, d, w);
    execute format('create policy ins on public.%I for insert to authenticated with check (app.can(%s, ''create'', org_id, branch_id, %s, %s, %s))', p_table, m, o, d, w);
    execute format('create policy upd on public.%I for update to authenticated using (app.can(%s, ''edit'', org_id, branch_id, %s, %s, %s)) with check (app.can(%s, ''edit'', org_id, branch_id, %s, %s, %s))', p_table, m, o, d, w, m, o, d, w);
    execute format('create policy del on public.%I for delete to authenticated using (app.can(%s, ''delete'', org_id, branch_id, %s, %s, %s))', p_table, m, o, d, w);
  elsif p_kind = 'child' then
    execute format('create policy sel on public.%I for select to authenticated using (app.can_see(%s, org_id, branch_id))', p_table, m);
    execute format('create policy ins on public.%I for insert to authenticated with check (app.can_write_child(%s, org_id, branch_id))', p_table, m);
    execute format('create policy upd on public.%I for update to authenticated using (app.can_write_child(%s, org_id, branch_id)) with check (app.can_write_child(%s, org_id, branch_id))', p_table, m, m);
    execute format('create policy del on public.%I for delete to authenticated using (app.can(%s, ''delete'', org_id, branch_id))', p_table, m);
  elsif p_kind = 'member' then
    execute format('create policy sel on public.%I for select to authenticated using (org_id = app.my_org_id() and (branch_id is null or branch_id = any(app.my_branch_ids())))', p_table);
    execute format('create policy ins on public.%I for insert to authenticated with check (app.can(%s, ''create'', org_id, branch_id))', p_table, m);
    execute format('create policy upd on public.%I for update to authenticated using (app.can(%s, ''edit'', org_id, branch_id)) with check (app.can(%s, ''edit'', org_id, branch_id))', p_table, m, m);
    execute format('create policy del on public.%I for delete to authenticated using (app.can(%s, ''delete'', org_id, branch_id))', p_table, m);
  elsif p_kind = 'global' then
    execute format('create policy sel on public.%I for select to authenticated using (org_id is null or org_id = app.my_org_id())', p_table);
    execute format('create policy ins on public.%I for insert to authenticated with check ((org_id is null and app.is_super_admin()) or (org_id is not null and app.can(%s, ''configure'', org_id, branch_id)))', p_table, m);
    execute format('create policy upd on public.%I for update to authenticated using ((org_id is null and app.is_super_admin()) or (org_id is not null and app.can(%s, ''configure'', org_id, branch_id))) with check ((org_id is null and app.is_super_admin()) or (org_id is not null and app.can(%s, ''configure'', org_id, branch_id)))', p_table, m, m);
    execute format('create policy del on public.%I for delete to authenticated using ((org_id is null and app.is_super_admin()) or (org_id is not null and app.can(%s, ''configure'', org_id, branch_id)))', p_table, m);
  else
    raise exception 'unknown rls kind %', p_kind;
  end if;
end $$;

-- ---------------------------------------------------------------- apply to every table
-- Organizations: own org only; edits need setup.configure at group scope.
select app.drop_policies('organizations');
alter table public.organizations enable row level security;
create policy sel on public.organizations for select to authenticated using (id = app.my_org_id());
create policy upd on public.organizations for update to authenticated
  using (app.can('setup', 'configure', id, null)) with check (app.can('setup', 'configure', id, null));

-- Branches: visible branches; edits need setup.configure.
select app.drop_policies('branches');
alter table public.branches enable row level security;
create policy sel on public.branches for select to authenticated using (org_id = app.my_org_id() and id = any(app.my_branch_ids()));
create policy ins on public.branches for insert to authenticated with check (app.can('setup', 'configure', org_id, null));
create policy upd on public.branches for update to authenticated using (app.can('setup', 'configure', org_id, id)) with check (app.can('setup', 'configure', org_id, id));

-- Structure & configuration
select app.apply_rls(t, 'config', 'setup') from unnest(array[
  'academic_years','terms','wings','rooms','departments','classes','subjects','class_subjects','sections',
  'module_flags','roles','role_permissions','positions','assignment_rules','custom_fields','terminology',
  'staff_branch_access','staff_roles','reporting_lines'
]) t;
select app.apply_rls('presets', 'global', 'setup');
select app.apply_rls('custom_field_values', 'child', 'tasks');
select app.apply_rls('config_history', 'config', 'setup');
select app.apply_rls('delegations', 'entity', 'staff', 'staff_id');

-- Staff directory: members of the branch see colleagues (needed to assign work);
-- edits are scope-checked on staff.edit.
select app.drop_policies('staff');
alter table public.staff enable row level security;
create policy sel on public.staff for select to authenticated
  using (org_id = app.my_org_id() and (branch_id is null or branch_id = any(app.my_branch_ids()) or user_id = auth.uid()));
create policy ins on public.staff for insert to authenticated with check (app.can('staff', 'create', org_id, branch_id));
create policy upd on public.staff for update to authenticated
  using (app.can('staff', 'edit', org_id, branch_id, id, department_id, wing_id))
  with check (app.can('staff', 'edit', org_id, branch_id, id, department_id, wing_id));
create policy del on public.staff for delete to authenticated using (app.can('staff', 'delete', org_id, branch_id));

-- Student roster: teachers of the branch read it; edits need student_attendance.configure.
select app.apply_rls('students', 'member', 'students');

-- Tasks: owner, assigner, collaborators and watchers always see; otherwise scope on owner.
select app.drop_policies('tasks');
alter table public.tasks enable row level security;
create or replace function app.task_participant(p_task uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.task_assignees a where a.task_id = p_task and a.staff_id = app.my_staff_id() and a.deleted_at is null)
$$;
create policy sel on public.tasks for select to authenticated using (
  org_id = app.my_org_id() and (
    owner_id = app.my_staff_id() or assigner_id = app.my_staff_id() or app.task_participant(id)
    or app.can('tasks', 'view', org_id, branch_id, owner_id, department_id, wing_id)));
create policy ins on public.tasks for insert to authenticated with check (
  org_id = app.my_org_id() and branch_id = any(app.my_branch_ids()) and app.module_enabled(branch_id, 'tasks')
  and (app.perm_rank(auth.uid(), 'tasks', 'create') > 0));
create policy upd on public.tasks for update to authenticated using (
  org_id = app.my_org_id() and (owner_id = app.my_staff_id() or assigner_id = app.my_staff_id() or app.task_participant(id)
    or app.can('tasks', 'edit', org_id, branch_id, owner_id, department_id, wing_id)))
  with check (org_id = app.my_org_id() and app.module_enabled(branch_id, 'tasks'));
create policy del on public.tasks for delete to authenticated using (app.can('tasks', 'delete', org_id, branch_id, owner_id, department_id, wing_id));

select app.apply_rls(t, 'child', 'tasks') from unnest(array['task_assignees','task_comments','task_attachments','task_events']) t;
select app.apply_rls('task_categories', 'config', 'tasks');
select app.apply_rls('escalation_rules', 'config', 'tasks');
select app.apply_rls('task_recurrences', 'entity', 'tasks', 'assigner_id');

-- Checklists
select app.apply_rls(t, 'config', 'checklists') from unnest(array['checklist_templates','checklist_items']) t;
select app.apply_rls('checklist_runs', 'entity', 'checklists', 'owner_id');
select app.apply_rls('checklist_responses', 'child', 'checklists');

-- Timetable & substitution
select app.apply_rls(t, 'config', 'timetable') from unnest(array['bell_schedules','periods','teacher_allocations','timetable_constraints','timetable_versions']) t;
select app.apply_rls('timetable_entries', 'member', 'timetable');
select app.apply_rls('substitutions', 'entity', 'substitution', 'substitute_staff_id');

-- Attendance & leave
select app.apply_rls('attendance_rules', 'config', 'staff_attendance');
select app.apply_rls('attendance_imports', 'entity', 'staff_attendance');
select app.apply_rls('staff_attendance', 'entity', 'staff_attendance', 'staff_id');
select app.apply_rls('student_attendance_sessions', 'entity', 'student_attendance', 'marked_by');
select app.apply_rls('student_attendance_marks', 'child', 'student_attendance');
select app.apply_rls('leave_types', 'config', 'leave');
select app.apply_rls('leave_balances', 'entity', 'leave', 'staff_id');
select app.apply_rls('leave_requests', 'entity', 'leave', 'staff_id');

-- Approvals: applicant and pending approvers see the request; otherwise scope on applicant.
select app.apply_rls(t, 'config', 'approvals') from unnest(array['approval_types','approval_flows','approval_steps']) t;
select app.drop_policies('approval_requests');
alter table public.approval_requests enable row level security;
create policy sel on public.approval_requests for select to authenticated using (
  org_id = app.my_org_id() and (applicant_id = app.my_staff_id() or app.my_staff_id() = any(pending_approver_ids)
    or exists (select 1 from public.approval_actions a where a.request_id = approval_requests.id and a.actor_id = app.my_staff_id())
    or app.can('approvals', 'view', org_id, branch_id, applicant_id)));
create policy ins on public.approval_requests for insert to authenticated with check (
  org_id = app.my_org_id() and branch_id = any(app.my_branch_ids()) and applicant_id = app.my_staff_id());
create policy upd on public.approval_requests for update to authenticated using (
  org_id = app.my_org_id() and (applicant_id = app.my_staff_id() or app.my_staff_id() = any(pending_approver_ids)
    or app.can('approvals', 'approve', org_id, branch_id, applicant_id)))
  with check (org_id = app.my_org_id());
select app.apply_rls('approval_actions', 'child', 'approvals');

-- Curriculum & planning (preloaded maps are global rows)
select app.apply_rls(t, 'global', 'lesson_planner') from unnest(array['curriculum_boards','curriculum_subjects','curriculum_units','curriculum_topics','learning_outcomes']) t;
select app.apply_rls('school_documents', 'member', 'lesson_planner');
select app.apply_rls('document_chunks', 'member', 'lesson_planner');
select app.apply_rls('lesson_plan_templates', 'config', 'lesson_planner');
select app.apply_rls('plan_submission_rules', 'config', 'lesson_planner');
select app.apply_rls('annual_plans', 'entity', 'lesson_planner', 'staff_id');
select app.apply_rls('annual_plan_items', 'child', 'lesson_planner');
-- Lesson plans: own + scope; plan bank entries visible to the branch (or group when shared).
select app.drop_policies('lesson_plans');
alter table public.lesson_plans enable row level security;
create policy sel on public.lesson_plans for select to authenticated using (
  app.can('lesson_planner', 'view', org_id, branch_id, staff_id)
  or (in_bank and org_id = app.my_org_id() and (branch_id = any(app.my_branch_ids()) or share_with_group)));
create policy ins on public.lesson_plans for insert to authenticated with check (app.can('lesson_planner', 'create', org_id, branch_id, staff_id));
create policy upd on public.lesson_plans for update to authenticated
  using (app.can('lesson_planner', 'edit', org_id, branch_id, staff_id) or app.can('lesson_planner', 'approve', org_id, branch_id, staff_id))
  with check (org_id = app.my_org_id());
create policy del on public.lesson_plans for delete to authenticated using (app.can('lesson_planner', 'delete', org_id, branch_id, staff_id));
select app.apply_rls(t, 'child', 'lesson_planner') from unnest(array['lesson_plan_versions','lesson_plan_reviews']) t;

-- Class log
select app.apply_rls('class_logs', 'entity', 'class_log', 'staff_id');
select app.apply_rls('homework', 'entity', 'class_log', 'staff_id');
select app.apply_rls('notebook_checks', 'entity', 'class_log', 'staff_id');

-- Exams
select app.apply_rls('exam_types', 'config', 'exams');
select app.apply_rls(t, 'member', 'exams') from unnest(array['exams','exam_schedules','invigilation_duties','seating_plans','paper_blueprints','question_bank']) t;
-- Question papers are confidential until the exam date: setter and named reviewers only,
-- unless the user holds question_papers.view (e.g. exam cell) — and never before exam date otherwise.
select app.drop_policies('question_papers');
alter table public.question_papers enable row level security;
create policy sel on public.question_papers for select to authenticated using (
  org_id = app.my_org_id() and app.module_enabled(branch_id, 'exams') and (
    setter_id = app.my_staff_id() or app.my_staff_id() = any(reviewer_ids)
    or (exam_date is not null and exam_date <= current_date and app.can('question_papers', 'view', org_id, branch_id, setter_id))));
create policy ins on public.question_papers for insert to authenticated with check (
  org_id = app.my_org_id() and setter_id = app.my_staff_id() and app.can('question_papers', 'create', org_id, branch_id, setter_id));
create policy upd on public.question_papers for update to authenticated using (
  org_id = app.my_org_id() and (setter_id = app.my_staff_id() or app.my_staff_id() = any(reviewer_ids)))
  with check (org_id = app.my_org_id());
select app.drop_policies('paper_access_log');
alter table public.paper_access_log enable row level security;
create policy sel on public.paper_access_log for select to authenticated using (app.can('question_papers', 'configure', org_id, branch_id) or staff_id = app.my_staff_id());

-- Observation & appraisal
select app.apply_rls('observation_rubrics', 'config', 'observation');
select app.drop_policies('observations');
alter table public.observations enable row level security;
create policy sel on public.observations for select to authenticated using (
  org_id = app.my_org_id() and (observer_id = app.my_staff_id()
    or (teacher_id = app.my_staff_id() and status in ('shared','acknowledged'))
    or app.can('observation', 'view', org_id, branch_id, teacher_id)));
create policy ins on public.observations for insert to authenticated with check (app.can('observation', 'create', org_id, branch_id, teacher_id));
create policy upd on public.observations for update to authenticated using (
  org_id = app.my_org_id() and (observer_id = app.my_staff_id() or teacher_id = app.my_staff_id() or app.can('observation', 'edit', org_id, branch_id, teacher_id)))
  with check (org_id = app.my_org_id());
select app.apply_rls('appraisal_cycles', 'config', 'appraisal');
select app.drop_policies('appraisal_scores');
alter table public.appraisal_scores enable row level security;
create policy sel on public.appraisal_scores for select to authenticated using (
  app.can('appraisal', 'view', org_id, branch_id, staff_id) and (staff_id <> app.my_staff_id()
    or exists (select 1 from public.appraisal_cycles c where c.id = cycle_id and c.released)));
create policy ins on public.appraisal_scores for insert to authenticated with check (app.can('appraisal', 'edit', org_id, branch_id, staff_id));
create policy upd on public.appraisal_scores for update to authenticated using (app.can('appraisal', 'edit', org_id, branch_id, staff_id)) with check (app.can('appraisal', 'edit', org_id, branch_id, staff_id));
select app.apply_rls('trainings', 'entity', 'observation', 'staff_id');

-- Admin modules
select app.apply_rls('ticket_categories', 'config', 'helpdesk');
select app.drop_policies('tickets');
alter table public.tickets enable row level security;
create policy sel on public.tickets for select to authenticated using (
  org_id = app.my_org_id() and (raised_by = app.my_staff_id() or owner_id = app.my_staff_id()
    or app.can('helpdesk', 'view', org_id, branch_id, owner_id)));
create policy ins on public.tickets for insert to authenticated with check (
  org_id = app.my_org_id() and branch_id = any(app.my_branch_ids()) and app.module_enabled(branch_id, 'helpdesk'));
create policy upd on public.tickets for update to authenticated using (
  org_id = app.my_org_id() and (raised_by = app.my_staff_id() or owner_id = app.my_staff_id() or app.can('helpdesk', 'edit', org_id, branch_id, owner_id)))
  with check (org_id = app.my_org_id());
select app.apply_rls('ticket_events', 'child', 'helpdesk');

select app.drop_policies('circulars');
alter table public.circulars enable row level security;
create policy sel on public.circulars for select to authenticated using (
  org_id = app.my_org_id() and (author_id = app.my_staff_id()
    or exists (select 1 from public.circular_receipts r where r.circular_id = circulars.id and r.staff_id = app.my_staff_id())
    or app.can('circulars', 'view', org_id, branch_id, author_id)));
create policy ins on public.circulars for insert to authenticated with check (app.can('circulars', 'create', org_id, branch_id, author_id));
create policy upd on public.circulars for update to authenticated using (app.can('circulars', 'edit', org_id, branch_id, author_id)) with check (app.can('circulars', 'edit', org_id, branch_id, author_id));
select app.drop_policies('circular_receipts');
alter table public.circular_receipts enable row level security;
create policy sel on public.circular_receipts for select to authenticated using (
  org_id = app.my_org_id() and (staff_id = app.my_staff_id() or app.can('circulars', 'view', org_id, branch_id)));
create policy upd on public.circular_receipts for update to authenticated using (staff_id = app.my_staff_id()) with check (staff_id = app.my_staff_id());

select app.apply_rls('calendar_events', 'member', 'calendar');
select app.apply_rls('meetings', 'member', 'meetings');
select app.apply_rls('meeting_actions', 'child', 'meetings');
select app.apply_rls('event_templates', 'config', 'events');
select app.apply_rls('events', 'member', 'events');
select app.apply_rls('duty_types', 'config', 'duty_roster');
select app.apply_rls('duty_assignments', 'entity', 'duty_roster', 'staff_id');

-- Incidents: confidential records need incidents_confidential.view.
select app.drop_policies('incidents');
alter table public.incidents enable row level security;
create policy sel on public.incidents for select to authenticated using (
  org_id = app.my_org_id() and (
    (not confidential and (reported_by = app.my_staff_id() or owner_id = app.my_staff_id() or app.can('incidents', 'view', org_id, branch_id, owner_id)))
    or (confidential and app.can('incidents_confidential', 'view', org_id, branch_id, owner_id))));
create policy ins on public.incidents for insert to authenticated with check (app.can('incidents', 'create', org_id, branch_id, reported_by));
create policy upd on public.incidents for update to authenticated using (
  org_id = app.my_org_id() and (owner_id = app.my_staff_id() or app.can('incidents', 'edit', org_id, branch_id, owner_id)))
  with check (org_id = app.my_org_id());

select app.apply_rls('compliance_items', 'entity', 'compliance', 'owner_id');

-- Platform: notifications etc. are personal.
create or replace function app.apply_personal_rls(p_table text) returns void language plpgsql as $$
begin
  perform app.drop_policies(p_table);
  execute format('alter table public.%I enable row level security', p_table);
  execute format('create policy sel on public.%I for select to authenticated using (org_id = app.my_org_id() and staff_id = app.my_staff_id())', p_table);
  execute format('create policy ins on public.%I for insert to authenticated with check (org_id = app.my_org_id() and staff_id = app.my_staff_id())', p_table);
  execute format('create policy upd on public.%I for update to authenticated using (org_id = app.my_org_id() and staff_id = app.my_staff_id()) with check (org_id = app.my_org_id() and staff_id = app.my_staff_id())', p_table);
  execute format('create policy del on public.%I for delete to authenticated using (org_id = app.my_org_id() and staff_id = app.my_staff_id())', p_table);
end $$;
select app.apply_personal_rls(t) from unnest(array['notifications','notification_prefs','device_tokens','bot_conversations','bot_feedback','support_tickets']) t;
select app.apply_rls('notification_rules', 'config', 'setup');
select app.apply_rls('message_usage', 'config', 'reports');
select app.apply_rls('saved_reports', 'entity', 'reports', 'owner_id');
select app.apply_rls('report_schedules', 'config', 'reports');
select app.apply_rls('branch_subscriptions', 'config', 'ai');
select app.apply_rls('ai_generations', 'entity', 'ai', 'staff_id');
select app.apply_rls('ai_credit_ledger', 'entity', 'ai', 'staff_id');
select app.apply_rls('credit_topup_requests', 'config', 'ai');
select app.apply_rls('kb_articles', 'global', 'help_bot');
select app.apply_rls('kb_chunks', 'global', 'help_bot');
select app.apply_rls('view_as_sessions', 'config', 'setup');

-- Server-only tables: RLS on, no policies for authenticated -> no direct access.
alter table public.jobs enable row level security;
alter table public.audit_log enable row level security;
create policy sel on public.audit_log for select to authenticated using (app.can('audit', 'view', org_id, branch_id));

-- Platform tables without org_id
alter table public.plans enable row level security;
create policy sel on public.plans for select to authenticated using (true);
create policy wr on public.plans for all to authenticated using (app.is_super_admin()) with check (app.is_super_admin());
alter table public.ai_action_costs enable row level security;
create policy sel on public.ai_action_costs for select to authenticated using (true);
create policy wr on public.ai_action_costs for all to authenticated using (app.is_super_admin()) with check (app.is_super_admin());
alter table public.platform_settings enable row level security;
create policy sel on public.platform_settings for select to authenticated using (app.is_super_admin());
create policy wr on public.platform_settings for all to authenticated using (app.is_super_admin()) with check (app.is_super_admin());
alter table public.platform_admins enable row level security;
create policy sel on public.platform_admins for select to authenticated using (user_id = auth.uid() or app.is_super_admin());

-- ---------------------------------------------------------------- grants
grant usage on schema public to authenticated, service_role;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;
revoke insert, update, delete on public.audit_log from authenticated;
revoke all on public.jobs from authenticated;

-- ---------------------------------------------------------------- audit trigger (rule 9)
create or replace function app.audit_row() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end;
  v_row jsonb := coalesce(v_new, v_old);
  v_org uuid;
begin
  if tg_op = 'UPDATE' and (v_old - 'updated_at') = (v_new - 'updated_at') then
    return null;  -- no-op update
  end if;
  v_org := case when tg_table_name = 'organizations' then (v_row->>'id')::uuid
                else nullif(v_row->>'org_id','')::uuid end;
  insert into public.audit_log (org_id, branch_id, actor_user_id, actor_staff_id, table_name, row_id, op, before, after, device)
  values (
    v_org,
    case when tg_table_name = 'branches' then (v_row->>'id')::uuid else nullif(v_row->>'branch_id','')::uuid end,
    auth.uid(),
    coalesce(nullif(current_setting('app.actor_staff_id', true), '')::uuid, app.my_staff_id()),
    tg_table_name,
    nullif(v_row->>'id','')::uuid,
    lower(tg_op),
    v_old, v_new,
    nullif(current_setting('app.device', true), ''));
  return null;
end $$;

-- Configuration screens keep their own history (section 4.4).
create or replace function app.config_history_row() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_row jsonb := coalesce(to_jsonb(new), to_jsonb(old));
begin
  if v_row->>'org_id' is null then return null; end if;
  insert into public.config_history (org_id, branch_id, entity, entity_id, action, before, after, actor_user_id)
  values ((v_row->>'org_id')::uuid, nullif(v_row->>'branch_id','')::uuid, tg_table_name, nullif(v_row->>'id','')::uuid, lower(tg_op),
          case when tg_op <> 'INSERT' then to_jsonb(old) end, case when tg_op <> 'DELETE' then to_jsonb(new) end, auth.uid());
  return null;
end $$;

do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public'
           and tablename not in ('audit_log','jobs','document_chunks','kb_chunks','config_history','notifications','message_usage','paper_access_log')
  loop
    execute format('drop trigger if exists trg_audit_%1$s on public.%1$I', t);
    execute format('create trigger trg_audit_%1$s after insert or update or delete on public.%1$I for each row execute function app.audit_row()', t);
  end loop;
  foreach t in array array['roles','role_permissions','positions','assignment_rules','custom_fields','terminology','module_flags',
    'task_categories','escalation_rules','checklist_templates','checklist_items','leave_types','approval_types','approval_flows',
    'approval_steps','lesson_plan_templates','plan_submission_rules','observation_rubrics','ticket_categories','event_templates',
    'duty_types','notification_rules','attendance_rules','exam_types','wings','classes','subjects','departments','rooms','bell_schedules','periods']
  loop
    execute format('drop trigger if exists trg_cfg_%1$s on public.%1$I', t);
    execute format('create trigger trg_cfg_%1$s after insert or update or delete on public.%1$I for each row execute function app.config_history_row()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- storage: private bucket, org-prefixed paths
insert into storage.buckets (id, name, public, file_size_limit)
values ('os-files', 'os-files', false, 26214400)
on conflict (id) do nothing;

drop policy if exists os_files_rw on storage.objects;
create policy os_files_rw on storage.objects for all to authenticated
  using (bucket_id = 'os-files' and (storage.foldername(name))[1] = app.my_org_id()::text)
  with check (bucket_id = 'os-files' and (storage.foldername(name))[1] = app.my_org_id()::text);
