-- Compliance coverage of the product schemas (os, crm, erp) and the AI/credit tables (core, billing).
-- The compliance engine (20261115200001_compliance.sql, docs/adr/compliance-tooling.md) is catalogue-driven: a table is
-- exported and erased for a person only when it has a row in core.pii_registry. This migration registers every product
-- table that holds a person (lead, student, guardian, staff), adds the org/product deletion notes for the immutable money
-- tables, lets the compliance functions (and only them) through the ERP money guard, and seeds the retention rules for
-- leads, students after leaving, messages, AI logs and financial records as DISABLED drafts (all CONFIRM with counsel,
-- docs/legal/data-retention-schedule.md).
--
-- The catalogue test (packages/server/test-platform/compliance-coverage.test.ts) runs on the full harness schema
-- (platform + core + os + crm + erp + compliance), so a new product table with a person column fails CI until it is
-- registered here or in a later migration.
--
-- Person ids (what the export / erasure tools take):
--   staff     core.staff.id (or the login id)            student  core.students.id
--   guardian  core.guardians.id (or the login id)        lead     a CRM family: crm.households.id, or the id of one of its
--                                                                 guardians, children (prospects) or enquiries
-- A lead is the CRM family as a whole (household, guardians, children, enquiries and everything hanging off them), so the
-- lead's ids are resolved as a closure over the CRM subject rows (app._compliance_person_keys below). Core people keep the
-- single-step resolution: a guardian's erasure must never reach the other guardian or the siblings of the household.

-- ================================================================ person-id resolution for leads (closure)
create or replace function app._compliance_person_keys(p_org uuid, p_person_type text, p_person uuid) returns uuid[]
language plpgsql volatile security definer set search_path = '' as $$
declare
  reg core.pii_registry;
  v_cols text[];
  v_match text;
  v_found uuid[];
  v uuid[] := array[p_person];
  v_from uuid[];
  v_size integer;
  v_pass integer := 0;
begin
  loop
    v_pass := v_pass + 1;
    v_size := cardinality(v);
    -- staff, students and guardians: only the id the caller gave (one step); leads: every id found so far
    v_from := case when p_person_type = 'lead' then v else array[p_person] end;
    for reg in select * from app._compliance_registry_for(p_org, p_person_type) r where r.is_subject and r.key_column is not null loop
      if app._compliance_registry_usable(reg, p_org) is not null then continue; end if;
      v_cols := array_prepend(reg.key_column, reg.link_columns);
      v_match := (select string_agg(format('t.%I = any(%L::uuid[])', x, v_from), ' or ') from unnest(v_cols) x);
      execute format('select coalesce(array_agg(distinct y) filter (where y is not null), ''{}'') from (select unnest(array[%s]) as y from %I.%I t where t.org_id = %L and (%s)) s',
                     (select string_agg(format('t.%I::uuid', x), ', ') from unnest(v_cols) x), reg.schema_name, reg.table_name, p_org, v_match) into v_found;
      v := (select coalesce(array_agg(distinct z), '{}') from unnest(v || v_found) z);
    end loop;
    exit when p_person_type <> 'lead' or cardinality(v) = v_size or v_pass >= 6;
  end loop;
  return v;
end $$;
revoke execute on function app._compliance_person_keys(uuid, text, uuid) from public, anon, authenticated, crm_server, os_server, erp_server, platform_admin_server, job_runner;
grant execute on function app._compliance_person_keys(uuid, text, uuid) to service_role;

-- ================================================================ ERP money guard: let the compliance engine through
-- Money is never edited or deleted by a request (DM-03). The compliance engine is the one exception, and only from inside
-- its own functions: person erasure anonymises free text on receipts (the amount stays), and an org or product deletion
-- (after the exit export, decision 42) or a confirmed retention rule removes the rows. The call stack is checked, so a
-- request role cannot claim the exception: it cannot execute those functions, and they run as their owner.
create or replace function erp.immutable_rows() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_mut text[] := string_to_array(coalesce(tg_argv[0], ''), ',');
  v_fn text[] := string_to_array(coalesce(tg_argv[1], ''), ',');
  v_k text;
  v_ctx text;
begin
  if not erp.is_request_role() then
    get diagnostics v_ctx = pg_context;
    if v_ctx ~ 'function app\.(_compliance_erase|_compliance_delete_scope|compliance_retention_purge)\(' then
      return case when tg_op = 'DELETE' then old else new end;
    end if;
  end if;
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
revoke execute on function erp.immutable_rows() from public;

-- ================================================================ registry: product tables
create function pg_temp.preg(p_schema text, p_table text, p_key text, p_types text[], p_mode text, p_pii text[], p_ord integer, p_note text,
  p_av jsonb default '{}', p_reason text default null, p_contact text[] default '{}', p_audit text[] default '{}',
  p_subject boolean default false, p_link text[] default '{}') returns void
language plpgsql as $$
declare
  pt text;
begin
  foreach pt in array p_types loop
    insert into core.pii_registry (schema_name, table_name, person_type, key_column, contact_columns, is_subject, link_columns,
                                   pii_columns, audit_columns, anonymise_values, erasure_mode, retain_reason, erase_order, note)
    values (p_schema, p_table, pt, p_key, p_contact, p_subject, p_link, p_pii, p_audit, p_av, p_mode, p_reason, p_ord, p_note);
  end loop;
end $$;

