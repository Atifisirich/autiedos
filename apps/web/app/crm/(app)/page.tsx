'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCrm } from '@/lib/crm/api';
import { age, fmtTime, localInput, rel } from '@/lib/crm/fmt';
import { Badge, Empty, ErrorBox, Loading, PageHeader, Stat } from '@/components/crm/ui';
import { TaskDone, type StageOpt } from '@/components/crm/forms';
import { useShell } from '@/components/crm/shell';

type Home = {
  tasks: { id: string; title: string; type: string; priority: string; due_at: string; enquiry_id: string; household_id: string; student: string; exempt_next_action: boolean; open_count: number }[];
  visits: { id: string; slot_at: string; checked_in_at: string | null; household_id: string; enquiry_id: string; student: string; host: string | null }[];
  fresh: { id: string; household_id: string; created_at: string; grade: string | null; student: string; owner: string }[];
  replies: { household_id: string; at: string; body: string; student: string }[];
  mine: { open: number; won: number; week: number };
  team: { id: string; name: string; on_leave: boolean; open: number; won: number; untouched: number; overdue: number }[];
  stages: StageOpt[];
  taskTypes: Record<string, string>;
  sla: number;
  reasons: string[];
  can: { tasks: boolean; reports: boolean };
  isHead: boolean;
};

