#!/usr/bin/env node
// Demo school for the ERP staff screens and the Playwright smoke test. Written as the table owner (RLS bypassed) into a database built with
// `pnpm db:reset:platform`. Run once per fresh database:
//   DATABASE_URL=postgres://postgres@localhost:54322/erpui node scripts/seed-erp-demo.mjs
// Logins (dev shim, ERP_AUTH_PROVIDER=dev): admin@demo.school (group admin), principal@, teacher@ (class teacher 1A), teacher2@, accounts@, hr@,
// frontoffice@, transport@, librarian@, store@, security@, driver@, parent@ (guardian of the first student of 1A).
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const url = process.env.DATABASE_URL ?? 'postgres://postgres@localhost:54322/erpui';
const c = new pg.Client({ connectionString: url });
await c.connect();
const id = () => randomUUID();
const q = async (sql, params = []) => (await c.query(sql, params)).rows;
const today = new Date();
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const T = iso(today);

if ((await q(`select 1 from core.organizations where slug = 'demo-school'`)).length) { console.log('demo school already seeded'); await c.end(); process.exit(0); }
await c.query('begin');

// ---------------------------------------------------------------- organisation, branches, subscription
const org = id();
await q(`insert into core.organizations (id, name, slug, kind, legal_name, state, city, gst_no, pan, setup_step) values ($1, 'Demo Public School', 'demo-school', 'school', 'Demo Education Society', 'Telangana', 'Hyderabad', '36AABCD1234E1Z5', 'AABCD1234E', 'done')`, [org]);
await q(`insert into core.subscriptions (org_id, product_key, status, plan_key) values ($1, 'erp', 'active', 'erp_monthly'), ($1, 'os', 'active', 'os_monthly')`, [org]);
const main = id(), east = id();
await q(`insert into core.branches (id, org_id, name, code, city, state_code, working_days, gst_no, boards) values ($1, $3, 'Main campus', 'MAIN', 'Hyderabad', '36', '{1,2,3,4,5,6}', '36AABCD1234E1Z5', '{CBSE}'), ($2, $3, 'East campus', 'EAST', 'Secunderabad', '36', '{1,2,3,4,5}', null, '{CBSE}')`, [main, east, org]);
await q(`select erp.seed_roles($1)`, [org]);
await q(`insert into erp.accounts (org_id, code, name, type, is_system) values
  ($1, '1000', 'Cash in hand', 'asset', true), ($1, '1010', 'Bank', 'asset', true), ($1, '1100', 'Fee receivable', 'asset', true),
  ($1, '2000', 'Caution deposits and advances', 'liability', true), ($1, '2100', 'Payroll payable', 'liability', true),
  ($1, '4000', 'Fee income', 'income', true), ($1, '4100', 'Other income', 'income', true),
  ($1, '5000', 'Salaries', 'expense', true), ($1, '5100', 'Operating expenses', 'expense', true) on conflict do nothing`, [org]);
const ins = async (table, row, schema = 'core') => {
  const keys = Object.keys(row);
  return (await q(`insert into ${schema}.${table} (org_id, ${keys.join(', ')}) values ($1, ${keys.map((_, i) => `$${i + 2}`).join(', ')}) returning id`, [org, ...keys.map((k) => row[k])]))[0].id;
};
const erpIns = (table, row) => ins(table, row, 'erp');