do $$
declare
  logins constant text[] := array['staff','guardian','student'];
  family constant text[] := array['guardian','student'];
  r_fin constant text := 'Financial record of the school (books of account, GST and income-tax evidence): kept about 8 years after the financial year (retention schedule 2.1, LAWYER TO CONFIRM); the row stays on the pseudonymous profile, free text is removed where there is any.';
  r_pay constant text := 'Statutory payroll record (wages, PF/ESI, TDS): kept about 8 years (retention schedule 2.1 staff after leaving and financial records, LAWYER TO CONFIRM); the staff row is pseudonymous.';
  r_work constant text := 'Work record made in the course of employment (planning, teaching, duties, timetable); the staff row is pseudonymous (retention schedule 2.1 operational records, CONFIRM).';
  r_hr constant text := 'HR record of the employee (appraisal, training, evaluation): kept with the staff file after leaving (retention schedule 2.1 staff after leaving, 3 years ASSUMPTION, LAWYER TO CONFIRM); the staff row is pseudonymous.';
  r_acad constant text := 'Academic record of the pseudonymous student (marks, results, report cards, certificates): education-board and transfer-certificate rules (retention schedule 2.1 students after leaving and open point 1, LAWYER TO CONFIRM).';
  r_crm_owner constant text := 'The CRM pipeline is the school''s: a lead or task stays assigned to a login, which must be reassigned before that login can be erased (the delete of the login is refused while it still owns leads or tasks).';
  r_proof constant text := 'Acknowledgement of a policy is proof that the school informed the person; kept for the relationship plus 3 years like consent records (retention schedule 2.1, CONFIRM).';
