'use client';
import Link from 'next/link';
import { addDays, attendanceTone, childName, fmtDate, fmtTime, istToday, loadHomework, loadMarks, loadTests, loadTimetable, testWindow, type Child } from '@autoed/shared/erp-portal';
import { usePortal } from '@/lib/erp-portal/session';
import { useLoad } from '@/lib/erp-portal/use-load';
import { Badge, Card, Empty, PageHead, Stat } from '@/components/erp-portal/ui';
import { NeedChild, WithData } from '@/components/erp-portal/screen';

export default function StudentHome() {
  return <NeedChild>{(c) => <Inner child={c} />}</NeedChild>;
}

function Inner({ child }: { child: Child }) {
  const { sb, L, lang } = usePortal();
  const today = istToday();
  const dow = ((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
  const q = useLoad('student-home', async () => {
    const [marks, hw, tests, tt] = await Promise.all([loadMarks(sb!, child.id, addDays(today, -3)), loadHomework(sb!, child), loadTests(sb!, child.id), loadTimetable(sb!, child.section_id, dow)]);
    return { marks, hw, tests, tt };
  }, [child.id], { childScoped: true });
  return (
    <>
      <PageHead title={L('home.hello', { name: child.first_name })} sub={`${childName(child)} · ${fmtDate(today, lang, true)}`} />
      <WithData q={q}>
        {(d) => {
          const mark = d.marks.find((m) => m.date === today);
          const due = d.hw.posts.filter((p) => p.type === 'homework' && p.due_date && p.due_date >= today && !d.hw.submissions[p.id]);
          const open = d.tests.tests.filter((t) => testWindow(t) === 'open' && !d.tests.attempts[t.id]?.submitted_at);
          return (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <Stat label={L('home.attendanceToday')} value={mark ? L(`att.${mark.status}`) : L('att.notMarked')} tone={mark && attendanceTone(mark.status) === 'good' ? 'good' : mark && attendanceTone(mark.status) === 'bad' ? 'bad' : 'none'} />
                <Stat label={L('student.tests')} value={open.length} hint={L('tests.window.open')} href="/erp/student/tests" />
              </div>
              <Card title={L('student.homework')} flush>
                {due.length === 0 ? <Empty title={L('homework.none')} /> : (
                  <ul className="divide-y divide-slate-100">{due.slice(0, 5).map((p) => <li key={p.id} className="flex justify-between gap-2 px-4 py-3 text-base"><span className="font-medium">{p.title}</span><span className="text-slate-700">{L('homework.due', { date: fmtDate(p.due_date, lang) })}</span></li>)}</ul>
                )}
                <div className="px-4 pb-3"><Link href="/erp/student/homework" className="text-base text-[var(--pt-primary)] underline">{L('nav.homework')}</Link></div>
              </Card>
              <Card title={L('home.timetable')} flush>
                {d.tt.length === 0 ? <Empty title={L('home.noClasses')} /> : (
                  <ul className="divide-y divide-slate-100">{d.tt.map((e) => <li key={e.seq} className="flex justify-between px-4 py-3 text-base"><span>{e.subject ?? '–'}</span><span className="tabular-nums text-slate-700">{e.start ? fmtTime(e.start, lang) : e.label}</span></li>)}</ul>
                )}
              </Card>
              {open.length > 0 && <div className="flex flex-wrap gap-2">{open.map((t) => <Link key={t.id} href={`/erp/student/tests/${t.id}`}><Badge tone="info">{t.title}</Badge></Link>)}</div>}
            </div>
          );
        }}
      </WithData>
    </>
  );
}
