import { requireCap } from '@/lib/erp/ctx';
import { core, erp } from '@/lib/erp/db';
import { Page, Card, Stat, Empty } from '@/components/erp/ui';
import { PrintButton } from '@/components/erp/client';
import { today, fdate, pct, inr, go, str } from '@/lib/erp/fmt';
import { workingDay } from '@/lib/erp/calendar';
import { NO_ID } from '@/lib/erp/q';

export const metadata = { title: "Principal's diary" };
type Snap = { working: boolean; reason: string | null; students: { marked: number; present: number; absent: number }; sections: { total: number; marked: number }; staff: { present: number; away: number }; posts: number; assessments: number; visitors: number; gatePasses: number; collected: number; tickets: number; events: string[] };

/** Principal's daily diary (RPT-03): compiled from the day's records, with the principal's comments, printable and archived. */
async function compile(fd: FormData) {
  'use server';
  const ctx = await requireCap('reports');
  const d = str(fd, 'date') ?? today();
  const branch = ctx.branchId ?? ctx.branches[0]?.id ?? null;
  const c = core(ctx.sb), e = erp(ctx.sb);
  const day = [d + 'T00:00:00+05:30', d + 'T23:59:59+05:30'] as const;
  const wd = await workingDay(ctx, d, branch);
  const [att, subs, secs, satt, posts, asm, vis, gp, rec, tk, ev] = await Promise.all([
    c.from('student_attendance_marks').select('status').eq('date', d).eq('session_key', 'day').is('deleted_at', null).limit(20000),
    c.from('student_attendance_sessions').select('id', { count: 'exact', head: true }).eq('date', d).eq('session_key', 'day').eq('status', 'submitted').is('deleted_at', null),
    c.from('sections').select('id', { count: 'exact', head: true }).eq('academic_year_id', ctx.year?.id ?? NO_ID).is('deleted_at', null),
    c.from('staff_attendance').select('status').eq('date', d).is('deleted_at', null),
    c.from('class_posts').select('id', { count: 'exact', head: true }).gte('created_at', day[0]).lte('created_at', day[1]).is('deleted_at', null),
    e.from('assessments').select('id', { count: 'exact', head: true }).eq('date', d).is('deleted_at', null),
    e.from('visitors').select('id', { count: 'exact', head: true }).gte('in_at', day[0]).lte('in_at', day[1]),
    e.from('gate_passes').select('id', { count: 'exact', head: true }).gte('created_at', day[0]).lte('created_at', day[1]),
    ctx.can('fees') ? e.from('receipts').select('total').eq('date', d).eq('status', 'valid') : Promise.resolve({ data: [] }),
    c.from('tickets').select('id', { count: 'exact', head: true }).gte('created_at', day[0]).lte('created_at', day[1]).is('deleted_at', null),
    c.from('calendar_events').select('title').lte('starts_on', d).gte('ends_on', d).is('deleted_at', null),
  ]);
  const a = (att.data ?? []) as { status: string }[], s = (satt.data ?? []) as { status: string }[];
  const snapshot: Snap = { working: wd.working, reason: wd.reason, students: { marked: a.length, present: a.filter((x) => !['absent', 'on_leave'].includes(x.status)).length, absent: a.filter((x) => x.status === 'absent').length }, sections: { total: secs.count ?? 0, marked: subs.count ?? 0 },
    staff: { present: s.filter((x) => ['present', 'late', 'half_day'].includes(x.status)).length, away: s.filter((x) => ['absent', 'on_leave'].includes(x.status)).length }, posts: posts.count ?? 0, assessments: asm.count ?? 0, visitors: vis.count ?? 0, gatePasses: gp.count ?? 0,
    collected: ((rec.data ?? []) as { total: number }[]).reduce((t, r) => t + Number(r.total), 0), tickets: tk.count ?? 0, events: ((ev.data ?? []) as { title: string }[]).map((x) => x.title) };
  let exq = e.from('principal_diary').select('id, comments').eq('date', d).is('deleted_at', null);
  exq = branch ? exq.eq('branch_id', branch) : exq.is('branch_id', null);
  const { data: ex } = await exq.maybeSingle();
  const comments = str(fd, 'comments') ?? (ex?.comments as string | null | undefined) ?? null;
  const { error } = ex ? await e.from('principal_diary').update({ snapshot, comments, compiled_at: new Date().toISOString() }).eq('id', ex.id) : await e.from('principal_diary').insert({ date: d, branch_id: branch, snapshot, comments });
  go(`/erp/diary?date=${d}`, error ? error.message : 'Diary compiled and saved.', error ? 'err' : 'ok');
}

export default async function Diary({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const { date = today() } = await searchParams;
  const ctx = await requireCap('reports');
  const branch = ctx.branchId ?? ctx.branches[0]?.id ?? null;
  const q = (sel: string) => { const b = erp(ctx.sb).from('principal_diary').select(sel).is('deleted_at', null); return branch ? b.eq('branch_id', branch) : b.is('branch_id', null); };
  const [{ data: entry }, { data: past }] = await Promise.all([q('id, snapshot, comments').eq('date', date).maybeSingle(), q('date').order('date', { ascending: false }).limit(14)]);
  const e = entry as unknown as { snapshot: Snap; comments: string | null } | null;
  const s = e?.snapshot;
  const P = (past ?? []) as unknown as { date: string }[];
  return (
    <Page title="Principal's daily diary" sub={`${fdate(date)} · ${ctx.branches.find((b) => b.id === branch)?.name ?? ''}`} actions={<><form className="flex gap-2"><input type="date" name="date" defaultValue={date} max={today()} className="input !w-auto" aria-label="Date" /><button className="btn-ghost">Open</button></form><PrintButton /></>}>
      {!s ? <Card><Empty title="Not compiled yet for this day" hint="The diary gathers attendance, staff present, diaries and assignments posted, visitors and events automatically." action={<form action={compile}><input type="hidden" name="date" value={date} /><button className="btn">Compile the diary</button></form>} /></Card> : <>
        {!s.working && <div className="mb-3 rounded-lg bg-amber-50 px-4 py-2 text-sm text-amber-900">{s.reason}. Nothing is counted as missed on this day.</div>}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Student attendance" value={s.students.marked ? `${pct(s.students.present, s.students.marked)}%` : '—'} hint={`${s.students.absent} absent · ${s.sections.marked} of ${s.sections.total} sections marked`} />
          <Stat label="Staff present" value={s.staff.present} hint={`${s.staff.away} away`} /><Stat label="Diary and homework posts" value={s.posts} /><Stat label="Assessments held" value={s.assessments} />
          <Stat label="Visitors and gate passes" value={`${s.visitors} / ${s.gatePasses}`} /><Stat label="Fees collected" value={inr(s.collected)} hint={`${s.tickets} new requests`} />
        </div>
        {s.events.length > 0 && <Card title="Events and calendar" className="mt-4"><ul className="list-disc px-8 py-3 text-sm">{s.events.map((x) => <li key={x}>{x}</li>)}</ul></Card>}
        <Card title="Principal's comments" className="mt-4"><form action={compile} className="space-y-3 p-4"><input type="hidden" name="date" value={date} /><textarea name="comments" rows={4} className="input" defaultValue={e?.comments ?? ''} aria-label="Comments" /><div className="no-print flex gap-2"><button className="btn">Save comments and refresh the numbers</button></div></form></Card></>}
      {P.length > 0 && <p className="no-print mt-4 text-sm text-muted">Archive: {P.map((p) => <a key={p.date} className="link mr-2" href={`/erp/diary?date=${p.date}`}>{fdate(p.date)}</a>)}</p>}
    </Page>
  );
}