begin
  -- ------------------------------------------------------------ CRM: the lead (a family that enquired)
  -- Subject rows: the household, its guardians, its children (prospects) and enquiries. Their ids form the lead (closure).
  -- The household, child and enquiry rows stay as pseudonymous stubs (retention schedule 2.1: "delete or anonymise, keep
  -- counts for reports"): the funnel keeps its counts and the fee payments of the enquiry (crm.payments, cascaded from the
  -- enquiry) are not lost; the parents, the names, the address and everything said or uploaded are removed.
  perform pg_temp.preg('crm', 'households', 'id', array['lead'], 'anonymise', array['address','locality','pincode','home_language','heard_about'], 800,
    'CRM family record of the lead: kept as an empty stub for the funnel counts.', p_subject => true);
  perform pg_temp.preg('crm', 'guardians', 'household_id', array['lead'], 'delete', array['name','phone','alt_phone','email','occupation'], 700,
    'Parents of the lead; phone and email also find messages and consents.', p_contact => array['phone','alt_phone','email'], p_subject => true, p_link => array['id']);
  perform pg_temp.preg('crm', 'prospects', 'household_id', array['lead'], 'anonymise', array['first_name','last_name','dob','gender','current_school','current_grade','special_needs'], 700,
    'Children of the lead (pre-admission): kept as a stub for the funnel counts, the child is removed.', '{"first_name":"Erased person"}', p_audit => array['full_name'], p_subject => true, p_link => array['id']);
  perform pg_temp.preg('crm', 'enquiries', 'household_id', array['lead'], 'anonymise', array['custom','tags','closure_reason','expected_decision'], 600,
    'Enquiries of the lead: stage, grade and dates stay for the funnel counts, custom answers and notes are removed.', '{"custom":{},"tags":[]}', p_subject => true, p_link => array['id','prospect_id']);
  -- everything that hangs off the family or an enquiry
  perform pg_temp.preg('crm', 'activities', 'household_id', array['lead'], 'delete', array['content','outcome','meta'], 100, 'Timeline of the lead.');
  perform pg_temp.preg('crm', 'follow_ups', 'household_id', array['lead'], 'delete', array['title','outcome'], 100, 'Tasks about the lead.');
  perform pg_temp.preg('crm', 'follow_ups', 'enquiry_id', array['lead'], 'delete', array['title','outcome'], 100, 'Tasks about the lead''s enquiries.');
  perform pg_temp.preg('crm', 'visits', 'household_id', array['lead'], 'delete', array['outcome'], 100, 'Campus visits of the lead.');
  perform pg_temp.preg('crm', 'messages', 'household_id', array['lead'], 'delete', array['body','fail_reason','provider_id'], 100, 'WhatsApp/SMS/email conversation with the lead.');
  perform pg_temp.preg('crm', 'applications', 'enquiry_id', array['lead'], 'delete', array['answers','declaration'], 100, 'Application forms of the lead.');
  perform pg_temp.preg('crm', 'enquiry_documents', 'enquiry_id', array['lead'], 'delete', array['file_id','file_name','reject_reason'], 100,
    'Documents uploaded for the lead; the stored objects are deleted through the Storage API with the file rows.');
  perform pg_temp.preg('crm', 'enquiry_sensitive', 'enquiry_id', array['lead'], 'delete', array['data'], 100, 'Sensitive custom fields of the lead (income, health).');
  perform pg_temp.preg('crm', 'source_touches', 'enquiry_id', array['lead'], 'delete', array['source','campaign','utm'], 100, 'Marketing attribution of the lead.');
  perform pg_temp.preg('crm', 'workflow_runs', 'enquiry_id', array['lead'], 'delete', array['log'], 100, 'Automation runs about the lead.');
  perform pg_temp.preg('crm', 'meta_leads', 'enquiry_id', array['lead'], 'delete', array['detail'], 100, 'Meta lead-ad callbacks of the lead.');
  perform pg_temp.preg('crm', 'import_rows', 'enquiry_id', array['lead'], 'delete', array['data','error'], 100, 'Import file rows that created the lead.');
  perform pg_temp.preg('crm', 'import_rows', 'match_household_id', array['lead'], 'delete', array['data','error'], 100, 'Import file rows matched to the lead.');
  perform pg_temp.preg('crm', 'payments', 'enquiry_id', array['lead'], 'anonymise', array['reference'], 100,
    'Registration and application fee payments: the amount and receipt number stay (financial record) on the anonymised enquiry, the payment reference is removed.');
  -- the lead after admission: the CRM rows of an admitted child or its parent are reached from the core student / guardian
  perform pg_temp.preg('crm', 'prospects', 'core_student_id', array['student'], 'anonymise', array['first_name','last_name','dob','gender','current_school','current_grade','special_needs'], 100,
    'Pre-admission record of the student: kept as lead history (retention schedule 2.1), the person is removed.', '{"first_name":"Erased person"}', p_audit => array['full_name']);
  -- (deleted, not anonymised: crm.guardians.phone is required and unique per org, and the core guardian row holds the family link)
  perform pg_temp.preg('crm', 'guardians', 'core_guardian_id', array['guardian'], 'delete', array['name','phone','alt_phone','email','occupation'], 100,
    'Pre-admission record of the guardian.');
  -- staff (counsellors) in the CRM: logins
  perform pg_temp.preg('crm', 'counsellor_settings', 'user_id', array['staff'], 'delete', array['user_id'], 100, 'Capacity and leave flag of the counsellor.');
  perform pg_temp.preg('crm', 'saved_views', 'user_id', array['staff'], 'delete', array['user_id','name','query'], 100, 'Saved lead views of the counsellor.');
  perform pg_temp.preg('crm', 'enquiries', 'owner_id', array['staff'], 'retain', array['owner_id'], 100, 'Leads owned by the counsellor.', p_reason => r_crm_owner);
  perform pg_temp.preg('crm', 'follow_ups', 'owner_id', array['staff'], 'retain', array['owner_id'], 100, 'Tasks owned by the counsellor.', p_reason => r_crm_owner);
  perform pg_temp.preg('crm', 'activities', 'actor_id', array['staff'], 'anonymise', array['actor_id'], 100, 'Timeline entries by the counsellor: the actor is removed.');
  perform pg_temp.preg('crm', 'messages', 'sender_id', array['staff'], 'anonymise', array['sender_id'], 100, 'Messages sent by the counsellor: the sender is removed.');
  perform pg_temp.preg('crm', 'visits', 'host_id', array['staff'], 'anonymise', array['host_id'], 100, 'Visits hosted by the staff member: the host is removed.');
  perform pg_temp.preg('crm', 'enquiry_documents', 'verifier_id', array['staff'], 'anonymise', array['verifier_id'], 100, 'Documents verified by the staff member: the verifier is removed.');
  perform pg_temp.preg('crm', 'payments', 'verified_by', array['staff'], 'anonymise', array['verified_by'], 100, 'Payments verified by the staff member: the verifier is removed.');

  -- ------------------------------------------------------------ OS (staff)
  perform pg_temp.preg('os', 'bot_feedback', 'staff_id', array['staff'], 'delete', array['question','comment'], 40, 'Feedback the staff member gave on help-bot answers.');
  perform pg_temp.preg('os', 'bot_conversations', 'staff_id', array['staff'], 'delete', array['messages','screen_path'], 50, 'Help-bot conversations of the staff member.');
  perform pg_temp.preg('os', 'reporting_lines', 'staff_id', array['staff'], 'delete', array['staff_id','manager_id'], 100, 'Reporting line of the staff member.');
  perform pg_temp.preg('os', 'reporting_lines', 'manager_id', array['staff'], 'delete', array['staff_id','manager_id'], 100, 'Reporting lines to the staff member as manager.');
  perform pg_temp.preg('os', 'staff_roles', 'staff_id', array['staff'], 'delete', array['staff_id'], 100, 'OS roles held by the staff member.');
  perform pg_temp.preg('os', 'saved_reports', 'owner_id', array['staff'], 'anonymise', array['owner_id'], 100, 'Reports saved by the staff member: the owner is removed.');
  perform pg_temp.preg('os', 'checklist_runs', 'owner_id', array['staff'], 'anonymise', array['owner_id'], 100, 'Checklist runs owned by the staff member: the owner is removed.');
  perform pg_temp.preg('os', 'checklist_templates', 'owner_staff_id', array['staff'], 'anonymise', array['owner_staff_id'], 100, 'Checklists owned by the staff member: the owner is removed.');
  perform pg_temp.preg('os', 'compliance_items', 'owner_id', array['staff'], 'anonymise', array['owner_id'], 100, 'Statutory items owned by the staff member: the owner is removed.');
  perform pg_temp.preg('os', 'meeting_actions', 'owner_id', array['staff'], 'anonymise', array['owner_id'], 100, 'Meeting actions owned by the staff member: the owner is removed.');
  perform pg_temp.preg('os', 'meetings', 'organizer_id', array['staff'], 'anonymise', array['organizer_id'], 100, 'Meetings organised by the staff member: the organiser is removed.');
  perform pg_temp.preg('os', 'circulars', 'author_id', array['staff'], 'anonymise', array['author_id'], 100, 'Circulars written by the staff member: the author is removed.');
  perform pg_temp.preg('os', 'circular_receipts', 'staff_id', array['staff'], 'anonymise', array['reply'], 100, 'Circular read receipts: the reply text is removed, the receipt stays.');
  perform pg_temp.preg('os', 'task_comments', 'author_id', array['staff'], 'anonymise', array['author_id'], 100, 'Task comments by the staff member: the author is removed.');
  perform pg_temp.preg('os', 'tasks', 'owner_id', array['staff'], 'retain', array['owner_id'], 100, 'Tasks of the staff member.', p_reason => r_work);
  perform pg_temp.preg('os', 'task_assignees', 'staff_id', array['staff'], 'retain', array['staff_id'], 100, 'Task assignments.', p_reason => r_work);
  perform pg_temp.preg('os', 'annual_plans', 'staff_id', array['staff'], 'retain', array['staff_id'], 100, 'Annual plans.', p_reason => r_work);
  perform pg_temp.preg('os', 'lesson_plans', 'staff_id', array['staff'], 'retain', array['staff_id'], 100, 'Lesson plans.', p_reason => r_work);
  perform pg_temp.preg('os', 'class_logs', 'staff_id', array['staff'], 'retain', array['staff_id'], 100, 'Class logs.', p_reason => r_work);
  perform pg_temp.preg('os', 'duty_assignments', 'staff_id', array['staff'], 'retain', array['staff_id'], 100, 'Duties.', p_reason => r_work);
  perform pg_temp.preg('os', 'invigilation_duties', 'staff_id', array['staff'], 'retain', array['staff_id'], 100, 'Invigilation duties.', p_reason => r_work);
  perform pg_temp.preg('os', 'substitutions', 'absent_staff_id', array['staff'], 'retain', array['absent_staff_id'], 100, 'Substitutions for the staff member.', p_reason => r_work);
  perform pg_temp.preg('os', 'substitutions', 'substitute_staff_id', array['staff'], 'retain', array['substitute_staff_id'], 100, 'Substitutions taken by the staff member.', p_reason => r_work);
  perform pg_temp.preg('os', 'paper_access_log', 'staff_id', array['staff'], 'retain', array['staff_id'], 100, 'Question-paper access log.',
    p_reason => 'Security log of who opened a question paper: evidence for the paper''s life (exam integrity); the staff row is pseudonymous.');
  perform pg_temp.preg('os', 'appraisal_scores', 'staff_id', array['staff'], 'retain', array['staff_id','self_appraisal','manager_rating'], 100, 'Appraisals.', p_reason => r_hr);
  perform pg_temp.preg('os', 'notebook_checks', 'staff_id', array['staff'], 'retain', array['staff_id','notes'], 100, 'Notebook checks of the teacher.', p_reason => r_hr);
  perform pg_temp.preg('os', 'observations', 'teacher_id', array['staff'], 'retain', array['teacher_id','feedback','teacher_reflection'], 100, 'Classroom observations of the teacher.', p_reason => r_hr);
  perform pg_temp.preg('os', 'trainings', 'staff_id', array['staff'], 'retain', array['staff_id','certificate_path'], 100, 'Training record.', p_reason => r_hr);

  -- ------------------------------------------------------------ ERP: students
  perform pg_temp.preg('erp', 'gate_passes', 'student_id', array['student'], 'anonymise', array['reason','collector_name','collector_phone','pickup_person_id','verified_by_name'], 50,
    'Gate passes of the student: the gate log stays (security), the people and reasons are removed.');
  perform pg_temp.preg('erp', 'student_sensitive', 'student_id', array['student'], 'delete', array['medical_notes','doctor_name','doctor_phone','emergency_contact','vaccination','aadhaar_last4','cwsn','cwsn_details'], 100, 'Medical, emergency and Aadhaar data: deleted.');
  perform pg_temp.preg('erp', 'pickup_persons', 'student_id', array['student'], 'delete', array['name','relation','phone','photo_file_id'], 100, 'People allowed to collect the student.');
  perform pg_temp.preg('erp', 'alumni_profiles', 'student_id', array['student'], 'delete', array['email','phone','city','occupation','organisation','notes'], 100, 'Alumni contact profile.', p_contact => array['email','phone']);
  perform pg_temp.preg('erp', 'health_checks', 'student_id', array['student'], 'delete', array['height_cm','weight_kg','bmi','vision','dental','notes'], 100, 'Health checks: deleted.');
  perform pg_temp.preg('erp', 'infirmary_visits', 'student_id', array['student'], 'delete', array['complaint','treatment','action'], 100, 'Infirmary visits: deleted.');
  perform pg_temp.preg('erp', 'counselling_referrals', 'student_id', array['student'], 'delete', array['reason','notes'], 100, 'Counselling referrals: deleted.');
  perform pg_temp.preg('erp', 'growth_records', 'student_id', array['student'], 'delete', array['title','note','category'], 100, 'Teacher and counsellor notes about the student.');
  perform pg_temp.preg('erp', 'post_admission_tasks', 'student_id', array['student'], 'delete', array['task'], 100, 'Joining checklist.');
  perform pg_temp.preg('erp', 'post_submissions', 'student_id', array['student'], 'delete', array['body','file_id','feedback'], 100, 'Homework submissions.');
  perform pg_temp.preg('erp', 'stored_documents', 'student_id', array['student'], 'delete', array['file_id','notes'], 100, 'Document copies (birth certificate, ID): the stored objects are deleted through the Storage API.');
  perform pg_temp.preg('erp', 'reading_logs', 'student_id', array['student'], 'delete', array['title','note'], 100, 'Reading log.');
  perform pg_temp.preg('erp', 'size_history', 'student_id', array['student'], 'delete', array['item','size'], 100, 'Uniform sizes.');
  perform pg_temp.preg('erp', 'meal_bookings', 'student_id', array['student'], 'delete', array['item'], 100, 'Meal bookings.');
  perform pg_temp.preg('erp', 'book_reservations', 'student_id', array['student'], 'delete', array['student_id'], 100, 'Library reservations.');
  perform pg_temp.preg('erp', 'student_group_members', 'student_id', array['student'], 'delete', array['role'], 100, 'Club and group memberships.');
  perform pg_temp.preg('erp', 'event_registrations', 'student_id', array['student'], 'delete', array['team','result','position'], 100, 'Event registrations.');
  perform pg_temp.preg('erp', 'student_transport', 'student_id', array['student'], 'delete', array['stop_id'], 100, 'Transport allocation (fees are on the fee demands).');
  perform pg_temp.preg('erp', 'trip_events', 'student_id', array['student'], 'delete', array['note','lat','lng'], 100, 'Boarding events on bus trips.');
  perform pg_temp.preg('erp', 'hostel_allocations', 'student_id', array['student'], 'delete', array['bed'], 100, 'Hostel allocation.');
  perform pg_temp.preg('erp', 'appointments', 'student_id', array['student'], 'delete', array['reason','requested_by_name'], 100, 'Appointment requests about the student.');
  perform pg_temp.preg('erp', 'conversations', 'student_id', array['student'], 'delete', array['subject','parent_name'], 100, 'Parent-teacher conversations about the student (messages go with them).');
  perform pg_temp.preg('erp', 'form_responses', 'student_id', array['student'], 'delete', array['answers'], 100, 'Form answers about the student.');
  perform pg_temp.preg('erp', 'announcement_recipients', 'student_id', array['student'], 'delete', array['title','body'], 100, 'Announcement deliveries about the student.');
  perform pg_temp.preg('erp', 'house_points', 'student_id', array['student'], 'anonymise', array['student_id','reason'], 100, 'House points: the points stay for the house, the student is removed.');
  perform pg_temp.preg('erp', 'council_positions', 'student_id', array['student'], 'anonymise', array['student_id','votes'], 100, 'Student council positions: the position stays, the student is removed.');
  perform pg_temp.preg('erp', 'loans', 'student_id', array['student'], 'anonymise', array['student_id'], 100, 'Library loans: the loan and fine stay for the library, the borrower is removed.');
  perform pg_temp.preg('erp', 'ptm_slots', 'student_id', array['student'], 'anonymise', array['student_id','booked_by','notes','feedback'], 100, 'PTM bookings: the slot stays, the family and notes are removed.');
  perform pg_temp.preg('erp', 'sales', 'student_id', array['student'], 'anonymise', array['student_id'], 100, 'Counter sales: the sale stays (financial record), the buyer is removed.');
  perform pg_temp.preg('erp', 'safeguarding_incidents', 'student_id', array['student'], 'retain', array['student_id','description','action_taken'], 100, 'Safeguarding incidents.',
    p_reason => 'Safeguarding and legal records are kept until counsel has decided the period (retention schedule 2.1 and open point 1); access exports include them.');
  perform pg_temp.preg('erp', 'assessment_results', 'student_id', array['student'], 'anonymise', array['remark'], 100, 'Marks: the mark stays on the pseudonymous student row, the remark is removed.');
  perform pg_temp.preg('erp', 'rubric_results', 'student_id', array['student'], 'retain', array['student_id'], 100, 'Rubric results.', p_reason => r_acad);
  perform pg_temp.preg('erp', 'report_cards', 'student_id', array['student'], 'retain', array['student_id','class_teacher_remark','principal_remark','snapshot'], 100, 'Report cards.', p_reason => r_acad);
  perform pg_temp.preg('erp', 'external_exam_results', 'student_id', array['student'], 'retain', array['student_id','notes'], 100, 'Board and external exam results.', p_reason => r_acad);
  perform pg_temp.preg('erp', 'test_attempts', 'student_id', array['student'], 'retain', array['student_id','answers'], 100, 'Online test attempts.', p_reason => r_acad);
  perform pg_temp.preg('erp', 'issued_documents', 'student_id', array['student'], 'retain', array['student_id','data','body'], 100, 'Certificates issued (TC, bonafide).',
    p_reason => r_acad || ' Issued certificates must stay verifiable by their verify code.');
  -- student money: never deleted by a person erasure
  perform pg_temp.preg('erp', 'fee_demands', 'student_id', array['student'], 'anonymise', array['note'], 100, 'Fee demands: amounts stay, the note is removed.', p_reason => null);
  perform pg_temp.preg('erp', 'receipts', 'student_id', array['student'], 'anonymise', array['note'], 100, 'Fee receipts (immutable money table): amounts stay, the note is removed (the compliance engine is the only writer allowed through the money guard).');
  perform pg_temp.preg('erp', 'receipt_allocations', 'student_id', array['student'], 'retain', array['student_id'], 100, 'Receipt allocations.', p_reason => r_fin);
  perform pg_temp.preg('erp', 'concessions', 'student_id', array['student'], 'anonymise', array['reason','document_file_id'], 100, 'Concessions: the amount stays, the reason and proof document are removed.');
  perform pg_temp.preg('erp', 'refunds', 'student_id', array['student'], 'anonymise', array['reason','reference'], 100, 'Refunds: the amount stays, the reason and reference are removed.', '{"reason":"Erased"}');
  perform pg_temp.preg('erp', 'deposits', 'student_id', array['student'], 'anonymise', array['note'], 100, 'Caution deposits: the amount stays, the note is removed.');
  perform pg_temp.preg('erp', 'payment_orders', 'student_id', array['student'], 'retain', array['student_id'], 100, 'Online payment orders.', p_reason => r_fin);
  perform pg_temp.preg('erp', 'rte_claims', 'student_id', array['student'], 'retain', array['student_id','reference'], 100, 'RTE reimbursement claims.', p_reason => r_fin || ' RTE claims are also evidence towards the government.');
  perform pg_temp.preg('erp', 'student_wallets', 'student_id', array['student'], 'retain', array['student_id'], 100, 'Canteen/store wallet.', p_reason => r_fin);
  perform pg_temp.preg('erp', 'student_wallet_txns', 'student_id', array['student'], 'anonymise', array['note'], 100, 'Wallet transactions: amounts stay, notes are removed.');
  perform pg_temp.preg('erp', 'store_orders', 'student_id', array['student'], 'anonymise', array['sizes_note'], 100, 'Store orders: the order stays (financial record), the size note is removed.');
  perform pg_temp.preg('erp', 'fee_followups', 'student_id', array['student'], 'delete', array['note','promise_date','promise_amount','outcome','by_name'], 100, 'Fee collection follow-up notes about the family.');

  -- ------------------------------------------------------------ ERP: logins (guardians, students, staff)
  perform pg_temp.preg('erp', 'announcement_recipients', 'user_id', logins, 'delete', array['title','body'], 100, 'Announcements delivered to the login.');
  perform pg_temp.preg('erp', 'form_responses', 'user_id', logins, 'delete', array['answers'], 100, 'Form answers of the login.');
  perform pg_temp.preg('erp', 'broadcast_acks', 'user_id', logins, 'delete', array['user_id'], 100, 'Emergency broadcast acknowledgements of the login.');
  perform pg_temp.preg('erp', 'policy_acks', 'user_id', logins, 'retain', array['user_id'], 100, 'Policy acknowledgements of the login.', p_reason => r_proof);
  perform pg_temp.preg('erp', 'conversations', 'parent_user', array['guardian'], 'delete', array['subject','parent_name'], 100, 'Conversations the parent started (messages go with them).');
  perform pg_temp.preg('erp', 'conversation_messages', 'sender', logins, 'anonymise', array['sender','sender_name','body'], 100, 'Messages written by the login in a conversation.', '{"body":"(erased)"}');
  perform pg_temp.preg('erp', 'appointments', 'requested_by', family, 'anonymise', array['requested_by','requested_by_name','reason'], 100, 'Appointments the login asked for.');
  perform pg_temp.preg('erp', 'gate_passes', 'requested_by', family, 'anonymise', array['requested_by','reason','collector_name','collector_phone'], 50, 'Gate passes the login asked for.');
  perform pg_temp.preg('erp', 'ptm_slots', 'booked_by', family, 'anonymise', array['booked_by','notes','feedback'], 100, 'PTM slots the login booked.');
  -- visitors are found by phone (a parent or a lead who visited)
  perform pg_temp.preg('erp', 'visitors', null, array['guardian','lead'], 'anonymise', array['name','phone','id_type','id_number_last4','photo_file_id','vehicle_no','material_details'], 100,
    'Visitor log entries of the person (matched by phone): the visit stays, the person is removed.', '{"name":"Erased person"}', p_contact => array['phone']);

  -- ------------------------------------------------------------ ERP: staff, HR and payroll
  perform pg_temp.preg('erp', 'staff_payroll', 'staff_id', array['staff'], 'anonymise', array['bank_name','bank_account','ifsc','address','emergency_contact','aadhaar_last4'], 100,
    'Payroll profile: bank, address, emergency contact and Aadhaar are removed; PAN, UAN and ESI number stay with the statutory returns (CONFIRM with counsel).');
  perform pg_temp.preg('erp', 'staff_hr_profiles', 'staff_id', array['staff'], 'delete', array['qualifications','experience_years','licence_no','licence_expiry'], 100, 'HR profile (qualifications, background check, licence).');
  perform pg_temp.preg('erp', 'onboarding_checklists', 'staff_id', array['staff'], 'delete', array['items'], 100, 'Onboarding checklist.');
  perform pg_temp.preg('erp', 'staff_feedback', 'staff_id', array['staff'], 'delete', array['note'], 100, 'Feedback about the staff member.');
  perform pg_temp.preg('erp', 'stored_documents', 'staff_id', array['staff'], 'delete', array['file_id','notes'], 100, 'Document copies of the staff member: the stored objects are deleted through the Storage API.');
  perform pg_temp.preg('erp', 'staff_exits', 'staff_id', array['staff'], 'anonymise', array['reason'], 100, 'Exit record: dates and full-and-final amount stay, the reason is removed.');
  perform pg_temp.preg('erp', 'salary_structures', 'staff_id', array['staff'], 'retain', array['staff_id'], 100, 'Salary structures.', p_reason => r_pay);
  perform pg_temp.preg('erp', 'payslips', 'staff_id', array['staff'], 'retain', array['staff_id'], 100, 'Payslips.', p_reason => r_pay);
  perform pg_temp.preg('erp', 'payroll_adjustments', 'staff_id', array['staff'], 'retain', array['staff_id','note'], 100, 'Payroll adjustments.', p_reason => r_pay);
  perform pg_temp.preg('erp', 'staff_loans', 'staff_id', array['staff'], 'retain', array['staff_id'], 100, 'Staff loans and advances.', p_reason => r_pay);
  perform pg_temp.preg('erp', 'tax_declarations', 'staff_id', array['staff'], 'retain', array['staff_id','declarations'], 100, 'Income-tax declarations.', p_reason => r_pay);
  perform pg_temp.preg('erp', 'student_wallets', 'staff_id', array['staff'], 'retain', array['staff_id'], 100, 'Staff canteen wallet.', p_reason => r_fin);
  perform pg_temp.preg('erp', 'issued_documents', 'staff_id', array['staff'], 'retain', array['staff_id','data','body'], 100, 'Letters issued to the staff member (experience, relieving).',
    p_reason => 'Issued letters must stay verifiable by their verify code; kept with the staff file (retention schedule 2.1, CONFIRM).');
  perform pg_temp.preg('erp', 'ptm_slots', 'staff_id', array['staff'], 'retain', array['staff_id'], 100, 'PTM slots of the teacher.', p_reason => r_work);
  perform pg_temp.preg('erp', 'assessments', 'staff_id', array['staff'], 'anonymise', array['staff_id'], 100, 'Assessments set by the teacher: the teacher is removed.');
  perform pg_temp.preg('erp', 'online_classes', 'staff_id', array['staff'], 'anonymise', array['staff_id'], 100, 'Online classes of the teacher: the teacher is removed.');
  perform pg_temp.preg('erp', 'student_groups', 'staff_id', array['staff'], 'anonymise', array['staff_id'], 100, 'Groups led by the staff member: the lead is removed.');
  perform pg_temp.preg('erp', 'loans', 'staff_id', array['staff'], 'anonymise', array['staff_id'], 100, 'Library loans of the staff member: the borrower is removed.');
  perform pg_temp.preg('erp', 'sales', 'staff_id', array['staff'], 'anonymise', array['staff_id'], 100, 'Counter sales to the staff member: the buyer is removed.');
  perform pg_temp.preg('erp', 'visitors', 'host_staff_id', array['staff'], 'anonymise', array['host_staff_id','host_name'], 100, 'Visitors hosted by the staff member: the host is removed.');
  perform pg_temp.preg('erp', 'job_applications', null, array['staff'], 'delete', array['name','phone','email','notes','scores','resume_file_id'], 100,
    'Job applications of the person (matched by phone and email; an applicant who never joined is erased as staff with the phone/email given).', p_contact => array['phone','email']);
  -- who did it: the actor's login and name are removed, the record stays
  perform pg_temp.preg('erp', 'receipts', 'collected_by_user_id', array['staff'], 'anonymise', array['collected_by_user_id','collected_by_name'], 100, 'Receipts the staff member collected: the collector is removed, the receipt stays.');
  perform pg_temp.preg('erp', 'sales', 'sold_by_user_id', array['staff'], 'anonymise', array['sold_by_user_id','sold_by_name'], 100, 'Sales the staff member made: the seller is removed.');
  perform pg_temp.preg('erp', 'issued_documents', 'issued_by_user_id', array['staff'], 'anonymise', array['issued_by_user_id','issued_by_name'], 100, 'Documents the staff member issued: the issuer is removed.');
  perform pg_temp.preg('erp', 'announcements', 'sent_by_user_id', array['staff'], 'anonymise', array['sent_by_user_id','sent_by_name'], 100, 'Announcements the staff member sent: the sender is removed.');
  perform pg_temp.preg('erp', 'emergency_broadcasts', 'sent_by_user_id', array['staff'], 'anonymise', array['sent_by_user_id','sent_by_name'], 100, 'Emergency broadcasts the staff member sent: the sender is removed.');
  perform pg_temp.preg('erp', 'fee_followups', 'by_user_id', array['staff'], 'anonymise', array['by_user_id','by_name'], 100, 'Fee follow-ups made by the staff member: the caller is removed.');
  perform pg_temp.preg('erp', 'growth_records', 'recorded_by_user_id', array['staff'], 'anonymise', array['recorded_by_user_id','recorded_by_name'], 100, 'Notes the staff member recorded: the author is removed.');
  perform pg_temp.preg('erp', 'gate_passes', 'verified_by_user_id', array['staff'], 'anonymise', array['verified_by_user_id','verified_by_name'], 50, 'Gate passes the staff member verified: the verifier is removed.');

  -- ------------------------------------------------------------ AI generations and credits (OS stream, core and billing)
  perform pg_temp.preg('core', 'ai_generations', 'user_id', logins, 'anonymise', array['user_id','staff_id','input','output','error'], 100,
    'AI requests of the login: the prompt and answer are removed, the usage row stays for credit accounting.', '{"input":{}}');
  perform pg_temp.preg('core', 'ai_generations', 'staff_id', array['staff'], 'anonymise', array['user_id','staff_id','input','output','error'], 100,
    'AI requests of the staff member: the prompt and answer are removed, the usage row stays for credit accounting.', '{"input":{}}');
  perform pg_temp.preg('billing', 'ai_credit_ledger', 'staff_id', array['staff'], 'anonymise', array['staff_id','note'], 100, 'AI credit usage of the staff member: the credits stay, the person is removed.');
  perform pg_temp.preg('billing', 'credit_topup_requests', 'requested_by_user_id', array['staff'], 'anonymise', array['requested_by_user_id','requested_by_staff_id','note'], 100, 'Credit top-up requests: the requester is removed.');
  perform pg_temp.preg('billing', 'credit_topup_requests', 'requested_by_staff_id', array['staff'], 'anonymise', array['requested_by_user_id','requested_by_staff_id','note'], 100, 'Credit top-up requests: the requester is removed.');