// ---------------------------------------------------------------- academic structure
const year = await ins('academic_years', { name: '2026-27', starts_on: '2026-06-01', ends_on: '2027-03-31', is_current: true, status: 'active' });
const t1 = await ins('terms', { academic_year_id: year, name: 'Term 1', seq: 1, starts_on: '2026-06-01', ends_on: '2026-11-30' });
await ins('terms', { academic_year_id: year, name: 'Term 2', seq: 2, starts_on: '2026-12-01', ends_on: '2027-03-31' });
await ins('number_series', { key: 'admission_no', prefix: 'DPS/26/', academic_year_id: year, padding: 4, next_value: 100 });
const wing = await ins('wings', { name: 'Primary', board: 'CBSE' });
const dEng = await ins('departments', { name: 'English' });
const dSci = await ins('departments', { name: 'Science and Maths' });
const pTeacher = await ins('positions', { key: 'teacher', name: 'Teacher', rank: 50, is_teaching: true });
const pAdmin = await ins('positions', { key: 'admin', name: 'Administrator', rank: 30, is_teaching: false });
const pPrincipal = await ins('positions', { key: 'principal', name: 'Principal', rank: 10, is_teaching: true });
const rooms = [];
for (let i = 1; i <= 6; i++) rooms.push(await ins('rooms', { branch_id: main, name: `Room ${i}`, capacity: 40 }));
const labRoom = await ins('rooms', { branch_id: main, name: 'Science lab', kind: 'lab', capacity: 30 });
const subjects = {};
for (const [name, code, dept] of [['English', 'ENG', dEng], ['Mathematics', 'MAT', dSci], ['EVS', 'EVS', dSci], ['Hindi', 'HIN', dEng]]) subjects[code] = await ins('subjects', { name, code, department_id: dept });
const progs = [];
for (const [i, n] of ['Class 1', 'Class 2', 'Class 3'].entries()) {
  const p = await ins('programmes', { branch_id: main, wing_id: wing, name: n, board: 'CBSE', stage: 'primary', level: i + 1, seq: i + 1, capacity: 80 });
  progs.push(p);
  for (const s of Object.values(subjects)) await ins('programme_subjects', { programme_id: p, subject_id: s, periods_per_week: 6 });
}

// ---------------------------------------------------------------- users and staff
const users = {};
// ERP_DEMO_DOMAIN puts the logins on another domain when the OS demo school (pnpm db:reset, also @demo.school) shares the database.
const DEMO_DOMAIN = process.env.ERP_DEMO_DOMAIN || 'demo.school';
async function user(email, role, name, { branch = main, kind = 'staff', position = pAdmin, dept = null, teaching = false, code = null, product = 'erp' } = {}) {
  email = email.replace(/@demo\.school$/, `@${DEMO_DOMAIN}`);
  const uid = id();
  await q(`insert into auth.users (id, email) values ($1, $2)`, [uid, email]);
  await q(`insert into core.org_users (org_id, user_id, kind, display_name, home_branch_id) values ($1, $2, $3, $4, $5)`, [org, uid, kind, name, kind === 'staff' ? branch : null]);
  await q(`insert into core.user_product_access (org_id, user_id, product_key, role_key) values ($1, $2, $3, $4)`, [org, uid, product, role]);
  let staff = null;
  if (kind === 'staff') {
    const [first, ...rest] = name.split(' ');
    staff = await ins('staff', { user_id: uid, first_name: first, last_name: rest.join(' ') || null, email, phone: `+9198000${String(Object.keys(users).length).padStart(5, '0')}`, branch_id: branch, position_id: position, department_id: dept, employee_code: code, staff_type: teaching ? 'teaching' : 'admin', joined_on: '2024-06-01', gender: 'female', dob: '1988-04-10' });
  }
  users[email.split('@')[0]] = { uid, staff, email };
  return { uid, staff };
}
await user('admin@demo.school', 'group_admin', 'Asha Reddy', { branch: null, code: 'E001' });
await user('principal@demo.school', 'principal', 'Dr Kiran Rao', { position: pPrincipal, teaching: true, code: 'E002' });
await user('teacher@demo.school', 'class_teacher', 'Meera Nair', { position: pTeacher, dept: dEng, teaching: true, code: 'E003' });
await user('teacher2@demo.school', 'subject_teacher', 'Ravi Kumar', { position: pTeacher, dept: dSci, teaching: true, code: 'E004' });
await user('teacher3@demo.school', 'class_teacher', 'Sunita Das', { position: pTeacher, dept: dSci, teaching: true, code: 'E005' });
await user('coordinator@demo.school', 'coordinator', 'Farah Khan', { position: pTeacher, teaching: true, code: 'E006' });
await user('accounts@demo.school', 'accounts', 'Prakash Iyer', { code: 'E007' });
await user('hr@demo.school', 'hr', 'Latha Menon', { code: 'E008' });
await user('frontoffice@demo.school', 'front_office', 'Sana Mirza', { code: 'E009' });
await user('transport@demo.school', 'transport', 'Venkat Rao', { code: 'E010' });
await user('librarian@demo.school', 'librarian', 'Gita Pillai', { code: 'E011' });
await user('store@demo.school', 'store', 'Imran Shaikh', { code: 'E012' });
await user('security@demo.school', 'security', 'Bhaskar Naidu', { code: 'E013' });
await user('driver@demo.school', 'driver', 'Mohan Lal', { code: 'E014' });
await user('nurse@demo.school', 'nurse', 'Joseph D Souza', { code: 'E015' });
await user('warden@demo.school', 'warden', 'Rekha Sharma', { code: 'E016' });
await user('counsellor@demo.school', 'counsellor', 'Anita Joseph', { code: 'E017' });
await q(`update core.departments set head_staff_id = $1 where id = $2`, [users.teacher.staff, dEng]);
const teachers = [users.teacher.staff, users.teacher2.staff, users.teacher3.staff];

