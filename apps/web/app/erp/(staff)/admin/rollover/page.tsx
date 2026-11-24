import { requireCap } from '@/lib/erp/ctx';
import { core, erp } from '@/lib/erp/db';
import { NO_ID } from '@/lib/erp/q';
import { Page, Card, Empty, Badge, Stat } from '@/components/erp/ui';
import { ConfirmSubmit } from '@/components/erp/client';
import { go, str, inr, today } from '@/lib/erp/fmt';
import { balance, type Demand } from '@autoed/shared/erp';

export const metadata = { title: 'Year rollover' };
type Prog = { id: string; name: string; seq: number | null; next_programme_id: string | null; branch_id: string | null };
type Sec = { id: string; programme_id: string; name: string; class_teacher_id: string | null; room_id: string | null; capacity: number | null };
/** Rollover wizard (SIS-06): new year, copied sections, promotion by result rule, dues carried forward. Preview first, then commit. */
async function commit(fd: FormData) {
  'use server';
  const ctx = await requireCap('admin', 'write');
  if (!ctx.year) go('/erp/admin/rollover', 'No current year.', 'err');
  const c = core(ctx.sb), cur = ctx.year!;
  const ys = Number(cur.starts_on.slice(0, 4)) + 1;
  const name = `${ys}-${String(ys + 1).slice(2)}`;
  const { data: exists } = await c.from('academic_years').select('id').eq('name', name).is('deleted_at', null).maybeSingle();
  if (exists) go('/erp/admin/rollover', `${name} already exists. Rollover has been run.`, 'err');
  const { data: ny, error } = await c.from('academic_years').insert({ name, starts_on: `${ys}-04-01`, ends_on: `${ys + 1}-03-31`, is_current: false, status: 'planning' }).select('id').single();
  if (error || !ny) go('/erp/admin/rollover', error?.message ?? 'Could not create the year.', 'err');
  const newYear = ny!.id as string;
  const [{ data: progs }, { data: secs }, { data: studs }, { data: cards }] = await Promise.all([
    c.from('programmes').select('id, next_programme_id').is('deleted_at', null), c.from('sections').select('id, programme_id, name, class_teacher_id, room_id, capacity').eq('academic_year_id', cur.id).is('deleted_at', null),
    c.from('students').select('id, section_id, programme_id, branch_id').eq('status', 'active').is('deleted_at', null).limit(20000), erp(ctx.sb).from('report_cards').select('student_id, snapshot').eq('academic_year_id', cur.id).is('deleted_at', null),
  ]);
  const S = (secs ?? []) as Sec[];
  const map = new Map<string, string>(); // old section -> copy in the new year
  for (const s of S) { const { data: n } = await c.from('sections').insert({ academic_year_id: newYear, programme_id: s.programme_id, name: s.name, class_teacher_id: s.class_teacher_id, room_id: s.room_id, capacity: s.capacity }).select('id').single(); if (n) map.set(s.id, n.id as string); }
  const next = new Map(((progs ?? []) as { id: string; next_programme_id: string | null }[]).map((p) => [p.id, p.next_programme_id]));
  const detain = new Set(fd.getAll('detain').map(String));
  const passMark = Number(str(fd, 'pass') ?? 33);
  if (fd.get('use_results') === 'on') for (const r of (cards ?? []) as { student_id: string; snapshot: { overall?: number | null } | null }[]) { const o = r.snapshot?.overall; if (o !== null && o !== undefined && o < passMark) detain.add(r.student_id); }
  let promoted = 0, detained = 0, graduated = 0;
  const secProg = new Map(S.map((s) => [s.id, s]));
  for (const s of (studs ?? []) as { id: string; section_id: string | null; programme_id: string | null; branch_id: string | null }[]) {
    const stay = detain.has(s.id), np = stay ? s.programme_id : next.get(s.programme_id ?? '') ?? null;
    await c.from('enrolments').update({ status: stay ? 'detained' : 'promoted', end_date: cur.ends_on, result: stay ? 'Detained' : 'Promoted' }).eq('student_id', s.id).eq('academic_year_id', cur.id).eq('status', 'active');
    if (!stay && !np) { await c.rpc('change_student_status', { p_student: s.id, p_to: 'alumni', p_reason: `Completed final grade in ${cur.name}`, p_effective: cur.ends_on }); graduated++; continue; }
    // Target section: the copy of a section in the new grade with the same suffix letter, else the first one.
    const oldName = (s.section_id && secProg.get(s.section_id)?.name) || ''; const suffix = oldName.trim().split(' ').pop();
    const targets = S.filter((x) => x.programme_id === np);
    const target = targets.find((x) => x.name.trim().split(' ').pop() === suffix) ?? targets[0];
    const nsec = target ? map.get(target.id) ?? null : null;
    await c.from('students').update({ programme_id: np, section_id: nsec, is_new: false }).eq('id', s.id);
    await c.from('enrolments').insert({ student_id: s.id, academic_year_id: newYear, programme_id: np, section_id: nsec, start_date: `${ys}-04-01`, status: 'active' });
    if (stay) detained++; else promoted++;
  }
  // Previous-year dues are carried forward and shown separately (FEE-12).
  await erp(ctx.sb).from('fee_demands').update({ carried_forward: true }).eq('academic_year_id', cur.id).in('status', ['due', 'partial']);
  await c.from('academic_years').update({ is_current: false, status: 'closed' }).eq('id', cur.id);
  await c.from('academic_years').update({ is_current: true, status: 'active' }).eq('id', newYear);
  go('/erp/admin/setup', `Rolled over to ${name}: ${promoted} promoted, ${detained} detained, ${graduated} moved to alumni. Next: create fee plans, routes and the timetable for the new year.`);
}