end $$;

-- Reviewed exemptions: product tables that look personal by column name but hold no person.
insert into core.pii_registry (schema_name, table_name, classification, exempt_reason) values
  ('crm', 'settings', 'exempt', 'system_user_id is the CRM automation login of the organisation (a service identity, not a person).'),
  ('erp', 'accounts', 'exempt', 'parent_id is the parent account in the chart of accounts, not a parent of a learner.'),
  ('erp', 'vendors', 'exempt', 'Supplier business contact (name, GST number, phone, email, address) of the school''s vendors; exported and deleted with the organisation.'),
  ('os', 'checklist_responses', 'exempt', 'photo_path is photo evidence of a facility checklist item (rooms, equipment), not a photo of a person; deleted with the organisation.'),
  ('billing', 'plans', 'exempt', 'AutoEd price list: whatsapp_included is a message allowance, not a contact.');

-- ================================================================ table policy: org / product deletion
-- Immutable money tables are never edited or deleted by a request (erp.immutable_rows). They are client data: they go
-- with the organisation or the ERP product, after the exit export (decision 42), through app._compliance_delete_scope,
-- the only caller the guard lets through. A person erasure never deletes them (registry rows above: anonymise / retain).
insert into core.table_policy (schema_name, table_name, org_deletion, org_export, note) values
  ('erp', 'receipts', 'delete', true, 'Immutable money table: deleted only with the organisation / ERP product after the exit export (guard lets the compliance deletion through); a person erasure anonymises notes only.'),
  ('erp', 'receipt_payments', 'delete', true, 'Immutable money table: deleted only with the organisation / ERP product after the exit export.'),
  ('erp', 'receipt_allocations', 'delete', true, 'Immutable money table: deleted only with the organisation / ERP product after the exit export.'),
  ('erp', 'vouchers', 'delete', true, 'Immutable ledger: deleted only with the organisation / ERP product after the exit export.'),
  ('erp', 'voucher_lines', 'delete', true, 'Immutable ledger: deleted only with the organisation / ERP product after the exit export.'),
  ('crm', 'wallet_ledger', 'delete', true, 'Append-only messaging wallet ledger (crm.guard_wallet stops request roles); deleted with the organisation / CRM product after the exit export.');

