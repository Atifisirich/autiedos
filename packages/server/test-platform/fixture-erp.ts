/**
 * ERP rows for one org (migrations 20261118000001..9_erp_*), written as the table owner. Called for org A and org B by
 * fixture.ts after the core master data; EVERY erp table gets at least one row per org (the harness fails otherwise).
 *
 * Family model used by the portal tests (per org): the linked guardian's household has the learner and a sibling;
 * `other` belongs to another family. Rows for `learner` must be visible to the guardian, rows for `other` must not.
 * Money goes through erp.post_receipts (the same function counter collection uses), so receipts, payments,
 * allocations, vouchers and voucher lines exist for both families.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';

type Q = (sql: string, params?: unknown[]) => Promise<pg.QueryResult>;

export interface ErpOrgInput {
  org: string;
  branch: string;
  admin: string;       // auth user of the org admin
  guardian: string;    // auth user of the portal guardian (linked to `learner`)
  core: {
    year: string; prog: string; section: string; room: string; subj: string; fam: string; otherFam: string; guardian: string;
    learner: string; sibling: string; other: string; adminStaff: string; otherStaff: string; teacherStaff: string | null;
  };
  /** org A only: extra staff logins with ERP roles seeded by erp.seed_roles */
  roles?: boolean;
}

const j = (v: unknown) => JSON.stringify(v);

