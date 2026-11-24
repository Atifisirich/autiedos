import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCtx, type Ctx } from '@/lib/erp/ctx';
import { core, erp } from '@/lib/erp/db';
import { Page, Stat, Card, Empty, Badge } from '@/components/erp/ui';
import { inrShort, inr, today, pct, fdate } from '@/lib/erp/fmt';
import { workingDay, weekday, DAYS } from '@/lib/erp/calendar';
import { navFor } from '@/lib/erp/nav';
import { balance } from '@autoed/shared/erp';

export const metadata = { title: 'Home' };
export default async function Home() {
  const ctx = await getCtx();
  if (ctx.role === 'driver') redirect('/erp/driver');
  if (['group_admin', 'principal', 'system_admin', 'coordinator'].includes(ctx.role)) return <Pulse ctx={ctx} />;
  if (['class_teacher', 'subject_teacher'].includes(ctx.role)) return <MyDay ctx={ctx} />;
  return <RoleHome ctx={ctx} />;
}

const scope = <T extends { or: (f: string) => T }>(q: T, ctx: Ctx) => (ctx.branchId ? q.or(`branch_id.eq.${ctx.branchId},branch_id.is.null`) : q);

/** Management morning pulse (RPT-02): one screen that says how the school is doing. */
async function Pulse({ ctx }: { ctx: Ctx }) {
  const d = today();
  const sb = ctx.sb;
  const wd = await workingDay(ctx, d);
  const monthStart = d.slice(0, 8) + '01';
  const [strength, att, subs, sections, rToday, rMonth, dues, staffAtt, staffCount, cover, tickets, busEv, approvals, newAdm, exits] = await Promise.all([
    scope(core(sb).from('students').select('id', { count: 'exact', head: true }).eq('status', 'active').is('deleted_at', null), ctx),
    core(sb).from('student_attendance_marks').select('status').eq('date', d).is('deleted_at', null).limit(20000),
    core(sb).from('student_attendance_sessions').select('section_id').eq('date', d).eq('status', 'submitted').is('deleted_at', null),
    core(sb).from('sections').select('id, name').eq('academic_year_id', ctx.year?.id ?? '00000000-0000-0000-0000-000000000000').is('deleted_at', null).order('seq'),
    ctx.can('fees') ? scope(erp(sb).from('receipts').select('total').eq('date', d).eq('status', 'valid').is('deleted_at', null), ctx) : Promise.resolve({ data: [] }),
    ctx.can('fees') ? scope(erp(sb).from('receipts').select('total').gte('date', monthStart).eq('status', 'valid').is('deleted_at', null).limit(20000), ctx) : Promise.resolve({ data: [] }),
    ctx.can('fees') ? scope(erp(sb).from('fee_demands').select('amount, concession, fine, paid, due_date').in('status', ['due', 'partial']).lte('due_date', d).is('deleted_at', null).limit(20000), ctx) : Promise.resolve({ data: [] }),
    scope(core(sb).from('staff_attendance').select('status').eq('date', d).is('deleted_at', null), ctx),
    scope(core(sb).from('staff').select('id', { count: 'exact', head: true }).eq('status', 'active').is('deleted_at', null), ctx),
    scope(erp(sb).from('substitutions').select('id', { count: 'exact', head: true }).eq('date', d).eq('status', 'assigned').is('deleted_at', null), ctx),
    ctx.can('helpdesk') ? scope(core(sb).from('tickets').select('id, title, due_at, status, priority').in('status', ['open', 'assigned', 'in_progress', 'waiting', 'reopened']).is('deleted_at', null).order('due_at').limit(200), ctx) : Promise.resolve({ data: [] }),
    ctx.can('transport') ? erp(sb).from('trip_events').select('type, note, at').in('type', ['sos', 'delay', 'overspeed', 'offroute']).gte('at', d + 'T00:00:00+05:30').order('at', { ascending: false }).limit(20) : Promise.resolve({ data: [] }),
    erp(sb).rpc('my_approvals'),
    scope(core(sb).from('students').select('id', { count: 'exact', head: true }).gte('joined_on', monthStart).in('status', ['active', 'admitted']).is('deleted_at', null), ctx),
    scope(core(sb).from('students').select('id', { count: 'exact', head: true }).gte('left_on', monthStart).is('deleted_at', null), ctx),
  ]);
  const a = (att.data ?? []) as { status: string }[];
  const present = a.filter((x) => ['present', 'late', 'half_day', 'on_duty'].includes(x.status)).length;
  const absent = a.filter((x) => x.status === 'absent').length;
  const counted = a.filter((x) => x.status !== 'on_leave').length;
  const marked = new Set(((subs.data ?? []) as { section_id: string }[]).map((s) => s.section_id));
  const secs = (sections.data ?? []) as { id: string; name: string }[];
  const unmarked = secs.filter((s) => !marked.has(s.id));
  const sum = (rows: { total: number }[] | null) => (rows ?? []).reduce((t, r) => t + Number(r.total), 0);
  const dueRows = (dues.data ?? []) as { amount: number; concession: number; fine: number; paid: number; due_date: string }[];
  const overdue = dueRows.reduce((t, x) => t + balance(x as never), 0);
  const sAbsent = ((staffAtt.data ?? []) as { status: string }[]).filter((x) => ['absent', 'on_leave', 'half_day'].includes(x.status)).length;
  const tk = (tickets.data ?? []) as { id: string; title: string; due_at: string | null; status: string; priority: string }[];
  const breached = tk.filter((t) => t.due_at && new Date(t.due_at) < new Date()).length;
  const bus = (busEv.data ?? []) as { type: string; note: string | null; at: string }[];
  const pend = (approvals.data ?? []) as { id: string; title: string }[];
  return (
    <Page title={`Good morning, ${ctx.name.split(' ')[0]}`} sub={`${fdate(d)} · ${ctx.branchId ? ctx.branches.find((b) => b.id === ctx.branchId)?.name : 'All branches'}${wd.working ? '' : ` · ${wd.reason}: attendance and posting checks are paused today`}`}>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Strength" value={strength.count ?? 0} hint={`+${newAdm.count ?? 0} joined, ${exits.count ?? 0} left this month`} href="/erp/students" />
        <Stat label="Student attendance today" value={counted ? `${pct(present, counted)}%` : '—'} hint={counted ? `${absent} absent of ${counted} marked` : wd.working ? 'Not marked yet' : 'Holiday'} tone={counted && pct(present, counted) < 85 ? 'warn' : undefined} href="/erp/attendance" />
        <Stat label="Sections not marked" value={wd.working ? unmarked.length : '—'} hint={wd.working ? `of ${secs.length} sections` : 'Not counted today'} tone={wd.working && unmarked.length ? 'bad' : 'good'} href="/erp/attendance" />
        <Stat label="Staff absent or on leave" value={sAbsent} hint={`${staffCount.count ?? 0} staff · ${cover.count ?? 0} periods covered`} href="/erp/timetable/substitutions" />
        {ctx.can('fees') && <>
          <Stat label="Collected today" value={inrShort(sum(rToday.data as never))} hint={`${(rToday.data ?? []).length} receipts`} href="/erp/fees/receipts" />
          <Stat label="Collected this month" value={inrShort(sum(rMonth.data as never))} href="/erp/fees" />
          <Stat label="Overdue fees" value={inrShort(overdue)} hint={`${dueRows.length} instalments past due`} tone={overdue > 0 ? 'warn' : 'good'} href="/erp/fees/dues" />
        </>}
        <Stat label="Open requests" value={tk.length} hint={breached ? `${breached} past SLA` : 'All within SLA'} tone={breached ? 'bad' : undefined} href="/erp/helpdesk" />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card title={`Waiting for your decision (${pend.length})`} actions={<Link className="link text-sm" href="/erp/approvals">Open inbox</Link>}>
          {pend.length === 0 ? <Empty title="Nothing waiting" hint="Approvals routed to you appear here." /> : <ul className="divide-y divide-line text-sm">{pend.slice(0, 6).map((p) => <li key={p.id} className="px-4 py-2"><Link className="link" href="/erp/approvals">{p.title}</Link></li>)}</ul>}
        </Card>
        <Card title="Attendance not marked" actions={<Link className="link text-sm" href="/erp/attendance">Board</Link>}>
          {!wd.working ? <Empty title="No school today" hint={wd.reason ?? ''} /> : unmarked.length === 0 ? <Empty title="Every section is marked" /> : <ul className="grid grid-cols-2 gap-x-4 px-4 py-3 text-sm">{unmarked.slice(0, 14).map((s) => <li key={s.id}><Link className="link" href={`/erp/attendance/roll/${s.id}`}>{s.name}</Link></li>)}</ul>}
        </Card>
        <Card title="Bus exceptions today" actions={ctx.can('transport') ? <Link className="link text-sm" href="/erp/transport/live">Live</Link> : undefined}>
          {bus.length === 0 ? <Empty title="No exceptions" hint="Late starts, over-speed and SOS alerts appear here." /> : <ul className="divide-y divide-line text-sm">{bus.slice(0, 6).map((b, i) => <li key={i} className="flex justify-between px-4 py-2"><Badge tone={b.type === 'sos' ? 'red' : 'amber'}>{b.type}</Badge><span className="text-muted">{b.note}</span></li>)}</ul>}
        </Card>
      </div>
      {tk.length > 0 && (
        <Card title="Parent and staff requests" className="mt-4" actions={<Link className="link text-sm" href="/erp/helpdesk">Helpdesk</Link>}>
          <ul className="divide-y divide-line text-sm">{tk.slice(0, 5).map((t) => <li key={t.id} className="flex items-center justify-between gap-3 px-4 py-2"><Link className="link truncate" href={`/erp/helpdesk/${t.id}`}>{t.title}</Link><span className="flex shrink-0 items-center gap-2"><Badge>{t.priority}</Badge>{t.due_at && new Date(t.due_at) < new Date() ? <Badge tone="red">past SLA</Badge> : null}</span></li>)}</ul>
        </Card>
      )}
      <p className="mt-4 text-sm text-muted"><Link className="link" href="/erp/diary">Principal&apos;s daily diary</Link> · <Link className="link" href="/erp/reports">Reports</Link> · <Link className="link" href="/erp/insights">Insight cards</Link></p>
    </Page>
  );
}

