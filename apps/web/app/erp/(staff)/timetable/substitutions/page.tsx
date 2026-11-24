import Link from 'next/link';
import { requireCap } from '@/lib/erp/ctx';
import { core, erp } from '@/lib/erp/db';
import { NO_ID } from '@/lib/erp/q';
import { options } from '@/lib/erp/lookup';
import { Page, Card, Empty, Badge } from '@/components/erp/ui';
import { today, fdate } from '@/lib/erp/fmt';
import { weekday, DAYS, addDays } from '@/lib/erp/calendar';
import { rankSubstitutes } from '@autoed/shared/erp';
import { activeVersion } from '@/lib/erp/timetable';
import { confirmSub } from '../actions';

export const metadata = { title: 'Substitutions' };
/** Substitution planner (TT-04): affected periods of absent teachers with ranked suggestions. */
export default async function Subs({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const { date = today() } = await searchParams;
  const ctx = await requireCap('timetable');
  const dow = weekday(date);
  const ver = await activeVersion(ctx);
  const [{ data: att }, { data: leave }, { data: tt }, staff, { data: subs }, { data: ta }, { data: week }, sections, subjects] = await Promise.all([
    core(ctx.sb).from('staff_attendance').select('staff_id, status').eq('date', date).in('status', ['absent', 'on_leave']).is('deleted_at', null),
    core(ctx.sb).from('leave_requests').select('staff_id').eq('status', 'approved').lte('start_date', date).gte('end_date', date).is('deleted_at', null),
    core(ctx.sb).from('timetable_entries').select('section_id, period_seq, subject_id, staff_id').eq('day', dow).eq('version_id', ver?.id ?? NO_ID).is('deleted_at', null).limit(5000),
    options(ctx, 'staff'),
    erp(ctx.sb).from('substitutions').select('period_seq, section_id, absent_staff_id, substitute_staff_id').eq('date', date).eq('status', 'assigned').is('deleted_at', null),
    core(ctx.sb).from('teacher_allocations').select('staff_id, section_id, subject_id').eq('academic_year_id', ctx.year?.id ?? NO_ID).is('deleted_at', null),
    erp(ctx.sb).from('substitutions').select('substitute_staff_id').gte('date', addDays(date, -6)).lte('date', date).eq('status', 'assigned').is('deleted_at', null),
    options(ctx, 'sections'), options(ctx, 'subjects'),
  ]);
  const absent = new Set([...((att ?? []) as { staff_id: string }[]).map((a) => a.staff_id), ...((leave ?? []) as { staff_id: string }[]).map((l) => l.staff_id)].filter(Boolean));
  type T = { section_id: string; period_seq: number; subject_id: string | null; staff_id: string | null };
  const Ts = (tt ?? []) as T[];
  const affected = Ts.filter((e) => e.staff_id && absent.has(e.staff_id)).sort((a, b) => a.period_seq - b.period_seq);
  const nm = { sec: new Map(sections.map((s) => [s.value, s.label])), sub: new Map(subjects.map((s) => [s.value, s.label])), st: new Map(staff.map((s) => [s.value, s.label])) };
  const can = ctx.can('timetable', 'write');
  const covers = new Map<string, number>(); for (const w of (week ?? []) as { substitute_staff_id: string | null }[]) if (w.substitute_staff_id) covers.set(w.substitute_staff_id, (covers.get(w.substitute_staff_id) ?? 0) + 1);
  const S = (subs ?? []) as { period_seq: number; section_id: string; absent_staff_id: string; substitute_staff_id: string | null }[];
  const A = (ta ?? []) as { staff_id: string; section_id: string; subject_id: string }[];
  const done = affected.filter((e) => S.some((s) => s.period_seq === e.period_seq && s.section_id === e.section_id)).length;
  return (
    <Page title="Substitution planner" sub={`${DAYS[dow]}, ${fdate(date)} · ${absent.size} teacher${absent.size === 1 ? '' : 's'} away · ${done} of ${affected.length} periods covered`} actions={<form className="flex gap-2"><input type="date" name="date" defaultValue={date} className="input !w-auto" aria-label="Date" /><button className="btn-ghost">Go</button><Link className="btn-ghost" href="/erp/timetable">Timetable</Link></form>}>
      {affected.length === 0 ? <Card><Empty title="No cover needed" hint="When a teacher's leave is approved or they are marked absent, every affected period is listed here with suggested substitutes." /></Card> : (
        <div className="space-y-3">{affected.map((e, i) => {
          const sub = S.find((s) => s.period_seq === e.period_seq && s.section_id === e.section_id);
          const busy = new Set([...Ts.filter((x) => x.period_seq === e.period_seq).map((x) => x.staff_id), ...S.filter((s) => s.period_seq === e.period_seq).map((s) => s.substitute_staff_id)]);
          const ranked = rankSubstitutes(staff.filter((s) => !absent.has(s.value) && !busy.has(s.value)).map((s) => ({ staff_id: s.value, name: s.label, teachesSubject: A.some((a) => a.staff_id === s.value && a.subject_id === e.subject_id), teachesSection: A.some((a) => a.staff_id === s.value && a.section_id === e.section_id), loadToday: Ts.filter((x) => x.staff_id === s.value).length, coversThisWeek: covers.get(s.value) ?? 0 }))).slice(0, 4);
          return <Card key={i}><div className="p-4"><div className="flex flex-wrap items-center justify-between gap-2"><div className="text-sm"><b>Period {e.period_seq}</b> · {nm.sec.get(e.section_id)} · {nm.sub.get(e.subject_id ?? '') ?? 'Free'} <span className="text-muted">· {nm.st.get(e.staff_id!)} is away</span></div>{sub ? <Badge tone="green">covered by {nm.st.get(sub.substitute_staff_id ?? '')}</Badge> : <Badge tone="red">needs cover</Badge>}</div>
            {!sub && (ranked.length === 0 ? <p className="mt-2 text-sm text-muted">No teacher is free in this period. Consider combining sections.</p> : <ul className="mt-2 divide-y divide-line border-t border-line">{ranked.map((r, k) => <li key={r.staff_id} className="flex items-center justify-between gap-3 py-2 text-sm"><span><b>{k + 1}. {r.name}</b> <span className="text-muted">· {r.why}</span></span>
              {can && <form action={confirmSub}><input type="hidden" name="date" value={date} /><input type="hidden" name="period" value={e.period_seq} /><input type="hidden" name="section" value={e.section_id} /><input type="hidden" name="section_name" value={nm.sec.get(e.section_id) ?? ''} /><input type="hidden" name="subject" value={e.subject_id ?? ''} /><input type="hidden" name="absent" value={e.staff_id!} /><input type="hidden" name="substitute" value={r.staff_id} /><button className={k === 0 ? 'btn btn-sm' : 'btn-ghost btn-sm'}>Confirm</button></form>}</li>)}</ul>)}</div></Card>; })}</div>)}
    </Page>
  );
}
