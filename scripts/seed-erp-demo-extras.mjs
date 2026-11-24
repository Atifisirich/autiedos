#!/usr/bin/env node
// Second pass of the ERP demo school: transport, library, store, forms, gate, assessments, templates, leave. Run after seed-erp-demo.mjs:
//   DATABASE_URL=postgres://postgres@localhost:54322/erpui node scripts/seed-erp-demo-extras.mjs
// Safe to run twice: it stops when the demo vehicle already exists.
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const c = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres@localhost:54322/erpui' });
await c.connect();
const q = async (sql, params = []) => (await c.query(sql, params)).rows;
const org = (await q(`select id from core.organizations where slug = 'demo-school'`))[0]?.id;
if (!org) throw new Error('Run seed-erp-demo.mjs first');

// Salary structures, bank details and HR profiles for every staff member that has none (payroll needs them).
{
  const iso0 = (d) => d.toISOString().slice(0, 10);
  const org0 = (await q(`select id from core.organizations where slug = 'demo-school'`))[0]?.id;
  const rows = await q(`select s.id from core.staff s where s.org_id = $1 and s.status = 'active' and not exists (select 1 from erp.salary_structures x where x.staff_id = s.id) order by s.employee_code`, [org0]);
  let i = 0;
  for (const r of rows) {
    i++;
    await q(`insert into erp.salary_structures (org_id, staff_id, effective_from, basic, hra, da, special_allowance, other_allowance, pf_applicable, esi_applicable, pt_applicable, tds_monthly) values ($1,$2,'2026-04-01',$3,$4,2000,3000,1000,true,false,true,$5)`, [org0, r.id, 20000 + i * 1500, 8000 + i * 500, i % 4 === 0 ? 1200 : 0]);
    await q(`insert into erp.staff_payroll (org_id, staff_id, bank_name, bank_account, ifsc, pan, uan, tax_regime) values ($1,$2,'State Bank of India',$3,'SBIN0001234',$4,$5,'new') on conflict do nothing`, [org0, r.id, `3300${100000 + i}`, `ABCDE${1000 + i}F`, `1012345${String(i).padStart(5, '0')}`]);
    await q(`insert into erp.staff_hr_profiles (org_id, staff_id, qualifications, experience_years, bgv_status) values ($1,$2,'B.Ed',$3,$4) on conflict do nothing`, [org0, r.id, 3 + i, i % 6 === 0 ? 'pending' : 'clear']);
  }
  if (rows.length) console.log(`payroll data added for ${rows.length} staff`);
  void iso0;
}
if ((await q(`select 1 from erp.vehicles where org_id = $1 limit 1`, [org])).length) { console.log('extras already seeded'); await c.end(); process.exit(0); }
const iso = (d) => d.toISOString().slice(0, 10);
const today = new Date();
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const ins = async (table, row, schema = 'erp') => {
  const keys = Object.keys(row);
  return (await q(`insert into ${schema}.${table} (org_id, ${keys.join(', ')}) values ($1, ${keys.map((_, i) => `$${i + 2}`).join(', ')}) returning id`, [org, ...keys.map((k) => (row[k] !== null && typeof row[k] === 'object' && !(row[k] instanceof Date) ? JSON.stringify(row[k]) : row[k]))]))[0].id;
};
await c.query('begin');
const main = (await q(`select id from core.branches where org_id = $1 and code = 'MAIN'`, [org]))[0].id;
const year = (await q(`select id from core.academic_years where org_id = $1 and is_current`, [org]))[0].id;
const sec1A = (await q(`select s.id, s.name, s.programme_id from core.sections s where s.org_id = $1 and s.academic_year_id = $2 order by s.name limit 1`, [org, year]))[0];
const students = await q(`select id from core.students where org_id = $1 and section_id = $2 order by admission_no limit 6`, [org, sec1A.id]);
const staffOf = async (email) => (await q(`select id from core.staff where org_id = $1 and email = $2`, [org, email]))[0]?.id ?? null;
const driver = await staffOf('driver@demo.school'), teacher = await staffOf('teacher@demo.school');
const subj = (await q(`select id from core.subjects where org_id = $1 order by code limit 1`, [org]))[0].id;

// ---------------------------------------------------------------- transport
const soon = iso(addDays(today, 20));
const bus = await ins('vehicles', { branch_id: main, reg_no: 'TS09 UA 1234', type: 'bus', capacity: 40, make_model: 'Tata Starbus', has_cctv: true, has_speed_governor: true, registration_expiry: iso(addDays(today, 200)), fitness_expiry: soon, insurance_expiry: iso(addDays(today, 90)), puc_expiry: iso(addDays(today, 60)) });
const route = await ins('routes', { branch_id: main, name: 'Route 1 · Kukatpally', vehicle_id: bus, driver_id: driver, zone: 'North', monthly_fee: 1800 });
const stops = [];
for (const [i, n] of ['KPHB Colony', 'JNTU Junction', 'Nizampet'].entries()) stops.push(await ins('stops', { route_id: route, name: n, sort: i + 1, pickup_time: `0${7 + Math.floor(i / 2)}:${i % 2 ? '20' : '00'}`, drop_time: `16:${10 + i * 10}`, fee: 1800 }));
for (const [i, s] of students.slice(0, 4).entries()) await ins('student_transport', { academic_year_id: year, student_id: s.id, route_id: route, stop_id: stops[i % 3], start_date: iso(addDays(today, -60)) });

