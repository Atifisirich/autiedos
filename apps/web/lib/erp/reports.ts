/**
 * Report families (Appendix B): about 250 fixed reports become a few families with filters, grouping and export.
 * Each runner reads through the Data API as the signed-in user (RLS decides what a role can see); core names are resolved with
 * batched lookups because PostgREST cannot embed across the erp and core schemas.
 */
import { core, erp } from './db';
import type { Ctx } from './ctx';
import { fullNameOf, NO_ID } from './q';
import { look, lookup } from './lookup';
import { pct, today } from './fmt';
import { balance, ageingBucket, type Demand } from '@autoed/shared/erp';

export type Filters = { from: string; to: string; section?: string; group?: string };
type Row = Record<string, unknown>;
export type Report = { title: string; replaces: string; cap?: string; groups?: [string, string][]; run: (ctx: Ctx, f: Filters) => Promise<Row[]> };

const tally = <T,>(rows: T[], key: (r: T) => string, add: (acc: Record<string, number>, r: T) => void, label: string) => {
  const m = new Map<string, Record<string, number>>();
  for (const r of rows) { const k = key(r) || '—'; const a = m.get(k) ?? {}; add(a, r); m.set(k, a); }
  return [...m].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => ({ [label]: k, ...v }));
};
const inc = (a: Record<string, number>, k: string, n = 1) => { a[k] = (a[k] ?? 0) + n; };
const br = <T extends { or: (f: string) => T }>(q: T, ctx: Ctx) => (ctx.branchId ? q.or(`branch_id.eq.${ctx.branchId},branch_id.is.null`) : q);
const end = (d: string) => d + 'T23:59:59+05:30';
const start = (d: string) => d + 'T00:00:00+05:30';

