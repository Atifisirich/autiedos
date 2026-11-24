'use client';
import Link from 'next/link';
import {
  addDays, attendanceTone, childName, feeSummary, fmtDate, fmtTime, inr, istToday, loadBus, loadCirculars, loadDirectory, loadFees, loadHomework, loadMarks,
  loadPickup, loadPtm, loadTimetable, nextActions, tripState, type Child,
} from '@autoed/shared/erp-portal';
import { usePortal } from '@/lib/erp-portal/session';
import { useLoad } from '@/lib/erp-portal/use-load';
import { Badge, Card, Empty, PageHead, Stat } from '@/components/erp-portal/ui';
import { NeedChild, WithData } from '@/components/erp-portal/screen';

export default function ParentHome() {
  return <NeedChild>{(child) => <Home child={child} />}</NeedChild>;
}

const QUICK = [
  ['attendance', 'nav.attendance'], ['homework', 'nav.homework'], ['bus', 'nav.bus'], ['calendar', 'nav.calendar'],
  ['requests', 'nav.requests'], ['forms', 'nav.forms'], ['ptm', 'nav.ptm'], ['pickup', 'nav.pickup'],
] as const;

function Home({ child }: { child: Child }) {
  const { sb, userId, member, L, lang } = usePortal();
  const today = istToday();
  const dow = ((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;

  const q = useLoad('home', async () => {
    const db = sb!;
    const [marks, hw, fees, dir, circulars, pickup, ptm, timetable] = await Promise.all([
      loadMarks(db, child.id, addDays(today, -7)), loadHomework(db, child), loadFees(db, child.id), loadDirectory(db, child.id), loadCirculars(db, userId!),
      loadPickup(db, child.id), loadPtm(db, child.id, today), loadTimetable(db, child.section_id, dow),
    ]);
    const bus = dir.transport ? await loadBus(db, child.id, dir.transport.route_id, today) : null;
    return { marks, hw, fees, dir, circulars, pickup, ptm, timetable, bus };
  }, [child.id], { childScoped: true });

  return (
    <>
      <PageHead title={childName(child)} sub={`${q.data?.dir.section ?? ''} · ${fmtDate(today, lang, true)}`} right={member?.display_name ? <span className="text-base text-slate-700">{L('home.hello', { name: member.display_name })}</span> : undefined} />
      <WithData q={q}>
        {(d) => {
          const todayMark = d.marks.find((m) => m.date === today);
          const fs = feeSummary(d.fees.demands, today);
          const unread = d.circulars.filter((c) => !c.read_at && c.status !== 'read').length;
          const live = d.bus ? tripState(d.bus.trip) : 'none';
          const dueSoon = d.hw.posts.filter((p) => p.type === 'homework' && p.due_date && p.due_date >= today && p.due_date <= addDays(today, 2) && !d.hw.submissions[p.id]).length;
          const actions = nextActions({ overdue: fs.overdue, approvedPasses: d.pickup.passes.filter((p) => p.status === 'approved').length, unread, openTests: 0, homeworkDueSoon: dueSoon, openPtmSlots: d.ptm.open.length, bookedPtm: d.ptm.mine.length > 0 });
          return (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <Stat label={L('home.attendanceToday')} value={todayMark ? L(`att.${todayMark.status}`) : L('att.notMarked')} tone={todayMark ? (attendanceTone(todayMark.status) === 'bad' ? 'bad' : attendanceTone(todayMark.status) === 'good' ? 'good' : 'none') : 'none'} href="/erp/parent/attendance" />
                <Stat label={L('home.feesDue')} value={inr(fs.due)} hint={fs.overdue > 0 ? L('home.overdueOf', { amount: inr(fs.overdue) }) : undefined} tone={fs.overdue > 0 ? 'bad' : 'none'} href="/erp/parent/fees" />
                <Stat label={L('home.bus')} value={live === 'running_live' || live === 'running_stale' ? (d.bus?.trip?.delay_minutes ? L('bus.late', { n: d.bus.trip.delay_minutes }) : L('home.busOnWay')) : d.dir.transport ? L('home.busNone') : '–'} hint={d.dir.transport?.route} href="/erp/parent/bus" />
                <Stat label={L('nav.messages')} value={unread} hint={L('home.unread')} href="/erp/parent/messages" />
              </div>

              {actions.length > 0 && (
                <Card title={L('home.nextActions')} flush>
                  <ul className="divide-y divide-slate-100">
                    {actions.map((a) => (
                      <li key={a.key}>
                        <Link href={`/erp/parent/${a.href}`} className="flex min-h-12 items-center px-4 py-3 text-base font-medium text-[var(--pt-primary)] underline-offset-2 hover:underline">
                          {L(`action.${a.key}`, { amount: inr(fs.overdue), n: a.count })}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}

              <nav aria-label={L('nav.main')}>
                <ul className="grid grid-cols-4 gap-2">
                  {QUICK.filter(([k]) => k !== 'bus' || d.dir.transport).map(([k, label]) => (
                    <li key={k}><Link href={`/erp/parent/${k}`} className="flex min-h-14 items-center justify-center rounded-xl border border-slate-200 bg-white p-2 text-center text-sm font-medium text-slate-900">{L(label)}</Link></li>
                  ))}
                </ul>
              </nav>

              <div className="grid gap-4 md:grid-cols-3">
                <Card title={L('home.homework')} className="md:col-span-2" flush>
                  {d.hw.posts.length === 0 ? <Empty title={L('home.noHomework')} /> : (
                    <ul className="divide-y divide-slate-100">
                      {d.hw.posts.slice(0, 5).map((p) => (
                        <li key={p.id} className="px-4 py-3">
                          <div className="flex flex-wrap items-center gap-2"><Badge tone="info">{L(`homework.type.${p.type}`)}</Badge><span className="font-medium text-slate-900">{p.title}</span>{p.due_date && <span className="text-sm text-slate-700">{L('homework.due', { date: fmtDate(p.due_date, lang) })}</span>}</div>
                          <div className="text-sm text-slate-700">{(p.subject_id && d.hw.subjects[p.subject_id]) || L('homework.general')}</div>
                          {p.body && <p className="mt-1 whitespace-pre-wrap text-base text-slate-900">{p.body}</p>}
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
                <Card title={L('home.timetable')} flush>
                  {d.timetable.length === 0 ? <Empty title={L('home.noClasses')} /> : (
                    <ul className="divide-y divide-slate-100">
                      {d.timetable.map((e) => <li key={e.seq} className="flex justify-between px-4 py-3 text-base"><span>{e.subject ?? '–'}</span><span className="tabular-nums text-slate-700">{e.start ? fmtTime(e.start, lang) : e.label}</span></li>)}
                    </ul>
                  )}
                </Card>
              </div>
              {d.dir.class_teacher && <p className="text-sm text-slate-700">{L('home.classTeacher', { name: d.dir.class_teacher.name })}</p>}
            </div>
          );
        }}
      </WithData>
    </>
  );
}