// ---------------------------------------------------------------- library
await q(`insert into core.number_series (org_id, key, prefix, padding, next_value) values ($1, 'accession', 'ACC-', 5, 1) on conflict do nothing`, [org]);
let acc = 0;
for (const [t, a] of [['The Jungle Book', 'Rudyard Kipling'], ['Panchatantra Stories', 'Vishnu Sharma'], ['Wings of Fire', 'A P J Abdul Kalam'], ['Mathematics for Class 3', 'NCERT'], ['My First Atlas', 'Oxford']]) {
  const b = await ins('books', { title: t, author: a, category: 'general', language: 'English', location: 'Shelf A' });
  for (let k = 0; k < 2; k++) await ins('book_copies', { book_id: b, accession_no: `ACC-${String(++acc).padStart(5, '0')}`, status: 'available', location: 'Shelf A' });
}

// ---------------------------------------------------------------- store and canteen
const itemIds = [];
for (const [n, cat, price, cost] of [['Notebook (172 pages)', 'stationery', 40, 28], ['School tie', 'uniform', 120, 80], ['Water bottle', 'store', 150, 100], ['Veg sandwich', 'canteen', 35, 20], ['Fruit juice', 'canteen', 25, 15]]) {
  const it = await ins('items', { name: n, sku: n.slice(0, 3).toUpperCase() + itemIds.length, category: cat, unit: 'pc', price, cost, reorder_level: 20 });
  itemIds.push(it);
  await ins('stock_movements', { item_id: it, type: 'inward', qty: 100, note: 'Opening stock' });
}

// ---------------------------------------------------------------- forms, gate
await ins('forms', { title: 'Annual picnic consent', description: 'Please confirm your child may join the picnic.', audience: 'parents', status: 'published', fields: [{ key: 'consent', label: 'I consent', type: 'checkbox', required: true }, { key: 'allergies', label: 'Allergies', type: 'text' }], closes_on: iso(addDays(today, 14)) });
await ins('forms', { title: 'Parent feedback survey', audience: 'parents', status: 'draft', fields: [{ key: 'rating', label: 'Overall rating', type: 'number' }], is_feedback_survey: true });
await ins('visitors', { branch_id: main, name: 'Ravi Teja', phone: '+919800000001', type: 'visitor', purpose: 'Meet principal', host_name: 'Principal', status: 'in', in_at: new Date().toISOString(), badge_no: 'V-001' });
await ins('visitors', { branch_id: main, name: 'Courier (Blue Dart)', type: 'vendor', purpose: 'Delivery', status: 'out', in_at: addDays(today, 0).toISOString(), out_at: new Date().toISOString() });

// ---------------------------------------------------------------- assessments
const scale = await ins('grading_scales', { name: 'CBSE 9-point', bands: [{ min: 91, grade: 'A1', point: 10 }, { min: 81, grade: 'A2', point: 9 }, { min: 71, grade: 'B1', point: 8 }, { min: 61, grade: 'B2', point: 7 }, { min: 51, grade: 'C1', point: 6 }, { min: 41, grade: 'C2', point: 5 }, { min: 33, grade: 'D', point: 4 }, { min: 0, grade: 'E', point: 0 }] });
const scheme = await ins('assessment_schemes', { academic_year_id: year, name: 'Primary scheme', pack: 'cbse_primary', programme_id: sec1A.programme_id, scale_id: scale, config: { components: [{ key: 'ut', name: 'Unit test', weight: 40 }, { key: 'final', name: 'Final', weight: 60 }], pass_percent: 33 } });
await ins('assessments', { branch_id: main, academic_year_id: year, name: 'Unit Test 1 · ' + sec1A.name, scheme_id: scheme, term: 'Term 1', component: 'ut', section_id: sec1A.id, subject_id: subj, max_marks: 25, weightage: 40, date: iso(addDays(today, -3)), entry_deadline: iso(addDays(today, -1)), status: 'open', staff_id: teacher });

// ---------------------------------------------------------------- documents, leave
await ins('doc_templates', { name: 'Bonafide certificate', type: 'bonafide', body: 'This is to certify that {{student_name}} is a bonafide student of {{school_name}} studying in {{section}} during {{year}}.' });
await ins('doc_templates', { name: 'Transfer certificate', type: 'tc', body: '{{student_name}} (Admission {{admission_no}}) left {{school_name}} on {{date}}.' });
const lt = (await q(`select id from core.leave_types where org_id = $1 order by key limit 1`, [org]))[0];
if (lt && teacher) await ins('leave_requests', { branch_id: main, staff_id: teacher, leave_type_id: lt.id, start_date: iso(addDays(today, 3)), end_date: iso(addDays(today, 4)), half_day: 'none', days: 2, reason: 'Family function', status: 'pending' }, 'core');
await c.query('commit');
console.log('extras seeded', { route, books: acc, items: itemIds.length });
await c.end();
