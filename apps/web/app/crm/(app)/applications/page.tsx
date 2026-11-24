'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { act, useCrm } from '@/lib/crm/api';
import { fmtDate, inr } from '@/lib/crm/fmt';
import { Badge, Empty, ErrorBox, Loading, Meter, PageHeader, Stat } from '@/components/crm/ui';

type App = { id: string; status: string; progress: number; submitted_at: string | null; enquiry_id: string; household_id: string; application_no: string | null; grade: string | null; student: string; stage: string; color: string; is_won: boolean; owner: string; branch: string; docs: number; docs_ok: number; docs_review: number; paid: number; pay_open: number };
type Queue = { id: string; purpose: string; amount: number; mode: string; reference: string | null; enquiry_id: string; household_id: string; student: string };
const TABS: [string, string][] = [['all', 'All'], ['started', 'In progress'], ['review', 'Documents to review'], ['payment', 'Payment pending'], ['ready', 'Ready for decision']];

export default function ApplicationsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Applications />
    </Suspense>
  );
}

function Applications() {
  const f = useSearchParams().get('f') ?? 'all';
  const { data, error, reload } = useCrm<{ rows: App[]; queue: Queue[] }>('/applications');
  if (error) return <ErrorBox message={error.message} />;
  if (!data) return <Loading />;
  const rows = data.rows;
  const is: Record<string, (r: App) => boolean> = {
    started: (r) => r.status === 'started',
    review: (r) => r.status === 'submitted' && !r.is_won && (r.docs_review > 0 || r.docs_ok < r.docs),
    payment: (r) => r.pay_open > 0,
    ready: (r) => r.status === 'submitted' && r.docs > 0 && r.docs_ok === r.docs && !r.is_won,
    all: () => true,
  };
  const shown = rows.filter(is[f] ?? is.all!);
  return (
    <>
      <PageHeader title="Applications" sub="The application phase of the same record: form, documents, fees and decision" />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="In progress" value={rows.filter(is.started!).length} href="/crm/applications?f=started" />
        <Stat label="Documents to review" value={rows.filter(is.review!).length} href="/crm/applications?f=review" />
        <Stat label="Payment pending" value={rows.filter(is.payment!).length} href="/crm/applications?f=payment" />
        <Stat label="Ready for decision" value={rows.filter(is.ready!).length} tone="good" href="/crm/applications?f=ready" />
      </div>
      {data.queue.length > 0 && (
        <section className="card mb-4 overflow-x-auto" aria-label="Offline payments waiting for verification">
          <div className="card-h">
            <h2>Offline payments waiting for verification</h2>
          </div>
          <table className="tbl">
            <tbody>
              {data.queue.map((p) => (
                <QueueRow key={p.id} p={p} onDone={reload} />
              ))}
            </tbody>
          </table>
        </section>
      )}
      <div className="mb-3 flex gap-1 overflow-x-auto border-b border-slate-200" role="tablist">
        {TABS.map(([k, l]) => (
          <Link key={k} href={`/crm/applications?f=${k}`} role="tab" aria-selected={f === k} className={`tab ${f === k ? 'tab-on' : ''}`}>
            {l}
          </Link>
        ))}
      </div>
      <div className="card overflow-x-auto">
        {!shown.length ? (
          <Empty title="No applications here">Start an application from a family&apos;s page, or send the parent the form link.</Empty>
        ) : (
          <table className="tbl">
            <caption className="sr-only">Applications</caption>
            <thead>
              <tr>
                <th>Application</th>
                <th>Student</th>
                <th>Grade</th>
                <th>Form</th>
                <th>Documents</th>
                <th>Paid</th>
                <th>Stage</th>
                <th>Owner</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link className="link" href={`/crm/applications/${r.enquiry_id}`}>
                      {r.application_no ?? 'Open'}
                    </Link>
                  </td>
                  <td>
                    {r.student}
                    <span className="muted block text-xs">{r.branch}</span>
                  </td>
                  <td>{r.grade}</td>
                  <td>{r.status === 'submitted' ? <Badge tone="green">Submitted {fmtDate(r.submitted_at)}</Badge> : <Meter value={r.progress} max={100} />}</td>
                  <td>
                    {r.docs_ok} of {r.docs} verified
                    {r.docs_review > 0 && (
                      <span className="ml-1.5">
                        <Badge tone="amber">{r.docs_review} to review</Badge>
                      </span>
                    )}
                  </td>
                  <td>
                    {inr(r.paid)}
                    {r.pay_open > 0 && (
                      <span className="ml-1.5">
                        <Badge tone="amber">Pending</Badge>
                      </span>
                    )}
                  </td>
                  <td>
                    <Badge tone={r.color}>{r.stage}</Badge>
                  </td>
                  <td>{r.owner}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function QueueRow({ p, onDone }: { p: Queue; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const go = async (what: string) => {
    setBusy(true);
    const r = await act(`/payments/${p.id}/settle`, { what });
    setBusy(false);
    if (r) onDone();
  };
  return (
    <tr>
      <td>
        <Link className="link" href={`/crm/households/${p.household_id}?e=${p.enquiry_id}`}>
          {p.student}
        </Link>
      </td>
      <td>{p.purpose}</td>
      <td>{inr(p.amount)}</td>
      <td>
        {p.mode.replace('_', ' ')}
        {p.reference ? ` · ${p.reference}` : ''}
      </td>
      <td className="text-right">
        <span className="flex justify-end gap-1.5">
          <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => go('verify')}>
            Verify and issue receipt
          </button>
          <button className="btn btn-sm" disabled={busy} onClick={() => go('fail')}>
            Not received
          </button>
        </span>
      </td>
    </tr>
  );
}