-- ================================================================ retention rules (all DISABLED drafts, CONFIRM with counsel)
insert into core.retention_policies (scope, data_type, description, product_key, schema_name, table_name, date_column, filter_column, filter_values,
                                     action, anonymise_columns, anonymise_values, period_value, period_unit, enabled, legal_status, legal_note) values
  -- leads (retention schedule 2.1: CRM leads and enquiries not admitted, 24 months after the last activity)
  ('table', 'crm_enquiries_inactive', 'CRM enquiries with no activity for the period.', 'crm', 'crm', 'enquiries', 'last_activity_at', null, null,
   'delete', '{}', '{}', 24, 'months', false, 'draft',
   'LAWYER TO CONFIRM (12 to 36 months; minors may need shorter). Before enabling: the purge must skip enquiries of admitted children (prospects.core_student_id set) and remove the family rows with them; the rule engine filters on one column only.'),
  ('table', 'crm_messages', 'CRM WhatsApp/SMS/email message content.', 'crm', 'crm', 'messages', 'created_at', null, null,
   'delete', '{}', '{}', 12, 'months', false, 'draft', 'ASSUMPTION 12 months (retention schedule 2.1 messages); LAWYER TO CONFIRM.'),
  -- messages (core outbox: content removed, delivery metadata kept)
  ('table', 'outbox_message_content', 'Text and address of sent messages (delivery metadata stays).', null, 'core', 'outbox', 'created_at', null, null,
   'anonymise', array['body','error','provider_ref'], '{"to_address":"erased"}', 12, 'months', false, 'draft',
   'ASSUMPTION 12 months for content, metadata 12 more months (retention schedule 2.1 messages); LAWYER TO CONFIRM.'),
  ('table', 'erp_conversation_messages', 'Parent-teacher conversation messages.', 'erp', 'erp', 'conversation_messages', 'created_at', null, null,
   'delete', '{}', '{}', 12, 'months', false, 'draft', 'ASSUMPTION 12 months (retention schedule 2.1 messages); LAWYER TO CONFIRM.'),
  ('table', 'erp_announcement_recipients', 'Per-recipient announcement deliveries.', 'erp', 'erp', 'announcement_recipients', 'created_at', null, null,
   'delete', '{}', '{}', 12, 'months', false, 'draft', 'ASSUMPTION 12 months (retention schedule 2.1 messages); LAWYER TO CONFIRM.'),
  -- AI logs (retention schedule 2.2: 12 months for usage detail; prompts and answers removed, the usage row stays)
  ('table', 'ai_generations', 'AI prompts and answers (the usage row stays for credits).', null, 'core', 'ai_generations', 'created_at', null, null,
   'anonymise', array['output','error'], '{"input":{}}', 12, 'months', false, 'draft', 'ASSUMPTION 12 months (retention schedule 2.2 AI logs); LAWYER TO CONFIRM.'),
  -- students and staff after leaving: the profile becomes pseudonymous (the same columns as a person erasure)
  ('table', 'students_after_leaving', 'Student profile after the learner left.', null, 'core', 'students', 'left_on', 'status', array['withdrawn','transferred','alumni'],
   'anonymise', array['last_name','dob','apaar_id','pen','photo_file_id','previous_school','user_id','crm_prospect_id','house','mother_tongue','nationality'], '{"first_name":"Erased person","custom":{}}', 84, 'months', false, 'draft',
   'ASSUMPTION 7 years for the core academic record (retention schedule 2.1 students after leaving and open point 1); other student data 1 year is not yet a rule; LAWYER TO CONFIRM.'),
  ('table', 'staff_after_leaving', 'Staff profile after the employee left.', null, 'core', 'staff', 'left_on', 'status', array['left'],
   'anonymise', array['last_name','email','phone','dob','photo_file_id','employee_code','user_id'], '{"first_name":"Erased person","custom":{},"ui_prefs":{}}', 36, 'months', false, 'draft',
   'ASSUMPTION 3 years for profile data; payroll and statutory records follow the financial rules (retention schedule 2.1 staff after leaving); LAWYER TO CONFIRM.'),
  -- financial records the client keeps in the ERP: about 8 years (one rule per table; children before parents, rules run in data_type order)
  ('table', 'erp_fin_1_receipt_allocations', 'Receipt allocations older than the financial-record period.', 'erp', 'erp', 'receipt_allocations', 'created_at', null, null,
   'delete', '{}', '{}', 96, 'months', false, 'draft', 'CONFIRM about 8 years from the end of the financial year (Companies Act, GST, income tax; retention schedule 2.1 financial records); LAWYER TO CONFIRM.'),
  ('table', 'erp_fin_2_receipt_payments', 'Receipt payment lines older than the financial-record period.', 'erp', 'erp', 'receipt_payments', 'created_at', null, null,
   'delete', '{}', '{}', 96, 'months', false, 'draft', 'CONFIRM about 8 years (retention schedule 2.1 financial records); LAWYER TO CONFIRM.'),
  ('table', 'erp_fin_3_receipts', 'Fee receipts older than the financial-record period.', 'erp', 'erp', 'receipts', 'date', null, null,
   'delete', '{}', '{}', 96, 'months', false, 'draft', 'CONFIRM about 8 years (retention schedule 2.1 financial records); LAWYER TO CONFIRM.'),
  ('table', 'erp_fin_4_fee_demands', 'Fee demands older than the financial-record period.', 'erp', 'erp', 'fee_demands', 'due_date', null, null,
   'delete', '{}', '{}', 96, 'months', false, 'draft', 'CONFIRM about 8 years (retention schedule 2.1 financial records); LAWYER TO CONFIRM.'),
  ('table', 'erp_fin_5_voucher_lines', 'Ledger voucher lines older than the financial-record period.', 'erp', 'erp', 'voucher_lines', 'created_at', null, null,
   'delete', '{}', '{}', 96, 'months', false, 'draft', 'CONFIRM about 8 years (retention schedule 2.1 financial records); LAWYER TO CONFIRM.'),
  ('table', 'erp_fin_6_vouchers', 'Ledger vouchers older than the financial-record period.', 'erp', 'erp', 'vouchers', 'date', null, null,
   'delete', '{}', '{}', 96, 'months', false, 'draft', 'CONFIRM about 8 years (retention schedule 2.1 financial records); LAWYER TO CONFIRM.'),
  ('table', 'erp_fin_7_payslips', 'Payslips older than the statutory payroll period.', 'erp', 'erp', 'payslips', 'created_at', null, null,
   'delete', '{}', '{}', 96, 'months', false, 'draft', 'CONFIRM about 8 years (PF/ESI/TDS and labour law; retention schedule 2.1 staff after leaving); LAWYER TO CONFIRM.');
