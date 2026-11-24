-- AutoEd core master data (8/8): write functions shared by the products, the student-status guard, and
-- function execute grants (Postgres grants EXECUTE to PUBLIC on every new function; take it away again).

-- ---------------------------------------------------------------- labels: app.term(key, locale)
-- Org row (branch null) of core.terminology, else the built-in default for the org's kind.
create or replace function app.term(p_key text, p_locale text default 'en') returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select t.singular from core.terminology t
      where t.org_id = app.current_org_id() and t.key = p_key and t.locale = p_locale and t.branch_id is null and t.deleted_at is null),
    (select app.default_term(o.kind, p_key) from core.organizations o where o.id = app.current_org_id()),
    app.default_term('school', p_key))
$$;

-- ---------------------------------------------------------------- number series
-- Next document number for the signed-in staff user's org, e.g. core.next_number('admission_no', branch, year).
-- Falls back from (branch, year) to the org-wide series. Locks the series row, so numbers never repeat.
create or replace function core.next_number(p_key text, p_branch uuid default null, p_year uuid default null) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  v_s core.number_series;
begin
  if v_org is null or not app.user_has_any_product(v_org) or app.my_member_kind() is distinct from 'staff' then
    raise exception 'not allowed to draw numbers' using errcode = '42501';
  end if;
  select * into v_s from core.number_series s
   where s.org_id = v_org and s.key = p_key and s.active and s.deleted_at is null
     and (s.branch_id is null or s.branch_id = p_branch)
     and (s.academic_year_id is null or s.academic_year_id = p_year)
   order by (s.branch_id is not null) desc, (s.academic_year_id is not null) desc
   limit 1 for update;
  if not found then raise exception 'no number series %', p_key using errcode = '22023'; end if;
  update core.number_series set next_value = next_value + 1 where id = v_s.id;
  return v_s.prefix || lpad(v_s.next_value::text, v_s.padding, '0') || v_s.suffix;
end $$;

-- ---------------------------------------------------------------- student status (B.7)
-- students.status changes only through core.change_student_status(); a direct UPDATE of status by a request
-- role is refused. The function is security definer, so inside it current_user is the migration owner.
-- (A session setting would not do: any role can set one.)
create or replace function app.guard_student_status() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status is distinct from old.status
     and current_user in ('authenticated','anon','crm_server','os_server','erp_server','platform_admin_server','job_runner') then
    raise exception 'students.status changes only through core.change_student_status()' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger trg_guard_status before update of status on core.students
  for each row execute function app.guard_student_status();

-- Transitions from ERP change_student_status + transferred (MAP-TABLES B.7). Side effects (fees, transport,
-- hostel) run in the products as listeners on core.student_status_events, never in here.
create or replace function core.change_student_status(p_student uuid, p_to text, p_reason text default null,
  p_effective date default current_date) returns core.student_status_events
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_s core.students;
  v_ev core.student_status_events;
  v_ok boolean;
begin
  select * into v_s from core.students s where s.id = p_student and s.org_id = app.current_org_id() for update;
  if not found or not app.can_any_product('students', 'edit', v_s.org_id, v_s.branch_id) then
    raise exception 'student not found or not allowed' using errcode = '42501';
  end if;
  v_ok := (v_s.status, p_to) in (
    ('admitted','active'), ('admitted','withdrawn'), ('admitted','archived'),
    ('active','suspended'), ('active','withdrawn'), ('active','transferred'), ('active','alumni'),
    ('suspended','active'), ('suspended','withdrawn'), ('suspended','transferred'),
    ('withdrawn','alumni'), ('withdrawn','active'),
    ('transferred','active'), ('transferred','archived'),
    ('alumni','archived'), ('alumni','active'));
  if not v_ok then
    raise exception 'student status % -> % is not allowed', v_s.status, p_to using errcode = '22023';
  end if;
  if p_to = 'active' and v_s.admission_no is null then
    raise exception 'an admission number is needed before a student becomes active' using errcode = '22023';
  end if;
  update core.students set status = p_to,
         left_on = case when p_to in ('withdrawn','transferred','alumni') then p_effective when p_to = 'active' then null else left_on end,
         joined_on = case when p_to = 'active' and joined_on is null then p_effective else joined_on end
   where id = p_student;
  insert into core.student_status_events (org_id, student_id, from_status, to_status, reason, effective_date, actor_user_id, actor_name)
  values (v_s.org_id, p_student, v_s.status, p_to, p_reason, p_effective, auth.uid(),
          (select u.display_name from core.org_users u where u.user_id = auth.uid()))
  returning * into v_ev;
  return v_ev;
end $$;

-- ---------------------------------------------------------------- function execute grants
revoke execute on all functions in schema app, core from public;
grant execute on all functions in schema app
  to authenticated, service_role, crm_server, os_server, erp_server, platform_admin_server, job_runner;
grant execute on function core.next_number(text, uuid, uuid), core.change_student_status(uuid, text, text, date)
  to authenticated, service_role, crm_server, os_server, erp_server;
-- migration-only helpers and trigger functions
revoke execute on function app.apply_rls(text, text, text, text, text), app.drop_policies(text, text),
  app.enable_audit(text, text, boolean), app.platform_audit_row(), app.platform_config_history_row(),
  app.apply_core_rls(text, text, text, text, text, text), app.guard_student_status()
  from authenticated, crm_server, os_server, erp_server, platform_admin_server, job_runner;
revoke execute on function app.record_login_event(uuid, text, boolean, text, inet, text) from authenticated, job_runner;