// ---------------------------------------------------------------- sections, families, students
const sections = [];
let secNo = 0;
for (const [pi, p] of progs.entries()) for (const letter of ['A', 'B']) {
  const sid = await ins('sections', { programme_id: p, academic_year_id: year, name: `${pi + 1}${letter}`, class_teacher_id: letter === 'A' && pi === 0 ? users.teacher.staff : teachers[(secNo + 1) % 3], room_id: rooms[secNo], capacity: 40, seq: secNo + 1 });
  sections.push({ id: sid, prog: p, name: `${pi + 1}${letter}` });
  secNo++;
}
const FIRST = ['Aarav', 'Diya', 'Vihaan', 'Ananya', 'Arjun', 'Ishita', 'Kabir', 'Myra', 'Reyansh', 'Saanvi', 'Vivaan', 'Aadhya', 'Krishna', 'Anika', 'Rohan', 'Kiara'];
const LAST = ['Sharma', 'Reddy', 'Khan', 'Iyer', 'Patel', 'Naidu', 'Singh', 'Das'];
const students = [];
const households = [];
let n = 0;
let parentUid = null;
for (const s of sections) {
  for (let k = 0; k < 8; k++) {
    n++;
    const last = LAST[n % LAST.length];
    const hh = await ins('households', { family_name: `${last} family`, address: `${n} Park Road`, city: 'Hyderabad', pincode: '500001', phone: `+9199000${String(n).padStart(5, '0')}`, email: `family${n}@example.test` });
    let gUser = null;
    if (n === 1) { gUser = (await user('parent@demo.school', 'portal', `Mr ${last}`, { kind: 'guardian' })).uid; parentUid = gUser; }
    await ins('guardians', { household_id: hh, name: `Mr ${last}`, relation: 'father', phone: `+9199000${String(n).padStart(5, '0')}`, is_primary: true, user_id: gUser });
    await ins('guardians', { household_id: hh, name: `Mrs ${last}`, relation: 'mother', phone: `+9198000${String(n).padStart(5, '0')}`, is_primary: false });
    const sid = await ins('students', { branch_id: main, household_id: hh, first_name: FIRST[n % FIRST.length], last_name: last, admission_no: `DPS/26/${String(n).padStart(4, '0')}`, status: 'active', programme_id: s.prog, section_id: s.id, roll_no: String(k + 1), gender: n % 2 ? 'male' : 'female', dob: `201${3 - progs.indexOf(s.prog)}-0${(n % 9) + 1}-1${n % 9}`, joined_on: '2026-06-01', house: ['Red', 'Blue', 'Green', 'Yellow'][n % 4], is_new: n % 5 === 0 });
    await ins('enrolments', { student_id: sid, academic_year_id: year, programme_id: s.prog, section_id: s.id, roll_no: String(k + 1) });
    await ins('student_sensitive', { student_id: sid, blood_group: ['O+', 'A+', 'B+'][n % 3], allergies: n % 7 === 0 ? 'peanuts' : null });
    students.push({ id: sid, hh, section: s.id, prog: s.prog, n });
    households.push(hh);
  }
}
if (parentUid) await q(`insert into core.learner_links (org_id, user_id, learner_id, relation) values ($1, $2, $3, 'father')`, [org, parentUid, students[0].id]);
await q(`update core.sections s set strength = (select count(*) from core.students x where x.section_id = s.id and x.org_id = s.org_id) where s.org_id = $1`, [org]);

