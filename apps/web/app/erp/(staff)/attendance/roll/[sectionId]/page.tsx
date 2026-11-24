import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireCap } from '@/lib/erp/ctx';
import { core } from '@/lib/erp/db';
import { fullNameOf } from '@/lib/erp/q';
import { Page, Card, Empty } from '@/components/erp/ui';
import { today, fdate } from '@/lib/erp/fmt';
import { workingDay } from '@/lib/erp/calendar';
import { Roll } from './roll';

const SESSIONS = ['day', 'am', 'pm', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'hostel_am', 'hostel_pm', 'study'];
export default async function RollPage({ params, searchParams }: { params: Promise<{ sectionId: string }>; searchParams: Promise<{ date?: string; session?: string }> }) {
  const [{ sectionId }, sp] = await Promise.all([params, searchParams]);
  const ctx = await requireCap('attendance', 'write');
  const date = sp.date ?? today(), session = sp.session ?? 'day';
  const { data: sec } = await core(ctx.sb).from('sections').select('id, name, programme:programmes(branch_id)').eq('id', sectionId).is('deleted_at', null).maybeSingle();
  if (!sec) notFound();
  const [{ data: studs }, { data: att }, wd, { data: sens }] = await Promise.all([
    core(ctx.sb).from('students').select('id, first_name, last_name, roll_no').eq('section_id', sectionId).eq('status', 'active').is('deleted_at', null).order('roll_no').order('first_name'),
    core(ctx.sb).from('student_attendance_marks').select('student_id, status, session_id').eq('date', date).eq('session_key', session).is('deleted_at', null),
    workingDay(ctx, date, (sec as unknown as { programme: { branch_id: string | null } | null }).programme?.branch_id),
    ctx.can('sensitive') ? core(ctx.sb).from('student_sensitive').select('student_id, allergies').not('allergies', 'is', null).is('deleted_at', null) : Promise.resolve({ data: [] }),
  ]);
  const list = (studs ?? []) as { id: string; first_name: string; last_name: string | null; roll_no: string | null }[];
  const inSection = new Set(list.map((s) => s.id));
  const prev = new Map(((att ?? []) as { student_id: string; status: string }[]).filter((a) => inSection.has(a.student_id)).map((a) => [a.student_id, a.status]));
  const allergy = new Map(((sens ?? []) as { student_id: string; allergies: string }[]).map((s) => [s.student_id, s.allergies]));
  const stat = (s?: string) => (s === 'absent' ? 'A' : s === 'late' ? 'L' : s === 'on_leave' ? 'LV' : 'P') as 'P' | 'A' | 'L' | 'LV';
  const students = list.map((s) => ({ id: s.id, name: fullNameOf(s), roll_no: s.roll_no, status: stat(prev.get(s.id)), alert: allergy.get(s.id) ? `Allergy: ${allergy.get(s.id)}` : null }));
  return (
    <Page title={`Roll call · ${sec.name}`} sub={<>{fdate(date)} · {session === 'day' ? 'Daily' : session} · <Link className="link" href="/erp/attendance">Back to board</Link></>}
      actions={<form className="flex gap-2"><input type="date" name="date" defaultValue={date} max={today()} className="input !w-auto" aria-label="Date" /><select name="session" defaultValue={session} className="input !w-auto" aria-label="Session">{SESSIONS.map((s) => <option key={s} value={s}>{s === 'day' ? 'Daily' : s}</option>)}</select><button className="btn-ghost">Go</button></form>}>
      {!wd.working && <div className="mb-3 rounded-lg bg-amber-50 px-4 py-2 text-sm text-amber-900">{wd.reason}. This date is not counted as a working day, so nothing is expected.</div>}
      {students.length === 0 ? <Card><Empty title="No active students in this section" hint="Admit students or move them into this section from Students → Bulk actions." /></Card>
        : <Roll key={`${date}${session}`} sectionId={sectionId} date={date} session={session} students={students} alreadyMarked={prev.size > 0} />}
    </Page>
  );
}
