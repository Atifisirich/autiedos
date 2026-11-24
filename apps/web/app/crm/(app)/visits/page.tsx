'use client';
import Link from 'next/link';
import { Suspense, useState } from 'react';
import { act, useCrm } from '@/lib/crm/api';
import { dayKey, fmtDay, fmtTime } from '@/lib/crm/fmt';
import { Badge, Empty, ErrorBox, Loading, PageHeader, Stat } from '@/components/crm/ui';

type Visit = { id: string; enquiry_id: string; household_id: string; slot_at: string; status: string; checked_in_at: string | null; outcome: string | null; type: string; student: string; grade: string | null; host: string | null; branch: string; guardian: string | null; mobile: string | null };

export default function VisitsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Visits />
    </Suspense>
  );
}

function Visits() {
  const [find, setFind] = useState('');
  const [q, setQ] = useState('');
  const { data, error, reload } = useCrm<{ visits: Visit[]; can: Record<string, any> }>('/visits');
  if (error) return <ErrorBox message={error.message} />;
  if (!data) return <Loading />;
  const rows = data.visits;
  const today = dayKey(new Date());
  const todays = rows.filter((v) => dayKey(v.slot_at) === today);
  const shown = q ? todays.filter((v) => v.mobile?.includes(q.replace(/\D/g, '') || '@@') || v.student.toLowerCase().includes(q.toLowerCase())) : todays;
  const upcoming = rows.filter((v) => dayKey(v.slot_at) > today && v.status === 'scheduled');
  const past = rows.filter((v) => dayKey(v.slot_at) < today);
  const byDay: Record<string, Visit[]> = {};
  for (const v of upcoming) (byDay[dayKey(v.slot_at)] ??= []).push(v);
  const can = data.can.tasks;
  return (
    <>
      <PageHeader title="Visits" sub="Front-desk check-in and the visit calendar for the next two weeks" />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Expected today" value={todays.length} />
        <Stat label="Arrived" value={todays.filter((v) => v.checked_in_at).length} tone="good" />
        <Stat label="Booked, next 14 days" value={upcoming.length} />
        <Stat label="No-shows, last 7 days" value={past.filter((v) => v.status === 'no_show').length} tone={past.some((v) => v.status === 'no_show') ? 'bad' : undefined} />
      </div>
      <section className="card mb-4" aria-label="Today's arrivals">
        <div className="card-h">
          <h2>Today&apos;s arrivals</h2>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setQ(find);
            }}
          >
            <input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find by mobile or student" className="input w-56" aria-label="Find a visitor" />
            <button className="btn">Find</button>
          </form>
        </div>
        {!shown.length ? (
          <Empty title={q ? 'No visit today matches that' : 'No visits today'}>
            {q ? (
              <Link className="link" href="/crm/walkin">
                Not booked? Add them as a walk-in.
              </Link>
            ) : (
              'Counsellors book visits from a family\'s page. Walk-ins go through the walk-in desk.'
            )}
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <caption className="sr-only">Today&apos;s visits</caption>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Family</th>
                  <th>Grade</th>
                  <th>Host</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((v) => (
                  <Row key={v.id} v={v} can={can} onDone={reload} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="card" aria-label="Coming up">
        <div className="card-h">
          <h2>Coming up</h2>
        </div>
        {!upcoming.length && <Empty title="No visits booked for the coming days" />}
        <div className="divide-y divide-slate-100">
          {Object.entries(byDay).map(([day, list]) => (
            <div key={day} className="grid gap-2 px-4 py-3 md:grid-cols-[10rem_1fr]">
              <div>
                <div className="font-semibold">{fmtDay(list[0]!.slot_at)}</div>
                <div className="muted text-xs">
                  {list.length} visit{list.length === 1 ? '' : 's'}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {list.map((v) => (
                  <Link key={v.id} href={`/crm/households/${v.household_id}?e=${v.enquiry_id}`} className="rounded-md border border-slate-200 px-2.5 py-1.5 hover:border-teal-600">
                    <b>{fmtTime(v.slot_at)}</b> {v.student}{' '}
                    <span className="muted text-xs">
                      · {v.host?.split(' ')[0]} · {v.branch}
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

function Row({ v, can, onDone }: { v: Visit; can: boolean; onDone: () => void }) {
  const [outcome, setOutcome] = useState('');
  const go = async (what: string) => {
    if (await act(`/visits/${v.id}`, { what, outcome })) onDone();
  };
  return (
    <tr>
      <td className="font-semibold">{fmtTime(v.slot_at)}</td>
      <td>
        <Link className="link" href={`/crm/households/${v.household_id}?e=${v.enquiry_id}`}>
          {v.student}
        </Link>
        <span className="muted block text-xs">
          {v.guardian} · {v.mobile}
        </span>
      </td>
      <td>{v.grade}</td>
      <td>{v.host}</td>
      <td>{v.status === 'done' ? <Badge tone="green">Done</Badge> : v.status === 'no_show' ? <Badge tone="rose">No-show</Badge> : v.checked_in_at ? <Badge tone="green">Arrived {fmtTime(v.checked_in_at)}</Badge> : <Badge>Expected</Badge>}</td>
      <td>
        {can && v.status === 'scheduled' && (
          <div className="flex justify-end gap-1.5">
            {!v.checked_in_at ? (
              <button className="btn btn-sm btn-primary" onClick={() => go('check_in')}>
                Check in
              </button>
            ) : (
              <>
                <input value={outcome} onChange={(e) => setOutcome(e.target.value)} placeholder="Visit outcome" aria-label="Visit outcome" className="input !w-44 !py-1 text-xs" />
                <button className="btn btn-sm btn-primary" onClick={() => go('done')}>
                  Mark done
                </button>
              </>
            )}
            {!v.checked_in_at && (
              <button className="btn btn-sm" onClick={() => go('no_show')}>
                No-show
              </button>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}