// ---------------------------------------------------------------- calendar, timetable, attendance, leave
await ins('calendar_events', { title: 'Diwali break', starts_on: iso(addDays(today, 20)), ends_on: iso(addDays(today, 22)), layer: 'holiday', audience: 'all', is_working_day: false });
await ins('calendar_events', { title: 'Annual day', starts_on: iso(addDays(today, 40)), layer: 'event', audience: 'all' });
await ins('calendar_events', { title: 'Staff meeting', starts_on: iso(addDays(today, 3)), layer: 'staff_meeting', audience: 'staff' });
const bell = await ins('bell_schedules', { wing_id: wing, name: 'Weekdays', days: [1, 2, 3, 4, 5, 6] });
const times = [['09:00', '09:45'], ['09:45', '10:30'], ['10:45', '11:30'], ['11:30', '12:15'], ['13:00', '13:45'], ['13:45', '14:30']];
for (const [i, [a, b]] of times.entries()) await ins('periods', { bell_schedule_id: bell, seq: i + 1, label: `P${i + 1}`, starts_at: a, ends_at: b, teaching_index: i + 1 });
const ver = await ins('timetable_versions', { branch_id: main, academic_year_id: year, name: 'Term 1', status: 'published' });
const subjIds = Object.values(subjects);
for (const [si, s] of sections.entries()) {
  for (const d of [1, 2, 3, 4, 5]) for (let p = 1; p <= 6; p++) {
    const subj = subjIds[(d + p + si) % 4];
    await ins('timetable_entries', { version_id: ver, day: d, period_seq: p, section_id: s.id, subject_id: subj, staff_id: teachers[(si + p + d) % 3], room_id: rooms[si] });
  }
  for (const [ti, t] of teachers.entries()) for (const subj of subjIds.slice(0, 2)) await ins('teacher_allocations', { academic_year_id: year, staff_id: t, section_id: s.id, subject_id: subj, periods_per_week: 4 }).catch(() => null);
}
let marked = 0;
for (let back = 1; back <= 12; back++) {
  const d = addDays(today, -back);
  if ([0, 6].includes(d.getUTCDay())) continue;
  for (const s of sections) {
    const sess = await ins('student_attendance_sessions', { section_id: s.id, date: iso(d), status: 'submitted', marked_by_staff_id: users.teacher.staff, submitted_at: d.toISOString() });
    for (const st of students.filter((x) => x.section === s.id)) {
      const absent = (st.n + back) % 11 === 0, late = (st.n + back) % 13 === 0;
      await ins('student_attendance_marks', { session_id: sess, student_id: st.id, date: iso(d), status: absent ? 'absent' : late ? 'late' : 'present' });
      marked++;
    }
  }
}
for (const [k, u] of Object.entries(users)) if (u.staff) for (let back = 1; back <= 10; back++) {
  const d = addDays(today, -back);
  if ([0, 6].includes(d.getUTCDay())) continue;
  await ins('staff_attendance', { staff_id: u.staff, date: iso(d), status: (back + k.length) % 9 === 0 ? 'absent' : 'present', source: 'manual', branch_id: main });
}
const cl = await ins('leave_types', { key: 'cl', name: 'Casual leave', yearly_quota: 12, applies_to: 'staff' });
await ins('leave_types', { key: 'sl', name: 'Sick leave', yearly_quota: 10, applies_to: 'staff' });
await ins('leave_types', { key: 'sick', name: 'Sick (student)', applies_to: 'student' });
for (const [k, u] of Object.entries(users)) if (u.staff) await ins('leave_balances', { staff_id: u.staff, leave_type_id: cl, academic_year_id: year, opening: 12 });
await ins('leave_requests', { staff_id: users.teacher2.staff, leave_type_id: cl, start_date: iso(addDays(today, 2)), end_date: iso(addDays(today, 2)), days: 1, reason: 'Family function', status: 'pending', branch_id: main });