export default function Home() {
  const { shell } = useShell();
  const { data: h, error, reload } = useCrm<Home>('/home');
  const denied = useSearchParams().get('denied');
  if (error) return <ErrorBox message={error.message} />;
  if (!h) return <Loading />;
  const now = Date.now();
  const overdue = h.tasks.filter((k) => +new Date(k.due_at) < now);
  const dueNow = h.tasks.filter((k) => +new Date(k.due_at) >= now && +new Date(k.due_at) < now + 2 * 3600e3);
  const later = h.tasks.filter((k) => +new Date(k.due_at) >= now + 2 * 3600e3);
  const due = localInput(new Date(now + 24 * 3600e3));
  const List = ({ title, rows, tone }: { title: string; rows: Home['tasks']; tone?: string }) => (
    <section className="card" aria-label={title}>
      <div className="card-h">
        <h2 className={tone}>{title}</h2>
        <span className="muted font-normal">{rows.length}</span>
      </div>
      {!rows.length ? (
        <p className="muted px-4 py-3">Nothing here.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {rows.map((k) => (
            <li key={k.id} className="flex items-center justify-between gap-3 px-4 py-2">
              <div className="min-w-0">
                <Link href={`/crm/households/${k.household_id}?e=${k.enquiry_id}`} className="link">
                  {k.student}
                </Link>{' '}
                <span className="text-slate-800">· {k.title}</span>
                {k.priority === 'high' && (
                  <span className="ml-1.5">
                    <Badge tone="red">High</Badge>
                  </span>
                )}
                <div className="muted text-xs">
                  {h.taskTypes[k.type] ?? k.type} · {rel(k.due_at)} ({fmtTime(k.due_at)})
                </div>
              </div>
              {h.can.tasks && <TaskDone taskId={k.id} title={k.title} lastOpen={k.open_count === 1 && !k.exempt_next_action} stages={h.stages} reasons={h.reasons} defaultDue={due} onDone={reload} />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
  return (
    <>
      <PageHeader title="My day" sub={`${shell.user.name} · ${shell.role.name}`}>
        {h.can.reports && (
          <Link href="/crm/reports" className="btn">
            Open dashboards
          </Link>
        )}
      </PageHeader>
      {denied && (
        <p role="alert" className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-amber-900">
          Your role does not have access to that area. Ask your admin if you need it.
        </p>
      )}
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Overdue tasks" value={overdue.length} tone={overdue.length ? 'bad' : undefined} href="/crm/tasks?tab=overdue" />
        <Stat label="Due in the next 2 hours" value={dueNow.length} href="/crm/tasks" />
        <Stat label="Awaiting first response" value={h.fresh.length} tone={h.fresh.length ? 'bad' : undefined} sub={`Target: within ${h.sla} min`} href="/crm/leads?chip=untouched" />
        <Stat label="Visits today" value={h.visits.length} href="/crm/visits" />
        {shell.scope === 'own' ? <Stat label="My admissions this year" value={h.mine.won} sub={`${h.mine.open} open · ${h.mine.week} new this week`} tone="good" href="/crm/leads?chip=my&won=1" /> : <Stat label="Unread parent replies" value={h.replies.length} href="/crm/inbox" />}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <List title="Overdue" rows={overdue} tone="text-rose-700" />
          <List title="Due now" rows={dueNow} />
          <List title="Later today and tomorrow" rows={later} />
        </div>
        <div className="space-y-4">
          <section className="card" aria-label="New leads awaiting first response">
            <div className="card-h">
              <h2>New leads awaiting first response</h2>
              <Link href="/crm/leads?chip=untouched" className="link text-xs">
                See all
              </Link>
            </div>
            {!h.fresh.length ? (
              <Empty title="Every new enquiry has had a response" />
            ) : (
              <ul className="divide-y divide-slate-100">
                {h.fresh.map((e) => {
                  const mins = Math.round((now - +new Date(e.created_at)) / 60000);
                  return (
                    <li key={e.id} className="flex flex-wrap items-center justify-between gap-1 px-4 py-2">
                      <span>
                        <Link className="link" href={`/crm/households/${e.household_id}?e=${e.id}&panel=call`}>
                          {e.student}
                        </Link>{' '}
                        <span className="muted">
                          · {e.grade} · {e.owner}
                        </span>
                      </span>
                      <span className={mins > h.sla ? 'font-semibold text-rose-700' : 'text-amber-800'}>
                        ⏱ waiting {age(e.created_at)}
                        {mins > h.sla ? ' (past target)' : ''}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          <section className="card" aria-label="Visits today">
            <div className="card-h">
              <h2>Visits today</h2>
              <Link href="/crm/visits" className="link text-xs">
                Visit calendar
              </Link>
            </div>
            {!h.visits.length ? (
              <Empty title="No visits today">Book one from any family&apos;s page.</Empty>
            ) : (
              <ul className="divide-y divide-slate-100">
                {h.visits.map((v) => (
                  <li key={v.id} className="flex items-center justify-between px-4 py-2">
                    <span>
                      <b>{fmtTime(v.slot_at)}</b> ·{' '}
                      <Link className="link" href={`/crm/households/${v.household_id}?e=${v.enquiry_id}`}>
                        {v.student}
                      </Link>{' '}
                      <span className="muted">· host {v.host}</span>
                    </span>
                    {v.checked_in_at ? <Badge tone="green">Arrived</Badge> : <Badge>Expected</Badge>}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="card" aria-label="Unread parent replies">
            <div className="card-h">
              <h2>Unread parent replies</h2>
              <Link href="/crm/inbox" className="link text-xs">
                Team inbox
              </Link>
            </div>
            {!h.replies.length ? (
              <Empty title="No unread replies" />
            ) : (
              <ul className="divide-y divide-slate-100">
                {h.replies.map((m) => (
                  <li key={m.household_id} className="px-4 py-2">
                    <Link className="link" href={`/crm/inbox?h=${m.household_id}`}>
                      {m.student}
                    </Link>{' '}
                    <span className="muted text-xs">· {rel(m.at)}</span>
                    <div className="truncate text-slate-800">{m.body}</div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {h.isHead && (
            <section className="card overflow-x-auto" aria-label="Team today">
              <div className="card-h">
                <h2>Team today</h2>
              </div>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Counsellor</th>
                    <th>Open</th>
                    <th>Untouched</th>
                    <th>Overdue tasks</th>
                    <th>Admissions</th>
                  </tr>
                </thead>
                <tbody>
                  {h.team.map((u) => (
                    <tr key={u.id}>
                      <td>
                        {u.name}
                        {u.on_leave && (
                          <span className="ml-1.5">
                            <Badge tone="amber">On leave</Badge>
                          </span>
                        )}
                      </td>
                      <td>
                        <Link className="link" href={`/crm/leads?owner=${u.id}&open=1`}>
                          {u.open}
                        </Link>
                      </td>
                      <td className={u.untouched ? 'font-semibold text-rose-700' : ''}>{u.untouched}</td>
                      <td className={u.overdue ? 'font-semibold text-rose-700' : ''}>{u.overdue}</td>
                      <td>{u.won}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
