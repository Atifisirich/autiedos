/**
 * Core master-data rows for one org (20261115100001..8), written as the table owner. Called for org A and
 * org B by fixture.ts; every core table gets at least one row per org (the harness fails otherwise).
 *
 * Per org: a "linked" household with the portal guardian, the learner and a sibling; a second household
 * with another learner; an admin staff row (linked to the admin login), another staff row without a login,
 * and in org A a teacher staff row (linked to the teacher login, home branch a1).
 */
import type pg from 'pg';

type Q = (sql: string, params?: unknown[]) => Promise<pg.QueryResult>;

export interface CoreOrgInput {
  org: string;
  branch: string;
  admin: string;          // auth user id of the org admin (staff)
  guardian: string;       // auth user id of the portal guardian/parent
  teacher?: string;       // auth user id of a teacher (org A only)
}

export async function seedCore(q: Q, o: CoreOrgInput) {
  const ins = async (table: string, row: Record<string, unknown>): Promise<string> => {
    const keys = Object.keys(row);
    const sql = `insert into core.${table} (org_id, ${keys.join(', ')}) values ($1, ${keys.map((_, i) => `$${i + 2}`).join(', ')}) returning id`;
    return (await q(sql, [o.org, ...keys.map((k) => row[k])])).rows[0].id as string;
  };
  const tag = o.org.slice(0, 8);

  // ------------------------------------------------------------ structure
  await ins('terminology', { key: 'section', singular: 'Batch', plural: 'Batches' });
  const file = await ins('files', { bucket: 'core-files', storage_path: `${o.org}/docs/report.pdf`, file_name: 'report.pdf', mime: 'application/pdf', size_bytes: 1024 });
  await ins('custom_fields', { entity: 'student', key: 'bus_route', label: 'Bus route' });
  const year = await ins('academic_years', { name: '2026-27', starts_on: '2026-06-01', ends_on: '2027-03-31', is_current: true, status: 'active' });
  const term = await ins('terms', { academic_year_id: year, name: 'Term 1', seq: 1 });
  await ins('number_series', { key: 'admission_no', prefix: `${tag}/`, academic_year_id: year });
  const wing = await ins('wings', { name: 'Senior', board: 'CBSE' });
  const room = await ins('rooms', { branch_id: o.branch, name: 'Room 8A', capacity: 40 });
  const dept = await ins('departments', { name: 'Science' });
  const pos = await ins('positions', { key: 'teacher', name: 'Teacher', rank: 50, is_teaching: true });
  const prog = await ins('programmes', { branch_id: o.branch, wing_id: wing, name: 'Class 8', board: 'CBSE', level: 8 });
  const subj = await ins('subjects', { name: 'Science', code: 'SCI', department_id: dept });
  await ins('programme_subjects', { programme_id: prog, subject_id: subj, periods_per_week: 6 });

  // ------------------------------------------------------------ people
  const adminStaff = await ins('staff', { user_id: o.admin, first_name: 'Admin', last_name: tag, employee_code: 'E001', position_id: pos, department_id: dept, staff_type: 'admin' });
  const otherStaff = await ins('staff', { first_name: 'Other', last_name: 'Teacher', employee_code: 'E002', branch_id: o.branch, position_id: pos, reports_to: adminStaff });
  const teacherStaff = o.teacher
    ? await ins('staff', { user_id: o.teacher, first_name: 'Teacher', employee_code: 'E003', branch_id: o.branch, position_id: pos, reports_to: adminStaff })
    : null;
  await q(`update core.departments set head_staff_id = $1 where id = $2`, [adminStaff, dept]);
  const section = await ins('sections', { programme_id: prog, academic_year_id: year, name: '8A', class_teacher_id: teacherStaff ?? otherStaff, room_id: room });
  const fam = await ins('households', { family_name: 'Linked family', city: 'Hyderabad' });
  const otherFam = await ins('households', { family_name: 'Other family' });
  const guardian = await ins('guardians', { household_id: fam, name: 'Linked guardian', relation: 'mother', phone: `+91900${tag.slice(0, 7)}`, user_id: o.guardian, is_primary: true });
  await ins('guardians', { household_id: otherFam, name: 'Other guardian', relation: 'father' });
  const student = (first: string, household: string, adm: string) =>
    ins('students', { branch_id: o.branch, household_id: household, first_name: first, last_name: tag, admission_no: adm, status: 'active', programme_id: prog, section_id: section, roll_no: adm });
  const learner = await student('Learner', fam, '1');
  const sibling = await student('Sibling', fam, '2');
  const other = await student('Other', otherFam, '3');
  for (const s of [learner, other]) await ins('student_sensitive', { student_id: s, blood_group: 'O+', allergies: 'peanuts', social_category: 'general' });
  for (const s of [learner, sibling, other]) await ins('enrolments', { student_id: s, academic_year_id: year, programme_id: prog, section_id: section });
  await ins('student_status_events', { student_id: learner, from_status: 'admitted', to_status: 'active', reason: 'fixture' });

  // ------------------------------------------------------------ approvals
  const aType = await ins('approval_types', { key: 'leave', name: 'Leave', product_key: 'os' });
  const flow = await ins('approval_flows', { approval_type_id: aType, name: 'Default' });
  await ins('approval_steps', { flow_id: flow, seq: 1, approver_kind: 'role', approver_role_key: 'principal' });
  const req = await ins('approval_requests', { approval_type_id: aType, flow_id: flow, product_key: 'os', applicant_user_id: o.admin, applicant_staff_id: adminStaff, title: 'Admin request' });
  await ins('approval_requests', { approval_type_id: aType, product_key: 'erp', applicant_user_id: o.guardian, title: 'Guardian request', student_id: learner });
  await ins('approval_actions', { request_id: req, step_seq: 1, actor_user_id: o.admin, action: 'submit' });
  await ins('delegations', { staff_id: adminStaff, delegate_id: otherStaff, starts_on: '2026-11-01', ends_on: '2026-11-30' });

  // ------------------------------------------------------------ calendar, timetable, exams, posts
  await ins('calendar_events', { title: 'Annual day', starts_on: '2026-12-20', layer: 'event', audience: 'all' });
  await ins('calendar_events', { title: 'Staff meeting', starts_on: '2026-12-01', layer: 'staff_meeting', audience: 'staff' });
  await ins('events', { name: 'Science fair', event_date: '2027-01-15', owner_staff_id: adminStaff });
  const bell = await ins('bell_schedules', { wing_id: wing, name: 'Weekdays' });
  await ins('periods', { bell_schedule_id: bell, seq: 1, label: 'P1', starts_at: '09:00', ends_at: '09:45' });
  await ins('teacher_allocations', { academic_year_id: year, staff_id: teacherStaff ?? otherStaff, section_id: section, subject_id: subj, periods_per_week: 6 });
  const ver = await ins('timetable_versions', { academic_year_id: year, name: 'v1', status: 'published' });
  await ins('timetable_entries', { version_id: ver, day: 1, period_seq: 1, section_id: section, subject_id: subj, staff_id: teacherStaff ?? otherStaff, room_id: room });
  const eType = await ins('exam_types', { key: 'unit_test', name: 'Unit test' });
  const exam = await ins('exams', { academic_year_id: year, term_id: term, exam_type_id: eType, name: 'UT1' });
  const sched = await ins('exam_schedules', { exam_id: exam, programme_id: prog, subject_id: subj, exam_date: '2026-12-10', max_marks: 25 });
  for (const s of [learner, other]) await ins('exam_seating', { exam_schedule_id: sched, student_id: s, room_id: room, seat_no: s === learner ? '1' : '2' });
  await ins('question_bank', { subject_id: subj, content: JSON.stringify({ text: 'What is a cell?' }), marks: 2 });
  await ins('class_posts', { section_id: section, subject_id: subj, title: 'Section homework', status: 'published' });
  await ins('class_posts', { section_id: section, student_id: other, title: 'Note for other learner', status: 'published', type: 'note' });
  await ins('class_posts', { section_id: section, title: 'Draft homework', status: 'draft' });

  // ------------------------------------------------------------ attendance and leave
  await ins('attendance_rules', { applies_to: 'staff', position_id: pos });
  const device = await ins('devices', { kind: 'biometric', name: 'Gate reader', branch_id: o.branch });
  const imp = await ins('attendance_imports', { kind: 'staff', file_id: file, status: 'done' });
  for (const s of [adminStaff, otherStaff, ...(teacherStaff ? [teacherStaff] : [])]) {
    await ins('staff_attendance', { staff_id: s, date: '2026-11-23', status: 'present', source: 'biometric', device_id: device, import_id: imp, branch_id: o.branch });
  }
  const cl = await ins('leave_types', { key: 'cl', name: 'Casual leave', yearly_quota: 12 });
  const sick = await ins('leave_types', { key: 'sick', name: 'Sick leave', applies_to: 'student' });
  await ins('leave_requests', { staff_id: otherStaff, leave_type_id: cl, start_date: '2026-11-25', end_date: '2026-11-25', days: 1 });
  await ins('leave_balances', { staff_id: otherStaff, leave_type_id: cl, academic_year_id: year, opening: 12 });
  const sl = await ins('student_leave_requests', { student_id: learner, leave_type_id: sick, start_date: '2026-11-20', end_date: '2026-11-20', requested_by_user_id: o.guardian });
  await ins('student_leave_requests', { student_id: other, leave_type_id: sick, start_date: '2026-11-21', end_date: '2026-11-21' });
  const sess = await ins('student_attendance_sessions', { section_id: section, date: '2026-11-20', status: 'submitted', marked_by_staff_id: teacherStaff ?? otherStaff });
  await ins('student_attendance_marks', { session_id: sess, student_id: learner, date: '2026-11-20', status: 'on_leave', student_leave_request_id: sl });
  await ins('student_attendance_marks', { session_id: sess, student_id: sibling, date: '2026-11-20', status: 'present' });
  await ins('student_attendance_marks', { session_id: sess, student_id: other, date: '2026-11-20', status: 'absent' });

  // ------------------------------------------------------------ comms, helpdesk, compliance
  const tpl = await ins('message_templates', { product_key: 'erp', event_key: 'absent', name: 'Absent alert', channel: 'whatsapp', body: '{{name}} is absent today' });
  await ins('notification_rules', { product_key: 'erp', event_key: 'absent', audience: 'family', template_id: tpl });
  const note = await ins('notifications', { user_id: o.admin, staff_id: adminStaff, product_key: 'os', event_key: 'leave.requested', title: 'Leave request' });
  await ins('notifications', { user_id: o.guardian, product_key: 'erp', event_key: 'absent', title: 'Learner absent' });
  await ins('notification_prefs', { user_id: o.admin, event_key: 'leave.requested', channel: 'push' });
  await ins('outbox', { product_key: 'erp', channel: 'whatsapp', to_address: '+919000000000', template_id: tpl, student_id: learner, guardian_id: guardian, notification_id: note });
  await ins('device_tokens', { user_id: o.admin, staff_id: adminStaff, token: `tok-${o.org}`, platform: 'android' });
  await ins('integrations', { product_key: 'erp', type: 'whatsapp', name: 'WhatsApp', provider: 'gupshup', provider_owner: 'autoed' });
  await ins('api_keys', { product_key: 'crm', name: 'Website form', prefix: `ak_${tag}`, key_hash: `hash-${o.org}` });
  await ins('webhooks', { product_key: 'crm', url: 'https://example.test/hook', events: ['enquiry.created'] });
  const cat = await ins('ticket_categories', { key: 'it', name: 'IT' });
  const t1 = await ins('tickets', { category_id: cat, title: 'Projector broken', raised_by_user_id: o.admin, raised_by_staff_id: adminStaff, room_id: room });
  const t2 = await ins('tickets', { category_id: cat, title: 'Bus late', raised_by_user_id: o.guardian, student_id: learner, source: 'portal' });
  await ins('ticket_events', { ticket_id: t1, event: 'created', actor_user_id: o.admin });
  await ins('ticket_events', { ticket_id: t2, event: 'comment', note: 'We are checking', actor_staff_id: adminStaff });
  await ins('ticket_events', { ticket_id: t2, event: 'comment', note: 'Driver warned (staff only)', internal: true });
  await ins('support_tickets', { user_id: o.admin, subject: 'How do I export?', staff_id: adminStaff });
  await ins('incidents', { type: 'discipline', student_ids: [learner], description: 'Confidential fixture incident', confidential: true, reported_by_staff_id: adminStaff });
  await ins('consents', { subject_type: 'student', student_id: learner, purpose: 'photos', granted: true });
  await ins('consents', { subject_type: 'guardian', guardian_id: guardian, purpose: 'whatsapp', granted: true });
  await ins('consents', { subject_type: 'student', student_id: other, purpose: 'photos', granted: false });
  await ins('consents', { subject_type: 'crm_guardian', crm_contact_id: learner, purpose: 'marketing', granted: true, product_key: 'crm' });
  await ins('data_requests', { type: 'access', subject_type: 'student', subject_id: learner, requested_by_user_id: o.guardian });
  await ins('retention_rules', { data_type: 'attendance', keep_years: 7 });

  return { year, prog, section, room, subj, fam, otherFam, guardian, learner, sibling, other, adminStaff, otherStaff, teacherStaff, cl, sick };
}
