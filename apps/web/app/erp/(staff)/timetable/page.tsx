import Link from 'next/link';
import { requireCap } from '@/lib/erp/ctx';
import { sectionsFor } from '@/lib/erp/q';
import { options } from '@/lib/erp/lookup';
import { Page, Card, Empty, Badge, Field } from '@/components/erp/ui';
import { DAYS } from '@/lib/erp/calendar';
import { findClashes, type Entry } from '@autoed/shared/erp';
import { activeVersion, periods as loadPeriods, entries, workingDays } from '@/lib/erp/timetable';
import { setCell, autoGenerate, createVersion } from './actions';

export const metadata = { title: 'Timetable' };
export default async function Timetable({ searchParams }: { searchParams: Promise<{ section?: string; teacher?: string; edit?: string }> }) {
  const sp = await searchParams;
  const ctx = await requireCap('timetable');
  const mineStaff = ['class_teacher', 'subject_teacher'].includes(ctx.role) ? ctx.staff?.id ?? null : null;
  const teacher = sp.teacher ?? (!sp.section ? mineStaff : null);
  const [sections, ver, bells, subjects, staff, rooms] = await Promise.all([sectionsFor(ctx), activeVersion(ctx), loadPeriods(ctx), options(ctx, 'subjects'), options(ctx, 'staff'), options(ctx, 'rooms', { branch: true })]);
  const all = ver ? await entries(ctx, ver.id) : [];
  const E: Entry[] = all.filter((e) => e.section_id).map((e) => ({ id: e.id, section_id: e.section_id!, day: e.day, period_no: e.period_seq, subject_id: e.subject_id, staff_id: e.staff_id, room: e.room_id }));
  const days = workingDays(ctx);
  const view = E.filter((e) => (sp.section ? e.section_id === sp.section : teacher ? e.staff_id === teacher : false));
  const name = { sub: new Map(subjects.map((s) => [s.value, s.label])), staff: new Map(staff.map((s) => [s.value, s.label])), sec: new Map(sections.map((s) => [s.id, s.name])), room: new Map(rooms.map((r) => [r.value, r.label])) };
  const clashes = findClashes(E).filter((c) => c.kind === 'teacher');
  const can = ctx.can('timetable', 'write');
  const [ed, ep] = (sp.edit ?? '').split('-').map(Number) as [number, number];
  const cur = view.find((e) => e.day === ed && e.period_no === ep);
  const load = new Map<string, number>(); for (const e of E) if (e.staff_id) load.set(e.staff_id, (load.get(e.staff_id) ?? 0) + 1);
  const teaching = bells.filter((b) => b.kind === 'period');
  return (
    <Page title="Timetable" sub="Section, teacher and room timetables from one grid. Clashes are checked as you save." actions={<><Link className="btn-ghost" href="/erp/x/teacher_allocations">Teaching assignments</Link><Link className="btn-ghost" href="/erp/x/periods">Bell schedule</Link><Link className="btn" href="/erp/timetable/substitutions">Substitutions</Link></>}>
      {!ver ? <Card><Empty title="No published timetable yet" hint="Create the timetable for this year, then fill it by hand or auto-generate it from the teaching assignments." action={can ? <form action={createVersion}><button className="btn">Create timetable</button></form> : undefined} /></Card> : <>
      <form className="no-print mb-3 flex flex-wrap gap-2"><select name="section" defaultValue={sp.section ?? ''} className="input !w-auto" aria-label="Section"><option value="">Section…</option>{sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        <select name="teacher" defaultValue={sp.section ? '' : teacher ?? ''} className="input !w-auto" aria-label="Teacher"><option value="">Teacher…</option>{staff.map((s) => <option key={s.value} value={s.value}>{s.label} ({load.get(s.value) ?? 0}/wk)</option>)}</select><button className="btn-ghost">Show</button>
        {can && <button formAction={autoGenerate} className="btn-ghost">{sp.section ? 'Auto-fill this section' : 'Auto-generate all sections'}</button>}</form>
      {clashes.length > 0 && <div className="mb-3 rounded-lg bg-red-50 px-4 py-2 text-sm text-red-800">{clashes.length} teacher clash{clashes.length > 1 ? 'es' : ''}: {clashes.slice(0, 4).map((c) => `${name.staff.get(c.key) ?? 'Teacher'} on ${DAYS[c.day]} period ${c.period_no} (${c.sections.map((s) => name.sec.get(s)).join(', ')})`).join('; ')}</div>}
      {!sp.section && !teacher ? <Card><Empty title="Choose a section or a teacher" hint="Start with teaching assignments, then auto-generate and fine-tune by clicking any cell." /></Card> : (
        <Card><div className="overflow-x-auto"><table className="tbl"><thead><tr><th>Period</th>{days.map((d) => <th key={d}>{DAYS[d]}</th>)}</tr></thead>
          <tbody>{bells.map((b, i) => b.kind !== 'period' ? <tr key={`b${i}`}><td colSpan={days.length + 1} className="bg-paper text-center text-xs text-muted">{b.label} · {String(b.starts_at).slice(0, 5)}</td></tr> : (
            <tr key={b.seq}><td className="whitespace-nowrap text-xs text-muted"><b className="text-ink">{b.label}</b> {String(b.starts_at).slice(0, 5)}–{String(b.ends_at).slice(0, 5)}</td>
              {days.map((d) => { const e = view.find((x) => x.day === d && x.period_no === b.seq); const body = e ? <><div className="font-medium">{name.sub.get(e.subject_id ?? '') ?? '—'}</div><div className="text-xs text-muted">{sp.section ? name.staff.get(e.staff_id ?? '') : name.sec.get(e.section_id)}{e.room ? ` · ${name.room.get(String(e.room)) ?? ''}` : ''}</div></> : <span className="text-xs text-muted">{can && sp.section ? '+ add' : ''}</span>;
                return <td key={d} className={ed === d && ep === b.seq ? 'bg-brand-soft' : ''}>{can && sp.section ? <Link href={`/erp/timetable?section=${sp.section}&edit=${d}-${b.seq}`} className="block min-h-[36px] hover:opacity-70">{body}</Link> : body}</td>; })}</tr>))}</tbody></table></div>
          {teaching.length === 0 && <Empty title="No bell schedule" hint="Add periods under Bell schedule." />}</Card>)}
      {can && sp.section && sp.edit && <Card title={`${DAYS[ed]} · period ${ep}`} className="mt-4"><form action={setCell} className="grid gap-3 p-4 sm:grid-cols-4">
        <input type="hidden" name="version" value={ver.id} /><input type="hidden" name="section" value={sp.section} /><input type="hidden" name="day" value={ed} /><input type="hidden" name="period" value={ep} />
        <Field label="Subject"><select name="subject_id" className="input" defaultValue={cur?.subject_id ?? ''}><option value="">Free period</option>{subjects.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select></Field>
        <Field label="Teacher"><select name="staff_id" className="input" defaultValue={cur?.staff_id ?? ''}><option value="">—</option>{staff.map((s) => { const busy = E.some((e) => e.staff_id === s.value && e.day === ed && e.period_no === ep && e.section_id !== sp.section); return <option key={s.value} value={s.value} disabled={busy}>{s.label}{busy ? ' (busy)' : ''}</option>; })}</select></Field>
        <Field label="Room"><select name="room_id" className="input" defaultValue={String(cur?.room ?? '')}><option value="">—</option>{rooms.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</select></Field><div className="flex items-end"><button className="btn w-full">Save cell</button></div></form></Card>}
      <p className="mt-3 text-xs text-muted">Every change is kept in the audit log with its date, so attendance and workload reports stay correct for past weeks. <Badge tone="grey">{ver.name}</Badge></p></>}
    </Page>
  );
}