export const REPORTS: Record<string, Report> = {
  strength: { title: 'Strength and enrolment', replaces: 'Strength report, nominal roll, segment, sibling, inactive students, strength audit, month-on-month', cap: 'students', groups: [['section', 'Section'], ['gender', 'Gender'], ['house', 'House'], ['status', 'Status'], ['month', 'Month joined'], ['roll', 'Nominal roll']],
    run: async (ctx, f) => {
      const { data } = await br(core(ctx.sb).from('students').select('admission_no, first_name, last_name, gender, house, status, joined_on, is_new, rte_quota, section_id').is('deleted_at', null).limit(20000), ctx);
      const R = (data ?? []) as { admission_no: string; first_name: string; last_name: string; gender: string; house: string; status: string; joined_on: string; is_new: boolean; rte_quota: boolean; section_id: string | null }[];
      const sec = await lookup(ctx, 'sections', R.map((r) => r.section_id));
      if (f.group === 'roll') return R.filter((r) => r.status === 'active').map((r) => ({ 'Admission no.': r.admission_no, Name: fullNameOf(r), Section: sec.name(r.section_id), Gender: r.gender, House: r.house, Joined: r.joined_on }));
      const key = (r: typeof R[number]) => f.group === 'gender' ? r.gender : f.group === 'house' ? r.house : f.group === 'status' ? r.status : f.group === 'month' ? String(r.joined_on ?? '').slice(0, 7) : sec.name(r.section_id);
      return tally(f.group === 'status' ? R : R.filter((r) => r.status === 'active'), key, (a, r) => { inc(a, 'Total'); inc(a, 'Boys', r.gender === 'male' ? 1 : 0); inc(a, 'Girls', r.gender === 'female' ? 1 : 0); inc(a, 'New', r.is_new ? 1 : 0); inc(a, 'RTE', r.rte_quota ? 1 : 0); }, 'Group');
    } },
  attendance: { title: 'Student attendance', replaces: 'Daily, monthly register, percentage bands, not-marked list, leave intimations', cap: 'attendance', groups: [['section', 'Section'], ['date', 'Date'], ['student', 'Student'], ['band', 'Percentage band']],
    run: async (ctx, f) => {
      let sid: string[] | null = null;
      if (f.section) { const { data } = await core(ctx.sb).from('students').select('id').eq('section_id', f.section).is('deleted_at', null).limit(5000); sid = ((data ?? []) as { id: string }[]).map((s) => s.id); }
      let q = core(ctx.sb).from('student_attendance_marks').select('date, status, student_id').eq('session_key', 'day').gte('date', f.from).lte('date', f.to).is('deleted_at', null).limit(100000);
      if (sid) q = q.in('student_id', sid.length ? sid : [NO_ID]);
      const { data } = await q;
      const R = (data ?? []) as { date: string; status: string; student_id: string }[];
      const st = await lookup(ctx, 'students', R.map((r) => r.student_id));
      const sec = await lookup(ctx, 'sections', R.map((r) => st.get(r.student_id)?.section_id));
      const add = (a: Record<string, number>, r: typeof R[number]) => { inc(a, 'Present', ['present', 'late', 'half_day', 'on_duty'].includes(r.status) ? 1 : 0); inc(a, 'Absent', r.status === 'absent' ? 1 : 0); inc(a, 'Late', r.status === 'late' ? 1 : 0); inc(a, 'Leave', r.status === 'on_leave' ? 1 : 0); };
      const withPct = (rows: Row[]) => rows.map((r) => ({ ...r, '%': pct(Number(r.Present), Number(r.Present) + Number(r.Absent)) }));
      if (f.group === 'band') { const per = withPct(tally(R, (r) => r.student_id, add, 'id')); return tally(per, (r) => { const p = Number(r['%']); return p >= 95 ? '95% and above' : p >= 85 ? '85 to 94%' : p >= 75 ? '75 to 84%' : 'Below 75%'; }, (a) => inc(a, 'Students'), 'Band'); }
      return withPct(tally(R, (r) => f.group === 'date' ? r.date : f.group === 'student' ? `${st.name(r.student_id)} (${String(st.get(r.student_id)?.admission_no ?? '')})` : sec.name(st.get(r.student_id)?.section_id), add, f.group === 'date' ? 'Date' : f.group === 'student' ? 'Student' : 'Section'));
    } },
  'staff-attendance': { title: 'Staff attendance and leave', replaces: 'Daily and monthly, late comers, leave details, regularisations', cap: 'staff', groups: [['staff', 'Staff'], ['date', 'Date']],
    run: async (ctx, f) => {
      const { data } = await core(ctx.sb).from('staff_attendance').select('date, status, staff_id').gte('date', f.from).lte('date', f.to).is('deleted_at', null).limit(50000);
      const R = (data ?? []) as { date: string; status: string; staff_id: string }[];
      const st = await lookup(ctx, 'staff', R.map((r) => r.staff_id));
      return tally(R, (r) => f.group === 'date' ? r.date : `${st.name(r.staff_id)} (${String(st.get(r.staff_id)?.employee_code ?? '')})`, (a, r) => { inc(a, 'Present', r.status === 'present' ? 1 : 0); inc(a, 'Late', r.status === 'late' ? 1 : 0); inc(a, 'Half day', r.status === 'half_day' ? 1 : 0); inc(a, 'Leave', r.status === 'on_leave' ? 1 : 0); inc(a, 'Absent', r.status === 'absent' ? 1 : 0); }, f.group === 'date' ? 'Date' : 'Staff');
    } },
  fees: { title: 'Collections', replaces: 'Day sheet, receipt book, mode-wise, head-wise, month-wise, trends, online payments, cheque statements', cap: 'fees', groups: [['date', 'Date'], ['mode', 'Mode'], ['head', 'Fee head'], ['section', 'Class'], ['collector', 'Collected by'], ['register', 'Receipt register']],
    run: async (ctx, f) => {
      const { data } = await br(erp(ctx.sb).from('receipts').select('receipt_no, date, total, status, collected_by_name, channel, student_id, payments:receipt_payments(mode, amount), allocations:receipt_allocations(amount, demand:fee_demands(head:fee_heads(name)))').gte('date', f.from).lte('date', f.to).is('deleted_at', null).limit(20000), ctx);
      const R = (data ?? []) as unknown as { receipt_no: string; date: string; total: number; status: string; collected_by_name: string; channel: string; student_id: string | null; payments: { mode: string; amount: number }[]; allocations: { amount: number; demand: { head: { name: string } | null } | null }[] }[];
      const st = await lookup(ctx, 'students', R.map((r) => r.student_id));
      const sec = await lookup(ctx, 'sections', R.map((r) => st.get(r.student_id)?.section_id));
      const secOf = (r: typeof R[number]) => sec.name(st.get(r.student_id)?.section_id);
      if (f.group === 'register') return R.map((r) => ({ Receipt: r.receipt_no, Date: r.date, Student: st.name(r.student_id), Class: secOf(r), Amount: r.total, Modes: r.payments.map((p) => p.mode).join(' + '), Status: r.status, 'Collected by': r.collected_by_name }));
      const V = R.filter((r) => r.status === 'valid');
      if (f.group === 'mode') return tally(V.flatMap((r) => r.payments), (p) => p.mode, (a, p) => { inc(a, 'Payments'); inc(a, 'Amount', Number(p.amount)); }, 'Mode');
      if (f.group === 'head') return tally(V.flatMap((r) => r.allocations), (x) => x.demand?.head?.name ?? '', (a, x) => inc(a, 'Amount', Number(x.amount)), 'Fee head');
      return tally(V, (r) => f.group === 'section' ? secOf(r) : f.group === 'collector' ? r.collected_by_name : r.date, (a, r) => { inc(a, 'Receipts'); inc(a, 'Amount', Number(r.total)); }, f.group === 'section' ? 'Class' : f.group === 'collector' ? 'Collected by' : 'Date');
    } },
  dues: { title: 'Dues and ageing', replaces: 'Class, branch, batch and month-wise dues, ageing, outstanding, previous-year dues, reminder slips', cap: 'fees', groups: [['section', 'Class'], ['bucket', 'Ageing'], ['head', 'Fee head'], ['student', 'Student']],
    run: async (ctx, f) => {
      const { data } = await br(erp(ctx.sb).from('fee_demands').select('amount, concession, fine, paid, due_date, carried_forward, student_id, head:fee_heads(name)').in('status', ['due', 'partial']).is('deleted_at', null).limit(50000), ctx);
      const d = today();
      const R = (data ?? []) as unknown as (Demand & { carried_forward: boolean; student_id: string; head: { name: string } | null })[];
      const st = await lookup(ctx, 'students', R.map((r) => r.student_id));
      const sec = await lookup(ctx, 'sections', R.map((r) => st.get(r.student_id)?.section_id));
      const key = (r: typeof R[number]) => f.group === 'bucket' ? ageingBucket(r.due_date, d) : f.group === 'head' ? r.head?.name ?? '' : f.group === 'student' ? `${st.name(r.student_id)} (${String(st.get(r.student_id)?.admission_no ?? '')})` : sec.name(st.get(r.student_id)?.section_id);
      return tally(R, key, (a, r) => { inc(a, 'Instalments'); inc(a, 'Outstanding', balance(r)); inc(a, 'Overdue', r.due_date < d ? balance(r) : 0); inc(a, 'Previous year', r.carried_forward ? balance(r) : 0); }, 'Group');
    } },
  concessions: { title: 'Concessions, refunds and changes', replaces: 'Concession, staff kids, sibling, scholarship, refunds, cancelled payments, fee edits', cap: 'fees', groups: [['type', 'Concession type'], ['status', 'Status'], ['reversals', 'Cancelled receipts']],
    run: async (ctx, f) => {
      if (f.group === 'reversals') { const { data } = await erp(ctx.sb).from('receipts').select('receipt_no, date, total, reversed_reason, collected_by_name').eq('status', 'reversed').is('deleted_at', null); return ((data ?? []) as { receipt_no: string; date: string; total: number; reversed_reason: string | null; collected_by_name: string | null }[]).map((r) => ({ Receipt: r.receipt_no, Date: r.date, Amount: r.total, Reason: r.reversed_reason, 'Collected by': r.collected_by_name })); }
      const { data } = await erp(ctx.sb).from('concessions').select('amount, status, kind, value, type:concession_types(name)').is('deleted_at', null).limit(20000);
      return tally((data ?? []) as unknown as { amount: number; status: string; type: { name: string } | null }[], (r) => f.group === 'status' ? r.status : r.type?.name ?? 'Other', (a, r) => { inc(a, 'Count'); inc(a, 'Revenue impact', r.status === 'approved' ? Number(r.amount) : 0); }, 'Group');
    } },
  academics: { title: 'Academic results', replaces: 'Test, term and evaluation analysis, grade-wise, subject and teacher analysis, toppers', cap: 'marks', groups: [['subject', 'Subject'], ['section', 'Section'], ['assessment', 'Assessment'], ['teacher', 'Teacher'], ['toppers', 'Toppers']],
    run: async (ctx, f) => {
      const { data } = await erp(ctx.sb).from('assessment_results').select('marks, student_id, assessment:assessments(name, max_marks, section_id, subject_id, staff_id)').not('marks', 'is', null).is('deleted_at', null).limit(100000);
      let R = (data ?? []) as unknown as { marks: number; student_id: string; assessment: { name: string; max_marks: number; section_id: string; subject_id: string; staff_id: string | null } | null }[];
      if (f.section) R = R.filter((r) => r.assessment?.section_id === f.section);
      const lk = await look(ctx, { students: R.map((r) => r.student_id), sections: R.map((r) => r.assessment?.section_id), subjects: R.map((r) => r.assessment?.subject_id), staff: R.map((r) => r.assessment?.staff_id) });
      const p = (r: typeof R[number]) => (Number(r.marks) / Number(r.assessment?.max_marks || 100)) * 100;
      const rows = tally(R, (r) => f.group === 'toppers' ? lk.students.name(r.student_id) : f.group === 'section' ? lk.sections.name(r.assessment?.section_id) : f.group === 'assessment' ? r.assessment?.name ?? '' : f.group === 'teacher' ? lk.staff.name(r.assessment?.staff_id) : lk.subjects.name(r.assessment?.subject_id), (a, r) => { inc(a, 'Entries'); inc(a, '_sum', p(r)); inc(a, 'Below 33%', p(r) < 33 ? 1 : 0); inc(a, '90% and above', p(r) >= 90 ? 1 : 0); }, 'Group').map(({ _sum, ...r }) => ({ ...r, 'Average %': Math.round((Number(_sum) / Number((r as Record<string, number>).Entries)) * 10) / 10 }));
      return f.group === 'toppers' ? rows.sort((a, b) => b['Average %'] - a['Average %']).slice(0, 25) : rows;
    } },
  homework: { title: 'Homework and diary', replaces: 'Assignment status, diary submissions, posting compliance', cap: 'homework', groups: [['teacher', 'Teacher'], ['section', 'Section'], ['type', 'Type']],
    run: async (ctx, f) => {
      const { data } = await core(ctx.sb).from('class_posts').select('type, staff_id, status, section_id').gte('created_at', start(f.from)).lte('created_at', end(f.to)).is('deleted_at', null).limit(50000);
      const R = (data ?? []) as { type: string; staff_id: string | null; status: string; section_id: string | null }[];
      const lk = await look(ctx, { staff: R.map((r) => r.staff_id), sections: R.map((r) => r.section_id) });
      return tally(R, (r) => f.group === 'section' ? lk.sections.name(r.section_id) : f.group === 'type' ? r.type : lk.staff.name(r.staff_id), (a, r) => { inc(a, 'Posts'); inc(a, 'Published', r.status === 'published' ? 1 : 0); inc(a, 'Awaiting approval', r.status === 'pending' ? 1 : 0); }, 'Group');
    } },
  conduct: { title: 'Learner profile and conduct', replaces: 'Discipline summaries, anecdotes, observations, counselling, achievements', cap: 'wellbeing', groups: [['type', 'Type'], ['category', 'Category'], ['student', 'Student']],
    run: async (ctx, f) => {
      const { data } = await erp(ctx.sb).from('growth_records').select('type, category, points, student_id').gte('date', f.from).lte('date', f.to).is('deleted_at', null).limit(50000);
      const R = (data ?? []) as { type: string; category: string | null; points: number | null; student_id: string }[];
      const st = await lookup(ctx, 'students', R.map((r) => r.student_id));
      return tally(R, (r) => f.group === 'category' ? r.category ?? '' : f.group === 'student' ? st.name(r.student_id) : r.type, (a, r) => { inc(a, 'Records'); inc(a, 'Points', Number(r.points ?? 0)); }, 'Group');
    } },
  transport: { title: 'Transport', replaces: 'Route and stop lists, day-wise trips, fuel and mileage, maintenance, seating', cap: 'transport', groups: [['route', 'Route occupancy'], ['trips', 'Trips'], ['costs', 'Cost per vehicle']],
    run: async (ctx, f) => {
      const [{ data: routes }, { data: vehicles }] = await Promise.all([erp(ctx.sb).from('routes').select('id, name, vehicle_id').is('deleted_at', null), erp(ctx.sb).from('vehicles').select('id, reg_no, capacity').is('deleted_at', null)]);
      const rt = new Map(((routes ?? []) as { id: string; name: string; vehicle_id: string | null }[]).map((r) => [r.id, r]));
      const vh = new Map(((vehicles ?? []) as { id: string; reg_no: string; capacity: number }[]).map((v) => [v.id, v]));
      if (f.group === 'trips') { const { data } = await erp(ctx.sb).from('trips').select('date, direction, status, delay_minutes, route_id').gte('date', f.from).lte('date', f.to).is('deleted_at', null); return tally((data ?? []) as { delay_minutes: number; route_id: string }[], (r) => rt.get(r.route_id)?.name ?? '', (a, r) => { inc(a, 'Trips'); inc(a, 'On time', r.delay_minutes > 0 ? 0 : 1); inc(a, 'Late', r.delay_minutes > 0 ? 1 : 0); }, 'Route'); }
      if (f.group === 'costs') { const { data } = await erp(ctx.sb).from('vehicle_logs').select('type, amount, litres, vehicle_id').gte('date', f.from).lte('date', f.to).is('deleted_at', null); return tally((data ?? []) as { type: string; amount: number | null; litres: number | null; vehicle_id: string }[], (r) => vh.get(r.vehicle_id)?.reg_no ?? '', (a, r) => { inc(a, 'Fuel cost', r.type === 'fuel' ? Number(r.amount ?? 0) : 0); inc(a, 'Litres', Number(r.litres ?? 0)); inc(a, 'Maintenance', r.type === 'maintenance' ? Number(r.amount ?? 0) : 0); }, 'Vehicle'); }
      const { data } = await erp(ctx.sb).from('student_transport').select('route_id').eq('active', true).is('deleted_at', null).limit(20000);
      const rows = tally((data ?? []) as { route_id: string }[], (r) => rt.get(r.route_id)?.name ?? '', (a) => inc(a, 'Students'), 'Route');
      return rows.map((r) => { const route = [...rt.values()].find((x) => x.name === (r as Row).Route); return { ...r, Capacity: route?.vehicle_id ? vh.get(route.vehicle_id)?.capacity ?? 0 : 0 }; });
    } },
  gate: { title: 'Gate and visitors', replaces: 'Visitor log, gate passes, pickups, vendor visits', cap: 'gate', groups: [['date', 'Date'], ['type', 'Visitor type'], ['passes', 'Gate passes']],
    run: async (ctx, f) => {
      if (f.group === 'passes') { const { data } = await erp(ctx.sb).from('gate_passes').select('status, created_at, handed_over_at, collector_name, student_id').gte('created_at', start(f.from)).lte('created_at', end(f.to)).is('deleted_at', null); const R = (data ?? []) as { status: string; created_at: string; handed_over_at: string | null; collector_name: string | null; student_id: string }[]; const st = await lookup(ctx, 'students', R.map((r) => r.student_id)); return R.map((r) => ({ Student: st.name(r.student_id), Collector: r.collector_name, Requested: r.created_at.slice(0, 16), 'Handed over': r.handed_over_at?.slice(0, 16) ?? '', Status: r.status })); }
      const { data } = await erp(ctx.sb).from('visitors').select('type, in_at').gte('in_at', start(f.from)).lte('in_at', end(f.to)).is('deleted_at', null).limit(50000);
      return tally((data ?? []) as { type: string; in_at: string }[], (r) => f.group === 'type' ? r.type : String(r.in_at).slice(0, 10), (a) => inc(a, 'Visitors'), 'Group');
    } },
  library: { title: 'Library', replaces: 'Circulation, issues by student, fines, stock, location', cap: 'library', groups: [['book', 'Popular titles'], ['student', 'Reading history'], ['overdue', 'Overdue']],
    run: async (ctx, f) => {
      const { data } = await erp(ctx.sb).from('loans').select('issued_on, due_on, returned_on, fine, student_id, book:books(title)').gte('issued_on', f.from).lte('issued_on', f.to).is('deleted_at', null).limit(50000);
      const R = (data ?? []) as unknown as { issued_on: string; due_on: string; returned_on: string | null; fine: number; student_id: string | null; book: { title: string } | null }[];
      const st = await lookup(ctx, 'students', R.map((r) => r.student_id));
      if (f.group === 'overdue') return R.filter((r) => !r.returned_on && r.due_on < today()).map((r) => ({ Book: r.book?.title, Borrower: st.name(r.student_id), Due: r.due_on }));
      return tally(R, (r) => f.group === 'student' ? st.name(r.student_id) : r.book?.title ?? '', (a, r) => { inc(a, 'Issues'); inc(a, 'Fines', Number(r.fine)); }, 'Group').sort((a, b) => Number((b as Record<string, number>).Issues) - Number((a as Record<string, number>).Issues));
    } },
  store: { title: 'Store, canteen and inventory', replaces: 'Sales, kits, stock, orders, issues, wallet balances', cap: 'inventory', groups: [['item', 'Item'], ['counter', 'Counter'], ['date', 'Date']],
    run: async (ctx, f) => {
      const { data } = await erp(ctx.sb).from('sales').select('counter, at, total, lines').gte('at', start(f.from)).lte('at', end(f.to)).is('deleted_at', null).limit(50000);
      const R = (data ?? []) as { counter: string; at: string; total: number; lines: { name: string; qty: number; price: number }[] }[];
      if (f.group === 'item') return tally(R.flatMap((r) => r.lines), (l) => l.name, (a, l) => { inc(a, 'Quantity', l.qty); inc(a, 'Sales', l.qty * l.price); }, 'Item');
      return tally(R, (r) => f.group === 'date' ? r.at.slice(0, 10) : r.counter, (a, r) => { inc(a, 'Bills'); inc(a, 'Sales', Number(r.total)); }, 'Group');
    } },
  hr: { title: 'HR and payroll', replaces: 'Staff list, inactive staff, payroll register, statutory reports, trainings', cap: 'staff', groups: [['department', 'Department'], ['type', 'Staff type'], ['status', 'Status'], ['list', 'Staff list']],
    run: async (ctx, f) => {
      const { data } = await br(core(ctx.sb).from('staff').select('employee_code, first_name, last_name, position_id, department_id, staff_type, status, joined_on, gender').is('deleted_at', null).limit(5000), ctx);
      const R = (data ?? []) as { employee_code: string | null; first_name: string; last_name: string | null; position_id: string | null; department_id: string | null; staff_type: string; status: string; joined_on: string | null; gender: string | null }[];
      const lk = await look(ctx, { positions: R.map((r) => r.position_id), departments: R.map((r) => r.department_id) });
      if (f.group === 'list') return R.map((r) => ({ Code: r.employee_code, Name: fullNameOf(r), Position: lk.positions.name(r.position_id), Department: lk.departments.name(r.department_id), Type: r.staff_type, Status: r.status, Joined: r.joined_on }));
      return tally(R, (r) => f.group === 'type' ? r.staff_type : f.group === 'status' ? r.status : lk.departments.name(r.department_id), (a, r) => { inc(a, 'Staff'); inc(a, 'Women', r.gender === 'female' ? 1 : 0); }, 'Group');
    } },
  communication: { title: 'Communication', replaces: 'Messages sent, delivered, read, failed, credits used, acknowledgements', cap: 'messages', groups: [['message', 'Message'], ['channel', 'Channel']],
    run: async (ctx, f) => {
      if (f.group === 'channel') { const { data } = await core(ctx.sb).from('outbox').select('channel, status, cost').gte('created_at', start(f.from)).lte('created_at', end(f.to)).is('deleted_at', null).limit(50000); return tally((data ?? []) as { channel: string; status: string; cost: number | null }[], (r) => r.channel, (a, r) => { inc(a, 'Messages'); inc(a, 'Queued', r.status === 'queued' ? 1 : 0); inc(a, 'Sent', ['sent', 'delivered'].includes(r.status) ? 1 : 0); inc(a, 'Failed', r.status === 'failed' ? 1 : 0); inc(a, 'Cost', Number(r.cost ?? 0)); }, 'Channel'); }
      const { data } = await erp(ctx.sb).from('announcement_recipients').select('title, read_at, ack_at').gte('created_at', start(f.from)).lte('created_at', end(f.to)).is('deleted_at', null).limit(100000);
      return tally((data ?? []) as { title: string | null; read_at: string | null; ack_at: string | null }[], (r) => r.title ?? '', (a, r) => { inc(a, 'Sent'); inc(a, 'Read', r.read_at ? 1 : 0); inc(a, 'Acknowledged', r.ack_at ? 1 : 0); }, 'Message');
    } },
  requests: { title: 'Requests and concerns', replaces: 'Concerns summary, TC requests, SLA compliance', cap: 'helpdesk', groups: [['category', 'Category'], ['owner', 'Owner'], ['priority', 'Priority']],
    run: async (ctx, f) => {
      const [{ data }, { data: cats }] = await Promise.all([core(ctx.sb).from('tickets').select('priority, category_id, owner_role_key, status, due_at, resolved_at').gte('created_at', start(f.from)).lte('created_at', end(f.to)).is('deleted_at', null).limit(50000), core(ctx.sb).from('ticket_categories').select('id, name').is('deleted_at', null)]);
      const cn = new Map(((cats ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name]));
      return tally((data ?? []) as { priority: string; category_id: string | null; owner_role_key: string | null; due_at: string | null; resolved_at: string | null }[], (r) => f.group === 'owner' ? r.owner_role_key ?? '' : f.group === 'priority' ? r.priority : (r.category_id ? cn.get(r.category_id) : '') ?? '', (a, r) => { inc(a, 'Requests'); inc(a, 'Closed', r.resolved_at ? 1 : 0); inc(a, 'Within SLA', r.resolved_at && (!r.due_at || r.resolved_at <= r.due_at) ? 1 : 0); inc(a, 'Open past SLA', !r.resolved_at && r.due_at && r.due_at < new Date().toISOString() ? 1 : 0); }, 'Group');
    } },
  usage: { title: 'Usage and adoption', replaces: 'Login statistics, never logged in, app adoption, checklist compliance', cap: 'admin', groups: [['role', 'Role'], ['status', 'Account status']],
    run: async (ctx, f) => {
      const [{ data: users }, { data: access }] = await Promise.all([core(ctx.sb).from('org_users').select('user_id, kind, display_name, status').limit(20000), core(ctx.sb).from('user_product_access').select('user_id, role_key').eq('product_key', 'erp').is('revoked_at', null)]);
      const role = new Map(((access ?? []) as { user_id: string; role_key: string }[]).map((a) => [a.user_id, a.role_key]));
      return tally((users ?? []) as { user_id: string; kind: string; status: string }[], (r) => f.group === 'status' ? r.status : role.get(r.user_id) ?? r.kind, (a, r) => { inc(a, 'Users'); inc(a, 'Active', r.status === 'active' ? 1 : 0); inc(a, 'Invited, not yet joined', r.status === 'invited' ? 1 : 0); inc(a, 'Disabled', r.status === 'disabled' ? 1 : 0); }, 'Group');
    } },
  admissions: { title: 'Admissions', replaces: 'Joining by class and month and the post-admission checklist (the enquiry pipeline reports are in the CRM)', cap: 'admissions', groups: [['grade', 'Class'], ['month', 'Month joined'], ['checklist', 'Checklist status']],
    run: async (ctx, f) => {
      if (f.group === 'checklist') { const { data } = await erp(ctx.sb).from('post_admission_tasks').select('task, done').gte('created_at', start(f.from)).lte('created_at', end(f.to)).is('deleted_at', null); return tally((data ?? []) as { task: string; done: boolean }[], (r) => r.task, (a, r) => { inc(a, 'Students'); inc(a, 'Done', r.done ? 1 : 0); inc(a, 'Open', r.done ? 0 : 1); }, 'Task'); }
      const { data } = await br(core(ctx.sb).from('students').select('joined_on, programme_id, status').gte('joined_on', f.from).lte('joined_on', f.to).is('deleted_at', null).limit(20000), ctx);
      const R = (data ?? []) as { joined_on: string; programme_id: string | null; status: string }[];
      const pg = await lookup(ctx, 'programmes', R.map((r) => r.programme_id));
      return tally(R, (r) => f.group === 'month' ? String(r.joined_on).slice(0, 7) : pg.name(r.programme_id), (a, r) => { inc(a, 'Admitted'); inc(a, 'Active', r.status === 'active' ? 1 : 0); inc(a, 'Left', ['withdrawn', 'transferred'].includes(r.status) ? 1 : 0); }, 'Group');
    } },
  statutory: { title: 'Statutory and government exports', replaces: 'UDISE+ data, APAAR status, board registration lists (Classes 9 to 12), RTE', cap: 'students', groups: [['udise', 'UDISE+ enrolment'], ['apaar', 'APAAR status'], ['board', 'Board registration list'], ['rte', 'RTE quota']],
    run: async (ctx, f) => {
      const { data } = await br(core(ctx.sb).from('students').select('admission_no, first_name, last_name, dob, gender, apaar_id, pen, rte_quota, mother_tongue, section_id, programme_id').eq('status', 'active').is('deleted_at', null).limit(20000), ctx);
      const R = (data ?? []) as { admission_no: string; first_name: string; last_name: string; dob: string; gender: string; apaar_id: string | null; pen: string | null; rte_quota: boolean; section_id: string | null; programme_id: string | null }[];
      const lk = await look(ctx, { sections: R.map((r) => r.section_id), programmes: R.map((r) => r.programme_id) });
      if (f.group === 'apaar') return R.filter((r) => !r.apaar_id).map((r) => ({ 'Admission no.': r.admission_no, Name: fullNameOf(r), Class: lk.sections.name(r.section_id), 'Date of birth': r.dob, PEN: r.pen ?? 'missing', 'APAAR ID': 'missing' }));
      if (f.group === 'board') return R.filter((r) => /(9|10|11|12|IGCSE|AS|A Level)/.test(lk.programmes.name(r.programme_id))).map((r) => ({ Class: lk.programmes.name(r.programme_id), 'Admission no.': r.admission_no, 'Student name': fullNameOf(r).toUpperCase(), 'Date of birth': r.dob, Gender: r.gender, 'APAAR ID': r.apaar_id ?? '' }));
      if (f.group === 'rte') return R.filter((r) => r.rte_quota).map((r) => ({ 'Admission no.': r.admission_no, Name: fullNameOf(r), Class: lk.sections.name(r.section_id) }));
      return tally(R, (r) => lk.programmes.name(r.programme_id), (a, r) => { inc(a, 'Boys', r.gender === 'male' ? 1 : 0); inc(a, 'Girls', r.gender === 'female' ? 1 : 0); inc(a, 'Total'); inc(a, 'RTE', r.rte_quota ? 1 : 0); inc(a, 'With APAAR ID', r.apaar_id ? 1 : 0); }, 'Class');
    } },
};
