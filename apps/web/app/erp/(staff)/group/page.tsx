import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCtx } from '@/lib/erp/ctx';
import { core, erp } from '@/lib/erp/db';
import { Page, Card, Empty } from '@/components/erp/ui';
import { today, pct, inrShort } from '@/lib/erp/fmt';
import { balance, type Demand } from '@autoed/shared/erp';
import { setFilter } from '@/lib/erp/actions';
import { NO_ID } from '@/lib/erp/q';

export const metadata = { title: 'Group console' };
type Dem = Demand & { branch_id: string | null };
/** Group console (GRP-01): compare branches on strength, attendance, collections, dues, staff and service without switching context. */
export default async function Group() {
  const ctx = await getCtx();
  if (ctx.orgUser.home_branch_id || !ctx.can('reports')) redirect('/erp');
  const d = today(), c = core(ctx.sb);
  const [st, att, dem, staff, tk, subs, secs, progs] = await Promise.all([
    c.from('students').select('id, branch_id').eq('status', 'active').is('deleted_at', null).limit(50000),
    c.from('student_attendance_marks').select('student_id, status').eq('date', d).eq('session_key', 'day').is('deleted_at', null).limit(50000),
    ctx.can('fees') ? erp(ctx.sb).from('fee_demands').select('branch_id, amount, concession, fine, paid, due_date').eq('academic_year_id', ctx.year?.id ?? NO_ID).neq('status', 'cancelled').is('deleted_at', null).limit(100000) : Promise.resolve({ data: [] }),
    c.from('staff').select('branch_id').eq('status', 'active').is('deleted_at', null),
    c.from('tickets').select('branch_id, status').in('status', ['open', 'in_progress', 'waiting']).is('deleted_at', null),
    c.from('student_attendance_sessions').select('section_id').eq('date', d).eq('session_key', 'day').eq('status', 'submitted').is('deleted_at', null),
    c.from('sections').select('id, programme_id').eq('academic_year_id', ctx.year?.id ?? NO_ID).is('deleted_at', null),
    c.from('programmes').select('id, branch_id').is('deleted_at', null),
  ]);
  const students = (st.data ?? []) as { id: string; branch_id: string | null }[];
  const stBranch = new Map(students.map((s) => [s.id, s.branch_id]));
  const progBranch = new Map(((progs.data ?? []) as { id: string; branch_id: string | null }[]).map((p) => [p.id, p.branch_id]));
  const secBranch = new Map(((secs.data ?? []) as { id: string; programme_id: string }[]).map((s) => [s.id, progBranch.get(s.programme_id) ?? null]));
  const nb = (rows: { branch_id: string | null }[] | null, b: string) => (rows ?? []).filter((r) => r.branch_id === b).length;
  const rows = ctx.branches.map((b) => {
    const a = ((att.data ?? []) as { student_id: string; status: string }[]).filter((x) => stBranch.get(x.student_id) === b.id);
    const D = ((dem.data ?? []) as Dem[]).filter((x) => x.branch_id === b.id);
    const dueTo = D.filter((x) => x.due_date <= d).reduce((t, x) => t + Number(x.amount) - Number(x.concession) + Number(x.fine), 0);
    const marked = ((subs.data ?? []) as { section_id: string }[]).filter((x) => secBranch.get(x.section_id) === b.id).length;
    const total = [...secBranch.values()].filter((x) => x === b.id).length;
    return { b, strength: nb(students, b.id), att: a.length ? pct(a.filter((x) => !['absent', 'on_leave'].includes(x.status)).length, a.length) : null, marked: `${marked} / ${total}`, collected: D.reduce((t, x) => t + Number(x.paid), 0), eff: dueTo ? pct(D.filter((x) => x.due_date <= d).reduce((t, x) => t + Number(x.paid), 0), dueTo) : null, overdue: D.filter((x) => x.due_date < d).reduce((t, x) => t + balance(x), 0), staff: nb(staff.data as { branch_id: string | null }[], b.id), tickets: nb(tk.data as { branch_id: string | null }[], b.id) };
  });
  const sum = (k: 'strength' | 'collected' | 'overdue' | 'staff' | 'tickets') => rows.reduce((t, r) => t + r[k], 0);
  return (
    <Page title="Group console" sub={`${ctx.branches.length} branch${ctx.branches.length === 1 ? '' : 'es'} · ${ctx.year?.name ?? ''}`} actions={<><Link className="btn-ghost" href="/erp/x/branches">Branches</Link><Link className="btn-ghost" href="/erp/x/quality_audits">Quality audits</Link></>}>
      <Card>{rows.length === 0 ? <Empty title="No branches" /> : <div className="overflow-x-auto"><table className="tbl"><thead><tr><th>Branch</th><th>City</th><th className="text-right">Strength</th><th className="text-right">Attendance today</th><th className="text-right">Sections marked</th><th className="text-right">Collected</th><th className="text-right">Collection efficiency</th><th className="text-right">Overdue</th><th className="text-right">Staff</th><th className="text-right">Open requests</th><th></th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.b.id}><td className="font-medium">{r.b.name}</td><td>{r.b.city}</td><td className="text-right tabular-nums">{r.strength}</td><td className="text-right tabular-nums">{r.att === null ? '—' : `${r.att}%`}</td><td className="text-right tabular-nums">{r.marked}</td><td className="text-right tabular-nums">{inrShort(r.collected)}</td><td className="text-right tabular-nums">{r.eff === null ? '—' : `${r.eff}%`}</td><td className="text-right tabular-nums">{inrShort(r.overdue)}</td><td className="text-right tabular-nums">{r.staff}</td><td className="text-right tabular-nums">{r.tickets}</td>
          <td><form action={setFilter}><input type="hidden" name="branch" value={r.b.id} /><button className="link text-sm">Drill down</button></form></td></tr>)}
          {rows.length > 1 && <tr className="font-semibold"><td colSpan={2}>Group</td><td className="text-right tabular-nums">{sum('strength')}</td><td /><td /><td className="text-right tabular-nums">{inrShort(sum('collected'))}</td><td /><td className="text-right tabular-nums">{inrShort(sum('overdue'))}</td><td className="text-right tabular-nums">{sum('staff')}</td><td className="text-right tabular-nums">{sum('tickets')}</td><td /></tr>}</tbody></table></div>}</Card>
      <p className="mt-3 text-sm text-muted">Drill down sets the branch filter in the header; choose &ldquo;All branches&rdquo; to come back. Group-level masters (fee heads, grading scales, templates, roles) are shared by every branch.</p>
    </Page>
  );
}
