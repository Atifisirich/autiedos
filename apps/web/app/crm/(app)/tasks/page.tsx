'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { act, useCrm } from '@/lib/crm/api';
import { dayKey, fmtDateTime, fmtTime, localInput, qs, rel } from '@/lib/crm/fmt';
import { Badge, Empty, ErrorBox, Loading, PageHeader } from '@/components/crm/ui';
import { TaskDone, type StageOpt } from '@/components/crm/forms';

type Task = { id: string; title: string; type: string; priority: string; status: string; due_at: string; outcome: string | null; enquiry_id: string; household_id: string; student: string; owner: string; exempt_next_action: boolean; open_count: number };
type Res = { tasks: Task[]; team: boolean; teamAllowed: boolean; calendar: boolean; tab: string; taskTypes: Record<string, string>; reasons: string[]; stages: StageOpt[]; can: Record<string, any> };
const TABS: [string, string][] = [['today', 'Today'], ['overdue', 'Overdue'], ['upcoming', 'Upcoming'], ['done', 'Done']];

export default function TasksPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Tasks />
    </Suspense>
  );
}

function Tasks() {
  const sp = Object.fromEntries(useSearchParams().entries()) as Record<string, string>;
  const tab = sp.tab ?? 'today';
  const { data: r, error, reload } = useCrm<Res>('/tasks', sp);
  if (error) return <ErrorBox message={error.message} />;
  if (!r) return <Loading />;
  const link = (patch: Record<string, string | undefined>) => '/crm/tasks' + qs(sp, patch);
  const due = localInput(new Date(Date.now() + 24 * 3600e3));
  return (
    <>
      <PageHeader title="Tasks" sub={r.team ? 'Everyone in your team' : 'Your follow-ups, visits and chases'}>
        {r.teamAllowed && (
          <div className="flex rounded-md border border-slate-300 bg-white p-0.5" role="group" aria-label="Whose tasks">
            {[['', 'Mine'], ['team', 'Team']].map(([k, l]) => (
              <Link key={l} href={link({ who: k || undefined })} aria-current={(sp.who ?? '') === k ? 'true' : undefined} className={`rounded px-2.5 py-1.5 text-xs font-medium ${(sp.who ?? '') === k ? 'bg-teal-700 text-white' : 'text-slate-700'}`}>
                {l}
              </Link>
            ))}
          </div>
        )}
        <div className="flex rounded-md border border-slate-300 bg-white p-0.5" role="group" aria-label="Layout">
          {[['', 'List'], ['calendar', 'Calendar']].map(([k, l]) => (
            <Link key={l} href={link({ view: k || undefined })} aria-current={(sp.view ?? '') === k ? 'true' : undefined} className={`rounded px-2.5 py-1.5 text-xs font-medium ${(sp.view ?? '') === k ? 'bg-teal-700 text-white' : 'text-slate-700'}`}>
              {l}
            </Link>
          ))}
        </div>
      </PageHeader>
      {r.calendar ? (
        <TaskCalendar tasks={r.tasks} today={dayKey(new Date())} showOwner={r.team} onMoved={reload} />
      ) : (
        <>
          <div className="mb-3 flex gap-1 border-b border-slate-200" role="tablist">
            {TABS.map(([k, l]) => (
              <Link key={k} href={link({ tab: k })} role="tab" aria-selected={tab === k} className={`tab ${tab === k ? 'tab-on' : ''}`}>
                {l}
              </Link>
            ))}
          </div>
          <div className="card overflow-x-auto">
            {!r.tasks.length ? (
              <Empty title={tab === 'overdue' ? 'Nothing overdue' : 'No tasks here'}>Tasks are created when you plan a next action, book a visit, or when a workflow asks for a follow-up.</Empty>
            ) : (
              <table className="tbl">
                <caption className="sr-only">Tasks</caption>
                <thead>
                  <tr>
                    <th>Task</th>
                    <th>Student</th>
                    <th>Type</th>
                    {r.team && <th>Owner</th>}
                    <th>{tab === 'done' ? 'Outcome' : 'Due'}</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {r.tasks.map((k) => (
                    <tr key={k.id}>
                      <td className="font-medium">
                        {k.title}
                        {k.priority === 'high' && (
                          <span className="ml-1.5">
                            <Badge tone="red">High</Badge>
                          </span>
                        )}
                      </td>
                      <td>
                        <Link className="link" href={`/crm/households/${k.household_id}?e=${k.enquiry_id}`}>
                          {k.student}
                        </Link>
                      </td>
                      <td>{r.taskTypes[k.type] ?? k.type}</td>
                      {r.team && <td>{k.owner}</td>}
                      <td className={k.status === 'open' && new Date(k.due_at) < new Date() ? 'font-medium text-rose-700' : ''}>
                        {tab === 'done' ? (
                          k.outcome
                        ) : (
                          <>
                            {fmtDateTime(k.due_at)} <span className="muted">({rel(k.due_at)})</span>
                          </>
                        )}
                      </td>
                      <td className="text-right">{k.status === 'open' && r.can.tasks && <TaskDone taskId={k.id} title={k.title} lastOpen={k.open_count === 1 && !k.exempt_next_action} stages={r.stages} reasons={r.reasons} defaultDue={due} onDone={reload} />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </>
  );
}

const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Month grid of open tasks. Drag a task onto another day to reschedule it (the time of day is kept); the select on each task does the same without a mouse. */
function TaskCalendar({ tasks, today, showOwner, onMoved }: { tasks: Task[]; today: string; showOwner: boolean; onMoved: () => void }) {
  const [offset, setOffset] = useState(0);
  const [over, setOver] = useState('');
  const router = useRouter();
  const [ty, tm] = today.split('-').map(Number) as [number, number];
  const first = new Date(ty, tm - 1 + offset, 1);
  const gridStart = new Date(first);
  gridStart.setDate(1 - ((first.getDay() + 6) % 7)); // weeks start on Monday
  const days = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    return d;
  });
  const items = tasks.map((t) => ({ ...t, day: dayKey(t.due_at) }));
  const move = async (id: string, day: string) => {
    const t = items.find((x) => x.id === id);
    if (!t || t.day === day) return;
    const shift = Math.round((+new Date(day) - +new Date(t.day)) / 86400e3);
    if (await act(`/tasks/${id}/reschedule`, { due: new Date(+new Date(t.due_at) + shift * 86400e3).toISOString() }, { quiet: true })) onMoved();
  };
  void router;
  return (
    <div className="card overflow-hidden">
      <div className="card-h">
        <h2>{first.toLocaleString('en-IN', { month: 'long', year: 'numeric' })}</h2>
        <span className="flex gap-1">
          <button className="btn btn-sm" onClick={() => setOffset(offset - 1)}>
            ← Previous
          </button>
          <button className="btn btn-sm" onClick={() => setOffset(0)}>
            Today
          </button>
          <button className="btn btn-sm" onClick={() => setOffset(offset + 1)}>
            Next →
          </button>
        </span>
      </div>
      <div className="overflow-x-auto">
        <div className="min-w-[44rem]">
          <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50 text-center text-xs font-semibold text-slate-700">
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
              <div key={d} className="py-1.5">
                {d}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {days.map((d) => {
              const k = key(d);
              const list = items.filter((t) => t.day === k);
              return (
                <div
                  key={k}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setOver(k);
                  }}
                  onDragLeave={() => setOver('')}
                  onDrop={(e) => {
                    e.preventDefault();
                    setOver('');
                    void move(e.dataTransfer.getData('text/plain'), k);
                  }}
                  className={`min-h-24 border-b border-r border-slate-100 p-1 ${d.getMonth() !== first.getMonth() ? 'bg-slate-50' : ''} ${over === k ? 'bg-teal-50' : ''}`}
                >
                  <div className={`mb-1 text-right text-xs ${k === today ? 'font-bold text-teal-800' : 'text-slate-600'}`}>
                    {k === today ? 'Today ' : ''}
                    {d.getDate()}
                  </div>
                  {list.slice(0, 4).map((t) => (
                    <Link
                      key={t.id}
                      href={`/crm/households/${t.household_id}?e=${t.enquiry_id}`}
                      draggable
                      onDragStart={(e) => e.dataTransfer.setData('text/plain', t.id)}
                      title={`${t.title} · ${t.owner}`}
                      className={`mb-0.5 block truncate rounded px-1 py-0.5 text-[11px] ${new Date(t.due_at) < new Date() ? 'bg-rose-100 text-rose-900' : 'bg-teal-100 text-teal-900'}`}
                    >
                      {fmtTime(t.due_at)} {t.student}
                      {showOwner ? ` · ${t.owner.split(' ')[0]}` : ''}
                    </Link>
                  ))}
                  {list.length > 4 && <div className="muted text-[11px]">+{list.length - 4} more</div>}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