/** Teacher "My day" (TAP-01): timetable with substitutions, attendance to mark, homework, marks due. */
async function MyDay({ ctx }: { ctx: Ctx }) {
  const d = today();
  const sid = ctx.staff?.id ?? null;
  const dow = weekday(d);
  const wd = await workingDay(ctx, d);
  if (!sid) return <Page title="My day"><Card><Empty title="Your login is not linked to a staff record yet" hint="Ask your school admin to link your account in Admin console → Users. Then your timetable, classes and marks appear here." /></Card></Page>;
  const noYear = '00000000-0000-0000-0000-000000000000';
  const [tt, subsFor, subsAway, mySections, posts, due, periods, subm] = await Promise.all([
    core(ctx.sb).from('timetable_entries').select('period_seq, room:rooms(name), section:sections(id, name), subject:subjects(name), version:timetable_versions!inner(status)').eq('staff_id', sid).eq('day', dow).eq('version.status', 'published').is('deleted_at', null).order('period_seq'),
    erp(ctx.sb).from('substitutions').select('period_seq, section:sections(id, name), subject:subjects(name)').eq('substitute_staff_id', sid).eq('date', d).eq('status', 'assigned').is('deleted_at', null),
    erp(ctx.sb).from('substitutions').select('period_seq').eq('absent_staff_id', sid).eq('date', d).is('deleted_at', null),
    core(ctx.sb).from('sections').select('id, name').eq('class_teacher_id', sid).eq('academic_year_id', ctx.year?.id ?? noYear).is('deleted_at', null),
    core(ctx.sb).from('class_posts').select('id, section_id').eq('created_by', ctx.user.id).gte('created_at', d + 'T00:00:00+05:30').is('deleted_at', null),
    erp(ctx.sb).from('assessments').select('id, name, entry_deadline, section:sections(name), subject:subjects(name)').eq('staff_id', sid).eq('status', 'open').is('deleted_at', null).order('entry_deadline').limit(8),
    core(ctx.sb).from('periods').select('seq, starts_at, ends_at, kind, teaching_index').eq('kind', 'teaching').is('deleted_at', null).order('seq'),
    core(ctx.sb).from('student_attendance_sessions').select('section_id').eq('date', d).eq('status', 'submitted').is('deleted_at', null),
  ]);
  type Slot = { period_seq: number; room?: { name: string } | null; section: { id: string; name: string } | null; subject: { name: string } | null; cover?: boolean };
  const slots: Slot[] = [...((tt.data ?? []) as unknown as Slot[]), ...((subsFor.data ?? []) as unknown as Slot[]).map((s) => ({ ...s, cover: true }))].sort((x, y) => x.period_seq - y.period_seq);
  const time = (p: number) => { const b = ((periods.data ?? []) as { seq: number; starts_at: string; ends_at: string }[]).find((x) => x.seq === p); return b ? `${String(b.starts_at).slice(0, 5)}–${String(b.ends_at).slice(0, 5)}` : `Period ${p}`; };
  const marked = new Set(((subm.data ?? []) as { section_id: string }[]).map((s) => s.section_id));
  const posted = new Set(((posts.data ?? []) as { section_id: string }[]).map((p) => p.section_id));
  const teachSections = [...new Map(slots.filter((s) => s.section).map((s) => [s.section!.id, s.section!])).values()];
  const away = (subsAway.data ?? []) as { period_seq: number }[];
  const mine = (mySections.data ?? []) as { id: string; name: string }[];
  const dueRows = (due.data ?? []) as unknown as { id: string; name: string; entry_deadline: string | null; section: { name: string } | null; subject: { name: string } | null }[];
  return (
    <Page title="My day" sub={`${DAYS[dow]}, ${fdate(d)}${wd.working ? '' : ` · ${wd.reason}`}`}>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Timetable" className="lg:col-span-2" actions={<Link className="link text-sm" href="/erp/timetable">Full week</Link>}>
          {!wd.working ? <Empty title="No school today" hint={wd.reason ?? ''} /> : slots.length === 0 ? <Empty title="No periods today" hint="Your coordinator builds the timetable. Substitutions appear here as soon as they are confirmed." /> : (
            <ul className="divide-y divide-line">{slots.map((s, i) => (
              <li key={i} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                <span className="w-24 shrink-0 tabular-nums text-muted">{time(s.period_seq)}</span>
                <span className="flex-1 font-medium">{s.section?.name} · {s.subject?.name ?? 'Cover'} {s.cover && <Badge tone="blue">substitution</Badge>} {away.some((x) => x.period_seq === s.period_seq) && <Badge tone="grey">covered by another teacher</Badge>}</span>
                {s.section && <span className="flex gap-2"><Link className="btn-ghost btn-sm" href={`/erp/homework?section=${s.section.id}`}>Post</Link></span>}
              </li>
            ))}</ul>
          )}
        </Card>
        <div className="space-y-4">
          <Card title="Attendance to mark">
            {mine.length === 0 ? <Empty title="You are not a class teacher" hint="Period attendance is available from the Attendance page." /> : <ul className="divide-y divide-line text-sm">{mine.map((s) => (
              <li key={s.id} className="flex items-center justify-between px-4 py-2.5"><span>{s.name}</span>{marked.has(s.id) ? <Badge tone="green">marked</Badge> : wd.working ? <Link className="btn btn-sm" href={`/erp/attendance/roll/${s.id}`}>Mark now</Link> : <Badge tone="grey">holiday</Badge>}</li>
            ))}</ul>}
          </Card>
          <Card title="Homework to post">
            {teachSections.length === 0 ? <Empty title="Nothing expected today" /> : <ul className="divide-y divide-line text-sm">{teachSections.map((s) => <li key={s.id} className="flex items-center justify-between px-4 py-2.5"><span>{s.name}</span>{posted.has(s.id) ? <Badge tone="green">posted</Badge> : <Link className="link" href={`/erp/homework?section=${s.id}`}>Post</Link>}</li>)}</ul>}
          </Card>
          <Card title="Marks due">
            {dueRows.length === 0 ? <Empty title="No marks pending" /> : <ul className="divide-y divide-line text-sm">{dueRows.map((a) => (
              <li key={a.id} className="px-4 py-2.5"><Link className="link" href={`/erp/assessments/${a.id}`}>{a.name} · {a.section?.name} · {a.subject?.name}</Link>{a.entry_deadline && <span className={`ml-2 text-xs ${a.entry_deadline < d ? 'text-red-600' : 'text-muted'}`}>due {fdate(a.entry_deadline)}</span>}</li>
            ))}</ul>}
          </Card>
        </div>
      </div>
    </Page>
  );
}

