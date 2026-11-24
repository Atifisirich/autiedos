import type { Ctx } from './ctx';
import { core, erp } from './db';
import { today, pct } from './fmt';
import { addDays } from './calendar';
import { NO_ID } from './q';
import { balance, type Demand } from '@autoed/shared/erp';
import { lookup } from './lookup';

export type Insight = { title: string; detail: string; href: string; tone: 'warn' | 'bad' | 'info' };
/** Insight cards (RPT-08): rule-based, each with a link to the records behind it. */
export async function insightCards(ctx: Ctx): Promise<Insight[]> {
  const d = today(), w1 = addDays(d, -7), w2 = addDays(d, -14), m1 = addDays(d, -30), m2 = addDays(d, -60);
  const out: Insight[] = [];
  const [att, rec, asm, posts, con, dues, sections] = await Promise.all([
    core(ctx.sb).from('student_attendance_marks').select('date, status, student_id').eq('session_key', 'day').gte('date', w2).is('deleted_at', null).limit(100000),
    ctx.can('fees') ? erp(ctx.sb).from('receipts').select('date, total').eq('status', 'valid').gte('date', m2).is('deleted_at', null).limit(50000) : Promise.resolve({ data: [] }),
    ctx.can('marks') ? erp(ctx.sb).from('assessments').select('id, name, entry_deadline, staff_id').eq('status', 'open').lt('entry_deadline', d).is('deleted_at', null).limit(500) : Promise.resolve({ data: [] }),
    core(ctx.sb).from('class_posts').select('section_id').gte('created_at', w1 + 'T00:00:00+05:30').is('deleted_at', null).limit(20000),
    ctx.can('concessions') ? erp(ctx.sb).from('concessions').select('amount, approved_at').eq('status', 'approved').gte('approved_at', m2).is('deleted_at', null).limit(5000) : Promise.resolve({ data: [] }),
    ctx.can('fees') ? erp(ctx.sb).from('fee_demands').select('amount, concession, fine, paid, due_date').in('status', ['due', 'partial']).lt('due_date', addDays(d, -60)).is('deleted_at', null).limit(20000) : Promise.resolve({ data: [] }),
    core(ctx.sb).from('sections').select('id, name').eq('academic_year_id', ctx.year?.id ?? NO_ID).is('deleted_at', null),
  ]);
  const A = (att.data ?? []) as { date: string; status: string; student_id: string }[];
  const st = await lookup(ctx, 'students', A.map((a) => a.student_id));
  const rate = (rows: { status: string }[]) => { const r = rows.filter((x) => x.status !== 'on_leave'); return r.length ? pct(r.filter((x) => x.status !== 'absent').length, r.length) : null; };
  const now = rate(A.filter((a) => a.date >= w1)), before = rate(A.filter((a) => a.date < w1));
  if (now !== null && before !== null && before - now >= 3) out.push({ title: `Attendance dipped to ${now}%`, detail: `It was ${before}% the week before.`, href: '/erp/reports/attendance?group=section', tone: 'warn' });
  const S = (sections.data ?? []) as { id: string; name: string }[];
  for (const s of S) { const r = rate(A.filter((a) => st.get(a.student_id)?.section_id === s.id && a.date >= w1)); if (r !== null && r < 80) out.push({ title: `${s.name}: attendance ${r}% this week`, detail: 'Below 80%. Check for illness or a pattern.', href: `/erp/reports/attendance?section=${s.id}&group=student`, tone: 'warn' }); }
  const R = (rec.data ?? []) as { date: string; total: number }[]; const c1 = R.filter((r) => r.date >= m1).reduce((t, r) => t + Number(r.total), 0), c2 = R.filter((r) => r.date < m1).reduce((t, r) => t + Number(r.total), 0);
  if (c2 > 0 && c1 < c2 * 0.7) out.push({ title: 'Collections slowed', detail: `Rs ${Math.round(c1).toLocaleString('en-IN')} in the last 30 days against Rs ${Math.round(c2).toLocaleString('en-IN')} in the 30 before.`, href: '/erp/reports/fees?group=date', tone: 'warn' });
  const old = (dues.data ?? []) as Demand[]; if (old.length) out.push({ title: `${old.length} instalments are more than 60 days overdue`, detail: `Rs ${Math.round(old.reduce((t, x) => t + balance(x), 0)).toLocaleString('en-IN')} outstanding.`, href: '/erp/fees/dues?bucket=90%2B', tone: 'bad' });
  const late = (asm.data ?? []) as { staff_id: string | null }[];
  if (late.length) { const sn = await lookup(ctx, 'staff', late.map((l) => l.staff_id)); const names = [...new Set(late.map((l) => sn.name(l.staff_id) || 'unassigned'))]; out.push({ title: `${late.length} assessments are past the marks deadline`, detail: `Teachers: ${names.slice(0, 5).join(', ')}${names.length > 5 ? ' and others' : ''}.`, href: '/erp/assessments?tab=board', tone: 'warn' }); }
  const posted = new Set(((posts.data ?? []) as { section_id: string }[]).map((p) => p.section_id)); const quiet = S.filter((s) => !posted.has(s.id));
  if (quiet.length && S.length) out.push({ title: `${quiet.length} sections had no homework or diary post this week`, detail: quiet.slice(0, 6).map((s) => s.name).join(', '), href: '/erp/homework?tab=compliance', tone: 'info' });
  const C = (con.data ?? []) as { amount: number; approved_at: string | null }[]; const k1 = C.filter((c) => (c.approved_at ?? '') >= m1).reduce((t, c) => t + Number(c.amount), 0), k2 = C.filter((c) => (c.approved_at ?? '') < m1).reduce((t, c) => t + Number(c.amount), 0);
  if (k1 > k2 * 1.5 && k1 > 0) out.push({ title: 'Concessions are growing unusually fast', detail: `Rs ${Math.round(k1).toLocaleString('en-IN')} approved in the last 30 days against Rs ${Math.round(k2).toLocaleString('en-IN')} before.`, href: '/erp/reports/concessions', tone: 'warn' });
  return out;
}
