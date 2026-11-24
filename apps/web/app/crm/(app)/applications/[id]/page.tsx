'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { act, formObj, useCrm } from '@/lib/crm/api';
import { fmtDate, inr } from '@/lib/crm/fmt';
import { Badge, ErrorBox, Loading, PageHeader } from '@/components/crm/ui';
import { ApplicationForm, type AppSection } from '@/components/crm/forms';

type Row = Record<string, any>;
type Res = {
  enquiry: Row; application: Row | null; documents: Row[]; payments: Row[]; checklist: { label: string; done: boolean }[]; ageIssue: string | null; seats: { capacity: number; confirmed: number } | null;
  sections: AppSection[]; fees: { registration: number; admission: number }; can: Record<string, any>; applyUrl: string;
};
const DOC_TONE: Record<string, string> = { pending: 'slate', uploaded: 'amber', verified: 'green', rejected: 'rose' };
const DOC_TEXT: Record<string, string> = { pending: 'Not received', uploaded: 'Received, to review', verified: 'Verified', rejected: 'Rejected' };

/** Application review (key screen): answers, documents with verify / reject, payment status, decision. */
export default function ApplicationPage() {
  const { id } = useParams<{ id: string }>();
  const { data: d, error, reload } = useCrm<Res>(`/applications/${id}`);
  if (error) return <ErrorBox message={error.message} />;
  if (!d) return <Loading />;
  const e = d.enquiry;
  const app = d.application;
  const can = d.can;
  return (
    <>
      <PageHeader
        title={`${e.student} · ${e.application_no ?? 'Application'}`}
        sub={
          <>
            {e.grade} · {e.branch} · {e.year} · <Badge tone={e.color}>{e.stage}</Badge>
          </>
        }
      >
        <Link className="btn" href={`/crm/households/${e.household_id}?e=${e.id}`}>
          Open family page
        </Link>
      </PageHeader>
      {!app ? (
        <div className="card p-6 text-center">
          <p className="font-medium">No application yet for this child.</p>
          {can.application && (
            <button
              className="btn btn-primary mt-3"
              onClick={async () => {
                if (await act(`/leads/${e.id}/application/start`)) reload();
              }}
            >
              Start application
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
          <section className="card min-w-0" aria-label="Form answers">
            <div className="card-h">
              <h2>Form answers</h2>
              <span className="muted font-normal">{app.status === 'submitted' ? `Submitted ${fmtDate(app.submitted_at)}` : `${app.progress}% complete`}</span>
            </div>
            <div className="p-4">
              {d.ageIssue && <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-amber-900">Age check: {d.ageIssue}</p>}
              <ApplicationForm
                key={app.updated_at}
                sections={d.sections}
                answers={app.answers}
                readOnly={app.status === 'submitted' || !can.application}
                staff
                canOverrideAge={!!d.ageIssue && can.decide}
                onSave={async (body) => {
                  const r = await act<{ ok: boolean; error?: string }>(`/leads/${e.id}/application`, body, { quiet: false });
                  if (r) reload();
                  return r ? { ok: true } : { ok: false, error: 'Not saved. See the message above.' };
                }}
              />
              {app.status !== 'submitted' && (
                <p className="muted mt-3 text-xs">
                  Parent link: <code className="select-all break-all">{d.applyUrl}</code>
                </p>
              )}
            </div>
          </section>
          <aside className="space-y-4">
            <section className="card" aria-label="Decision">
              <div className="card-h">
                <h2>Decision</h2>
              </div>
              <div className="space-y-2 p-4">
                {d.checklist.map((c) => (
                  <p key={c.label} className={c.done ? 'text-green-900' : 'text-slate-700'}>
                    {c.done ? '✓' : '○'} {c.label}
                  </p>
                ))}
                {d.seats && (
                  <p className="muted text-xs">
                    Seats in {e.grade}: {d.seats.confirmed} confirmed of {d.seats.capacity}
                  </p>
                )}
                {e.is_won ? (
                  <Badge tone="green">Admission confirmed</Badge>
                ) : (
                  can.decide &&
                  !e.is_closed && (
                    <button
                      className="btn btn-primary w-full"
                      disabled={d.checklist.some((c) => !c.done)}
                      onClick={async () => {
                        if (await act(`/leads/${e.id}/admission`, {})) reload();
                      }}
                    >
                      Confirm admission
                    </button>
                  )
                )}
                {!e.is_won && d.checklist.some((c) => !c.done) && <p className="muted text-xs">The button unlocks when every item above is done.</p>}
              </div>
            </section>
            <section className="card" aria-label="Documents">
              <div className="card-h">
                <h2>Documents</h2>
              </div>
              <ul className="divide-y divide-slate-100">
                {d.documents.map((doc) => (
                  <DocRow key={doc.id} doc={doc} edit={can.application} verify={can.verifyDocs} onDone={reload} />
                ))}
              </ul>
            </section>
            <section className="card" aria-label="Payments">
              <div className="card-h">
                <h2>Payments</h2>
              </div>
              <ul className="divide-y divide-slate-100">
                {d.payments.map((p) => (
                  <li key={p.id} className="px-4 py-2.5">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">
                        {p.purpose} · {inr(p.amount)}
                      </span>
                      <Badge tone={p.status === 'paid' ? 'green' : p.status === 'failed' ? 'rose' : 'amber'}>{p.status === 'pending' && p.mode !== 'link' ? 'To verify' : p.status[0].toUpperCase() + p.status.slice(1)}</Badge>
                    </div>
                    <p className="muted break-all text-xs">
                      {String(p.mode).replace('_', ' ')}
                      {p.receipt_no ? ` · receipt ${p.receipt_no}` : ''}
                      {p.link ? ` · link ${p.link}` : ''}
                    </p>
                    {can.verifyPay && p.status !== 'paid' && <PayVerify id={p.id} onDone={reload} />}
                  </li>
                ))}
                {!d.payments.length && <li className="muted px-4 py-3">No payments requested yet.</li>}
              </ul>
              {can.pay && <NewPayment enquiryId={e.id} fees={d.fees} onDone={reload} />}
            </section>
          </aside>
        </div>
      )}
    </>
  );
}

function DocRow({ doc, edit, verify, onDone }: { doc: Row; edit: boolean; verify: boolean; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [file, setFile] = useState('');
  const go = async (what: string, extra: Row = {}) => {
    if (await act(`/documents/${doc.id}`, { what, ...extra })) onDone();
  };
  return (
    <li className="space-y-1.5 px-4 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{doc.type}</span>
        <Badge tone={DOC_TONE[doc.status]}>{DOC_TEXT[doc.status]}</Badge>
      </div>
      {doc.file_name && <p className="muted text-xs">{doc.file_name}</p>}
      {doc.reject_reason && <p className="text-xs text-rose-700">Reason: {doc.reject_reason}</p>}
      {edit && ['pending', 'rejected'].includes(doc.status) && (
        <form
          className="flex gap-1.5"
          onSubmit={(ev) => {
            ev.preventDefault();
            if (file) void go('upload', { fileName: file });
          }}
        >
          <input type="file" required accept="image/*,.pdf" aria-label={`File for ${doc.type}`} onChange={(ev) => setFile(ev.target.files?.[0]?.name ?? '')} className="w-full text-xs" />
          <button className="btn btn-sm">Add</button>
        </form>
      )}
      {verify && doc.status === 'uploaded' && (
        <div className="flex gap-1.5">
          <input value={reason} onChange={(ev) => setReason(ev.target.value)} placeholder="Reason if rejecting" aria-label="Reason if rejecting" className="input !py-1 text-xs" />
          <button className="btn btn-sm btn-primary" onClick={() => go('verify')}>
            Verify
          </button>
          <button className="btn btn-sm btn-danger" onClick={() => go('reject', { reason })}>
            Reject
          </button>
        </div>
      )}
    </li>
  );
}

function PayVerify({ id, onDone }: { id: string; onDone: () => void }) {
  const [ref, setRef] = useState('');
  return (
    <div className="mt-1.5 flex gap-1.5">
      <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="Reference" aria-label="Payment reference" className="input !py-1 text-xs" />
      <button
        className="btn btn-sm"
        onClick={async () => {
          if (await act(`/payments/${id}/settle`, { reference: ref })) onDone();
        }}
      >
        Mark received
      </button>
    </div>
  );
}

function NewPayment({ enquiryId, fees, onDone }: { enquiryId: string; fees: { registration: number; admission: number }; onDone: () => void }) {
  return (
    <form
      className="grid grid-cols-2 gap-2 border-t border-slate-200 p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (await act(`/leads/${enquiryId}/payment`, formObj(e.currentTarget))) onDone();
      }}
    >
      <select name="purpose" className="input" aria-label="Purpose">
        <option>Admission fee</option>
        <option>Registration fee</option>
      </select>
      <input name="amount" type="number" min={1} defaultValue={fees.admission} required className="input" aria-label="Amount" />
      <select name="mode" className="input" aria-label="Mode">
        <option value="link">Send payment link</option>
        <option value="cash">Cash</option>
        <option value="cheque">Cheque</option>
        <option value="bank_transfer">Bank transfer</option>
      </select>
      <button className="btn">Request / record</button>
    </form>
  );
}