export async function seedErp(q: Q, o: ErpOrgInput) {
  const c = o.core;
  const ins = async (table: string, row: Record<string, unknown>, schema = 'erp'): Promise<string> => {
    const keys = Object.keys(row);
    const sql = `insert into ${schema}.${table} (org_id, ${keys.join(', ')}) values ($1, ${keys.map((_, i) => `$${i + 2}`).join(', ')}) returning id`;
    return (await q(sql, [o.org, ...keys.map((k) => row[k])])).rows[0].id as string;
  };
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params)).rows[0]?.id as string;

  // roles of the ERP (accounts, class_teacher, driver, hr ...) for org A, extra staff logins holding them
  const users: Record<string, string> = {};
  const staff: Record<string, string> = {};
  if (o.roles) {
    await q(`select erp.seed_roles($1)`, [o.org]);
    for (const [key, role, emp] of [['accounts', 'accounts', 'E101'], ['classTeacher', 'class_teacher', 'E102'], ['driver', 'driver', 'E103'], ['hr', 'hr', 'E104']] as const) {
      const uid = randomUUID();
      await q(`insert into auth.users (id, email) values ($1, $2)`, [uid, `${key}@${o.org.slice(0, 6)}.erp.test`]);
      await q(`insert into core.org_users (org_id, user_id, kind, display_name, home_branch_id) values ($1, $2, 'staff', $3, $4)`, [o.org, uid, `ERP ${key}`, o.branch]);
      await q(`insert into core.user_product_access (org_id, user_id, product_key, role_key) values ($1, $2, 'erp', $3)`, [o.org, uid, role]);
      users[key] = uid;
      staff[key] = (await q(`insert into core.staff (org_id, user_id, first_name, employee_code, branch_id, staff_type) values ($1, $2, $3, $4, $5, 'support') returning id`, [o.org, uid, key, emp, o.branch])).rows[0].id as string;
    }
  }
  const driverStaff = staff.driver ?? c.otherStaff;

  const file = await one(`select id from core.files where org_id = $1 limit 1`, [o.org]);
  const post = await one(`select id from core.class_posts where org_id = $1 and title = 'Section homework'`, [o.org]);
  const event = await one(`select id from core.events where org_id = $1 limit 1`, [o.org]);
  const base = { branch_id: o.branch };

  // ------------------------------------------------------------ setup, workflow, people (file 2)
  await ins('module_flags', { module_key: 'fees' });
  await ins('masters', { type: 'house', name: 'Red' });
  await ins('import_jobs', { entity: 'students', filename: 'students.csv' });
  const auto = await ins('automations', { name: 'Absentee notice', trigger: 'attendance.submitted' });
  await ins('automation_runs', { automation_id: auto, status: 'ok' });
  await ins('saved_reports', { name: 'Defaulters', family: 'fees', created_by: o.admin });
  await ins('adoption_checklists', { name: 'Marks entered', role: 'teacher', check_key: 'marks_entered' });
  await ins('briefings', { title: "What's new", published: true });
  await ins('doc_templates', { name: 'Bonafide', type: 'bonafide', body: '<p>{{student_name}}</p>' });
  const polStaff = await ins('policies', { title: 'Staff handbook', audience: 'staff' });
  await ins('policies', { title: 'Parent handbook', audience: 'parents' });
  await ins('policy_acks', { policy_id: polStaff, user_id: o.admin });
  for (const s of [c.learner, c.other]) await ins('student_sensitive', { student_id: s, doctor_name: 'Dr Rao', medical_notes: 'fixture note', aadhaar_last4: '1234' });
  const grp = await ins('student_groups', { name: 'Chess club', ...base });
  for (const s of [c.learner, c.other]) await ins('student_group_members', { group_id: grp, student_id: s });
  for (const s of [c.learner, c.other]) await ins('stored_documents', { student_id: s, doc_type: 'Birth certificate', file_id: file });
  for (const s of [c.learner, c.other]) await ins('alumni_profiles', { student_id: s, batch_year: 2026 });
  for (const s of [c.learner, c.other]) await ins('pickup_persons', { student_id: s, name: 'Uncle' });
  for (const s of [c.learner, c.other]) await ins('post_admission_tasks', { student_id: s, task: 'Collect documents' });
  await ins('facility_bookings', { room_id: c.room, date: '2026-12-01', start_time: '10:00', end_time: '11:00', purpose: 'PTA', booked_by: o.admin, ...base });

  // ------------------------------------------------------------ learning, assessment, wellbeing (file 3)
  await ins('content_items', { title: 'Cells video', type: 'video', subject_id: c.subj });
  await ins('online_classes', { title: 'Science revision', section_id: c.section, subject_id: c.subj });
  await ins('online_classes', { title: 'Staff meeting', is_staff_meeting: true });
  for (const s of [c.learner, c.other]) await ins('post_submissions', { post_id: post, student_id: s, body: 'Done' });
  const scale = await ins('grading_scales', { name: 'CBSE', bands: j([{ min: 91, grade: 'A1' }, { min: 0, grade: 'E' }]) });
  const scheme = await ins('assessment_schemes', { name: 'CBSE scheme', scale_id: scale, academic_year_id: c.year });
  const asPub = await ins('assessments', { name: 'Unit test 1', scheme_id: scheme, section_id: c.section, subject_id: c.subj, status: 'published', academic_year_id: c.year, ...base });
  const asOpen = await ins('assessments', { name: 'Unit test 2', scheme_id: scheme, section_id: c.section, subject_id: c.subj, status: 'open', academic_year_id: c.year, ...base });
  for (const s of [c.learner, c.other]) await ins('assessment_results', { assessment_id: asPub, student_id: s, marks: 41 });
  await ins('assessment_results', { assessment_id: asOpen, student_id: c.learner, marks: 20 });
  await ins('rubric_results', { student_id: c.learner, area: 'Communication', indicator: 'Speaks clearly' });
  await ins('remark_bank', { category: 'general', body: 'Works with focus.' });
  await ins('report_cards', { student_id: c.learner, term: 'Term 1', status: 'published', verify_code: `RC-${o.org.slice(0, 8)}-L1`, academic_year_id: c.year, section_id: c.section, published_at: new Date().toISOString(), ...base });
  await ins('report_cards', { student_id: c.learner, term: 'Term 2', status: 'draft', academic_year_id: c.year, section_id: c.section, ...base });
  await ins('report_cards', { student_id: c.other, term: 'Term 1', status: 'published', verify_code: `RC-${o.org.slice(0, 8)}-O1`, academic_year_id: c.year, section_id: c.section, ...base });
  await ins('external_exam_results', { student_id: c.learner, exam: 'Olympiad', score: '90' });
  const live = await ins('online_tests', { title: 'Quiz live', section_id: c.section, subject_id: c.subj, status: 'live', ...base });
  await ins('online_tests', { title: 'Quiz draft', section_id: c.section, subject_id: c.subj, status: 'draft', ...base });
  for (const s of [c.learner, c.other]) await ins('test_attempts', { test_id: live, student_id: s, score: 3 });
  await ins('growth_records', { student_id: c.learner, note: 'Shared with parent', visibility: 'teacher', share_with_parent: true, ...base });
  await ins('growth_records', { student_id: c.learner, note: 'Counsellor only', visibility: 'counsellor', ...base });
  await ins('growth_records', { student_id: c.other, note: 'Other shared', share_with_parent: true, ...base });
  await ins('discipline_rules', { category: 'Late arrival', level: '1' });
  await ins('safeguarding_incidents', { student_id: c.learner, description: 'Fixture safeguarding entry' });
  await ins('counselling_referrals', { student_id: c.learner, reason: 'Exam anxiety' });
  for (const s of [c.learner, c.other]) await ins('infirmary_visits', { student_id: s, complaint: 'Headache' });
  for (const s of [c.learner, c.other]) await ins('health_checks', { student_id: s, height_cm: 140 });
  await ins('house_points', { house: 'Red', points: 5, student_id: c.learner, reason: 'Helped a friend' });
  await ins('house_points', { house: 'Blue', points: 3, student_id: c.other, reason: 'Won a quiz' });
  for (const s of [c.learner, c.other]) await ins('event_registrations', { event_id: event, student_id: s });
  await ins('council_positions', { title: 'Head boy', student_id: c.learner });

  // ------------------------------------------------------------ fees and accounting (file 4)
  for (const [code, name, type] of [['1000', 'Cash in hand', 'asset'], ['1010', 'Bank', 'asset'], ['4000', 'Fee income', 'income']]) {
    await ins('accounts', { code, name, type, is_system: true });
  }
  const tuitionAcc = await one(`select id from erp.accounts where org_id = $1 and code = '4000'`, [o.org]);
  await ins('vendors', { name: 'Stationers Pvt Ltd' });
  const head = await ins('fee_heads', { name: 'Tuition', type: 'tuition', account_id: tuitionAcc });
  await ins('fee_heads', { name: 'Fine', type: 'fine' });
  const plan = await ins('fee_plans', { name: 'Class 8 plan', programme_id: c.prog, academic_year_id: c.year, ...base });
  const planItem = await ins('fee_plan_items', { plan_id: plan, head_id: head, instalment: 'Term 1', amount: 20000, due_date: '2026-06-15' });
  const dem = async (student: string, amount: number, label: string, due: string) =>
    ins('fee_demands', { student_id: student, head_id: head, plan_item_id: planItem, label, amount, due_date: due, academic_year_id: c.year, ...base });
  const dLearner1 = await dem(c.learner, 5000, 'Tuition T1', '2026-06-15');
  const dLearner2 = await dem(c.learner, 3000, 'Tuition T2', '2026-09-15');
  const dOther1 = await dem(c.other, 4000, 'Tuition T1', '2026-06-15');
  const ctype = await ins('concession_types', { name: 'Sibling discount', kind: 'percent', value: 10 });
  await ins('concessions', { student_id: c.learner, type_id: ctype, kind: 'percent', value: 10, reason: 'Sibling', status: 'pending', requested_by: o.admin, academic_year_id: c.year });
  await ins('concessions', { student_id: c.other, type_id: ctype, kind: 'percent', value: 10, reason: 'Staff ward', status: 'pending', requested_by: o.admin, academic_year_id: c.year });
  const r1 = (await q(`select erp.post_receipts($1, $2::jsonb, $3, 'Fixture') as r`, [o.org,
    j({ idempotency_key: `fx-${o.org}-1`, allocations: [{ demand_id: dLearner1, amount: 5000 }], payments: [{ mode: 'cash', amount: 5000 }] }), o.admin])).rows[0].r;
  await q(`select erp.post_receipts($1, $2::jsonb, $3, 'Fixture')`, [o.org,
    j({ idempotency_key: `fx-${o.org}-2`, allocations: [{ demand_id: dOther1, amount: 2000 }], payments: [{ mode: 'upi', amount: 2000, reference: 'UPI123' }] }), o.admin]);
  const receipt = r1.receipt_ids[0] as string;
  // the fixture's receipts notify the family; the core harness counts the guardian's notifications, so remove them
  await q(`delete from core.notifications where org_id = $1 and event_key like 'fees.%'`, [o.org]);
  await ins('bank_lines', { date: '2026-11-20', description: 'UPI settlement', amount: 2000 });
  await ins('refunds', { student_id: c.learner, receipt_id: receipt, amount: 100, reason: 'Excess paid' });
  for (const s of [c.learner, c.other]) await ins('fee_followups', { student_id: s, type: 'call', note: 'Promised to pay by Friday', by_user_id: o.admin });
  await ins('payment_orders', { student_id: c.learner, amount: 3000, allocations: j([{ demand_id: dLearner2, amount: 3000 }]), gateway_order_id: 'order_fx' });
  await ins('deposits', { student_id: c.learner, type: 'caution', amount: 2000 });
  await ins('rte_claims', { student_id: c.other, amount: 12000, academic_year_id: c.year });
  await ins('expenses', { description: 'Chalk and markers', amount: 1200, account_id: tuitionAcc, requested_by: o.admin, ...base });
  await ins('budgets', { account_id: tuitionAcc, amount: 100000, academic_year_id: c.year, ...base });
  const vendor = await one(`select id from erp.vendors where org_id = $1 limit 1`, [o.org]);
  await ins('contracts', { title: 'Lift AMC', vendor_id: vendor, value: 50000 });
  void dLearner2;

  // ------------------------------------------------------------ HR and payroll (file 5)
  await ins('staff_payroll', { staff_id: c.adminStaff, bank_name: 'SBI', bank_account: '123456789012', ifsc: 'SBIN0000001', pan: 'ABCDE1234F', aadhaar_last4: '4321' });
  await ins('staff_payroll', { staff_id: c.otherStaff, bank_name: 'HDFC', bank_account: '999900001111' });
  await ins('staff_hr_profiles', { staff_id: c.adminStaff, qualifications: 'M.Ed' });
  await ins('salary_structures', { staff_id: c.adminStaff, basic: 40000, hra: 10000 });
  await ins('salary_structures', { staff_id: c.otherStaff, basic: 22000, hra: 8000 });
  const run = await ins('payroll_runs', { month: '2026-10-01', status: 'paid', working_days: 26, ...base });
  await ins('payslips', { run_id: run, staff_id: c.adminStaff, month: '2026-10-01', gross: 50000, total_deductions: 3000, net: 47000 });
  await ins('payslips', { run_id: run, staff_id: c.otherStaff, month: '2026-10-01', gross: 30000, total_deductions: 2000, net: 28000 });
  await ins('staff_loans', { staff_id: c.otherStaff, type: 'advance', amount: 10000, emi: 2000, balance: 8000 });
  await ins('payroll_adjustments', { staff_id: c.otherStaff, month: '2026-11-01', type: 'bonus', amount: 1000 });
  await ins('tax_declarations', { staff_id: c.adminStaff, fy: '2026-27' });
  const opening = await ins('job_openings', { title: 'Maths teacher', ...base });
  await ins('job_applications', { name: 'Applicant One', opening_id: opening, stage: 'applied' });
  await ins('staff_exits', { staff_id: c.otherStaff, reason: 'Relocating', status: 'notice' });
  await ins('onboarding_checklists', { staff_id: c.adminStaff });
  await ins('staff_feedback', { staff_id: c.otherStaff, note: 'Great with parents', type: 'praise' });

  // ------------------------------------------------------------ transport, gate, hostel, store, library (file 6)
  const bus = await ins('vehicles', { reg_no: `TS09-${o.org.slice(0, 4)}`, ...base });
  const route1 = await ins('routes', { name: 'Route 1', vehicle_id: bus, driver_id: driverStaff, ...base });
  const route2 = await ins('routes', { name: 'Route 2', vehicle_id: bus, ...base });
  const stop1 = await ins('stops', { route_id: route1, name: 'Main gate' });
  const stop2 = await ins('stops', { route_id: route2, name: 'Bus stand' });
  await ins('student_transport', { student_id: c.learner, route_id: route1, stop_id: stop1, academic_year_id: c.year });
  await ins('student_transport', { student_id: c.other, route_id: route2, stop_id: stop2, academic_year_id: c.year });
  const trip1 = await ins('trips', { route_id: route1, status: 'running', ...base });
  const trip2 = await ins('trips', { route_id: route2, status: 'running', ...base });
  await ins('trip_events', { trip_id: trip1, student_id: c.learner, type: 'boarded' });
  await ins('trip_events', { trip_id: trip2, student_id: c.other, type: 'boarded' });
  await ins('trip_positions', { trip_id: trip1, lat: 17.38, lng: 78.48 });
  await ins('trip_positions', { trip_id: trip2, lat: 17.4, lng: 78.5 });
  await ins('vehicle_logs', { vehicle_id: bus, type: 'fuel', amount: 3000 });
  await ins('visitors', { name: 'Courier', purpose: 'Delivery', ...base });
  const passes: Record<string, string> = {};
  for (const [k, s] of [['learner', c.learner], ['other', c.other]] as const) {
    passes[k] = await ins('gate_passes', { student_id: s, reason: 'Doctor visit', status: 'approved', collector_name: 'Uncle', requested_by: o.admin, ...base });
    await ins('gate_pass_otps', { pass_id: passes[k], student_id: s, otp: k === 'learner' ? '123456' : '654321' }, 'private');
  }
  const broadcast = await ins('emergency_broadcasts', { message: 'Fire drill at 11', is_drill: true });
  await ins('broadcast_acks', { broadcast_id: broadcast, user_id: o.admin });
  const block = await ins('hostel_blocks', { name: 'Block A', ...base });
  const hroom = await ins('hostel_rooms', { block_id: block, name: 'A-101' });
  await ins('hostel_allocations', { student_id: c.learner, room_id: hroom, bed: '1', academic_year_id: c.year });
  await ins('mess_menus', { date: '2026-11-24', meal: 'lunch', items: 'Rice, dal' });
  const item = await ins('items', { name: 'Notebook', sku: 'NB1', price: 40, category: 'stationery' });
  await ins('stock_movements', { item_id: item, qty: 100, type: 'inward', ...base });
  await ins('sales', { student_id: c.learner, lines: j([{ item_id: item, qty: 1, price: 40 }]), total: 40, ...base });
  await ins('store_orders', { student_id: c.learner, lines: j([{ item_id: item, qty: 1 }]), total: 40, created_by: o.guardian });
  await ins('size_history', { student_id: c.learner, item: 'Shoes', size: '5' });
  const pr = await ins('purchase_requests', { title: 'Lab chemicals', requested_by: o.admin });
  await ins('purchase_orders', { po_no: 'PO-1', vendor_id: vendor, request_id: pr });
  await ins('assets', { name: 'Projector', tag: 'AST-1', ...base });
  const wallet = await ins('student_wallets', { student_id: c.learner, balance: 100 });
  await ins('student_wallets', { student_id: c.other, balance: 50 });
  await ins('student_wallet_txns', { wallet_id: wallet, student_id: c.learner, type: 'topup', amount: 100 });
  await ins('meal_bookings', { student_id: c.learner, date: '2026-11-25', created_by: o.guardian });
  await ins('meal_bookings', { student_id: c.other, date: '2026-11-25', created_by: o.admin });
  const book = await ins('books', { title: 'Wings of Fire', author: 'Kalam' });
  const copy = await ins('book_copies', { book_id: book, accession_no: `ACC-${o.org.slice(0, 6)}-1` });
  const copy2 = await ins('book_copies', { book_id: book, accession_no: `ACC-${o.org.slice(0, 6)}-2` });
  await ins('loans', { copy_id: copy, book_id: book, student_id: c.learner, due_on: '2026-12-05' });
  await ins('loans', { copy_id: copy2, book_id: book, student_id: c.other, due_on: '2026-12-06' });
  for (const s of [c.learner, c.other]) await ins('book_reservations', { book_id: book, student_id: s });
  await ins('reading_logs', { student_id: c.learner, title: 'Wings of Fire', pages: 20 });
  await ins('issued_documents', { type: 'bonafide', number: 'BF-1', student_id: c.learner, verify_code: `DOC-${o.org.slice(0, 8)}-L1`, ...base });
  await ins('issued_documents', { type: 'bonafide', number: 'BF-2', student_id: c.other, verify_code: `DOC-${o.org.slice(0, 8)}-O1`, ...base });

  // ------------------------------------------------------------ communication, PTM, gallery, forms, reports (file 7)
  const ann = await ins('announcements', { title: 'School reopens', body: 'Monday', status: 'sent', ...base });
  await ins('announcement_recipients', { message_id: ann, user_id: o.guardian, student_id: c.learner, title: 'School reopens' });
  await ins('announcement_recipients', { message_id: ann, user_id: o.admin, title: 'School reopens' });
  const conv = await ins('conversations', { subject: 'Homework doubt', student_id: c.learner, parent_user: o.guardian });
  await ins('conversation_messages', { conversation_id: conv, sender: o.guardian, body: 'Hello teacher' });
  await ins('ptm_slots', { staff_id: c.otherStaff, date: '2026-12-12', start_time: '10:00', status: 'open', ...base });
  await ins('ptm_slots', { staff_id: c.otherStaff, date: '2026-12-12', start_time: '10:15', status: 'booked', student_id: c.other, ...base });
  const alb = await ins('gallery_albums', { title: 'Annual day', status: 'approved', event_id: event, ...base });
  await ins('gallery_albums', { title: 'Draft album', status: 'pending', ...base });
  await ins('gallery_photos', { album_id: alb, file_id: file, caption: 'Stage' });
  await ins('appointments', { student_id: c.learner, reason: 'Meet principal', requested_by: o.guardian });
  await ins('maintenance_schedules', { title: 'Fire extinguisher check', room_id: c.room });
  await ins('utility_readings', { type: 'electricity', reading: 1200, ...base });
  const form = await ins('forms', { title: 'Feedback survey', status: 'published', audience: 'parents' });
  await ins('forms', { title: 'Staff form (draft)', status: 'draft', audience: 'staff' });
  await ins('form_responses', { form_id: form, user_id: o.guardian, student_id: c.learner, answers: j({ q1: 'good' }) });
  await ins('principal_diary', { date: '2026-11-23', comments: 'Quiet day', ...base });
  // staff UI (20261118100002): a substitution when the school has no OS timetable
  await ins('substitutions', { date: '2026-11-23', period_seq: 1, section_id: c.section, subject_id: c.subj, absent_staff_id: c.otherStaff, substitute_staff_id: c.adminStaff, reason: 'Sick leave', ...base });
  await ins('data_health_reports', { findings: j({ missing_dob: 2 }) });
  await ins('franchise_royalties', { period: '2026-Q2', amount: 10000, ...base });
  await ins('quality_audits', { framework: 'internal', ...base });
  await ins('disclosures', { item: 'Fire safety certificate', value: 'valid till 2027' });

  return { users, staff, passes, receipt, run, route1, route2, trip1, trip2, asPub, asOpen, live, dLearner1, dLearner2, dOther1, driverStaff, item, wallet, copy };
}