/** Other staff roles: the jobs they can do, plus what is waiting. */
async function RoleHome({ ctx }: { ctx: Ctx }) {
  const groups = navFor(ctx).filter((g) => g.title !== 'Today');
  const d = today();
  const [mine, rc, tk] = await Promise.all([
    erp(ctx.sb).rpc('my_approvals'),
    ctx.can('fees') ? erp(ctx.sb).from('receipts').select('total').eq('date', d).eq('status', 'valid').is('deleted_at', null) : Promise.resolve({ data: null }),
    ctx.can('helpdesk') ? core(ctx.sb).from('tickets').select('id', { count: 'exact', head: true }).in('status', ['open', 'assigned', 'in_progress']).eq('owner_role_key', ctx.role).is('deleted_at', null) : Promise.resolve({ count: null }),
  ]);
  return (
    <Page title={`Hello, ${ctx.name.split(' ')[0]}`} sub={fdate(d)}>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Waiting for your decision" value={((mine.data ?? []) as unknown[]).length} href="/erp/approvals" />
        {rc.data && <Stat label="Collected today" value={inr((rc.data as { total: number }[]).reduce((t, r) => t + Number(r.total), 0))} hint={`${rc.data.length} receipts`} href="/erp/fees/receipts" />}
        {tk.count !== null && tk.count !== undefined && <Stat label="Requests assigned to your desk" value={tk.count} href="/erp/helpdesk" />}
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {groups.map((g) => <Card key={g.title} title={g.title}><ul className="divide-y divide-line text-sm">{g.items.map((i) => <li key={i.href}><Link className="block px-4 py-2.5 hover:bg-paper" href={i.href}>{i.label}</Link></li>)}</ul></Card>)}
      </div>
    </Page>
  );
}
