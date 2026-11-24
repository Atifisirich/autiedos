-- AutoEd OS on the shared platform (5/6): row level security for os.* and the OS rules on shared core rows.
--
-- Every os table gets, in this order:
--   1. app.apply_rls('os', table, 'product' | 'product_config', 'os', module)  -- platform baseline: RLS on, product +
--      user access + platform role check, audit trigger (config history for config tables);
--   2. OS policies (permissive, OR-ed with the baseline) with the legacy OS predicates: staff-based own / team /
--      department / wing scopes, participants (task collaborators, approvers, circular recipients), personal rows;
--   3. restrictive policies where the OS must be narrower than the baseline: module switched off for the branch,
--      question papers before the exam date, own appraisal score before release.
-- Every OS policy starts with app.user_has_product(org_id, 'os') (tenant + product + user access; harness T7).
-- Because derived platform roles map own/team/department/wing to 'own' (20261116000002), the baseline never
-- grants more than the OS rule did.

-- ---------------------------------------------------------------- helpers used by the policies
create or replace function os.task_participant(p_task uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from os.task_assignees a where a.task_id = p_task and a.staff_id = os.my_staff_id() and a.deleted_at is null)
$$;

create or replace function os.section_branch(p_section uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select p.branch_id from core.sections s join core.programmes p on p.id = s.programme_id where s.id = p_section
$$;

create or replace function os.attendance_session_branch(p_session uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select os.section_branch(s.section_id) from core.student_attendance_sessions s where s.id = p_session
$$;

create or replace function os.ticket_branch(p_ticket uuid) returns uuid
language sql stable security definer set search_path = '' as $$ select t.branch_id from core.tickets t where t.id = p_ticket $$;

create or replace function os.approval_branch(p_request uuid) returns uuid
language sql stable security definer set search_path = '' as $$ select r.branch_id from core.approval_requests r where r.id = p_request $$;

create or replace function os.acted_on(p_request uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from core.approval_actions a where a.request_id = p_request and a.actor_staff_id = os.my_staff_id())
$$;

create or replace function os.circular_recipient(p_circular uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from os.circular_receipts r where r.circular_id = p_circular and r.staff_id = os.my_staff_id())
$$;

create or replace function os.cycle_released(p_cycle uuid) returns boolean
language sql stable security definer set search_path = '' as $$ select coalesce((select c.released from os.appraisal_cycles c where c.id = p_cycle), false) $$;

-- Switchable module of a permission module (packages/shared flagModuleFor).
create or replace function os.flag_module(p_module text) returns text
language sql immutable set search_path = '' as $$
  select case p_module when 'appraisal' then 'observation' when 'question_papers' then 'exams'
    when 'incidents_confidential' then 'incidents' when 'students' then 'student_attendance'
    when 'setup' then null when 'staff' then null when 'ai' then null when 'audit' then null else p_module end
$$;

-- ---------------------------------------------------------------- generator (migrations only)
-- kind: config (product_config), entity (scope on owner/department/wing), child (read can_see, write any create/edit),
--       member (read org/branch member, write module.action), global (org_id null = AutoEd rows, read by OS users),
--       personal (staff_id = signed-in staff), custom (baseline only; the caller adds OS policies).
create or replace function os.apply_rls(p_table text, p_kind text, p_module text,
  p_owner text default null, p_dept text default null, p_wing text default null) returns void
language plpgsql set search_path = '' as $$
declare
  t text := format('os.%I', p_table);
  m text := quote_literal(p_module);
  o text := coalesce(p_owner, 'null::uuid');
  d text := coalesce(p_dept, 'null::uuid');
  w text := coalesce(p_wing, 'null::uuid');
  b text := case when app.has_column('os', p_table, 'branch_id') then 'branch_id' else 'null::uuid' end;
  p text := 'app.user_has_product(org_id, ''os'')';
  f text := os.flag_module(p_module);
begin
  perform app.apply_rls('os', p_table, case when p_kind = 'config' then 'product_config' else 'product' end, 'os', p_module);
  if p_kind = 'config' then
    execute format('create policy os_sel on %s for select using (%s and os.member(org_id, %s))', t, p, b);
    execute format('create policy os_ins on %s for insert with check (%s and os.can(%s, ''configure'', org_id, %s))', t, p, m, b);
    execute format('create policy os_upd on %s for update using (%2$s and os.can(%3$s, ''configure'', org_id, %4$s)) with check (%2$s and os.can(%3$s, ''configure'', org_id, %4$s))', t, p, m, b);
    execute format('create policy os_del on %s for delete using (%s and os.can(%s, ''configure'', org_id, %s))', t, p, m, b);
  elsif p_kind = 'entity' then
    execute format('create policy os_sel on %s for select using (%s and os.can(%s, ''view'', org_id, %s, %s, %s, %s))', t, p, m, b, o, d, w);
    execute format('create policy os_ins on %s for insert with check (%s and os.can(%s, ''create'', org_id, %s, %s, %s, %s))', t, p, m, b, o, d, w);
    execute format('create policy os_upd on %s for update using (%2$s and os.can(%3$s, ''edit'', org_id, %4$s, %5$s, %6$s, %7$s)) with check (%2$s and os.can(%3$s, ''edit'', org_id, %4$s, %5$s, %6$s, %7$s))', t, p, m, b, o, d, w);
    execute format('create policy os_del on %s for delete using (%s and os.can(%s, ''delete'', org_id, %s, %s, %s, %s))', t, p, m, b, o, d, w);
  elsif p_kind = 'child' then
    execute format('create policy os_sel on %s for select using (%s and os.can_see(%s, org_id, %s))', t, p, m, b);
    execute format('create policy os_ins on %s for insert with check (%s and os.can_write_child(%s, org_id, %s))', t, p, m, b);
    execute format('create policy os_upd on %s for update using (%2$s and os.can_write_child(%3$s, org_id, %4$s)) with check (%2$s and os.can_write_child(%3$s, org_id, %4$s))', t, p, m, b);
    execute format('create policy os_del on %s for delete using (%s and os.can(%s, ''delete'', org_id, %s))', t, p, m, b);
  elsif p_kind = 'member' then
    execute format('create policy os_sel on %s for select using (%s and os.member(org_id, %s))', t, p, b);
    execute format('create policy os_ins on %s for insert with check (%s and os.can(%s, ''create'', org_id, %s))', t, p, m, b);
    execute format('create policy os_upd on %s for update using (%2$s and os.can(%3$s, ''edit'', org_id, %4$s)) with check (%2$s and os.can(%3$s, ''edit'', org_id, %4$s))', t, p, m, b);
    execute format('create policy os_del on %s for delete using (%s and os.can(%s, ''delete'', org_id, %s))', t, p, m, b);
  elsif p_kind = 'global' then
    execute format('create policy os_sel on %s for select using ((org_id is null and app.user_has_product(app.current_org_id(), ''os'')) or (%s and os.member(org_id, %s)))', t, p, b);
    execute format('create policy os_ins on %s for insert with check (%s and os.can(%s, ''configure'', org_id, %s))', t, p, m, b);
    execute format('create policy os_upd on %s for update using (%2$s and os.can(%3$s, ''configure'', org_id, %4$s)) with check (%2$s and os.can(%3$s, ''configure'', org_id, %4$s))', t, p, m, b);
    execute format('create policy os_del on %s for delete using (%s and os.can(%s, ''configure'', org_id, %s))', t, p, m, b);
  elsif p_kind = 'personal' then
    execute format('create policy os_all on %s for all using (%2$s and org_id = app.current_org_id() and (staff_id = os.my_staff_id() or os.is_system())) with check (%2$s and org_id = app.current_org_id() and (staff_id = os.my_staff_id() or os.is_system()))', t, p);
  elsif p_kind <> 'custom' then
    raise exception 'os.apply_rls: unknown kind %', p_kind;
  end if;
  -- a module switched off for the branch closes its rows on every path (legacy check_perm / can_see)
  if f is not null and p_kind in ('entity','child','custom') and b <> 'null::uuid' then
    execute format('create policy os_module_on on %s as restrictive for all using (%2$s and os.module_on(branch_id, %3$L)) with check (%2$s and os.module_on(branch_id, %3$L))', t, p, f);
  end if;
end $$;

-- ---------------------------------------------------------------- structure and access configuration
select os.apply_rls(t, 'config', 'setup') from unnest(array['module_flags','roles','role_permissions','staff_roles','reporting_lines','assignment_rules']) t;

-- ---------------------------------------------------------------- tasks
select os.apply_rls('tasks', 'custom', 'tasks');
create policy os_sel on os.tasks for select using (app.user_has_product(org_id, 'os') and org_id = app.current_org_id() and (
  owner_id = os.my_staff_id() or assigner_id = os.my_staff_id() or os.task_participant(id) or os.is_system()
  or os.can('tasks', 'view', org_id, branch_id, owner_id, department_id, wing_id)));
create policy os_ins on os.tasks for insert with check (app.user_has_product(org_id, 'os') and os.member(org_id, branch_id)
  and (os.is_system() or os.staff_perm_rank(os.my_staff_id(), 'tasks', 'create') > 0));
create policy os_upd on os.tasks for update using (app.user_has_product(org_id, 'os') and org_id = app.current_org_id() and (
  owner_id = os.my_staff_id() or assigner_id = os.my_staff_id() or os.task_participant(id) or os.is_system()
  or os.can('tasks', 'edit', org_id, branch_id, owner_id, department_id, wing_id)))
  with check (app.user_has_product(org_id, 'os') and org_id = app.current_org_id());
create policy os_del on os.tasks for delete using (app.user_has_product(org_id, 'os') and os.can('tasks', 'delete', org_id, branch_id, owner_id, department_id, wing_id));
select os.apply_rls(t, 'child', 'tasks') from unnest(array['task_assignees','task_comments','task_attachments','task_events']) t;
select os.apply_rls(t, 'config', 'tasks') from unnest(array['task_categories','escalation_rules']) t;
select os.apply_rls('task_recurrences', 'entity', 'tasks', 'assigner_id');

-- ---------------------------------------------------------------- checklists, timetable generator, substitution
select os.apply_rls(t, 'config', 'checklists') from unnest(array['checklist_templates','checklist_items']) t;
select os.apply_rls('checklist_runs', 'entity', 'checklists', 'owner_id');
select os.apply_rls('checklist_responses', 'child', 'checklists');
select os.apply_rls('timetable_constraints', 'config', 'timetable');
select os.apply_rls('substitutions', 'entity', 'substitution', 'substitute_staff_id');

-- ---------------------------------------------------------------- curriculum and planning
select os.apply_rls(t, 'global', 'lesson_planner') from unnest(array['curriculum_boards','curriculum_subjects','curriculum_units','curriculum_topics','learning_outcomes']) t;
select os.apply_rls(t, 'member', 'lesson_planner') from unnest(array['reference_documents','document_chunks']) t;
select os.apply_rls(t, 'config', 'lesson_planner') from unnest(array['lesson_plan_templates','plan_submission_rules']) t;
select os.apply_rls('annual_plans', 'entity', 'lesson_planner', 'staff_id');
select os.apply_rls('annual_plan_items', 'child', 'lesson_planner');
select os.apply_rls('lesson_plans', 'custom', 'lesson_planner');
create policy os_sel on os.lesson_plans for select using (app.user_has_product(org_id, 'os') and (
  os.can('lesson_planner', 'view', org_id, branch_id, staff_id)
  or (in_bank and os.member(org_id, null) and (branch_id = any(os.branch_ids_of(app.uid())) or share_with_group))));
create policy os_ins on os.lesson_plans for insert with check (app.user_has_product(org_id, 'os') and os.can('lesson_planner', 'create', org_id, branch_id, staff_id));
create policy os_upd on os.lesson_plans for update
  using (app.user_has_product(org_id, 'os') and (os.can('lesson_planner', 'edit', org_id, branch_id, staff_id) or os.can('lesson_planner', 'approve', org_id, branch_id, staff_id)))
  with check (app.user_has_product(org_id, 'os') and org_id = app.current_org_id());
create policy os_del on os.lesson_plans for delete using (app.user_has_product(org_id, 'os') and os.can('lesson_planner', 'delete', org_id, branch_id, staff_id));
select os.apply_rls(t, 'child', 'lesson_planner') from unnest(array['lesson_plan_versions','lesson_plan_reviews']) t;
select os.apply_rls(t, 'entity', 'class_log', 'staff_id') from unnest(array['class_logs','notebook_checks']) t;

-- ---------------------------------------------------------------- exams
select os.apply_rls(t, 'member', 'exams') from unnest(array['exam_plans','invigilation_duties','paper_blueprints']) t;
-- Question papers are confidential until the exam date: setter and named reviewers only, then question_papers.view.
select os.apply_rls('question_papers', 'custom', 'question_papers');
create policy os_sel on os.question_papers for select using (app.user_has_product(org_id, 'os') and org_id = app.current_org_id() and (
  setter_id = os.my_staff_id() or os.my_staff_id() = any(reviewer_ids) or os.is_system()
  or (exam_date is not null and exam_date <= current_date and os.can('question_papers', 'view', org_id, branch_id, setter_id))));
create policy os_ins on os.question_papers for insert with check (app.user_has_product(org_id, 'os')
  and (os.is_system() or (setter_id = os.my_staff_id() and os.can('question_papers', 'create', org_id, branch_id, setter_id))));
create policy os_upd on os.question_papers for update
  using (app.user_has_product(org_id, 'os') and org_id = app.current_org_id() and (setter_id = os.my_staff_id() or os.my_staff_id() = any(reviewer_ids) or os.is_system()))
  with check (app.user_has_product(org_id, 'os') and org_id = app.current_org_id());
create policy os_confidential_sel on os.question_papers as restrictive for select using (app.user_has_product(org_id, 'os') and (
  setter_id = os.my_staff_id() or os.my_staff_id() = any(reviewer_ids) or os.is_system() or (exam_date is not null and exam_date <= current_date)));
create policy os_confidential_upd on os.question_papers as restrictive for update using (app.user_has_product(org_id, 'os') and (
  setter_id = os.my_staff_id() or os.my_staff_id() = any(reviewer_ids) or os.is_system()));
create policy os_confidential_del on os.question_papers as restrictive for delete using (app.user_has_product(org_id, 'os') and (
  setter_id = os.my_staff_id() or os.is_system()));
select os.apply_rls('paper_access_log', 'custom', 'question_papers');
create policy os_sel on os.paper_access_log for select using (app.user_has_product(org_id, 'os') and (
  os.can('question_papers', 'configure', org_id, branch_id) or staff_id = os.my_staff_id() or os.is_system()));
create policy os_ins on os.paper_access_log for insert with check (app.user_has_product(org_id, 'os') and os.is_system());

-- ---------------------------------------------------------------- observation and appraisal
select os.apply_rls('observation_rubrics', 'config', 'observation');
select os.apply_rls('observations', 'custom', 'observation');
create policy os_sel on os.observations for select using (app.user_has_product(org_id, 'os') and org_id = app.current_org_id() and (
  observer_id = os.my_staff_id() or (teacher_id = os.my_staff_id() and status in ('shared','acknowledged')) or os.is_system()
  or os.can('observation', 'view', org_id, branch_id, teacher_id)));
create policy os_ins on os.observations for insert with check (app.user_has_product(org_id, 'os') and os.can('observation', 'create', org_id, branch_id, teacher_id));
create policy os_upd on os.observations for update using (app.user_has_product(org_id, 'os') and org_id = app.current_org_id() and (
  observer_id = os.my_staff_id() or teacher_id = os.my_staff_id() or os.is_system() or os.can('observation', 'edit', org_id, branch_id, teacher_id)))
  with check (app.user_has_product(org_id, 'os') and org_id = app.current_org_id());
select os.apply_rls('appraisal_cycles', 'config', 'appraisal');
select os.apply_rls('appraisal_scores', 'custom', 'appraisal');
create policy os_sel on os.appraisal_scores for select using (app.user_has_product(org_id, 'os') and (os.is_system() or os.can('appraisal', 'view', org_id, branch_id, staff_id)));
create policy os_ins on os.appraisal_scores for insert with check (app.user_has_product(org_id, 'os') and os.can('appraisal', 'edit', org_id, branch_id, staff_id));
create policy os_upd on os.appraisal_scores for update using (app.user_has_product(org_id, 'os') and os.can('appraisal', 'edit', org_id, branch_id, staff_id))
  with check (app.user_has_product(org_id, 'os') and os.can('appraisal', 'edit', org_id, branch_id, staff_id));
create policy os_own_hidden on os.appraisal_scores as restrictive for select using (app.user_has_product(org_id, 'os') and (
  staff_id is distinct from os.my_staff_id() or os.cycle_released(cycle_id)));
select os.apply_rls('trainings', 'entity', 'observation', 'staff_id');

-- ---------------------------------------------------------------- circulars, meetings, events, duties, compliance
select os.apply_rls('circulars', 'custom', 'circulars');
create policy os_sel on os.circulars for select using (app.user_has_product(org_id, 'os') and org_id = app.current_org_id() and (
  author_id = os.my_staff_id() or os.circular_recipient(id) or os.is_system() or os.can('circulars', 'view', org_id, branch_id, author_id)));
create policy os_ins on os.circulars for insert with check (app.user_has_product(org_id, 'os') and os.can('circulars', 'create', org_id, branch_id, author_id));
create policy os_upd on os.circulars for update using (app.user_has_product(org_id, 'os') and os.can('circulars', 'edit', org_id, branch_id, author_id))
  with check (app.user_has_product(org_id, 'os') and os.can('circulars', 'edit', org_id, branch_id, author_id));
select os.apply_rls('circular_receipts', 'custom', 'circulars');
create policy os_sel on os.circular_receipts for select using (app.user_has_product(org_id, 'os') and org_id = app.current_org_id() and (
  staff_id = os.my_staff_id() or os.is_system() or os.can('circulars', 'view', org_id, branch_id)));
create policy os_upd on os.circular_receipts for update using (app.user_has_product(org_id, 'os') and (staff_id = os.my_staff_id() or os.is_system()))
  with check (app.user_has_product(org_id, 'os') and (staff_id = os.my_staff_id() or os.is_system()));
select os.apply_rls('meetings', 'member', 'meetings');
select os.apply_rls('meeting_actions', 'child', 'meetings');
select os.apply_rls('event_templates', 'config', 'events');
select os.apply_rls('event_plans', 'member', 'events');
select os.apply_rls('duty_types', 'config', 'duty_roster');
select os.apply_rls('duty_assignments', 'entity', 'duty_roster', 'staff_id');
select os.apply_rls('compliance_items', 'entity', 'compliance', 'owner_id');

-- ---------------------------------------------------------------- reports and help bot
select os.apply_rls('saved_reports', 'entity', 'reports', 'owner_id');
select os.apply_rls('report_schedules', 'config', 'reports');
select os.apply_rls(t, 'global', 'help_bot') from unnest(array['kb_articles','kb_chunks']) t;
select os.apply_rls(t, 'personal', 'help_bot') from unnest(array['bot_conversations','bot_feedback']) t;

-- The probe table stays for the harness until it covers the real tables everywhere (ADR 005).

-- ---------------------------------------------------------------- OS rules on shared core rows
-- Staff-side screens of shared tables come from the OS (decision 50). These permissive policies give OS users the
-- OS's staff-based scopes on core rows (a teacher's own attendance, a HOD's team leave, the approver of a request);
-- they never apply without the OS product. Core's own policies (audiences, writers) are unchanged.
-- Wrappers in app (every server role has USAGE on app, none but os_server on os): policies on core tables are
-- evaluated for crm_server / erp_server too, so they must not reference the os schema directly.
create or replace function app.os_can(p_module text, p_action text, p_org uuid, p_branch uuid, p_owner uuid default null,
  p_department uuid default null, p_wing uuid default null) returns boolean
language sql stable security definer set search_path = '' as $$ select os.can(p_module, p_action, p_org, p_branch, p_owner, p_department, p_wing) $$;
create or replace function app.os_staff_id() returns uuid
language sql stable security definer set search_path = '' as $$ select os.my_staff_id() $$;
create or replace function app.os_is_system() returns boolean
language sql stable security definer set search_path = '' as $$ select os.is_system() $$;
create or replace function app.os_member(p_org uuid, p_branch uuid) returns boolean
language sql stable security definer set search_path = '' as $$ select os.member(p_org, p_branch) $$;
create or replace function app.os_module_on(p_branch uuid, p_module text) returns boolean
language sql stable security definer set search_path = '' as $$ select os.module_on(p_branch, p_module) $$;
create or replace function app.os_can_see(p_module text, p_org uuid, p_branch uuid) returns boolean
language sql stable security definer set search_path = '' as $$ select os.can_see(p_module, p_org, p_branch) $$;
create or replace function app.os_can_write_child(p_module text, p_org uuid, p_branch uuid) returns boolean
language sql stable security definer set search_path = '' as $$ select os.can_write_child(p_module, p_org, p_branch) $$;
create or replace function app.os_section_branch(p_section uuid) returns uuid
language sql stable security definer set search_path = '' as $$ select os.section_branch(p_section) $$;
create or replace function app.os_session_branch(p_session uuid) returns uuid
language sql stable security definer set search_path = '' as $$ select os.attendance_session_branch(p_session) $$;
create or replace function app.os_ticket_branch(p_ticket uuid) returns uuid
language sql stable security definer set search_path = '' as $$ select os.ticket_branch(p_ticket) $$;
create or replace function app.os_approval_branch(p_request uuid) returns uuid
language sql stable security definer set search_path = '' as $$ select os.approval_branch(p_request) $$;
create or replace function app.os_acted_on(p_request uuid) returns boolean
language sql stable security definer set search_path = '' as $$ select os.acted_on(p_request) $$;

create or replace function os.core_scope(p_table text, p_module text, p_branch text, p_owner text) returns void
language plpgsql set search_path = '' as $$
declare
  t text := format('core.%I', p_table);
  p text := 'app.user_has_product(org_id, ''os'')';
  m text := quote_literal(p_module);
begin
  execute format('create policy os_sel on %s for select using (%s and app.os_can(%s, ''view'', org_id, %s, %s))', t, p, m, p_branch, p_owner);
  execute format('create policy os_ins on %s for insert with check (%s and app.os_can(%s, ''create'', org_id, %s, %s))', t, p, m, p_branch, p_owner);
  execute format('create policy os_upd on %s for update using (%2$s and app.os_can(%3$s, ''edit'', org_id, %4$s, %5$s)) with check (%2$s and app.os_can(%3$s, ''edit'', org_id, %4$s, %5$s))', t, p, m, p_branch, p_owner);
  execute format('create policy os_del on %s for delete using (%s and app.os_can(%s, ''delete'', org_id, %s, %s))', t, p, m, p_branch, p_owner);
end $$;

select os.core_scope('staff_attendance', 'staff_attendance', 'branch_id', 'staff_id');
select os.core_scope('attendance_imports', 'staff_attendance', 'branch_id', 'null::uuid');
select os.core_scope('leave_requests', 'leave', 'branch_id', 'staff_id');
select os.core_scope('leave_balances', 'leave', 'null::uuid', 'staff_id');
select os.core_scope('delegations', 'staff', 'null::uuid', 'staff_id');
select os.core_scope('student_attendance_sessions', 'student_attendance', 'app.os_section_branch(section_id)', 'marked_by_staff_id');
select os.core_scope('class_posts', 'class_log', 'app.os_section_branch(section_id)', 'staff_id');
select os.core_scope('ai_generations', 'ai', 'branch_id', 'staff_id');

create policy os_upd on core.staff for update
  using (app.user_has_product(org_id, 'os') and app.os_can('staff', 'edit', org_id, branch_id, id, department_id, wing_id))
  with check (app.user_has_product(org_id, 'os') and app.os_can('staff', 'edit', org_id, branch_id, id, department_id, wing_id));

create policy os_sel on core.student_attendance_marks for select using (app.user_has_product(org_id, 'os')
  and app.os_can_see('student_attendance', org_id, app.os_session_branch(session_id)));
create policy os_ins on core.student_attendance_marks for insert with check (app.user_has_product(org_id, 'os')
  and app.os_can_write_child('student_attendance', org_id, app.os_session_branch(session_id)));
create policy os_upd on core.student_attendance_marks for update
  using (app.user_has_product(org_id, 'os') and app.os_can_write_child('student_attendance', org_id, app.os_session_branch(session_id)))
  with check (app.user_has_product(org_id, 'os') and app.os_can_write_child('student_attendance', org_id, app.os_session_branch(session_id)));

-- Approvals: the applicant, the pending approvers and past actors see the request; others by scope on the applicant.
create policy os_sel on core.approval_requests for select using (app.user_has_product(org_id, 'os') and org_id = app.current_org_id() and (
  applicant_staff_id = app.os_staff_id() or app.os_staff_id() = any(pending_approver_ids) or app.os_acted_on(id) or app.os_is_system()
  or app.os_can('approvals', 'view', org_id, branch_id, applicant_staff_id)));
create policy os_ins on core.approval_requests for insert with check (app.user_has_product(org_id, 'os') and app.os_member(org_id, branch_id)
  and (applicant_staff_id = app.os_staff_id() or app.os_is_system()));
create policy os_upd on core.approval_requests for update using (app.user_has_product(org_id, 'os') and org_id = app.current_org_id() and (
  applicant_staff_id = app.os_staff_id() or app.os_staff_id() = any(pending_approver_ids) or app.os_is_system()
  or app.os_can('approvals', 'approve', org_id, branch_id, applicant_staff_id)))
  with check (app.user_has_product(org_id, 'os') and org_id = app.current_org_id());
create policy os_sel on core.approval_actions for select using (app.user_has_product(org_id, 'os')
  and (actor_staff_id = app.os_staff_id() or app.os_can_see('approvals', org_id, app.os_approval_branch(request_id))));
create policy os_ins on core.approval_actions for insert with check (app.user_has_product(org_id, 'os')
  and (actor_staff_id = app.os_staff_id() or app.os_is_system()) and org_id = app.current_org_id());

-- Helpdesk: the raiser and the owner always; others by scope on the owner.
create policy os_sel on core.tickets for select using (app.user_has_product(org_id, 'os') and org_id = app.current_org_id() and (
  raised_by_staff_id = app.os_staff_id() or owner_staff_id = app.os_staff_id() or app.os_is_system()
  or app.os_can('helpdesk', 'view', org_id, branch_id, owner_staff_id)));
create policy os_ins on core.tickets for insert with check (app.user_has_product(org_id, 'os') and app.os_member(org_id, branch_id)
  and app.os_module_on(branch_id, 'helpdesk'));
create policy os_upd on core.tickets for update using (app.user_has_product(org_id, 'os') and org_id = app.current_org_id() and (
  raised_by_staff_id = app.os_staff_id() or owner_staff_id = app.os_staff_id() or app.os_is_system()
  or app.os_can('helpdesk', 'edit', org_id, branch_id, owner_staff_id)))
  with check (app.user_has_product(org_id, 'os') and org_id = app.current_org_id());
create policy os_sel on core.ticket_events for select using (app.user_has_product(org_id, 'os') and app.os_can_see('helpdesk', org_id, app.os_ticket_branch(ticket_id)));
create policy os_ins on core.ticket_events for insert with check (app.user_has_product(org_id, 'os') and app.os_member(org_id, app.os_ticket_branch(ticket_id)));

-- Incidents: reporter and owner see their non-confidential incidents; confidential rows need the confidential
-- permission on every path (restrictive; harness: org admins hold it through '*').
create policy os_sel on core.incidents for select using (app.user_has_product(org_id, 'os') and org_id = app.current_org_id() and (
  reported_by_staff_id = app.os_staff_id() or owner_staff_id = app.os_staff_id() or app.os_is_system()
  or app.os_can('incidents', 'view', org_id, branch_id, owner_staff_id)));
create policy os_ins on core.incidents for insert with check (app.user_has_product(org_id, 'os') and app.os_can('incidents', 'create', org_id, branch_id, reported_by_staff_id));
create policy os_upd on core.incidents for update using (app.user_has_product(org_id, 'os') and org_id = app.current_org_id() and (
  owner_staff_id = app.os_staff_id() or app.os_is_system() or app.os_can('incidents', 'edit', org_id, branch_id, owner_staff_id)))
  with check (app.user_has_product(org_id, 'os') and org_id = app.current_org_id());
create policy confidential on core.incidents as restrictive for select using (
  not confidential or app.can_any_product('incidents_confidential', 'view', org_id, branch_id) or app.os_is_system()
  or app.os_can('incidents_confidential', 'view', org_id, branch_id, owner_staff_id));

-- ---------------------------------------------------------------- function grants
-- Postgres lets PUBLIC execute new functions: take that away in os and grant to the OS role and `authenticated`
-- (policies run as the caller). DDL helpers, sync and system-actor functions are not for users.
revoke execute on all functions in schema os from public;
grant usage on schema os to authenticated, os_server, service_role;
grant execute on all functions in schema os to authenticated, os_server, service_role;
revoke execute on function os.std(text), os.apply_rls(text, text, text, text, text, text), os.core_scope(text, text, text, text),
  os.sync_access(uuid), os.system_user_id(uuid), os.active_orgs(), os.dev_login_user(text), os.branch_org_id(uuid), os.ensure_staff_login(text, text, text, uuid), os.enqueue_job(text, jsonb, timestamptz, text, integer),
  os.trg_sync_access(), os.trg_sync_access_ins(), os.trg_sync_access_del()
  from authenticated;
revoke execute on function os.std(text), os.apply_rls(text, text, text, text, text, text), os.core_scope(text, text, text, text),
  os.trg_sync_access(), os.trg_sync_access_ins(), os.trg_sync_access_del()
  from os_server;

revoke execute on function app.os_can(text, text, uuid, uuid, uuid, uuid, uuid), app.os_staff_id(), app.os_is_system(), app.os_member(uuid, uuid),
  app.os_module_on(uuid, text), app.os_can_see(text, uuid, uuid), app.os_can_write_child(text, uuid, uuid), app.os_section_branch(uuid),
  app.os_session_branch(uuid), app.os_ticket_branch(uuid), app.os_approval_branch(uuid), app.os_acted_on(uuid) from public;
grant execute on function app.os_can(text, text, uuid, uuid, uuid, uuid, uuid), app.os_staff_id(), app.os_is_system(), app.os_member(uuid, uuid),
  app.os_module_on(uuid, text), app.os_can_see(text, uuid, uuid), app.os_can_write_child(text, uuid, uuid), app.os_section_branch(uuid),
  app.os_session_branch(uuid), app.os_ticket_branch(uuid), app.os_approval_branch(uuid), app.os_acted_on(uuid)
  to authenticated, crm_server, os_server, erp_server, platform_admin_server, job_runner, service_role;

revoke execute on function app.platform_setting(text), app.ai_costs(), app.ai_ensure_allowance(text), app.ai_credit_state(text, uuid, uuid),
  app.ai_charge(uuid, text), app.ai_usage(text), app.ai_request_topup(numeric, text, uuid) from public;
grant execute on function app.platform_setting(text), app.ai_costs(), app.ai_ensure_allowance(text), app.ai_credit_state(text, uuid, uuid),
  app.ai_charge(uuid, text), app.ai_usage(text), app.ai_request_topup(numeric, text, uuid)
  to authenticated, crm_server, os_server, erp_server, platform_admin_server, service_role;

-- os_server and authenticated reach every os table (default privileges of 20261115000001); the sequences of
-- generated columns need nothing more.
grant select, insert, update, delete on all tables in schema os to authenticated, os_server;
grant all on all tables in schema os to service_role;