// ---------------------------------------------------------------- exams, comms, helpdesk
const et = await ins('exam_types', { key: 'unit_test', name: 'Unit test', seq: 1 });
const exam = await ins('exams', { branch_id: main, academic_year_id: year, term_id: t1, exam_type_id: et, name: 'Unit Test 1', starts_on: iso(addDays(today, 10)), ends_on: iso(addDays(today, 14)), programme_ids: progs, status: 'scheduled' });
for (const p of progs) for (const [i, s] of subjIds.entries()) await ins('exam_schedules', { exam_id: exam, programme_id: p, subject_id: s, exam_date: iso(addDays(today, 10 + i)), starts_at: '09:00', ends_at: '10:30', max_marks: 25, pass_marks: 9 });
const tpl = await ins('message_templates', { product_key: 'erp', event_key: 'absent', name: 'Absent alert', channel: 'whatsapp', body: '{{student}} was absent today.' });
await ins('message_templates', { product_key: 'erp', event_key: 'fee_reminder', name: 'Fee reminder', channel: 'sms', body: 'Fee of {{amount}} is due on {{date}}.' });
const cat = await ins('ticket_categories', { key: 'it', name: 'IT and equipment' });
await ins('ticket_categories', { key: 'maintenance', name: 'Maintenance' });
await ins('tickets', { category_id: cat, title: 'Projector in Room 3 not working', description: 'No display since Monday.', raised_by_user_id: users.teacher.uid, raised_by_staff_id: users.teacher.staff, room_id: rooms[2], priority: 'normal', branch_id: main });
await ins('notifications', { user_id: users.admin.uid, staff_id: users.admin.staff, product_key: 'erp', event_key: 'welcome', title: 'Welcome to AutoEd ERP', body: 'Your demo school is ready.', link: '/erp' });
await ins('class_posts', { type: 'homework', section_id: sections[0].id, subject_id: subjects.MAT, staff_id: users.teacher.staff, title: 'Practice addition sums', body: 'Page 14, questions 1 to 10.', due_date: iso(addDays(today, 2)), status: 'published', published_at: today.toISOString(), allow_submission: true, max_marks: 10 });
await ins('class_posts', { type: 'diary', section_id: sections[0].id, staff_id: users.teacher.staff, title: 'Bring crayons tomorrow', status: 'published', published_at: today.toISOString() });

