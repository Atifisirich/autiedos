import Link from 'next/link';
import { requireCap } from '@/lib/erp/ctx';
import { core } from '@/lib/erp/db';
import { sectionsFor } from '@/lib/erp/q';
import { lookup } from '@/lib/erp/lookup';
import { Page, Card, Empty, Badge, Stat } from '@/components/erp/ui';
import { today, fdate, ftime, pct } from '@/lib/erp/fmt';
import { workingDay } from '@/lib/erp/calendar';

export const metadata = { title: 'Attendance' };
/** Live "not marked" board for coordinators; teachers see their own sections first (ATT-06). */
export default async function Board({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const { date = today() } = await searchParams;
  const ctx = await requireCap('attendance');
  const [sections, { data: subs }, wd, { data: counts }] = await Promise.all([
    sectionsFor(ctx),
    core(ctx.sb).from('student_attendance_sessions').select('id, section_id, submitted_at, marked_by_name, status').eq('date', date).eq('session_key', 'day').eq('status', 'submitted').is('deleted_at', null),
    workingDay(ctx, date),
    core(ctx.sb).from('students').select('section_id').eq('status', 'active').is('deleted_at', null).limit(20000),
  ]);
  const subRows = (subs ?? []) as { id: string; section_id: string; submitted_at: string | null; marked_by_name: string | null }[];
  const sessionIds = subRows.map((s) => s.id);
  const { data: marks } = sessionIds.length ? await core(ctx.sb).from('student_attendance_marks').select('session_id, status').in('session_id', sessionIds).is('deleted_at', null).limit(20000) : { data: [] };
  const tally = new Map<string, { present: number; absent: number; late: number }>();
  for (const m of (marks ?? []) as { session_id: string; status: string }[]) {
    const t = tally.get(m.session_id) ?? { present: 0, absent: 0, late: 0 };
    if (m.status === 'absent') t.absent++; else if (m.status === 'late') t.late++; else if (m.status !== 'on_leave') t.present++;
    tally.set(m.session_id, t);
  }
  const sub = new Map(subRows.map((s) => [s.section_id, s]));
  const strength = new Map<string, number>();
  for (const c of (counts ?? []) as { section_id: string | null }[]) if (c.section_id) strength.set(c.section_id, (strength.get(c.section_id) ?? 0) + 1);
  const teachers = await lookup(ctx, 'staff', sections.map((s) => s.class_teacher_id));
  const mine = ctx.staff?.id;
  const rows = [...sections].sort((a, b) => Number(b.class_teacher_id === mine) - Number(a.class_teacher_id === mine));
  const marked = rows.filter((r) => sub.has(r.id)).length;
  const sum = (k: 'present' | 'absent' | 'late') => subRows.reduce((t, s) => t + (tally.get(s.id)?.[k] ?? 0), 0);
  const tp = sum('present') + sum('late'), ta = sum('absent');
  const canMark = ctx.can('attendance', 'write');
  return (
    <Page title="Attendance" sub={`${fdate(date)}${wd.working ? '' : ` · ${wd.reason}`}`} actions={<>
      <form className="flex gap-2"><input type="date" name="date" defaultValue={date} max={today()} className="input !w-auto" aria-label="Date" /><button className="btn-ghost">Go</button></form>
      <Link className="btn-ghost" href="/erp/attendance/staff">Staff attendance</Link><Link className="btn-ghost" href="/erp/reports/attendance">Reports</Link></>}>
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Sections marked" value={`${marked} / ${rows.length}`} tone={wd.working && marked < rows.length ? 'warn' : 'good'} hint={wd.working ? undefined : 'Not a working day'} />
        <Stat label="Present" value={tp} hint={tp + ta ? `${pct(tp, tp + ta)}%` : ''} />
        <Stat label="Absent" value={ta} tone={ta ? 'warn' : undefined} />
        <Stat label="Cut-off" value="09:30" hint="Teachers are nudged 15 minutes before" />
      </div>
      <Card>{rows.length === 0 ? <Empty title="No sections yet" hint="Create classes and sections in Admin console → Academic structure." /> : (
        <table className="tbl"><thead><tr><th>Section</th><th>Class teacher</th><th>Strength</th><th>Status</th><th>Present</th><th>Absent</th><th>Late</th><th></th></tr></thead>
          <tbody>{rows.map((r) => { const s = sub.get(r.id); const t = s ? tally.get(s.id) : undefined; return (
            <tr key={r.id}><td className="font-medium">{r.name}</td><td>{r.class_teacher_id ? teachers.name(r.class_teacher_id) : <span className="text-muted">Not assigned</span>}</td><td>{strength.get(r.id) ?? 0}</td>
              <td>{s ? <><Badge tone="green">marked</Badge> <span className="text-xs text-muted">{ftime(s.submitted_at)} · {s.marked_by_name}</span></> : wd.working ? <Badge tone="red">not marked</Badge> : <Badge tone="grey">no school</Badge>}</td>
              <td>{t?.present ?? ''}</td><td>{t?.absent ?? ''}</td><td>{t?.late ?? ''}</td>
              <td className="text-right">{canMark && <Link className="btn-ghost btn-sm" href={`/erp/attendance/roll/${r.id}?date=${date}`}>{s ? 'Edit' : 'Mark'}</Link>}</td></tr>); })}</tbody></table>)}
      </Card>
    </Page>
  );
}
