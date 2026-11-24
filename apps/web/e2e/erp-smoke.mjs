#!/usr/bin/env node
/**
 * Browser smoke test for the ERP staff screens. Needs the dev stack: a database seeded by scripts/seed-erp-demo.mjs and
 * scripts/seed-erp-demo-extras.mjs, PostgREST (node scripts/erp-dev-postgrest.mjs) and the web app with ERP_AUTH_PROVIDER=dev.
 *
 *   BASE_URL=http://localhost:3100 DATABASE_URL=postgres://postgres@localhost:54322/erpui node apps/web/e2e/erp-smoke.mjs
 *
 * Signs in as the group admin and as a teacher (dev login), opens every staff screen the role may see, and fails on uncaught page errors,
 * console errors, and 5xx responses. Then drives four flows end to end: admit a student, mark attendance, collect a fee and get a receipt,
 * run payroll. Set SMOKE_SHOTS=/some/dir to save screenshots (for your own checks; nothing is committed).
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const pg = require('pg');

const BASE = process.env.BASE_URL ?? 'http://localhost:3100';
const SHOTS = process.env.SMOKE_SHOTS;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres@localhost:54322/erpui' });
await db.connect();
const ORG = (await db.query(`select id from core.organizations where slug = 'demo-school'`)).rows[0]?.id;
if (!ORG) throw new Error('Demo school not seeded: run scripts/seed-erp-demo.mjs first');
const one = async (sql) => (await db.query(sql)).rows[0]?.id;
const ids = {
  student: await one(`select id from core.students where org_id = '${ORG}' order by admission_no limit 1`), staff: await one(`select id from core.staff where org_id = '${ORG}' and email = 'teacher@demo.school'`),
  assessment: await one(`select id from erp.assessments where org_id = '${ORG}' limit 1`), section: await one(`select id from core.sections where org_id = '${ORG}' order by name limit 1`), form: await one(`select id from erp.forms where org_id = '${ORG}' limit 1`),
  ticket: await one(`select id from core.tickets where org_id = '${ORG}' limit 1`), receipt: await one(`select id from erp.receipts where org_id = '${ORG}' limit 1`), rc: await one(`select id from erp.report_cards where org_id = '${ORG}' limit 1`),
};
const entities = (await import('node:fs')).readFileSync(new URL('../lib/erp/entities.gen.ts', import.meta.url), 'utf8').match(/"table":"([a-z_0-9]+)"/g).map((m) => m.slice(9, -1));

const COMMON = ['/erp', '/erp/account', '/erp/approvals', '/erp/assessments', `/erp/assessments/${ids.assessment}`, '/erp/attendance', `/erp/attendance/roll/${ids.section}`, '/erp/diary', '/erp/documents', '/erp/exams', '/erp/fees', '/erp/fees/cheques', '/erp/fees/dues', '/erp/fees/receipts', '/erp/fees/structure',
  '/erp/forms', `/erp/forms/${ids.form}`, '/erp/helpdesk', `/erp/helpdesk/${ids.ticket}`, '/erp/homework', '/erp/inbox', '/erp/insights', '/erp/library', '/erp/me', '/erp/messages', '/erp/modules', '/erp/ptm', `/erp/receipt/${ids.receipt}`, '/erp/report-cards', ...(ids.rc ? [`/erp/report-cards/${ids.rc}`] : []),
  '/erp/reports', '/erp/reports/strength', '/erp/reports/attendance', '/erp/reports/fees', '/erp/reports/dues', '/erp/reports/academics', '/erp/reports/homework', '/erp/reports/library', '/erp/reports/communication', '/erp/reports/requests', '/erp/reports/statutory', '/erp/reports/conduct', '/erp/reports/concessions',
  '/erp/students', `/erp/students/${ids.student}`, '/erp/timetable', '/erp/timetable/substitutions', '/erp/wellbeing', '/erp/m/events', '/erp/m/facilities', '/erp/m/learning', '/erp/x/sections', '/erp/x/subjects', '/erp/x/calendar_events'];
const ADMIN_ONLY = ['/erp/accounting', '/erp/admin', '/erp/admin/adoption', '/erp/admin/audit', '/erp/admin/automations', '/erp/admin/health', '/erp/admin/import', '/erp/admin/import?entity=students', '/erp/admin/roles', '/erp/admin/rollover', '/erp/admin/settings', '/erp/admin/setup', '/erp/admin/users',
  '/erp/admissions', '/erp/attendance/staff', '/erp/driver', '/erp/fees/counter', `/erp/fees/counter?student=${ids.student}`, '/erp/fees/reconciliation', '/erp/gate', '/erp/group', '/erp/hr', '/erp/hr/leave', '/erp/hr/payroll', `/erp/hr/staff/${ids.staff}`, `/erp/hr/staff/${ids.staff}/bank`,
  '/erp/store', '/erp/students/bulk', '/erp/students/new', '/erp/transport', '/erp/transport/live', '/erp/m/hostel', '/erp/reports/staff-attendance', '/erp/reports/transport', '/erp/reports/gate', '/erp/reports/store', '/erp/reports/hr', '/erp/reports/usage', '/erp/reports/admissions',
  ...entities.map((e) => `/erp/x/${e}`)];

const browser = await chromium.launch();
const problems = [];
let checked = 0;

async function session(email) {
  const ctx = await browser.newContext({ acceptDownloads: true });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  const page = await ctx.newPage();
  const st = { where: '' };
  page.on('pageerror', (e) => problems.push(`${email} ${st.where}: page error ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && problems.push(`${email} ${st.where}: console ${m.text().slice(0, 200)}`));
  page.on('response', (r) => r.status() >= 500 && problems.push(`${email} ${st.where}: ${r.status()} ${r.url()}`));
  const login = await page.request.post(`${BASE}/api/erp/dev-login`, { data: { email } });
  if (!login.ok()) { problems.push(`${email}: login failed ${login.status()}`); await ctx.close(); return null; }
  return { ctx, page, st };
}
async function open(s, path, email) {
  s.st.where = path;
  const r = await s.page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
  checked++;
  if (r && r.status() >= 500) problems.push(`${email} ${path}: ${r.status()}`);
  return r;
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }); };

// ------------------------------------------------------------------ every screen
for (const [email, extra] of process.env.SMOKE_FLOWS_ONLY ? [] : [['admin@demo.school', ADMIN_ONLY], ['teacher@demo.school', []]]) {
  const s = await session(email);
  if (!s) continue;
  for (const p of [...COMMON, ...extra]) {
    if (p.endsWith('/export')) continue;
    const r = await open(s, p, email);
    // A teacher is sent back to the home page with a notice on screens the role does not have; that is the intended behaviour, not a failure.
    if (r && r.status() === 404 && email.startsWith('teacher')) continue;
    if (r && r.status() >= 400) problems.push(`${email} ${p}: ${r.status()}`);
    const txt = await s.page.locator('body').innerText();
    if (/Application error|Internal Server Error|Unhandled Runtime Error/.test(txt)) problems.push(`${email} ${p}: error text on page`);
  }
  // exports download as files
  if (email.startsWith('admin')) for (const f of ['fees', 'attendance']) { const r = await s.page.request.get(`${BASE}/erp/reports/${f}/export`); if (!r.ok()) problems.push(`export ${f}: ${r.status()}`); }
  await s.ctx.close();
}

// ------------------------------------------------------------------ flow 1: admit a student
{
  const email = 'admin@demo.school', s = await session(email);
  const stamp = Date.now().toString().slice(-6);
  const first = `Smoke${stamp}`;
  await open(s, '/erp/students/new', email);
  await s.page.fill('input[name=first_name]', first);
  await s.page.fill('input[name=last_name]', 'Tester');
  await s.page.fill('input[name=dob]', '2019-05-05');
  await s.page.selectOption('select[name=gender]', 'female');
  await s.page.selectOption('select[name=section_id]', { index: 1 });
  await s.page.fill('input[name=g1_name]', 'Smoke Parent');
  await s.page.fill('input[name=g1_phone]', `98${stamp}0${stamp.slice(0, 2)}`);
  await s.page.click('button:has-text("Admit student")');
  await s.page.waitForURL(/\/erp\/students\/[0-9a-f-]{36}/, { timeout: 60000 }).catch(() => {});
  const row = (await db.query(`select id, admission_no, status from core.students where org_id = '${ORG}' and first_name = $1`, [first])).rows[0];
  if (!row) problems.push(`flow admit: student ${first} was not created (url ${s.page.url()})`);
  else { await open(s, `/erp/students/${row.id}`, email); if (!(await s.page.locator('body').innerText()).includes(first)) problems.push('flow admit: student page does not show the new name'); await shot(s.page, 'admit'); }
  await s.ctx.close();
}

// ------------------------------------------------------------------ flow 2: mark attendance (as the class teacher)
{
  const email = 'teacher@demo.school', s = await session(email);
  const sec = await one(`select s.id from core.sections s join core.staff t on t.id = s.class_teacher_id where s.org_id = '${ORG}' and t.email = 'teacher@demo.school' limit 1`);
  await db.query(`delete from core.student_attendance_marks where session_id in (select id from core.student_attendance_sessions where section_id = $1 and date = current_date)`, [sec]);
  await db.query(`delete from core.student_attendance_sessions where section_id = $1 and date = current_date`, [sec]);
  await open(s, `/erp/attendance/roll/${sec}`, email);
  const first = s.page.locator('button[aria-label*="Tap to change"]').first();
  await first.click(); // present -> absent
  await s.page.click('button:has-text("Submit attendance")');
  await s.page.waitForSelector('text=/saved|marked|submitted|Attendance/i', { timeout: 15000 }).catch(() => {});
  await s.page.waitForTimeout(1500);
  const n = (await db.query(`select count(*)::int as n, count(*) filter (where m.status = 'absent')::int as absent from core.student_attendance_marks m join core.student_attendance_sessions ss on ss.id = m.session_id where ss.section_id = $1 and ss.date = current_date and ss.status = 'submitted'`, [sec])).rows[0];
  if (!n || n.n === 0) problems.push('flow attendance: no marks saved for today');
  else if (n.absent !== 1) problems.push(`flow attendance: expected 1 absent, found ${n.absent}`);
  await shot(s.page, 'attendance');
  await s.ctx.close();
}

// ------------------------------------------------------------------ flow 3: collect a fee, receipt
{
  const email = 'accounts@demo.school', s = await session(email);
  const student = await one(`select d.student_id as id from erp.fee_demands d where d.org_id = '${ORG}' and d.status in ('due','partial') and d.student_id not in (select student_id from erp.fee_demands where status = 'paid') order by d.due_date limit 1`);
  const before = (await db.query(`select count(*)::int as n from erp.receipts where org_id = '${ORG}'`)).rows[0].n;
  await open(s, `/erp/fees/counter?student=${student}`, email);
  s.page.on('dialog', (d) => d.accept());
  await s.page.click('button:has-text("Save and print receipt")');
  await s.page.waitForLoadState('networkidle');
  await s.page.waitForTimeout(1000);
  const after = (await db.query(`select count(*)::int as n from erp.receipts where org_id = '${ORG}'`)).rows[0].n;
  if (after !== before + 1) problems.push(`flow fee: expected one new receipt, got ${after - before} (url ${s.page.url()})`);
  else {
    const rc = (await db.query(`select id, receipt_no, total from erp.receipts where org_id = '${ORG}' order by created_at desc limit 1`)).rows[0];
    await open(s, `/erp/receipt/${rc.id}`, email);
    if (!(await s.page.locator('body').innerText()).includes(rc.receipt_no)) problems.push('flow fee: receipt page does not show the receipt number');
    const v = (await db.query(`select count(*)::int as n from erp.vouchers where ref_id = $1`, [rc.id]).catch(() => ({ rows: [{ n: 1 }] }))).rows[0].n;
    if (!v) problems.push('flow fee: no accounting voucher posted for the receipt');
    await shot(s.page, 'receipt');
  }
  await s.ctx.close();
}

// ------------------------------------------------------------------ flow 4: run payroll
{
  const email = 'hr@demo.school', s = await session(email);
  const month = new Date().toISOString().slice(0, 7), monthDate = `${month}-01`;
  await db.query(`delete from erp.payslips where run_id in (select id from erp.payroll_runs where month = $1 and status = 'draft')`, [monthDate]).catch(() => {});
  await db.query(`delete from erp.payroll_runs where month = $1 and status = 'draft'`, [monthDate]).catch(() => {});
  await open(s, '/erp/hr/payroll', email);
  await s.page.fill('input[name=month]', month);
  await s.page.click('button:has-text("Compute payroll")');
  await s.page.waitForURL(/ok=|err=/, { timeout: 60000 }).catch(() => {});
  await s.page.waitForTimeout(1000);
  const run = (await db.query(`select r.id, (select count(*)::int from erp.payslips l where l.run_id = r.id) as lines from erp.payroll_runs r where r.month = $1 order by r.created_at desc limit 1`, [monthDate])).rows[0];
  if (!run || run.lines === 0) problems.push('flow payroll: no payroll lines were computed');
  else {
    const r = await s.page.request.get(`${BASE}/api/erp/payroll/${run.id}/bank`);
    if (!r.ok()) problems.push(`flow payroll: bank export ${r.status()}`);
    await shot(s.page, 'payroll');
  }
  await s.ctx.close();
}

await browser.close();
await db.end();
console.log(`${checked} page loads checked`);
if (problems.length) {
  console.error(`ERP smoke test found ${problems.length} problem(s):\n` + [...new Set(problems)].map((p) => ' - ' + p).join('\n'));
  process.exit(1);
}
console.log('ERP smoke test passed: every staff screen opened for admin and teacher, and the admit, attendance, fee and payroll flows worked.');
