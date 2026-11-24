-- ERP staff UI: the Data API inserts rows as the signed-in user and does not send org_id. The erp tables default it to the caller's organisation
-- (app.current_org_id()); these core tables, which the ERP screens write to, had no default, so every insert failed row level security with
-- a null org_id. Setting the default changes nothing for callers that send org_id, and row level security still checks the value.
do $$
declare t text;
begin
  foreach t in array array[
    'academic_years', 'calendar_events', 'class_posts', 'enrolments', 'exam_schedules', 'exam_seating', 'exam_types', 'exams', 'guardians', 'households',
    'leave_balances', 'leave_requests', 'notifications', 'number_series', 'programmes', 'question_bank', 'rooms', 'sections', 'staff', 'staff_attendance',
    'student_attendance_marks', 'student_attendance_sessions', 'student_leave_requests', 'student_sensitive', 'student_status_events', 'students', 'subjects',
    'teacher_allocations', 'terminology', 'terms', 'ticket_categories', 'ticket_events', 'tickets', 'timetable_entries', 'timetable_versions', 'periods',
    'bell_schedules', 'departments', 'positions', 'wings', 'delegations', 'custom_fields', 'message_templates', 'leave_types', 'role_permissions', 'user_product_access'
  ] loop
    if exists (select 1 from information_schema.columns where table_schema = 'core' and table_name = t and column_name = 'org_id' and column_default is null) then
      execute format('alter table core.%I alter column org_id set default app.current_org_id()', t);
    end if;
  end loop;
end $$;