// ---------------------------------------------------------------- fees
const accIncome = (await q(`select id from erp.accounts where org_id = $1 and code = '4000'`, [org]))[0].id;
const heads = {};
for (const [name, type] of [['Tuition fee', 'tuition'], ['Admission fee', 'admission'], ['Transport fee', 'transport'], ['Exam fee', 'exam'], ['Late fine', 'fine']]) heads[type] = await erpIns('fee_heads', { name, type, account_id: accIncome });
await erpIns('concession_types', { name: 'Sibling discount', kind: 'percent', value: 10, head_type: 'tuition', auto_rule: 'sibling' });
await erpIns('concession_types', { name: 'Merit scholarship', kind: 'fixed', value: 5000, head_type: 'tuition', auto_rule: 'merit', max_amount: 10000 });
const D0 = (d) => iso(addDays(today, d));
for (const [pi, p] of progs.entries()) {
  const plan = await erpIns('fee_plans', { branch_id: main, academic_year_id: year, name: `Class ${pi + 1} day scholar`, programme_id: p, category: 'day scholar' });
  const items = [];
  for (const [inst, due] of [['Term 1', D0(-60)], ['Term 2', D0(-5)], ['Term 3', D0(60)]]) items.push(await erpIns('fee_plan_items', { plan_id: plan, head_id: heads.tuition, instalment: inst, amount: 12000 + pi * 1500, due_date: due }));
  items.push(await erpIns('fee_plan_items', { plan_id: plan, head_id: heads.exam, instalment: 'Annual', amount: 1500, due_date: D0(-60) }));
  for (const st of students.filter((x) => x.prog === p)) {
    const [{ branch_id }] = [{ branch_id: main }];
    for (const it of items) {
      const r = (await q(`select amount, due_date, head_id, instalment from erp.fee_plan_items where id = $1`, [it]))[0];
      await erpIns('fee_demands', { student_id: st.id, branch_id, academic_year_id: year, head_id: r.head_id, plan_item_id: it, label: `Class ${pi + 1} day scholar · ${r.instalment}`, amount: r.amount, due_date: r.due_date });
    }
  }
}
// two families paid Term 1 through the posting function, so receipts, vouchers and the day sheet have data
for (const st of students.slice(0, 6)) {
  const dem = await q(`select id, amount from erp.fee_demands where org_id = $1 and student_id = $2 order by due_date limit 2`, [org, st.id]);
  const payload = { allocations: dem.map((d) => ({ demand_id: d.id, amount: Number(d.amount) })), payments: [{ mode: st.n % 2 ? 'cash' : 'upi', amount: dem.reduce((t, d) => t + Number(d.amount), 0), reference: st.n % 2 ? null : `UPI${100000 + st.n}` }], date: T, idempotency_key: `seed-${st.id}` };
  await q(`select erp.post_receipts($1, $2::jsonb, $3, 'Prakash Iyer')`, [org, JSON.stringify(payload), users.accounts.uid]);
}

// ---------------------------------------------------------------- HR and payroll, accounting
let ei = 0;
for (const [k, u] of Object.entries(users)) {
  if (!u.staff) continue;
  ei++;
  await erpIns('salary_structures', { staff_id: u.staff, effective_from: '2026-04-01', basic: 20000 + ei * 1500, hra: 8000 + ei * 500, da: 2000, special_allowance: 3000, other_allowance: 1000, pf_applicable: true, esi_applicable: false, pt_applicable: true, tds_monthly: ei % 4 === 0 ? 1200 : 0 });
  await erpIns('staff_payroll', { staff_id: u.staff, bank_name: 'State Bank of India', bank_account: `3300${String(100000 + ei)}`, ifsc: 'SBIN0001234', pan: `ABCDE${1000 + ei}F`, uan: `1012345${String(ei).padStart(5, '0')}`, tax_regime: 'new' });
  await erpIns('staff_hr_profiles', { staff_id: u.staff, qualifications: 'B.Ed', experience_years: 3 + ei, bgv_status: ei % 6 === 0 ? 'pending' : 'clear' });
}
const vend = await erpIns('vendors', { name: 'Sri Lakshmi Stationers', type: 'stationery', gst_no: '36AAAAA0000A1Z5', phone: '+919876500001' });
await erpIns('vendors', { name: 'Metro Uniforms', type: 'uniform', phone: '+919876500002' });
const accExp = (await q(`select id from erp.accounts where org_id = $1 and code = '5100'`, [org]))[0].id;
await erpIns('budgets', { branch_id: main, academic_year_id: year, account_id: accExp, amount: 500000, alert_percent: 80 });
await erpIns('expenses', { branch_id: main, description: 'Chalk and registers', date: T, account_id: accExp, vendor_id: vend, amount: 4200, status: 'requested', payment_mode: 'cash', is_petty_cash: true, requested_by: users.accounts.uid });
await erpIns('policies', { title: 'Staff handbook', body: 'Code of conduct, attendance and leave rules.', version: '1.0', audience: 'staff', requires_ack: true, published: true });
await erpIns('masters', { type: 'house', name: 'Red', sort: 1 }); await erpIns('masters', { type: 'house', name: 'Blue', sort: 2 });
await erpIns('masters', { type: 'house', name: 'Green', sort: 3 }); await erpIns('masters', { type: 'house', name: 'Yellow', sort: 4 });

await c.query('commit');
console.log(JSON.stringify({ org, branches: { main, east }, year, sections: sections.map((s) => s.name), students: students.length, marks: marked, users: Object.keys(users).length }));
await c.end();