export default async function Rollover() {
  const ctx = await requireCap('admin');
  const cur = ctx.year;
  if (!cur) return <Page title="Year rollover"><Card><Empty title="No academic year" /></Card></Page>;
  const [{ data: progs }, { data: studs }, { data: dues }, { data: cards }, { count: open }] = await Promise.all([
    core(ctx.sb).from('programmes').select('id, name, seq, next_programme_id, branch_id').is('deleted_at', null).order('seq'), core(ctx.sb).from('students').select('id, first_name, last_name, programme_id').eq('status', 'active').is('deleted_at', null).limit(20000),
    ctx.can('fees') ? erp(ctx.sb).from('fee_demands').select('amount, concession, fine, paid, due_date').eq('academic_year_id', cur.id).in('status', ['due', 'partial']).is('deleted_at', null).limit(50000) : Promise.resolve({ data: [] }),
    erp(ctx.sb).from('report_cards').select('student_id, snapshot, status').eq('academic_year_id', cur.id).is('deleted_at', null), erp(ctx.sb).from('assessments').select('id', { count: 'exact', head: true }).eq('academic_year_id', cur.id).eq('status', 'open').is('deleted_at', null),
  ]);
  const ys = Number(cur.starts_on.slice(0, 4)) + 1, name = `${ys}-${String(ys + 1).slice(2)}`;
  const P = (progs ?? []) as Prog[], St = (studs ?? []) as { id: string; first_name: string; last_name: string | null; programme_id: string | null }[];
  const by = (p: string) => St.filter((s) => s.programme_id === p);
  const carry = ((dues ?? []) as Demand[]).reduce((t, d) => t + balance(d), 0);
  const overall = (c: { snapshot: unknown }) => (c.snapshot as { overall?: number | null } | null)?.overall;
  const low = ((cards ?? []) as { student_id: string; snapshot: unknown }[]).filter((c) => { const o = overall(c); return o !== null && o !== undefined && o < 33; });
  const early = today() < `${cur.ends_on.slice(0, 4)}-02-01`;
  void NO_ID;
  return (
    <Page title="Year rollover wizard" sub={`From ${cur.name} to ${name}. Review everything below before you commit.`}>
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4"><Stat label="Active students" value={St.length} /><Stat label="Dues to carry forward" value={inr(carry)} hint="shown separately next year" /><Stat label="Below pass mark" value={low.length} hint="from report cards" /><Stat label="Marks still open" value={open ?? 0} tone="warn" /></div>
      {early && <div className="mb-3 rounded-lg bg-amber-50 px-4 py-2 text-sm text-amber-900">The year ends on {cur.ends_on}. Rollover is usually run between March and May.</div>}
      <form action={commit}>
        <Card title="Step 1 · Promotion preview"><table className="tbl"><thead><tr><th>Current grade</th><th>Students</th><th>Moves to</th></tr></thead><tbody>{P.map((p) => { const nx = P.find((x) => x.id === p.next_programme_id); return <tr key={p.id}><td>{p.name}</td><td>{by(p.id).length}</td><td>{nx ? nx.name : <Badge tone="grey">final grade: students become alumni</Badge>}</td></tr>; })}</tbody></table></Card>
        <Card title="Step 2 · Result rule" className="mt-4"><div className="flex flex-wrap items-center gap-4 p-4 text-sm"><label className="flex items-center gap-2"><input type="checkbox" name="use_results" className="h-4 w-4" /> Detain students whose overall result is below</label><input name="pass" type="number" defaultValue={33} className="input !w-20" aria-label="Pass percentage" /><span>%</span></div>
          {low.length > 0 && <ul className="divide-y divide-line border-t border-line text-sm">{low.slice(0, 30).map((c) => { const s = St.find((x) => x.id === c.student_id); return s ? <li key={c.student_id} className="flex justify-between px-4 py-2"><span>{s.first_name} {s.last_name} · {overall(c)}%</span><label className="flex items-center gap-1"><input type="checkbox" name="detain" value={s.id} className="h-4 w-4" />detain</label></li> : null; })}</ul>}</Card>
        <Card title="Step 3 · What happens when you commit" className="mt-4"><ul className="list-disc space-y-1 px-8 py-4 text-sm"><li>Academic year {name} is created and becomes the current year.</li><li>Every section is copied with its class teacher and room.</li><li>Students move to the next grade; enrolment history is kept for each year.</li><li>Students in a final grade move to alumni.</li><li>Unpaid fees from {cur.name} are marked as previous-year dues.</li><li>Fee plans, routes and the timetable for {name} are yours to create next (the checklist will guide you).</li></ul></Card>
        {ctx.can('admin', 'write') && <div className="mt-4"><ConfirmSubmit className="btn" message={`Roll over to ${name}? This moves every active student and cannot be undone in one click.`}>Commit rollover to {name}</ConfirmSubmit></div>}
      </form>
    </Page>
  );
}
